# 046 — herdr detection findings: improvements for CLI integration, session detection, and live status

> **Status:** closed — not pursuing. **Closed:** 2026-07-26.
>
> **Disposition:** Reviewed as a research backlog on 2026-07-26 against the shipped 032 /
> 050 / 047 / 052 architecture. **No items warrant implementation; this is not a work list.**
> - Findings **#4 / #5 / #7** are MOOT under the shipped scoped status detector (spec 050) —
>   the screen-region rule engine they assumed (spec 048) was rolled back and never rebuilt.
> - Findings **#1 / #3 / O1** (needs-attention toast; status-event diagnostics; OpenCode
>   plugin health) are developer-facing with no user-facing payoff being prioritized; #1 would
>   also require building a toast host (the app has no toast infrastructure today).
> - Finding **#2 / O2** (decouple drift-prone artifacts; surface OpenCode SQLite "schema
>   drift") rests on a drift premise that turned out to be **our own scanner implementation
>   error, now fixed** — OpenCode's schema did not drift. The motivating risk is unfounded;
>   item dropped.
> - Original rejections **A** (hooks) and **B** (process-tree ID) were later **adopted** by
>   specs 047 / 032, so those threads are closed independently of this spec.
>
> Per CLAUDE.md, moved to `specs/done/` (not deleted) because the file still provides durable
> context: historical reasoning for why techniques were / weren't adopted, and herdr technique
> references. **The body below is preserved as-is for reference — no part of it is a work
> item.** herdr is AGPL-3.0; read for technique only, do not vendor code or rule text.

## Re-evaluation note (read this first — supersedes the original "Correction to the record")

The original document was written as deltas on top of an assumed-already-shipped
screen-scraping status engine (then called "spec 045" / "spec 048"). That engine was
rolled back, and an earlier version of this spec correctly said *"there is currently no
status-detection code anywhere in this tree."* **That statement is no longer true.** Four
specs have since landed and moved the ground under every finding here:

- **spec 032** shipped **hooks-based status badges** — the authoritative status source.
  Managed lifecycle hooks install into `~/.claude/settings.json` (Claude) and
  `~/.codex/hooks.json` (Codex, + `[features] hooks = true`), and report `session_start` /
  `user_prompt_submit` / `pre_tool_use` / `post_tool_use` / `stop` / `stop_failure` /
  `permission_request` to a localhost report server.
- **spec 050** shipped a **scoped terminal-error scraping complement** — default on
  (`agentStatusScraping`), Codex-only patterns at launch, matching canonical fatal-output
  signatures from a rolling fresh-output buffer (never scrollback, never keywords like
  `Error:`/`panic`). It feeds the *same* reducer a `terminal_error` event with a latch.
  This is the explicit, documented, one-off exception to spec 032's "no scraping" line.
- **spec 047** shipped **process-tree identification of CLI-launched agents** + the managed-
  hook install — i.e. the *exact two techniques* this document's original "Considered and
  not adopted" section rejected as Finding A (hooks) and Finding B (foreground-process
  identification). Both are now in the tree; those rejections are closed (see §A, §B).
- **spec 052** shipped **opencode as a third `AgentKind`** — plugin-based session linking
  + status (no external hook command exists for OpenCode), a SQLite session scanner,
  provider routing via `OPENCODE_CONFIG_CONTENT`, and `--auto` as the launch default.

Three consequences, each reflected in the findings below:

1. **The original screen-region rule engine (rules JSON, `regions.ts`, `PROMPT_MARKER`,
   OSC-as-idle, transcript-viewer `skip`) does not exist and was never rebuilt.** Findings
   premised on it (#4, #5, #7) are marked **MOOT** under the scoped detector — they would
   only revive if scraping ever broadened back toward 048-style region rules, which the 048
   lesson argues against.
2. **The original "Finding A" rejection (hooks violate the no-config-mutation guardrail) was
   revisited and a scoped, reversible exception was accepted.** Managed hooks are now the
   canonical linking + status path for Claude/Codex. What was *correctly* rejected was
   herdr's host-runtime-dependent hook script (needs `python3`/a shell CLI); MultiAgent's is
   a self-contained PowerShell script + localhost report server. OpenCode has no external
   hook command at all, so spec 052 uses an in-process plugin instead.
3. **The 048 lesson still stands and is load-bearing for any future scraping work:**
   rules/signatures must be verified against **real captured output** before shipping, must
   be canonical high-specificity signatures (not loose substrings/keywords), and must scan a
   rolling fresh buffer (never scrollback). spec 050 encodes exactly this discipline.

## How status detection actually works now (the baseline these findings are deltas on)

One pure reducer, `eventToState` in `src/shared/agentStatus.ts`, is the single merge point.
Two independent, separately-toggleable sources compose at that reducer:

| Source | Gated by | What it owns |
|---|---|---|
| **Lifecycle hooks** (spec 032) | `cliSessionLinking` (default on) | authoritative working / waiting / idle / error-via-`stop_failure` |
| **Terminal-error scraping** (spec 050) | `agentStatusScraping` (default on) | the scoped gap: fatal errors no hook reports → `terminal_error` (latched) |

Hook events and scrape events travel the same IPC path (`pane:agent-event` /
`pane:terminal-status`) into the same `eventToState(prev, input)` call in
`src/renderer/src/store/panesIpc.ts`. The resulting state lives on the `agentStatus` field of
each `PaneLeaf` (`src/renderer/src/store/panes.ts`) and renders via `StatusDot.tsx` in both
`PaneHeader` and the sidebar `PaneRow`. The scrape patterns live as the
`TERMINAL_STATUS_PATTERNS` table in `src/main/pty/terminalStatusDetector.ts` (TS code, not
data JSON): `claude: []`, `codex: [<two fatal signatures>]`, `opencode: []` (OpenCode
surfaces errors via its plugin's `session.error` → `stop_failure`, so scraping is
intentionally empty for it — matching Claude). OpenCode linking + status comes from a
bundled in-process plugin (`src/main/integration/assets/multiagent-opencode-plugin.js`)
injected via `OPENCODE_CONFIG_CONTENT`, which POSTs the same event shapes to the same report
server.

Read every finding below against this baseline — not against the rolled-back 048 engine the
original prose assumed.

---

## Findings ranked by impact

### 1. (HIGH, intact + cheaper) "Needs attention" toast + sound when a background pane becomes blocked

> **Status (2026-07-26): intact, and cheaper than when written.** The `agentStatus` slice +
> state transitions this finding assumed absent **now exist** (spec 032). The only missing
> piece is the toast host — still no push notification surface beyond `UpdateBanner` /
> `window.prompt`. Two updates to the original framing:
> - **Generalize beyond `input-required`.** The highest-signal *push* events today also
>   include error (Codex 404 via scraping; Claude `stop_failure`; OpenCode `session.error`).
>   A toast on a transition to `error` for a non-focused pane is at least as valuable as the
>   permission-prompt case and reuses the same host.
> - **OpenCode rarely hits `waiting` by default.** spec 052 launches OpenCode with `--auto`
>   (auto-approve non-denied permissions), so OpenCode panes run unattended and don't surface
>   permission prompts. The needs-attention-on-blocked case therefore applies to OpenCode
>   only if `--auto` is off (see OpenCode finding **O3** for that open consideration).

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
- Drive it from the existing `agentStatus` field on `PaneLeaf` (spec 032, in
  `src/renderer/src/store/panes.ts`): on a transition to `waiting` (or `error`) for a pane
  that is **not the focused pane in the active tab**, emit a toast keyed by `paneId`
  (debounced so repeated prompts don't spam). The transitions are already computed inside
  `eventToState` — this is a renderer-side observer off the same store, not a new status path.
- Optional sound: a bundled asset under `src/renderer/src/assets/`, gated by a setting
  (default off — audio is intrusive). Keep it advisory: clicking the toast runs
  `focusPaneInTab(tabId, paneId)` (atomic, hydrates inactive tabs — CLAUDE.md multi-window
  invariant).
- Cross-window note: a detached window's blocked/errored agent should toast in **its own**
  window (status is local-only per window today); the primary window can't see detached
  status.

**Effort:** low–medium. **Risk:** low (advisory, debounced, setting-gated).

---

### 2. (MEDIUM, reframed) Decouple drift-prone detection artifacts from app releases

> **Status (2026-07-26): reframed down from HIGH.** There is no longer a bundled
> `rules/{claude,codex}.json` rule-pack directory and no `engine.ts` `RuleSet` — those were
> the rolled-back 048 architecture and **do not exist** (the file citations in the body
> below are stale; read them as "the equivalent live artifact"). The real drift-prone
> artifacts today are far fewer, which lowers the ROI of a full OTA catalog:
> - the **`TERMINAL_STATUS_PATTERNS` TS table** (`src/main/pty/terminalStatusDetector.ts`) —
>   two Codex fatal signatures spec 050's own Risks flag as version-dependent;
> - the **OpenCode plugin's event-name → our-event-name mapping**
>   (`multiagent-opencode-plugin.js`) — brittle to OpenCode's `Event` union changing (it
>   silently broke twice during spec 052; see **O1**);
> - the **Claude/Codex managed hook scripts** + the OpenCode plugin asset — bundled, so a
>   one-line fix still waits for an app release.
>
> The underlying need (decouple these from app releases) remains, but at a much smaller
> scale than herdr's case (herdr maintains 19 agent manifests; we have three agents' worth
> of small artifacts). The body below is preserved as the technique reference; treat its
> file paths as aspirational and its "HIGH" framing as superseded by this banner. Finding
> **#6** (version/minEngineVersion) is now only worth doing if this one is pursued.

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

### 3. (MEDIUM-HIGH, reframed) Status-event diagnostics / explain path + dev overlay

> **Status (2026-07-26): intact in spirit, re-pointed.** The "engine" to explain is no
> longer a screen-region rule evaluator (`engine.ts`/`regions.ts`/`detectFromRegions` do not
> exist — those citations below are stale). It is now `eventToState` + the scrape detector +
> the report-server event stream. The diagnostics that would actually help, per pane:
> - the **stream of lifecycle events the report server received** (hook + plugin + scrape),
>   with timestamps — so a wrong badge is traceable to "no event arrived" vs "an event
>   arrived but the reducer kept prev";
> - the **reducer's resulting state + latch** (`eventToState` is already pure; an opt-in
>   trace return is cheap);
> - for OpenCode specifically, **whether the plugin loaded and POSTed anything** (see **O1**
>   — this is the highest-leverage instance, because the plugin is OpenCode's *sole*
>   linking+status path and it silently no-ops on failure).
>
> The body below is preserved as herdr's explain-technique reference; substitute the live
> artifacts above for the stale `engine.ts`/`regions.ts` paths.

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

### 4. (MOOT under the scoped detector) Transcript-viewer / scroll-mode `skip_state_update`

> **Status (2026-07-26): MOOT.** The 050 detector matches only canonical *fatal-error*
> signatures from a rolling fresh buffer; it does no permission/idle/working detection, so
> opening Claude's Ctrl+O transcript viewer or Codex's scroll mode cannot false-flip the dot
> to `waiting`/`idle`. The false-positive class this finding guards against doesn't arise
> under the scoped detector. It would only revive if scraping ever broadened back toward
> 048-style region rules — which the 048 lesson argues against. Kept below as the technique
> reference for that hypothetical; no action now.

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

### 5. (MOOT) Codex-specific prompt/block markers for `after_last_prompt_marker`

> **Status (2026-07-26): MOOT.** There is no `after_last_prompt_marker` / `prompt_box_body`
> region extraction anywhere in the tree — `regions.ts` does not exist. The 050 detector
> uses whole-stream canonical regexes over a rolling buffer, not region-based matching, so
> Codex's `›` prompt glyph and `•■✗✓` block markers are irrelevant to current detection.
> Kept below as the technique reference; no action unless region-based scraping returns.

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

### 6. (LOW, conditional on #2) Rule-file schema: `version`, `minEngineVersion`, `aliases`

> **Status (2026-07-26): lower priority.** Only worth doing if the reframed #2 (decoupling
> drift-prone artifacts from app releases) is pursued, and even then the artifacts are TS
> code / a JS plugin, not versioned data JSON, so `version`/`minEngineVersion` apply to
> fewer things than the body assumes. Skip unless #2 is picked up.

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

### 7. (N/A) Use OSC 9 progress (`4;0`) as an idle signal

> **Status (2026-07-26): N/A.** The current system derives `idle` deterministically from the
> `Stop` hook (Claude/Codex) and from the OpenCode plugin's `session.idle` event — not from
> OSC. OSC 9 is captured nowhere for status. spec 032 explicitly deferred any OSC-as-idle
> tie-breaker. The body is preserved as reference; no action.

**The gap.** We capture `osc_progress` (OSC 9) in `osc.ts` and expose it as a region, but
neither `claude.json` nor `codex.json` keys `idle` off it. herdr's `claude.toml`
`osc_progress_idle` rule matches `^4;0` for idle (priority 250).

**How to adapt.** Add an `osc_progress` idle rule to `claude.json` matching the idle
progress payload (observe the actual OSC 9 bytes Claude emits — don't assume `4;0`). Keep
priority low so a visible blocker/working rule overrides it.

**Effort:** trivial. **Risk:** low. (Minor gain; our osc_title rules already cover most
cases. Include only if observed OSC 9 traffic warrants it.)

---

## OpenCode-specific findings (added 2026-07-26, post spec 052)

OpenCode is now a third `AgentKind` (spec 052). Its integration differs structurally from
Claude/Codex — it has **no external-process hook command**, so linking + status come from an
**in-process plugin** (`src/main/integration/assets/multiagent-opencode-plugin.js`), injected
process-scoped via `OPENCODE_CONFIG_CONTENT`; sessions live in a **SQLite DB** scanned by
`OpencodeSessionScanner`; and panes launch with **`--auto`** (unattended). These are the
herdr-style techniques worth adapting specifically for OpenCode.

### O1. (HIGH) OpenCode plugin health + event-log diagnostics

**The gap.** The OpenCode plugin is the **sole** session-linking + status path for OpenCode
panes — there is no `--session-id` (OpenCode generates its own id) and no fallback scanner
for linking (the SQLite scanner is for the Session Browser, not pane linking). If the plugin
silently stops working, every OpenCode pane stays unlinked + badgeless with **no visible
signal**. This is not hypothetical: spec 052 documents the plugin silently no-op'ing **twice**
during development — first because `OPENCODE_CONFIG_DIR` is not a real env var (the plugin
never loaded), then because session/permission lifecycle events are delivered only through
the generic `event` hook, not as top-level keys (the plugin loaded but no hooks fired). A
future OpenCode version that renames an event or reshapes the `Event` union reproduces
exactly this failure mode.

**Why high impact.** This is the OpenCode instance of finding **#3** (diagnostics), but
higher-stakes because there is no fallback. It is also the prerequisite for safely tuning
the plugin's event→our-event mapping (some mappings were speculative at spec 052 ship time —
see O3/Risks), the same way #3 was the prerequisite for tuning 048's rules.

**What to adapt.**
- A **plugin-loaded heartbeat**: the plugin POSTs a one-shot `/agent-event` (or a new
  `/plugin-loaded` route) on first load, so main/renderer knows the plugin is alive for that
  pane. Absence of the heartbeat after N seconds on an OpenCode pane = "plugin didn't load"
  → surface a diagnostic (not a user-facing error).
- An **event-log diagnostics overlay** (shared with #3): per pane, show whether the plugin
  loaded and the sequence of events it POSTed, alongside hook/scrape events. This makes
  "plugin loads but sessions never link" debuggable instead of a guessing game.
- Pin the **OpenCode `Event` union shape** the plugin was verified against (a comment +
  version string); on an OpenCode upgrade, re-verify against `@opencode-ai/sdk` types before
  assuming the plugin still works.

**Effort:** low–medium. **Risk:** low (read-only diagnostics; the heartbeat is one extra
best-effort POST the plugin already wraps in try/catch).

---

### O2. (MEDIUM) OpenCode SQLite schema drift is invisible

**The gap.** `OpencodeSessionScanner` queries the `session`/`message`/`part` tables, which
spec 052 verified are **"NOT a documented stable contract"** (against OpenCode 1.18.5). The
scanner fails closed defensively (`PRAGMA table_info` check; any mismatch → returns `[]`).
That is correct for safety, but the failure is **invisible**: an OpenCode version bump that
renames a column silently drops OpenCode from the Session Browser + Recent sidebar — no
error, no diagnostic — indistinguishable from "no OpenCode sessions yet." This is the
session-indexing analog of finding #2's drift class, specific to OpenCode, and the
invisibility is the problem.

**What to adapt.**
- When `schemaOk()` fails, **surface it**: a diagnostic flag/log line (and, if the #3/O1
  diagnostics overlay exists, a row there) saying "OpenCode DB schema unrecognized
  (<installed version?>); OpenCode sessions not indexed." This turns a silent fail-closed
  into an observable one.
- Record the **schema version the scanner was written against**; treat a mismatch as a known
  maintenance task, not a mystery. (Same discipline as the plugin's Event-union pinning in
  O1.)

**Effort:** low. **Risk:** none (read-only; fail-closed behavior unchanged, just observable).

---

### O3. (OPEN — both directions recorded, not picked here) OpenCode permission posture vs. needs-attention

spec 052 launches OpenCode with `--auto` (auto-approve non-denied permissions), so OpenCode
panes run unattended and **never reach a `waiting`/needs-attention state by default**. This
inverts finding **#1**'s premise for OpenCode. Two directions are worth recording; this
spec does **not** pick one (defer to a future spec).

- **(a) Keep `--auto`; broaden the notification.** Leave OpenCode unattended (matches its
  posture as a long-running agent), and let finding #1's toast also fire on OpenCode
  `session.error` (→ `error`) and optionally on turn-complete (`session.idle` → `stop`), so
  OpenCode still gets *push* alerts without surfacing prompts. Lowest friction; re-uses #1.
- **(b) Re-open the spec 052 Non-Goal: a per-card / per-pane `--auto` toggle.** Let the user
  opt a given OpenCode pane into surfacing permission prompts, so it can participate in
  needs-attention exactly like Claude/Codex (prompts reach `permission_request` → `waiting`
  → toast). More control, but it diverges OpenCode panes from each other and adds a
  per-pane/per-card setting spec 052 deliberately fenced out.

Also worth noting for whoever picks this up: the plugin maps `permission.updated` →
`permission_request`, but under `--auto` permissions are auto-resolved, so that event may
fire-and-clear instantly (a transient `waiting` flash) or not fire at all. The mapping was
speculative at spec 052 ship time and needs real-capture verification (the 048 lesson again)
before either direction is built on it.

---

## Considered and not adopted (documented for future agents)

These are real herdr features that conflict with MultiAgent non-negotiables or
architecture. Recorded so future agents don't re-investigate them.

### A. Hook-based session capture via agent config mutation — **ADOPTED (in a different form) by specs 047 + 032 — finding CLOSED**

> **Update (2026-07-26): this rejection was revisited and the technique was adopted.**
> Managed lifecycle hooks now install into `~/.claude/settings.json` (Claude) and
> `~/.codex/hooks.json` (Codex, + `[features] hooks = true`) under a scoped, reversible,
> default-on toggle (`cliSessionLinking`), with a marked block + `.bak` + atomic write +
> reconcile-on-install. The CLAUDE.md guardrail documents this scoped exception. OpenCode
> has no external hook command, so spec 052 uses an in-process **plugin** instead (same
> report server, same events). **What was correctly rejected** below was herdr's
> host-runtime-dependent hook script (needs `python3` on Unix / the `herdr` CLI on Windows) —
> MultiAgent's is a self-contained PowerShell script + localhost report server with no
> prerequisites, which is what made the scoped exception acceptable. The technique is in the
> tree; this finding is kept only as the historical reasoning.

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
the default. Reference: our `src/main/sessions/SessionSpawner.ts` (detection),
`src/main/sessions/` (indexing).

### B. Foreground-process-group agent identification — **ADOPTED by spec 047 (Phase 1) — finding CLOSED**

> **Update (2026-07-26): this rejection was based on a factual error and the technique was
> adopted.** spec 047 corrected the claim that herdr's Windows foreground-job path is a
> no-op: herdr's `src/platform/windows.rs` implements it fully (ToolHelp + NtQuery +
> ReadProcessMemory), and spec 047 shipped `src/main/pty/agentProcessDetect.ts` +
> `processSnapshot.ts` + `agentProcessSweeper.ts` (using `Get-CimInstance Win32_Process` on
> Windows) for CLI-launched `claude`/`codex`/**`opencode`** detection + demotion-on-exit.
> The technique is in the tree. **Known residual gap:** an agent launched inside WSL is not
> detectable from the Windows host process table (recorded in spec 052 Risks). The reasoning
> below is kept as the historical record.

herdr identifies the running agent from the pane's foreground process group
(`identify_agent_in_job`, `src/detect/mod.rs`), so an agent launched **manually inside a
shell pane** (user types `claude`) is detected and status-tracked. We set `agentKind` only
at spawn (`SessionSpawner`), so a manually-launched agent in a shell pane gets no status.
herdr's own Windows path is a no-op fallback (`src/platform/fallback.rs:
foreground_job → None`). We are Windows-first, where foreground-process-group inspection is
hard/unreliable. **Low impact, high effort for us.** Document as a known gap; revisit only
if we add a reliable Windows process-tree inspection primitive.

### C. Multi-source arbitration (hook authority + screen + PTY activity) — **partially adopted**

> **Update (2026-07-26): the shipped design IS a two-source arbitration.** Hooks (spec 032)
> are authoritative; the scoped scrape (spec 050) is the complement; they compose at the
> `eventToState` reducer, and the `terminal_error` **latch** (hold through dead-turn noise;
> clear on `user_prompt_submit`/`session_start`/`demote`) is exactly the suppression-window
> discipline this finding endorses. The line below saying "we deliberately don't use hooks"
> is **stale** — read it as pre-032 reasoning. No action beyond keeping the latch tuned; the
> "visible blocker overrides authority and notifies" principle is already encoded as
> "input-required/error wins over working/idle."

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

**MultiAgent (real current homes — findings land against these, not a future engine):**
- Status reducer (single merge point, spec 032): `src/shared/agentStatus.ts`
  (`eventToState`, applied in `src/renderer/src/store/panesIpc.ts` + `panes.ts`).
- Scoped scrape detector + patterns (spec 050): `src/main/pty/terminalStatusDetector.ts`
  (`TERMINAL_STATUS_PATTERNS` — claude:[], codex:[2], opencode:[]); toggle is
  `agentStatusScraping` in `src/renderer/src/store/settings.ts` (default on).
- Managed lifecycle hooks (spec 047/032): Claude `~/.claude/settings.json`, Codex
  `~/.codex/hooks.json`; report server under `src/main/sessions/`.
- CLI-launched agent detection (spec 047): `src/main/pty/agentProcessDetect.ts`,
  `processSnapshot.ts`, `agentProcessSweeper.ts`.
- OpenCode linking/status (spec 052): `src/main/integration/assets/multiagent-opencode-plugin.js`
  (event → our-event mapping; sole linking+status path); `src/main/sessions/OpencodeSessionScanner.ts`
  (SQLite, Session Browser only).
- `agentStatus` field on `PaneLeaf`: `src/renderer/src/store/panes.ts`
  (`setPaneAgentStatus` / `promote`/`demote` mutate it).
- Status dot (shipped): `src/renderer/src/components/PaneHeader/index.tsx` + sidebar
  `src/renderer/src/components/Sidebar/TabSections.tsx` (both render `<StatusDot>`).
- Sidebar per-pane surface: `PaneRow` in `TabSections.tsx` (no separate "Agents dock").
- Toast/banner precedent (for #1): `src/renderer/src/components/UpdateBanner.tsx` only;
  no reusable toast host exists yet.
- Auto-update infra (for a reframed #2): `src/main/updater.ts`, `publish.bat`.
- Command registry (new commands/sections): `src/renderer/src/commands/registry.ts`.
- IPC contract source of truth: `src/shared/types.ts`.
- Session detection + spawning: `src/main/sessions/SessionSpawner.ts`, `src/main/sessions/`.
- Layout persistence pattern: `src/main/ipc/layoutStore.ts`, `applyLayout` in `panes.ts`.
- **Rolled-back, does NOT exist** (do not cite as a home): `src/renderer/src/terminal/status/`
  (`engine.ts`/`rules/*.json`/`regions.ts` — the spec 048 screen-rule engine). The findings
  above were re-pointed away from this; treat any stray reference to it as stale.

## Suggested ordering (re-evaluated 2026-07-26)

> The original ordering (schema → toast → diagnostics → accuracy → OTA) assumed a 048-style
> screen-rule engine would be built. It wasn't. Findings #4, #5, #7 are **MOOT** under the
> scoped detector and are dropped from the ordering. The reframed priorities:

1. **Finding #3 + O1 (status-event diagnostics + OpenCode plugin health)** — do **first**.
   Highest leverage: OpenCode's plugin is its sole linking+status path and silently no-ops on
   failure (it broke twice during spec 052). An event-log overlay + plugin-heartbeat makes
   every subsequent tuning safe, the same way the original ordering put `status:explain`
   ahead of rule edits. This subsumes the old #3 and folds in O1.
2. **Finding #1 (needs-attention toast + sound)** — highest user-visible payoff, independent
   of diagnostics. Generalize beyond `input-required` to also cover `error` (and, for
   OpenCode under `--auto`, optionally `session.idle`/turn-complete — see O3 direction (a)).
3. **Finding #2 (reframed) + O2 (drift mitigation)** — decouple the small set of drift-prone
   artifacts (`TERMINAL_STATUS_PATTERNS`, the OpenCode plugin's event mapping, the SQLite
   scanner schema) from app releases, **or** at minimum make the failures observable (O2).
   Smaller scope than herdr's 19-manifest case; only pursue if (1) shows drift biting in
   practice. #6 (schema versioning) is conditional on this and otherwise skip.
4. ~~#4 (transcript-viewer skip) + #5 (Codex markers) + #7 (OSC 9 idle)~~ — **dropped as
   MOOT** under the scoped detector. Revive only if scraping ever broadens back toward
   region-based 048-style rules (which the 048 lesson argues against).
5. **O3 (OpenCode permission posture)** — open design question, not actionable until a
   future spec picks direction (a) keep `--auto` + broaden, or (b) per-pane `--auto` toggle.
   Requires real-capture verification of the `permission.updated` mapping first.