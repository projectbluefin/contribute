#!/usr/bin/env bash
# Hermetic behavior contract for the root launcher. External tools are faked;
# this test never contacts GitHub, a registry, Podman, or Kubernetes.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
real_just="$(command -v just)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
home="$scratch/home"
fake_bin="$scratch/bin"
podman_log="$scratch/podman.log"
kubectl_log="$scratch/kubectl.log"
apptainer_log="$scratch/apptainer.log"
kvm="$scratch/kvm"
mkdir -p "$home/.config/hive" "$fake_bin"
touch "$kvm"
chmod 0666 "$kvm"
cat >"$home/.config/hive/contributor.env" <<'EOF'
HIVE_REGISTRATION_TOKEN=test-registration
HIVE_HUB=https://hive.example.test
CONTRIBUTOR_USERNAME=test-user
EOF
chmod 0600 "$home/.config/hive/contributor.env"
cat >"$fake_bin/gh" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-} ${2:-}" == "auth status" ]] && exit 0
exit 1
EOF
cat >"$fake_bin/podman" <<'EOF'
#!/usr/bin/env bash
set -eu
[[ "${1:-}" == info ]] && { [[ "${FAKE_PODMAN_INFO_FAIL:-0}" != 1 ]]; exit; }
printf '%s\n' "$*" >>"${PODMAN_LOG:?}"
case "${1:-} ${2:-} ${3:-}" in
  "system connection list") exit 0 ;;
  "image exists "*) exit 0 ;;
  "pull "*) exit 0 ;;
  "inspect --format "*) printf 'false\n'; exit 0 ;;
  "container exists "*) exit 1 ;;
  "run "*) exit 17 ;;
esac
exit 0
EOF
cat >"$fake_bin/apptainer" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${APPTAINER_LOG:?}"
exit 18
EOF
cat >"$fake_bin/kubectl" <<'EOF'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >>"${KUBECTL_LOG:?}"
case "$*" in
  "create namespace bluefin-system --dry-run=client -o yaml") printf 'apiVersion: v1\nkind: Namespace\n' ;;
  "create secret generic contribute-secret "*) printf 'apiVersion: v1\nkind: Secret\n' ;;
  "apply "*) cat >/dev/null ;;
  "get secret contribute-secret "*) : ;;
  "get deployment contribute -n bluefin-system") : ;;
esac
exit 0
EOF
cat >"$fake_bin/krun" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$fake_bin/gh" "$fake_bin/podman" "$fake_bin/kubectl" "$fake_bin/krun" "$fake_bin/apptainer"

failures=0
scenario=startup
fail() {
  printf 'FAIL [%s]: %s\n' "$scenario" "$1" >&2
  failures=$((failures + 1))
}
contains() { grep -Fq -- "$1" <<<"$2" || fail "expected output to contain: $1"; }
not_contains() {
  grep -Fq -- "$1" <<<"$2" && fail "expected output not to contain: $1"
  return 0
}
log_contains() { grep -Fq -- "$1" "$2" || fail "expected $2 to contain: $1"; }
log_not_contains() {
  grep -Fq -- "$1" "$2" && fail "expected $2 not to contain: $1"
  return 0
}
run_just() {
  : >"$podman_log"
  : >"$kubectl_log"
  set +e
  output="$(env HOME="$home" PATH="$fake_bin:/usr/bin:/bin" PODMAN_LOG="$podman_log" KUBECTL_LOG="$kubectl_log" REVIEW_TEST_KVM_DEVICE="$kvm" REVIEW_GH_TOKEN=test-gh-token TERM=xterm-256color "$real_just" --justfile "$root/justfile" "$@" 2>&1)"
  status=$?
  set -e
}

scenario="public recipes"
recipes="$($real_just --justfile "$root/justfile" --list)"
for recipe in contribute review-container review-queue review-appliance review-appliance-build review-stop review-doctor; do
  contains "$recipe" "$recipes"
done

scenario="doctor verifies the KVM runtime"
run_just review-doctor
[[ "$status" -eq 0 ]] || fail "review-doctor failed: $output"
contains 'Podman krun KVM runtime ready' "$output"
scenario="contribute launches the OMP worker"
run_just contribute
[[ "$status" -eq 17 ]] || fail "expected fake container exit 17, got $status"
log_contains 'run --runtime=krun --rm --interactive --tty --name bluefin-contribute-' "$podman_log"
log_contains '--userns keep-id:uid=65532,gid=65532' "$podman_log"
log_contains "$home/.config/hive/contributor.env:/home/bluefin/.config/hive/contributor.env:ro,z" "$podman_log"
log_contains ':/home/bluefin:rw' "$podman_log"
log_contains '--env AGENT_BACKEND=omp' "$podman_log"
log_contains 'ghcr.io/projectbluefin/contribute:stable' "$podman_log"
log_not_contains 'AGENT_MODEL' "$podman_log"
log_not_contains 'AGENT_REASONING_EFFORT' "$podman_log"
log_not_contains 'test-gh-token' "$podman_log"

scenario="review-container is the same worker"
run_just review-container
[[ "$status" -eq 17 ]] || fail "expected fake container exit 17, got $status"
log_contains 'run --runtime=krun --rm --interactive --tty --name bluefin-contribute-' "$podman_log"
log_contains 'ghcr.io/projectbluefin/contribute:stable' "$podman_log"

scenario="contributor instance names select independent state"
cp "$home/.config/hive/contributor.env" "$home/.config/hive/contributor.org-one.env"
cp "$home/.config/hive/contributor.env" "$home/.config/hive/contributor.org-two.env"
run_just contribute org/one
one_call="$(cat "$podman_log")"
run_just contribute org/two
two_call="$(cat "$podman_log")"
[[ "$one_call" != "$two_call" ]] || fail "different contributor instances must not collide"
[[ "$one_call" == *"contributor.org-one.env:/home/bluefin/.config/hive/contributor.env:ro,z"* ]] || fail "first contributor used the wrong registration"
[[ "$two_call" == *"contributor.org-two.env:/home/bluefin/.config/hive/contributor.env:ro,z"* ]] || fail "second contributor used the wrong registration"

scenario="detached workers are rejected"
set +e
output="$(env HOME="$home" PATH="$fake_bin:/usr/bin:/bin" PODMAN_LOG="$podman_log" KUBECTL_LOG="$kubectl_log" REVIEW_TEST_KVM_DEVICE="$kvm" REVIEW_GH_TOKEN=test-gh-token REVIEW_DETACH=1 "$real_just" --justfile "$root/justfile" contribute 2>&1)"
status=$?
set -e
[[ "$status" -ne 0 ]] || fail "detached launch must fail"
contains 'detached contributor containers are not supported' "$output"

scenario="KVM preflight failure falls back to Apptainer"
: >"$apptainer_log"
set +e
output="$(env HOME="$home" PATH="$fake_bin:/usr/bin:/bin" PODMAN_LOG="$podman_log" KUBECTL_LOG="$kubectl_log" APPTAINER_LOG="$apptainer_log" REVIEW_TEST_KVM_DEVICE="$kvm" REVIEW_GH_TOKEN=test-gh-token FAKE_PODMAN_INFO_FAIL=1 "$real_just" --justfile "$root/justfile" review-queue owner/repo 2>&1)"
status=$?
set -e
[[ "$status" -eq 18 ]] || fail "expected fake Apptainer exit 18, got $status"
contains 'using the isolated Apptainer fallback' "$output"
log_contains 'run --containall' "$apptainer_log"

scenario="review-queue delegates to the OMP appliance"
run_just review-queue --issues
[[ "$status" -eq 17 ]] || fail "expected fake container exit 17, got $status"
log_contains 'run --runtime=krun --rm --interactive --tty --name bluefin-review-' "$podman_log"
log_contains 'ghcr.io/projectbluefin/review:stable --issues' "$podman_log"

scenario="review repositories use independent microVM state"
run_just review-queue owner/repo
one_review_call="$(cat "$podman_log")"
run_just review-queue owner/repo2
two_review_call="$(cat "$podman_log")"
[[ "$one_review_call" == *"bluefin-review-review-owner-repo-"* ]] || fail "first review instance was not scope-named"
[[ "$two_review_call" == *"bluefin-review-review-owner-repo2-"* ]] || fail "second review instance was not scope-named"
[[ "$one_review_call" != "$two_review_call" ]] || fail "different review targets must not collide"
log_not_contains 'ghcr.io/projectbluefin/contribute' "$podman_log"

scenario="cluster scale uses the one contributor deployment"
run_just contribute cluster 3
[[ "$status" -eq 0 ]] || fail "cluster scale failed: $output"
log_contains 'apply -f deploy/contribute.yaml' "$kubectl_log"
log_contains 'set env deployment/contribute -n bluefin-system AGENT_BACKEND=omp HIVE_HUB=https://hive.example.test' "$kubectl_log"
log_contains 'scale deployment/contribute -n bluefin-system --replicas=3' "$kubectl_log"
log_contains 'rollout status deployment/contribute -n bluefin-system --timeout=15s' "$kubectl_log"
log_not_contains 'test-gh-token' "$kubectl_log"

scenario="review-container cluster delegates to the same deployment"
run_just review-container cluster 2
[[ "$status" -eq 0 ]] || fail "cluster alias failed: $output"
log_contains 'scale deployment/contribute -n bluefin-system --replicas=2' "$kubectl_log"

scenario="review-stop stops only cluster workers"
run_just review-stop cluster
[[ "$status" -eq 0 ]] || fail "cluster stop failed: $output"
log_contains 'get deployment contribute -n bluefin-system' "$kubectl_log"
log_contains 'scale deployment/contribute -n bluefin-system --replicas=0' "$kubectl_log"

if ((failures)); then
  printf 'just-onboarding: %d failure(s)\n' "$failures" >&2
  exit 1
fi
printf 'just-onboarding: OMP-only launcher contract holds\n'
