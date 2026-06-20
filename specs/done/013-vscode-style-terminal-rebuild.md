# 013 - Terminal architecture: root cause of short no-scroll output drop

Status: **RESOLVED.** Closes the investigation started in `012-conpty-no-scroll-output-loss.md`.
The durable rules now live in `CLAUDE.md` (PTY Isolation section). This file is the post-mortem.

## Symptom (from spec 012)

In shell panes on the Win11 target, short output that does **not** scroll the viewport was
silently dropped — canonically `git pull` in an up-to-date repo not showing `Already up to date.`
when the prompt was high in a fresh viewport. Multi-line/scrolling output always showed.

## Root cause (finally isolated)

**A `PATH` rewrite in `PtyManager.buildEnv`.** It prepended `%APPDATA%\npm`,
`%ProgramFiles%\nodejs`, and `~/.local/bin` to `PATH`. Those dirs were **already** on the inherited
PATH, so the prepend only **reordered** PATH — and that reordering shifted `git`'s process startup
timing (git does PATH lookups at launch) into ConPTY's timing-sensitive no-scroll flush race,
dropping its short output. PowerShell builtins like `echo hi` were never affected because they do
no PATH lookup. Removing the PATH rewrite fixed it for every config.

The bug was a *trigger* for ConPTY's underlying no-scroll fragility, which is a known, documented
class of Windows ConPTY issue (see spec 012 / microsoft/terminal issues). We did not need the exact
millisecond mechanism — removing the trigger is a complete fix.

## How the investigation went wrong (so we don't repeat it)

We spent a long time believing **worker-process separation** was the fix: a dedicated `shellWorker`
made shells work, and a unification attempt (commit `27ec130`) brought the drop back. That looked
conclusive but was a **red herring** — `shellWorker` only worked because it used a minimal env
(`buildShellEnv`) with no PATH rewrite, and `27ec130` failed only because its new `'shell'` env
profile still applied the PATH rewrite (the PATH block sat outside the `profile === 'agent'`
guard). Controlled tests on the *shared* worker settled it:

- shared worker + immediate-ready → still dropped (ruled out ready/DA1 timing)
- shared worker + post-attach resize-kick → still dropped (ruled out resize-flush)
- shared worker + **minimal env (no PATH rewrite)** → **worked**
- then bisection: CLAUDE_CODE_* vars innocent; `PATH` rewrite alone reproduced it; `%APPDATA%\npm`
  alone reproduced it; that folder contains no `git` (just npm shims), confirming it was PATH
  *reordering*, not a shadowed binary.
- removing the PATH rewrite entirely: agents still launch (`codex`/`claude` resolve on the
  inherited PATH) and shells work — proving the rewrite was pure redundancy.

Lesson: when a "fix" works, keep isolating single variables until you can *explain* it. The
dedicated worker correlated with the fix without causing it.

## Final architecture (shipped)

- **One pty host + one worker** for shell and agent panes: `PtyManager` + `ptyWorker.ts`
  (`ELECTRON_RUN_AS_NODE` child). `ShellPtyHost`/`shellWorker` deleted.
- **No flow control.** All output relayed directly (`sendDirectPtyOutput`, `seq=0`) →
  synchronous `terminal.write`. No coalesce/ack/pause/watermarks. Only `pendingDirectOutput`
  remains, to buffer while a pty has no routable window (cross-window move).
- **Env profiles:** `buildEnv(extraVars, 'agent' | 'shell')`. CLAUDE_CODE_* vars are agent-only;
  **no PATH rewrite for anyone.**
- ready-gated `windowsPty` + DA1; OSC 633 shell integration for CWD; VS Code-style resize
  debouncer; xterm registry preserves scrollback across remounts.

## Verification

- `git pull` (no scroll), `echo hi` show in shell panes.
- Codex/Claude panes start and resume on the same worker.
- typecheck + build clean; single `ptyWorker.js` emitted; `shellIntegration.ps1` emitted.
- Reference: VS Code integrated terminal at `C:\Users\cdhan\Desktop\vscode` informed the
  ready/resize/shell-integration shape.
