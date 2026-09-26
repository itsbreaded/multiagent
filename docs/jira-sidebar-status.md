# Jira sidebar status badges

This document expands the `AGENTS.md` **Jira sidebar status badges** guardrails.

## Ownership and persistence

The main process owns Jira credential persistence and all Jira network requests.
The token is stored only in the additive Jira settings file under Electron
`userData`, encrypted with `safeStorage`, and written atomically. The settings
screen may request the decrypted token through the dedicated token IPC channel
to populate its ordinary password field and Show/Hide control; it keeps that
value only in component memory. Main accepts that request only from the
primary/settings window. The token never enters localStorage, layout state, the
Jira status store, logs, errors, or IPC traces. If secure storage is unavailable
or a secure write/decrypt fails, the app fails closed and never writes
plaintext.

## Lookup lifecycle

The renderer derives an issue key only from the leading whitespace-delimited
token of the displayed project-folder label. Matching is a case-insensitive
literal prefix followed by decimal digits. Startup and first appearance perform
the one allowed initial lookup; later requests come only from the per-folder or
bulk refresh actions. There is no timer, polling, Jira mutation, automatic tab
closure, pane lookup, Recent-session lookup, or transcript/path scanning.

Each row owns its request generation and cached result. A late response is
discarded after a rename, close, configuration change, or newer refresh. A
transient failed refresh retains the last successful status as explicitly stale;
an invalidated base URL or issue key never exposes its old link until refreshed.

## External links and diagnostics

The successful badge activates a main-owned `jira:open-issue` request with an
issue key, not a renderer-supplied URL. Main reloads current settings, builds a
validated HTTP(S) issue URL, and sends it through the external-browser
allowlist. Renderer navigation and auxiliary anchor paths must not bypass that
validation. Jira requests disable automatic cross-origin redirects so
Authorization cannot follow an untrusted redirect.

Credential values, including the account email when paired with Jira settings,
must not appear in errors, logs, diagnostics, test snapshots, or E2E IPC
traces. The preload trace omits credential-bearing Jira saves and connection
tests.

## Settings behavior

The Jira form follows the rest of the settings panel: edits are drafts while
the panel is open and are persisted when the Jira settings view closes. The
footer action is **Test Jira connection**. It sends the current base URL, email,
and token to a read-only Jira account endpoint without saving the draft. A
successful or failed test is shown inline and never blocks closing or saving
the settings.
