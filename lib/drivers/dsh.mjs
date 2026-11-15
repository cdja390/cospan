import fs from 'node:fs';
import path from 'node:path';
import { createActivityTracker, createParser, excerpt } from '../observation.mjs';
import { BUILTIN_CONFIG, loadEffectiveConfig, workspaceTrajectoryDir } from '../targets.mjs';

const NATIVE_DSH_EFFORTS = new Set(['off', 'low', 'high', 'max']);
const MAX_RETAINED_PATCHES = 20;

function normalizeDshEffort(effort, fallback) {
  if (!effort) return fallback;
  const e = String(effort).toLowerCase();
  if (e === 'inherit') return null;
  if (NATIVE_DSH_EFFORTS.has(e)) return e;
  if (e === 'none' || e === 'minimal') return 'off';
  if (e === 'medium') {
    process.stderr.write(`cospan: dsh uses off|low|high|max reasoningEffort; mapping --effort medium -> high\n`);
    return 'high';
  }
  if (e === 'xhigh') {
    process.stderr.write(`cospan: dsh uses off|low|high|max reasoningEffort; mapping --effort xhigh -> max\n`);
    return 'max';
  }
  throw new Error(`invalid --effort "${effort}" for dsh (expected off|low|medium|high|xhigh|max)`);
}

function pickDshBaseDefaults(defaults, kind) {
  const sendModel = defaults.model || defaults.sendModel || 'inherit';
  if (kind === 'ask') {
    return {
      defaultModel: defaults.askModel || sendModel,
      defaultEffort: defaults.askEffort || 'inherit',
    };
  }
  return {
    defaultModel: sendModel,
    defaultEffort: defaults.effort || defaults.sendEffort || 'inherit',
  };
}

function encodeDshModelWithProvider(mappedModel, provider) {
  if (!mappedModel || mappedModel.includes('/')) return mappedModel;
  return provider && provider !== 'deepseek-official' ? `${provider}/${mappedModel}` : mappedModel;
}

export function resolveDshModelAndEffort({ kind = 'send', model, effort, config } = {}) {
  const effective = config || loadEffectiveConfig().config;
  const defaults = { ...BUILTIN_CONFIG.defaults.dsh, ...(effective?.defaults?.dsh || {}) };
  const mappings = { ...BUILTIN_CONFIG.mappings.dsh, ...(effective?.mappings?.dsh || {}) };

  const { defaultModel, defaultEffort } = pickDshBaseDefaults(defaults, kind);
  const rawModel = model || defaultModel;
  const mappedModel = rawModel === 'inherit' ? null : mappings[rawModel] || rawModel;
  const encodedModel = encodeDshModelWithProvider(mappedModel, defaults.provider);
  const resolvedEffort = normalizeDshEffort(effort, defaultEffort === 'inherit' ? null : defaultEffort);
  return { model: encodedModel, effort: resolvedEffort };
}

function splitProviderAndModel(modelSpec, workspace) {
  if (modelSpec && modelSpec.includes('/')) {
    const slash = modelSpec.indexOf('/');
    return { provider: modelSpec.slice(0, slash), model: modelSpec.slice(slash + 1) };
  }
  const cfgProvider = loadEffectiveConfig({ workspaceRoot: workspace }).config?.defaults?.dsh?.provider;
  return {
    provider: cfgProvider || 'deepseek-official',
    model: modelSpec || 'deepseek-flash',
  };
}

function pruneOldPatchFiles(patchesDir) {
  try {
    const files = fs
      .readdirSync(patchesDir)
      .filter((f) => f.startsWith('dsh-patch-') && f.endsWith('.json'))
      .sort();
    for (const stale of files.slice(0, Math.max(0, files.length - MAX_RETAINED_PATCHES))) {
      fs.unlinkSync(path.join(patchesDir, stale));
    }
  } catch {}
}

export function writeDshModelPatchFile({ workspace, model, effort }) {
  if (!model && !effort) return null;
  const { provider, model: modelId } = splitProviderAndModel(model, workspace);
  const patchPayload = [
    {
      id: 'agent-default-model',
      config: {
        provider,
        model: modelId,
        ...(effort ? { reasoningEffort: effort } : {}),
      },
    },
  ];
  const patchesDir = path.join(workspaceTrajectoryDir(workspace), 'patches');
  fs.mkdirSync(patchesDir, { recursive: true });
  const filename = `dsh-patch-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`;
  const patchPath = path.join(patchesDir, filename);
  fs.writeFileSync(patchPath, JSON.stringify(patchPayload, null, 2) + '\n');
  pruneOldPatchFiles(patchesDir);
  return patchPath;
}

function extractDshTouchedFiles(toolName, input) {
  if (!/write|edit|patch/i.test(String(toolName || '')) || !input || typeof input !== 'object') return [];
  const candidate = input.path || input.file_path || input.filePath;
  return typeof candidate === 'string' && candidate ? [candidate] : [];
}

function resolveDshEventToolId(event) {
  return event.id || event.callId || event.toolCallId || 'dsh_tool';
}

function resolveDshEventToolName(event, fallback) {
  return event.name || event.tool || event.toolName || fallback;
}

function projectDshToolCall(event, ctx) {
  const id = resolveDshEventToolId(event);
  const name = resolveDshEventToolName(event, 'tool');
  const input = event.input ?? event.args ?? event.arguments;
  ctx.toolNames.set(id, name);
  ctx.tracker.upsertActivity({
    key: id,
    tool: name,
    status: 'running',
    input,
    touchedFiles: extractDshTouchedFiles(name, input),
  });
}

function projectDshToolResult(event, ctx) {
  const id = resolveDshEventToolId(event);
  const name = resolveDshEventToolName(event, ctx.toolNames.get(id) || 'tool');
  const isErr = Boolean(event.isError || event.is_error || event.error);
  ctx.tracker.upsertActivity({
    key: id,
    tool: name,
    status: isErr ? 'error' : 'done',
    output: event.error ?? event.output ?? event.result ?? event.content,
  });
}

const TERMINAL_DSH_TYPES = new Set(['final', 'result', 'done', 'turn/end']);
const TEXT_DSH_TYPES = new Set(['text', 'message', 'assistant_message', 'assistant/message']);
const TOOL_CALL_DSH_TYPES = new Set(['tool_call', 'tool/call']);
const TOOL_RESULT_DSH_TYPES = new Set(['tool_result', 'tool/result']);

function extractDshTextPayload(event) {
  for (const key of ['text', 'result', 'response', 'answer', 'output', 'content']) {
    if (typeof event?.[key] === 'string') return event[key];
  }
  return null;
}

function cleanDshStderr(stderr) {
  return String(stderr || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l && !l.startsWith('dsh: reasoning:'))
    .join('\n');
}

function finalizeDshStreamState({
  exitCode,
  streamError,
  finalResponse,
  accumulatedText,
  turnCompleted,
  sessionId,
  usage,
}) {
  const native = {
    target: 'dsh',
    exit_code: exitCode,
    ...(streamError ? { stream_error: excerpt(streamError, 512).text } : {}),
  };
  if (streamError) return { payload: null, streamFailure: streamError, native };
  const resolvedText = finalResponse ?? (accumulatedText.length > 0 ? accumulatedText : null);
  if (turnCompleted || resolvedText !== null) {
    return {
      payload: { response: resolvedText ?? '', conversation_id: sessionId, usage },
      streamFailure: null,
      native,
    };
  }
  return { payload: null, streamFailure: null, native };
}

export const dshDriver = {
  id: 'dsh',
  displayName: 'DeepSeek Harness CLI',
  installHint: 'DeepSeek Harness CLI (`dsh`) was not found. Install DeepSeek Harness and verify with `dsh --version`.',

  humanResumeCommand(conversationId) {
    return conversationId ? `dsh tui --resume ${conversationId}` : null;
  },

  resolveConfig({ kind = 'send', model, effort, config } = {}) {
    return resolveDshModelAndEffort({ kind, model, effort, config });
  },

  buildInvocation({
    kind = 'send',
    prompt,
    model = null,
    effort = null,
    workspace,
    readonly = false,
    permissions = 'unrestricted',
    conversationId = null,
  }) {
    const effectiveReadonly = kind === 'ask' || Boolean(readonly);
    const permPreset =
      permissions !== 'restricted' ? 'danger-full-access' : effectiveReadonly ? 'read-only' : 'workspace-write';
    const patchFile = writeDshModelPatchFile({ workspace, model, effort });

    const args = [
      '--profile',
      'headless',
      ...(patchFile ? ['--patch', patchFile] : []),
      '--json',
      ...(kind !== 'ask' && conversationId ? ['--session-id', conversationId] : []),
      '--permission-mode',
      permPreset,
      '--approval-policy',
      'never',
      '-',
    ];
    return { args, stdinText: prompt, cwd: workspace };
  },

  parseForegroundOutput({ stdout, stderr, exitCode }) {
    const cleanedStderr = cleanDshStderr(stderr);
    const session = dshDriver.createStreamSession();
    const parser = createParser((ev) => session.acceptEvent(ev), session.warn);
    parser.write(Buffer.from(stdout || '', 'utf8'));
    parser.end();
    session.writeStderr(cleanedStderr);
    const finalized = session.finalize(exitCode);
    if (finalized.streamFailure) {
      throw Object.assign(new Error(finalized.streamFailure), { native: finalized.native });
    }
    if (!finalized.payload) {
      throw Object.assign(
        new Error(`dsh ask did not return a completed turn (exit ${exitCode}): ${cleanedStderr || stdout}`),
        { native: finalized.native }
      );
    }
    return {
      response: finalized.payload.response,
      conversationId: finalized.payload.conversation_id,
      usage: finalized.payload.usage,
      native: finalized.native,
    };
  },

  createStreamSession({ onConversation = () => {} } = {}) {
    const tracker = createActivityTracker();
    const toolNames = new Map();
    let sessionId = null;
    let accumulatedText = '';
    let finalResponse = null;
    let turnCompleted = false;
    let usage = null;
    let streamError = null;

    const captureSession = (ev) => {
      const candidate = ev?.sessionId || ev?.session_id || ev?.session?.id;
      if (typeof candidate === 'string' && candidate && candidate.length <= 256 && candidate !== sessionId) {
        sessionId = candidate;
        onConversation(candidate);
      }
    };

    const applyTextEvent = (event) => {
      if (typeof event.delta === 'string') {
        accumulatedText += event.delta;
        tracker.updateText({ key: `${sessionId || 'dsh'}:text`, text: event.delta, delta: true });
        return;
      }
      const full = extractDshTextPayload(event);
      if (full !== null) {
        accumulatedText = full;
        tracker.updateText({ key: `${sessionId || 'dsh'}:text`, text: full, delta: false });
      }
    };

    const applyTerminalEvent = (event) => {
      turnCompleted = true;
      usage = event.usage || usage;
      const text = extractDshTextPayload(event);
      if (text !== null) finalResponse = text;
      tracker.updateText({
        key: `${sessionId || 'dsh'}:final`,
        text: finalResponse ?? accumulatedText,
        status: 'done',
      });
    };

    return {
      warn: tracker.warn,
      snapshot: tracker.snapshot,
      writeStderr() {},
      acceptEvent(event) {
        tracker.touch();
        captureSession(event);
        const type = event?.type;
        if (type === 'error') {
          streamError = event.message || event.error?.message || 'DeepSeek Harness stream error.';
          return true;
        }
        if (TERMINAL_DSH_TYPES.has(type)) {
          applyTerminalEvent(event);
          return true;
        }
        if (TEXT_DSH_TYPES.has(type)) {
          applyTextEvent(event);
          return false;
        }
        if (TOOL_CALL_DSH_TYPES.has(type)) projectDshToolCall(event, { tracker, toolNames });
        else if (TOOL_RESULT_DSH_TYPES.has(type)) projectDshToolResult(event, { tracker, toolNames });
        return false;
      },
      finalize(exitCode) {
        return finalizeDshStreamState({
          exitCode,
          streamError,
          finalResponse,
          accumulatedText,
          turnCompleted,
          sessionId,
          usage,
        });
      },
    };
  },
};
