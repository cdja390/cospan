import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const BIN = path.join(ROOT_DIR, 'bin', 'cospan.mjs');
const FAKE_AGY = path.join(TEST_DIR, 'fakes', 'fake-agy.mjs');
const FAKE_CODEX = path.join(TEST_DIR, 'fakes', 'fake-codex.mjs');
const FAKE_CLAUDE = path.join(TEST_DIR, 'fakes', 'fake-claude.mjs');
const FAKE_DSH = path.join(TEST_DIR, 'fakes', 'fake-dsh.mjs');

function makeTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-p2-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# temp repo\n');
  spawnSync('git', ['add', 'README.md'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

function runCospan(args, { cwd, env = {}, input } = {}) {
  const cfgDir = `${cwd}-cospan-cfg`;
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      AGY_BIN: FAKE_AGY,
      CODEX_BIN: FAKE_CODEX,
      CLAUDE_BIN: FAKE_CLAUDE,
      DSH_BIN: FAKE_DSH,
      COSPAN_CONFIG_DIR: cfgDir,
      ...env,
    },
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

test('claude foreground ask + detached send -> wait -> continue lifecycle', () => {
  const repo = makeTempGitRepo();
  try {
    const askUnres = runCospan(['ask', '--to', 'claude', '--prompt', 'hello claude'], { cwd: repo });
    assert.equal(askUnres.code, 0, askUnres.stderr);
    assert.match(
      askUnres.stdout,
      /claude_model=sonnet effort=low.*skip_perms=true.*disallowed=Edit,Write,NotebookEdit/
    );

    const askRes = runCospan(['ask', '--to', 'claude', '--restricted', '--prompt', 'hello restricted claude'], {
      cwd: repo,
    });
    assert.equal(askRes.code, 0, askRes.stderr);
    assert.match(askRes.stdout, /perm_mode=plan skip_perms=false restricted=true/);

    const send1 = runCospan(
      [
        'send',
        '--to',
        'claude',
        '--readonly',
        '--model',
        'opus',
        '--effort',
        'max',
        '--json',
        '--prompt',
        'Audit repo',
      ],
      { cwd: repo }
    );
    assert.equal(send1.code, 0, send1.stderr);
    const { job_id: job1 } = JSON.parse(send1.stdout);
    assert.match(job1, /^claude-/);

    const wait1 = runCospan(['wait', job1, '--timeout', '10s'], { cwd: repo });
    assert.equal(wait1.code, 0, wait1.stderr);
    assert.match(wait1.stdout, /claude_model=opus effort=max.*session=claude-sess-777/);

    const cont = runCospan(['continue', '--last', '--to', 'claude', '--json', '--prompt', 'Check second file'], {
      cwd: repo,
    });
    assert.equal(cont.code, 0, cont.stderr);
    const { job_id: job2, conversation_id: convId } = JSON.parse(cont.stdout);
    assert.equal(convId, 'claude-sess-777');

    const wait2 = runCospan(['wait', job2, '--timeout', '10s'], { cwd: repo });
    assert.equal(wait2.code, 0, wait2.stderr);
    assert.match(wait2.stdout, /resumed=true session=claude-sess-777/);
    assert.match(wait2.stdout, /interactive_resume: claude --resume claude-sess-777/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-cospan-cfg`, { recursive: true, force: true });
  }
});

test('dsh foreground ask + detached send -> wait -> continue lifecycle with zero workspace pollution', () => {
  const repo = makeTempGitRepo();
  try {
    // Default inherit does not patch user's dsh profile
    const askInherit = runCospan(['ask', '--to', 'dsh', '--prompt', 'hello dsh'], { cwd: repo });
    assert.equal(askInherit.code, 0, askInherit.stderr);
    assert.match(askInherit.stdout, /dsh_model=deepseek-flash.*patched=false perm=danger-full-access approval=never/);

    // Explicit model + effort + restricted applies --patch and workspace-write
    const send1 = runCospan(
      [
        'send',
        '--to',
        'dsh',
        '--restricted',
        '--model',
        'pro',
        '--effort',
        'high',
        '--json',
        '--prompt',
        'Verify build',
      ],
      { cwd: repo }
    );
    assert.equal(send1.code, 0, send1.stderr);
    const { job_id: job1 } = JSON.parse(send1.stdout);
    assert.match(job1, /^dsh-/);

    const wait1 = runCospan(['wait', job1, '--timeout', '10s'], { cwd: repo });
    assert.equal(wait1.code, 0, wait1.stderr);
    assert.match(wait1.stdout, /dsh_model=deepseek-v4-pro effort=high patched=true perm=workspace-write/);

    const cont = runCospan(['continue', '--last', '--to', 'dsh', '--json', '--prompt', 'Follow-up dsh'], { cwd: repo });
    assert.equal(cont.code, 0, cont.stderr);
    const { job_id: job2, conversation_id: convId } = JSON.parse(cont.stdout);
    assert.equal(convId, 'dsh-session-888');

    const wait2 = runCospan(['wait', job2, '--timeout', '10s'], { cwd: repo });
    assert.equal(wait2.code, 0, wait2.stderr);
    assert.match(wait2.stdout, /resumed=true session=dsh-session-888/);
    assert.match(wait2.stdout, /interactive_resume: dsh tui --resume dsh-session-888/);

    const gitSt = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    assert.equal(gitSt.stdout.trim(), '');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-cospan-cfg`, { recursive: true, force: true });
  }
});

test('unauthenticated claude/dsh errors surface clearly and doctor --check verifies all 4 targets', () => {
  const repo = makeTempGitRepo();
  try {
    const unauthAsk = runCospan(['ask', '--to', 'claude', '--prompt', 'test'], {
      cwd: repo,
      env: { FAKE_CLAUDE_UNAUTH: '1' },
    });
    assert.notEqual(unauthAsk.code, 0);
    assert.match(unauthAsk.stderr, /Not logged in/);

    const unauthSend = runCospan(['send', '--to', 'dsh', '--json', '--prompt', 'test'], {
      cwd: repo,
      env: { FAKE_DSH_UNAUTH: '1' },
    });
    const { job_id: jobId } = JSON.parse(unauthSend.stdout);
    const unauthWait = runCospan(['wait', jobId, '--timeout', '10s'], { cwd: repo });
    assert.equal(unauthWait.code, 3);
    assert.match(unauthWait.stdout, /No API key or logged-in DeepSeek account configured/);

    const docOk = runCospan(['doctor', '--check', '--json'], { cwd: repo });
    assert.equal(docOk.code, 0, docOk.stderr);
    const parsedDoc = JSON.parse(docOk.stdout);
    assert.equal(parsedDoc.contracts_ok, true);
    for (const id of ['agy', 'codex', 'claude', 'dsh']) {
      assert.equal(parsedDoc.targets[id].driverReady, true);
      assert.equal(parsedDoc.contracts[id].ok, true);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-cospan-cfg`, { recursive: true, force: true });
  }
});
