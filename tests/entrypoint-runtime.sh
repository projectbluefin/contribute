#!/usr/bin/env bash
# tests/entrypoint-runtime.sh
#
# Executes image/contribute/entrypoint.sh on the host against a stand-in for
# Hive's contributor-agent.sh and a stub tmux, so the branches the image
# contract only greps for actually run: the alternate-backend refusal, the
# Copilot token fallbacks, the local-inference (LLMMAN_MODEL) OMP config, the
# TERM fallback (with and without infocmp), the task token cache redirect, and
# how the agent's exit status and a vanished session become PID 1's status.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
entry_src="$repo_root/image/contribute/entrypoint.sh"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

failures=0
fail() {
  printf 'entrypoint-runtime: %s\n' "$1" >&2
  failures=$((failures + 1))
}

# shellcheck disable=SC2016 # the entrypoint source is matched literally, not expanded
agent_line='/usr/local/bin/contributor-agent.sh "$@" &'
[[ "$(grep -cxF "$agent_line" "$entry_src")" == 1 ]] || {
  printf 'entrypoint-runtime: entrypoint no longer launches the agent as %s\n' "$agent_line" >&2
  exit 1
}

# The entrypoint hardcodes the agent's image path; point that one line at a
# stand-in under the scratch tree.
entry="$scratch/entrypoint.sh"
sed "s|^/usr/local/bin/contributor-agent.sh \"\\\$@\" &\$|\"\$FAKE_AGENT\" \"\$@\" \&|" "$entry_src" >"$entry"
# shellcheck disable=SC2016 # the rewritten line is matched literally, not expanded
grep -qxF '"$FAKE_AGENT" "$@" &' "$entry" || {
  echo "entrypoint-runtime: could not redirect the agent launch" >&2
  exit 1
}

stub_bin="$scratch/bin"
mkdir -p "$stub_bin"
# tmux: the session "exists" while $FAKE_SESSION exists.
cat >"$stub_bin/tmux" <<'TMUX'
#!/usr/bin/env bash
case "$1" in
  has-session) [[ -e "$FAKE_SESSION" ]] ;;
  kill-session) rm -f "$FAKE_SESSION" ;;
  ls) echo "no server running" >&2; exit 1 ;;
  *) exit 0 ;;
esac
TMUX
chmod 0755 "$stub_bin/tmux"

# Agent stand-in: records what the entrypoint handed it, then behaves per
# FAKE_AGENT_MODE.
agent="$scratch/agent.sh"
cat >"$agent" <<'AGENT'
#!/usr/bin/env bash
{
  printf 'ARGS=%s\n' "$*"
  for v in AGENT_BACKEND COPILOT_INTEGRATION_ID COPILOT_GITHUB_TOKEN GITHUB_COPILOT_TOKEN \
    PI_CONFIG_FILES TERM HIVE_GH_TOKEN_CACHE; do
    printf '%s=%s\n' "$v" "${!v-<unset>}"
  done
} >"$FAKE_AGENT_ENV"
case "${FAKE_AGENT_MODE:-ok}" in
  ok) : >"$FAKE_SESSION"; exit 0 ;;
  fail-after-session) : >"$FAKE_SESSION"; exit 3 ;;
  fail-before-session) exit 7 ;;
  session-vanishes) : >"$FAKE_SESSION"; sleep 0.3; rm -f "$FAKE_SESSION"; sleep 30 ;;
esac
AGENT
chmod 0755 "$agent"

case_no=0
# run_entry <expected-status> [env assignments...] — runs the entrypoint with a
# clean environment and leaves its stderr in $err and the agent's record in
# $agent_env.
run_entry() {
  local expected="$1" status=0
  shift
  case_no=$((case_no + 1))
  local dir="$scratch/case$case_no"
  mkdir -p "$dir/home" "$dir/tmp"
  err="$dir/stderr"
  agent_env="$dir/agent.env"
  case_home="$dir/home"
  env -i PATH="${CASE_PATH:-$stub_bin:$PATH}" HOME="$dir/home" TMPDIR="$dir/tmp" TERM=xterm \
    FAKE_AGENT="$agent" FAKE_AGENT_ENV="$agent_env" FAKE_SESSION="$dir/session" \
    PI_CONFIG_FILES=/usr/share/hive/contribute/omp-config.yml \
    "$@" timeout 30 bash "$entry" --flag value </dev/null >"$dir/stdout" 2>"$err" || status=$?
  if [[ "$status" != "$expected" ]]; then
    fail "case $case_no ($*): exited $status, expected $expected; stderr: $(tr '\n' ' ' <"$err")"
    return 1
  fi
}

agent_saw() {
  local want="$1" label="$2"
  grep -qxF -- "$want" "$agent_env" 2>/dev/null ||
    fail "$label: agent did not see '$want' (saw: $(tr '\n' ' ' <"$agent_env" 2>/dev/null))"
}

# --- Alternate backends are refused before anything starts --------------------
if run_entry 64 AGENT_BACKEND=goose; then
  grep -qF 'supports only AGENT_BACKEND=omp' "$err" || fail "backend refusal names no reason"
  [[ ! -e "$agent_env" ]] || fail "agent started despite an alternate backend"
fi

# --- Defaults, argument pass-through, and the clean exit path ----------------
if run_entry 0 AGENT_BACKEND=omp; then
  agent_saw 'ARGS=--flag value' "argument pass-through"
  agent_saw 'AGENT_BACKEND=omp' "default backend"
  agent_saw 'COPILOT_INTEGRATION_ID=copilot-developer-cli' "integration id default"
  agent_saw 'PI_CONFIG_FILES=/usr/share/hive/contribute/omp-config.yml' "overlay untouched without LLMMAN_MODEL"
  agent_saw 'TERM=xterm' "a resolvable TERM is kept"
  grep -qF 'no tty; following the agent without attaching' "$err" || fail "unattended run did not say it is not attaching"
  [[ ! -e "$case_home/.omp" ]] || fail "OMP model config written without LLMMAN_MODEL"
fi

# --- Copilot token fallbacks ---------------------------------------------------
if run_entry 0 GITHUB_TOKEN=gh-actions-tok; then
  agent_saw 'COPILOT_GITHUB_TOKEN=gh-actions-tok' "GITHUB_TOKEN fallback"
  agent_saw 'GITHUB_COPILOT_TOKEN=gh-actions-tok' "GITHUB_COPILOT_TOKEN follows COPILOT_GITHUB_TOKEN"
fi
if run_entry 0 GITHUB_TOKEN=gh-actions-tok GH_TOKEN=gh-cli-tok; then
  agent_saw 'COPILOT_GITHUB_TOKEN=gh-cli-tok' "GH_TOKEN wins over GITHUB_TOKEN"
fi
if run_entry 0 GH_TOKEN=gh-cli-tok COPILOT_GITHUB_TOKEN=explicit-tok GITHUB_COPILOT_TOKEN=other-tok \
  COPILOT_INTEGRATION_ID=custom-id; then
  agent_saw 'COPILOT_GITHUB_TOKEN=explicit-tok' "explicit COPILOT_GITHUB_TOKEN wins"
  agent_saw 'GITHUB_COPILOT_TOKEN=other-tok' "explicit GITHUB_COPILOT_TOKEN wins"
  agent_saw 'COPILOT_INTEGRATION_ID=custom-id' "explicit integration id wins"
fi

# --- Local inference: LLMMAN_MODEL writes OMP's provider and role config -----
if run_entry 0 LLMMAN_MODEL=qwen3-coder-30b; then
  models="$case_home/.omp/agent/models.yml"
  roles="$case_home/.omp/agent/contribute-local.yml"
  [[ -f "$models" ]] || fail "LLMMAN_MODEL did not write models.yml"
  [[ -f "$roles" ]] || fail "LLMMAN_MODEL did not write contribute-local.yml"
  if [[ -f "$models" && -f "$roles" ]]; then
    [[ "$(stat -c %a "$models")" == 600 ]] || fail "models.yml is not 0600 (it carries an API key)"
    [[ "$(stat -c %a "$roles")" == 600 ]] || fail "contribute-local.yml is not 0600"
    [[ "$(grep -cF 'baseUrl: "http://10.0.2.2:17434/v1"' "$models")" == 2 ]] ||
      fail "default llmman base URL not used for both providers"
    [[ "$(grep -cF 'apiKey: "llmman-local"' "$models")" == 2 ]] || fail "default llmman API key not used"
    [[ "$(grep -cF -- '- id: "qwen3-coder-30b"' "$models")" == 2 ]] || fail "model id missing from a provider"
    grep -qxF '  llmman:' "$models" || fail "llmman provider missing"
    grep -qxF '  openai:' "$models" || fail "openai provider missing"
    grep -qxF '  default: "openai/qwen3-coder-30b"' "$roles" || fail "default role not pointed at the local model"
    python3 - "$models" "$roles" <<'PY' || fail "generated OMP config is not the expected YAML structure"
import sys
try:
    import yaml
except ImportError:
    sys.exit(0)
models = yaml.safe_load(open(sys.argv[1]))
roles = yaml.safe_load(open(sys.argv[2]))
for name in ("llmman", "openai"):
    p = models["providers"][name]
    assert p["api"] == "openai-completions", p
    assert [m["id"] for m in p["models"]] == ["qwen3-coder-30b"], p
assert roles == {"modelRoles": {"default": "openai/qwen3-coder-30b"}}, roles
PY
  fi
  agent_saw "PI_CONFIG_FILES=/usr/share/hive/contribute/omp-config.yml:$roles" "local role config appended to the overlay"
fi
if run_entry 0 LLMMAN_MODEL=gemma3-12b OPENAI_BASE_URL=http://10.0.2.2:9999/v1 OPENAI_API_KEY=sk-local; then
  models="$case_home/.omp/agent/models.yml"
  [[ "$(grep -cF 'baseUrl: "http://10.0.2.2:9999/v1"' "$models" 2>/dev/null)" == 2 ]] ||
    fail "OPENAI_BASE_URL not honoured for both providers"
  [[ "$(grep -cF 'apiKey: "sk-local"' "$models" 2>/dev/null)" == 2 ]] || fail "OPENAI_API_KEY not honoured"
fi
# An image without the PI_CONFIG_FILES env still loads the shipped overlay.
if run_entry 0 LLMMAN_MODEL=m1 PI_CONFIG_FILES=; then
  agent_saw "PI_CONFIG_FILES=/usr/share/hive/contribute/omp-config.yml:$case_home/.omp/agent/contribute-local.yml" \
    "empty PI_CONFIG_FILES falls back to the shipped overlay"
fi

# --- TERM fallback ---------------------------------------------------------------
if run_entry 0 TERM=hive-no-such-terminal-zz; then
  agent_saw 'TERM=xterm-256color' "unknown TERM falls back"
  grep -qF 'TERM=hive-no-such-terminal-zz has no terminfo; using xterm-256color' "$err" ||
    fail "TERM fallback was silent"
fi
if run_entry 0 TERM=; then
  agent_saw 'TERM=xterm-256color' "empty TERM falls back"
  grep -qF 'TERM=<unset> has no terminfo' "$err" || fail "empty TERM fallback was silent"
fi

# Without infocmp the entrypoint searches terminfo directories itself, under
# both the letter and the hex-named first-character directory.
nocmp="$scratch/nocmp-bin"
mkdir -p "$nocmp"
for tool in bash env sed rm mkdir cat chmod sleep timeout; do
  real="$(command -v "$tool")" || continue
  ln -sf "$real" "$nocmp/$tool"
done
ln -sf "$stub_bin/tmux" "$nocmp/tmux"
fake_terminfo="$scratch/terminfo"
mkdir -p "$fake_terminfo/q" "$fake_terminfo/71"
: >"$fake_terminfo/q/qterm-letter"
: >"$fake_terminfo/71/qterm-hex"
if CASE_PATH="$nocmp" run_entry 0 TERMINFO="$fake_terminfo" TERM=qterm-letter; then
  agent_saw 'TERM=qterm-letter' "terminfo letter directory lookup"
fi
if CASE_PATH="$nocmp" run_entry 0 TERMINFO="$fake_terminfo" TERM=qterm-hex; then
  agent_saw 'TERM=qterm-hex' "terminfo hex directory lookup"
fi
if CASE_PATH="$nocmp" run_entry 0 TERMINFO="$fake_terminfo" TERM=qterm-missing; then
  agent_saw 'TERM=xterm-256color' "terminfo lookup without infocmp falls back"
fi

# --- Task token cache redirect ----------------------------------------------
if run_entry 0 HIVE_GH_TOKEN_CACHE=/explicit/cache; then
  agent_saw 'HIVE_GH_TOKEN_CACHE=/explicit/cache' "explicit token cache wins"
fi
if run_entry 0; then
  if [[ -w /var/run/hive-metrics ]]; then
    agent_saw 'HIVE_GH_TOKEN_CACHE=<unset>' "writable default cache left alone"
  else
    agent_saw "HIVE_GH_TOKEN_CACHE=$scratch/case$case_no/tmp/hive-gh-token.cache" \
      "unwritable default cache redirected under TMPDIR"
  fi
fi

# --- Exit status ---------------------------------------------------------------
run_entry 3 FAKE_AGENT_MODE=fail-after-session || true
run_entry 7 FAKE_AGENT_MODE=fail-before-session || true
if run_entry 1 FAKE_AGENT_MODE=session-vanishes; then
  grep -qF 'the contributor session ended; stopping' "$err" || fail "vanished session was not reported"
fi

# --- A stale relay pid file from a previous run is removed at start ----------
case_dir_next="$scratch/case$((case_no + 1))"
mkdir -p "$case_dir_next"
stale="$case_dir_next/relay.pid"
printf '{"pid": 1}\n' >"$stale"
if run_entry 0 HIVE_RELAY_PID_FILE="$stale"; then
  [[ ! -e "$stale" ]] || fail "stale relay pid file survived startup"
fi

if ((failures > 0)); then
  printf 'entrypoint-runtime: %d failure(s)\n' "$failures" >&2
  exit 1
fi
echo "entrypoint-runtime: $case_no cases hold"
