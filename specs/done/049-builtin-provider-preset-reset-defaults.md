# 049 — Reset-to-Defaults for Built-in Provider Presets

## Problem

A built-in provider preset (Claude `native`/`deepseek`/`alibaba`/`ollama`/`zai`, Codex
`native`/`alibaba-token`/`alibaba-payg`) seeds known-good `baseUrl` + `model` defaults only on
**first activation** (`newClaudeConfig` / `newCodexConfig`, in
`src/renderer/src/components/SettingsPanel/AgentProvidersSection.tsx`). Once the user edits a
field and switches away, `saveClaudeOutgoing` / `saveCodexOutgoing` persist the edited draft into
the `claudePresets` / `codexPresets` map slot, so `loadClaudeDraft` / `loadCodexDraft` thereafter
returns the **saved** (edited) values — never the defaults. Re-clicking the active preset chip is a
no-op (`if (claudeDraft.preset === incomingId) return`).

Net effect: **if a user wipes the model/endpoint and saves, there is no way back to the shipped
default short of typing it in by hand.** Custom providers are out of scope — they have no shipped
defaults to reset to.

## Current Behavior

- `CLAUDE_PRESET_DEFAULTS` / `CODEX_PRESET_DEFAULTS` (`AgentProvidersSection.tsx:31`, `:54`) hold
  each built-in's shipped routing defaults. They are read **only** inside `newClaudeConfig` /
  `newCodexConfig`, which runs only when a preset slot has no saved draft.
- The saved-draft maps (`claudePresets` / `codexPresets`) are `Partial<Record<Builtin, Config>>`.
  Once a draft is written to a slot, defaults are never consulted again for that slot.
- No "reset" / "restore defaults" control exists in the UI. Per-field affordances exist only for
  editing (text inputs); there is no per-field reset icon.
- `authToken` (Claude) and `apiKey` (Codex) are user secrets and are **never** part of the defaults
  map (`native` aside, no preset ships a token). `extraEnvVars` and `enabled` are likewise not in
  the defaults map.

## Intended Behavior

### Scope of what "reset" touches

A reset restores **exactly the fields present in that preset's defaults entry** — nothing more.
Because `authToken` / `apiKey` / `extraEnvVars` / `enabled` are never keys in
`CLAUDE_PRESET_DEFAULTS` / `CODEX_PRESET_DEFAULTS`, a reset can never clear a credential or toggle
enabled state. This rule is self-maintaining: if a future preset ships a new routing field, it
becomes resettable automatically by being added to the defaults map.

Concretely, reset restores:

- **Claude:** `baseUrl`, `model`, `opusModel`, `sonnetModel`, `haikuModel`, `subagentModel`,
  `effortLevel` (every field `CLAUDE_PRESET_DEFAULTS[preset]` defines). Leaves `authToken`,
  `extraEnvVars`, `enabled`, `preset` untouched.
- **Codex:** `providerName`, `model`, `baseUrl`, `envKey`, `wireApi` (every field
  `CODEX_PRESET_DEFAULTS[preset]` defines). Leaves `apiKey`, `extraEnvVars`, `enabled`, `preset`
  untouched. (`envKey` is the env-var *name*, e.g. `OPENAI_API_KEY` — routing config, not a secret;
  the secret is `apiKey`, which is preserved.)

`native` renders no routing fields (everything is gated on `preset !== 'native'`), so the control
is hidden for native too — there is nothing visible to reset. In practice the button appears for
the non-native built-ins: `deepseek`/`alibaba`/`ollama`/`zai` (Claude) and `alibaba-token`/
`alibaba-payg` (Codex). Custom providers never show it.

### UI — single control per built-in, none on custom

**Decision (delegated by user): one "Reset to defaults" control per built-in provider**, not a
per-field icon. Reasoning:

- A per-field reset would scatter 6–8 small icons across an already dense card, and most of those
  fields (auth, extra env) must never reset — leading to an inconsistent "some fields have it, some
  don't" surface.
- The user's mental model is "I changed the model/endpoint and it broke; give me the preset's
  routing back" — a single coherent action serves that directly. Credentials are a separate concern
  and stay put.

**Rejected alternative:** per-field reset icons. Higher clutter, no added capability (the single
button already covers every resettable field), and harder to keep in sync with the defaults map.

Placement: a small image-icon button (consistent with the repo rule that buttons use
`src/renderer/src/assets/` `.png`s, not text/emoji — **ask for a missing icon before implementing**)
labelled "Reset to defaults" (tooltip), shown in the active-provider row only when the active
preset is a **built-in**. Hidden entirely when a custom provider is active (`isCustomId(preset)`).
Disabled (grayed) when the draft already equals the preset defaults (no-op), matching the disabled-
card gray convention.

The action is **direct, no overlay-modal confirm**: it discards routing edits (re-typeable) but
never credentials, so it does not meet the "discards credentials" bar that gates the delete-provider
confirm in spec 048. Keep it a one-click action.

### Mechanics (`AgentProvidersSection.tsx`)

Add `resetClaudePresetDefaults()` / `resetCodexPresetDefaults()` (mirroring the existing
`activateClaude` / `flushClaude` shape):

1. Read the active draft. If `isCustomId(draft.preset)`, bail (no-op — control is hidden anyway).
2. Build the reset draft: `{ ...draft, ...CLAUDE_PRESET_DEFAULTS[draft.preset as ClaudeBuiltinPreset] }`
   (Codex: `...CODEX_PRESET_DEFAULTS[...]`). The spread of the defaults map over the draft replaces
   exactly the routing fields and leaves `authToken` / `apiKey` / `extraEnvVars` / `enabled` /
   `preset` intact.
3. `setClaudeDraft(resetDraft)` and commit to the store **both** as the active config **and** into
   the built-in's saved slot (`claudePresets[builtin]`) — so the reset sticks across a switch-away
   and back (otherwise `loadClaudeDraft` would re-surface the old edited draft). Reuse the existing
   `commitClaudeActive` / `saveClaudeOutgoing` path; do not introduce a new persistence route.
4. No main-process change: the active config remains the single source of truth that
   `SessionSpawner` reads, unchanged from spec 048.

### Disabled-card interaction

When the provider card is disabled (provider not enabled), the reset button still works on the
preserved config (gray fields, same as today's edit-while-disabled) — resetting routing fields does
not require enabling the provider. Consistent with the disabled-card behavior spec 048 preserves.

## Implementation Phases

1. **Helpers** — `resetClaudePresetDefaults` / `resetCodexPresetDefaults` in
   `AgentProvidersSection.tsx`, default-spread over the active draft, commit to active + saved slot.
2. **UI** — reset control in the active-provider row, gated on `!isCustomId(preset)`, disabled when
   draft already equals defaults. Source an icon from `src/renderer/src/assets/` (ask if none fits)
   per the repo button rule.
3. **Verify** — typecheck, unit test for the reset helpers (reset restores defaults, preserves
   token/key, sticks across a switch round-trip), manual reset on each built-in.

## Risks

- **CONFIRMED + FIXED at implementation: the `ollama`/`zai` Claude presets shipped `authToken: ''`
  in their defaults map.** That made "Reset to defaults" credential-destruct on `zai` (it would
  blank a user-entered key). Fix: `authToken` removed from both entries — seeding is unaffected
  (`newClaudeConfig` already sets `authToken: ''` as a base field before spreading defaults), and
  reset no longer touches the token. Pinned by `providerPresetDefaults.test.ts`, which fails if any
  preset's defaults ever regain a credential key. This is the durable lesson: the defaults map is
  the reset surface, so credential keys must never appear in it.
- **Reset must persist into the saved slot, not just the active draft.** If it only mutates the
  draft, `loadClaudeDraft` re-surfaces the old edited values on the next switch-back and the reset
  appears to "not stick." Verification step covers a switch round-trip.
- **Spread-order matters.** Defaults must spread *over* the draft (`{ ...draft, ...defaults }`),
  never the reverse, or the user's saved auth/credentials would be blanked onto a no-token object.
- **Codex `envKey` reset.** It looks credential-adjacent but is the env-var name, not a secret. The
  secret (`apiKey`) is preserved. Documented above so a future reader doesn't "fix" it by excluding
  `envKey` and silently break the preset's routing identity.
- **No new persistence route.** Reuse `commitClaudeActive` / `saveClaudeOutgoing`. Introducing a
  bespoke save path risks desyncing active vs saved slot — the exact bug spec 048's flush logic
  guards against.

## Verification Steps

- `npm run typecheck` passes.
- `npm run test` — add a unit test asserting: after a reset, `baseUrl`/`model` (and Codex
  `providerName`/`envKey`/`wireApi`) match `*_PRESET_DEFAULTS[preset]`, while `authToken` (Claude) /
  `apiKey` (Codex) / `extraEnvVars` are unchanged; and that switching away then back keeps the
  reset values (not the pre-reset edited draft).
- Manual: on the Claude card, set `alibaba`, wipe `model` + `baseUrl`, click "Reset to defaults",
  confirm both restore to `qwen3.5-plus` / `https://dashscope-intl.aliyuncs.com/apps/anthropic` and
  the auth token (if entered) survives. Switch to `deepseek` and back — reset values persist.
- Manual: on the Codex card, set `alibaba-token`, wipe `baseUrl` + `model`, reset, confirm restore
  and `apiKey` preserved.
- Manual: reset is **absent** when a custom provider is active; **disabled** when the draft already
  equals the preset defaults.

## Definition of Done

- [ ] Every non-native built-in provider preset (Claude `deepseek`/`alibaba`/`ollama`/`zai`,
      Codex `alibaba-token`/`alibaba-payg`) exposes a "Reset to defaults" control; `native` and
      custom providers do not.
- [ ] Reset restores exactly the fields in `*_PRESET_DEFAULTS[preset]`; `authToken` (Claude) and
      `apiKey` (Codex) are never cleared, and `enabled` / `extraEnvVars` / `preset` are preserved.
- [ ] Reset persists into the built-in's saved slot, so it survives a switch-away-and-back round
      trip (does not silently revert to the pre-reset draft).
- [ ] Control is disabled when the draft already equals defaults; hidden on custom providers.
- [ ] `npm run typecheck` + `npm run test` pass; manual verifications above pass.
