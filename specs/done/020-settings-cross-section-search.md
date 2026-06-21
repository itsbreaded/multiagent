# 020 — Settings Cross-Section Search

## Problem

The settings search field is scoped to whichever section is currently active. Typing "scrollback" while in the Appearance section returns nothing, even though the setting exists in Terminal. This forces users to already know which section contains the setting they want.

## Current Behavior

`src/renderer/src/components/SettingsPanel/index.tsx` renders section content under `{activeSection === '<id>' && (...)}` guards (lines 318, 373, 475, 654, 657). The `show*Setting` booleans at lines 170–177 already check `normalizedQuery`, but they are only ever evaluated inside the guard for their own section. The sidebar always shows the active section highlighted regardless of search state.

## Intended Behavior

Two mutually exclusive modes driven by whether the search field is non-empty:

### Section mode (`normalizedQuery === ''`)
Identical to current behavior. Sidebar highlights the active section. Only that section's content renders.

### Search mode (`normalizedQuery !== ''`)
- Main area shows all matching settings from every section, grouped under category headers — only non-empty groups render.
- Sidebar has **no highlighted section** — all nav items appear in their muted color (`#6b7280`).
- Clicking any sidebar item in search mode: clears the query and enters that section (returns to section mode).
- Clearing the search (backspace to empty): the previously active `activeSection` value is restored automatically — no new state needed.

## Non-Negotiables

- Do **not** add a new top-level state variable. `isSearching` is a derived bool (`normalizedQuery !== ''`); `activeSection` already retains its value while searching.
- The `McpSection` and `AgentProvidersSection` components are only rendered in section mode. Search mode shows nav cards for them, not their full UIs.
- The GPU diagnostics readout inside the Terminal section must **not** appear in search results — it is lazy-loaded only when `activeSection === 'terminal'` and that guard must stay intact.
- The existing `show*Setting` boolean definitions (lines 170–177) are the filter mechanism. Reuse them; do not duplicate or rewrite the keyword strings.

## Key Code Locations

| What | File | Lines |
|---|---|---|
| `normalizedQuery` definition | `SettingsPanel/index.tsx` | 169 |
| `show*Setting` booleans | `SettingsPanel/index.tsx` | 170–177 |
| `visibleHotkeys` filter | `SettingsPanel/index.tsx` | 180–182 |
| Sidebar `sections.map(...)` loop | `SettingsPanel/index.tsx` | 229–269 |
| Sidebar button click handler | `SettingsPanel/index.tsx` | 234 |
| Search `<input>` `onChange` | `SettingsPanel/index.tsx` | 300 |
| Section content area (`<div className="dark-scrollbar">`) | `SettingsPanel/index.tsx` | 315–658 |
| Appearance guard | `SettingsPanel/index.tsx` | 318 |
| Hotkeys guard | `SettingsPanel/index.tsx` | 373 |
| Terminal guard | `SettingsPanel/index.tsx` | 475 |
| MCP guard | `SettingsPanel/index.tsx` | 654 |
| Providers guard | `SettingsPanel/index.tsx` | 657 |

## Implementation Steps

All changes are isolated to `src/renderer/src/components/SettingsPanel/index.tsx`.

### 1 — Derive `isSearching`

Add after the `normalizedQuery` definition (line 169):

```ts
const isSearching = normalizedQuery !== ''
```

### 2 — Sidebar: neutral state during search + clear-on-click

In the `sections.map()` loop the `active` local is `activeSection === section.id` (line 231). Replace all style references to `active` with `active && !isSearching`.

Replace the existing `onClick` (line 234) with:

```ts
onClick={() => {
  if (isSearching) setQuery('')
  setActiveSection(section.id)
  setRecording(null)
  setConflictLabel(null)
}}
```

### 3 — Cancel recording when user types in the search box

The search `<input>` `onChange` is currently `(e) => setQuery(e.target.value)`. Change to:

```ts
onChange={(e) => { setRecording(null); setQuery(e.target.value) }}
```

### 4 — Section content area: branch on `isSearching`

The `<div className="dark-scrollbar">` at line 315 currently contains five section-gated blocks. Wrap all of them so they only render in section mode, and add a new search-mode branch:

```tsx
<div className="dark-scrollbar" style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
  {!isSearching ? (
    <>
      {/* existing five section blocks — unchanged */}
    </>
  ) : (
    <SearchResults ... />   // see step 5
  )}
</div>
```

### 5 — `SearchResults` block (inline or extracted)

Render only non-empty groups. Use the same `show*Setting` and `visibleHotkeys` booleans already defined above — they already reflect `normalizedQuery`.

```tsx
function SearchResults({
  // pass down every show* flag, visibleHotkeys, effectiveHotkeys, hotkeyOverrides,
  // and the setters needed by each SettingRow / HotkeyRow
  // plus: setQuery, setActiveSection for nav cards
  // plus: recording, setRecording, conflictLabel props for HotkeyRow
}): JSX.Element {
  const hasAppearance  = showBranchSetting || showOverflowSetting
  const hasHotkeys     = visibleHotkeys.length > 0
  const hasTerminal    = anyTerminalSetting   // already defined at line 177
  const hasMcp         = MCP_KEYWORDS.some(k => normalizedQuery.includes(k))
  const hasProviders   = PROVIDER_KEYWORDS.some(k => normalizedQuery.includes(k))
  const hasAnything    = hasAppearance || hasHotkeys || hasTerminal || hasMcp || hasProviders

  if (!hasAnything) return <EmptyMessage>No settings match your search.</EmptyMessage>

  return (
    <>
      {hasAppearance && (
        <>
          <SectionLabel>Appearance</SectionLabel>
          {showBranchSetting && <SettingRow ...gitBranch... />}
          {showOverflowSetting && <SettingRow ...tabOverflow... />}
        </>
      )}
      {hasHotkeys && (
        <>
          <SectionLabel>Keyboard Shortcuts</SectionLabel>
          {/* same HotkeyRow list as hotkeys section — no Reset All button, no Terminal Shortcuts subsection */}
          {visibleHotkeys.map(id => <HotkeyRow key={id} ... />)}
        </>
      )}
      {hasTerminal && (
        <>
          <SectionLabel>Terminal</SectionLabel>
          {/* no caps/diagnostics readout — omit it entirely */}
          {showContrastSetting && <SettingRow ...contrast... />}
          {showRescaleSetting && <SettingRow ...rescale... />}
          {showScrollbackSetting && <SettingRow ...scrollback... />}
          {showOptimizedRendererSetting && <SettingRow ...optimizedRenderer... />}
          {showGpuAccelSetting && <SettingRow ...gpuAccel... />}
        </>
      )}
      {hasMcp && (
        <SettingNavCard
          title="MCP Servers"
          description="Configure the built-in browser server and custom MCP servers."
          onNavigate={() => { setQuery(''); setActiveSection('mcp') }}
        />
      )}
      {hasProviders && (
        <SettingNavCard
          title="Agent Providers"
          description="Set API keys and model overrides for Claude and Codex."
          onNavigate={() => { setQuery(''); setActiveSection('providers') }}
        />
      )}
    </>
  )
}
```

Keyword constant arrays (define at module level, outside the component):

```ts
const MCP_KEYWORDS      = ['mcp', 'model context', 'protocol', 'server', 'browser']
const PROVIDER_KEYWORDS = ['provider', 'agent', 'claude', 'codex', 'api', 'key', 'env', 'environment', 'variable']
```

Matching: `KEYWORDS.some(k => normalizedQuery.includes(k))` — same pattern as the existing `'git branch badges tabs panes'.includes(normalizedQuery)` just inverted (keyword-in-query rather than query-in-keywords) to avoid false positives from short queries like "a".

### 6 — `SettingNavCard` component

Add alongside the other small helper components at the bottom of the file:

```tsx
function SettingNavCard({ title, description, onNavigate }: {
  title: string
  description: string
  onNavigate: () => void
}): JSX.Element {
  return (
    <section
      style={{
        padding: '10px 12px',
        marginBottom: 4,
        border: '1px solid #2a2b2e',
        borderRadius: 6,
        backgroundColor: '#141517',
        display: 'grid',
        gridTemplateColumns: 'minmax(220px, 1fr) minmax(160px, auto)',
        gap: 24,
        alignItems: 'center',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ color: '#d4d4d4', fontSize: 13, marginBottom: 4 }}>{title}</div>
        <div style={{ color: '#6b7280', fontSize: 11, lineHeight: 1.4 }}>{description}</div>
      </div>
      <div>
        <button
          onClick={onNavigate}
          style={{
            padding: '4px 12px',
            background: 'none',
            border: '1px solid #3a3b3e',
            borderRadius: 4,
            color: '#6b7280',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Go to →
        </button>
      </div>
    </section>
  )
}
```

## What NOT to Change

- The `useEffect` that lazily loads `caps` only when `activeSection === 'terminal'` — leave it exactly as-is. Search mode never renders the diagnostics readout, so it never triggers the probe.
- `settingsInitialSection` deep-link logic (line 63) — unaffected. Deep-links start with an empty query, so they enter section mode as before.
- `McpSection` and `AgentProvidersSection` components — no changes. They are only mounted in section mode.
- The `{!normalizedQuery && (...)}` guard around the Terminal Shortcuts (fixed) subsection inside the Hotkeys block — leave it. In search mode that entire section block is not rendered anyway.

## Verification

- [ ] Typing "scrollback" from Appearance shows Terminal > Scrollback Lines under a "Terminal" header.
- [ ] Typing "branch" shows Appearance > Git branch badges under an "Appearance" header.
- [ ] Typing "new tab" shows the matching hotkey row under a "Keyboard Shortcuts" header.
- [ ] Typing "mcp" shows an MCP nav card; clicking "Go to →" clears search and opens the MCP section.
- [ ] Typing "provider" shows an Agent Providers nav card.
- [ ] Typing "api" shows both Terminal settings that match (if any) AND the Providers nav card.
- [ ] While searching, no sidebar item has the green left border or highlighted background.
- [ ] Clicking a sidebar section while searching: query clears, that section is shown, sidebar highlights it.
- [ ] Clearing the search restores the previously active section (no jank, no empty view).
- [ ] Starting a hotkey rebind, then typing in the search box: recording is cancelled.
- [ ] A query that matches nothing across all groups shows "No settings match your search."
- [ ] After a no-match search, clicking Terminal in the sidebar shows the Terminal section correctly.
- [ ] GPU diagnostics readout does NOT appear in any search results.
- [ ] Opening settings via command palette deep-link (e.g. `openSettings('hotkeys')`) still lands on the correct section.
