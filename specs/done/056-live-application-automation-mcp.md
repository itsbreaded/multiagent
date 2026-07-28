# Spec: Live Application Automation MCP

Status: done
Created: 2026-07-27
Completed: 2026-07-27

## Problem

MultiAgent already gives app-launched agents a built-in browser MCP server, but
that server controls a separate web browser rather than the running MultiAgent
application. Developing or validating a UI change therefore requires a person
to operate the application manually or to write a purpose-built automated
test. Adding an MCP tool for each UI feature would create a second, incomplete
and costly-to-maintain application API.

## Goal

Provide an opt-in built-in MCP server through which an AI agent can observe
and operate the live MultiAgent application using broad UI-automation
primitives. It must work in both development and packaged installations so
that the application's developer audience can use it during ordinary work.

## Users & Context

Developers using MultiAgent to build or refine its UI, or to have an
app-launched Claude, Codex, or OpenCode session inspect and validate the live
application. They may run an installed MultiAgent instance while an agent
starts a second development instance with `npm run dev`; either instance may
need to identify and control itself or the other instance. They enable the
capability when they intend to grant an agent control over a local application
window.

## Requirements

1. MUST provide a separately identifiable built-in MCP server for live
   MultiAgent application automation, distinct from the existing external-web
   browser MCP server.
2. MUST keep the application-automation server disabled by default and let a
   user explicitly enable or disable it in application settings. The setting
   MUST persist across relaunches. Supplying the documented launch-time
   automation-port variable is also an explicit, non-persistent opt-in for
   that launched instance.
3. MUST make the server available in development and packaged installations;
   enabling it MUST NOT depend on a debug-only launch mode.
4. MUST inject the server, when enabled, into newly launched supported agent
   sessions using the same process-scoped configuration model as other built-in
   MCP servers. Enabling or disabling it MUST NOT modify global or project
   agent configuration and MUST NOT alter existing agent sessions. For an
   app-launched session, the injected server MUST target that same running
   MultiAgent instance by default, without a separate connection or discovery
   step.
5. MUST support a local MCP client that was not launched by MultiAgent, so a
   developer can connect an independently started AI session to an enabled
   running application instance.
6. MUST recognize `MULTIAGENT_UI_AUTOMATION_PORT` as the documented
   launch-time contract through which a process launching MultiAgent requests
   a specific local automation port for that application instance. A valid
   supplied port MUST be used for that instance; a missing, invalid, or
   unavailable requested port MUST leave the server unavailable and report a
   clear status or startup error rather than silently selecting another port.
7. MUST let a local automation client attach an enabled target instance by its
   explicit local automation endpoint, including itself, and receive a stable
   target identity for later interaction. An agent that starts an instance
   through `npm run dev` with the requested port MUST be able to use that
   known endpoint to attach the new instance without instance discovery.
8. MUST support simultaneous control of the host instance and one or more
   attached external instances. Every window enumeration, observation, and
   interaction after attachment MUST be scoped to an explicit target identity;
   it MUST NOT depend on a mutable, global "selected application" state.
   Window identities MUST be scoped to their target instance. Operations for
   one target MUST NOT block or invalidate other attached targets; operations
   addressed to the same window MUST execute in their arrival order at the
   automation endpoint.
9. MUST expose broad, feature-independent primitives sufficient for an agent
   to: enumerate and select application windows; inspect the selected UI;
   perform pointer, keyboard, text-entry, scrolling, and drag interactions;
   wait for UI state; capture screenshots; and inspect renderer console and
   network diagnostics.
10. MUST allow agents to operate the primary application window and any
   application-owned detached windows. The agent MUST be able to identify the
   target window well enough to avoid relying on window ordering.
11. MUST preserve the existing browser MCP server and its behavior. An agent
   must be able to distinguish whether a tool controls an external browser or
   the MultiAgent application.
12. MUST expose a clear settings status for the server, including whether it is
   enabled, running, available to new sessions, and the local endpoint used
   by the current instance.
13. MUST limit the automation connection and cross-instance discovery to the
   local machine. It MUST NOT
   listen on a non-loopback network interface or create remote access to the
   user's application by default.
14. MUST describe the capability as granting an agent broad control over the
    visible MultiAgent UI, including the ability to activate ordinary app
    controls and enter text. The opt-in control and status must make that
    consequence clear before use.
15. SHOULD support the same resilient, semantic UI targeting practices used by
    the existing Playwright Electron tests so normal application evolution does
    not require new domain-specific MCP tools.

## Non-Goals

- We will NOT create a dedicated MCP tool for each MultiAgent feature or
  command.
- We will NOT replace the existing browser MCP server or make it control the
  MultiAgent UI.
- We will NOT expose the automation server to remote hosts, cloud services, or
  other machines by default.
- We will NOT change or persist the user's global or project Claude, Codex, or
  OpenCode configuration.
- We will NOT guarantee that an agent can safely complete every destructive
  app workflow without the same user-visible consequences as manual use.

## Scenarios (Acceptance Criteria)

- **Given** a fresh installation or a user who has not enabled live
  application automation, **when** they launch MultiAgent and create an agent
  session, **then** no application-automation MCP server is injected and the
  settings surface shows it as disabled.
- **Given** a user enables or disables live application automation in
  settings, **when** they relaunch MultiAgent, **then** the same enabled state
  is restored.
- **Given** a user enables live application automation, **when** they start a
  new supported agent session, **then** that session receives the application
  automation MCP server without changes to its global or project MCP config.
- **Given** an agent session launched inside an enabled MultiAgent instance,
  **when** it calls an application-automation tool without selecting another
  target, **then** the action observes or operates the same MultiAgent
  instance that launched the session.
- **Given** an enabled installed MultiAgent instance and an independently
  launched local MCP client, **when** that client connects through the
  instance's supported local endpoint, **then** it can select and control the
  installed instance.
- **Given** an enabled installed MultiAgent instance and an agent that starts
  a second enabled instance with `npm run dev` and its requested automation
  port, **when** the controlling agent connects to that port, **then** it can
  select and control the development instance without needing to distinguish
  it through target discovery.
- **Given** a development instance starts with a valid
  `MULTIAGENT_UI_AUTOMATION_PORT`, **when** its persisted automation setting is
  disabled, **then** the requested port temporarily opts in that process and
  the instance exposes its local automation endpoint there without changing
  the persisted setting.
- **Given** a development instance starts with a malformed or already occupied
  requested automation port, **when** it launches, **then** it does not expose
  an automation endpoint on an unintended port and clearly reports that the
  requested endpoint is unavailable.
- **Given** an app-launched agent has its host instance and a development
  instance attached as separate targets, **when** it observes or interacts
  with windows from both targets in the same session, **then** each request
  names its target and affects only the window belonging to that target.
- **Given** an agent submits multiple interactions for the same target window,
  **when** the automation endpoint receives them, **then** it applies them in
  request-arrival order; interactions for another target remain usable while
  those requests run.
- **Given** a target is no longer reachable, **when** an agent performs an
  operation for that target, **then** the operation fails for that target with
  a clear connection error while the agent's other attached targets remain
  usable.
- **Given** a selected target instance, **when** an agent requests its window
  list, **then** the result contains only windows owned by that instance.
- **Given** the server is enabled and a session has access to it, **when** the
  agent lists available application windows, **then** it can identify the
  primary window and each detached MultiAgent window and select one for later
  interaction.
- **Given** an enabled instance has selected its automatic local port,
  **when** the user views the MCP settings status, **then** it reports that
  endpoint and that it is available to new sessions and local clients.
- **Given** the agent has selected an application window, **when** it inspects
  the UI and performs a supported pointer, keyboard, text-entry, scroll, or
  drag action, **then** the corresponding visible application interaction is
  applied to that selected window.
- **Given** a UI change causes an application renderer error or failed network
  request, **when** an agent queries the selected window's diagnostics,
  **then** it receives the relevant console or network information without
  needing a dedicated feature tool.
- **Given** the server is enabled in a packaged installation, **when** a user
  starts a new supported agent session, **then** the session can use the same
  live-application automation capability.
- **Given** a user disables the server, **when** they start another agent
  session, **then** that new session does not receive the server while an
  already running session is left unchanged.
- **Given** both built-in MCP servers are enabled, **when** an app-launched
  agent lists its available tools, **then** it can distinguish the live
  application automation tools from the existing external-browser tools and
  use the latter without controlling the MultiAgent UI.
- **Given** the server is enabled, **when** another device attempts to connect
  over the network, **then** it cannot reach the automation endpoint.

## Open Questions

None outstanding.

## Resolved Decisions

- The feature is a built-in, opt-in MCP server, rather than a development-only
  facility.
- It is intended for developers using MultiAgent and is supported in packaged
  as well as development installations.
- The interface is broad UI automation rather than a collection of
  feature-specific application commands.
- The server remains local-only and uses process-scoped agent configuration.
- A persistent on-screen automation indicator and pause control are not part
  of this feature.
- Both app-launched sessions and independently launched local MCP clients are
  supported.
- An app-launched agent session controls its host MultiAgent instance by
  default; it needs neither a port nor a discovery step for self-control.
- Cross-instance automation is target-scoped. A client attaches each external
  endpoint explicitly and retains a stable target identity; tool calls do not
  use an ambient selected-target state.
- An enabled application can be a target for itself and for another local
  MultiAgent instance, including an agent-spawned `npm run dev` instance.
- A launcher can assign an agent-spawned target instance a known local
  automation port through `MULTIAGENT_UI_AUTOMATION_PORT`; the agent uses that
  explicit endpoint instead of discovery to control the new instance. The
  variable is a temporary, per-process opt-in and does not change saved
  settings.
- No cross-instance authentication, capability exchange, or per-client
  authorization is required. The target instance's persisted opt-in setting
  or its explicit launch-time port is the sole access gate; the service
  remains local-machine-only.

## Out-of-Scope Notes

- A separate later effort may add higher-level, domain-specific app workflows
  if repeated automation tasks demonstrate a durable need; this feature must
  stand on its broad primitives alone.
- An independently accessible automation service for remote collaborators or
  hosted agents would require a separate security and authentication design.
