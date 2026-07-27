# Implementation Plan: Validate Project Directory Changes

## Tasks

1. **completed** — Requirements 2–5, 7; scenarios for quoted, empty, relative,
   missing, file, and inspection-failure input. Add a main-process directory-input
   validation contract that cleans, validates, and returns the normalized absolute
   directory without mutating tab state. Verify with focused unit tests.
2. **completed** — Requirements 1, 4, 6–8; scenarios for each change-project entry
   point, duplicate submission, and Browse. Add the opt-in validation interaction to
   the directory form and use it at every Change project directory entry point. Verify
   with focused component tests and typecheck.
3. **completed** — Requirements 1–8. Run the required repository-wide checks and Electron
   smoke test, update this plan with evidence, and prepare the spec for review.

## Implementation Summary

- Covered requirements 1–8 with a privileged directory-validation contract and opt-in
  form behavior at every Change project directory entry point. Validation cleans quoted
  input, rejects invalid paths without changing the tab, prevents duplicate submission,
  and records recents only after success.
- Added focused tests for cleaning, absolute/directory/access failures, successful
  confirmation, invalid confirmation, empty quoted input, and duplicate submission.
- Checks passed: `npx vitest run src/main/directoryValidation.test.ts
  src/renderer/src/components/DirPicker/index.test.tsx` (12 tests), `npm run typecheck`,
  `npm run build`, `npm run test` (691 tests), and `npm run test:e2e` (19 tests).

## Verification Evidence

- **Requirements 1–3, 5–8 — PASS:** the focused validation and picker tests cover
  cleaned quotes, empty input, relative input, missing paths, file paths, inspection
  failure, pending duplicate submission, success, and Browse-to-confirm behavior.
- **Requirement 4 — PASS after repair:** the main-process layout persistence path now
  validates and normalizes every tab default, omitting unchecked values before writing
  the layout. `layoutStore.test.ts` proves valid defaults are normalized and invalid
  defaults are not persisted.
- **All acceptance scenarios — PASS:** focused tests and code-path inspection confirm
  every Change project directory entry point opts into the same contract; the
  independent review confirmed this mapping.
- **Non-goals and decisions — PASS:** validation remains opt-in for Change project
  directory, so repair and one-off picker workflows retain their existing behavior; no
  directories are created and no shell syntax is expanded.
- **Independent review — PASS:** a blind requirements pass initially found the
  persistence and Browse gaps; both were repaired and independently rechecked as pass.
- **Mechanical checks — PASS:** `npx vitest run src/main/directoryValidation.test.ts
  src/main/ipc/layoutStore.test.ts src/renderer/src/components/DirPicker/index.test.tsx`
  (21 tests), `npm run typecheck`, `npm run build`, `npm run test` (694 tests), and
  `npm run test:e2e` (19 tests).
- **Inspection — PASS:** no debug code, commented-out workaround, or spec-related TODO
  remains in the changed implementation paths.
