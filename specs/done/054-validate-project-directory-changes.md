# Spec: Validate Project Directory Changes

Status: done
Created: 2026-07-27
Completed: 2026-07-27

## Problem

The **Change project directory** form accepts any non-empty manually typed value.
Unlike a value selected through Browse, it is not checked to ensure it identifies an
accessible directory before becoming the tab's project default. A typo, a pasted shell
quoted path, or a path to a file can therefore be saved and cause later sessions or
shells to start with an invalid working directory.

## Goal

Make manually entered project directories safe to use: clean routine pasted-path
formatting, validate the resulting value before applying it, and keep the form open
with an actionable error when it cannot be used.

## Users & Context

Users change a tab's default project directory from a context menu, the sidebar, or
the command palette. They may paste an absolute path copied from a shell, file
explorer, or documentation rather than select it with Browse.

## Requirements

1. Every entry point for **Change project directory** MUST apply the same validation
   contract before changing the tab's default project directory.
2. The form MUST normalize routine paste formatting before validation and use the
   cleaned directory when the change succeeds. This means trimming surrounding
   whitespace, then removing one matching pair of surrounding single or double quotes,
   and trimming the result again.
3. When the user clicks **Change** or submits with the keyboard, the form MUST verify
   that the cleaned value is an absolute path that exists and identifies a directory
   before changing the tab's default project directory.
4. Validation MUST be authoritative in the desktop application's privileged process,
   so a renderer-side caller cannot persist an unchecked directory value.
5. If the input is empty after cleanup, is relative, does not exist, identifies something
   other than a directory, or cannot be inspected, the form MUST remain open, MUST leave the
   existing project directory unchanged, and MUST show a clear error explaining that a
   usable directory is required.
6. While validation is in progress, the form MUST prevent duplicate confirmation
   submissions and provide feedback that the check is underway.
7. A successful change MUST store and display the validated normalized absolute
   directory value rather than the raw pasted text. The directory must be added to
   recent directories only after validation succeeds.
8. Directory paths returned from Browse MUST continue to work without an unnecessary
   user-visible error.

## Non-Goals

- We will NOT create missing directories.
- We will NOT infer, expand, or execute shell syntax such as environment variables,
  home-directory shorthand, commands, or command-line flags.
- We will NOT repair existing tabs that already contain an invalid saved directory.
- We will NOT change the session-directory repair workflow in this spec.
- We will NOT change the validation behavior of one-off shell or agent starts, or of
  other directory-picker forms.

## Scenarios (Acceptance Criteria)

- **Given** a user pastes `  "C:\\Code\\multiagent"  ` for an existing directory,
  **When** they choose Change, **Then** the outer whitespace and quotes are removed,
  the directory is validated, and the tab uses the validated directory.
- **Given** a user enters a path that does not exist, **When** they choose Change,
  **Then** the form stays open, names the problem, and the tab retains its prior project
  directory.
- **Given** a user enters only whitespace or matching empty quotes, **When** they choose
  Change, **Then** the form requires a directory and makes no tab change.
- **Given** a user enters an existing file path, **When** they choose Change, **Then**
  the form rejects it with a directory-specific error and makes no tab change.
- **Given** a user enters a relative path, **When** they choose Change, **Then** the
  form explains that an absolute directory path is required and makes no tab change.
- **Given** directory inspection fails because it cannot be read, **When** the user
  chooses Change, **Then** the form presents an inspection/access error and makes no
  tab change.
- **Given** validation is pending, **When** the user presses Enter or Change again,
  **Then** only one validation request is made and no duplicate tab update occurs.
- **Given** the user chooses an existing directory through Browse, **When** they choose
  Change, **Then** the change succeeds and the validated directory is recorded as a
  recent directory.
- **Given** the user opens **Change project directory** from any supported entry point,
  **When** they submit the same invalid path, **Then** it is rejected consistently and
  no entry point updates the tab.

## Open Questions

None outstanding.

## Resolved Decisions

- Matching outer single or double quotes are treated as paste formatting, not as part
  of a directory name. No other shell-language expansion is performed.
- This iteration applies only to **Change project directory**. The shared picker also
  serves session repair and one-off starts, whose validation needs differ and should be
  considered separately.
- Relative paths are rejected. A persisted project default must be unambiguous across
  application launches and follows the existing absolute-path convention.

## Out-of-Scope Notes

- A later UX improvement could offer a distinct action to create a new project
  directory when a typed path is absent.
