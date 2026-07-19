# 050 — Terminal-scraping status dots (complementary to hooks)

> **Status:** shipped. A direct extension of the hook-based badges from spec 032. The hook
> system has honest gaps (notably Codex fatal API errors) that no lifecycle hook can report;
> this spec fills them. **Default flipped to ON post-implementation** — the original design
> default was OFF, but shipping default-off left the codex-404-stays-blue bug unfixed out of
> the box, which defeated the feature's purpose; the narrow canonical-signature matcher makes
> the false-positive risk low enough to default on (toggleable off via `agentStatusScraping`).

## Problem

The status dot (`StatusDot`, driven by `eventToState` in `src/shared/agentStatus.ts`) is
sourced **entirely** from managed lifecycle hooks — see spec 032. That is the right default,
but it has gaps the hooks literally cannot close:

- **Codex has no `StopFailure` and no error hook.** `docs/session-linking-hooks.md` states
  this explicitly: *"Codex has no Notification hook and no StopFailure … `error` is
  therefore Claude-only for v1."* When Codex hits a fatal API error it prints the error to
  the terminal and returns to its prompt — it does **not** exit (so the sweeper/demote path
  never fires) and emits no hook. The last event was `user_prompt_submit` → `working`, so
  the dot **stays blue** indefinitely on a dead turn.
- Concrete trigger: `unexpected status 404 Not Found: Unknown error, url:
  https://api.z.ai/api/coding/paas/v4/responses` after `API failed after N retries — …`.
  This is a provider-compat failure (z.ai/GLM has no `/responses` endpoint), so it is fatal
  and repeatable, not transient — exactly the case a red dot should surface.
- Other agents (Claude Code edge cases, opencode) may have analogous hook gaps in the future.

The only available signal for these cases is the agent's **own terminal output**. This spec
adds a narrowly-scoped, **complementary** scraping source — not a replacement, not a
"covers everything" engine.

## Relationship to spec 032 (read this)

Spec 032's handoff contract #1 is the hard line: *"No screen/OSC scraping as a status
source… reintroduce scraping and you've broken the spec."* **This spec amends that line** to
permit exactly one scoped exception: a fatal-terminal-error detector, default on,
Codex-only at launch, feeding the same `eventToState` reducer as a `terminal_error` event.
032's line should be read as amended by 050 — "no scraping" becomes "no scraping except the
scoped `agentStatusScraping` complement in spec 050." When 050 ships, update 032's contract
#1 to reference 050 (and fix 032's stale "Status: pending / design" header — its code is
already in the tree). 050 does not weaken any other 032 guarantee; hooks remain authoritative
for working/waiting/idle.

## Non-goals (read these — they are the point)

- **Not a full-coverage status system.** Scraping is a fallback for signals hooks cannot
  report. Hook events remain authoritative wherever they exist. Do not let scraping
  duplicate working/waiting/idle detection that hooks already own.
- **Not a general screen parser.** v1 detects exactly one thing per agent: a fatal terminal
  error. No permission detection, no "thinking" detection, no tool detection from the
  screen — hooks own all of that.
- **On by default, toggleable off.** Default ON (flipped from the original OFF design — see
  Status). The hooks-only discipline remains the default *behavior source*; scraping only
  fills gaps hooks can't and never overrides them. Users who want strictly hooks-only can
  disable `agentStatusScraping`.
- **No new hook installs, no agent-config mutation.** This is a read-only observer on the
  PTY byte stream. It must not touch `~/.claude.json`, `~/.codex/*`, `.mcp.json`, or any
  managed hook install.

## Current behavior

- One badge write path: hook → main → `pane:agent-event` → `panesIpc.ts` →
  `eventToState(prev, input)` → `setPaneAgentStatus`. (`src/renderer/src/store/panesIpc.ts`,
  `src/shared/agentStatus.ts`.)
- `AgentLifecycleEvent` (in `src/shared/types.ts`) is the only event union; there is no
  terminal-scrape event type.
- Setting `cliSessionLinking` (`src/renderer/src/store/settings.ts`, main-authoritative via
  `settings:get/set-cli-session-linking` in `src/main/ipc/handlers.ts`) gates the managed
  hook install — i.e. it is effectively the gate on **hook-based** status events. There is
  no setting for scraping.

## Intended behavior

### 1. Two independent, composable sources

Status detection has two independent, separately-toggleable sources that **compose at the
reducer**:

| Setting (main-authoritative) | Controls | Default |
|---|---|---|
| `cliSessionLinking` (existing) | managed hook install → hook-based status events | ON |
| `agentStatusScraping` (new) | the terminal-scrape observer | **OFF** |

All four combinations are valid and meaningful:

- **hooks on, scrape off** — today's behavior. The spec-032 default.
- **hooks on, scrape on** — compose. Hooks drive working/waiting/idle; scrape fills the
  error gap hooks can't. This is the expected steady state for users who want it.
- **hooks off, scrape on** — scrape alone. Limited (only fatal-error → red), but works.
  Useful for users who disable managed hooks but still want crash visibility.
- **both off** — no events; dot renders `unknown` (the honest fallback). No change.

### 2. No conflict with hooks — scraping is one more event into the same reducer

Scraping does **not** add a second write path. It produces a new event type that travels the
*same* path hooks use:

```
PTY bytes → main detector → pane:terminal-status IPC → panesIpc.ts → eventToState(prev, input) → setPaneAgentStatus
```

`eventToState` stays the single merge point. Conflict resolution lives entirely in its
per-case precedence rules — there is no coordination logic across two systems.

### 3. The new event + sticky-latch precedence

Add `terminal_error` to the event union (and leave room for a future `terminal_*` family).
In `eventToState`:

```ts
case 'terminal_error':
  return { status: 'error', detail: input.detail ?? 'terminal error',
           turnId: prev?.turnId, event: 'terminal_error', updatedAt: now }
```

The error is a **latch**: once set, `const latched = prev?.event === 'terminal_error'`, and:

- **Keeps error** (ignores dead-turn noise): `pre_tool_use` / `post_tool_use` / `stop` /
  `permission_request` / `promote` → `if (latched) return prev`. The turn is dead; any
  straggler hook from it must not resurrect `working` or flap to `idle`. This is the flap
  you'd otherwise worry about. (For `pre_tool_use`/`post_tool_use`, which already have an
  existing turn-id guard that returns `prev` only when `status === 'idle'`, the latch check
  goes at the **top** of the case and short-circuits before that existing guard runs.)
- **Clears error** (legitimate re-arm): `user_prompt_submit` → `working` (user retried),
  `session_start` → `idle` (fresh/resume/compact), `demote` → `undefined` (process exited).

  **`session_start` is conditional and must be handled explicitly** (this is the one case
  where the existing code preserves `prev`). Today `session_start` is
  `return prev ?? { status: 'idle', … }` — when `prev` exists it returns `prev` unchanged,
  deliberately, so a `SessionStart` fired mid-turn (e.g. Codex fires SessionStart on the
  first user message) does not flip a live working turn to idle. The latch must short-circuit
  that: `if (latched) return { status: 'idle', event: 'session_start', updatedAt: now }`;
  otherwise keep the existing `prev ?? idle` preserve-prev behavior verbatim. Do not change
  the non-latched path.
- `stop_failure` (Claude-only) is its own high-signal error path and is unchanged.

Net: a fatal Codex 404 latches the dot red and holds through any late hook until the user
submits a new prompt, the session restarts, or the process exits. No flapping; no silent
recovery we can't verify.

### 4. Agent-agnostic plumbing, Codex patterns at launch

The detector plumbing is **per-agentKind and pluggable** — not hardcoded to Codex. Today the
registry has one entry (`codex`); future entries (a Claude Code edge case, opencode, etc.)
are additive and touch only the pattern table, not the pipeline. The extensibility surface
is the whole point of building it this way instead of a Codex-special-case.

## The lesson from spec 048 (read before writing any pattern)

Spec 048 built a scraping rule engine and was **rolled back**: loose single-phrase
substring matches over a large scrollback window misread ordinary chat text that *discussed*
the detection rules (e.g. quoting "do you want to proceed?") as a live permission prompt.

This spec avoids that failure by construction:

1. **Match canonical, high-specificity signatures only.** Not keywords. v1 matches exactly:
   - `unexpected status \d{3}\b` (optionally requiring the trailing `, url:`), and
   - `API failed after \d+ retries`.
   These are Codex's own fatal-output formats, consistent across reported versions. Their
   specificity reduces the 048 failure mode to a low residual risk — it is not impossible for
   a match to occur if a user pastes a provider error into a prompt or an echo reaches the
   rolling buffer. That residual is acceptable for a default-on v1 complement; if it bites,
   tighten the specific pattern, never broaden it.
2. **Never scan scrollback.** The detector keeps a small **rolling line buffer** (last
   complete line(s) only) and matches against *fresh* output as it streams. The matched
   region is what just arrived, not the pane's history. This is the architectural fix for
   048's "matched loose substrings over a large scrollback window."
3. **Codex-only gating.** The detector is wired only for panes whose `agentKind === 'codex'`
   (and only when the setting is on). It never runs on shell panes or other agents in v1.
4. **No broad keywords.** Explicitly reject `Error:`, `panic`, `fatal`, etc. as detection
   patterns — they appear in legitimate tool output. If a future agent needs them, that
   agent's entry must justify specificity per pattern.

## Implementation phases

### Phase 1 — Pure detector + registry (no wiring, fully testable)

- `src/main/pty/terminalStatusDetector.ts` — pure, no Electron/IO deps:
  - A `Detector` holding a rolling line buffer (cap ~1–2 KiB, line-aligned; older bytes
    drop off). Accepts `feed(bytes: string)`; returns matched events or null.
  - A pattern registry: `Record<AgentKind, PatternEntry[]>`. `PatternEntry = { regex:
    RegExp, detail: (match) => string, event: 'terminal_error' }`. v1 has one entry under
    `'codex'` with the two signatures above.
  - Deterministic and injectable like `agentStatus.ts` / `paneTree.ts` (the repo pattern
    for pure logic). No `Date.now()`/`Math.random()`.
- `terminalStatusDetector.test.ts` — feed real captured Codex 404 byte streams (multi-chunk,
  spanning writes), assert exactly one `terminal_error` event with a sensible detail; feed
  benign streams (chat, diffs, `/review on my current changes`) and assert no match.

### Phase 2 — Reducer extension + tests

- `src/shared/types.ts`: add `'terminal_error'` to `AgentLifecycleEvent` (and a comment that
  the `terminal_*` family is the scrape source, distinct from hook-sourced events).
- `src/shared/agentStatus.ts`: add the `terminal_error` case and the `latched` guards on
  every preserving case (`pre_tool_use`/`post_tool_use`/`stop`/`permission_request`/`promote`
  → `if (latched) return prev`). For the clearing cases: `user_prompt_submit` and `demote`
  need no special-casing (they already overwrite); `session_start` is the one that needs the
  explicit conditional in Section 3 above (`if (latched) return idle`, else existing
  preserve-prev). Pure change only — no behavior change on the non-latched paths.
- `src/shared/agentStatus.test.ts` (or co-located): precedence tests — terminal_error then
  late `post_tool_use`/`stop`/`permission_request` stays error; `user_prompt_submit` clears
  to working; `session_start` clears to idle; `demote` clears; `stop_failure` still works.

### Phase 3 — Setting (mirror `cliSessionLinking` exactly)

- `src/shared/types.ts`: add `settings:get-terminal-status-scraping` / `settings:set-…`
  IPC signatures and channel strings.
- Main (`src/main/ipc/handlers.ts`): persisted boolean, main-authoritative, default **false**.
  `set` returns the applied boolean. Persist wherever `cliSessionLinking` persists.
- Renderer store (`src/renderer/src/store/settings.ts`): `agentStatusScraping: boolean`,
  setter + hydrater, added to `Persisted` + `loadSettings` (`!== false` → true on unknown,
  so default-on is stable).
- Settings UI: a new toggle under the same section as the CLI Session Linking / Terminal
  toggle. Wording must be honest that this is a **complementary** error detector, not full
  status — e.g. "Detect fatal agent errors from terminal output (complements hook-based
  status; on by default)".

### Phase 4 — Main wiring + IPC

**Where `agentKind` comes from (the spec does not assume PtyManager tracks it — it does
not).** `PtyManager` (`src/main/pty/PtyManager.ts`) tracks only spawn/resize/ready state, not
`agentKind`. The `ptyId → agentKind` association lives in two places:

- **App-spawned agent panes:** `SessionSpawner.spawnNew` / `spawnResume`
  (`src/main/sessions/SessionSpawner.ts:22,39`) receive `agentKind` and return the `ptyId`.
  Populate a main-side `ptyId → agentKind` map here (v1 scope — app-spawned Codex only).
- **CLI-launched agents in shell panes:** promoted at runtime by the sweeper, whose private
  `emitted` map (`src/main/pty/agentProcessSweeper.ts`) holds the transition. Wiring the
  detector on promotion is the follow-up noted in Risks/Non-goals — not v1.

**The detector seam is `ptyOutputRouter`, not PtyManager.** `createPtyOutputRouter`
(`src/main/ipc/ptyOutputRouter.ts:13`) already subscribes to `ptyManager.on('data', (id,
data) => …)` and parses OSC/CWD per pane — this is the single existing per-pane byte
subscriber and the natural place to feed a `Detector`. Implement the detector as a map
`ptyId → Detector` owned alongside the router (or a sibling module it calls into); on each
`data` event, look up the pane's `agentKind`; if it is `codex` **and** the setting is on,
`feed(data)` the pane's detector and forward any emitted event as
`pane:terminal-status(ptyId, event, detail)` via `windowManager.sendToWindowForPty` (parallel
to `pane:agent-event`). Create the detector lazily on first data for a codex pane; drop it on
the router's `releasePty(id)` (already called on exit) so it does not leak.

- Gating is read from main's authoritative copy of the setting — the renderer never decides
  whether to scrape. The detector only runs in main. Toggle live: when the setting flips
  off, stop feeding/forwarding (and clear the detector map); when it flips on, lazily
  re-create on next data.
- `src/shared/types.ts`: add the `pane:terminal-status` channel.
- `src/renderer/src/store/panesIpc.ts`: handler that runs the same
  `eventToState(prev, {event, detail})` → `setPaneAgentStatus`. ~6 lines; symmetric with the
  `pane:agent-event` handler.

### Phase 5 — Docs + guardrail

- `CLAUDE.md` (Terminals & PTY group): one-line rule — terminal-error scraping is the one
  scoped (`agentStatusScraping`, default on, toggleable off) exception to the hooks-only badge; it feeds
  `eventToState` as a `terminal_error` event, latched until next
  `user_prompt_submit`/`session_start`/`demote`; Codex-only at launch, agent-agnostic
  plumbing. Link `→ docs/pty-and-terminals.md`.
- `docs/pty-and-terminals.md` (or `docs/session-linking-hooks.md`): the why — Codex has no
  error hook; the canonical signatures; the 048 lesson (specificity + no-scrollback); the
  compose-at-the-reducer design; the setting matrix.

## Implementation order (sequenced, with verify gates)

1. Phase 1 detector + unit tests. **Gate:** pure tests green against real captured streams.
2. Phase 2 reducer + precedence tests. **Gate:** all `agentStatus` tests green.
3. Phase 3 setting round-trip (main ↔ renderer hydrate). **Gate:** toggling persists across
   reload; default is off.
4. Phase 4 wiring. **Gate:** with setting on, a real Codex 404 turns the dot red and it
   holds; submitting a new prompt clears it; with setting off, no scraping occurs (verify
   no `pane:terminal-status` is emitted).
5. Phase 5 docs.

## Risks

- **False positives (the 048 failure mode).** Mitigated by canonical-signature-only matching
  + rolling fresh-output buffer + Codex-only gating. If a false positive is ever reported,
  the fix is to tighten the specific pattern, never to broaden it.
- **Pattern drift across Codex versions.** Codex's fatal line format is stable today but not
  guaranteed. The registry makes this a one-pattern edit; add a captured-stream regression
  test whenever the format is observed to change.
- **Scope creep into hook-owned states.** Resist adding working/waiting/idle scraping. Hooks
  own those; scraping fills error gaps only. (See Non-goals.)
- **CLI-launched Codex in a shell pane** is promoted by the sweeper, not spawned with a known
  `agentKind` at PTY creation. v1 wires app-spawned Codex panes only; attaching on sweeper
  promotion is a follow-up, called out in Non-goals/phase 4.

## Verification

- Unit: `terminalStatusDetector.test.ts` (match + no-match, multi-chunk), `agentStatus.test.ts`
  (latch + clearing precedence).
- Integration: the `ptyOutputRouter`-owned detector emits `pane:terminal-status` for a Codex
  pane only when the setting is on; silent when off; silent for non-codex panes.
- Typecheck + full `npm run test` green.
- Manual: real app-launched Codex pointed at a provider lacking `/responses` → dot turns red
  after the fatal line, holds through stray output, clears on the next submitted prompt;
  toggle off → dot stays at hook-driven state (blue/unknown) through the same error.

## Handoff contract (non-negotiables)

1. **Scraping feeds the existing reducer as a `terminal_error` event — no second write path.**
   If you find yourself writing a parallel status store, stop.
2. **Default ON, own toggle (`agentStatusScraping`), independent of `cliSessionLinking`.**
   One, both, or none must all work.
3. **Match canonical signatures only, from a rolling fresh-output buffer — never scrollback,
   never keywords.** This is the 048 lesson. Reject any "also match `Error:`" instinct.
4. **Detector is pure and per-agentKind-pluggable.** Codex is the first entry, not a
   special-case woven through the pipeline.
5. **No agent-config mutation, no new managed hooks.** Read-only observer on the PTY stream.
6. **Complementary, not full-coverage.** v1 detects fatal terminal errors only.

## Definition of done

- Setting toggles scraping independently; all four source combinations behave as the matrix
  above.
- A real Codex fatal API error turns the dot red and holds until a new turn/session/exit.
- Pure detector + reducer fully unit-tested; scraping stays off when the setting is off.
- Guardrail + doc updated; no false positives on benign Codex output.
