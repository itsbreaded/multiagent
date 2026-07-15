# MultiAgent shell integration — CWD reporting for bash and zsh.
#
# Emits, before each prompt:
#   - OSC 633;D            — previous command finished (fires onCommandComplete)
#   - OSC 633;P;Cwd=<esc>  — primary CWD report (escaped; unescaped by shellIntegration.ts)
#   - OSC 7;file://<path>  — file:// fallback (raw path; decodeURIComponent leaves it intact)
#
# MultiAgent's ptyOutputRouter (src/main/ipc/ptyOutputRouter.ts) parses these and emits
# `pty:cwd`. Mirrors the contract of shellIntegration.ps1 + the parsers in shellIntegration.ts.
#
# This file is copied OUTSIDE the asar archive (see terminalEnvironment.ts) so the shell — a
# separate process that cannot read inside app.asar — can source it. It is loaded either via
# `bash --init-file <this>` (which REPLACES ~/.bashrc) or via a generated ZDOTDIR .zshrc
# (which REPLACES ~/.zshrc), so this script sources the user's own rc first.

# Guard against double-sourcing (e.g. the user's rc re-sources us).
[ -n "${__MULTIAGENT_SHELL_INTEGRATION_DONE:-}" ] && return 0 2>/dev/null
__MULTIAGENT_SHELL_INTEGRATION_DONE=1

# Source the user's rc (best-effort). The launch mechanism replaces default rc sourcing.
if [ -n "$BASH_VERSION" ]; then
  [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" 2>/dev/null
elif [ -n "$ZSH_VERSION" ]; then
  [ -f "$HOME/.zshrc" ] && . "$HOME/.zshrc" 2>/dev/null
fi

# Escape control bytes, ';' and '\' as \xNN. LC_ALL=C makes the loop byte-oriented so a
# multi-byte path escapes per byte — matching the .ps1 and the \xNN unescape in
# shellIntegration.ts (String.fromCharCode per byte).
__ma_escape_cwd() {
  local LC_ALL=C
  local s="$1" out="" i ch code len=${#1}
  for ((i = 0; i < len; i++)); do
    ch="${s:i:1}"
    case "$ch" in
      [[:cntrl:]] | ';' | '\')
        printf -v code '\\x%02x' "'$ch"
        out+="$code"
        ;;
      *)
        out+="$ch"
        ;;
    esac
  done
  printf '%s' "$out"
}

__ma_report_cwd() {
  printf '\033]633;D\a'
  printf '\033]633;P;Cwd=%s\a' "$(__ma_escape_cwd "$PWD")"
  printf '\033]7;file://%s\a' "$PWD"
}

if [ -n "$BASH_VERSION" ]; then
  # Prepend to PROMPT_COMMAND so we run before the prompt is drawn. Handle both the array
  # (bash 5+) and the classic string form without erroring on either.
  if declare -p PROMPT_COMMAND >/dev/null 2>&1; then
    case "$(declare -p PROMPT_COMMAND)" in
      'declare -a'*) PROMPT_COMMAND=(__ma_report_cwd "${PROMPT_COMMAND[@]}") ;;
      *) PROMPT_COMMAND="__ma_report_cwd${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;
    esac
  else
    PROMPT_COMMAND='__ma_report_cwd'
  fi
elif [ -n "$ZSH_VERSION" ]; then
  typeset -ga precmd_functions
  precmd_functions=(__ma_report_cwd $precmd_functions)
fi