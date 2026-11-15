import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cospanHomeDir, targetsFilePath } from './config.mjs';

export {
  BUILTIN_CONFIG,
  cospanHomeDir,
  configDir,
  targetsFilePath,
  globalConfigFilePath,
  workspaceTrajectoryDir,
  trajectoryConfigFilePath,
  workspaceConfigCandidates,
  loadEffectiveConfig,
  resolveEffectivePermissions,
  ensureDefaultGlobalConfig,
  writeConfigTemplate,
} from './config.mjs';

export function loadPinnedTargets() {
  try {
    const parsed = JSON.parse(fs.readFileSync(targetsFilePath(), 'utf8'));
    return parsed?.targets && typeof parsed.targets === 'object' ? parsed.targets : {};
  } catch {
    return {};
  }
}

export function savePinnedTargets(targets) {
  const dir = cospanHomeDir();
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    updated_at: new Date().toISOString(),
    targets,
  };
  fs.writeFileSync(targetsFilePath(), JSON.stringify(payload, null, 2) + '\n');
  return targetsFilePath();
}

const CANDIDATE_SPECS = {
  agy: {
    envVar: 'AGY_BIN',
    binName: 'agy',
    phase: 1,
    fallbacks: [path.join(os.homedir(), '.local', 'bin', 'agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy'],
  },
  codex: {
    envVar: 'CODEX_BIN',
    binName: 'codex',
    phase: 1,
    fallbacks: [
      '/opt/homebrew/bin/codex',
      path.join(os.homedir(), '.local', 'bin', 'codex'),
      '/usr/local/bin/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
    ],
  },
  claude: {
    envVar: 'CLAUDE_BIN',
    binName: 'claude',
    phase: 1,
    fallbacks: [
      '/opt/homebrew/bin/claude',
      path.join(os.homedir(), '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
    ],
  },
  dsh: {
    envVar: 'DSH_BIN',
    binName: 'dsh',
    phase: 1,
    fallbacks: [
      '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
      path.join(os.homedir(), '.local', 'bin', 'dsh'),
      '/opt/homebrew/bin/dsh',
    ],
  },
};

function isExecutableFile(filePath) {
  if (!filePath) return false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (/\.(mjs|cjs|js)$/i.test(filePath)) return true;
    if (process.platform !== 'win32') fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function whichBinary(binName) {
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, binName + ext);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

export function resolveTargetBinary(targetId) {
  const spec = CANDIDATE_SPECS[targetId];
  if (!spec) return null;

  const fromEnv = process.env[spec.envVar];
  if (fromEnv) return fromEnv;

  const pinned = loadPinnedTargets()[targetId]?.binary;
  if (pinned && isExecutableFile(pinned)) return pinned;

  const fromPath = whichBinary(spec.binName);
  if (fromPath) return fromPath;

  for (const candidate of spec.fallbacks) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export function buildSpawnCommand(binary, args) {
  if (/\.(mjs|cjs|js)$/i.test(binary)) {
    return { cmd: process.execPath, args: [binary, ...args] };
  }
  return { cmd: binary, args };
}

export function probeTargetVersion(binary) {
  if (!binary) return null;
  try {
    const { cmd, args } = buildSpawnCommand(binary, ['--version']);
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 3000, windowsHide: true });
    if (r.error || r.status !== 0) return null;
    const text = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
    return text.split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

export function discoverAllTargets() {
  const result = {};
  for (const [id, spec] of Object.entries(CANDIDATE_SPECS)) {
    const binary = resolveTargetBinary(id);
    const installed = !!binary && isExecutableFile(binary);
    result[id] = {
      id,
      phase: spec.phase,
      driverReady: spec.phase === 1,
      installed,
      binary: installed ? binary : null,
      version: installed ? probeTargetVersion(binary) : null,
    };
  }
  return result;
}
