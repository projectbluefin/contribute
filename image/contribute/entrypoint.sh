#!/usr/bin/env bash
# Bluefin Contribute entrypoint: Hive's pinned contributor runtime owns the
# tmux session, prompt injection, and task selection; this only waits for
# that session to exist and attaches this attended terminal to it, so the
# OMP agent is visible immediately with no second terminal required.
set -euo pipefail

note() { printf 'contribute: %s\n' "$1" >&2; }

if [[ -n "${AGENT_BACKEND:-}" && "${AGENT_BACKEND}" != omp ]]; then
  echo "ERROR: this contribute image supports only AGENT_BACKEND=omp." >&2
  exit 64
fi
export AGENT_BACKEND=omp
export COPILOT_INTEGRATION_ID="${COPILOT_INTEGRATION_ID:-copilot-developer-cli}"
export COPILOT_GITHUB_TOKEN="${COPILOT_GITHUB_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
export GITHUB_COPILOT_TOKEN="${GITHUB_COPILOT_TOKEN:-${COPILOT_GITHUB_TOKEN:-}}"

# The attach client must describe the terminal that actually renders tmux.
# The base ships the full terminfo database, so the caller's TERM normally
# resolves; the fallback covers terminals newer than the base's ncurses
# (e.g. xterm-ghostty). A truecolor caller (COLORTERM) gets the direct-color
# fallback; without it tmux downsamples every pane color to 256 and OMP
# renders the wrong colors.
tmux_fallback_term=xterm-256color
has_terminfo() {
  local term="${1:-}"
  [[ -n "$term" ]] || return 1
  if command -v infocmp >/dev/null 2>&1; then
    infocmp "$term" >/dev/null 2>&1
    return $?
  fi
  local first="${term:0:1}"
  local hex_first
  printf -v hex_first '%x' "'$first"
  local dir
  for dir in "${TERMINFO:-}" "$HOME/.terminfo" /etc/terminfo /lib/terminfo /usr/share/terminfo /usr/lib/terminfo; do
    [[ -n "$dir" ]] || continue
    if [[ -e "$dir/$first/$term" || -e "$dir/$hex_first/$term" ]]; then
      return 0
    fi
  done
  return 1
}

if ! has_terminfo "${TERM:-}"; then
  tmux_fallback_term=xterm-256color
  note "TERM=${TERM:-<unset>} has no terminfo; using ${tmux_fallback_term}"
  export TERM="$tmux_fallback_term"
fi

agent_pid=
attach_pid=
# Podman/Apptainer send SIGTERM and wait before SIGKILL, so teardown has to be
# BOUNDED: an unbounded wait on a stuck agent stalls until that deadline and
# dies by SIGKILL, which is the "Ctrl-C stops it" promise failing in the only
# way a user can see. Two short steps, three seconds worst case.
#
# Nothing downstream depends on the agent exiting cleanly. Hive's hub releases
# the task itself when the socket drops.
shutdown_grace_deciseconds=20

wait_for_exit() {
  local pid="$1" limit="$2" waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$limit" ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
}

reset_terminal() {
  # Restore cursor visibility, disable mouse tracking (1000/1002/1003/1006),
  # disable bracketed paste (2004), leave alternate screen (1049), and reset SGR.
  if [ -t 1 ]; then
    printf '\033[?1000l\033[?1002l\033[?1003l\033[?1006l\033[?2004l\033[?1049l\033[?25h\033[0m' || true
  elif [ -t 2 ]; then
    printf '\033[?1000l\033[?1002l\033[?1003l\033[?1006l\033[?2004l\033[?1049l\033[?25h\033[0m' >&2 || true
  fi
}

cleanup() {
  status=$?
  # A second signal during teardown would re-enter this handler and restart
  # the escalation, stretching a bounded teardown past the runtime's deadline.
  trap '' HUP INT TERM
  if [ -n "$attach_pid" ] && kill -0 "$attach_pid" 2>/dev/null; then
    kill "$attach_pid" 2>/dev/null || true
    wait_for_exit "$attach_pid" 10
    kill -KILL "$attach_pid" 2>/dev/null || true
    wait "$attach_pid" 2>/dev/null || true
  fi
  if [ -n "$agent_pid" ] && kill -0 "$agent_pid" 2>/dev/null; then
    kill -TERM "$agent_pid" 2>/dev/null || true
    wait_for_exit "$agent_pid" "$shutdown_grace_deciseconds"
    # Hive's agent script blocks on its own tmux session, so dropping the
    # session is what lets a stuck shutdown finish.
    tmux kill-session -t contributor 2>/dev/null || true
    wait_for_exit "$agent_pid" 10
    kill -KILL "$agent_pid" 2>/dev/null || true
    wait "$agent_pid" 2>/dev/null || true
  fi
  tmux kill-session -t contributor 2>/dev/null || true
  reset_terminal
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

/usr/local/bin/contributor-agent.sh "$@" &
agent_pid=$!

attempts=0
while ! tmux has-session -t contributor 2>/dev/null; do
  if ! kill -0 "$agent_pid" 2>/dev/null; then
    wait "$agent_pid"
    exit $?
  fi
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 600 ]; then
    note 'contributor session did not start'
    note "tmux readiness diagnostics: TMUX=${TMUX:-<unset>} TMUX_TMPDIR=${TMUX_TMPDIR:-<unset>}"
    tmux_state="$(tmux ls 2>&1 || true)"
    note "tmux readiness diagnostics: ${tmux_state//$'\n'/; }"
    exit 1
  fi
  sleep 0.1
done

# Attach only when there is a terminal. Without this an unattended run would
# fail on `tmux attach`, which refuses to run without a tty.
#
# The attach runs as a background job and is waited on rather than run in the
# foreground: bash defers a trap handler until the foreground child returns,
# so a foreground `tmux attach-session` swallows SIGTERM/SIGINT for as long
# as the session is attached, and the runtime would then force the container
# closed by its own kill deadline instead of stopping cleanly on Ctrl-C.
# `wait` is interruptible, so this keeps PID 1 responsive to signals for the
# whole session.
#
# The explicit `<&3` matters: with job control off, bash redirects an
# asynchronous command's stdin from /dev/null unless the command carries a
# redirection of its own, and `tmux attach` dies with "open terminal failed:
# not a terminal" the moment it loses the tty.
if [ -t 0 ] && [ -t 1 ]; then
  exec 3<&0
  tmux attach-session -t contributor <&3 &
  attach_pid=$!
  wait "$attach_pid" || true
  attach_pid=
  exec 3<&-
  reset_terminal
  note 'tmux detached; the agent remains foreground in this terminal. Press Ctrl-C or close this terminal to stop it.'
  wait "$agent_pid"
else
  note 'no tty; following the agent without attaching'
  wait "$agent_pid"
fi
