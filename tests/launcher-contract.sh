#!/usr/bin/env bash
# tests/launcher-contract.sh
# Hermetic contract test for bin/hive-contribute
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
launcher="$repo_root/bin/hive-contribute"

fail() {
  printf 'launcher-contract: %s\n' "$*" >&2
  exit 1
}

assert_eq() {
  local actual="$1" expected="$2" label="${3:-}"
  if [[ "$actual" != "$expected" ]]; then
    fail "${label}: expected '${expected}', got '${actual}'"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" label="${3:-}"
  if [[ "$haystack" != *"$needle"* ]]; then
    fail "${label}: expected to contain '${needle}', got: ${haystack}"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="${3:-}"
  if [[ "$haystack" == *"$needle"* ]]; then
    fail "${label}: expected NOT to contain '${needle}', got: ${haystack}"
  fi
}

scratch="$(mktemp -d "${TMPDIR:-/tmp}/launcher-contract.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

fake_bin="$scratch/bin"
fake_home="$scratch/home"
fake_kvm="$scratch/dev/kvm"
podman_log="$scratch/podman.log"
curl_log="$scratch/curl.log"
gh_log="$scratch/gh.log"
mkdir -p "$fake_bin" "$fake_home" "$scratch/dev"

touch "$fake_kvm"
chmod 0666 "$fake_kvm"
# --- Fake commands -----------------------------------------------------------

cat >"$fake_bin/krun" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$fake_bin/krun"

cat >"$fake_bin/podman" <<EOF
#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == "--runtime=krun" ]]; then
  # Podman resolves the runtime NAME through containers.conf, so an
  # unregistered krun fails here even when a binary exists on PATH.
  [[ "\${FAKE_PODMAN_NO_KRUN:-0}" == 1 ]] && exit 125
  shift
fi
[[ "\${1:-}" == info ]] && { [[ "\${FAKE_PODMAN_INFO_FAIL:-0}" == 1 ]] && exit 1 || exit 0; }
if [[ "\${1:-} \${2:-} \${3:-}" == "system connection list" ]]; then
  [[ "\${FAKE_PODMAN_REMOTE:-0}" != 1 ]] || printf 'remote\tssh://engine.example.test/run/podman.sock\tidentity\ttrue\n'
  exit 0
fi
case "\${1:-} \${2:-}" in
  "pull "*)
    printf 'pull %s\n' "\${*:2}" >>"$podman_log"
    [[ "\${FAKE_PODMAN_PULL_FAIL:-0}" != 1 ]] || exit 1
    exit 0
    ;;
  "image exists")
    [[ "\${FAKE_PODMAN_IMAGE_EXISTS:-1}" == 1 ]] && exit 0 || exit 1
    ;;
  "image inspect")
    printf 'image inspect %s\n' "\${*:2}" >>"$podman_log"
    if [[ "\$*" == *'{{.Digest}}'* ]]; then
      printf 'sha256:1111111111111111111111111111111111111111111111111111111111111111\n'
      exit 0
    fi
    printf 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\n'
    exit 0
    ;;
  "save "*)
    printf 'save %s\n' "\${*:2}" >>"$podman_log"
    archive=""
    while (( \$# )); do
      [[ "\$1" == -o ]] && archive="\$2"
      shift
    done
    printf 'oci-archive\n' >"\$archive"
    exit 0
    ;;
  "run "*)
    printf 'run %s\n' "\${*:2}" >>"$podman_log"
    exit "\${FAKE_PODMAN_RUN_STATUS:-0}"
    ;;
esac
exit 0
EOF
chmod +x "$fake_bin/podman"

cat >"$fake_bin/gh" <<EOF
#!/usr/bin/env bash
set -eu
printf 'gh %s\n' "\$*" >>"$gh_log"
case "\${1:-} \${2:-}" in
  "auth status")
    [[ "\${FAKE_GH_AUTH_STATUS_FAIL:-0}" != 1 ]] || exit 1
    echo "✓ Logged in to github.com account testuser (keyring)"
    echo "  - Token scopes: repo, read:org, workflow"
    exit 0
    ;;
  "auth token")
    [[ "\${FAKE_GH_TOKEN_FAIL:-0}" != 1 ]] || exit 1
    printf '%s\n' "\${FAKE_GH_TOKEN_VALUE:-fake-gh-auth-token-12345}"
    exit 0
    ;;
  "attestation verify")
    [[ "\${FAKE_GH_ATTESTATION_FAIL:-0}" != 1 ]] || { echo "✗ attestation verification failed" >&2; exit 1; }
    echo "✓ Verification succeeded!"
    exit 0
    ;;
esac
exit 0
EOF
chmod +x "$fake_bin/gh"

# The launcher no longer calls curl itself — Hive owns every exchange with the
# hub. This stub exists only so the `curl` prerequisite check in setup finds a
# binary, and it records its argv so a future caller cannot start passing
# credentials on a command line unnoticed.
cat >"$fake_bin/curl" <<EOF
#!/usr/bin/env bash
set -eu
printf 'curl %s\n' "\$*" >>"$curl_log"
exit 0
EOF
chmod +x "$fake_bin/curl"

# Base environment for running tests
clean_env() {
  export PATH="$fake_bin:$PATH"
  export HOME="$fake_home"
  export XDG_CONFIG_HOME="$fake_home/.config"
  export XDG_STATE_HOME="$fake_home/.local/state"
  export HIVE_CONTRIBUTE_TEST_KVM_DEVICE="$fake_kvm"
  unset HIVE_CONTRIBUTE_CONFIG
  unset HIVE_CONTRIBUTE_TEST_HOST_ROOT
  unset HUB REGISTRATION IMAGE BACKEND
  unset GH_TOKEN GITHUB_TOKEN
  unset FAKE_PODMAN_INFO_FAIL FAKE_PODMAN_REMOTE FAKE_PODMAN_PULL_FAIL FAKE_PODMAN_IMAGE_EXISTS FAKE_PODMAN_NO_KRUN
  unset FAKE_PODMAN_RUN_STATUS
  unset FAKE_GH_AUTH_STATUS_FAIL FAKE_GH_TOKEN_FAIL FAKE_GH_TOKEN_VALUE
  unset FAKE_GH_ATTESTATION_FAIL HIVE_CONTRIBUTE_NO_VERIFY
  rm -rf "${fake_home:?}"
  mkdir -p "$fake_home"
  cat >"$fake_bin/krun" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$fake_bin/krun"
  : >"$podman_log"
  : >"$curl_log"
  : >"$gh_log"
}

# -----------------------------------------------------------------------------
# Scenario 1: `config` writes ~/.config/hive-contribute.yml mode 0600,
#             seeds hub from ~/.config/hive/contributor.env, prints resolved values.
# -----------------------------------------------------------------------------
test_config_seeding_and_creation() {
  clean_env
  mkdir -p "$fake_home/.config/hive"
  cat >"$fake_home/.config/hive/contributor.env" <<'EOF'
HIVE_HUB=wss://existing-hub.example.com/contribute
HIVE_REGISTRATION_TOKEN=some-token-abc
CONTRIBUTOR_ID=c-seeded
EOF

  local config_file="$fake_home/.config/hive-contribute.yml"
  [[ ! -f "$config_file" ]] || fail "config should not exist before test"

  local output
  output="$("$launcher" config)"

  [[ -f "$config_file" ]] || fail "config file was not created"
  local mode
  mode="$(stat -c '%a' "$config_file")"
  assert_eq "$mode" "600" "config file permission"

  assert_contains "$output" "config:       $config_file" "config output config path"
  assert_contains "$output" "hub:          wss://existing-hub.example.com/contribute" "config output hub"
  assert_contains "$output" "registration: $fake_home/.config/hive/contributor.env" "config output registration"
  assert_contains "$output" "image:        ghcr.io/projectbluefin/contribute:stable" "config output image"
  assert_contains "$output" "backend:      omp" "config output backend"
  assert_contains "$output" "hive ref:     v4 (tracked, never pinned)" "config output hive ref"

  # Verify file content
  local file_content
  file_content="$(<"$config_file")"
  assert_contains "$file_content" "hub: wss://existing-hub.example.com/contribute" "saved hub in yaml"
  assert_contains "$file_content" "backend: omp" "saved backend in yaml"
}

# -----------------------------------------------------------------------------
# Scenario 2: zero-config bare run registers through upstream, then launches.
# -----------------------------------------------------------------------------
test_zero_config_run_registers_then_launches() {
  clean_env
  mkdir -p "$fake_home/.config/hive"
  local just_log="$scratch/just-zero.log"
  : >"$just_log"

  # Stand in for upstream contribute-setup: it discovers the hive (the picker
  # this launcher never sees) and writes the credential naming it.
  cat >"$fake_bin/just" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${JUST_LOG:?}"
printf 'hive-hub=%s\n' "${HIVE_HUB:-<unset>}" >>"${JUST_LOG}"
config_dir=""
for arg in "$@"; do
  case "$arg" in config_dir=*) config_dir="${arg#config_dir=}" ;; esac
done
[[ -n "$config_dir" ]] || exit 1
mkdir -p "$config_dir"
printf 'HIVE_REGISTRATION_TOKEN=discovered-token\nHIVE_HUB=wss://discovered.example.com/contribute\nCONTRIBUTOR_ID=c-discovered\n' >"$config_dir/contributor.env"
EOF
  chmod +x "$fake_bin/just"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$fake_bin/git"
  chmod +x "$fake_bin/git"
  local tool
  for tool in node jq; do
    printf '#!/usr/bin/env bash\nexit 0\n' >"$fake_bin/$tool"
    chmod +x "$fake_bin/$tool"
  done

  local output
  # No arguments at all: `cd` in and run it.
  output="$(JUST_LOG="$just_log" "$launcher" 2>&1)"

  grep -q 'contribute-setup omp' "$just_log" ||
    fail "a bare run on an unconfigured machine did not reach upstream contribute-setup"
  assert_contains "$output" "starting isolated KVM worker" "bare run launched the worker"
  assert_eq "$(grep -c '^run ' "$podman_log" || true)" "1" "exactly one podman run from a bare first run"
  grep -q '^hub: wss://discovered.example.com/contribute$' "$fake_home/.config/hive-contribute.yml" ||
    fail "the hub upstream registered against was not recorded in the config"
  assert_eq "$(stat -c '%a' "$fake_home/.config/hive/contributor.env")" "600" "registered credential permission"

  # The one refusal left: a credential that names no hub. Setup has already
  # run, so there is nothing further to try and an error is the honest answer.
  : >"$podman_log"
  sed -i 's|^hub: .*$|hub:|' "$fake_home/.config/hive-contribute.yml"
  printf 'HIVE_REGISTRATION_TOKEN=t\nCONTRIBUTOR_ID=c\n' >"$fake_home/.config/hive/contributor.env"
  set +e
  output="$("$launcher" run 2>&1)"
  local status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "run should fail when no hub can be resolved"
  assert_contains "$output" "no hub in" "error message when no hub can be resolved"
  assert_eq "$(cat "$podman_log")" "" "no podman run recorded when no hub can be resolved"

  rm -f "$fake_bin/just" "$fake_bin/git" "$fake_bin/node" "$fake_bin/jq"
}

# -----------------------------------------------------------------------------
# Scenario 3: `run` on krun path: exactly one podman invocation, keep-id,
#             registration mounted ro, AGENT_BACKEND=omp, NO credentials in argv.
# -----------------------------------------------------------------------------
test_run_krun_path() {
  clean_env
  local config_file="$fake_home/.config/hive-contribute.yml"
  mkdir -p "$fake_home/.config/hive"
  cat >"$config_file" <<EOF
hub: wss://hub.example.com/contribute
registration: $fake_home/.config/hive/contributor.env
image: ghcr.io/projectbluefin/contribute:stable
backend: omp
EOF
  chmod 600 "$config_file"

  cat >"$fake_home/.config/hive/contributor.env" <<'EOF'
HIVE_HUB=wss://hub.example.com/contribute
HIVE_REGISTRATION_TOKEN=not-a-real-registration-token
CONTRIBUTOR_ID=c-test-krun
EOF
  chmod 600 "$fake_home/.config/hive/contributor.env"

  export GH_TOKEN="not-a-real-gh-token"
  export ANTHROPIC_API_KEY="not-a-real-anthropic-key"
  export OPENROUTER_API_KEY="not-a-real-openrouter-key"
  # Set but EMPTY: the relay's documented opt-out of session labeling, which
  # must be forwarded as an empty value rather than dropped.
  export HIVE_SESSION=""

  local output
  output="$("$launcher" run)"

  assert_contains "$output" "starting isolated KVM worker" "kvm worker banner"

  local run_count
  run_count="$(grep -c '^run ' "$podman_log" || true)"
  assert_eq "$run_count" "1" "exactly one podman run recorded"

  local run_cmd
  run_cmd="$(grep '^run ' "$podman_log")"

  assert_contains "$run_cmd" "--runtime=krun" "krun runtime flag"
  assert_contains "$run_cmd" "--rm" "podman rm flag"
  assert_contains "$run_cmd" "--interactive" "interactive flag"
  assert_contains "$run_cmd" "--tty" "tty flag"
  assert_contains "$run_cmd" "--userns keep-id:uid=65532,gid=65532" "userns keep-id"
  assert_contains "$run_cmd" "--volume $fake_home/.config/hive/contributor.env:/home/hive/.config/hive/contributor.env:ro,z" "registration mount ro,z"
  assert_contains "$run_cmd" "--env AGENT_BACKEND=omp" "backend env"
  assert_contains "$run_cmd" "--env GH_TOKEN" "GH_TOKEN env passed by name"
  assert_contains "$run_cmd" "--env ANTHROPIC_API_KEY" "provider key env passed by name"
  assert_contains "$run_cmd" "--env OPENROUTER_API_KEY" "OpenRouter key env passed by name"
  assert_contains "$run_cmd" "--env HIVE_SESSION=" "set-but-empty HIVE_SESSION forwarded"
  # Upstream's contributor envelope, with swap pinned to the memory ceiling.
  assert_contains "$run_cmd" "--memory 4g" "memory ceiling"
  assert_contains "$run_cmd" "--memory-swap 4g" "swap pinned to memory ceiling"
  assert_contains "$run_cmd" "--cpus 2" "cpu ceiling"
  assert_contains "$run_cmd" "ghcr.io/projectbluefin/contribute:stable" "image name"

  # Provenance is verified against the digest Podman actually pulled, not the
  # tag, and against the publishing repository — before the container runs.
  local gh_calls
  gh_calls="$(cat "$gh_log")"
  assert_contains "$gh_calls" "attestation verify oci://ghcr.io/projectbluefin/contribute@sha256:1111111111111111111111111111111111111111111111111111111111111111" "provenance verified against the pulled digest"
  assert_contains "$gh_calls" "--repo projectbluefin/contribute" "provenance verified against the publishing repo"

  # Crucial security assertion: NO credential value anywhere in recorded argv!
  assert_not_contains "$run_cmd" "not-a-real-registration-token" "registration token value in argv"
  assert_not_contains "$run_cmd" "not-a-real-gh-token" "GH token value in argv"
  assert_not_contains "$run_cmd" "not-a-real-anthropic-key" "Anthropic key value in argv"
  assert_not_contains "$run_cmd" "not-a-real-openrouter-key" "OpenRouter key value in argv"

  # Hive owns every exchange with the hub. The launcher mounts the credential
  # and starts the container; it does not validate, reissue, or otherwise call
  # the hub. A downstream copy of that protocol is what this asserts stays gone.
  assert_eq "$(cat "$curl_log")" "" "the launcher must not call the hub itself"

  # An unset HIVE_SESSION must stay absent — the relay then defaults the label
  # to the backend name, which is not the same thing as an empty label.
  unset HIVE_SESSION
  : >"$podman_log"
  "$launcher" run >/dev/null
  assert_not_contains "$(grep '^run ' "$podman_log")" "HIVE_SESSION" "unset HIVE_SESSION must not be forwarded"

  # `none` removes the ceiling rather than passing a literal to the runtime.
  printf 'memory: none\ncpus: none\n' >>"$config_file"
  : >"$podman_log"
  "$launcher" run >/dev/null
  local unbounded
  unbounded="$(grep '^run ' "$podman_log")"
  assert_not_contains "$unbounded" "--memory" "memory ceiling removed by none"
  assert_not_contains "$unbounded" "--cpus" "cpu ceiling removed by none"
  unset OPENROUTER_API_KEY
}

# -----------------------------------------------------------------------------
# Scenario 3b: the bug #618 reported. A host can register krun with Podman
#              against a differently named binary (/usr/bin/crun-krun), so
#              there is no `krun` on PATH while `podman run --runtime=krun`
#              works perfectly. Probing PATH gave up the KVM boundary for nothing.
# -----------------------------------------------------------------------------
test_krun_registered_with_podman_but_absent_from_path() {
  clean_env
  # No krun executable anywhere on PATH...
  rm -f "$fake_bin/krun"
  # ...but Podman resolves the runtime name, which is what the launch uses.
  unset FAKE_PODMAN_NO_KRUN
  local config_file="$fake_home/.config/hive-contribute.yml"
  mkdir -p "$fake_home/.config/hive"
  cat >"$config_file" <<EOF
hub: wss://hub.example.com/contribute
registration: $fake_home/.config/hive/contributor.env
image: ghcr.io/projectbluefin/contribute:stable
backend: omp
EOF
  chmod 600 "$config_file"
  printf 'HIVE_HUB=wss://hub.example.com/contribute\nHIVE_REGISTRATION_TOKEN=t\nCONTRIBUTOR_ID=c\n' \
    >"$fake_home/.config/hive/contributor.env"
  chmod 600 "$fake_home/.config/hive/contributor.env"

  local output
  output="$("$launcher" run)"
  assert_contains "$output" "starting isolated KVM worker" "krun registered with Podman must take the KVM path"
  assert_eq "$(grep -c '^run ' "$podman_log" || true)" "1" "exactly one podman run"
  assert_contains "$(grep '^run ' "$podman_log")" "--runtime=krun" "launch must still request krun"
}

# -----------------------------------------------------------------------------
# Scenario 3c: Podman fallback when krun is unavailable: warns and runs standard Podman
# -----------------------------------------------------------------------------
test_run_podman_fallback_without_krun() {
  clean_env
  export FAKE_PODMAN_NO_KRUN=1

  local config_file="$fake_home/.config/hive-contribute.yml"
  mkdir -p "$fake_home/.config/hive"
  cat >"$config_file" <<EOF
hub: wss://hub.example.com/contribute
registration: $fake_home/.config/hive/contributor.env
image: ghcr.io/projectbluefin/contribute:stable
backend: omp
EOF
  chmod 600 "$config_file"
  printf 'HIVE_HUB=wss://hub.example.com/contribute\nHIVE_REGISTRATION_TOKEN=t\nCONTRIBUTOR_ID=c\n' \
    >"$fake_home/.config/hive/contributor.env"
  chmod 600 "$fake_home/.config/hive/contributor.env"

  local output
  output="$("$launcher" run 2>&1)"
  assert_contains "$output" "running container worker without KVM boundary" "warns about missing KVM"
  assert_contains "$output" "starting container worker" "starts container worker"
  assert_eq "$(grep -c '^run ' "$podman_log" || true)" "1" "exactly one podman run"
  assert_not_contains "$(grep '^run ' "$podman_log")" "--runtime=krun" "standard podman must not request krun"
}

# -----------------------------------------------------------------------------
# Scenario 3d: Doctor reports Podman container fallback when krun is unavailable
# -----------------------------------------------------------------------------
test_doctor_podman_fallback() {
  clean_env
  export FAKE_PODMAN_NO_KRUN=1
  local config_file="$fake_home/.config/hive-contribute.yml"
  mkdir -p "$fake_home/.config/hive"
  cat >"$config_file" <<EOF
hub: wss://hub.example.com/contribute
registration: $fake_home/.config/hive/contributor.env
image: ghcr.io/projectbluefin/contribute:stable
backend: omp
EOF
  chmod 600 "$config_file"
  touch "$fake_home/.config/hive/contributor.env"
  export FAKE_GH_TOKEN_VALUE="fake-doctor-gh-token"

  local output
  output="$("$launcher" doctor)"
  assert_contains "$output" "Podman container runtime ready" "doctor reports podman container runtime"
  assert_contains "$output" "checks passed, 0 failed" "doctor summary passes on container fallback"
}

# -----------------------------------------------------------------------------
# Scenario: provenance fails closed. When gh is present and the attestation
#           does not verify, NO container may run — an isolation appliance
#           that shrugs off a failed provenance check has no boundary left.
#           HIVE_CONTRIBUTE_NO_VERIFY=1 is the loud operational override.
# -----------------------------------------------------------------------------
test_run_refuses_unverified_image() {
  clean_env
  local config_file="$fake_home/.config/hive-contribute.yml"
  mkdir -p "$fake_home/.config/hive"
  cat >"$config_file" <<EOF
hub: wss://hub.example.com/contribute
registration: $fake_home/.config/hive/contributor.env
image: ghcr.io/projectbluefin/contribute:stable
backend: omp
EOF
  chmod 600 "$config_file"
  printf 'HIVE_HUB=wss://hub.example.com/contribute\nHIVE_REGISTRATION_TOKEN=t\nCONTRIBUTOR_ID=c-verify\n' \
    >"$fake_home/.config/hive/contributor.env"
  chmod 600 "$fake_home/.config/hive/contributor.env"

  export FAKE_GH_ATTESTATION_FAIL=1
  set +e
  local output status
  output="$("$launcher" run 2>&1)"
  status=$?
  set -e
  assert_eq "$status" "1" "failed verification must fail the launch"
  assert_contains "$output" "build-provenance verification failed" "refusal names the check"
  assert_eq "$(grep -c '^run ' "$podman_log" || true)" "0" "no container ran after a failed verification"

  # The override launches, and says out loud that verification was skipped.
  export HIVE_CONTRIBUTE_NO_VERIFY=1
  output="$("$launcher" run 2>&1)" || fail "HIVE_CONTRIBUTE_NO_VERIFY=1 must still launch"
  assert_contains "$output" "WITHOUT provenance verification" "override warns"
  assert_eq "$(grep -c '^run ' "$podman_log" || true)" "1" "override launched exactly once"
}
# Scenario 6: `doctor`: exits non-zero and says why when hub is unset or gh has no token;
#             exits zero on healthy fake machine; never mounts credential (no container run).
# -----------------------------------------------------------------------------
test_doctor_failures_and_success() {
  clean_env
  # Case A: hub is unset -> doctor fails
  local config_file="$fake_home/.config/hive-contribute.yml"
  mkdir -p "$fake_home/.config/hive"
  cat >"$config_file" <<EOF
hub:
registration: $fake_home/.config/hive/contributor.env
image: ghcr.io/projectbluefin/contribute:stable
backend: omp
EOF
  chmod 600 "$config_file"

  set +e
  local output_no_hub status_no_hub
  output_no_hub="$("$launcher" doctor 2>&1)"
  status_no_hub=$?
  set -e

  [[ "$status_no_hub" -ne 0 ]] || fail "doctor should fail when hub is unset"
  assert_contains "$output_no_hub" "no hub configured; run 'hive-contribute setup'" "doctor missing hub message"

  # Case B: hub is set, but gh has no token -> doctor fails
  cat >"$config_file" <<EOF
hub: wss://hub.example.com/contribute
registration: $fake_home/.config/hive/contributor.env
image: ghcr.io/projectbluefin/contribute:stable
backend: omp
EOF
  export FAKE_GH_TOKEN_FAIL=1

  set +e
  local output_no_gh status_no_gh
  output_no_gh="$("$launcher" doctor 2>&1)"
  status_no_gh=$?
  set -e

  [[ "$status_no_gh" -ne 0 ]] || fail "doctor should fail when gh token is unavailable"
  assert_contains "$output_no_gh" "no GitHub token is available" "doctor missing token message"

  # Case C: healthy fake machine -> doctor passes (exit 0)
  unset FAKE_GH_TOKEN_FAIL
  export FAKE_GH_TOKEN_VALUE="fake-doctor-gh-token"
  touch "$fake_home/.config/hive/contributor.env"

  local output_healthy status_healthy=0
  output_healthy="$("$launcher" doctor 2>&1)" || status_healthy=$?

  assert_eq "$status_healthy" "0" "doctor should pass on healthy machine"
  assert_contains "$output_healthy" "hive: wss://hub.example.com/contribute" "doctor reports hub"
  assert_contains "$output_healthy" "Podman krun KVM runtime ready" "doctor reports kvm ready"
  assert_contains "$output_healthy" "gh is authenticated" "doctor reports gh ready"
  assert_contains "$output_healthy" "a GitHub token is available for the agent" "doctor reports token ready"
  assert_contains "$output_healthy" "checks passed, 0 failed" "doctor summary passes"

  # Never mounts credential / no container run recorded
  assert_eq "$(cat "$podman_log")" "" "doctor must never run podman"
}
# -----------------------------------------------------------------------------
# Scenario 7: `setup` survives upstream's HOST-CLI preflight.
#
# Hive's contribute-setup depends on contribute-check-backend, which probes the
# host PATH for the agent CLI and exits 1 when it is absent. On this appliance
# that is the normal state — the CLI ships in the image — so setup has to
# answer the probe instead of failing a correctly-configured machine.
# -----------------------------------------------------------------------------
test_setup_satisfies_host_cli_probe() {
  clean_env
  mkdir -p "$fake_home/.config/hive"
  cat >"$fake_home/.config/hive-contribute.yml" <<EOF
hub: wss://setup-hub.example.com/contribute
registration: $fake_home/.config/hive/contributor.env
image: ghcr.io/projectbluefin/contribute:stable
backend: omp
EOF
  chmod 600 "$fake_home/.config/hive-contribute.yml"

  # Stand in for upstream's recipe: it fails exactly the way
  # contribute-check-backend does when the agent CLI is missing from PATH, and
  # otherwise writes the credential it would have registered.
  cat >"$fake_bin/just" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${JUST_LOG:?}"
# Upstream's recipe registers with $HIVE_HUB when set and asks interactively
# otherwise; record which it was handed.
printf 'hive-hub=%s\n' "${HIVE_HUB:-<unset>}" >>"${JUST_LOG}"
# Exactly what upstream's contribute-check-backend does for this backend.
command -v omp >/dev/null 2>&1 || { echo "ERROR: OMP CLI not found." >&2; exit 1; }
printf 'resolved-omp=%s\n' "$(command -v omp)" >>"${JUST_LOG}"
omp --version >>"${JUST_LOG}" 2>&1 || true
config_dir=""
for arg in "$@"; do
  case "$arg" in config_dir=*) config_dir="${arg#config_dir=}" ;; esac
done
[[ -n "$config_dir" ]] || exit 1
mkdir -p "$config_dir"
printf 'HIVE_REGISTRATION_TOKEN=registered-token\nHIVE_HUB=wss://setup-hub.example.com/contribute\nCONTRIBUTOR_ID=c-registered\n' >"$config_dir/contributor.env"
EOF
  chmod +x "$fake_bin/just"

  cat >"$fake_bin/git" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"rev-parse HEAD"*) printf 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' ;;
esac
exit 0
EOF
  chmod +x "$fake_bin/git"
  # Upstream's setup shells out to these; the launcher must name a missing one
  # up front. Stand them in so the check passes without depending on the host.
  local tool
  for tool in node jq; do
    printf '#!/usr/bin/env bash\nexit 0\n' >"$fake_bin/$tool"
    chmod +x "$fake_bin/$tool"
  done

  local just_log="$scratch/just.log"
  : >"$just_log"

  # A PATH with no agent CLI on it: the appliance's normal target host, and the
  # state a developer machine with omp installed would otherwise hide.
  env -i HOME="$fake_home" XDG_CONFIG_HOME="$fake_home/.config" \
    XDG_STATE_HOME="$fake_home/.local/state" JUST_LOG="$just_log" \
    PATH="$fake_bin:/usr/bin:/bin" \
    "$launcher" setup >/dev/null 2>&1 ||
    fail "setup failed on a host without the agent CLI, which is the appliance's normal state"

  grep -q 'contribute-setup omp' "$just_log" ||
    fail "setup did not invoke upstream contribute-setup"
  grep -q 'packaged in ghcr.io/projectbluefin/contribute:stable' "$just_log" ||
    fail "the host-CLI probe was not answered with the image that runs the agent"
  grep -q 'resolved-omp=.*hive-contribute-shim' "$just_log" ||
    fail "the probe resolved something other than the appliance's shim"
  grep -qF 'hive-hub=wss://setup-hub.example.com/contribute' "$just_log" ||
    fail "the configured hub was not handed to upstream contribute-setup as HIVE_HUB"

  local mode
  mode="$(stat -c '%a' "$fake_home/.config/hive/contributor.env")"
  assert_eq "$mode" "600" "registered credential permission"
  grep -q '^HIVE_REGISTRATION_TOKEN=registered-token$' "$fake_home/.config/hive/contributor.env" ||
    fail "registration produced by setup was not installed"

  # A host missing one of upstream's prerequisites is refused before any
  # network or credential work, by name. /bin is /usr/bin on most hosts, so
  # the PATH here carries only what the launcher needs to read its config;
  # every prerequisite it looks for is a fake or absent.
  rm -f "$fake_bin/jq"
  local minbin="$scratch/minbin" tool_path
  mkdir -p "$minbin"
  for tool in bash sed head; do
    tool_path="$(command -v "$tool")"
    ln -sf "$tool_path" "$minbin/$tool"
  done
  local refusal
  refusal="$(env -i HOME="$fake_home" XDG_CONFIG_HOME="$fake_home/.config" \
    XDG_STATE_HOME="$fake_home/.local/state" JUST_LOG="$just_log" \
    PATH="$fake_bin:$minbin" "$launcher" setup 2>&1 || true)"
  assert_contains "$refusal" "'jq' is required to register with a hive" "missing prerequisite named"

  rm -rf "$minbin"
  rm -f "$fake_bin/just" "$fake_bin/git" "$fake_bin/node"
}

# --- Run all scenarios -------------------------------------------------------

echo "1. Testing config creation and hub seeding..."
test_config_seeding_and_creation || exit 1

echo "2. Testing zero-config bare run: register through upstream, then launch..."
test_zero_config_run_registers_then_launches || exit 1

echo "3. Testing run on krun path..."
test_run_krun_path || exit 1

echo "3b. Testing krun registered with Podman but absent from PATH..."
test_krun_registered_with_podman_but_absent_from_path || exit 1
echo "3c. Testing Podman fallback when krun is unavailable..."
test_run_podman_fallback_without_krun || exit 1

echo "3d. Testing doctor preflight on Podman fallback..."
test_doctor_podman_fallback || exit 1

echo "3e. Testing that a ghcr image failing provenance verification does not run..."
test_run_refuses_unverified_image || exit 1
echo "4. Testing doctor preflight..."
test_doctor_failures_and_success || exit 1
echo "5. Testing setup against upstream's host-CLI preflight..."
test_setup_satisfies_host_cli_probe || exit 1

echo "launcher-contract: all tests passed."
