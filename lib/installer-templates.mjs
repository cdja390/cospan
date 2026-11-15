import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(SELF_DIR, '..');
export const COSPAN_BIN_PATH = path.join(PACKAGE_ROOT, 'bin', 'cospan.mjs');

function shellQuote(p) {
  return `"${String(p).replaceAll('"', '\\"')}"`;
}

function cliCommandPrefix(cospanBin = COSPAN_BIN_PATH) {
  return `node ${shellQuote(cospanBin)}`;
}

export const MOUNTABLE_TARGET_IDS = ['agy', 'codex', 'claude', 'dsh'];

const TARGET_DOCS = {
  codex: {
    title: 'OpenAI Codex (`codex`)',
    defaultSend: '`gpt-6.1-sol` (`--effort high`)',
    defaultAsk: '`gpt-6.1-sol` (`--effort low`)',
    modelsNote:
      'Default model is `gpt-6.1-sol` (overrideable in `~/.cospan/config.json` or `<workspace>/.cospan/config.json`). Built-in aliases: `sol` (`gpt-6.1-sol`), `terra` (`gpt-6.1-terra`), `astra` (`gpt-6-astra`), `luna` (`gpt-6-luna`), `spark` (`gpt-5.3-codex-spark`). Supported `--effort`: `low`, `medium`, `high`, `xhigh`.',
    strengths:
      'Delegate code review, second-opinion debugging, repository research, or scoped implementation tasks to OpenAI Codex CLI.',
  },
  agy: {
    title: 'Google Antigravity (`agy`)',
    defaultSend: '`gemini-3.8-flash-low`',
    defaultAsk: '`gemini-3.8-flash-low`',
    modelsNote:
      'Default `send` and `ask` model is `gemini-3.8-flash-low` (overrideable in `~/.cospan/config.json` or `<workspace>/.cospan/config.json`). Built-in family/alias mappings: `gemini-3.8-flash` / `flash` (`gemini-3.8-flash-low`), `gemini-4-carbon` / `carbon` (`gemini-4-carbon-high`), `gemini-4-argon` / `argon` (`gemini-4-argon-high`), `gemini-4-hydrogen` / `hydrogen` (`gemini-4-hydrogen-high`), `opus` (`claude-opus-5-5-high`), `sonnet` (`claude-sonnet-5-5-high`), combinable with `--effort low|medium|high` (and `xhigh` for `gemini-4-hydrogen`).',
    strengths:
      'Delegate repository-wide research, multimodal/large-context analysis, code review, or implementation tasks to Google Antigravity CLI.',
  },
  claude: {
    title: 'Anthropic Claude Code (`claude`)',
    defaultSend: '`sonnet` (`--effort high`)',
    defaultAsk: '`sonnet` (`--effort low`)',
    modelsNote:
      'Default model is evergreen `sonnet` (overrideable in `~/.cospan/config.json` or `<workspace>/.cospan/config.json`; pass `inherit` to use Claude Code settings default). Built-in aliases: `sonnet`, `opus`, `haiku`, `fable`, or any explicit Claude model ID. Supported `--effort`: `low`, `medium`, `high`, `xhigh`, `max`.',
    strengths:
      'Delegate code review, architectural analysis, repository debugging, or scoped implementation tasks to Anthropic Claude Code CLI.',
  },
  dsh: {
    title: 'DeepSeek Harness (`dsh`)',
    defaultSend: 'profile default (`inherit`, typically `deepseek-flash`)',
    defaultAsk: 'profile default (`inherit`)',
    modelsNote:
      'Defaults to `inherit` so `dsh --profile headless` uses your configured DeepSeek Harness provider/model without overriding `~/.dsh`. Pass `--model v4.1-flash` or `--model flash` (`deepseek-flash`), `--model pro` (`deepseek-v4-pro`), `--model chat` (`deepseek-chat`), `--model reasoner` (`deepseek-reasoner`), or `<provider>/<model>` plus `--effort low|high|max` to apply an ephemeral `--patch` overlay.',
    strengths:
      'Delegate repository research, verification, second-opinion debugging, or implementation tasks to DeepSeek Harness CLI.',
  },
};

export function renderAgyHostTargetSkill({ targetId, cospanBin }) {
  const doc = TARGET_DOCS[targetId];
  const cmd = cliCommandPrefix(cospanBin);
  const selfNote =
    targetId === 'agy'
      ? ' Use when you need explicit `--model` or `--effort` selection not exposed by built-in subagents, or a detached cospan session.'
      : '';
  return `---
name: cospan-${targetId}
description: Point-to-point headless delegation to ${doc.title} via cospan. ${doc.strengths}${selfNote}
---

# cospan-${targetId} — Delegate to ${doc.title}

\`cospan-${targetId}\` is a **persona-free** point-to-point delegation primitive. Do not rely on hidden role personas—state what you want inspected, reviewed, or changed directly in \`--prompt\`, and choose workspace write intent explicitly (\`--readonly\` vs default writable).

## 1. Launch (\`send\` vs \`ask\`)

- **Background session (\`send\`, default for any real task or tool-using work):**
  \`\`\`bash
  ${cmd} send --to ${targetId} [--readonly] [--restricted] [--raw] [--model <id>] [--effort <low|medium|high|xhigh>] [--timeout 60m] --prompt "<task>"
  \`\`\`
  - **Permissions**: Runs \`unrestricted\` by default so cross-directory reads, builds, and tool caches never stall on OS sandbox prompts. Pass \`--restricted\` (or set \`"permissions": "restricted"\` in \`config.json\`) only when OS sandboxing is explicitly desired.
  - Add \`--readonly\` for research, review, or verification where ${targetId} must NOT modify workspace files.
  - Omit \`--readonly\` when ${targetId} should edit files in the current workspace (pre-existing dirty paths are automatically listed in the envelope, and post-run file deltas are appended to the result).
  - Add \`--raw\` only when passing a pre-framed machine protocol prompt with zero envelope wrapping.
  - For multi-paragraph prompts, write to a scratch file and pass \`--prompt-file <path>\` (or pipe via \`--stdin\`).
  - ${doc.modelsNote}

- **Fast zero-tool foreground check (\`ask\`, seconds-long factual Q&A only):**
  \`\`\`bash
  ${cmd} ask --to ${targetId} --prompt "<short question>"
  \`\`\`

## 2. Antigravity (\`agy\`) Zero-Polling Wait Recipe

After \`send\` prints \`Job <id> started\`, collect it using Antigravity's native background task wakeup—**never poll in a loop**:

1. Run \`send\` with \`run_command\` (\`WaitMsBeforeAsync: 5000\`) to capture \`<job-id>\`.
2. Immediately launch \`wait\` with \`WaitMsBeforeAsync: 500\` so Antigravity backgrounds the wait task:
   \`\`\`bash
   ${cmd} wait <job-id> --timeout 30m
   \`\`\`
3. **End your turn (call no more tools)** unless you have genuinely independent local work to do first. Antigravity will automatically wake you as soon as \`wait\` exits with the deliverable output!
4. Exit codes of \`wait\`: \`0\` = done (stdout has the full report), \`2\` = still running (launch \`wait\` again), \`3\` = error, \`4\` = canceled, \`5\` = timed out with a resumable session (ask the user before continuing).

## 3. Multi-Turn Continuation & Result Discipline

- **Follow up in the exact same ${targetId} session:**
  \`\`\`bash
  ${cmd} continue --id <job-id> --prompt "<delta follow-up instructions>"
  # or resume the latest finished ${targetId} job in this workspace:
  ${cmd} continue --last --to ${targetId} --prompt "<delta follow-up instructions>"
  \`\`\`
  (Send only the delta instruction rather than restating the whole prior prompt; collect the new linked job ID with \`wait\`.)
- **Bounded progress peek (<= 8 KiB JSON with \`phase\` & \`touched_files\`, only if the user asks mid-flight):**
  \`\`\`bash
  ${cmd} observe <job-id>
  \`\`\`
- **Cancel a running job:** \`${cmd} cancel <job-id>\`
- **Result handling & evidence boundaries:**
  - Preserve ${targetId}'s \`file:line\` citations, observed facts vs hypotheses, and severity ordering accurately.
  - Never mask a failed or timed-out delegation with a silent host-side substitute—report the delegation failure first.
  - When \`--readonly\` was used for a review, present the findings to the user before auto-applying controversial edits if they only asked for a review.
`;
}

export function renderAgyHostJobsSkill({ cospanBin }) {
  const cmd = cliCommandPrefix(cospanBin);
  return `---
name: cospan-jobs
description: Internal job collection and lifecycle protocol for cospan background jobs in Antigravity.
user-invocable: false
---

# cospan-jobs (Antigravity Host Protocol)

Manage detached \`cospan\` jobs and trajectories recorded for the current workspace (stored out-of-tree under \`~/.cospan/trajectories/\`):

- \`${cmd} wait <id> --timeout 30m\` — run via \`run_command\` with \`WaitMsBeforeAsync: 500\` and stop calling tools so Antigravity wakes you on completion.
- \`${cmd} observe <id>\` — immediate <= 8 KiB JSON activity snapshot with \`phase\` and \`touched_files\` (never consumes \`result\`).
- \`${cmd} result <id>\` — print stored deliverable of a completed job.
- \`${cmd} continue (--id <id> | --last [--to <target>]) --prompt "..."\` — resume the recorded target session in a linked job.
- \`${cmd} cancel <id>\` — terminate a running worker and its descendant process group safely.
- \`${cmd} status [id]\` — list recent jobs or inspect one job record.
- \`${cmd} config\` — inspect effective config & model mappings (\`~/.cospan/config.json\` + \`<workspace>/.cospan/config.json\`).
`;
}

export function renderCodexHostTargetSkill({ targetId, cospanBin }) {
  const doc = TARGET_DOCS[targetId];
  const cmd = cliCommandPrefix(cospanBin);
  const selfNote =
    targetId === 'codex'
      ? ' Use when you need explicit model/effort selection or an isolated detached cospan session.'
      : '';
  return `---
name: ${targetId}
description: Point-to-point headless delegation to ${doc.title} via cospan ($cospan:${targetId}). ${doc.strengths}${selfNote}
---

# $cospan:${targetId} — Delegate to ${doc.title}

\`$cospan:${targetId}\` is a **persona-free** point-to-point delegation primitive. State the concrete task directly in \`prompt\`, and select \`readonly: true\` (research/review/verification) vs \`readonly: false\` (default writable workspace edits). Runs \`unrestricted\` by default unless \`restricted: true\` or \`config.json\` opts into OS sandboxing.

## 1. Preferred Path: Bundled \`cospan\` MCP Tools

Always prefer the bundled \`cospan\` MCP tools over raw shell command calls—they run outside host command sandboxing and block cleanly inside a single tool call without polling overhead:

1. **Dispatch (\`cospan_send\`):**
   Call MCP tool \`cospan_send\` with:
   - \`cwd\`: **required** absolute path of your current repository/workspace
   - \`to\`: \`"${targetId}"\`
   - \`prompt\`: your task instructions
   - \`readonly\`: \`true\` for read-only inspection/review, \`false\` (default) when file edits are allowed
   - \`restricted\` *(optional)*: \`true\` to opt into strict OS sandboxing (defaults to \`unrestricted\`)
   - \`model\` *(optional)* / \`effort\` *(optional)* / \`raw\` *(optional)* / \`timeout\` *(optional, e.g. \`"60m"\`)*
   - ${doc.modelsNote}

2. **Collect (\`cospan_wait\`):**
   Call MCP tool \`cospan_wait\` with \`{ "cwd": "<workspace>", "id": "<job_id>", "timeout": "20m" }\`.
   - \`cospan_wait\` blocks quietly until the detached worker finishes and returns \`status\` + the full deliverable output in one shot.
   - If \`exit_code === 2\` (\`status === "running"\`), call \`cospan_wait\` again.
   - If \`exit_code === 5\` (\`status === "attention"\`), ask the user before calling \`cospan_continue\`.

3. **Follow-up / Peek / Fast Q&A:**
   - Multi-turn continuation in the same ${targetId} session: \`cospan_continue\` (\`cwd\`, \`id\` or \`last: true\`, \`prompt\` with only the delta instruction) -> then \`cospan_wait\` on the new job ID.
   - Mid-flight bounded snapshot (<= 8 KiB JSON with \`phase\` and \`touched_files\`): \`cospan_observe\` (\`cwd\`, \`id\`).
   - Fast zero-tool foreground Q&A: \`cospan_ask\` (\`cwd\`, \`to: "${targetId}"\`, \`prompt\`).
   - Cancel: \`cospan_cancel\` (\`cwd\`, \`id\`).

4. **Result Handling & Evidence Boundaries:**
   - Preserve ${targetId}'s \`file:line\` citations, observed facts vs inferences, and severity ordering verbatim.
   - Never mask a failed or incomplete delegation with a silent host-side substitute—surface the delegation failure first.
   - When \`readonly: true\` was used for a review, present the findings before auto-applying controversial edits if the user only asked for a review.

## 2. CLI Fallback (only if \`cospan\` MCP server is unavailable)

Run unsandboxed in your workspace directory:
\`\`\`bash
${cmd} send --to ${targetId} [--readonly] --prompt "<task>"
${cmd} wait <job-id> --timeout 10m
\`\`\`
`;
}

export function renderCodexHostJobsSkill() {
  return `---
name: jobs
description: Internal lifecycle reference for cospan detached jobs inside Codex.
user-invocable: false
---

# cospan:jobs (Codex Host Protocol)

Use the \`cospan\` MCP tools with \`cwd\` set to your active workspace root (state & trajectories live under \`~/.cospan/trajectories/\`):
- \`cospan_wait\` — block cleanly on a running \`job_id\` and return the final deliverable.
- \`cospan_observe\` — bounded <= 8 KiB JSON progress snapshot without reading the full result body.
- \`cospan_continue\` — continue a prior \`job_id\`'s native conversation thread (or \`last: true\`).
- \`cospan_result\` — read the stored output of a finished \`job_id\`.
- \`cospan_cancel\` — cancel a running \`job_id\`.
- \`cospan_status\` — list recorded jobs for \`cwd\`.
`;
}
