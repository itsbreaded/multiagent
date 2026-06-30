# 031 — Split-pane agent TUI state corruption / unexpected “resume conversation” popup

## Status

Implemented and validated on 2026-06-30. Ready to move to `done`.

### Phase 0 evidence (2026-06-30)

An isolated fake-agent E2E now preserves one original agent PTY/PID through 100
alternating horizontal/vertical split-and-close cycles and records preload
receipt, `terminal.write` input, invokes, and sends.

Current repeatable result:

- original pane ID, PTY ID, and OS PID remain stable;
- no `session:resume` is invoked;
- reconstructed framed output received by preload exactly matches framed output
  passed to `terminal.write`; the suspected listener-loss gap did **not**
  reproduce;
- the split shortcut itself does not reach the PTY;
- the original PTY does receive `ESC [ O`, xterm's standard focus-out report,
  when focus moves to the new pane. Focus reports are expected terminal input,
  and the production-shaped Codex capture confirmed it as the expected focus
  transition rather than a selector shortcut.
- every resize sent to the original PTY during stress has positive rows and
  columns; no zero/negative geometry reaches ConPTY.

All 247 Vitest tests and all seven Electron E2E tests pass with the diagnostic
enabled. The trace API is exposed only when `MULTIAGENT_E2E_USER_DATA_DIR` is
set, so production renderers do not expose captured terminal data.

This evidence currently rejects the persistent output router as the best-fit
fix. Do not implement it unless a later real-agent capture localizes loss
between preload and `terminal.write`.

The one-off local production-shaped Codex harness also:

- copies a clean existing rollout and authentication into a disposable home;
- launches `codex resume <id>` through the normal production path;
- waits for substantial transcript replay and an additional settling window;
- performs 200 horizontal splits, alternating the keyboard shortcut and pane
  header menu paths;
- captured both raw target-PTY output and xterm's actual visible buffer after
  every render, so stale resize/reflow content is observable;
- verifies original PID stability and absence of `session:resume` IPC after the
  initial restored launch.

No resume selector was emitted or exposed in the visible buffer during the
200-cycle run. The same run swept window heights from 320 through 1,000 px, so
short-pane resize/reflow states are included.

One independent defect was reproduced and fixed: a direction-button click in
`SpawnChoiceMenu` bubbled through the old `PaneContainer` ancestor after the
split tree rewrite, restoring store focus to the source pane after `splitPane`
selected the new pane. The next structural shortcut could therefore target and
close the wrong (old) PTY. Direction buttons now stop propagation before
mutating the tree, with a component regression test asserting that the new leaf
retains focus. The focus inversion is the only repository defect that
reproduced at the reported interaction boundary, and the fixed build survived
the complete real-agent and geometry matrix without recovery UI.

The initial output-loss theory was rejected by instrumentation. The implemented
fix addresses the reproduced split focus race; no speculative PTY router or CLI
input suppression was added.

## Reported symptom

Splitting a pane can intermittently leave an existing Codex or Claude pane on a
“resume conversation” screen/popup. The state is uncommon and appears related
to the split transition rather than an intentional resume action.

The exact text and whether the popup is a real CLI state transition or a stale,
partially redrawn terminal frame have not yet been captured. That distinction
matters:

- A real CLI transition requires unexpected input, process restart, or a CLI
  bug triggered by resize.
- A visually stale popup can be produced by losing part of an ANSI/TUI redraw
  while the process itself remains in the correct state.

Do not describe this as a confirmed process restart. The current split path
does not intentionally kill or resume the existing agent PTY.

## Confirmed and suspected code behavior

### 1. Splitting structurally remounts the existing terminal

`spawnPaneCore()` replaces the target leaf with a new split node:

```ts
rootNode: replaceNode(tab.rootNode, fallbackLeaf.id, split)
```

`PaneGrid.renderNode()` renders a leaf under a keyed `PaneSplitDropTarget`, but
after the replacement that same leaf is beneath a newly keyed `Allotment`
subtree. React identity is positional as well as keyed; a key cannot preserve a
component when its parent path changes. The existing `PaneContainer` and
`Terminal` therefore unmount and mount during a split.

This is expected by the current terminal code. Its cleanup comment explicitly
notes that terminal unmounts occur when the pane tree changes.

### 2. The xterm instance survives; its PTY output subscription is remounted

`xtermRegistry` correctly keeps the xterm instance and wrapper alive offscreen.
However, the `pty:data` listener is owned by `Terminal` Effect 3:

```ts
unsubData = window.ipc.on('pty:data', ...)
// ... cleanup
unsubData?.()
```

React runs the old effect cleanup before installing the replacement effect. At
the source-code level there is a listener discontinuity in which:

- the PTY is alive;
- its route still points to the renderer window;
- the long-lived xterm still exists;
- no renderer listener is registered to write that PTY's output to xterm.

However, this does **not** by itself prove an event-interleavable gap. React
normally flushes passive-effect unmount cleanup and replacement setup
synchronously in one renderer task; Electron cannot dispatch a callback in the
middle of two synchronous operations on that thread. The replacement terminal
also initializes as `ready` from `xtermRegistry.connected`, so there is no
obvious extra-render delay before setup. An event is dropped only if the
instrumented reproduction demonstrates that Electron/preload dispatch can
occur after unsubscribe and before replacement subscription (or that setup is
deferred through some other path). This is a hypothesis, not a confirmed loss.

### 3. Main-process buffering does not cover this interval

`handlers.ts` buffers direct output only when
`windowManager.sendToWindowForPty()` reports that no window is routable. During
a same-window split the PTY remains routed, so `webContents.send()` succeeds.
The main process cannot tell that the renderer currently has no channel
listener. The existing buffer therefore does not protect component remounts.

This is not a criticism of the route buffer: its contract is cross-window route
availability, not renderer component lifetime.

### 4. A split creates resize/redraw pressure at the vulnerable moment

The replacement `Terminal` attaches the preserved xterm, fits it to the new
geometry, reconnects handlers, and sends a resize. Codex and Claude are
full-screen/differential TUIs; terminal resize commonly causes an immediate
ANSI redraw. Losing any chunk of a differential redraw can leave stale cells,
an uncleared overlay, or an internally inconsistent screen even though the CLI
process did not change mode.

This timing could explain the intermittent nature of the report and why both
agent implementations can exhibit it. It remains only a candidate for a stale
visual popup. Lost ANSI can preserve content that was already drawn, but it
cannot generally invent a resume selector that the CLI never emitted. Phase 0
must establish both transport loss and its relationship to the actual popup.

### 5. Keyboard handling is a separate candidate that must be ruled out

App shortcuts are handled in two places:

- the xterm custom key handler in `Terminal`;
- the global `window` keydown handler in `App`.

The xterm path normally calls `stopPropagation()` and `preventDefault()`, so
there is no demonstrated duplicate dispatch. Nevertheless, splitting mutates
the React tree synchronously from inside the key handler, making this boundary
worth instrumenting. An unexpected `pty:write` is a different root cause from
lost output and requires a different fix.

## Candidate diagnoses

The repository proves a remount and subscription teardown/setup, but not lost
output. The viable candidates, in current priority order, are:

1. unexpected shortcut/input bytes reaching the CLI;
2. an actual PTY exit/restart or incorrect resume invocation;
3. upstream CLI behavior triggered by resize;
4. lost renderer output leaving a stale/partial TUI frame;
5. complete bytes interpreted or rendered incorrectly by xterm.

Before any implementation is selected, capture must show all of the following:

1. The existing pane retains the same `pane.id`, `ptyId`, and OS process PID.
2. No `pty:exit`, `pty:kill`, `session:new`, or `session:resume` occurs for the
   existing pane during the split.
3. No unexpected `pty:write` input is sent to the existing PTY.
4. Whether output sequence markers emitted during the remount contain a gap at
   preload receipt, handler dispatch, `terminal.write`, or the rendered buffer.
5. Whether the CLI's raw output actually contains the resume-screen content.

Follow the decision table below. Do not implement the router unless the
listener-gap row is reproduced reliably and connected to the real symptom.

## Conditional fix: persistent renderer PTY-data router

This section is authorized only if Phase 0 proves loss between preload receipt
and `terminal.write` during remount. Otherwise it is optional architectural
hardening, not the fix for this spec.

### Persistent renderer PTY-data router

Move `pty:data` ownership out of the React `Terminal` lifecycle. Install one
renderer-window listener whose lifetime is the renderer window, and route data
by `ptyId` to a registered long-lived xterm target.

Suggested shape:

```ts
// terminal/ptyDataRouter.ts
type Target = {
  paneId: string
  ptyId: string
  terminal: Pick<XTerm, 'write'>
}

register(target: Target): () => void
replacePty(paneId: string, oldPtyId: string | undefined, nextPtyId: string): void
unregisterPane(paneId: string): void
```

The module installs exactly one `window.ipc.on('pty:data', ...)` listener and
keeps maps by both pane and PTY. Binding is a two-sided reconciliation, because
PTY identity and terminal creation can arrive in either order:

- recording a pane/PTY binding attempts attachment if its terminal exists;
- creating a terminal attempts attachment if its PTY binding exists;
- output routing starts only once both sides exist;
- PTY replacement, exit, pane/tab disposal, layout replacement, and
  cross-window transfer invalidate the old generation.

Centralize this reconciliation in `xtermRegistry` or one dedicated
terminal-session registry. Do not scatter partial router ownership across
store setters and React effects.

Because the xterm instance already survives in `xtermRegistry`, the router can
write to it while its wrapper is in the offscreen holder. No remount buffer is
required and output ordering remains the order delivered by Electron.

### Why this fix is preferred

- If Phase 0 demonstrates an interleavable listener gap, it closes that gap at
  its source.
- It preserves the existing synchronous `terminal.write(data)` contract.
- It does not add acknowledgements, sequence negotiation, pause/resume, or
  backpressure IPC.
- It does not accumulate an unbounded renderer queue during a long unmount.
- It works for split, drag/drop, zoom, hidden tabs, and same-window tree edits.
- It fits the existing design: xterm lifetime is already registry-owned rather
  than component-owned.

### Generation/identity safety

The router must guard against stale events when a pane starts a new agent or
resumes after exit:

- `ptyId` is the routing identity; never route by focused pane.
- Replacing a pane's PTY removes the old `ptyId -> target` entry atomically
  before adding the new one.
- Cleanup returned by an older registration must be generation-safe: it may
  remove only the exact registration it created, not a newer target using the
  same pane ID.
- Late output for an unknown/retired PTY is ignored.
- Explicit pane close disposes xterm only after unregistering the route.
- Registry disposal itself invalidates the output target so every existing
  close-tab/bulk-close/layout cleanup path is covered atomically.

### Keep these lifecycles component-local

Only continuous PTY output requires the persistent router in this change.

- `pty:ready` can remain component-local because `pty:get-ready` replays current
  ready metadata after mount.
- xterm input (`terminal.onData`) and resize (`terminal.onResize`) require a
  mounted interactive terminal and may remain in `Terminal`.
- `pty:exit` is already handled by a module-level store listener.

Separating these avoids turning the router into a second terminal manager.

## Explicitly rejected fixes

### Do not add main/renderer ACK or flow-control IPC

The project intentionally removed ack/seq/pause/resume output flow control for
performance reasons. Reintroducing it is unnecessary: the xterm exists during
the gap and can be written directly through a stable renderer listener.

### Do not merely delay resize

A timeout may make the race less frequent but does not close the listener gap.
Output unrelated to resize can still be lost.

### Do not add a short arbitrary output buffer to `Terminal`

The component cannot buffer events while it has no listener. A global buffer
with a guessed timeout or byte cap adds overflow behavior without need.

### Do not treat `React key={pane.id}` as sufficient

The leaf moves beneath a different parent path when it becomes a split child.
Keys reconcile siblings under the same parent; they do not preserve identity
across arbitrary parent replacement.

### Do not suppress the popup by sending Escape

That can alter a valid CLI state and would conceal the actual corruption.

## Phase 0 — Prove the causal path

First capture the real symptom with a screenshot or video and sanitized raw PTY
input/output. Classify it as exactly one of:

- the CLI emitted bytes that draw a resume screen;
- xterm shows resume-like cells absent from the captured output;
- the app-owned Session Browser opened;
- previously drawn content remained because a later clear/redraw was absent.

Without this classification, a fake transport test cannot prove popup
causality.

Add an E2E-only deterministic fake agent command, following the existing fake
Claude launch mechanism. The fake agent must:

1. Emit monotonically numbered framed records continuously (for example OSC or
   unmistakable text records `FRAME 000001` …) at a configurable short period.
2. Log every input byte it receives without interpreting it.
3. Log SIGWINCH/resize observations and emit a burst of frames after each one.
4. Remain alive until explicitly terminated.

Add temporary/test-only tracing at these boundaries with a shared reproduction
ID, per-record sequence, and monotonic timestamps:

- PTY manager emission;
- main `webContents.send` attempt/result;
- preload's underlying `ipcRenderer` listener receipt;
- renderer router/component handler dispatch;
- `terminal.write` input;
- xterm write-completion/rendered-buffer observation;
- every `pty:write`, `pty:resize`, `pty:exit`, `session:new`, and
  `session:resume` for the original PTY.

Automate at least 100 split/close-new-pane cycles against the original pane.
Closing only the newly created pane is important so the original PTY remains
the subject throughout the run.

Logical frames may be split or coalesced across PTY chunks. The test parser must
reassemble framed records across arbitrary chunk boundaries. A pre-fix
transport reproducer passes only when it localizes missing records to one
adjacent pair of boundaries. The post-fix test separately asserts:

- every logical record reaches the `terminal.write` input stream once, in
  order;
- after xterm's write callback/completion, its buffer matches the deterministic
  ANSI fixture;
- the independently captured real popup reproduction no longer occurs.

If a real Codex/Claude reproduction is available, record raw PTY input/output
around the popup as a supporting manual artifact. Do not put user transcript
content or credentials in logs.

## Decision table after instrumentation

| Observation | Root cause | Required fix |
|---|---|---|
| Same PID, no unexpected input, record reaches preload but not handler/write across remount | Renderer listener gap | Persistent PTY-data router in this spec |
| Unexpected input bytes match or overlap the split shortcut | Shortcut leakage/duplicate handling | Consolidate app shortcut interception before tree mutation; add keydown/keyup/repeat tests |
| Existing PTY exits or is killed | Session lifecycle bug | Trace caller and fix ownership/kill path; router is not the popup fix |
| Complete input/output, same PID, popup begins after resize | Upstream CLI resize behavior | Reduce/normalize redundant resize and file upstream reproduction; do not corrupt app state to mask it |
| Complete byte stream but xterm differs | xterm parser/render issue | Minimize raw ANSI fixture and address renderer/backend behavior |

## Conditional implementation plan

Execute Phase 1 only if Phase 0 selects the renderer-listener-gap row. For any
other row, revise this spec with the evidenced root cause and its narrow fix
before changing production behavior.

### Phase 1 — Extract persistent output ownership

1. Add `src/renderer/src/terminal/ptyDataRouter.ts` with one IPC listener and
   generation-safe registration maps.
2. Reuse `createDirectPtyDataHandler` so validation and synchronous write
   behavior stay in one place.
3. Implement two-sided reconciliation between pane/PTy bindings and terminal
   entries. Either side may arrive first; both creation paths attempt the same
   idempotent bind operation. Do not tie registration to visibility or React
   mounting.
4. Remove only the `pty:data` subscribe/unsubscribe logic from Terminal Effect
   3. Preserve ready metadata, input, resize, DA1, fit, and cleanup behavior.
5. Document the invariant in `CLAUDE.md`: routed PTY output ownership is
   renderer-window/registry scoped, never React mount scoped.

### Phase 2 — Tests

Unit tests for the router:

- routes interleaved chunks to the correct PTY target;
- preserves order and performs exactly one write per received chunk;
- ignores malformed events and unknown PTYs;
- atomically replaces a pane's old PTY route;
- stale cleanup cannot unregister a newer generation;
- unregister on exit/close prevents later writes;
- one IPC listener is installed regardless of terminal count.
- PTY-before-terminal and terminal-before-PTY ordering both bind correctly;
- registry disposal atomically invalidates the target;
- close tab, close tabs right/other, layout replacement, detached-window
  transfer, exit-then-resume, and late output after disposal cannot reach a
  stale xterm.

Renderer/component integration test:

- mount an existing live terminal;
- restructure a leaf into a split, forcing the existing `Terminal` to remount;
- emit output during cleanup/setup boundaries;
- assert all output reaches the same xterm exactly once and no new
  `session:resume` is invoked for the original pane.

Electron E2E test:

- use the Phase 0 fake agent;
- stress repeated horizontal and vertical splits;
- verify original `ptyId` and PID stability;
- verify contiguous output across every split;
- verify no unexpected input and no resume invocation;
- close each new pane and finish with the original process still live.

Shortcut regression test (required and elevated because input is a primary
candidate):

- split shortcut produces exactly one split on one non-repeat keydown;
- the shortcut bytes never reach the PTY;
- keyup does not create a split or reach the PTY;
- held/repeated keydown has explicitly chosen behavior (recommended: ignore
  `KeyboardEvent.repeat` for structural app commands).

## Acceptance criteria

- Phase 0 identifies one row of the decision table with captured evidence.
- The real symptom is classified using screenshot/video plus sanitized raw PTY
  input/output; a fake numbered-frame test alone is insufficient.
- If the listener-gap row is identified, PTY output subscription is no longer
  owned by a remountable `Terminal` effect.
- Original pane `pane.id`, `ptyId`, and PID remain stable across split stress.
- Every reconstructed fake-agent record reaches `terminal.write` exactly once
  and in order; deterministic rendered-buffer assertions pass after write
  completion.
- No split emits shortcut input to the PTY.
- No split invokes `session:resume` for an already live original pane.
- Existing deferred agent spawn sizing, ConPTY metadata/DA1 handling, direct
  synchronous writes, cross-window route buffering, and scrollback survival
  remain intact.
- Unit, renderer integration, Electron E2E, typecheck, and production build are
  green.
- Manual stress with both current Codex and Claude no longer reproduces the
  reported popup. If only the fake-agent loss is fixed but a real CLI popup
  remains, this spec is not complete; return to the decision table.

## Relevant files

- `src/renderer/src/components/PaneGrid/index.tsx`
- `src/renderer/src/components/Terminal/index.tsx`
- `src/renderer/src/utils/xtermRegistry.ts`
- `src/renderer/src/terminal/ptyData.ts`
- `src/renderer/src/store/panes.ts`
- `src/renderer/src/App.tsx`
- `src/preload/index.ts`
- `src/main/ipc/handlers.ts`
- `e2e/startup.spec.ts`
