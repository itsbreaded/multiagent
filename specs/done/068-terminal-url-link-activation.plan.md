# Implementation Plan: Reliable terminal URL links

Plan Status: completed
Source spec: `specs/done/068-terminal-url-link-activation.md` (Status: done)

## Verified Repository Facts

- `src/renderer/src/components/Terminal/index.tsx` creates every shell and
  agent xterm instance. It uses xterm's OSC-8 `linkHandler` plus one
  application-owned implicit HTTP(S) link provider; both callbacks invoke
  `shell:open-external`.
- xterm's linkifier determines activation on mouse-up and passes the browser
  `MouseEvent` into the callback. The current app callbacks ignore that event,
  so they do not enforce primary-button activation.
- xterm's `IBufferLine.isWrapped` records natural terminal wrapping, but an
  agent/TUI that uses absolute cursor positioning produces adjacent rows with
  `isWrapped === false`. The application provider records public CSI H/f
  row-start evidence to cover this display shape.
- `Terminal.registerLinkProvider` is part of the installed xterm public API and
  provides the sole application-owned implicit HTTP(S) link provider.
- `src/main/external.ts` is the existing validated external boundary. It accepts
  only `http:`, `https:`, and `mailto:` and must remain unchanged.
- PTY output is deliberately direct and synchronous through
  `src/renderer/src/terminal/ptyData.ts`; the link fix must operate on the
  rendered xterm buffer and must not add output coalescing, acknowledgements, or
  flow control.
- Renderer tests use Vitest + happy-dom. Pure terminal utilities can be tested
  without mocking Zustand or importing Electron.

## Scope and Coverage

| Requirement/scenario | Planned task(s) | Verification |
| --- | --- | --- |
| R1, natural-wrap scenario | T1 | Pure buffer-link test joins `isWrapped` rows and returns the full target/range |
| R2, cursor-positioned scenario | T1, T2 | Pure positioned-row fixtures plus provider wiring test path |
| R3, boundary/non-merge scenario | T1 | Whitespace, blank, non-edge, and ambiguous-row fixtures return separate/no link |
| R4, implicit + OSC-8 links | T1, T2 | Provider activation test and OSC-8 handler callback test |
| R5–R6, left-only/context menu | T2 | Button matrix asserts only `button === 0` invokes IPC; no event suppression is added |
| R7, existing external validation | T2, T3 | `src/main/external.test.ts`; existing `shell:open-external` route remains unchanged |
| R8, deterministic regression coverage | T1, T2, T3 | Focused Vitest tests, full unit suite, and focused Playwright Electron test |
| Non-goals and scope decisions | T2 | No PTY/main URL-policy/terminal-size changes; runtime test records context-menu behavior |

## Architecture and Data Flow

Terminal output remains:

`pty:data` → synchronous `xterm.write` → xterm buffer/link provider →
`window.ipc.invoke('shell:open-external', url)` → existing main-process URL
validation.

The renderer will own the sole application link provider for automatically
detected HTTP(S) URLs. It will reconstruct a bounded display run
around the requested buffer row:

- naturally wrapped rows are joined through `isWrapped`;
- cursor-positioned rows are joined only when the renderer has observed the
  corresponding CSI cursor-position sequence targeting the row start, the
  preceding row reaches the terminal edge, the next row begins at column one
  without whitespace, and no blank/non-contiguous/ambiguous boundary occurs;
- candidate text is capped at the same 2048-character scale used by the current
  addon, and URL offsets are mapped back to 1-based xterm buffer ranges;
- a link range can span rows, so hovering/clicking any segment uses the one
  complete target.

The custom provider fully replaces the existing `WebLinksAddon` path and
returns the complete link for every row it can prove is part of a natural-wrap
or cursor-positioned run. Removing the addon is required so an ambiguous row
cannot fall through to a partial third-party match. One shared
`isPrimaryLinkActivation` guard is used by both implicit-link and OSC-8
callbacks. The guard returns without preventing the browser's normal
context-menu event for every button other than zero.

## Implementation Tasks

### T1 - Add a tested display-aware terminal link provider (completed)

- Dependencies: ready spec; no source changes required first.
- Requirements/scenarios: R1–R3, R8; natural-wrap, cursor-positioned, and
  boundary/non-merge scenarios.
- Files and symbols:
  - Add `src/renderer/src/terminal/links.ts` with the HTTP(S) URL pattern,
    display-run reconstruction, xterm range mapping, link-provider factory,
    and a bounded cursor-position continuity tracker.
  - Add `src/renderer/src/terminal/links.test.ts` with fake buffer-line/terminal
    fixtures and deterministic link-range/target assertions.
- Current behavior: the installed addon reconstructs only rows marked
  `isWrapped`, so cursor-positioned rows can produce a partial match; there is
  no application-owned reconstruction seam.
- Implementation change: expose a provider that scans only the bounded buffer
  neighborhood needed for the hovered row, joins natural-wrap rows and
  cursor-positioned rows only when the continuity tracker has observed a
  row-start CSI sequence, detects the complete HTTP(S) target, and returns one
  `ILink` with a range covering every segment. Preserve the addon's URL
  punctuation/security matching semantics; do not add mailto or custom
  protocols to automatic detection.
- The continuity tracker must be fed from xterm's public parser API for CSI
  cursor-position sequences (`H`/`f`) and map the 1-based viewport row to the
  active buffer row using the current viewport offset. It must mark only
  column-one row starts, remain bounded, and clear stale evidence on terminal
  resize/reset/clear as applicable. It must not consume or rewrite the CSI
  sequence; xterm remains responsible for normal terminal behavior.
- Invariants and edge cases:
  - URL text is ASCII/width-one for mapping purposes; use xterm cell width when
    translating offsets so wide glyphs before a URL do not shift its range.
  - Trim terminal padding only for matching; never include trailing punctuation
    or whitespace that the current URL matcher excludes.
  - Do not join rows containing whitespace, blanks, non-edge predecessors, or an
    ambiguous continuation; require a URL punctuation cue at a cursor-row
    boundary and fail closed rather than manufacture a URL.
  - Keep the 2048-character bound so a hover cannot scan the full 250,000-line
    scrollback buffer.
- Cursor-positioned rows without observed row-start evidence are ambiguous and
  must not be joined merely because they happen to be adjacent and full-width.
- Verification:
  - Natural-wrap fixture: a URL split over `isWrapped` rows returns one complete
    target and a range spanning those rows.
  - Cursor-position fixture: full-width non-wrapped rows starting at column one
    with recorded CSI row-start evidence return one complete target from every
    participating row; the same fixture without evidence does not join.
  - Boundary fixtures: whitespace, blank row, non-edge row, and ambiguous row
    do not concatenate unrelated text.
  - Include URLs ending in common punctuation/query delimiters and a near-limit
    long URL to guard the matcher and bound.
- Completion evidence: `src/renderer/src/terminal/links.test.ts` covers natural
  wrapping, CSI-marked cursor rows, ambiguous boundaries, edge/scan-limit
  fail-closed behavior, and the provider type-checks against xterm 6.

### T2 - Wire the provider and enforce primary-button activation (completed)

- Dependencies: T1 provider and tests.
- Requirements/scenarios: R4–R8; implicit-link left/right/middle-click and
  explicit OSC-8 scenarios.
- Files and symbols:
  - Update `src/renderer/src/components/Terminal/index.tsx` in `createXterm`.
  - Extend `src/renderer/src/terminal/links.test.ts` (or add a focused sibling
    test) for the shared activation callback/button matrix.
  - Remove the now-unused `@xterm/addon-web-links` import, package dependency,
    and lockfile entry. The application provider is the sole implicit HTTP(S)
    provider, so fail-closed ambiguity cannot fall through to a partial match.
- Current behavior: both callback paths invoke IPC for any mouse button, and
  the third-party implicit provider only understands natural wrapping.
- Implementation change: create one per-xterm bounded continuity tracker,
  register its display-aware provider before xterm is opened, route its
  activation through the existing IPC channel, and guard both that activation
  and `xterm.options.linkHandler.activate` with
  `event.button === 0`. Do not call `preventDefault` or stop propagation for
  non-left buttons so the existing xterm/right-click context-menu path survives.
- Invariants and edge cases:
  - A left click invokes the external-open IPC path once with the full target.
  - Right, middle, and auxiliary mouse releases invoke it zero times.
  - OSC-8 links retain their existing target and only gain the button filter.
  - `src/main/external.ts` and the `shell:open-external` IPC signature remain
    unchanged; malformed/non-http(s) targets still fail at the existing main
    boundary.
  - Registry remounts must not register duplicate providers on the same xterm;
    provider/parser registration belongs in the one-time xterm creation path.
- Verification:
  - Unit-test the activation callback with button values 0, 1, 2, and an
    auxiliary value; assert only zero forwards the URL.
  - Assert the xterm instance registers exactly the application provider and
    that its natural-wrap and cursor-positioned callbacks return the complete
    target; no addon provider is loaded.
  - Run renderer tests and typecheck.
  - Manual Electron smoke check: display a long URL in a shell and agent pane,
    click a middle segment to confirm the complete URL opens, then right-click
    it to confirm no browser opens and the terminal context menu remains.
- Completion evidence: `Terminal` uses one guarded activation path for both link
  types, the third-party addon is removed, no provider/parser is duplicated
  after remount, and the focused Electron URL test passes.

### T3 - Add focused regression tests for the existing external boundary (completed)

- Dependencies: none; may run in parallel with T1.
- Requirements/scenarios: R7–R8; malformed/non-http(s) scenario.
- Files and symbols:
  - Add `src/main/external.test.ts` around `openExternalUrl`.
  - Mock only Electron's `shell.openExternal` and assert its calls.
- Current behavior: `openExternalUrl` parses the URL, allows only `http:`,
  `https:`, and `mailto:`, and silently rejects malformed or unsupported URLs.
- Implementation change: no production change; characterize the existing
  security boundary so the terminal-link fix cannot accidentally broaden it.
- Verification: assert allowed protocols reach `shell.openExternal`, while
  malformed, `file:`, `data:`, and `javascript:` values do not.
- Completion evidence: `src/main/external.test.ts` passes with the unchanged
  `src/main/external.ts` implementation.

## Cross-Cutting Constraints

- Preserve the PTY guardrails in `AGENTS.md` and `docs/pty-and-terminals.md`:
  no output rewriting, flow control, scrollback reduction, or resize behavior
  changes.
- Keep automatic detection limited to HTTP(S), and leave main-process protocol
  validation as the security boundary.
- Keep link scanning bounded and synchronous enough for xterm hover events; do
  not scan the full scrollback or perform IPC while reconstructing candidates.
- Scope remains all shell and agent terminal panes through their shared
  `Terminal` component.
- Do not add UI, settings, modifier-key requirements, or alternate URL actions.

## Risks, Migration, and Rollback

- **Ambiguous row provenance:** xterm does not expose whether a non-wrapped row
  came from newline or cursor positioning. The public CSI parser hook supplies
  the missing row-start evidence; rows without that evidence fail closed. A
  future TUI-specific protocol can be added separately if needed.
- **Provider replacement:** the third-party addon is removed rather than kept
  as a fallback, because fallback behavior would violate the fail-closed rule
  for ambiguous cursor-positioned rows. The app provider's natural-wrap tests
  are therefore load-bearing.
- **Mapping/resize:** xterm ranges are buffer coordinates and can become stale
  after resize. The provider recomputes on each request; no cached ranges or
  persisted state are introduced.
- **Rollback:** revert the renderer provider/wiring and its tests (and package
  dependency edit, if any). No layout, settings, transcript, PTY, or user-agent
  configuration migration is required.

## Handoff Checklist

- [x] Implementer confirms the custom provider is the sole implicit-link
      provider and cannot be bypassed by a partial third-party match.
- [x] CSI row-start tracking is bounded, non-consuming, reset-safe, and covered
      by a parser/provider integration fixture.
- [x] Tests cover natural wrapping, cursor-positioned edge continuity,
      ambiguous/non-merge boundaries, full target mapping, and button filtering.
- [x] Non-left activation does not suppress the existing context-menu event.
- [x] `shell:open-external` and main URL validation are unchanged.
- [x] `npm run test -- src/renderer/src/terminal/links.test.ts src/main/external.test.ts`,
      `npm run typecheck`, and `npm run build` results are recorded below.
- [x] Focused Electron context-menu/left-click regression result is recorded
      below; the broader E2E suite retains an unrelated browser-MCP failure.

## Plan Review

Completed by independent blind reviewer: APPROVED. The reviewer confirmed the
CSI H/f continuity signal is viable through xterm's supported parser API, the
application provider is the sole implicit HTTP(S) provider so ambiguous cases
truly fail closed, provider registration/coverage assertions are load-bearing,
  and external-boundary tests cover malformed/unsupported protocols. Non-blocking
  follow-up: keep tracker coordinates correct across normal-buffer scrolling and
  origin-mode/scroll-region positioning; this iteration's evidence is scoped to
  absolute viewport H/f sequences. The focused Electron left/right-click test
  below supplies the runtime behavior evidence.

## Implementation Summary

Implemented the display-aware provider in
`src/renderer/src/terminal/links.ts`, wired it as the sole implicit HTTP(S)
provider for every shared terminal, and routed both implicit and OSC-8
activation through the primary-button guard. The old web-links addon and its
dependency were removed. Deterministic unit tests, external-boundary tests,
and a focused Electron regression test cover the requested behavior. The
implementation remains bounded and does not alter PTY output, flow control,
resize behavior, or main-process URL validation.

## Verification Evidence

- R1/R2/R3: `src/renderer/src/terminal/links.test.ts` passed natural-wrap,
  CSI-marked cursor-row, parser-to-provider cursor reconstruction,
  ambiguous/no-cue boundary, and scan-limit cases; the provider maps one complete
  target across all participating rows and fails closed without row-start
  evidence.
- R4/R5/R6: the same test file passed the shared OSC-8/implicit activation
  button matrix; only `button === 0` forwards, with no `preventDefault` or
  propagation suppression. A real xterm OSC-8 provider fixture confirms the
  configured `linkHandler.activate` reaches the same guarded callback. The
  focused Electron test also observed the terminal context menu after an
  automatic-link right click.
- R7: `src/main/external.test.ts` passed allowed `http:`, `https:`, and
  `mailto:` cases and rejected malformed, `file:`, `data:`, and `javascript:`
  values. `src/main/external.ts` is unchanged.
- R8: `npm run test -- src/renderer/src/terminal/links.test.ts src/main/external.test.ts`
  passed (2 files, 12 tests); `npm run test` passed (77 files, 831 tests).
- Acceptance scenarios: natural-wrap complete target, cursor-positioned complete
  target, boundary fail-closed behavior, automatic-link right click, shared
  OSC-8 right/middle/left button filtering, and malformed/non-HTTP validation
  PASS via the focused Vitest cases, parser/provider integration fixture,
  the real xterm OSC-8 provider fixture, `src/main/external.test.ts`, and the
  focused Electron test. The Electron test directly observed the automatic-link
  right-click context menu and exact left-click IPC target. No separate
  Electron layout hit-test is claimed for OSC-8; the provider-level fixture is
  the deterministic runtime-equivalent evidence.
- Non-goals: PASS by source inspection and unchanged diffs; no PTY output,
  agent CLI rendering, terminal sizing, flow control, protocol allow-list,
  browser-panel, copy/edit, modifier-key, or settings behavior was added.
- Resolved decisions/dependencies: PASS; the shared `Terminal` component is
  the only wiring point, xterm 6's public link/parser APIs are available, the
  existing `shell:open-external` signature is preserved, and the existing
  main-process URL allow-list remains the boundary. No open questions remain.
- Mechanical checks: `npm run typecheck`, `npm run build`, and `git diff --check`
  passed.
- User-visible Electron check: `npx playwright test e2e/startup.spec.ts -g
  "opens a complete wrapped URL only on a left click"` passed (1 test). It
  observed zero external-open invokes for right click and one exact complete
  URL for left click.
- Broader E2E limit: `npm run test:e2e` built successfully and ran 28 tests;
  27 passed, while one unrelated browser-MCP manager race failed and worker
  teardown timed out. This suite failure is retained as explicit
  evidence, not claimed as a green global check.
- Verification repair: the blind review identified a false-positive
  cursor-row merge at an unrelated boundary. The provider now requires a URL
  punctuation cue for cursor-row joins, `links.test.ts` covers both a host and
  plain-text false positive, and the focused plus full unit suites were rerun
  successfully (12 and 831 tests respectively).
- Runtime limit: the focused Electron test exercised a shell pane; the shared
  `Terminal` component covers agent panes, but no separate manual agent-pane
  smoke observation was made.
- Independent verification note: the final blind delegation had not returned
  at handoff; the earlier independent review's boundary finding was repaired,
  then covered by the no-cue false-positive tests and the final 12-test focused
  run. The recorded plan review remains independently APPROVED.
- No unresolved open questions remain. The tracker evidence is scoped to
  absolute viewport CSI H/f row starts; origin-mode/scroll-region-specific
  provenance is outside this iteration's stated display contract.
