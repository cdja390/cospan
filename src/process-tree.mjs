import { spawnSync } from 'node:child_process';

export function signalGroup(pid, signal, runner = spawnSync, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  if (platform === 'win32') {
    try {
      const res = runner('taskkill', ['/PID', String(pid), '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      if (res?.error || (res?.status != null && res.status !== 0)) {
        try {
          process.kill(pid);
        } catch {}
      }
    } catch {
      try {
        process.kill(pid);
      } catch {}
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {}
}

export function parseWindowsProcessTable(stdout) {
  if (!stdout || typeof stdout !== 'string') return [];
  const lines = stdout
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  const format = /^CreationDate/i.test(lines[0]) ? 'wmic' : 'powershell';
  const rows = [];
  for (const line of lines) {
    if (/^(ProcessId|ParentProcessId|CreationDate|--+)/i.test(line)) continue;
    if (format === 'wmic') {
      const match = /^(\S+)\s+(\d+)\s+(\d+)$/.exec(line);
      if (match)
        rows.push({
          pid: Number(match[3]),
          parent: Number(match[2]),
          group: Number(match[3]),
          born: match[1],
        });
    } else {
      const match = /^(\d+)\s+(\d+)\s*(.*)$/.exec(line);
      if (match) {
        rows.push({
          pid: Number(match[1]),
          parent: Number(match[2]),
          group: Number(match[1]),
          born: match[3].trim() || 'unknown',
        });
      }
    }
  }
  return rows;
}

export function windowsProcessTable(runner = spawnSync) {
  let res;
  const psScript =
    'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ' +
    'Select-Object ProcessId,ParentProcessId,' +
    "@{Name='CreationDate';Expression={if ($_.CreationDate) " +
    "{ $_.CreationDate.ToString('o') } else { '' }}}";
  try {
    res = runner('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', psScript], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
  } catch (err) {
    res = { error: err };
  }
  if (res?.error || res?.status !== 0) {
    try {
      res = runner('wmic', ['process', 'get', 'ProcessId,ParentProcessId,CreationDate'], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      });
    } catch (err) {
      res = { error: err };
    }
  }
  if (res?.error || res?.status !== 0 || !res?.stdout) return null;
  return parseWindowsProcessTable(res.stdout);
}

let inspectionUnavailable = false;

export function isInspectionUnavailable() {
  return inspectionUnavailable;
}

function markInspectionUnavailable() {
  if (!inspectionUnavailable) {
    process.stderr.write(
      'cospan warning: process-tree inspection unavailable; ' +
        'run unsandboxed to verify descendant cleanup.\n'
    );
  }
  inspectionUnavailable = true;
  return null;
}

export function processTable() {
  if (process.platform === 'win32') {
    return windowsProcessTable() || markInspectionUnavailable();
  }
  const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
    encoding: 'utf8',
    timeout: 1000,
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  });
  if (ps.error || ps.status !== 0) {
    return markInspectionUnavailable();
  }
  return (ps.stdout || '')
    .trim()
    .split('\n')
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match
        ? [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              group: Number(match[3]),
              born: match[4].trim(),
            },
          ]
        : [];
    });
}

export function parseBorn(born) {
  if (typeof born !== 'string' || !born || born === 'unknown') return null;
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})?$/.exec(
      born
    );
  if (iso) {
    const seconds =
      BigInt(Date.UTC(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5], +iso[6])) / 1000n;
    const ticks = BigInt((iso[7] || '').padEnd(7, '0'));
    const zoneMinutes =
      iso[8] && iso[8] !== 'Z'
        ? (iso[8].startsWith('-') ? -1n : 1n) *
          (BigInt(iso[8].slice(1, 3)) * 60n + BigInt(iso[8].slice(4, 6)))
        : 0n;
    return (seconds - zoneMinutes * 60n) * 10_000_000n + ticks;
  }
  const wmic = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-]\d{3})$/.exec(born);
  if (wmic) {
    const seconds =
      BigInt(Date.UTC(+wmic[1], +wmic[2] - 1, +wmic[3], +wmic[4], +wmic[5], +wmic[6])) / 1000n;
    return (seconds - BigInt(wmic[8]) * 60n) * 10_000_000n + BigInt(wmic[7]) * 10n;
  }
  const legacy = Date.parse(born);
  return Number.isNaN(legacy) ? null : BigInt(legacy) * 10_000n;
}

export function bornAfterParent(child, parent) {
  const c = parseBorn(child?.born);
  const p = parseBorn(parent?.born);
  if (c === null || p === null) return true;
  return c >= p;
}

export function tree(pid, rows = processTable()) {
  if (!rows || !pid) return [];
  const root = rows.find((row) => row.pid === pid);
  if (!root) return [];
  const found = new Map([[pid, root]]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      if (found.has(row.pid) || !found.has(row.parent)) continue;
      if (!bornAfterParent(row, found.get(row.parent))) continue;
      found.set(row.pid, row);
      changed = true;
    }
  }
  return rows.filter((row) => row.pid !== pid && found.has(row.pid));
}

export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  return processTable()?.find((row) => row.pid === pid) || null;
}

export function matchesProcessIdentity(rows, identity) {
  return Boolean(
    identity && rows?.some((row) => row.pid === identity.pid && row.born === identity.born)
  );
}

function adoptDescendants(children, rows) {
  if (!rows) return;
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      if (children.has(row.pid) || row.pid === process.pid) continue;
      const parent = children.get(row.parent);
      if (!parent || !matchesProcessIdentity(rows, parent) || !bornAfterParent(row, parent))
        continue;
      children.set(row.pid, row);
      changed = true;
    }
  }
}

export async function stopExecution(root, known = [], table = processTable) {
  if (!root) return;
  const current = table();
  if (!current) return;
  const children = new Map(
    known.filter((old) => matchesProcessIdentity(current, old)).map((row) => [row.pid, row])
  );
  if (matchesProcessIdentity(current, root)) {
    children.set(root.pid, root);
    for (const row of tree(root.pid, current)) children.set(row.pid, row);
  }
  children.delete(process.pid);
  if (children.size === 0) return;

  const sendSignal = (rows, kind) => {
    adoptDescendants(children, rows);
    const reusedLeader = rows?.some((row) => row.pid === root.pid && row.born !== root.born);
    const ownedMember = rows?.some(
      (row) => row.group === root.pid && children.get(row.pid)?.born === row.born
    );
    if (!reusedLeader && ownedMember) signalGroup(root.pid, kind);
    for (const child of [...children.values()].reverse()) {
      if (matchesProcessIdentity(rows, child)) {
        try {
          process.kill(child.pid, kind);
        } catch {}
      }
    }
  };
  sendSignal(current, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 500));
  sendSignal(table(), 'SIGKILL');
}
