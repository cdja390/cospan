import { createActivityTracker, createParser, excerpt } from '../observation.mjs';
import { BUILTIN_CONFIG, loadEffectiveConfig } from '../targets.mjs';

const VALID_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

function cleanCodexStderr(stderr) {
  return String(stderr || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l && !l.startsWith('WARNING: proceeding, even though we could not update PATH:'))
    .join('\n');
}

function normalizeCodexEffort(effort, fallback) {
  if (!effort) return fallback;
  const e = String(effort).toLowerCase();
  if (e === 'inherit') return null;
  if (VALID_EFFORTS.has(e)) return e;
  if (e === 'max') {
    process.stderr.write(
      `cospan: codex uses low|medium|high|xhigh reasoning effort; mapping --effort max -> xhigh\n`
    );
    return 'xhigh';
  }
  throw new Error(
    `invalid --effort "${effort}" for codex (expected none|minimal|low|medium|high|xhigh)`
  );
}

function pickCodexBaseDefaults(defaults, kind) {
  const sendModel = defaults.model || defaults.sendModel || 'gpt-6.2-sol';
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

export function resolveCodexModelAndEffort({ kind = 'send', model, effort, config } = {}) {
  const effective = config || loadEffectiveConfig().config;
  const defaults = { ...BUILTIN_CONFIG.defaults.codex, ...(effective?.defaults?.codex || {}) };
  const mappings = { ...BUILTIN_CONFIG.mappings.codex, ...(effective?.mappings?.codex || {}) };

  const { defaultModel, defaultEffort } = pickCodexBaseDefaults(defaults, kind);
  const rawModel = model || defaultModel;
  const resolvedModel =
    rawModel === 'inherit'
      ? null
      : Object.hasOwn(mappings, rawModel)
        ? mappings[rawModel]
        : rawModel;
  const resolvedEffort = normalizeCodexEffort(
    effort,
    defaultEffort === 'inherit' ? null : defaultEffort
  );
  return { model: resolvedModel, effort: resolvedEffort };
}

function mapItemStatus(rawStatus, eventType) {
  if (rawStatus === 'failed' || rawStatus === 'declined' || rawStatus === 'errored') return 'error';
  if (rawStatus === 'completed' || eventType === 'item.completed') return 'done';
  return 'running';
}

function projectFileChangeItem(item, key, status, tracker) {
  const changes = Array.isArray(item.changes) ? item.changes : null;
  const paths = changes ? changes.map((c) => c.path).filter(Boolean) : [];
  const summary = changes
    ? changes.map((c) => `${c.kind || 'edit'} ${c.path}`).join(', ')
    : 'patch';
  tracker.upsertActivity({ key, tool: 'file_change', status, input: summary, touchedFiles: paths });
}

const ITEM_PROJECTORS = {
  agent_message(item, key, status, ctx) {
    if (typeof item.text === 'string') {
      ctx.setLastAgentMessage(item.text);
      ctx.tracker.updateText({ key, text: item.text, delta: false, status });
    }
  },
  command_execution(item, key, status, ctx) {
    const fallbackOut = item.exit_code != null ? `exit ${item.exit_code}` : undefined;
    ctx.tracker.upsertActivity({
      key,
      tool: 'command_execution',
      status,
      input: item.command,
      output: item.aggregated_output || fallbackOut,
    });
  },
  file_change(item, key, status, ctx) {
    projectFileChangeItem(item, key, status, ctx.tracker);
  },
  mcp_tool_call(item, key, status, ctx) {
    const toolLabel =
      item.server && item.tool ? `mcp:${item.server}/${item.tool}` : 'mcp_tool_call';
    ctx.tracker.upsertActivity({
      key,
      tool: toolLabel,
      status,
      input: item.arguments,
      output: item.error || item.result,
    });
  },
  web_search(item, key, status, ctx) {
    ctx.tracker.upsertActivity({ key, tool: 'web_search', status, input: item.query });
  },
  collab_tool_call(item, key, status, ctx) {
    ctx.tracker.upsertActivity({
      key,
      tool: `collab:${item.tool || 'call'}`,
      status,
      input: item.prompt,
    });
  },
  error(item, _key, _status, ctx) {
    if (!item.message) return;
    const bounded = excerpt(item.message, 256).text;
    if (ctx.itemErrors.length < 3) ctx.itemErrors.push({ message: bounded });
    ctx.tracker.warn(bounded);
  },
};

function buildRestrictedExecPermFlags(readonly, isResume) {
  if (isResume) {
    const mode = readonly ? 'sandbox_mode="read-only"' : 'sandbox_mode="workspace-write"';
    return ['-c', mode, '-c', 'approval_policy="never"'];
  }
  return ['-s', readonly ? 'read-only' : 'workspace-write', '-c', 'approval_policy="never"'];
}

function finalizeCodexStream({
  exitCode,
  streamErrorMessage,
  itemErrors,
  turnCompleted,
  lastAgentMessage,
  threadId,
  usage,
}) {
  const native = {
    target: 'codex',
    exit_code: exitCode,
    ...(streamErrorMessage ? { stream_error: excerpt(streamErrorMessage, 512).text } : {}),
    ...(itemErrors.length ? { errors: itemErrors } : {}),
  };
  if (streamErrorMessage) {
    return { payload: null, streamFailure: streamErrorMessage, native };
  }
  if (turnCompleted || (typeof lastAgentMessage === 'string' && lastAgentMessage.length > 0)) {
    return {
      payload: { response: lastAgentMessage ?? '', conversation_id: threadId, usage },
      streamFailure: null,
      native,
    };
  }
  return { payload: null, streamFailure: null, native };
}

export const codexDriver = {
  id: 'codex',
  displayName: 'OpenAI Codex CLI',
  installHint:
    'Codex CLI was not found. Install `@openai/codex` or Codex.app ' +
    'and verify with `codex --version`.',

  humanResumeCommand(conversationId) {
    return conversationId ? `codex resume ${conversationId}` : null;
  },

  resolveConfig({ kind = 'send', model, effort, config } = {}) {
    return resolveCodexModelAndEffort({ kind, model, effort, config });
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
    const unrestricted = permissions !== 'restricted';
    const modelFlags = [
      ...(model ? ['-m', model] : []),
      ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
    ];

    if (kind === 'ask') {
      const permFlags = unrestricted
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['-s', 'read-only', '-c', 'approval_policy="never"'];
      const args = [
        'exec',
        '--json',
        '--ephemeral',
        '-C',
        workspace,
        '--skip-git-repo-check',
        ...permFlags,
        ...modelFlags,
        '-',
      ];
      return { args, stdinText: prompt, cwd: workspace };
    }

    if (conversationId) {
      // IMPORTANT: `codex exec resume` does NOT accept `-C` or `-s` flags!
      const permFlags = unrestricted
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : buildRestrictedExecPermFlags(readonly, true);
      const args = [
        'exec',
        'resume',
        '--json',
        '--skip-git-repo-check',
        ...permFlags,
        ...modelFlags,
        conversationId,
        '-',
      ];
      return { args, stdinText: prompt, cwd: workspace };
    }

    const permFlags = unrestricted
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : buildRestrictedExecPermFlags(readonly, false);
    const args = [
      'exec',
      '--json',
      '-C',
      workspace,
      '--skip-git-repo-check',
      ...permFlags,
      ...modelFlags,
      '-',
    ];
    return { args, stdinText: prompt, cwd: workspace };
  },

  parseForegroundOutput({ stdout, stderr, exitCode }) {
    const cleanedStderr = cleanCodexStderr(stderr);
    const session = codexDriver.createStreamSession();
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
          `codex ask did not return a completed turn (exit ${exitCode}): ${cleanedStderr || stdout}`
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
    let threadId = null;
    let lastAgentMessage = null;
    let turnCompleted = false;
    let usage = null;
    let streamErrorMessage = null;
    const itemErrors = [];
    const projCtx = {
      tracker,
      itemErrors,
      setLastAgentMessage: (txt) => {
        lastAgentMessage = txt;
      },
    };

    const dispatchItemEvent = (type, item) => {
      if (type !== 'item.started' && type !== 'item.updated' && type !== 'item.completed') return;
      const projector = item && typeof item === 'object' ? ITEM_PROJECTORS[item.type] : null;
      if (projector) {
        projector(
          item,
          `${threadId || 'thread'}:${item.id || 'item'}`,
          mapItemStatus(item.status, type),
          projCtx
        );
      }
    };

    return {
      warn: tracker.warn,
      snapshot: tracker.snapshot,
      writeStderr() {},
      acceptEvent(event) {
        tracker.touch();
        const type = event?.type;
        if (type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id) {
          if (event.thread_id !== threadId) {
            threadId = event.thread_id;
            onConversation(threadId);
          }
          return false;
        }
        if (type === 'turn.completed') {
          turnCompleted = true;
          usage = event.usage || null;
          return true;
        }
        if (type === 'turn.failed') {
          streamErrorMessage = event.error?.message || 'Codex turn failed.';
          return true;
        }
        if (type === 'error') {
          streamErrorMessage = event.message || 'Codex stream error.';
          return false;
        }
        dispatchItemEvent(type, event?.item);
        return false;
      },
      finalize(exitCode) {
        return finalizeCodexStream({
          exitCode,
          streamErrorMessage,
          itemErrors,
          turnCompleted,
          lastAgentMessage,
          threadId,
          usage,
        });
      },
    };
  },
};
