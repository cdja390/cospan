#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-V')) {
  process.stdout.write('codex-cli 0.167.2-fake\n');
  process.exit(0);
}

if (argv[0] !== 'exec') {
  process.stderr.write(`fake-codex: unsupported command ${argv[0]}\n`);
  process.exit(2);
}

const isResume = argv[1] === 'resume';
const rest = isResume ? argv.slice(2) : argv.slice(1);
if (rest.includes('--help') || rest.includes('-h')) {
  const flags = isResume
    ? '--json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --config --model'
    : '--json --ephemeral --skip-git-repo-check ' +
      '--dangerously-bypass-approvals-and-sandbox --sandbox --config --model';
  process.stdout.write(`${flags}\n`);
  process.exit(0);
}

// Strictly enforce real Codex CLI flag asymmetry: `codex exec resume` rejects `-C` and `-s`!
if (
  isResume &&
  (rest.includes('-C') ||
    rest.includes('--cd') ||
    rest.includes('-s') ||
    rest.includes('--sandbox'))
) {
  process.stderr.write('error: unexpected argument -C/-s found in `codex exec resume`\n');
  process.exit(2);
}

let model = 'default';
let workspace = process.cwd();
let sandbox = 'default';
let bypass = false;
const configs = [];
const positionals = [];

for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--json' || a === '--skip-git-repo-check' || a === '--ephemeral') continue;
  if (a === '--dangerously-bypass-approvals-and-sandbox') {
    bypass = true;
    continue;
  }
  if (a === '-m' || a === '--model') {
    model = rest[++i] || '';
    continue;
  }
  if (a === '-C' || a === '--cd') {
    workspace = rest[++i] || workspace;
    continue;
  }
  if (a === '-s' || a === '--sandbox') {
    sandbox = rest[++i] || '';
    continue;
  }
  if (a === '-c' || a === '--config') {
    configs.push(rest[++i] || '');
    continue;
  }
  positionals.push(a);
}

let threadId = 'codex-thread-999';
let promptArg;
if (isResume) {
  threadId = positionals[0] || threadId;
  promptArg = positionals[1] || '-';
} else {
  promptArg = positionals[0] || '-';
}

const prompt = promptArg === '-' ? fs.readFileSync(0, 'utf8') : promptArg;
const delayMs = Number(process.env.FAKE_CODEX_DELAY_MS || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.FAKE_CODEX_TOUCH_FILE) {
  fs.writeFileSync(
    path.join(workspace, process.env.FAKE_CODEX_TOUCH_FILE),
    'touched by fake-codex\n'
  );
}

process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\n');
process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\n');

if (process.env.FAKE_CODEX_HANG === '1') {
  await sleep(60000);
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_cmd_1',
      type: 'command_execution',
      command: 'git status --short',
      aggregated_output: 'clean',
      exit_code: 0,
      status: 'completed',
    },
  }) + '\n'
);

if (delayMs > 0) await sleep(delayMs);

if (process.env.FAKE_CODEX_FAIL === '1') {
  process.stdout.write(
    JSON.stringify({
      type: 'turn.failed',
      error: { message: 'Simulated codex turn failure' },
    }) + '\n'
  );
  process.exit(1);
}

const text =
  `Status: DONE\ncodex_model=${model} bypass=${bypass} sandbox=${sandbox} ` +
  `resumed=${isResume} thread=${threadId} configs=${configs.join(';')}\nprompt_echo=${prompt}`;

process.stdout.write(
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_msg_1',
      type: 'agent_message',
      text,
    },
  }) + '\n'
);

process.stdout.write(
  JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: 100,
      cached_input_tokens: 40,
      cache_write_input_tokens: 0,
      output_tokens: 30,
      reasoning_output_tokens: 10,
    },
  }) + '\n'
);
