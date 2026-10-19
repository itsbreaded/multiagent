# Renderer UI styling

Expands the **UI & command registry** guardrail in [`AGENTS.md`](../AGENTS.md).

## Source of truth

`src/renderer/src/styles/theme.ts` owns the renderer's appearance values. `defaultTheme` is
the current product appearance. `ThemeDefinition` describes the complete token set,
`themeToCssVariables` maps it to CSS custom properties, and `installTheme` installs it on the
document root before the app renders. This leaves a future theme free to provide a different
token set without component-by-component palette changes. This styling work adds no theme
selector, saved theme preference, or second built-in theme.

For inline React styles, use `ui.color`, `ui.radius`, `ui.shadow`, `ui.chrome`, the shared
style objects, or `border` from `theme.ts`. These references resolve through the active root
variables. For CSS, use `--ui-color-*`, `--ui-radius-*`, and `--ui-shadow-*`. A feature
stylesheet may define local aliases that point to those shared variables. Do not hardcode a
renderer palette value in a component or CSS rule.

Add a semantic token to `defaultTheme.color` when a color expresses a distinct role. Keep
status, provider identity, Jira status, warning, danger, and selection colors semantically
separate even when two roles currently share the same value. `ThemeDefinition` and
`themeToCssVariables` will carry the token to CSS. Add or update a test that proves the token
maps correctly and that changing it updates a computed style without changing the component.
Keep every remaining visual invariant named and justified below.

## Form controls and focus

Every native input, textarea, and select uses `.ui-control`. Checkboxes also use
`.ui-control-checkbox` for the shared accent treatment. The active `nativeColorScheme` sets
the browser UI scheme for fields, selects, and number steppers; the default theme uses `dark`.
Per-feature width, height, typography, and wrapper layout can remain local.

`.ui-control:focus-visible` supplies a 2px accent outline with a 1px offset. Do not use
`outline: none` unless the same keyboard interaction has another visible focus indicator.
Custom wrappers such as search controls may also update their border on `:focus-within`, but
must retain a visible keyboard ring. Keep disabled and invalid states legible and semantic.

## Shared visual patterns

- Use `overlayStyles` and `menuStyles` for common overlay and menu framing. Preserve feature
  geometry, z-order, and hit targets.
- Use existing shared style objects when a UI has the same role. Native form controls use
  `.ui-control`; keep product icon buttons on image assets from `src/renderer/src/assets/`.
- Put `dark-scrollbar` on non-terminal scrollable surfaces. Preserve the xterm viewport's
  separately tuned scrollbar and terminal content sizing.
- Use the app's system font for general interface text. Use monospace for code, identifiers,
  and technical labels. Keep feature-specific reading sizes and layout where they serve the
  content; normalize repeated patterns through shared styles rather than broad resets.
- Preserve semantic badge/status colors. Add distinct tokens for new status roles instead of
  reusing the accent solely to reduce the token count.
- Electron does not create a right-click context menu automatically. Add an explicit,
  feature-scoped menu for text editing or selected-text actions where needed. Jira Mentions'
  menu is main-process-owned and offers text edit actions only in editable fields and Copy
  for selected read-only issue text. Do not expose field contents or clipboard data over IPC.

## Named visual invariants

- The ANSI colors in `Terminal/index.tsx`'s xterm theme preserve terminal output palette
  semantics. Its app surface, text, cursor, and surrounding recovery/menu UI use theme tokens.
- Image and SVG artwork in `src/renderer/src/assets/` keeps its authored identity and
  contrast. Components theme their surrounding frames and controls.
- Native OS menu appearance is controlled by Electron and the host platform; app-owned
  custom overlays and menus use the theme tokens.
- The xterm viewport has a separate scrollbar implementation. It still draws from the theme
  scrollbar colors and must not inherit the generic page scrollbar rules.

## Adding or changing UI

1. Identify the existing surface family and reuse its component, shared style, and spacing
   pattern where possible.
2. Use semantic `ui` tokens or CSS variables for every palette value; add a token when no
   existing role fits.
3. Add `.ui-control` to native form controls and check keyboard focus, hover, disabled, and
   invalid states.
4. Keep feature-specific geometry and behavior local; keep common colors, borders, shadows,
   radii, and interaction states shared.
5. Use `dark-scrollbar`, shared overlay styles, and image icon assets where applicable.
6. If a style must stay invariant or a feature needs a different common state, record the
   reason here and in the focused subsystem documentation when it affects feature behavior.
7. Verify the rendered state at the relevant window size and in any detached window that owns
   the feature; keep the check or screenshot with the related spec when the change needs a
   visual acceptance record.
