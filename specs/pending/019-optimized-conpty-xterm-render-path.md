# 019 — Optimized ConPTY + xterm Rendering Path (gated, environment-aware)

## Decisions (resolved before implementation)

These were confirmed with the requester; implement to these, don't re-litigate:

1. **Default renderer = `auto`.** Keep the full detection machinery: WebGL on a
   real hardware GPU, DOM on a software rasterizer.
2. **Single preference, no per-environment override storage.** `localStorage` is
   already per-machine and `auto` adapts per environment; do **not** add a
   per-platform/per-machine override map.
3. **New "Terminal" settings section, and scrollback moves into it.** The existing
   `terminalScrollbackLines` control relocates from "General" to "Terminal". The
   "General" section becomes empty and is **removed** (along with its
   `settings.open.general` command); its search keywords fold into
   `settings.open.terminal`.
4. **Renderer backend applies on next pane mount, not live.** A user changing the
   GPU preference or master flag takes effect on new/reopened panes. The cheap
   xterm options (contrast, glyphs, smooth scroll, rescale) still hot-apply to
   live panes. The **only** live backend change is the involuntary WebGL→DOM
   demotion on context loss (xterm reverts to its built-in DOM renderer when the
   addon is disposed) — no cross-instance live swap is built for user changes.

## Problem

The terminal renderer hardcodes one rendering strategy that is wrong for some
machines. `Terminal/index.tsx` loads `@xterm/addon-webgl` **unconditionally** on
every pane, with only a `try/catch` that falls back to the DOM renderer when the
addon *throws at construction*. It does **not** detect the much more common
failure mode: a machine where WebGL is "available" but backed by a software
rasterizer (SwiftShader / WARP / llvmpipe). On those machines the WebGL addon
loads successfully and then burns 50–60% CPU echoing a single keystroke
(confirmed previously by bisect; see `feedback-webgl-cpu` memory). There is no
way for a user — or the app — to pick a cheaper render path, and no way to turn
the optimization off if it regresses.

We want a **gated, environment-aware rendering path** that:
- picks the fastest *correct* backend per machine automatically,
- lets the user override per environment,
- keeps latency and color/glyph accuracy high for interactive CLI agents
  (Claude Code / Codex), which is the top priority,
- and is structured so new backends (e.g. WebGPU, or `addon-canvas` once it
  ships for xterm v6) drop in cleanly without touching pane code.

## Current behavior

- `src/renderer/src/components/Terminal/index.tsx` (`createXterm`, ~lines 145–180)
  constructs every `XTerm`, then does:
  ```ts
  try {
    const webglAddon = new WebglAddon()
    webglAddon.onContextLoss(() => { try { webglAddon.dispose() } catch {} })
    xterm.loadAddon(webglAddon)
  } catch { /* fall back to xterm's DOM renderer */ }
  ```
  WebGL is always attempted; the only fallback is construction throwing or a
  later context-loss event. Software-rendered WebGL is never detected.
- `xtermRegistry.ts` owns the long-lived xterm instances (survive remounts) and
  already exposes one cross-instance mutator, `setScrollbackLines()`. There is no
  equivalent for renderer backend.
- Settings (`store/settings.ts`) persist a flat `Persisted` object to
  `localStorage` under `multiagent:settings` and re-serialize the whole object on
  every setter. Terminal-related setting today: `terminalScrollbackLines` only.
- `SettingsPanel/index.tsx` sections: `appearance | hotkeys | mcp | providers |
  general`. Each new section needs a matching `settings.open.<section>` command
  in `src/renderer/src/commands/registry.ts` (per CLAUDE.md Command Registry rule).
- ConPTY is already handled correctly: on `pty:ready` with
  `windowsPty.backend === 'conpty'`, `Terminal/index.tsx` sets
  `terminal.options.windowsPty` and registers a DA1 (`CSI c`) handler that replies
  `\x1b[?61;4c`. **This must be preserved.**
- PTY output has **no flow control** by deliberate design (CLAUDE.md "no
  flow-control" note + spec 013). The renderer writes each `pty:data` chunk
  synchronously via `terminal.write(data)`. The previous ack/seq/pause pipeline
  was a CPU regression and was removed. **Do not reintroduce it.**

## Goals

1. A single, declarative place that decides *which* render backend an xterm uses,
   given (a) the user's preference and (b) the detected machine capabilities.
2. Automatic avoidance of software-rendered WebGL (the documented CPU trap).
3. A user-facing **GPU acceleration** control (`auto | on | off`) plus a master
   **feature flag** that reverts to today's behavior if the new path misbehaves.
4. A small set of accuracy/latency-relevant xterm options surfaced in Settings
   with sensible defaults that favor *accuracy and low latency* for CLI agents.
5. Correct apply semantics per Decision #4: the cheap xterm options (contrast,
   glyphs, smooth-scroll, rescale) and scrollback hot-apply to live panes; the
   renderer-backend settings (`terminalGpuAcceleration`, `optimizedTerminalRenderer`)
   take effect on the next pane mount. No app restart required for either.

## Non-goals / Non-negotiables

- **Do NOT reintroduce PTY flow control / ack / seq / pause-resume** in any form.
  Output stays synchronous `terminal.write`. (CLAUDE.md; spec 013; `feedback-webgl-cpu`.)
- **Do NOT rewrite PATH** or otherwise touch `buildEnv` — unrelated and the
  documented cause of the no-scroll output loss.
- **Do NOT add `@xterm/addon-canvas`.** It has no release compatible with
  `@xterm/xterm@6.x` (the canvas backend is left as an extension point only).
- Do not change the PTY worker, isolation model, or the ConPTY DA1 handshake
  except to relocate the *renderer-side* DA1/`windowsPty` wiring if it makes the
  render path cleaner — behavior must be identical.
- No new native deps. `@xterm/addon-webgl@^0.19.0` is already installed.

## Intended behavior

### Backend model

Define a small, data-driven backend registry instead of hardcoding WebGL:

```ts
// src/renderer/src/terminal/rendering/backends.ts
export type RendererBackendId = 'dom' | 'webgl' // 'canvas' | 'webgpu' reserved

export interface RendererBackend {
  id: RendererBackendId
  label: string
  /** Probe + load. Returns a disposable handle, or null if it cannot run here. */
  attach(xterm: XTerm): { dispose(): void } | null
  /** True only if this backend can run given probed capabilities. */
  isViable(caps: RendererCapabilities): boolean
}
```

- `dom`: always viable, `attach` is a no-op (xterm's built-in renderer). This is
  the floor that can never fail.
- `webgl`: viable only when `caps.webgl && !caps.softwareRendering`. `attach`
  constructs `WebglAddon`, wires `onContextLoss` → dispose + permanent demotion
  (see fallback below).

Adding a future backend = appending one entry here. Pane code never imports an
addon directly.

### Capability probe (environment awareness)

```ts
// src/renderer/src/terminal/rendering/capabilities.ts
export interface RendererCapabilities {
  platform: 'win32' | 'darwin' | 'linux'
  webgl: boolean            // a real WebGL2 context can be created
  softwareRendering: boolean // SwiftShader / WARP / llvmpipe / "Software"
  gpuRenderer?: string      // UNMASKED_RENDERER_WEBGL string, for diagnostics
}
```

Probe **once per renderer process**, cached:
1. Main process: new IPC `gpu:feature-status` returns `app.getGPUFeatureStatus()`
   plus `app.commandLine`/`gpu` info. Used to know if Chromium GPU compositing is
   software (`"software_only"` / `"disabled_software"`).
2. Renderer: create a throwaway `<canvas>`, get `webgl2` context, read
   `WEBGL_debug_renderer_info` → `UNMASKED_RENDERER_WEBGL`. Flag
   `softwareRendering` when the string matches
   `/swiftshader|warp|llvmpipe|software|basic render/i` **or** main reports
   software compositing.

This is the mechanism that fixes the documented CPU trap: software-rendered
WebGL is treated as "WebGL not viable" so `auto` resolves to DOM.

**Probe timing — sync vs async (important; resolves the mount-time race).**
`createXterm` is synchronous, so the backend decision must be available without
awaiting. Split the probe by latency:
- The **renderer-side WebGL probe is synchronous** (create canvas → get `webgl2`
  context → read `UNMASKED_RENDERER_WEBGL`). Run it lazily on first access and
  cache the result on a module singleton. This alone is **authoritative** for
  `resolveBackend` — it can decide at the first pane mount with no race.
- The **main `gpu:feature-status` IPC is async** and only *refines*: kick it off
  once at renderer bootstrap (e.g. early in `App.tsx`, before layout restore);
  when it resolves, merge `softwareRendering` (OR it in) and populate the
  diagnostics readout. It must **never** be on the critical path of pane creation.
- `webglDemoted` and the cached capabilities are **per-renderer-process** state
  (each detached window probes and latches independently). Document this so the
  latch isn't mistaken for global app state.

### Resolution (pure, testable)

```ts
// src/renderer/src/terminal/rendering/resolveBackend.ts
export function resolveBackend(
  pref: 'auto' | 'on' | 'off',
  caps: RendererCapabilities,
): RendererBackendId
```
- `off` → `'dom'` (hard).
- `on`  → `'webgl'` if `caps.webgl` (allowed even if software — user opted in),
  else `'dom'`.
- `auto`→ `'webgl'` only if `webgl && !softwareRendering`, else `'dom'`.

Keep this a pure function with unit-style coverage (it is the brain of the
feature and must be trivially verifiable).

### Applying (backend at mount; options hot-apply)

- **Backend is chosen once, at xterm creation.** When `createXterm` runs for a
  pane it calls `resolveBackend(pref, caps)` and attaches that backend; the
  returned disposable handle is stored on `TerminalEntry` for cleanup. There is
  **no** cross-instance live backend swap for user-initiated changes.
- A user changing `terminalGpuAcceleration` or the master flag persists the new
  value; it applies to **new and reopened panes** (next mount). Surface this in
  the UI with a small "applies to new panes" hint so the lack of instant effect
  isn't surprising.
- The four cheap xterm options **do** hot-apply: a registry helper
  (`xtermRegistry.applyTerminalOptions(opts)`, same shape as the existing
  `setScrollbackLines`) writes `minimumContrastRatio` / `customGlyphs` /
  `smoothScrollDuration` / `rescaleOverlappingGlyphs` onto every live
  `xterm.options`.

### Runtime fallback (WebGL → DOM)

Preserve and harden today's behavior: when a WebGL backend reports
`onContextLoss`, dispose the addon — xterm automatically reverts that live pane to
its built-in DOM renderer — and **permanently demote this process to DOM** for the
remainder of the session (a module-level `webglDemoted` flag consulted by
`webgl.isViable`), mirroring VS Code's static `_suggestedRendererType = 'dom'`
latch. This is the only involuntary live backend change, and it prevents a
context-loss/reattach thrash loop across panes.

### Feature flag (kill switch)

`optimizedTerminalRenderer: boolean` (default **true**).
- `true`  → use the backend registry + capability probe + resolution above.
- `false` → legacy path: unconditional `new WebglAddon()` in `try/catch`, exactly
  as today. This is the escape hatch if the new path regresses on some machine;
  flipping it off restores known-good behavior without a downgrade/rebuild.

### ConPTY render path (formalize, don't change behavior)

- Keep `windowsPty` option + DA1 `\x1b[?61;4c` reply exactly as in
  `Terminal/index.tsx` today. If the renderer wiring is refactored into the
  rendering module, the observable handshake must be byte-identical.
- **Investigate (optional, gated):** xterm exposes `reflowCursorLine`; VS Code
  enables it for ConPTY to avoid prompt loss on horizontal reflow. Only adopt it
  if verified against our xterm v6 version and our resize/reflow flow; otherwise
  document that it was evaluated and skipped. Do not block the spec on it.

## Settings (new) — defaults favor accuracy + low latency

New Settings section **"Terminal"** (new `SettingsSection` id `'terminal'`), with
a matching `settings.open.terminal` command in the registry. The existing
`terminalScrollbackLines` control **moves here** from "General"; the now-empty
"General" section and its `settings.open.general` command are removed (its
keywords — scrollback, terminal, history — fold into `settings.open.terminal`).

| Setting (store key) | Control | Default | Apply | Rationale |
|---|---|---|---|---|
| `optimizedTerminalRenderer` | toggle | `true` | next mount | Master feature flag / kill switch. Off = legacy unconditional-WebGL path. |
| `terminalGpuAcceleration` | `auto / on / off` segmented | `auto` | next mount | VS Code's `gpuAcceleration` model. `auto` avoids software-WebGL. |
| `terminalMinimumContrastRatio` | number (1–21) | `1` | live | `1` = **no** color adjustment → preserves exact agent colors (accuracy first). VS Code defaults 4.5; we deliberately default off. |
| `terminalCustomGlyphs` | toggle | `true` | live | Crisp box-drawing/block/braille glyphs used heavily by Codex/Claude TUIs. |
| `terminalSmoothScrolling` | toggle | `false` | live | Off = lowest perceived latency; matches VS Code default. |
| `terminalRescaleOverlappingGlyphs` | toggle | `true` | live | Prevents wide/ambiguous glyphs bleeding into neighbors. |
| `terminalScrollbackLines` | number + presets | `250_000` | live | Unchanged behavior; relocated from General. |

The four "live" xterm options map directly to `xterm.options`
(`minimumContrastRatio`, `customGlyphs`, `smoothScrollDuration` (0 vs ~125ms),
`rescaleOverlappingGlyphs`) and hot-apply via `xtermRegistry.applyTerminalOptions`.
The two "next mount" renderer settings only affect panes created/reopened after
the change — show the "applies to new panes" hint next to them. Verify each option
name exists on the installed `@xterm/xterm@6.x` before wiring; drop any that don't
and note it.

**Diagnostics readout** (read-only, in the Terminal section): show the resolved
active backend and the detected `gpuRenderer` / `softwareRendering` status, so a
user on a weak machine can see *why* DOM was chosen (mirrors VS Code surfacing the
active renderer). Source it from the cached capability probe.

Persisted shape: extend `Persisted` and the `saveSettings` re-serialization with
the **six new keys** (`terminalScrollbackLines` already exists — leave it as-is).
Add `loadSettings` defaults/normalization for each new key (clamp
`terminalMinimumContrastRatio` to [1, 21]; coerce `terminalGpuAcceleration` to the
enum; booleans default per the table). Follow the existing verbose
`saveSettings({...all keys...})` convention in each setter rather than introducing
a new persistence mechanism. Note: every setter currently re-lists all keys, so
each new key touches every existing setter's `saveSettings(...)` call — budget for
that mechanical churn (or refactor to `saveSettings(get())`, optional).

## Implementation phases

**Phase 1 — Rendering module + capability probe (no UI yet).**
- Add `src/renderer/src/terminal/rendering/`:
  - `backends.ts` — the `RendererBackend` descriptors (`dom`, `webgl`) incl. their
    `attach()`/`isViable()` and the module-level `webglDemoted` latch.
  - `capabilities.ts` — synchronous WebGL probe + cached singleton; async merge of
    main's `gpu:feature-status`.
  - `resolveBackend.ts` — the pure decision function.
  - `applyBackend.ts` — thin orchestration called by `createXterm`: `resolve →
    pick descriptor → attach → return handle`. (Keeps pane code free of addon
    imports; if it stays a one-liner, it may be folded into `backends.ts` — note
    which you chose.)
- Add main IPC `gpu:feature-status` (+ type in `src/shared/types.ts`).
- Cache the capability probe at first use (synchronous part); kick the async part
  off at bootstrap.
- **Test infra note:** this repo has **no test runner** (only `npm run typecheck`).
  Do not add one for this. Keep `resolveBackend` pure and validate it with a
  temporary table-driven check during development (off/on/auto × {hw, software,
  no-webgl}); remove it before handoff, or, if a runner is later added, port the
  table into it. The standing gate is `typecheck` + the manual verification steps.

**Phase 2 — Route Terminal through the module behind the flag.**
- Replace the hardcoded WebGL block in `createXterm` with: if
  `optimizedTerminalRenderer` → attach `resolveBackend(pref, caps)` backend; else
  legacy try/catch. Backend is decided once, at creation.
- Store the backend disposable on `TerminalEntry.backendHandle` (for cleanup on
  dispose) and add the permanent WebGL-demotion latch on context loss. No
  cross-instance live backend swap.
- Confirm ConPTY DA1 + `windowsPty` behavior is unchanged.

**Phase 3 — Settings store + persistence.**
- Add the new keys, defaults, normalization, persistence, and setters. Renderer
  keys just persist (read at next mount); the four xterm-option setters call
  `xtermRegistry.applyTerminalOptions` to hot-apply. `terminalScrollbackLines`
  keeps its existing setter/behavior unchanged.

**Phase 4 — Settings UI + command registry.**
- New "Terminal" section in `SettingsPanel` with the renderer controls + the four
  xterm options + the relocated scrollback control + diagnostics readout; wire
  into the `sections` list (with a `count`) and search predicates.
- Remove the now-empty "General" section and its `settings.open.general` command.
- Add `settings.open.terminal` command (+ keywords: gpu, webgl, renderer,
  acceleration, performance, contrast, glyphs, scrolling, scrollback, history).
- Default `settingsInitialSection` fallback stays `'appearance'` (unaffected).

**Phase 5 — Verify & document.**
- Manual verification (below), then fold the durable lesson into CLAUDE.md
  (renderer selection lives in the rendering module; software-WebGL is auto-DOM;
  flow control still forbidden) and update the `feedback-webgl-cpu` memory to note
  the trap is now handled by `auto`.

## Risks

- **Backend applies on next mount, not live** (by decision). The risk is a user
  toggling GPU mode and seeing no change on open panes — mitigate with the
  "applies to new panes" UI hint. The only live backend change is the
  context-loss demotion, where xterm reverts to DOM automatically on addon
  dispose; verify that path doesn't clear scrollback.
- **`app.getGPUFeatureStatus()` quirks**: values differ across Electron versions
  and OSes. Treat the renderer-side `UNMASKED_RENDERER_WEBGL` string as the
  primary signal and main's status as corroborating; never hard-fail on it.
- **Forcing `on` on a software machine** reintroduces the CPU spike *by user
  choice* — acceptable, but the diagnostics readout should make the software
  state visible so it isn't a silent footgun.
- **xterm v6 option drift**: a setting may map to a non-existent option. Verify
  names at implementation time; omit + note any that don't exist.
- **Detached windows**: settings/store are per-renderer. Ensure the capability
  probe and backend application run in detached windows too (they construct their
  own xterms). The flag/preference is read from the same persisted settings.

## Verification steps

1. `npm run typecheck` clean; `npm run dev` launches.
2. On the dev machine, open Settings → Terminal: diagnostics shows the real GPU
   renderer string and resolved backend. With a hardware GPU, `auto` resolves to
   `webgl`.
3. Force software rendering to prove the trap is closed: launch with
   `--disable-gpu` (or set `app.disableHardwareAcceleration()` temporarily) →
   `auto` must resolve to `dom`. Measure CPU the same way the original regression
   was found: hold a key (or run a steady echo) and watch the renderer process in
   Task Manager / `electron` process row — DOM should stay low single-digit %
   where software-WebGL spiked to ~50–60%. Then set `on`, open a **new** pane →
   it attaches WebGL (and spikes under software rendering) — proving the override
   works and the diagnostics warn about software rendering.
4. Toggle the master flag off, open a new pane → legacy path (WebGL attempted
   unconditionally). Toggle on, open a new pane → environment-aware path. (Renderer
   changes are expected to require a new/reopened pane, not restart the app.)
5. Change `minimumContrastRatio`, `customGlyphs`, `smoothScrolling`,
   `rescaleOverlappingGlyphs`, and `terminalScrollbackLines` → effects apply live
   to an already-open pane.
6. ConPTY unchanged: a fresh PowerShell pane and a Claude/Codex pane both start,
   accept input, and render TUI box-drawing correctly. `git pull` short output is
   not dropped (regression guard for the no-scroll race).
7. Detached window: move a pane out; renderer selection + settings apply there too.

## Handoff contract

**Definition of done**
- Renderer backend is chosen by `resolveBackend(pref, caps)` in the new rendering
  module; no addon is imported directly by pane components.
- `auto` never attaches WebGL on a software-rendered context; `off` is always DOM;
  `on` attaches WebGL when any WebGL2 context exists.
- Master feature flag cleanly reverts to the legacy unconditional-WebGL path.
- All Terminal settings persist and survive reload; the four xterm options +
  scrollback hot-apply to live panes, and the renderer settings take effect on the
  next pane mount; diagnostics readout reflects the real machine.
- ConPTY DA1 + `windowsPty` handshake is byte-identical to today.
- `npm run typecheck` passes; all verification steps pass.

**Non-negotiables**
- No PTY flow control / ack / seq / pause-resume, ever.
- No PATH rewrite / `buildEnv` change.
- No `@xterm/addon-canvas` dependency.
- DOM renderer remains the always-viable floor; nothing may make a pane unable to
  render at all if WebGL is unavailable.

## References (researched)

- **VS Code** (`C:\Users\cdhan\Desktop\vscode`):
  - `terminal.integrated.gpuAcceleration` = `auto|on|off`, default `auto`
    (`.../terminal/common/terminalConfiguration.ts`); renderer choice +
    `_shouldLoadWebgl()` and WebGL `onContextLoss` → dispose + static
    `_suggestedRendererType = 'dom'` latch
    (`.../terminal/browser/xterm/xtermTerminal.ts`).
  - ConPTY DA1 (`CSI c` → `\x1b[?61;4c`) handler and `windowsPty` option set after
    process ready; `reflowCursorLine` for ConPTY
    (`.../terminal/browser/terminalInstance.ts`).
  - Flow control via `FlowControlConstants` (Hi/Lo watermarks, char-count ack) at
    the pty-host layer — **intentionally not adopted here.**
  - Relevant settings reused: `minimumContrastRatio` (4.5 in VS Code; we default
    1 for accuracy), `customGlyphs`, `smoothScrolling`, `rescaleOverlappingGlyphs`.
- **Warp** (`C:\Users\cdhan\Desktop\warp`, AGPL/MIT, Rust/wGPU+Metal — verified
  real source, remote `github.com/warpdotdev/warp`). Warp is a GPU-native renderer
  so its techniques are **non-portable to xterm.js**; they inform *philosophy*, not
  mechanism:
  - Latency-over-cosmetics: `crates/warpui/src/rendering/wgpu/resources.rs:848`
    sets `PresentMode::AutoNoVsync` and explicitly accepts tearing "to improve
    responsiveness." We can't set the present mode (Chromium owns the swapchain),
    but it backs our low-latency defaults (smooth-scroll off, no flow control).
  - Glyph atlas caching (`crates/warpui/src/rendering/glyph_cache.rs`,
    `rendering/atlas/{allocator,manager}.rs`, `app/src/terminal/grid_renderer/cell_glyph_cache.rs`)
    — not adopted; xterm's WebGL addon already maintains its own glyph atlas.
  - Software-driver avoidance in adapter selection (`rendering/wgpu/resources.rs`)
    corroborates this spec's core move: detect software rendering and don't pay for
    a GPU path that isn't really GPU-backed (the `auto` → DOM resolution).
- **This repo**: `Terminal/index.tsx` (current unconditional WebGL + ConPTY DA1),
  `utils/xtermRegistry.ts` (cross-instance mutation pattern), `store/settings.ts`
  (persistence convention), `commands/registry.ts` (section command rule),
  `feedback-webgl-cpu` memory (the CPU trap this closes).
```
