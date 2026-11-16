import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const BUILTIN_CONFIG = {
  permissions: 'unrestricted',
  defaults: {
    agy: {
      model: 'gemini-3.8-flash-medium',
      askModel: 'gemini-3.8-flash-medium',
      family: 'gemini-3.8-flash',
      effort: 'medium',
    },
    codex: {
      model: 'gpt-6.1-sol',
      effort: 'high',
      askModel: 'gpt-6.1-sol',
      askEffort: 'low',
    },
    claude: {
      model: 'sonnet',
      effort: 'high',
      askModel: 'sonnet',
      askEffort: 'low',
    },
    dsh: {
      model: 'inherit',
      effort: 'inherit',
      askModel: 'inherit',
      askEffort: 'inherit',
      provider: 'deepseek-official',
    },
  },
  mappings: {
    agy: {
      'gemini-3.8-flash': 'gemini-3.8-flash-medium',
      flash: 'gemini-3.8-flash-medium',
      'gemini-4-carbon': 'gemini-4-carbon-medium',
      carbon: 'gemini-4-carbon-medium',
      'gemini-4-argon': 'gemini-4-argon-medium',
      argon: 'gemini-4-argon-medium',
      'gemini-4-hydrogen': 'gemini-4-hydrogen-medium',
      hydrogen: 'gemini-4-hydrogen-medium',
      'claude-opus-5-5': 'claude-opus-5-5-medium',
      opus: 'claude-opus-5-5-medium',
      'claude-sonnet-5-5': 'claude-sonnet-5-5-medium',
      sonnet: 'claude-sonnet-5-5-medium',
    },
    codex: {
      sol: 'gpt-6.1-sol',
      terra: 'gpt-6.1-terra',
      astra: 'gpt-6-astra',
      luna: 'gpt-6-luna',
      spark: 'gpt-5.3-codex-spark',
    },
    claude: {
      sonnet: 'sonnet',
      'sonnet5.5': 'sonnet',
      'sonnet-5.5': 'sonnet',
      opus: 'opus',
      'opus5.5': 'opus',
      'opus-5.5': 'opus',
      haiku: 'haiku',
      fable: 'fable',
    },
    dsh: {
      flash: 'deepseek-flash',
      'v4.1-flash': 'deepseek-flash',
      'deepseek-v4.1-flash': 'deepseek-flash',
      pro: 'deepseek-v4-pro',
      'v4-pro': 'deepseek-v4-pro',
    },
  },
};

export function cospanHomeDir() {
  return (
    process.env.COSPAN_HOME || process.env.COSPAN_CONFIG_DIR || path.join(os.homedir(), '.cospan')
  );
}

export const configDir = cospanHomeDir;

export function targetsFilePath() {
  return path.join(cospanHomeDir(), 'targets.json');
}

export function globalConfigFilePath() {
  return path.join(cospanHomeDir(), 'config.json');
}

export function workspaceTrajectoryDir(workspaceRoot) {
  let canonical = workspaceRoot || process.cwd();
  try {
    canonical = fs.realpathSync(canonical);
  } catch {}
  const baseSlug =
    (path.basename(canonical) || 'workspace')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'workspace';
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return path.join(cospanHomeDir(), 'trajectories', `${baseSlug}-${hash}`);
}

export function trajectoryConfigFilePath(workspaceRoot) {
  return path.join(workspaceTrajectoryDir(workspaceRoot), 'config.json');
}

export function workspaceConfigCandidates(workspaceRoot) {
  if (!workspaceRoot) return [];
  return [
    path.join(workspaceRoot, '.cospan', 'config.json'),
    path.join(workspaceRoot, 'cospan.config.json'),
  ];
}

function isPermissionMode(value) {
  return value === 'restricted' || value === 'unrestricted';
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mergeNestedRecords(targetGroup, incomingGroup) {
  if (!incomingGroup || typeof incomingGroup !== 'object') return;
  for (const [key, vals] of Object.entries(incomingGroup)) {
    if (vals && typeof vals === 'object') {
      targetGroup[key] = { ...(targetGroup[key] || {}), ...vals };
    }
  }
}

function mergeConfigLayer(base, layer) {
  if (!layer || typeof layer !== 'object') return base;
  const out = structuredClone(base);
  if (isPermissionMode(layer.permissions)) {
    out.permissions = layer.permissions;
  }
  mergeNestedRecords(out.defaults, layer.defaults);
  mergeNestedRecords(out.mappings, layer.mappings);
  return out;
}

function nonWorkspaceConfigCandidates(workspaceRoot) {
  const useLegacy = !process.env.COSPAN_HOME && !process.env.COSPAN_CONFIG_DIR;
  const legacyXdgPath = useLegacy
    ? path.join(os.homedir(), '.config', 'cospan', 'config.json')
    : null;
  const trajPath = workspaceRoot ? trajectoryConfigFilePath(workspaceRoot) : null;
  return [legacyXdgPath, globalConfigFilePath(), trajPath].filter(Boolean);
}

/**
 * Load effective configuration across:
 * built-in -> global -> trajectory -> workspace -> explicit `--config`.
 */
export function loadEffectiveConfig({
  workspaceRoot = process.cwd(),
  explicitConfigPath = null,
} = {}) {
  let merged = structuredClone(BUILTIN_CONFIG);
  const loadedFiles = [];

  for (const candidate of nonWorkspaceConfigCandidates(workspaceRoot)) {
    const data = readJsonIfExists(candidate);
    if (data) {
      merged = mergeConfigLayer(merged, data);
      loadedFiles.push(candidate);
    }
  }

  for (const wsCandidate of workspaceConfigCandidates(workspaceRoot)) {
    const data = readJsonIfExists(wsCandidate);
    if (data) {
      merged = mergeConfigLayer(merged, data);
      loadedFiles.push(wsCandidate);
      break;
    }
  }

  const explicit = explicitConfigPath || process.env.COSPAN_CONFIG || null;
  if (explicit) {
    const resolved = path.resolve(explicit);
    const data = readJsonIfExists(resolved);
    if (!data) throw new Error(`cannot read or parse config file: ${resolved}`);
    merged = mergeConfigLayer(merged, data);
    loadedFiles.push(resolved);
  }

  return { config: merged, loadedFiles };
}

export function resolveEffectivePermissions(
  config,
  targetId,
  { restricted = false, unrestricted = false } = {}
) {
  if (restricted) return 'restricted';
  if (unrestricted) return 'unrestricted';
  const targetPerm = targetId ? config?.defaults?.[targetId]?.permissions : null;
  if (isPermissionMode(targetPerm)) return targetPerm;
  if (isPermissionMode(config?.permissions)) return config.permissions;
  return 'unrestricted';
}

export function ensureDefaultGlobalConfig() {
  const file = globalConfigFilePath();
  if (fs.existsSync(file)) return { path: file, created: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(BUILTIN_CONFIG, null, 2) + '\n');
  return { path: file, created: true };
}

export function writeConfigTemplate(targetFile) {
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, JSON.stringify(BUILTIN_CONFIG, null, 2) + '\n');
  return targetFile;
}
