# Spec: Renderer UI Style Alignment and CSS Guidance

Status: done <!-- draft | ready | in-progress | review | done -->
Created: 2026-10-19
Completed: 2026-10-19

## Problem

The app has an established dark palette and green accent, but shared UI styles have drifted between screens. A static source audit found that the global renderer stylesheet defines the base colors and scrollbar treatment but no shared native-control color scheme or focus treatment. Individual screens therefore make separate choices for text fields, selects, numeric steppers, checkboxes, borders, and focus states. Similar duplication appears in other common primitives, such as modal surfaces and repeated palette values.

Examples confirmed in the current renderer:

- The Jira Settings refresh-interval number field inherits the default native color scheme, while the Jira Mentions snooze number field and unit selector explicitly use a dark native scheme and green focus outline. This accounts for the visibly different number steppers.
- Directory picking and Jira Mentions search/reply controls set green focus treatments. Search fields in Settings, Session Browser, and Command Palette, plus several settings forms and inline rename fields, are styled independently; some suppress the browser outline without adding a keyboard-visible replacement. Other fields leave native focus styling in place, which can appear orange, or remain without a clear focus indicator.
- Some provider checkboxes set the app's green accent, while other settings checkboxes use the native default. Text fields also use different background, border, and text values across settings, provider forms, Jira settings, session search, and rename flows.
- The theme module contains reusable palette values, but many components still repeat literal colors. For example, provider form fields use values that differ from the theme's input, border, and text tokens, and the base stylesheet keeps a separate copy of some theme values. Directory Picker rebuilds modal colors and framing while other major overlays use the shared overlay styles. Feature styles either consume theme values or maintain their own conventions. The existing agent guidance covers selected overlay, button, and scrollbar conventions but does not define a complete shared-style contract or a checklist for new UI.
- Jira Mentions' editable fields and selectable issue text have no right-click editing menu. Other areas such as terminals and sidebar rows supply custom menus, but Electron does not provide context menus automatically, leaving basic text copy/paste inconsistent.

The audit covered renderer-owned app chrome, tab/sidebar/pane controls, overlays and pickers, settings sections and forms, Session Browser, Command Palette, and Jira Mentions. It looked for repeated colors and tokens, surfaces, borders, focus and interaction states, native controls, and scrollbar conventions. Findings, surface dispositions, implementation details, and computed-style/screenshot evidence are recorded in the adjacent plan. Live native popup actions remain explicitly UNVERIFIED on this host. The drift made the product feel inconsistent and gave developers no complete, durable standard to follow when adding UI.

## Goal

Align repeated renderer-owned UI patterns across the app with the existing dark theme and green accent, with particular attention to form controls and native focus/stepper appearance. Restore basic right-click text editing and copy support in Jira Mentions. Treat the app's current appearance as its default theme and establish a token contract that can support future themes without restyling each component. Establish clear, discoverable guidance that helps new features use the same style contract and makes future drift reviewable.

## Users & Context

App users move between settings, search, session, directory, sidebar, pane, and Jira surfaces and expect controls to behave and look like parts of one application. Developers add new settings and feature screens and need a concise source of truth for styling those controls and documenting justified exceptions.

## Requirements

1. The audit MUST review every renderer-owned surface family for drift in repeated visual patterns, including palette use, typography, spacing, radii, borders, shadows, buttons, form controls, focus and interaction states, overlays, badges, and scrollbars. The durable audit record MUST give each surface family a disposition: aligned, updated, or an intentional exception.
2. The implementation MUST align repeated shared UI patterns to the existing theme while preserving feature-specific page layouts and sizes unless those layouts directly conflict with a shared token or documented rule.
3. The app MUST define one consistent visual contract for renderer-owned text inputs, search/password fields, textareas, selects, numeric inputs and their steppers, checkboxes, and other form controls already used in the app.
4. Common UI patterns MUST use the existing dark palette and green accent consistently, including their idle, hover, selected, keyboard-focus-ring, disabled, and invalid states. Text-box focus rings MUST use the app's green accent; native defaults MUST NOT introduce an orange or otherwise unexplained contrasting ring, and styling MUST NOT remove a visible keyboard focus indicator.
5. Native controls that expose platform UI, including number steppers and select menus, MUST present a consistent dark appearance across app surfaces and supported app windows.
6. Shared colors and common visual treatments MUST have a documented source of truth. The current appearance MUST be represented as the default theme. Feature-specific layouts MAY adapt sizing and placement, but MUST use the documented semantic tokens or shared styles for common states; semantic status and validation colors MUST retain their meaning.
7. The audit MUST identify and align drifted patterns across the app, including app chrome, tab/sidebar/pane controls, overlays and pickers, settings, Session Browser, Command Palette, Jira Mentions, inline editors, and detached-window surfaces where those patterns appear.
8. The work MUST preserve existing labels, validation rules, keyboard behavior, persistence, and feature behavior except for the Jira Mentions text-menu actions in R13. Existing IPC contracts and behavior MUST remain unchanged.
9. The repository MUST gain a concise UI styling guide that defines the palette and shared visual contract, native-control expectations, focus and interaction states, scrollbar and overlay conventions, when feature-specific styling is appropriate, and a short checklist for adding or changing UI. The guide MUST be discoverable from the agent guardrails and the documentation index.
10. The verification record MUST cover the audited surface families with rendered/computed-style or screenshot evidence, including keyboard focus and numeric/select native appearance. Any intentional exception MUST be named and justified in the durable guidance.
11. The theme contract MUST account for every renderer-owned palette value found by the audit. Each value MUST be a theme-controlled semantic token or a named, justified theme-invariant exception. Renderer components MUST consume the shared theme contract so a future theme can provide a different token set at the renderer's theme boundary without component-specific palette edits. The work MUST NOT add theme selection, persistence, or a second theme; the existing appearance is the default.
12. In Jira Mentions, the issue description content MUST use the full available width of the detail content column, matching the horizontal fill of the reply composer and related mentions content. This width alignment MUST preserve wrapping, current vertical resizing, and narrow-layout containment.
13. Jira Mentions MUST provide a right-click text context menu for editable text controls and selected read-only text. Editable controls MUST offer the applicable standard editing actions, including copy and paste; selected read-only text MUST offer copy. Unavailable actions MUST be disabled or omitted, and the menu MUST preserve the native text selection and current keyboard editing behavior.
14. Every test command MUST be safe to run while the developer uses the same computer: tests MUST keep desktop windows hidden and unfocused, MUST NOT invoke browser-native JavaScript dialogs (`window.alert`, `window.confirm`, or `window.prompt`), activate native popups such as a select menu, launch external applications, or display native dialogs/menus, and MUST block network requests to non-loopback hosts. E2E tests MUST use isolated profiles, synthetic data, and loopback fixtures; attempted external actions MUST be recorded or asserted without performing them.

## Non-Goals

- We will NOT introduce a new brand palette or a broad visual redesign of pages.
- We will NOT change application behavior, validation, persistence, or existing IPC behavior beyond the Jira Mentions text-menu request in R13.
- We will NOT restyle text emitted inside terminal sessions or web content rendered by external sites; app-owned controls and chrome around those surfaces remain in scope.
- We will NOT introduce app-wide context menus for other text controls or change the existing terminal, sidebar, or other custom context menus.
- We will NOT change the semantic meaning of status, warning, error, or Jira workflow colors.
- We will NOT undertake a general accessibility redesign beyond keeping common controls' keyboard focus visible and their current accessible behavior intact.

## Scenarios (Acceptance Criteria)

- **S1 Given** the refresh-interval field in Jira Settings and the snooze-duration field in Jira Mentions, **When** both are rendered and focused, **Then** their fields, number steppers, focus indicators, and associated native select control follow the same documented dark control treatment.
- **S2 Given** a user navigates by keyboard among Settings, Session Browser, Command Palette, Directory Picker, Jira Mentions, and inline sidebar/pane rename fields, **When** focus moves between controls, **Then** every focused text box has a visible green focus ring and no surface falls back to an unexplained orange ring or suppresses focus feedback.
- **S3 Given** a new settings field, overlay, or feature surface is added, **When** its author follows the UI styling guide, **Then** its common colors, surfaces, controls, and interaction states match the app contract and any exception is documented.
- **S4 Given** a future theme supplies the shared semantic tokens at the renderer theme boundary, **When** a shared control or surface renders, **Then** it consumes those supplied values without changing component-specific styles; the existing appearance remains the default in this work.
- **S5 Given** the audit maps every renderer palette value to a semantic token or justified invariant, **When** a synthetic token set is installed at the root, **Then** representative surfaces from the audited families follow the changed values without component-specific palette edits, and every fixed color has a documented reason to remain invariant.
- **S6 Given** Jira Mentions shows an editable text field or reply composer, **When** the user right-clicks in it, **Then** a context menu offers the applicable copy, cut, paste, and select-all actions, with unavailable actions disabled or omitted, and text selection and keyboard editing continue to work.
- **S7 Given** Jira Mentions shows selectable read-only issue text, **When** the user selects text and right-clicks it, **Then** the context menu offers copy without editable-only actions.
- **S8 Given** an issue description and reply composer are both visible in Jira Mentions, **When** the detail column renders at desktop or narrow widths, **Then** the description fills the same available horizontal column as the reply composer without clipping or horizontal overflow, while its vertical resize behavior remains intact.
- **S9 Given** the main window and a detached window show the same renderer-owned control, **When** the control is viewed or focused in either window, **Then** it retains the same documented appearance and interaction states.
- **S10 Given** an invalid or disabled control and a control with a semantic warning/error state, **When** each state is shown, **Then** the control remains legible, uses the documented state treatment, and retains the existing validation or status meaning.
- **S11 Given** the style-alignment work is complete, **When** the reviewed surface inventory is compared with the documentation, **Then** every identified drift has a recorded disposition and every audited surface family has rendered or computed-style evidence.
- **S12 Given** any test suite is run while the developer uses the computer for other work, **When** the suite creates an Electron window, exercises an external/native action, or requests network access, **Then** windows remain hidden and unfocused, no browser-native JavaScript dialog or native select popup is invoked, OS-facing actions are suppressed or represented by a safe assertion, non-loopback requests are blocked, and local fixture traffic continues to work.

## Open Questions

None outstanding.

## Resolved Decisions

- The audit and alignment scope is all renderer-owned app UI, as requested, including controls in detached windows. Terminal session output and external website content are outside the shared UI styling contract.
- Use the existing dark palette and green accent as the baseline; the request is to align existing UI, not create a new visual theme.
- Treat the complete current renderer appearance as the default theme. Build a replaceable semantic token boundary for future theme values, but do not add theme selection, persistence, or an alternate built-in theme.
- In Jira Mentions, the description body should fill the available detail content column to match the reply composer; preserve its current vertical resize and responsive behavior.
- Restore standard text context-menu actions in Jira Mentions only; keep other app context-menu behavior out of this change. This scope was resolved by the auto-orchestrator blind subagent because the reported gap is specific to Mentions and the contract does not establish a shared app-wide text-menu defect.
- "Textbox highlight" means the focus ring around the text box. It MUST use the app's green accent consistently.
- The audit covers every renderer surface family, while implementation aligns recurring shared patterns and preserves feature-specific layout and sizing.
- Test execution is a desktop-safety contract for every test command. Electron E2E may drive hidden renderer windows, but must not surface windows, invoke external applications, show native dialogs/menus, or contact non-loopback hosts.

## Out-of-Scope Notes

- A later design-system effort could address broader typography, spacing, animation, and component-library consistency beyond the directly audited styles and controls.
