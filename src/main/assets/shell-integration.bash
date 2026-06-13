# Agent Terminal shell integration (§15.5 / D3). Sourced via PROMPT_COMMAND AFTER
# the user's own startup files (env-var hook, never --rcfile/--noprofile), so §5's
# "user's own configuration" rule holds. Emits OSC 133 marks (FinalTerm/iTerm2/
# VS Code convention) so the host can segment commands: A prompt-start, B
# command-start, C output-start, D;exit finished. Marks are invisible in xterm.
#
# Degrades silently: a foreign/non-bash shell that inherits this env but lacks the
# (app-owned, non-user-writable) file returns immediately rather than erroring.
# Known, spec-sanctioned limit: an rc that *overwrites* PROMPT_COMMAND disables
# command capture (marks absent → feature simply unavailable).

[[ -r "$APP_TERM_INTEGRATION" ]] || return 0
[[ -n "$BASH_VERSION" ]] || return 0

__app_term_install() {
  # Idempotent: append B to PS1 and prepend C to PS0 only once each, self-healing
  # every prompt in case the user's rc reset PS1/PS0 after we were sourced.
  case "$PS1" in *133\;B*) ;; *) PS1="${PS1}\[\e]133;B\a\]" ;; esac
  case "$PS0" in *133\;C*) ;; *) PS0="\e]133;C\a${PS0}" ;; esac
}

__app_term_precmd() {
  local ec=$?
  printf '\e]133;D;%s\a' "$ec"
  printf '\e]133;A\a'
  __app_term_install
  return 0
}

__app_term_install
case "$PROMPT_COMMAND" in
  *__app_term_precmd*) ;;
  *) PROMPT_COMMAND="__app_term_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;
esac
