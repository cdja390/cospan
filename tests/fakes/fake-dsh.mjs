#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const VALID_DSH_EFFORTS = new Set(['off', 'low', 'high', 'max']);

function validatePatchOverlay(patchPath) {
  const parsed = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
  if (!Array.isArray(parsed) || !parsed[0] || parsed[0].id !== 'agent-default-model') {
    throw new Error('invalid dsh --patch: expected array with id="agent-default-model"');
  }
  const cfg = parsed[0].config || {};
  if (!cfg.provider || !cfg.model) {
    throw new Error('invalid dsh --patch: agent-default-model requires provider and model');
  }
  if (cfg.reasoningEffort != null && !VALID_DSH_EFFORTS.has(cfg.reasoningEffort)) {
    throw new Error(`invalid dsh reasoningEffort: ${cfg.reasoningEffort}`);
  }
  return cfg;
}

function parseFakeDshArgs(argv) {
  const st = {
    profile: null,
    patchFiles: [],
    json: false,
    sessionId: null,
    permMode: 'workspace-write',
    approval: 'ask',
    help: false,
    taskArg: null,
  };
  let seenAppFlag = false;

  const launcherValueFlags = {
    '--profile': (v) => (st.profile = v || null),
    '--patch': (v) => st.patchFiles.push(v || ''),
  };
  const appValueFlags = {
    '--session-id': (v) => (st.sessionId = v || null),
    '--permission-mode': (v) => (st.permMode = v || ''),
    '--approval-policy': (v) => (st.approval = v || ''),
    '--add-dir': () => {},
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      st.help = true;
    } else if (launcherValueFlags[a]) {
      if (seenAppFlag) throw new Error(`${a} launcher flag must precede app flags`);
      launcherValueFlags[a](argv[++i]);
    } else if (a === '--json') {
      seenAppFlag = true;
      st.json = true;
    } else if (appValueFlags[a]) {
      seenAppFlag = true;
      appValueFlags[a](argv[++i]);
    } else {
      seenAppFlag = true;
      st.taskArg = a;
    }
  }
  return st;
}

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-V')) {
  process.stdout.write('0.2.2-rc.1-fake\n');
  process.exit(0);
}

let st;
try {
  st = parseFakeDshArgs(argv);
} catch (err) {
  process.stderr.write(`fake-dsh flag error: ${err.message}\n`);
  process.exit(2);
}

if (st.help) {
  const out =
    st.profile === 'headless'
      ? '--json --session-id --permission-mode --approval-policy --add-dir\n'
      : '--profile --patch --dump-config --dump-config-schema\n';
  process.stdout.write(out);
  process.exit(0);
}

if (st.profile !== 'headless') {
  process.stderr.write(`fake-dsh: expected --profile headless, got ${st.profile}\n`);
  process.exit(2);
}

let modelCfg = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'default',
};
try {
  for (const p of st.patchFiles) modelCfg = validatePatchOverlay(p);
} catch (err) {
  process.stderr.write(`fake-dsh patch error: ${err.message}\n`);
  process.exit(2);
}

if (process.env.FAKE_DSH_UNAUTH === '1') {
  process.stdout.write(
    JSON.stringify({
      type: 'error',
      message: 'No API key or logged-in DeepSeek account configured.',
    }) + '\n'
  );
  process.exit(1);
}

const prompt = st.taskArg === '-' ? fs.readFileSync(0, 'utf8') : st.taskArg || '';
const sessionId = st.sessionId || 'dsh-session-888';
const delayMs = Number(process.env.FAKE_DSH_DELAY_MS || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.FAKE_DSH_TOUCH_FILE) {
  fs.writeFileSync(
    path.join(process.cwd(), process.env.FAKE_DSH_TOUCH_FILE),
    'touched by fake-dsh\n'
  );
}

process.stderr.write('dsh: reasoning: inspecting repository...\n');
process.stdout.write(JSON.stringify({ type: 'session', sessionId }) + '\n');
process.stdout.write(
  JSON.stringify({
    type: 'tool_call',
    id: 'call_1',
    name: 'read_file',
    input: { path: 'README.md' },
  }) + '\n'
);
process.stdout.write(
  JSON.stringify({
    type: 'tool_result',
    id: 'call_1',
    name: 'read_file',
    output: '# temp repo',
  }) + '\n'
);

if (delayMs > 0) await sleep(delayMs);

if (process.env.FAKE_DSH_FAIL === '1') {
  process.stdout.write(
    JSON.stringify({ type: 'error', message: 'Simulated dsh execution failure' }) + '\n'
  );
  process.exit(1);
}

const summary =
  `Status: DONE\ndsh_provider=${modelCfg.provider} dsh_model=${modelCfg.model} ` +
  `effort=${modelCfg.reasoningEffort || 'default'} patched=${st.patchFiles.length > 0} ` +
  `perm=${st.permMode} approval=${st.approval} ` +
  `resumed=${Boolean(st.sessionId)} session=${sessionId}\nprompt_echo=${prompt}`;

process.stdout.write(JSON.stringify({ type: 'text', delta: summary }) + '\n');
process.stdout.write(
  JSON.stringify({
    type: 'final',
    sessionId,
    text: summary,
    usage: { input_tokens: 60, output_tokens: 28 },
  }) + '\n'
);
