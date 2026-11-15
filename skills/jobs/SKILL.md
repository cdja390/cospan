---
name: jobs
description: Internal lifecycle reference for cospan detached jobs inside Codex.
user-invocable: false
---

# cospan:jobs (Codex Host Protocol)

Use the `cospan` MCP tools with `cwd` set to your active workspace root (state & trajectories live under `~/.cospan/trajectories/`):
- `cospan_wait` — block cleanly on a running `job_id` and return the final deliverable.
- `cospan_observe` — bounded <= 8 KiB JSON progress snapshot without reading the full result body.
- `cospan_continue` — continue a prior `job_id`'s native conversation thread (or `last: true`).
- `cospan_result` — read the stored output of a finished `job_id`.
- `cospan_cancel` — cancel a running `job_id`.
- `cospan_status` — list recorded jobs for `cwd`.
