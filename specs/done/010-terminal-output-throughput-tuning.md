# 010 - Terminal Output Throughput Tuning

> **STATUS: SUPERSEDED / NOT PURSUED (see spec 013).** This spec proposed tuning the PTY
> flow-control pipeline (bounded main-process batching, sequence-numbered acks, backpressure,
> bounded xterm draining). That entire pipeline has since been **removed**, not tuned: PTY output
> is now relayed directly to xterm (`sendDirectPtyOutput`, `seq=0`, synchronous `terminal.write`)
> with no coalescing, acks, or pause/resume. In practice node-pty + xterm absorb the volume and the
> result is noticeably more responsive. The "short no-scroll output dropped" problem this spec was
> partly motivated by turned out to be an unrelated **PATH-rewrite** bug (see
> `specs/done/013-vscode-style-terminal-rebuild.md`), not a throughput issue.
>
> What was kept from this spec: **Phase 5** (resize is now one-way `ipc.send('pty:resize')`, not
> `invoke`) and the high default scrollback with a Settings control (Phase 6). The Warp research
> below is retained as background only. Do **not** reintroduce batching/ack/backpressure for the
> shell path; if an agent ever needs flood backpressure, add it agent-only and prove it leaves
> shell no-scroll output untouched.

## Problem

The app embeds xterm.js inside Electron and feeds it PTY output through:

`node-pty worker -> main process -> Electron IPC -> renderer -> xterm.write(...)`

This is a different architecture from Warp's native Rust terminal. Warp can parse PTY bytes directly in a native event loop, keep a first-class terminal model, coalesce redraw wakeups, and render only visible/dirty grid structures through a native GPU renderer. Rewriting this app toward that model is not appropriate right now, but the comparison highlights practical optimizations for our existing Electron/xterm pipeline.

Current risk areas:

- PTY output can cross multiple IPC/string boundaries before xterm consumes it.
- Main-process coalescing currently flushes on `setImmediate`, which may still produce many renderer IPC events during bursts.
- Renderer output draining writes up to `128 KiB` chunks into xterm with no explicit per-frame time budget.
- Resize uses `ipc.invoke('pty:resize', ...)` even though the renderer does not need a response.
- `CLAUDE.md` documents sequence-numbered PTY output acks and 5ms coalescing, but the current source still appears to use event-loop-turn coalescing plus renderer-side pause/resume. The implementation and durable docs need to be reconciled.

The goal is not to match Warp's terminal architecture. The goal is to improve throughput and responsiveness while preserving xterm.js, WebGL rendering, high scrollback, pane remount survival, and agent-specific terminal behavior.

## Research Notes

Local Warp source reviewed from `C:\Users\cdhan\Desktop\warp`:

- Warp's terminal model is split into a Rust `warp_terminal` crate and app-level block/grid handling. The useful lesson is the boundary, not the implementation: parse/model changes happen before rendering, and render work is based on structured rows/grids rather than repeated whole-string repaint intent.
- `crates/warp_terminal/src/model/grid/row.rs` tracks an `occ` dirty/occupied boundary per row and exposes `dirty_cells()`. This reinforces that our Electron path should reduce unnecessary full-buffer/string churn before xterm sees it, but we should not recreate a custom dirty grid while xterm owns parsing/rendering.
- `app/src/terminal/model/blockgrid.rs` caches expensive finished-grid measurements such as rightmost visible non-empty cell and visible-content presence. For this app, the comparable low-risk optimization is to keep instrumentation summaries and byte accounting in small per-PTY state objects rather than recomputing queue totals from arrays on every chunk.
- `specs/tui-output-redraw/TECH.md` covers a Warp-specific issue where CLI agent primary-screen resize/full-clear redraws can accidentally accumulate historical frames. This app already passes `--no-alt-screen` for agents and uses xterm's normal terminal semantics, so we should not port Warp's block-grid behavior. However, it adds an important manual scenario: repeatedly resize a Claude/Codex pane during a full-screen/frame-style redraw and confirm old frames do not visually accumulate, flicker excessively, or flood scrollback.
- Warp tracks terminal/grid memory with helpers such as `estimated_memory_usage_bytes()` and `flat_storage_bytes()`. This is a good argument for measuring scrollback memory before adding a setting or lowering defaults.

External references checked:

- Warp's public architecture notes describe a Rust terminal with a GPU-rendered UI and block-based command output model. This supports the high-level comparison already in this spec, but does not justify replacing xterm.js in this app.
- xterm.js flow-control docs say `write()` buffers input and processes it on later event-loop turns with a time constraint intended to avoid blocking a frame. That means renderer-side chunking should be benchmarked against xterm's internal parser budget; too many tiny chunks can add overhead, while very large chunks can still create queue and callback latency.
- xterm.js exposes `onWriteParsed`, which fires after parsing and at most once per frame. If callback timing is not enough to understand stalls, instrumentation can optionally listen to `onWriteParsed` in development builds to distinguish "write accepted" from "parser caught up for this frame."

## Current Behavior

Relevant app files:

- `src/main/pty/PtyManager.ts`
- `src/main/pty/ptyWorker.ts`
- `src/main/ipc/handlers.ts`
- `src/preload/index.ts`
- `src/shared/types.ts`
- `src/renderer/src/components/Terminal/index.tsx`
- `src/renderer/src/utils/xtermRegistry.ts`

Current output flow:

1. `ptyWorker.ts` receives `node-pty` data and sends `{ type: 'data', id, data }` to main.
2. `PtyManager` emits `data`.
3. `handlers.ts` appends data to a per-PTY string buffer and flushes it with `setImmediate`.
4. Main sends `pty:data` to the owning renderer window.
5. `Terminal` queues string chunks, pauses node-pty at `1 MiB` queued data, resumes at `256 KiB`, and writes chunks to xterm in `128 KiB` slices.
6. Resize calls flush pending output and uses `ipc.invoke('pty:resize', ...)`.

Good existing decisions to preserve:

- `node-pty` is isolated in a child process with `ELECTRON_RUN_AS_NODE=1`.
- xterm instances survive React remounts through `xtermRegistry`.
- xterm uses the WebGL addon when available.
- Backpressure exists through `pty:pause-output` / `pty:resume-output`.
- Terminal scrollback is intentionally high (`250_000`) for long-running Claude/Codex chats.
- Agent panes pass terminal flags/env vars that reduce flicker and avoid unsupported alternate-screen/mouse behavior.

## Intended Behavior

PTY output should arrive at xterm in fewer, better-shaped batches without making interactive typing feel delayed.

Implementation should:

- Preserve high scrollback by default; do not reduce `TERMINAL_SCROLLBACK_LINES` as a hidden performance fix.
- Add measurement first so tuning decisions are data-driven.
- Batch raw PTY output in main over a short bounded window, not just the current event-loop turn.
- Add sequence-numbered renderer acknowledgements or otherwise reconcile the current implementation with the durable PTY flow-control notes in `CLAUDE.md`.
- Keep xterm writes bounded so large bursts cannot monopolize the renderer event loop.
- Use one-way IPC for resize where no return value is needed.
- Keep all changes scoped to the Electron/xterm pipeline; do not introduce a custom terminal parser or renderer.

## Implementation Phases

### Phase 1 - Instrument The Pipeline

Add development-only counters/logging behind a small flag or local constant:

- PTY bytes received from worker per second.
- Number and size of main-to-renderer `pty:data` sends.
- Renderer queued bytes high-water mark.
- xterm write chunk size and write callback latency.
- Optional xterm `onWriteParsed` frame cadence/latency in profiling builds, if useful for separating parser backlog from IPC/write callback timing.
- Pause/resume counts per PTY.
- Resize count per PTY during pane drag/fit operations.
- Scrollback/memory proxy metrics where cheap: terminal count, configured scrollback, queued chars, and Chromium heap snapshots during stress runs. Do not add expensive per-cell accounting in production.

Keep this lightweight and disabled by default. It should be easy to enable while profiling but must not spam normal users.

### Phase 2 - Main-Process Output Batching

Replace `setImmediate`-only coalescing with a bounded batcher:

- Per PTY, append incoming chunks to a buffer.
- Flush when either:
  - the buffer reaches a max size, initially `256 KiB`, or
  - a short timer fires, initially `5ms`.
- Flush immediately on PTY exit.
- Flush before resize, preserving current behavior that resize does not lag behind queued output.
- Keep OSC 7 parsing immediate enough for prompt CWD updates; parsing can still inspect each incoming chunk before batch flush.
- Avoid unbounded string concatenation during pathological bursts. If the batcher accumulates many chunks before a size flush, prefer an array plus joined flush or another structure that does not repeatedly copy a growing string.

This mirrors the useful part of Warp's coalesced wakeup model while staying inside Electron IPC.

### Phase 3 - Renderer Acks And Backpressure

Implement a sequence-numbered ack model if it is not already present:

- Main tags each `pty:data` payload with a monotonically increasing sequence number and byte length.
- Renderer acks after xterm's `write` callback has consumed the payload.
- Main tracks in-flight bytes per PTY and pauses node-pty when in-flight plus queued bytes exceeds a high watermark.
- Main resumes node-pty when acknowledged bytes bring the total below a low watermark.
- Keep renderer-side queueing simple; avoid independent pause/resume decisions in both main and renderer unless the ownership boundary is explicit.
- Define renderer teardown semantics before adding acks: if a window unloads, pane transfers, or the listener unsubscribes with unacked bytes, main must either reroute those bytes to the new owner or drop only bytes that have already been durably written into xterm. Do not leave the PTY paused waiting for a destroyed renderer.

If implementation chooses not to add acks, update `CLAUDE.md` to remove the claim. Do not leave durable docs describing a flow-control design that the code does not implement.

### Phase 4 - Bounded Xterm Draining

Tune xterm write draining:

- Benchmark `32 KiB`, `64 KiB`, and `128 KiB` `XTERM_WRITE_CHUNK_CHARS` values.
- Prefer the smallest chunk that keeps throughput high without visible frame stalls.
- Add a per-frame or per-turn drain budget if large bursts still block UI responsiveness.
- Account for xterm's own internal parser budget: `terminal.write()` returning or invoking its callback does not mean a frame has painted, and over-slicing can fight xterm's internal batching.
- Preserve order exactly. Never drop output.
- On cancellation/unmount, resume paused PTYs before discarding renderer queues, preserving the current safety behavior.

Expected initial candidate: `64 KiB`, inspired by Warp's bounded processing/yield behavior, but validate locally.

### Phase 5 - Resize IPC Cleanup

Change terminal resize from request/response IPC to one-way IPC:

- Move `pty:resize` from `InvokeChannels` to `SendChannels` in `src/shared/types.ts` and keep the channel signature in `IPCChannels`.
- Main should handle resize with `ipcMain.on(...)`.
- Renderer should call `window.ipc.send('pty:resize', ...)` and should not allocate a Promise for every resize.
- Preserve deduping and column debounce in `Terminal`.
- Keep the explicit output flush before resize in main.

Update `src/preload/index.ts` only if the typed bridge requires changes beyond the channel union update.

### Phase 6 - Optional Scrollback Controls

Do not lower the default scrollback. If memory pressure remains a real issue after batching and drain tuning, add an explicit setting:

- Default: `250_000`, matching current behavior and `CLAUDE.md`.
- Allow lower values for users who prefer memory savings.
- Apply only to newly created xterm instances unless a safe migration path is designed.
- Explain the tradeoff in settings UI without adding noisy terminal chrome.

This phase is optional and should only happen with evidence that scrollback memory is the dominant issue.

### Phase 7 - Agent Redraw And Resize Stress Pass

Do not port Warp's block-grid in-place clear behavior. xterm should continue to own terminal semantics. Add this as a targeted validation pass because agent panes intentionally run in primary screen with `--no-alt-screen`:

- Resize active Claude and Codex panes repeatedly while they are drawing a frame-style response.
- Confirm old frames do not accumulate as visible output beyond normal terminal behavior.
- Confirm resize does not create a runaway loop of `pty:resize` -> agent redraw -> queued output -> delayed fit.
- If frame redraw artifacts remain after throughput fixes, treat that as a separate agent-terminal behavior issue, not part of generic PTY throughput tuning.

## Risks

- Larger batching windows can increase perceived latency for command output. Keep the timer short and flush on size.
- Ack-based flow control can deadlock if a renderer is destroyed before acking. Main must resume/clean up PTYs on unroute, exit, tab transfer, and window close paths.
- xterm `write` callbacks indicate xterm has accepted the write, not necessarily that the GPU frame has painted. Treat them as backpressure signals, not visual-frame completion.
- Resize changes can cause stale dimensions if dedupe/debounce logic is disturbed.
- Multi-window PTY routing means queued output and in-flight byte accounting must move or clear correctly when PTYs transfer windows.
- Updating `CLAUDE.md` prematurely can mislead future agents. Only update durable instructions after code and verification match.
- xterm already does internal write/parser scheduling. External batching that is too aggressive can improve IPC counts while making input latency or parser backlog worse.
- Main-process string buffers can become a hidden CPU/memory cost if repeated concatenation copies large bursts many times.

## Verification

Manual scenarios:

- Run a high-output command such as `yes` or a large file print, then stop it; the UI should remain responsive and output should not disappear.
- Start a long Codex or Claude response; typing, pane focus, and scrolling should remain responsive.
- Drag-resize panes repeatedly while output is streaming; terminal dimensions should settle correctly.
- Drag-resize panes repeatedly while Claude/Codex is rendering a frame-like UI; prior frames should not visibly stack up or flood scrollback.
- Move a live pane to another window while output is streaming; no duplicate, lost, or orphaned output.
- Close a pane/window while output is paused or in-flight; PTY should not remain permanently paused.
- Confirm OSC 7 CWD updates still arrive promptly at prompts.

Automated checks where practical:

- `npm run typecheck`
- Unit-test pure batching/ack accounting helpers if they are factored out.
- Add a small integration-style test around coalescing flush conditions if the code structure allows it without brittle timers.
- Add focused tests for ack accounting teardown/transfer cases if acks are implemented: ack in order, duplicate/stale ack ignored, destroyed renderer clears or reroutes in-flight state, pause/resume thresholds cannot deadlock.

## Handoff Contract

Non-negotiables:

- Preserve xterm.js and the existing WebGL renderer path.
- Preserve high default scrollback and agent terminal flags/env behavior.
- Do not drop, reorder, or truncate PTY output.
- Keep PTY routing window-aware; only the owning window should receive live output.
- Flush pending output on exit and before resize.
- Reconcile `CLAUDE.md` with the implementation before marking this spec done.
- Keep the durable docs clear that this app remains xterm/Electron-based; Warp research is inspiration for batching, measurement, and validation only.

Definition of done:

- Main batches PTY output by bounded time/size, not only `setImmediate`.
- Renderer/main flow control is either sequence-ack based as documented or `CLAUDE.md` accurately documents the implemented design.
- xterm write chunk size and drain behavior have been benchmarked and set intentionally.
- Resize no longer uses request/response IPC unless a concrete return value is needed.
- Typecheck passes.
- Manual stress scenarios above have been exercised and notes are added here or folded into `CLAUDE.md` before moving/deleting the spec.

## Handoff Decisions

- Prefer implementing sequence-numbered acks. In practice, this means main gives each `pty:data` batch a monotone id, the renderer sends a small receipt after xterm accepts the write, and main uses those receipts to decide when too much output is in flight. This should give better responsiveness than pushing unlimited output into renderer-side queues, and it reconciles the current `CLAUDE.md` claim with code.
- Optimize for best user experience and responsiveness, not maximum raw output throughput. During stress output, typing, pane focus, resize, Ctrl+C, and scrolling should stay usable even if total output completion takes slightly longer.
- Keep xterm `onWriteParsed` instrumentation optional. It is a profiling hook that fires after xterm has parsed written data, at most once per frame. Developers do not need it for the first pass; add it only if basic IPC counts, write callback latency, and queue high-water metrics do not explain stalls.
