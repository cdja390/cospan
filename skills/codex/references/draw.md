# Raster Image Generation & Editing via Codex (`$imagegen`)

Delegate bitmap image generation and iterative editing to OpenAI Codex CLI's built-in `image_gen` tool (uses the user's ChatGPT subscription quota; no `OPENAI_API_KEY` required).

## 0. Scope & Opt-In Boundaries

- **Explicit opt-in only**: Use this path ONLY when the user explicitly asks to generate or edit an image via Codex / `cospan-codex`. Do not intercept generic image requests meant for the host's own image tools, and inside Codex itself invoke `$imagegen` directly instead of delegating through `cospan`.
- **Bitmap assets only**: Use for raster outputs (icons, logo explorations, illustrations, textures, product/UI mockups, diagrams, cutouts). Do NOT use when editing existing repo-native `SVG`/vector systems or building deterministic `HTML/CSS/Canvas` visuals.
- **Prerequisites & auth boundary**: Requires `codex` CLI signed in with ChatGPT (`codex login status`). Never run interactive `codex login` yourself, and never silently switch to API-key fallback scripts unless the user explicitly asks.

## 1. Dispatch & Collection (MCP Hosts: Claude Code / DeepSeek Harness)

- **Writable access required**: Set `readonly: false` (default) so Codex can copy the generated PNG from `$CODEX_HOME/generated_images/<thread_id>/` to your destination path.
- **Reasoning effort**: Pass `effort: "low"` (or `"medium"` at most)—image generation does not benefit from `high`/`xhigh` reasoning overhead.
- **Dispatch via `cospan_send` + `cospan_wait`**:
  1. Call `cospan_send` with `{ "cwd": "<workspace>", "to": "codex", "readonly": false, "effort": "low", "timeout": "10m", "prompt": "$imagegen <spec>. Use built-in image_gen without asking for confirmation, copy the final PNG to \"<abs-output-path>\", and report the saved path." }`.
  2. Call `cospan_wait` with `{ "cwd": "<workspace>", "id": "<job_id>", "timeout": "10m" }`.
- **Multi-turn refinement in the same visual thread (`cospan_continue`)**:
  Codex's built-in `image_gen` edit mode operates on images already in the thread. Call `cospan_continue` (`id: "<job_id>"`, `effort: "low"`, delta `prompt` listing invariants + new `<abs-v2-path>`), then `cospan_wait`.
- **CLI fallback (only if `cospan` MCP is unavailable)**:
  ```bash
  node "<skill-dir>/../../bin/cospan.mjs" send --to codex --effort low --timeout 10m --prompt '$imagegen <spec>...'
  node "<skill-dir>/../../bin/cospan.mjs" wait <job-id> --timeout 10m
  ```

## 2. File Paths, Dimensions, Transparency & Local Inputs

- **Explicit save path & non-destructive edits**: Built-in `image_gen` writes raw files under `$CODEX_HOME/generated_images/<thread_id>/`. Always give Codex an explicit absolute destination path to copy the final PNG to. Never overwrite an existing asset unless requested—save iterations to sibling paths such as `asset-v2.png`.
- **Aspect orientation vs exact pixel size**: Built-in `image_gen` natively renders aspect orientations (square, landscape, portrait) rather than arbitrary exact pixel dimensions. Ask for orientation by default; ask Codex to resample/resize afterwards only when an exact pixel dimension (e.g. `1024x1024` or `512x512`) is required.
- **Transparent backgrounds**: Ask built-in `image_gen` directly for a genuinely transparent background and preserved alpha channel. If a solid background is returned when alpha is required, refine via `continue` or prompt a flat uniform chroma/white backdrop and key it out locally.
- **Local reference or edit-target images**: Pass absolute file paths in the prompt and label each file's role (`edit target` vs `style/composition reference`). Instruct Codex to load local edit targets with `view_image` first so they enter thread context before calling `image_gen`.
- **Host verification**: Always inspect the saved PNG locally after `wait` completes before presenting it to the user.

## 3. Structured Prompting Checklist

Prefix the task with `$imagegen` and state concrete visual constraints without unrequested creative invention:

- **Asset type & intended use**: e.g. app icon, flat logo mark, landing hero, UI mockup.
- **Subject & framing**: focal metaphor/subject, centering, camera angle, negative space.
- **Style / medium**: e.g. minimalist flat vector-style mark, line icon, studio photo.
- **Palette & backdrop**: 1-3 specific colors/hex codes; solid backdrop vs transparent.
- **Text & negative constraints**: quote exact text verbatim, or state `no text, no lettering, no watermark`.
- **Edit invariants (for edits)**: `change only <X>; keep <Y> unchanged`.
