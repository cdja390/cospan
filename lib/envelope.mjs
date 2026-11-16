import { spawnSync } from 'node:child_process';

const MAX_DIRTY_STATUS_LINES = 100;
const MAX_DIRTY_STATUS_BYTES = 16 * 1024;

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    ...opts,
  });
  return { code: r.status ?? -1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

export function gitPorcelain(cwd) {
  const r = sh('git', ['status', '--porcelain=v1', '-uall'], { cwd });
  return r.code === 0 ? r.out : null;
}

export function gitBranch(cwd) {
  const r = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return r.code === 0 && r.out ? r.out : 'none';
}

export function parsePorcelainPaths(porcelain) {
  if (!porcelain) return new Map();
  const map = new Map();
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    const rest = line.slice(3).trim();
    const arrow = rest.indexOf(' -> ');
    const file = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    map.set(file, status);
  }
  return map;
}

export function formatDirtyContext(porcelain) {
  if (!porcelain) return '';
  const lines = porcelain.split('\n').filter(Boolean);
  if (!lines.length) return '';
  const shown = [];
  let totalBytes = 0;
  for (const line of lines) {
    if (shown.length >= MAX_DIRTY_STATUS_LINES) break;
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (totalBytes + lineBytes > MAX_DIRTY_STATUS_BYTES) break;
    shown.push(line);
    totalBytes += lineBytes;
  }
  const omitted = lines.length - shown.length;
  return (
    `Pre-existing dirty workspace paths (${lines.length} total` +
    (omitted > 0 ? `, ${omitted} omitted` : '') +
    `) — do not revert or touch unrelated edits:\n` +
    shown.map((l) => `  ${l}`).join('\n')
  );
}

/**
 * Compute working-tree changes between `before` and `after` porcelain outputs.
 */
export function computePorcelainDelta(before, after) {
  if (before === null || after === null) return [];
  const prev = parsePorcelainPaths(before);
  const next = parsePorcelainPaths(after);
  const changed = [];
  for (const [file, status] of next) {
    if (prev.get(file) !== status) changed.push(`${status.trim() || 'M'} ${file}`);
  }
  for (const [file] of prev) {
    if (!next.has(file)) changed.push(`reverted/cleaned ${file}`);
  }
  return changed;
}

/**
 * Minimal persona-free protocol envelope (~15 lines).
 * Bypassed completely when `raw` is true (e.g., upper frameworks like HOPF).
 */
export function wrapPrompt({
  prompt,
  cwd,
  branch,
  readonly,
  preExistingPorcelain,
  isContinuation = false,
  raw = false,
}) {
  if (raw) return prompt;
  if (isContinuation) {
    const modeNote = readonly
      ? '[cospan follow-up | mode: readonly — do not create, edit, or delete files]'
      : '[cospan follow-up | mode: writable — ' +
        'never run git commit/push/reset/checkout unless explicitly asked]';
    return `${modeNote}\n\n${prompt}`;
  }

  const lines = [
    '[cospan delegation context]',
    `- Workspace: ${cwd} (git branch: ${branch}, date: ${new Date().toISOString().slice(0, 10)})`,
    readonly
      ? '- Access mode: READ-ONLY. Inspect and analyze freely; ' +
        'do NOT create, edit, or delete any files.'
      : '- Access mode: WRITABLE. You may edit workspace files needed for the task.',
    '- Safety guardrails (default-closed unless the task explicitly asks): ' +
      'never run `git commit`, `git push`, `git reset`, `git clean`, branch switches, ' +
      'package publishes, or destructive system commands.',
    '- Begin your final response with `Status: DONE`, `Status: DONE_WITH_CONCERNS`, ' +
      'or `Status: BLOCKED` followed by a concise, concrete report.',
  ];
  const dirtyBlock = !readonly ? formatDirtyContext(preExistingPorcelain) : '';
  if (dirtyBlock) lines.push(`- ${dirtyBlock}`);

  return `${lines.join('\n')}\n\n[Task]\n${prompt}`;
}
