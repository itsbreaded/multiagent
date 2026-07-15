# 046 — herdr detection findings: improvements for CLI integration, session detection, and live status

> **Status:** findings / backlog. This is a research spec, not an implementation plan.
> It ranks techniques observed in the `herdr` repo (`C:\Users\cdhan\Desktop\herdr`, a
> Rust terminal agent multiplexer — a conceptual counterpart to this Electron app) that
> could improve MultiAgent's CLI tool integration, session detection, and live agent
> status, ranked by impact. Each finding points at herdr code (for reference) and where
> it would land in MultiAgent. **Do not vendor any herdr code or rule files — adapt the
> technique in MultiAgent's own words.**
>
> herdr is AGPL-3.0. We read it only for technique; no source or rule text is copied.

## Correction to the record (read this first)

Everything below was originally written as **deltas on top of an assumed-already-shipped
status-detection engine** ("spec 045"). That engine did not exist when this was written,
and although a real implementation was later built under spec 048 (a priority-gated rule
engine, screen-region extractors, OSC capture, hysteresis, an `agentStatus` store slice,
and a status dot in `PaneHeader`/the sidebar's `PaneRow`), **spec 048 has since been rolled
back** — its spec file deleted, its code reverted. There is currently **no status-detection
code anywhere in this tree**, and no "Agents dock" ever existed (that name refers to a
component that was never built by any spec).

Two consequences for anyone picking this document up:

1. **Every "ours: `src/renderer/src/terminal/status/...`" citation below is currently
   false.** None of those files exist. Treat this entire document as a pre-implementation
   research note, not a description of current MultiAgent state — the "Context: where we
   already match herdr" section immediately below is entirely aspirational, not fact.
2. **Why 048 was rolled back is directly relevant to how any future attempt at this
   should be scoped.** Spec 048's rule sets were largely educated guesses at Claude/Codex
   CLI output, not verified against real captured screens. In practice this produced a
   concrete false positive: normal chat text that merely *discussed* the detection rules
   (quoting phrases like "do you want to proceed?") got misread as a live permission
   prompt, because the rules matched loose single-phrase substrings over a large
   scrollback window rather than herdr's actual compound, narrowly-scoped conditions.
   Tightening the rules to require multiple simultaneous signals (the question phrase +
   "esc to cancel" + a numbered-option line, scoped to the box interior, not the whole
   scrollback) fixed that specific case, but the underlying issue — rules never verified
   against a real capture — was never resolved before the feature was rolled back
   entirely. **Any future attempt at this should prioritize getting real captured screens
   from actual Claude/Codex sessions before writing rule content**, and finding #3 below
   (a `status:explain`-style debug view) is the highest-leverage prerequisite for doing
   that tuning safely, not an optional nice-to-have.

The findings below are still useful as a **ranked backlog of herdr techniques worth
adapting**, independent of whether a status engine exists yet — read them as "if/when a
status-detection feature is (re)built, here is what else herdr does that's worth
adopting," not as deltas on existing code.

---

## Findings ranked by impact

### 1. (HIGH) "Needs attention" toast + sound when a background pane becomes blocked

**The gap.** Spec 045's core motivation (its Problem statement) is: *"it is easy to miss
a permission prompt sitting in a background pane for minutes."* The spec surfaces this via
the Agents dock attention badge and `agents.focus-needing-input`, but only when you look at
the sidebar. There is **no proactive, app-level notification** when a non-focused pane
transitions to `input-required`, and no audio cue. herdr has both.

**What herdr does.** When a pane transitions to `Blocked` (especially in a background
workspace), herdr fires a `ToastNotification { kind: NeedsAttention, title: "<agent>
needs attention", context: "background · <n>" }` and plays `Sound::Request`.
- `src/app/actions.rs:143` / `:167` — `AgentState::Blocked => Some(ToastKind::NeedsAttention)`.
- `src/app/actions.rs:196` — title text `"needs attention"`.
- `src/app/actions.rs:207` — `NeedsAttention => Some(Sound::Request)`.
- Tests at `src/app/actions.rs:4620` (`visible_blocker_overrides_hook_working_and_notifies`)
  and `:4453` characterize the toast.

**Why high impact.** It is the single most direct response to spec 045's stated problem,
and it pays off even when the user is not looking at the sidebar (different window,
different tab, monitor away). Badge + palette command are pull; toast + sound are push.

**Where it lands here.**
- A general toast/notification surface — we currently have only `UpdateBanner`
  (`src/renderer/src/components/UpdateBanner.tsx`) and `window.prompt` dialogs; there is no
  reusable toast. Either build a small toast host (reuse the modal language in
  `src/renderer/src/styles/theme.ts` and CLAUDE.md's overlay tokens: `#1a1b1e` panel,
  `#2a2b2e` borders, 10px radius) or extend `UpdateBanner`'s slim-banner pattern.
- Drive it from the `agentStatus` store slice (spec 045 Phase 4): on a transition to
  `input-required` for a pane that is **not the focused pane in the active tab**, emit a
  toast keyed by `paneId` (debounced so repeated prompts don't spam).
- Optional sound: a bundled asset under `src/renderer/src/assets/`, gated by a setting
  (default off — audio is intrusive). Keep it advisory: clicking the toast runs
  `focusPaneInTab(tabId, paneId)` (atomic, hydrates inactive tabs — spec 045 invariant).
- Cross-window note: a detached window's blocked agent should toast in **its own** window
  (spec 045 v1 is local-only per window); primary can't see detached status.

**Effort:** low–medium. **Risk:** low (advisory, debounced, setting-gated).

---

### 2. (HIGH) Over-the-air detection-rule updates with version gating

**The gap.** Our rules ship as static JSON bundled at build time
(`src/renderer/src/terminal/status/rules/{claude,codex}.json`). Spec 045's #1 risk is
explicit: *"Markers are version-dependent and will misfire (fullscreen TUI, locale, new
CLI versions)."* Today, when Claude Code or Codex changes a prompt string (e.g. rewording
"do you want to proceed?" or the OSC title spinner), detection silently degrades until we
cut a new app release. herdr decouples rule fixes from app releases.

**What herdr does.** A manifest catalog at `https://herdr.dev/agent-detection/index.toml`
lists per-agent manifest versions. herdr fetches it (env-overridable URL, 256 KiB cap),
caches locally, and applies updates gated by:
- `version` — dotted-numeric, comparable (`ManifestVersion` in
  `src/detect/manifest_update.rs`).
- `min_engine_version` — the rule file declares the minimum engine it needs; the binary
  refuses manifests that require a newer engine than it has (forward compatibility).
- Local override shadowing remote — a local file wins over the cached remote, for
  user/dev fixes.
- A toast on update (`AppEvent::AgentDetectionManifestsUpdated` → `"Agent detection rules
  updated"`, `src/app/actions.rs:2553`).

**Why high impact.** Detection accuracy has a half-life tied to upstream CLI churn. OTA
rules let us ship a rule fix for a new Claude/Codex build the same day without an app
release. This is the difference between detection being a durable feature and a thing that
quietly rots between releases.

**How to adapt for MultiAgent (do not copy herdr's catalog).**
- Reuse **existing** auto-update infra rather than inventing a new channel: we already
  check `github.com/itsbreaded/multiagent` releases via `electron-updater`
  (`src/main/updater.ts`, `publish.bat`, CLAUDE.md "Auto-Update" — public repo, no token).
  Publish rule-pack JSON as release assets (e.g. `status-rules-claude.json`,
  `status-rules-codex.json`) tagged with a `status-rules` category; main fetches the latest
  release assets on startup + hourly (mirror the updater cadence).
- Extend `RuleSet` (`src/renderer/src/terminal/status/engine.ts`) with `version` and
  `minEngineVersion` fields; reject/ignore rule packs whose `minEngineVersion` exceeds the
  bundled engine version. Keep the bundled JSON as the always-present fallback so a failed
  fetch never leaves us with no rules.
- Cache fetched packs under `userData` (beside `layout.json`); load order: cached remote →
  bundled fallback. A local override path (for dev/power users) can shadow both, like
  herdr's `Override` source.
- Gate behind a Settings → Terminal toggle ("Auto-update agent status rules", default on)
  so users who want frozen rules can opt out. Surface last-updated time + version in
  Settings diagnostics.
- **Trust/safety:** fetch over HTTPS from our own GitHub releases (not an arbitrary URL),
  validate JSON shape against the `RuleSet` schema before applying, cap fetch size, and
  never `eval`/load code — rules are pure data consumed by the existing engine. A
  malformed pack must fall back to bundled, never crash.

**Where it lands here.**
- `src/renderer/src/terminal/status/engine.ts` — add `version`/`minEngineVersion` to
  `RuleSet`; add a loader that prefers cached-remote over bundled.
- New main-process module (e.g. `src/main/status/rulePackUpdater.ts`) that fetches release
  assets, validates, writes to `userData`, and broadcasts `status:rules-updated` to the
  renderer (new IPC in `src/shared/types.ts`).
- Settings UI section (registry `settings.open.<section>` per CLAUDE.md command-registry
  rules) + diagnostics.
- Tests: version comparison, `minEngineVersion` rejection, schema-validation fallback to
  bundled, fetch-failure fallback.

**Effort:** medium. **Risk:** medium (network, trust, cache invalidation) — mitigated by
pure-data rules, HTTPS-from-our-own-releases, schema validation, bundled fallback, opt-out.

---

### 3. (MEDIUM-HIGH) `status:explain` debug path + dev diagnostics overlay

**The gap.** Our engine is pure and testable, but when a rule misfires in the real app
there is no way to see **why** — which rule fired, which gate/matcher matched, what the
extracted region text was, what the fallback was. Tuning rules is blind without this.
herdr has a rich explain path.

**What herdr does.** `DetectionExplain` (`src/detect/manifest.rs`) carries: matched rule
id + priority + region, the full `evaluated_rules` vector with per-rule `RuleEvidence`
(which `contains`/`regex`/`line_regex` were present, `all`/`any`/`not` counts, a region
byte preview), `fallback_reason`, `screen_detection_skipped`, and manifest version. It's
exposed via `herdr agent read <pane> --source detection` and `explain_for_label(...)` —
the AGENTS.md "Screen detection is evidence-based" workflow literally tells maintainers to
capture the bottom-buffer state and inspect it before editing a manifest.

**Why medium-high impact.** This is the maintainability lever for the whole detection
feature. Rules are tunable data; without an explain path, every misfire becomes a
print-statement archaeology session. It also makes OTA rule packs (#2) verifiable: "the new
pack matched rule X on this screen." Spec 045's risk section anticipates misfires; this is
the tool for living with them.

**How to adapt.**
- Extend `evaluate` (`src/renderer/src/terminal/status/engine.ts`) to optionally return an
  explanation: the fired rule (id/state/priority), each evaluated rule's gate result, the
  extracted region strings (already available from `regions.ts`), and the fallback used.
  Keep it opt-in (a `explain?: boolean` arg) so the hot 300 ms tick pays nothing.
- Add a `status:explain` invoke (main-relayed or pure-renderer) that returns the trace for
  a given pane id; surface it in:
  - A dev/diagnostics overlay (reuse the modal language), or
  - A Settings → Terminal diagnostics panel: pick a pane, see current regions + fired rule
    + OSC title/progress, live.
- Pin `process.platform` in any tests that branch on platform (CLAUDE.md determinism).

**Where it lands here.**
- `src/renderer/src/terminal/status/engine.ts` (explain result type + opt-in).
- `src/renderer/src/terminal/status/index.ts` (wire explain through `detectFromRegions`).
- New diagnostics UI under `src/renderer/src/components/` (overlay) or a Settings subpanel
  (`src/renderer/src/commands/registry.ts` entry per CLAUDE.md).

**Effort:** low–medium. **Risk:** low (opt-in, off the hot path).

---

### 4. (MEDIUM) Transcript-viewer / scroll-mode `skip_state_update`

**The gap.** Spec 045 handles fullscreen/alt-screen TUI → `unknown` (via `altScreen` in
`detectFromRegions`, `src/renderer/src/terminal/status/index.ts`). It does **not** handle
the in-app viewer modes that look like live chrome but aren't: Claude's transcript viewer
(Ctrl+O) and Codex's scroll/edit-history mode. In those modes the bottom-of-buffer text
contains prompt-like and "esc to ..." strings that can falsely match `input-required` or
`idle` rules.

**What herdr does.** Both `claude.toml` and `codex.toml` have a `transcript_viewer` rule
with `state = "unknown"` and `skip_state_update = true` (Claude: priority 1000, matches
`"showing detailed transcript"` + toggle hints; Codex: priority 1000, matches `↑/↓ to
scroll`/`q to quit` etc., region `after_last_prompt_marker`). The engine treats
`skip_state_update` as "this screen is an agent-owned viewer; do not update live state from
it" (`AgentDetection.skip_state_update`, `src/detect/mod.rs`; `should_skip_state_update`).

**Why medium impact.** Without it, opening the transcript viewer in a background Claude
pane can flip its dot to a false `input-required`/`idle` and (with finding #1) fire a
spurious needs-attention toast. That erodes trust in the toast.

**How to adapt.**
- Add a `skip: true` flag to `Rule` (`src/renderer/src/terminal/status/engine.ts`); when a
  `skip` rule is the highest-priority match, `detectFromRegions` returns `unknown` and
  **does not advance hysteresis** (treat like alt-screen: keep previous state, don't
  flap). Add `transcript_viewer`-style rules to `claude.json`/`codex.json` using
  MultiAgent-observed strings (do not copy herdr's strings verbatim).
- Reuse the `altScreen` short-circuit path in `index.ts` as the model.

**Effort:** low. **Risk:** low.

---

### 5. (MEDIUM) Codex-specific prompt/block markers for `after_last_prompt_marker`

**The gap.** Our `PROMPT_MARKER` regex (`src/renderer/src/terminal/status/regions.ts`) is
generic: `^\s*(?:❯|>|▶|»|\$|#)\s?`. It does not include Codex's actual prompt glyph `›`
nor Codex's block markers (`•■✗✓`). So for Codex panes, `after_last_prompt_marker` and
`prompt_box_body` extraction are less accurate than herdr's, weakening the input-required
rules that key off them.

**What herdr does.** `codex_prompt_line` = `line == "›" || line.starts_with("› ")`;
`codex_block_marker_line` = starts with `•`/`■`/`✗`/`✓`
(`src/detect/manifest.rs`). It also has
`whole_recent_without_current_prompt_marker` and `before_current_prompt_marker` to avoid
matching the user's **in-progress input** (the line they're currently typing) as agent
output — a real false-positive source.

**How to adapt.**
- Add `›` to `PROMPT_MARKER` in `regions.ts`; add a Codex block-marker helper used by
  `after_last_prompt_marker` to stop at the last `•/■/✗/✓`-prefixed line.
- Consider a `whole_recent_without_current_prompt_marker`-equivalent: when the very last
  non-empty line is a prompt line with no block marker after it, treat it as in-progress
  input and exclude it from the matched region. This prevents a half-typed user prompt
  from matching idle/working rules.

**Effort:** low. **Risk:** low (region-accuracy only; characterize with tests).

**Where it lands here:** `src/renderer/src/terminal/status/regions.ts` + `regions.test.ts`.

---

### 6. (LOW–MEDIUM) Rule-file schema: `version`, `minEngineVersion`, `aliases`

**The gap.** Our `RuleSet` (`engine.ts`) has `agentKind`/`fallback`/`rules` only. herdr
manifests carry `id`, `version`, `min_engine_version`, `updated_at`, `aliases`
(`src/detect/manifest.rs` `AgentManifest`). Without `version`/`minEngineVersion` we can't
do OTA updates (finding #2) safely.

**How to adapt.** Add `version?: string` (dotted-numeric) and `minEngineVersion?: number`
to `RuleSet`, plus a constant `STATUS_ENGINE_VERSION` in `engine.ts`. Bundled JSON
declares its version; the loader compares. `aliases` is only useful if we grow beyond
Claude/Codex (finding 9) — skip for now.

**Effort:** trivial. **Risk:** none. Enables #2.

---

### 7. (LOW) Use OSC 9 progress (`4;0`) as an idle signal

**The gap.** We capture `osc_progress` (OSC 9) in `osc.ts` and expose it as a region, but
neither `claude.json` nor `codex.json` keys `idle` off it. herdr's `claude.toml`
`osc_progress_idle` rule matches `^4;0` for idle (priority 250).

**How to adapt.** Add an `osc_progress` idle rule to `claude.json` matching the idle
progress payload (observe the actual OSC 9 bytes Claude emits — don't assume `4;0`). Keep
priority low so a visible blocker/working rule overrides it.

**Effort:** trivial. **Risk:** low. (Minor gain; our osc_title rules already cover most
cases. Include only if observed OSC 9 traffic warrants it.)

---

## Considered and not adopted (documented for future agents)

These are real herdr features that conflict with MultiAgent non-negotiables or
architecture. Recorded so future agents don't re-investigate them.

### A. Hook-based session capture via agent config mutation — **rejected (policy)**
herdr installs a **managed, versioned** hook into Claude's settings
(`src/integration/config_edit.rs` — `ensure_command_hook`, idempotent, preserves unrelated
hooks) that runs `herdr-agent-state.sh/.ps1` (`src/integration/assets/claude/`) on
`SessionStart`. The hook reads the Claude hook payload and reports `session_id` +
`transcript_path` back over a Unix socket (`pane.report_agent_session`,
`src/api/schema.rs:166`). This captures the session id **reliably including on resume/fork**
— the exact gap our Codex cwd/time polling struggles with (CLAUDE.md "Session Detection").
For Claude specifically herdr's hook is session-capture only (not live state).

**Why we don't adopt it.** It requires writing into `~/.claude.json` / `~/.codex` config —
a direct violation of CLAUDE.md's non-negotiable *"The app must not mutate user or project
agent config files."* It also depends on a host runtime (`python3` on Unix; shells
`herdr` CLI on Windows) — a non-starter for our per-user Windows installer with no
prerequisites (spec 045 non-negotiable). Our `--session-id` launch path already covers the
common Claude case; the remaining gap is Codex resume/fork detection.

**If we ever revisit:** it would need to be an explicit, user-consented, off-by-default
"enhanced session detection" setting that installs managed hooks with begin/end markers
(herdr's `# >>> herdr ... integration` / `# <<<` block pattern, `KIMI_CONFIG_BLOCK_*` in
`src/integration/mod.rs`) and a clean uninstall — a policy change requiring user sign-off,
not a silent behavior. The Codex cwd/time-constrained scanner path (CLAUDE.md) must remain
the default. Reference: our `src/main/pty/SessionSpawner.ts` (detection),
`src/main/sessions/` (indexing).

### B. Foreground-process-group agent identification — **rejected (platform)**
herdr identifies the running agent from the pane's foreground process group
(`identify_agent_in_job`, `src/detect/mod.rs`), so an agent launched **manually inside a
shell pane** (user types `claude`) is detected and status-tracked. We set `agentKind` only
at spawn (`SessionSpawner`), so a manually-launched agent in a shell pane gets no status.
herdr's own Windows path is a no-op fallback (`src/platform/fallback.rs:
foreground_job → None`). We are Windows-first, where foreground-process-group inspection is
hard/unreliable. **Low impact, high effort for us.** Document as a known gap; revisit only
if we add a reliable Windows process-tree inspection primitive.

### C. Multi-source arbitration (hook authority + screen + PTY activity) — **partially relevant**
herdr arbitrates between agent self-reported state (`HookStateReported`), screen detection
(`StateChanged` with `visible_blocker`/`visible_working`), and PTY activity, with
suppression windows to avoid flap (`src/terminal/state.rs
set_detected_state_with_screen_signals_at`; `src/app/actions.rs:2575`). Key principle
worth keeping: **a screen `visible_blocker` overrides a non-blocked authority and
notifies** (`visible_blocker_overrides_hook_working_and_notifies` test). Since we
deliberately don't use hooks (finding A), our single-source screen+OSC model is correct;
our priority system already encodes "input-required wins over working/idle." The
takeaway for us is the **suppression-window discipline** to avoid flap on rapid
working↔idle transitions — already addressed by our hysteresis
(`src/renderer/src/terminal/status/hysteresis.ts`). No action beyond keeping hysteresis
tuned.

### D. Server-owned runtime / detach-keep-running / socket API for agents — **out of scope**
herdr is a Rust daemon: agents keep running in the server while the TUI detaches; reattach
from any terminal or over SSH (`src/persist/restore.rs`, `src/server`, `src/api`); agents
can drive herdr via a socket API ("agents spawn panes, read output, wait on each other").
MultiAgent is an Electron app that kills PTYs on close and resumes from transcripts
(CLAUDE.md "Session Detection" / startup resume). This is a fundamentally different
architecture, not an incremental improvement. **Out of scope.** Worth noting only as the
conceptual poles: herdr optimizes for "walk away, agents survive disconnect"; we optimize
for "come back to where you left off in a desktop window."

---

## Reference index

**herdr (read-only reference, do not copy):**
- Detection engine + regions + gates: `src/detect/manifest.rs`
- Rule files: `src/detect/manifests/{claude,codex}.toml` (and 17 others)
- OTA manifest catalog + versioning: `src/detect/manifest_update.rs`
- State model + source signals: `src/detect/mod.rs` (`AgentDetection`, `skip_state_update`)
- Arbitration + needs-attention toast/sound: `src/app/actions.rs` (~143–207, 2575–2620)
- Terminal-state arbitration method: `src/terminal/state.rs`
  (`set_detected_state_with_screen_signals_at`)
- Hook install + managed config edits: `src/integration/{mod.rs,config_edit.rs}`,
  `src/integration/assets/{claude,codex}/`
- Session report socket API: `src/api/schema.rs:166`, `src/api/server.rs:369`
- Persist/restore (detach model): `src/persist/{restore.rs,snapshot.rs}`

**MultiAgent (where findings would land, if/when a status engine is (re)built):**
- Status engine + rules + OSC + regions + hysteresis: no current home; would live under
  `src/renderer/src/terminal/status/` (that directory does not currently exist).
- Sidebar surface: there is no "Agents dock" — the only per-pane sidebar surface is
  `PaneRow` inside `src/renderer/src/components/Sidebar/TabSections.tsx`.
- Store slice (agentStatus): would live in `src/renderer/src/store/panes.ts`; no such
  slice currently exists there.
- Status dot: would render in `src/renderer/src/components/PaneHeader/index.tsx`; no
  status-dot code currently exists there.
- Toast/banner precedent: `src/renderer/src/components/UpdateBanner.tsx`
- Auto-update infra to reuse for OTA rules: `src/main/updater.ts`,
  `publish.bat`; updater IPC in main; CLAUDE.md "Auto-Update (GitHub Releases)"
- Command registry (new commands/sections): `src/renderer/src/commands/registry.ts`
- IPC contract source of truth: `src/shared/types.ts`
- Session detection (for finding A context): `src/main/pty/SessionSpawner.ts`,
  `src/main/sessions/`
- Layout persistence pattern: `src/main/ipc/layoutStore.ts`, `applyLayout` in `panes.ts`

## Suggested ordering

1. Finding #6 (schema version/minEngineVersion) — trivial prerequisite for #2.
2. Finding #1 (needs-attention toast + sound) — highest user-visible payoff, independent.
3. Finding #3 (`status:explain` diagnostics) — makes every subsequent rule edit safe.
4. Finding #4 (transcript-viewer skip) + #5 (Codex markers) + #7 (OSC 9 idle) — accuracy
   pass; do together once explain (#3) exists to verify them.
5. Finding #2 (OTA rule packs) — largest effort/risk; do last, after the schema (#6) and
   diagnostics (#3) are in place to validate packs.