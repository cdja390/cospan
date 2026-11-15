import { createActivityTracker, excerpt } from '../observation.mjs';
import { BUILTIN_CONFIG, loadEffectiveConfig } from '../targets.mjs';

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const FILE_MUTATION_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit']);

function normalizeClaudeEffort(effort, fallback) {
  if (!effort) return fallback;
  const e = String(effort).toLowerCase();
  if (e === 'inherit') return null;
  if (VALID_EFFORTS.has(e)) return e;
  throw new Error(`invalid --effort "${effort}" for claude (expected low|medium|high|xhigh|max)`);
}

function pickClaudeBaseDefaults(defaults, kind) {
  const sendModel = defaults.model || defaults.sendModel || 'sonnet';
  if (kind === 'ask') {
    return {
      defaultModel: defaults.askModel || sendModel,
      defaultEffort: defaults.askEffort || 'low',
    };
  }
  return {
    defaultModel: sendModel,
    defaultEffort: defaults.effort || defaults.sendEffort || 'high',
  };
}

export function resolveClaudeModelAndEffort({ kind = 'send', model, effort, config } = {}) {
  const effective = config || loadEffectiveConfig().config;
  const defaults = { ...BUILTIN_CONFIG.defaults.claude, ...(effective?.defaults?.claude || {}) };
  const mappings = { ...BUILTIN_CONFIG.mappings.claude, ...(effective?.mappings?.claude || {}) };

  const { defaultModel, defaultEffort } = pickClaudeBaseDefaults(defaults, kind);
  const rawModel = model || defaultModel;
  const resolvedModel = rawModel === 'inherit' ? null : mappings[rawModel] || rawModel;
  const resolvedEffort = normalizeClaudeEffort(effort, defaultEffort === 'inherit' ? null : defaultEffort);
  return { model: resolvedModel, effort: resolvedEffort };
}

function buildClaudePermissionFlags({ readonly, permissions }) {
  if (permissions !== 'restricted') {
    return readonly
      ? ['--dangerously-skip-permissions', '--disallowed-tools', 'Edit,Write,NotebookEdit']
      : ['--dangerously-skip-permissions'];
  }
  return readonly
    ? ['--restricted', '--permission-mode', 'plan', '--permission-prompts', 'none']
    : ['--permission-mode', 'acceptEdits', '--permission-prompts', 'none'];
}

function extractTouchedFilesFromToolUse(toolName, input) {
  if (!FILE_MUTATION_TOOLS.has(String(toolName || '').toLowerCase()) || !input || typeof input !== 'object') {
    return [];
  }
  const candidate = input.file_path || input.notebook_path || input.path;
  return typeof candidate === 'string' && candidate ? [candidate] : [];
}

function joinClaudeErrorsArray(errors) {
  if (!Array.isArray(errors) || !errors.length) return '';
  return errors
    .map((e) => (typeof e === 'string' ? e : e?.message || JSON.stringify(e)))
    .filter(Boolean)
    .join('; ');
}

function extractClaudeErrorMessage(obj, fallback = 'Claude Code execution failed.') {
  if (!obj || typeof obj !== 'object') return fallback;
  const candidates = [
    typeof obj.result === 'string' ? obj.result.trim() : '',
    joinClaudeErrorsArray(obj.errors),
    typeof obj.error === 'string' ? obj.error : '',
    typeof obj.error?.message === 'string' ? obj.error.message : '',
    typeof obj.message === 'string' ? obj.message : '',
  ];
  return candidates.find(Boolean) || fallback;
}

function isClaudeErrorResult(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.is_error === true || Boolean(obj.error)) return true;
  return typeof obj.subtype === 'string' && obj.subtype.startsWith('error');
}

function parseClaudeJsonStdout(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return [...parsed].reverse().find((item) => item?.type === 'result') || parsed.at(-1) || null;
    }
    return parsed;
  } catch {}
  for (const line of trimmed.split('\n').reverse()) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') return obj;
    } catch {}
  }
  return null;
}

function projectAssistantBlocks(blocks, ctx) {
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      ctx.setLastText(block.text);
      ctx.tracker.updateText({ key: `${ctx.getSessionId() || 'claude'}:text`, text: block.text, delta: false });
    } else if (block.type === 'tool_use') {
      const id = block.id || `tool_${Date.now()}`;
      const name = block.name || 'tool';
      ctx.toolNames.set(id, name);
      ctx.tracker.upsertActivity({
        key: id,
        tool: name,
        status: 'running',
        input: block.input,
        touchedFiles: extractTouchedFilesFromToolUse(name, block.input),
      });
    }
  }
}

function projectUserToolResults(blocks, ctx) {
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (block?.type !== 'tool_result') continue;
    const id = block.tool_use_id || 'tool_result';
    const tool = ctx.toolNames.get(id) || 'tool';
    ctx.tracker.upsertActivity({
      key: id,
      tool,
      status: block.is_error ? 'error' : 'done',
      output: block.content,
    });
  }
}

function formatClaudeNative(resultEvent, exitCode, streamError) {
  return {
    target: 'claude',
    exit_code: exitCode,
    ...(typeof resultEvent?.subtype === 'string' ? { subtype: excerpt(resultEvent.subtype, 128).text } : {}),
    ...(typeof resultEvent?.total_cost_usd === 'number' ? { total_cost_usd: resultEvent.total_cost_usd } : {}),
    ...(streamError ? { stream_error: excerpt(streamError, 512).text } : {}),
  };
}

export const claudeDriver = {
  id: 'claude',
  displayName: 'Anthropic Claude Code CLI',
  installHint:
    'Claude Code CLI was not found. Install `@anthropic-ai/claude-code` or `brew install claude` and verify with `claude --version`.',

  humanResumeCommand(conversationId) {
    return conversationId ? `claude --resume ${conversationId}` : null;
  },

  resolveConfig({ kind = 'send', model, effort, config } = {}) {
    return resolveClaudeModelAndEffort({ kind, model, effort, config });
  },

  buildInvocation({
    kind = 'send',
    prompt,
    model,
    effort = 'high',
    workspace,
    readonly = false,
    permissions = 'unrestricted',
    conversationId = null,
  }) {
    const effectiveReadonly = kind === 'ask' || Boolean(readonly);
    const formatFlags =
      kind === 'ask'
        ? ['--output-format', 'json', '--no-session-persistence']
        : ['--output-format', 'stream-json', '--verbose'];
    const resumeFlags = kind !== 'ask' && conversationId ? ['--resume', conversationId] : [];
    const permFlags = buildClaudePermissionFlags({ readonly: effectiveReadonly, permissions });
    const modelFlags = [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];

    const args = ['-p', ...formatFlags, '--add-dir', workspace, ...resumeFlags, ...permFlags, ...modelFlags];
    return { args, stdinText: prompt, cwd: workspace };
  },

  parseForegroundOutput({ stdout, stderr, exitCode }) {
    const parsed = parseClaudeJsonStdout(stdout);
    if (!parsed || typeof parsed !== 'object') {
      const detail = (stderr || stdout || '').trim();
      throw Object.assign(new Error(`claude ask did not return parseable JSON (exit ${exitCode}): ${detail}`), {
        native: formatClaudeNative(null, exitCode, null),
      });
    }
    if (isClaudeErrorResult(parsed)) {
      const msg = extractClaudeErrorMessage(parsed);
      throw Object.assign(new Error(msg), { native: formatClaudeNative(parsed, exitCode, msg) });
    }
    return {
      response: typeof parsed.result === 'string' ? parsed.result : '',
      conversationId: parsed.session_id || null,
      usage: parsed.usage || null,
      native: formatClaudeNative(parsed, exitCode, null),
    };
  },

  createStreamSession({ onConversation = () => {} } = {}) {
    const tracker = createActivityTracker();
    const toolNames = new Map();
    let sessionId = null;
    let lastAssistantText = null;
    let resultEvent = null;
    let streamError = null;

    const captureSession = (candidate) => {
      if (typeof candidate === 'string' && candidate && candidate.length <= 256 && candidate !== sessionId) {
        sessionId = candidate;
        onConversation(candidate);
      }
    };

    const projCtx = {
      tracker,
      toolNames,
      getSessionId: () => sessionId,
      setLastText: (txt) => {
        lastAssistantText = txt;
      },
    };

    return {
      warn: tracker.warn,
      snapshot: tracker.snapshot,
      writeStderr() {},
      acceptEvent(event) {
        tracker.touch();
        captureSession(event?.session_id);
        const type = event?.type;
        if (type === 'assistant') {
          projectAssistantBlocks(event.message?.content, projCtx);
          return false;
        }
        if (type === 'user') {
          projectUserToolResults(event.message?.content, projCtx);
          return false;
        }
        if (type === 'result') {
          resultEvent = event;
          if (isClaudeErrorResult(event)) {
            streamError = extractClaudeErrorMessage(event);
          } else if (typeof event.result === 'string') {
            lastAssistantText = event.result;
            tracker.updateText({ key: `${sessionId || 'claude'}:final`, text: event.result, status: 'done' });
          }
          return true;
        }
        if (type === 'error') {
          streamError = extractClaudeErrorMessage(event, 'Claude stream error.');
        }
        return false;
      },
      finalize(exitCode) {
        const native = formatClaudeNative(resultEvent, exitCode, streamError);
        if (streamError) return { payload: null, streamFailure: streamError, native };
        const responseText = typeof resultEvent?.result === 'string' ? resultEvent.result : lastAssistantText;
        if (resultEvent || (typeof responseText === 'string' && responseText.length > 0)) {
          return {
            payload: {
              response: responseText ?? '',
              conversation_id: resultEvent?.session_id || sessionId,
              usage: resultEvent?.usage || null,
            },
            streamFailure: null,
            native,
          };
        }
        return { payload: null, streamFailure: null, native };
      },
    };
  },
};
