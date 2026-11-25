import { createActivityTracker, createParser, excerpt } from '../observation.mjs';
import { resolveDshModelAndEffort, writeDshModelPatchFile } from './dsh-protocol.mjs';

export { resolveDshModelAndEffort, writeDshModelPatchFile } from './dsh-protocol.mjs';

function extractDshTouchedFiles(toolName, input) {
  if (!/write|edit|patch/i.test(String(toolName || '')) || !input || typeof input !== 'object')
    return [];
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

function hasExplicitDshErrorField(error) {
  if (typeof error === 'string') return error.trim().length > 0;
  return typeof error?.message === 'string' && error.message.trim().length > 0;
}

function pickDshErrorText(candidates, fallback = 'DeepSeek Harness turn ended with error.') {
  for (const raw of candidates) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text) return text;
  }
  return fallback;
}

function extractDshTerminalError(event) {
  if (event?.reason?.kind === 'error') {
    return pickDshErrorText([
      event.reason.error,
      event.reason.error?.message,
      event.reason.message,
      event.message,
      event.text,
    ]);
  }
  if (
    event?.isError === true ||
    event?.is_error === true ||
    hasExplicitDshErrorField(event?.error)
  ) {
    return pickDshErrorText([event.error, event.error?.message, event.message, event.text]);
  }
  return null;
}

function applyDshTerminalEvent(event, state) {
  const terminalError = extractDshTerminalError(event);
  if (terminalError) {
    state.streamError = terminalError;
    return;
  }
  state.turnCompleted = true;
  state.usage = event.usage || state.usage;
  const text = extractDshTextPayload(event);
  if (text !== null) state.finalResponse = text;
  state.tracker.updateText({
    key: `${state.sessionId || 'dsh'}:final`,
    text: state.finalResponse ?? state.accumulatedText,
    status: 'done',
  });
}

export const dshDriver = {
  id: 'dsh',
  displayName: 'DeepSeek Harness CLI',
  installHint:
    'DeepSeek Harness CLI (`dsh`) was not found. ' +
    'Install DeepSeek Harness and verify with `dsh --version`.',

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
      permissions !== 'restricted'
        ? 'danger-full-access'
        : effectiveReadonly
          ? 'read-only'
          : 'workspace-write';
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
        new Error(
          `dsh ask did not return a completed turn (exit ${exitCode}): ${cleanedStderr || stdout}`
        ),
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
    const state = {
      tracker,
      sessionId: null,
      accumulatedText: '',
      finalResponse: null,
      turnCompleted: false,
      usage: null,
      streamError: null,
    };

    const captureSession = (ev) => {
      const candidate = ev?.sessionId || ev?.session_id || ev?.session?.id;
      if (
        typeof candidate === 'string' &&
        candidate &&
        candidate.length <= 256 &&
        candidate !== state.sessionId
      ) {
        state.sessionId = candidate;
        onConversation(candidate);
      }
    };

    const applyTextEvent = (event) => {
      const key = `${state.sessionId || 'dsh'}:text`;
      if (typeof event.delta === 'string') {
        state.accumulatedText += event.delta;
        tracker.updateText({ key, text: event.delta, delta: true });
        return;
      }
      const full = extractDshTextPayload(event);
      if (full !== null) {
        state.accumulatedText = full;
        tracker.updateText({ key, text: full, delta: false });
      }
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
          state.streamError = pickDshErrorText(
            [event.message, event.error, event.error?.message],
            'DeepSeek Harness stream error.'
          );
          return true;
        }
        if (TERMINAL_DSH_TYPES.has(type)) {
          applyDshTerminalEvent(event, state);
          return true;
        }
        if (TEXT_DSH_TYPES.has(type)) {
          applyTextEvent(event);
          return false;
        }
        if (TOOL_CALL_DSH_TYPES.has(type)) projectDshToolCall(event, { tracker, toolNames });
        else if (TOOL_RESULT_DSH_TYPES.has(type))
          projectDshToolResult(event, { tracker, toolNames });
        return false;
      },
      finalize(exitCode) {
        return finalizeDshStreamState({ exitCode, ...state });
      },
    };
  },
};
