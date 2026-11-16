#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const HELP_TEXT = [
  '--print --output-format --verbose --add-dir --resume --model --effort',
  '--permission-mode --permission-prompts --dangerously-skip-permissions',
  '--restricted --disallowed-tools --no-session-persistence',
].join(' ');

function parseFakeClaudeArgs(argv) {
  const state = {
    isPrint: false,
    format: 'text',
    verbose: false,
    workspace: process.cwd(),
    resumeId: null,
    model: 'default',
    effort: 'default',
    permMode: 'default',
    permPrompts: 'host',
    skipPerms: false,
    restricted: false,
    disallowedTools: '',
    noPersist: false,
    promptArg: null,
  };

  const valueFlags = {
    '--output-format': (v) => (state.format = v),
    '--add-dir': (v) => (state.workspace = v),
    '--resume': (v) => (state.resumeId = v),
    '-r': (v) => (state.resumeId = v),
    '--model': (v) => (state.model = v),
    '--effort': (v) => (state.effort = v),
    '--permission-mode': (v) => (state.permMode = v),
    '--permission-prompts': (v) => (state.permPrompts = v),
    '--disallowed-tools': (v) => (state.disallowedTools = v),
    '--disallowedTools': (v) => (state.disallowedTools = v),
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p' || a === '--print') state.isPrint = true;
    else if (a === '--verbose') state.verbose = true;
    else if (a === '--dangerously-skip-permissions') state.skipPerms = true;
    else if (a === '--restricted') state.restricted = true;
    else if (a === '--no-session-persistence') state.noPersist = true;
    else if (valueFlags[a]) valueFlags[a](argv[++i] || '');
    else if (!a.startsWith('-')) state.promptArg = a;
  }
  return state;
}

function validateClaudeFlags(st) {
  if (!st.isPrint) {
    process.stderr.write('fake-claude: interactive TUI not supported; pass -p/--print\n');
    process.exit(2);
  }
  if (st.format === 'stream-json' && !st.verbose) {
    process.stderr.write(
      'Error: When using --print, --output-format=stream-json requires --verbose\n'
    );
    process.exit(1);
  }
  if (st.restricted && st.skipPerms) {
    process.stderr.write(
      'Error: --restricted refuses bypassPermissions (--dangerously-skip-permissions)\n'
    );
    process.exit(1);
  }
}

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write('2.1.322-fake (Claude Code)\n');
  process.exit(0);
}
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${HELP_TEXT}\n`);
  process.exit(0);
}

const st = parseFakeClaudeArgs(argv);
validateClaudeFlags(st);

if (process.env.FAKE_CLAUDE_UNAUTH === '1') {
  process.stderr.write('Not logged in · Please run /login\n');
  process.exit(1);
}

const prompt = st.promptArg !== null ? st.promptArg : fs.readFileSync(0, 'utf8');
const sessionId = st.resumeId || 'claude-sess-777';
const delayMs = Number(process.env.FAKE_CLAUDE_DELAY_MS || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.FAKE_CLAUDE_TOUCH_FILE) {
  fs.writeFileSync(
    path.join(st.workspace, process.env.FAKE_CLAUDE_TOUCH_FILE),
    'touched by fake-claude\n'
  );
}

const summary =
  `Status: DONE\nclaude_model=${st.model} effort=${st.effort} perm_mode=${st.permMode} ` +
  `skip_perms=${st.skipPerms} restricted=${st.restricted} ` +
  `disallowed=${st.disallowedTools || 'none'} ` +
  `resumed=${Boolean(st.resumeId)} session=${sessionId}\nprompt_echo=${prompt}`;

if (st.format === 'json') {
  if (delayMs > 0) await sleep(delayMs);
  if (process.env.FAKE_CLAUDE_FAIL === '1') {
    process.stdout.write(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: sessionId,
        errors: ['Simulated claude ask failure'],
      }) + '\n'
    );
    process.exit(1);
  }
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: sessionId,
      result: summary,
      total_cost_usd: 0.002,
      usage: { input_tokens: 20, output_tokens: 12 },
    }) + '\n'
  );
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, model: st.model }) + '\n'
);
process.stdout.write(
  JSON.stringify({
    type: 'assistant',
    session_id: sessionId,
    message: {
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'README.md' } },
      ],
    },
  }) + '\n'
);
process.stdout.write(
  JSON.stringify({
    type: 'user',
    session_id: sessionId,
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: '# temp repo', is_error: false },
      ],
    },
  }) + '\n'
);

if (delayMs > 0) await sleep(delayMs);

if (process.env.FAKE_CLAUDE_FAIL === '1') {
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: sessionId,
      errors: ['Simulated claude stream failure'],
    }) + '\n'
  );
  process.exit(1);
}

process.stdout.write(
  JSON.stringify({
    type: 'assistant',
    session_id: sessionId,
    message: { content: [{ type: 'text', text: summary }] },
  }) + '\n'
);
process.stdout.write(
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    result: summary,
    total_cost_usd: 0.015,
    usage: { input_tokens: 80, output_tokens: 35 },
  }) + '\n'
);
