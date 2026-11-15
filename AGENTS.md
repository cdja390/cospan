# AGENTS.md

## Engineering & Modularity Rules

1. **Pure ESM & Zero Runtime Dependencies**: Target Node `>=20` using `.mjs` modules only, `node:` prefixes for all built-in imports, and explicit `.mjs` extensions on relative imports. **Never add runtime `dependencies`**; tooling belongs strictly in `devDependencies` and must not enter `package.json` `"files"`.
2. **Thin Entrypoints (`lib/cli.mjs`, `mcp/cospan-mcp.mjs`)**: Keep entry files strictly to argument/RPC dispatch and public re-exports—never accumulate state persistence, worker execution, diagnostics, or subcommand bodies inside a single file.
3. **Module Responsibilities**:
   - `lib/cli-args.mjs` (flags/prompts/help), `lib/job-store.mjs` (state & trajectories), `lib/job-diagnostics.mjs` (bounded `observe` & recovery), `lib/job-worker.mjs` (detached launch & `_worker`), `lib/commands/{dispatch,lifecycle,admin}.mjs` (CLI subcommands).
   - `lib/config.mjs` & `lib/targets.mjs` (layered config & binary discovery), `lib/contract-check.mjs` (zero-token `--help` CLI contract verification), `lib/process-tree.mjs` & `lib/stream-worker.mjs` (descendant PID tracking & NDJSON streaming), `lib/installer-templates.mjs` & `lib/installer.mjs` (host bundles), `lib/drivers/{agy,codex,claude,dsh}.mjs` (target harnesses), `mcp/{cospan-mcp,tools}.mjs` (stdio MCP).
4. **Hard Anti-Bloat Gates**: Every `.mjs` module must stay `<= 350` effective lines (`max-lines`), functions `<= 80` lines (`max-lines-per-function`), nesting `<= 4` (`max-depth`), cyclomatic complexity `<= 15` (`complexity`), with zero circular imports (`import-x/no-cycle`).
5. **Contract Stability**: Preserve CLI flags, job exit codes (`0/2/3/4/5`), `<= 8 KiB` bounded `observe` JSON, out-of-tree `~/.cospan/trajectories/` storage, public exports (`durationToMs`, `repoRoot`, `workspaceStateDir`, `parseCliArgs`, `JOB_EXIT_CODES`, `main`), and stdio MCP behavior.
6. **Mandatory Verification Gate**: Every change must pass `npm run lint`, `npm run format:check`, and `npm test` (plus `node bin/cospan.mjs install` whenever installer templates, skills, or `mcp/` files change) before completion.
