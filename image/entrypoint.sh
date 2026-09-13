#!/usr/bin/env bash
# review container entrypoint.
#
# This wraps Hive's contributor runtime instead of replacing it. Hive owns the
# contributor WebSocket protocol, task selection, the tmux session, prompt
# injection and output capture; everything below is context setup that happens
# before handing control over.
set -euo pipefail

note() { printf 'review: %s\n' "$1" >&2; }

# Startup banner. Deep cyan, slate blue, and neon magenta, colors only when
# stderr is a terminal so captured logs stay plain text.
banner() {
  local mode="$1" c1='' c2='' c3='' r=''
  if [ -t 2 ]; then
    c1=$'\033[1;36m' c2=$'\033[38;5;68m' c3=$'\033[1;95m' r=$'\033[0m'
  fi
  {
    printf '%s' "$c1"
    cat <<'BANNER'
 ____  _____ _   _ ___ _____ _    _
|  _ \| ____| | | |_ _| ____| |  | |
| |_) |  _| | | | || ||  _| | |/\| |
|  _ <| |___| |_| || || |___|  /\  |
|_| \_\_____|\___/|___|_____|_/  \_|
BANNER
    printf '%s      %sBLUEFIN REVIEW APPLIANCE%s\n' "$r" "$c3" "$r"
    printf '%s%s | model %s | effort %s%s\n' \
      "$c2" "$mode" "${AGENT_MODEL:-provider default}" \
      "${AGENT_REASONING_EFFORT:-provider default}" "$r"
  } >&2
}

# Prefer the backend selected by Hive's contributor registration if present.
# The launcher may also pass AGENT_BACKEND; prefer the mounted contributor.env
# selection so the image truly consumes Hive's decision rather than enforcing
# a local default.
hive_config="${HOME}/.config/hive"
selected_backend="${AGENT_BACKEND:-}"
if [ -f "${hive_config}/contributor.env" ]; then
  # Parse AGENT_BACKEND from the registration file if present.
  parsed_backend="$(awk -F= '$1=="AGENT_BACKEND" {sub(/^[^=]*=/, ""); print; exit}' "${hive_config}/contributor.env" 2>/dev/null | tr -d "\"' " || true)"
  if [ -n "${parsed_backend}" ]; then
    selected_backend="${parsed_backend}"
  fi
fi
if [ -z "${selected_backend}" ]; then
  selected_backend="omp"
fi

# Validate the selected backend before startup. Hive remains responsible for
# assignment selection; this only proves the selected CLI can run here.
case "$selected_backend" in
omp)
  command -v omp >/dev/null 2>&1 || {
    note 'ERROR: OMP backend selected but omp is not installed.'
    exit 1
  }
  ;;
codex)
  command -v codex >/dev/null 2>&1 || {
    note 'ERROR: Codex backend selected but codex is not installed.'
    exit 1
  }
  codex --version >/dev/null 2>&1 || {
    note 'ERROR: Codex backend selected but codex is not executable.'
    exit 1
  }
  [ -r /home/dev/.codex/auth.json ] || {
    note 'ERROR: Codex backend selected but its subscription auth.json is missing.'
    exit 1
  }
  ;;
*)
  note "ERROR: unsupported Hive agent backend: ${selected_backend}."
  exit 1
  ;;
esac

# The maintainer review surface is the PR-review launch path: the dashboard
# needs GH_TOKEN and the selected backend but no mounted Hive registration, so
# it skips the contributor.env gate and the Hive handover below. The launcher
# may pass only HIVE_HUB so this surface can consult the selected deployment.
review_dashboard=false
if [ "${1:-}" = queue ]; then
  review_dashboard=true
  shift
fi

hive_config="${HOME}/.config/hive"
if [ "$review_dashboard" = false ] && [ ! -f "${hive_config}/contributor.env" ]; then
  note "missing ${hive_config}/contributor.env"
  note "  mount your Hive config, or run: just contribute-setup codex"
  note "  reviewing the PR queue needs no Hive: run the image with 'queue'"
  exit 1
fi

if [ "$review_dashboard" = true ]; then
  note 'Bluefin Operations | review dashboard starting'
else
  note 'Bluefin Operations | contributor runtime starting'
fi
if [ "$review_dashboard" = true ]; then
  if [ -n "${HIVE_HUB:-}" ]; then
    banner 'PR queue dashboard (Hive configured)'
  else
    banner 'PR queue dashboard (Hive not configured)'
  fi
else
  banner 'Hive contributor'
fi

# --- Git hooks ---------------------------------------------------------------
#
# Hive's entrypoint sets user.name, user.email and credential.helper with
# `git config --global`, which writes individual keys and leaves core.hooksPath
# intact. Hooks are ergonomics only: --no-verify bypasses all of them.
if [ -d /opt/bluefin/git-hooks ]; then
  git config --global core.hooksPath /opt/bluefin/git-hooks || true
fi

# Contributor work forks the assigned repository, so `gh repo fork
# --remote=true` leaves both `origin` and `upstream` tracking a `main`. Git
# then refuses `git checkout main` with "matched multiple (2) remote tracking
# branches" and prints this exact setting as the hint. Name the fork's remote
# so the first checkout of a freshly forked repository just works.
git config --global checkout.defaultRemote origin || true

# The dashboard path never runs contributor-agent.sh, which is where Hive sets
# user.name and user.email. Without them `git commit` aborts with "Author
# identity unknown", so every fix, issue, and landing agent this surface
# dispatches dies the moment it tries to commit. Derive the identity from the
# same credential the agent already acts with, so a commit is attributable to
# the human whose token authorised it. The numeric-id noreply form is the one
# GitHub links back to the account; the bare login form does not on accounts
# created after 2017, and an unattributable commit additionally trips the
# require_extra_approval_for_unattributed_changes rule on every projectbluefin
# ruleset. Never overwrite an identity that is already set.
if [ -n "${GH_TOKEN:-}" ] && ! git config --global --get user.email >/dev/null 2>&1; then
  gh_identity="$(gh api user --jq '[.login, .id] | @tsv' 2>/dev/null || true)"
  if [ -n "$gh_identity" ]; then
    gh_login="${gh_identity%%	*}"
    gh_uid="${gh_identity##*	}"
    git config --global user.name "$gh_login" || true
    git config --global user.email "${gh_uid}+${gh_login}@users.noreply.github.com" || true
  else
    note 'GitHub identity lookup failed; git commits would abort with "Author identity unknown".'
  fi
fi

skills_root="${HOME}/.agents/skills"
if [ -d "$skills_root" ]; then
  shopt -s nullglob
  skills=("$skills_root"/*/SKILL.md)
  note "${#skills[@]} org skills available (load one with /<skill-name>)"
fi

# Contributor work is usually lint-gated. Name any unavailable validation
# tools at startup so an agent does not discover the gap mid-task.
validation_tools=(bats shellcheck hadolint systemd-analyze pre-commit just podman actionlint)
missing_validation_tools=()
for validation_tool in "${validation_tools[@]}"; do
  if ! command -v "$validation_tool" >/dev/null 2>&1; then
    missing_validation_tools+=("$validation_tool")
  fi
done
if ((${#missing_validation_tools[@]})); then
  note "validation tools unavailable: ${missing_validation_tools[*]} (fsdk-containers#89)"
fi

if [ "$review_dashboard" = true ]; then
  # The dashboard gets its context the way a Hive session does, minus Hive:
  # source the pinned runtime's extension seam (/etc/hive/entrypoint.d), whose
  # hook installs the exact curl rewrite for the selected hosted endpoint.
  # Then fetch the knowledge export with upstream's own expression. An absent
  # HIVE_HUB stays absent: queue mode never silently chooses a deployment.
  if [ -n "${GH_TOKEN:-}" ]; then
    shopt -s nullglob
    for hook in /etc/hive/entrypoint.d/*.sh; do
      # shellcheck disable=SC1090
      [ -r "$hook" ] && . "$hook"
    done
    if [ -n "${HIVE_HUB:-}" ]; then
      hub_http="${HIVE_HUB/wss:\/\//https://}"
      if ! curl -sf --max-time 30 "${hub_http%/contribute}/api/knowledge/export" \
        -o "${HOME}/agent.md"; then
        rm -f "${HOME}/agent.md"
        note "Hive knowledge export unavailable from ${hub_http%/contribute}; reviews continue without it."
      fi
      # The export stays a file the agent can search, and is deliberately NOT
      # linked to AGENTS.md/CLAUDE.md-style context files that a backend loads
      # into every subprocess it starts: linking them spent the live export —
      # 417 KB of scraped documentation — of each check's context window
      # before the diff was read, and checks answered with prose or an empty
      # response instead of a verdict. The review scope's REVIEW.md names the
      # path instead, so the knowledge base is reachable at the cost of one
      # line.
    fi
  fi
  if [ -n "${HIVE_HUB:-}" ]; then
    note 'Bluefin Operations | maintainer review dashboard (Hive configured)'
  else
    note 'Bluefin Operations | maintainer review dashboard (Hive not configured)'
  fi
  # The dashboard runs as a background job this shell waits on; it must NOT be
  # exec'd. PID 1 owes the container one duty the Textual process does not
  # perform: reaping adopted children. A review's tool calls leave orphaned
  # grandchildren (defunct git/gh) whose intermediate shell exited first, and
  # reparented to an exec'd Python PID 1 — which never waitpid()s a process it
  # did not spawn — they accumulated as zombies for the whole session (#338).
  # Kept alive, this shell reaps them, `wait` stays interruptible so the trap
  # keeps PID 1 signal-responsive, and the status still propagates — the same
  # handover shape as the contributor path below, for the same reason.
  #
  # The explicit `<&3` matters as it does for the tmux attach below: with job
  # control off, bash redirects an asynchronous command's stdin from /dev/null
  # unless the command carries a redirection of its own, and the dashboard
  # dies the moment it loses the tty.
  exec 3<&0
  /opt/bluefin/tui/.venv/bin/python /opt/bluefin/tui/bluefin_review_tui.py "$@" <&3 &
  tui_pid=$!
  exec 3<&-
  trap 'kill -TERM "$tui_pid" 2>/dev/null || true' HUP INT TERM
  tui_status=0
  wait "$tui_pid" || tui_status=$?
  exit "$tui_status"
fi

# --- Hand over to Hive -------------------------------------------------------
#
# contributor-agent.sh creates the tmux session named "contributor", starts the
# relay, and launches the selected agent by keystroke injection. Attaching to that session is
# Hive's own documented flow. Running it in the foreground is deliberate: the
# launcher never backgrounds or detaches the agent.
# The attach client must describe the terminal that actually renders tmux.
# The base ships the full terminfo database, so the caller's TERM normally
# resolves; the fallback covers terminals newer than the base's ncurses
# (e.g. xterm-ghostty). A truecolor caller (COLORTERM) gets the direct-color
# fallback; without it tmux downsamples every pane color to 256 and the
# agent renders the wrong colors.
tmux_fallback_term=xterm-256color
if ! infocmp "${TERM:-}" >/dev/null 2>&1; then
  case "${COLORTERM:-}" in
  truecolor | 24bit) tmux_fallback_term=xterm-direct ;;
  esac
  note "TERM=${TERM:-<unset>} has no terminfo; using ${tmux_fallback_term}"
  export TERM="$tmux_fallback_term"
fi
agent_pid=
status_pid=
# Podman sends SIGTERM and waits ten seconds before SIGKILL, so teardown has
# to be BOUNDED: an unbounded wait on a stuck agent stalls until that deadline
# and dies by SIGKILL, which is the "Ctrl-C stops it" promise failing in the
# only way a user can see. Two short steps, three seconds worst case, leave
# the deadline untouched.
#
# Nothing downstream depends on the agent exiting cleanly. Hive's hub releases
# the task itself when the socket drops -- its disconnect defer nils
# currentTask, logs 'task released on disconnect' and books a cooldown, and
# heartbeatLoop closes a half-open socket on a stale pong. A polite window for
# the agent's own exit trap is worth two seconds; it is not load-bearing, and
# must not grow into a shutdown protocol this repository does not owe anyone.
shutdown_grace_deciseconds=20

wait_for_exit() {
  # Poll rather than 'wait' so this is reusable from inside a trap handler,
  # where the child has usually already been reaped.
  local pid="$1" limit="$2" waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$limit" ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
}

cleanup() {
  status=$?
  # A second signal during teardown would re-enter this handler and restart
  # the escalation, stretching a bounded teardown past podman's deadline.
  trap '' HUP INT TERM
  if [ -n "$status_pid" ] && kill -0 "$status_pid" 2>/dev/null; then
    kill -TERM "$status_pid" 2>/dev/null || true
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

# The attended surface is a passive status companion. Hive still creates and
# owns the contributor tmux session; the companion prints its exact attach
# command so a maintainer can enter that session deliberately.
#
# The companion runs as a background job and is waited on rather than run in
# the foreground so this shell remains PID 1 and signal-responsive. Its input
# is the attended terminal; Hive's own tmux session remains a separate,
# explicitly attachable runtime.
#
# The explicit `<&3` matters: with job control off, bash redirects an
# asynchronous command's stdin from /dev/null unless the command carries a
# redirection of its own, and the companion would lose its attended terminal.
if [ -t 0 ] && [ -t 1 ]; then
  exec 3<&0
  /opt/bluefin/tui/.venv/bin/python /opt/bluefin/tui/worker_status.py <&3 &
  status_pid=$!
  exec 3<&-
  wait "$status_pid" || true
  status_pid=
  note 'status companion closed; the agent remains foreground in this terminal. Press Ctrl-C or close this terminal to stop it.'
  wait "$agent_pid"
else
  note 'no tty; following the agent without attaching'
  wait "$agent_pid"
fi
