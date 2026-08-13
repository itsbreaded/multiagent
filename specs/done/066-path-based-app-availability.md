# Spec: Reliable PATH-Based Application Availability

Status: done
Created: 2026-08-12
Completed: 2026-08-12

## Problem

MultiAgent gates the visible “Open in VS Code” action on a startup command
probe that runs `code --version` and waits for the process to exit. Some CLI
launchers return their answer promptly but take much longer to terminate. The
probe therefore times out, converts a successful command into `false`, and
hides an action that is known to work through the `vscode://` protocol.

The application also needs a consistent way to determine whether future
PATH-based applications are available. Availability is currently being
confused with successful completion of an application-specific health check.

## Goal

PATH-based application availability is determined by resolving the requested
command in the environment inherited by MultiAgent, without launching the
application or waiting for an application-specific process to exit. VS Code's
availability gate no longer produces false negatives when its CLI launcher is
slow to terminate, and the same resolution behavior is reusable for future
PATH-based launch targets.

## Users & Context

Developers who launch MultiAgent from a desktop shortcut, Start Menu, terminal,
or another host environment, and use actions that open projects in installed
developer applications. The relevant PATH is the one inherited by MultiAgent,
because that is also the environment available to app-launched processes.

## Requirements

1. MultiAgent MUST determine availability for a PATH-based launch target by
   resolving its command name against the main process's inherited PATH and,
   on Windows, the inherited PATHEXT rules.
2. Resolution MUST return the first matching regular file according to the
   platform's PATH precedence, or an unavailable result when no match exists.
   Directories, missing files, and inaccessible entries MUST NOT count as
   matches.
3. Availability detection MUST NOT launch the target application, execute a
   version or health command, inspect file contents, or recursively scan the
   filesystem.
4. Availability detection MUST be asynchronous and MUST NOT block main-process
   startup or other IPC handlers while PATH entries are checked.
5. The availability result for VS Code MUST be based on resolving its PATH
   command rather than waiting for `code --version` to exit. The existing
   VS Code project-opening action MUST continue to use its current URI-based
   launch behavior.
6. The resolution behavior MUST be reusable by future PATH-based launch
   targets without duplicating platform-specific PATH or extension logic.
7. A target that is unavailable MUST remain unavailable to the caller, and a
   failed or timed-out application-specific health check MUST NOT be used to
   overwrite a successful PATH resolution.
8. Resolution MUST use the PATH and PATHEXT visible to MultiAgent at launch;
   it MUST NOT rewrite PATH, source shell profiles, or silently search unrelated
   installation directories.
9. Existing agent-provider availability behavior MUST remain unchanged except
   for sharing the reusable resolution behavior. Existing running or restored
   panes MUST NOT be affected by availability detection.

## Non-Goals

- We will NOT install, update, authenticate, configure, or repair VS Code or
  any other application.
- We will NOT change the `vscode://` project-opening protocol or add a new
  launch-error dialog in this iteration.
- We will NOT add periodic PATH polling, shell-profile loading, or automatic
  environment refresh while the app is running.
- We will NOT run application-specific health checks as part of ordinary
  availability detection.
- We will NOT add a registry- or fixed-installation-directory search for
  applications that are absent from the inherited PATH.
- We will NOT change which providers or applications the product supports.

## Scenarios (Acceptance Criteria)

- **Given** `code.cmd` is a regular file in a directory on MultiAgent's
  inherited Windows PATH, **when** startup availability is evaluated, **then**
  VS Code is reported available without starting `Code.exe`.

- **Given** `code --version` writes a valid version quickly but its process takes
  longer than the former probe timeout to exit, **when** startup availability is
  evaluated, **then** VS Code is still reported available.

- **Given** no PATH directory contains a matching command file, **when** the
  target is resolved, **then** it is reported unavailable and no application
  process is started.

- **Given** a PATH entry contains a directory named like the requested command
  but no regular file, **when** the target is resolved, **then** it is reported
  unavailable.

- **Given** multiple PATH directories contain the same command, **when** the
  target is resolved, **then** the first matching directory and platform-valid
  extension win.

- **Given** Windows PATHEXT contains the applicable command extension, **when**
  a matching `.cmd`, `.bat`, or executable file is present, **then** the target
  can be resolved without requiring an extension in the configured command
  name.

- **Given** the PATH contains many entries, **when** availability checks run,
  **then** the main process remains responsive and the checks complete through
  asynchronous filesystem operations.

- **Given** a future PATH-based launch target uses the shared availability
  mechanism, **when** its command is present or absent on PATH, **then** it
  receives the same resolved-path or unavailable result without implementing
  its own PATH/PATHEXT scan.

- **Given** a provider CLI is present or absent on PATH, **when** provider
  availability is evaluated, **then** its existing detected/undetected behavior
  remains the same as specified by `provider-cli-availability`.

- **Given** a running or restored agent pane belongs to a provider whose CLI is
  not currently resolvable, **when** availability is evaluated, **then** the
  existing pane remains intact.

## Open Questions

None outstanding.

## Resolved Decisions

- Availability means “resolvable as a launch target on the app's inherited
  PATH,” not “the target passes an application-specific health check.” This
  avoids treating slow process teardown as absence.
- The shared mechanism returns a resolved path as well as availability so
  future launchers can use the same resolution result. The VS Code action
  continues to use the existing URI path in this iteration.
- Windows resolution follows the inherited PATHEXT order rather than a new
  hardcoded list. This matches the platform's command lookup model; Microsoft
  documents PATH/PATHEXT lookup in its [`where`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/where)
  and [`PATH`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/path)
  documentation.
- The resolver is a capability check only. Launching a resolved command and
  reporting a launch failure remain separate behavior for future work.

## Out-of-Scope Notes

- A future iteration may add explicit “refresh application availability” UI.
- A future iteration may detect GUI-only applications through protocol or
  registry registration when they are intentionally not on PATH.
- A future diagnostics view may report the resolved path and distinguish
  missing, inaccessible, and launch-failed states.
