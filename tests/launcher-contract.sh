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
podman_env_log="$scratch/podman-env.log"
curl_log="$scratch/curl.log"
curl_stdin_log="$scratch/curl-stdin.log"
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
if [[ "\${1:-}" == info ]]; then
  [[ "\${FAKE_PODMAN_INFO_FAIL:-0}" != 1 ]] || exit 1
  # Whether this host can carry the loopback transport at all. Unset FAKE
  # variable = slirp4netns present; set-but-empty = Podman reports none.
  if [[ "\${2:-}" == --format && "\${3:-}" == *Slirp4NetNS* ]]; then
    printf '%s\n' "\${FAKE_PODMAN_SLIRP-/usr/bin/slirp4netns}"
  fi
  exit 0
fi
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
    printf 'image exists %s\n' "\${*:3}" >>"$podman_log"
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
    # \`--env NAME\` resolves from THIS process's environment, so what Podman
    # sees here is exactly what the container would receive. Recording it is
    # the only way to prove a by-name forward carried the right value.
    printf 'OPENAI_API_KEY=%s\n' "\${OPENAI_API_KEY-<unset>}" >>"$podman_env_log"
    printf 'OPENAI_BASE_URL=%s\n' "\${OPENAI_BASE_URL-<unset>}" >>"$podman_env_log"
    printf 'LLMMAN_MODEL=%s\n' "\${LLMMAN_MODEL-<unset>}" >>"$podman_env_log"
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
case " \$* " in
  *" --config - "*) cat >>"$curl_stdin_log" ;;
esac
if [[ "\${FAKE_LLMMAN_UNREACHABLE:-0}" == 1 ]]; then
  echo "curl: (7) Failed to connect to 127.0.0.1 port 17434" >&2
  exit 7
fi
if [[ -n "\${FAKE_LLMMAN_STATUS:-}" ]]; then
  printf '%s' "\${FAKE_LLMMAN_BODY:-}"
  printf '\n%s' "\${FAKE_LLMMAN_STATUS}"
fi
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
  unset HIVE_CONTRIBUTE_TEST_OS
  unset HUB REGISTRATION IMAGE BACKEND
  unset GH_TOKEN GITHUB_TOKEN
  unset FAKE_PODMAN_INFO_FAIL FAKE_PODMAN_REMOTE FAKE_PODMAN_PULL_FAIL FAKE_PODMAN_IMAGE_EXISTS FAKE_PODMAN_NO_KRUN
  unset FAKE_PODMAN_RUN_STATUS
  unset FAKE_GH_AUTH_STATUS_FAIL FAKE_GH_TOKEN_FAIL FAKE_GH_TOKEN_VALUE
  unset FAKE_GH_ATTESTATION_FAIL HIVE_CONTRIBUTE_NO_VERIFY
  unset FAKE_PODMAN_SLIRP FAKE_LLMMAN_UNREACHABLE FAKE_LLMMAN_STATUS FAKE_LLMMAN_BODY
  unset OPENAI_API_KEY OPENAI_BASE_URL LLMMAN_MODEL
  rm -rf "${fake_home:?}"
  mkdir -p "$fake_home" "$fake_home/.config"
  cat >"$fake_bin/krun" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$fake_bin/krun"
  : >"$podman_log"
  : >"$podman_env_log"
  : >"$curl_log"
  : >"$curl_stdin_log"
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

  # Never mounts credential / no container run recorded. The image probe is the
  # only podman call doctor may make, and it must be recorded so the non-Linux
  # scenario below can prove doctor skips podman entirely.
  assert_eq "$(grep -cE '^(run|pull|save) ' "$podman_log" || true)" "0" "doctor must never run podman"
  assert_contains "$(cat "$podman_log")" "image exists" "doctor probes the local image cache on a Linux host"
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

# -----------------------------------------------------------------------------
# Scenario 6: non-Linux host contract (#646). When run on macOS or Windows,
#             doctor and run must name the platform requirement and Lima/WSL2
#             remediation rather than failing on remote or missing container engines.
# -----------------------------------------------------------------------------
test_non_linux_host_rejection() {
  clean_env
  export HIVE_CONTRIBUTE_TEST_OS="Darwin"

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

  # 1. `run` fails with platform requirement message
  set +e
  local run_output run_status
  run_output="$("$launcher" run 2>&1)"
  run_status=$?
  set -e
  [[ "$run_status" -ne 0 ]] || fail "run must fail on non-Linux host"
  assert_contains "$run_output" "this appliance requires a Linux host; on macOS use Lima, on Windows use WSL2" "run names platform requirement"
  assert_eq "$(cat "$podman_log")" "" "no podman run recorded on non-Linux host"

  # 2. `doctor` fails with platform requirement message
  export FAKE_GH_TOKEN_VALUE="fake-doctor-gh-token"
  set +e
  local doc_output doc_status
  doc_output="$("$launcher" doctor 2>&1)"
  doc_status=$?
  set -e
  [[ "$doc_status" -ne 0 ]] || fail "doctor must fail on non-Linux host"
  assert_contains "$doc_output" "this appliance requires a Linux host; on macOS use Lima, on Windows use WSL2" "doctor names platform requirement"
  assert_eq "$(cat "$podman_log")" "" "doctor must never run podman on non-Linux host"

  # 3. Windows (MINGW) host behaves identically
  export HIVE_CONTRIBUTE_TEST_OS="MINGW64_NT-10.0"
  set +e
  local win_output win_status
  win_output="$("$launcher" run 2>&1)"
  win_status=$?
  set -e
  [[ "$win_status" -ne 0 ]] || fail "run must fail on Windows host"
  assert_contains "$win_output" "this appliance requires a Linux host; on macOS use Lima, on Windows use WSL2" "Windows run names platform requirement"

  # 4. `setup` fails with platform requirement message
  set +e
  local setup_output setup_status
  setup_output="$("$launcher" setup 2>&1)"
  setup_status=$?
  set -e
  [[ "$setup_status" -ne 0 ]] || fail "setup must fail on non-Linux host"
  assert_contains "$setup_output" "this appliance requires a Linux host; on macOS use Lima, on Windows use WSL2" "setup names platform requirement"
}

# A registered, configured machine. `extra` is appended to the config file, so
# each scenario below states only the llmman keys it is about.
seed_configured_machine() {
  local extra="${1:-}"
  local config_file="$fake_home/.config/hive-contribute.yml"
  mkdir -p "$fake_home/.config/hive"
  cat >"$config_file" <<EOF
hub: wss://hub.example.com/contribute
registration: $fake_home/.config/hive/contributor.env
image: ghcr.io/projectbluefin/contribute:stable
backend: omp
${extra}
EOF
  chmod 600 "$config_file"
  printf 'HIVE_HUB=wss://hub.example.com/contribute\nHIVE_REGISTRATION_TOKEN=t\nCONTRIBUTOR_ID=c\n' \
    >"$fake_home/.config/hive/contributor.env"
  chmod 600 "$fake_home/.config/hive/contributor.env"
  export FAKE_GH_TOKEN_VALUE="fake-doctor-gh-token"
}

# 7. Local inference stays off until explicitly configured: cloud provider
# keys are forwarded untouched, no loopback transport or URL override is
# applied, and doctor does not require a local daemon.
test_local_inference_off_by_default() {
  clean_env
  export OPENAI_API_KEY="test-openai-cloud-key"
  seed_configured_machine ""

  "$launcher" run >/dev/null
  local run_cmd
  run_cmd="$(grep '^run ' "$podman_log")"
  assert_not_contains "$run_cmd" "--network" "no slirp4netns mode without llmman"
  assert_not_contains "$run_cmd" "OPENAI_BASE_URL" "no base URL forward without llmman"
  assert_contains "$(cat "$podman_env_log")" "OPENAI_API_KEY=test-openai-cloud-key" \
    "cloud OpenAI key is passed untouched"

  local doc_out
  doc_out="$("$launcher" doctor 2>&1)"
  assert_contains "$doc_out" "Local inference" "doctor has a local inference section"
  assert_contains "$doc_out" "not selected; the worker uses whichever cloud provider you configured" \
    "doctor reports local inference not selected"
}

# 8. Local inference opt-in: loopback endpoint gets slirp4netns host loopback,
# rewrites to 10.0.2.2, forwards OPENAI_BASE_URL, passes LLMMAN_MODEL, and
# replaces OPENAI_API_KEY with the token file's value. Cloud key is NOT forwarded.
test_local_inference_loopback_opt_in() {
  clean_env
  local token_file="$fake_home/.config/llmman.token"
  printf 'not-a-real-llmman-key\n' >"$token_file"
  chmod 600 "$token_file"
  export OPENAI_API_KEY="not-a-real-cloud-openai-key"

  seed_configured_machine "llmman: http://127.0.0.1:17434/v1
llmman_token: $token_file
llmman_model: qwen3-coder-30b"

  local output
  output="$("$launcher" run)"
  assert_contains "$output" "local inference: http://10.0.2.2:17434/v1 over slirp4netns host loopback" \
    "local inference is announced"
  assert_contains "$output" "authenticated from ${token_file}" "token source is announced"
  assert_contains "$output" "model: qwen3-coder-30b (the OpenAI cloud slot is repurposed; other configured providers remain)" \
    "configured model is named in banner"

  local run_cmd
  run_cmd="$(grep '^run ' "$podman_log")"
  assert_contains "$run_cmd" "--network slirp4netns:allow_host_loopback=true" "loopback network mode"
  assert_contains "$run_cmd" "--env OPENAI_BASE_URL=http://10.0.2.2:17434/v1" "container URL passed by value"
  assert_contains "$run_cmd" "--env LLMMAN_MODEL=qwen3-coder-30b" "model selection passed to container"

  # OPENAI_API_KEY must cross by name, not by value, carrying the token from the
  # file and NOT the cloud key. The fake podman dumped its environment; check
  # that the value that reached the child process is the one from the local
  # file and not a value from anyone's argv.
  assert_contains "$(cat "$podman_env_log")" "OPENAI_API_KEY=not-a-real-llmman-key" \
    "the llmman key is what the container receives"
  assert_contains "$(cat "$podman_env_log")" "LLMMAN_MODEL=qwen3-coder-30b" \
    "the model name is in the container environment"
  assert_not_contains "$run_cmd" "not-a-real-llmman-key" "llmman key value in argv"
  assert_not_contains "$run_cmd" "not-a-real-cloud-openai-key" "cloud key value in argv"

  # The isolation boundary is exactly what it was.
  assert_contains "$run_cmd" "--userns keep-id:uid=65532,gid=65532" "userns unchanged"
  assert_contains "$run_cmd" "--volume $fake_home/.config/hive/contributor.env:/home/hive/.config/hive/contributor.env:ro,z" \
    "registration still mounted read-only"
  assert_not_contains "$run_cmd" "--volume $fake_home:" "the host home must never be mounted"
  assert_not_contains "$run_cmd" "--network=host" "the host network namespace must never be shared"
  assert_not_contains "$run_cmd" "--privileged" "no privileged container"
  assert_not_contains "$run_cmd" "--publish" "the appliance publishes no port of its own"
  assert_eq "$(cat "$curl_log")" "" "run must not probe the endpoint; that is doctor's job"

  # Unauthenticated is supported, and the operator's cloud key still must not
  # be what talks to a local daemon.
  : >"$podman_log"
  : >"$podman_env_log"
  sed -i "\|^llmman_token: |d" "$fake_home/.config/hive-contribute.yml"
  output="$("$launcher" run)"
  assert_contains "$output" "unauthenticated: no llmman_token is configured" "unauthenticated state is stated"
  assert_contains "$(cat "$podman_env_log")" "OPENAI_API_KEY=llmman-local" \
    "an unauthenticated endpoint receives the appliance placeholder, not the cloud key"
}

# An endpoint reached over the network needs no transport of ours, and a
# malformed one must stop before a container exists.
test_local_inference_network_endpoint_and_bad_url() {
  clean_env
  seed_configured_machine "llmman: https://ai.lan.example:17434/v1"

  "$launcher" run >/dev/null
  local run_cmd
  run_cmd="$(grep '^run ' "$podman_log")"
  assert_not_contains "$run_cmd" "--network" "a routable endpoint needs no special network mode"
  assert_contains "$run_cmd" "--env OPENAI_BASE_URL=https://ai.lan.example:17434/v1" "URL passed through verbatim"

  clean_env
  seed_configured_machine "llmman: http://127.0.0.1.nip.io:17434/v1"
  "$launcher" run >/dev/null
  run_cmd="$(grep '^run ' "$podman_log")"
  assert_not_contains "$run_cmd" "--network" "a DNS host starting with 127 is not loopback"
  assert_contains "$run_cmd" "--env OPENAI_BASE_URL=http://127.0.0.1.nip.io:17434/v1" "DNS URL passed through verbatim"

  clean_env
  seed_configured_machine "llmman: 127.0.0.1:17434"
  local output status=0
  output="$("$launcher" run 2>&1)" || status=$?
  [[ "$status" -ne 0 ]] || fail "a malformed llmman endpoint must not start a worker"
  assert_contains "$output" "is not an http:// or https:// base URL" "malformed endpoint named"
  assert_eq "$(grep -c '^run ' "$podman_log" || true)" "0" "no container started for a malformed endpoint"
}

# doctor answers reachability, authentication, and model availability before a
# worker exists, because the alternative is discovering a dead endpoint as a
# failed assignment.
test_doctor_verifies_local_endpoint() {
  local models_body='{"object":"list","data":[{"id":"qwen3-coder-30b","object":"model"},{"id":"gemma3-12b","object":"model"}]}'
  local token_file

  # Healthy: reachable, authenticated, serving the configured model.
  clean_env
  token_file="$fake_home/.config/llmman.token"
  seed_configured_machine "llmman: http://127.0.0.1:17434/v1
llmman_token: $token_file
llmman_model: qwen3-coder-30b"
  printf 'not-a-real-llmman-key\n' >"$token_file"
  chmod 600 "$token_file"
  export FAKE_LLMMAN_STATUS=200
  export FAKE_LLMMAN_BODY="$models_body"

  local output status=0
  output="$("$launcher" doctor 2>&1)" || status=$?
  assert_eq "$status" "0" "doctor passes against a healthy llmman endpoint"
  assert_contains "$output" "http://127.0.0.1:17434/v1 (the container reaches it as http://10.0.2.2:17434/v1)" \
    "doctor reports both sides of the transport"
  assert_contains "$output" "transport: slirp4netns host loopback" "doctor names the transport"
  assert_contains "$output" "key read from ${token_file}" "doctor reports the key source"
  assert_contains "$output" "answered and accepted this identity" "doctor reports reachability and auth"
  assert_contains "$output" "qwen3-coder-30b is loaded there" "doctor reports model availability"
  assert_not_contains "$output" "not-a-real-llmman-key" "doctor must never print the key"
  assert_eq "$(grep -cE '^(run|pull|save) ' "$podman_log" || true)" "0" "doctor must never run podman"
  # The key travelled to curl on stdin, never on a command line.
  grep -qF 'Authorization: Bearer not-a-real-llmman-key' "$curl_stdin_log" ||
    fail "doctor did not authenticate its probe"
  assert_not_contains "$(cat "$curl_log")" "not-a-real-llmman-key" "probe key in curl argv"

  # Rejected key.
  export FAKE_LLMMAN_STATUS=401
  export FAKE_LLMMAN_BODY=""
  status=0
  output="$("$launcher" doctor 2>&1)" || status=$?
  [[ "$status" -ne 0 ]] || fail "doctor must fail when the endpoint rejects the key"
  assert_contains "$output" "refused this identity (HTTP 401)" "doctor reports an authentication failure"

  # Unreachable daemon.
  unset FAKE_LLMMAN_STATUS FAKE_LLMMAN_BODY
  export FAKE_LLMMAN_UNREACHABLE=1
  status=0
  output="$("$launcher" doctor 2>&1)" || status=$?
  [[ "$status" -ne 0 ]] || fail "doctor must fail when the endpoint does not answer"
  assert_contains "$output" "did not answer" "doctor reports unreachability"
  unset FAKE_LLMMAN_UNREACHABLE

  # Reachable, but not serving the model the operator asked for.
  export FAKE_LLMMAN_STATUS=200
  export FAKE_LLMMAN_BODY='{"data":[{"id":"gemma3-12b"}]}'
  status=0
  output="$("$launcher" doctor 2>&1)" || status=$?
  [[ "$status" -ne 0 ]] || fail "doctor must fail when the configured model is absent"
  assert_contains "$output" "qwen3-coder-30b is not loaded; it serves: gemma3-12b" "doctor names what is served"

  # A key file the operator pointed at but never created.
  export FAKE_LLMMAN_BODY="$models_body"
  rm -f "$token_file"
  status=0
  output="$("$launcher" doctor 2>&1)" || status=$?
  [[ "$status" -ne 0 ]] || fail "doctor must fail on a missing key file"
  assert_contains "$output" "does not exist" "doctor names the missing key file"

  # The transport itself missing: slirp4netns is what carries the loopback
  # route, and Podman is the one that knows whether it is there.
  printf 'not-a-real-llmman-key\n' >"$token_file"
  chmod 600 "$token_file"
  export FAKE_PODMAN_SLIRP=""
  status=0
  output="$("$launcher" doctor 2>&1)" || status=$?
  [[ "$status" -ne 0 ]] || fail "doctor must fail when the loopback transport is unavailable"
  assert_contains "$output" "needs slirp4netns" "doctor names the missing transport"
  unset FAKE_PODMAN_SLIRP
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
echo "6. Testing non-Linux host rejection..."
test_non_linux_host_rejection || exit 1
echo "7. Testing that local inference stays off until it is selected..."
test_local_inference_off_by_default || exit 1

echo "8. Testing the explicit loopback llmman opt-in..."
test_local_inference_loopback_opt_in || exit 1

echo "9. Testing a routable llmman endpoint and a malformed one..."
test_local_inference_network_endpoint_and_bad_url || exit 1

echo "10. Testing doctor's llmman reachability, authentication, and model checks..."
test_doctor_verifies_local_endpoint || exit 1

echo "launcher-contract: all tests passed."
