import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { callTool, TOOLS } from '../mcp/tools.mjs';

const DSH_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DSH_DIR, '..');
const COSPAN_BIN = path.join(REPO_ROOT, 'bin', 'cospan.mjs');
const SKILLS_ROOT = path.join(REPO_ROOT, 'skills');
const PROVIDER_NAME = 'cospan';
const BUNDLED_SKILL_RANK = 600;

export const name = 'cospan';

function parseSkillMarkdown(raw, fallbackName) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(raw);
  if (!match) {
    return { name: fallbackName, description: `Cospan skill (${fallbackName})`, body: raw };
  }
  const [, frontmatter, body] = match;
  const descMatch = /^description:\s*(.+)$/mu.exec(frontmatter);
  const userInvocable = !/^user-invocable:\s*false\s*$/mu.test(frontmatter);
  return {
    name: fallbackName,
    description: descMatch ? descMatch[1].trim().replace(/^["']|["']$/gu, '') : `Cospan skill (${fallbackName})`,
    userInvocable,
    body,
  };
}

function hydrateSkillBody(body, skillDir) {
  return body.replaceAll('<skill-dir>', skillDir || '').replaceAll('<plugin-root>', REPO_ROOT);
}

function loadSkillCandidates() {
  if (!fs.existsSync(SKILLS_ROOT)) return [];
  const candidates = [];
  for (const entry of fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(SKILLS_ROOT, entry.name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    try {
      const raw = fs.readFileSync(skillFile, 'utf8');
      const exposedName = entry.name.startsWith('cospan-') ? entry.name : `cospan-${entry.name}`;
      const parsed = parseSkillMarkdown(raw, exposedName);
      candidates.push({
        name: parsed.name,
        description: parsed.description,
        invocation: {
          modelInvocable: true,
          userInvocable: parsed.userInvocable !== false,
        },
        provider: PROVIDER_NAME,
        source: 'bundled',
        resourceBase: { kind: 'directory', path: skillDir },
        rank: BUNDLED_SKILL_RANK,
        locator: pathToFileURL(skillFile),
        _skillFile: skillFile,
      });
    } catch {}
  }
  return candidates;
}

function resolveSessionCwd(ctx, agent) {
  const fromHeader = agent?.session?.header?.cwd;
  if (typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader;
  const fromPolicy = ctx.get?.('sandboxPolicy')?.workspaceRoot;
  if (typeof fromPolicy === 'string' && fromPolicy.trim()) return fromPolicy;
  return null;
}

function buildDshToolParameters(inputSchema) {
  const required = (inputSchema.required || []).filter((key) => key !== 'cwd');
  return {
    type: 'object',
    additionalProperties: false,
    properties: inputSchema.properties || {},
    ...(required.length ? { required } : {}),
  };
}

function registerCospanTool(toolCtx, toolDef) {
  toolCtx.tools.register({
    name: toolDef.name,
    description: toolDef.description,
    parameters: buildDshToolParameters(toolDef.inputSchema),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          output: { type: 'string' },
        },
        required: ['ok', 'output'],
      },
      render: (_args, value) => [{ type: 'text', text: value.output }],
    },
    async execute(args, exec) {
      const cwd = args?.cwd || resolveSessionCwd(toolCtx, exec?.agent);
      if (!cwd) {
        return { ok: false, output: 'Error: Could not resolve workspace cwd from active DSH session.' };
      }
      const res = await callTool(COSPAN_BIN, toolDef.name, { ...args, cwd });
      const text = res.content?.map((c) => c.text).join('\n') || '';
      return { ok: !res.isError, output: text };
    },
  });
}

export function apply(ctx) {
  ctx.inject(['skills'], (skillCtx) => {
    const provider = {
      name: PROVIDER_NAME,
      list: async () => loadSkillCandidates(),
      async get(candidate) {
        const skillFile = candidate._skillFile;
        const raw = fs.readFileSync(skillFile, 'utf8');
        const parsed = parseSkillMarkdown(raw, candidate.name);
        const skillDir = candidate.resourceBase?.path || path.dirname(skillFile);
        return {
          name: parsed.name,
          description: parsed.description,
          invocation: candidate.invocation,
          provider: PROVIDER_NAME,
          source: 'bundled',
          resourceBase: candidate.resourceBase,
          content: hydrateSkillBody(parsed.body, skillDir),
        };
      },
    };
    skillCtx.effect(() => skillCtx.skills.registerProvider(() => provider), 'cospan: skills provider');
  });

  ctx.inject(['tools'], (toolCtx) => {
    for (const toolDef of TOOLS) {
      registerCospanTool(toolCtx, toolDef);
    }
  });
}
