#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
image=""
size_ceiling_bytes=$((700 * 1024 * 1024))
while (($#)); do
  case "$1" in
  --image)
    image="$2"
    shift 2
    ;;
  *)
    echo "unknown argument: $1" >&2
    exit 2
    ;;
  esac
done
containerfile=image/contribute/Containerfile
fail() {
  echo "contribute-contract: $*" >&2
  exit 1
}
grep -qE '^ARG FSDK_BASE_IMAGE=ghcr\.io/projectbluefin/base:[^@]+@sha256:[0-9a-f]{64}$' "$containerfile" || fail "base must be tag@digest pinned"
grep -qE '^ARG FSDK_BUILDER_IMAGE=ghcr\.io/projectbluefin/lab-runner:[^@]+@sha256:[0-9a-f]{64}$' "$containerfile" || fail "builder must be tag@digest pinned"
for pin in OMP_X86_64_SHA256 OMP_AARCH64_SHA256 NODE_X86_64_SHA256 NODE_AARCH64_SHA256 GH_X86_64_SHA256 GH_AARCH64_SHA256 TMUX_X86_64_SHA256 TMUX_AARCH64_SHA256; do grep -qE "^ARG ${pin}=[0-9a-f]{64}$" "$containerfile" || fail "missing ${pin}"; done
for path in contributor-agent.sh contributor-relay.js pi-backend.js lib/pane-classifier.js; do grep -q "${path}" "$containerfile" || fail "missing Hive runtime ${path}"; done
grep -qF 'ENTRYPOINT ["/usr/local/bin/contribute-entrypoint"]' "$containerfile" || fail "wrong entrypoint"
grep -qF 'WORKDIR /home/bluefin/workspace' "$containerfile" || fail "wrong workdir"
grep -qF 'USER 65532:65532' "$containerfile" || fail "wrong user"
grep -qF 'NODE_PATH=/usr/lib/bluefin/hive/node_modules' "$containerfile" || fail "missing NODE_PATH"
grep -qF 'io.projectbluefin.contribute="true"' "$containerfile" || fail "missing contribute label"
grep -qF 'contribute_image := env("CONTRIBUTE_IMAGE", "ghcr.io/projectbluefin/contribute:stable")' justfile || fail "missing launcher image"
grep -qF '/home/bluefin/.config/hive/contributor.env:ro,z' justfile || fail "missing single registration mount"
grep -qF 'keep-id:uid=65532,gid=65532' justfile || fail "wrong user namespace"
grep -qF 'HIVE_SETUP_BACKEND=omp' justfile || fail "OMP setup not selected"
grep -qF 'AGENT_BACKEND=omp' "$containerfile" || fail "OMP must be the image default backend"
grep -qF 'supports only AGENT_BACKEND=omp' image/contribute/entrypoint.sh || fail "entrypoint must reject alternate backends"
image_hive_commit="$(sed -n 's/^ARG HIVE_COMMIT=//p' "$containerfile")"
launcher_hive_commit="$(sed -n 's/^hive_commit := "\([0-9a-f]\{40\}\)"$/\1/p' justfile)"
[[ -n "$image_hive_commit" && "$image_hive_commit" == "$launcher_hive_commit" ]] || fail "launcher and contributor image must pin the same Hive commit"
if grep -R -nE 'AGENT_MODEL|AGENT_REASONING_EFFORT' justfile image/contribute deploy/contribute.yaml; then
  fail "provider, model, and effort belong to OMP configuration"
fi
[[ ! -d image/tui ]] || fail "legacy Textual UI must not ship"
[[ ! -e image/Containerfile ]] || fail "legacy compatibility image must not ship"
grep -qF 'COPY image/tmux.conf /etc/tmux.conf' "$containerfile" || fail "missing shared tmux.conf (mouse, truecolor, history-limit)"
# Positive control: the attended path must actually show the OMP session in
# the launching terminal instead of leaving the operator staring at relay
# logs with no way to see the agent (the entrypoint used to `exec` straight
# into contributor-agent.sh, unwrapped, with nothing waiting for or attaching
# to the tmux session Hive creates).
entry=image/contribute/entrypoint.sh
# shellcheck disable=SC2016 # the entrypoint source is matched literally, not expanded
grep -q '^/usr/local/bin/contributor-agent.sh "\$@" &$' "$entry" || fail "entrypoint must background contributor-agent.sh so it can wait for and attach to its tmux session"
grep -qF 'tmux has-session -t contributor' "$entry" || fail "entrypoint must wait for the contributor tmux session before attaching"
grep -qF 'tmux attach-session -t contributor' "$entry" || fail "entrypoint must attach the attended terminal to the contributor tmux session"
grep -qF 'attach_pid=' "$entry" || fail "the attach must have explicit PID-1 cleanup ownership"

# --- scripts/generate-contribute-sbom.py unit contract ------------------------
python3 "$root/tests/contribute_sbom_contract.py" || fail "tests/contribute_sbom_contract.py failed"

if [[ -z "$image" ]]; then
  echo "contribute-contract: static contract holds"
  exit 0
fi
engine="${CONTAINER_ENGINE:-podman}"
inspect() { "$engine" image inspect "$image" --format "$1"; }
test "$(inspect '{{.Config.User}}')" = 65532:65532 || fail "image user"
test "$(inspect '{{.Config.WorkingDir}}')" = /home/bluefin/workspace || fail "image workdir"
test "$(inspect '{{json .Config.Entrypoint}}')" = '["/usr/local/bin/contribute-entrypoint"]' || fail "image entrypoint"
# shellcheck disable=SC2016 # the single-quoted $HOME expands inside the container, not this shell
"$engine" run --rm --entrypoint /usr/bin/bash "$image" -c 'set -eu; omp --version; node -e "require.resolve(\"ws\")"; python3 --version >/dev/null; gh --version >/dev/null; tmux -V; git --version >/dev/null; curl --version >/dev/null; find --version >/dev/null; grep --version >/dev/null; sed --version >/dev/null; cmp --version >/dev/null; test -w "$HOME"; test -w "$HOME/workspace"; test -f /usr/local/bin/contributor-relay.js; test -f /usr/local/bin/pi-backend.js; test -f /usr/local/bin/lib/pane-classifier.js; test ! -e /usr/bin/npm; test ! -e /usr/bin/corepack' >/dev/null || fail "runtime closure"
if "$engine" run --rm --env AGENT_BACKEND=goose "$image" >/dev/null 2>&1; then
  fail "alternate agent backends must be rejected"
fi
size="$($engine history --format json "$image" | python3 -c 'import json,sys; print(sum(int(x.get("size") or 0) for x in json.load(sys.stdin)))')"
[[ "$size" =~ ^[0-9]+$ ]] || fail "could not measure image size"
((size <= size_ceiling_bytes)) || fail "contribute image is $((size / 1024 / 1024)) MiB, over the $((size_ceiling_bytes / 1024 / 1024)) MiB ceiling"
echo "contribute-contract: runtime contract holds ($((size / 1024 / 1024)) MiB)"
