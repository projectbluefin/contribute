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
launcher=bin/hive-contribute
entry=image/contribute/entrypoint.sh

fail() {
  echo "contribute-contract: $*" >&2
  exit 1
}

# --- Static Containerfile and launcher contract ------------------------------
grep -qE '^ARG FSDK_BASE_IMAGE=[^@]+@sha256:[0-9a-f]{64}$' "$containerfile" || fail "base must be tag@digest pinned"
grep -qE '^ARG FSDK_BUILDER_IMAGE=[^@]+@sha256:[0-9a-f]{64}$' "$containerfile" || fail "builder must be tag@digest pinned"
for pin in OMP_X86_64_SHA256 OMP_AARCH64_SHA256 NODE_X86_64_SHA256 NODE_AARCH64_SHA256 GH_X86_64_SHA256 GH_AARCH64_SHA256 TMUX_X86_64_SHA256 TMUX_AARCH64_SHA256; do
  grep -qE "^ARG ${pin}=[0-9a-f]{64}$" "$containerfile" || fail "missing ${pin}"
done

# Upstream Hive tracking. The Containerfile no longer names a branch: it takes a
# resolved SHA and refuses to build without one, so the tracking lives in the
# callers. Assert both halves, or provenance silently degrades to an empty label.
grep -qF 'HIVE_COMMIT is required' "$containerfile" ||
  fail "the build must refuse to run without a resolved HIVE_COMMIT"
! grep -qE '^ARG HIVE_REF' "$containerfile" ||
  fail "HIVE_REF is no longer wired to anything; a settable arg that changes nothing is a lie"
for caller in justfile .github/workflows/publish-contribute.yml .github/workflows/validate.yml; do
  grep -qF 'refs/heads/v5' "$caller" || fail "${caller} does not resolve Hive's tracking branch"
  grep -qF 'HIVE_COMMIT' "$caller" || fail "${caller} does not pass the resolved commit to the build"
done
grep -qF '/out/usr/share/hive/contribute/HIVE_COMMIT' "$containerfile" || fail "build must write resolved commit to HIVE_COMMIT"

# The upstream runtime this image carries: the relay, the agent script, the
# helpers the relay requires, the backend table, and Hive's `gh` policy layer.
# `bin/lib/` is named as a subtree rather than by file — that is what keeps a
# module upstream adds from going missing. The runtime closure check below
# asserts pane-classifier.js actually landed in the built image.
# omp-backend.js is deliberately absent — it is a host-side staging helper for
# `just contribute-hive`, and upstream's own contributor image does not ship it.
for path in contributor-agent.sh contributor-relay.js pi-backend.js bin/lib/ backends.conf gh-wrapper.sh contributor-default.json; do
  grep -q "${path}" "$containerfile" || fail "missing Hive runtime ${path}"
done
! grep -qF 'bin/omp-backend.js' "$containerfile" ||
  fail "omp-backend.js is a host-side staging helper and must not be in the image closure"

# Hive's gh policy layer. The wrapper has to BE `gh` on the agent's PATH with
# the real binary at upstream's own REAL_GH default, and contributor mode has
# to be the root-owned marker file rather than an environment variable the
# agent could set for itself.
# shellcheck disable=SC2016 # matched literally against the Containerfile, not expanded here
grep -qF -- 'install -m 0755 "$workdir/hive/bin/gh-wrapper.sh" /out/usr/bin/gh;' "$containerfile" ||
  fail "Hive's gh wrapper must be installed as the agent's gh"
grep -qF 'mv /out/usr/bin/gh /out/opt/hive/bin/gh-real' "$containerfile" ||
  fail "the real gh binary must be staged at the wrapper's REAL_GH default"
grep -qF ': > /out/etc/hive/contributor-mode' "$containerfile" ||
  fail "the image must carry the root-owned contributor-mode marker"

# Hive-generic image identity, user, workdir, entrypoint, node path
grep -qF 'ENTRYPOINT ["/usr/local/bin/hive-contribute"]' "$containerfile" || fail "wrong entrypoint"

# The guest home is a contract between the launcher and the image, and it is
# named once, here. The launcher mounts persistent state, the working
# directory, and the read-only registration under it; the image resolves HOME
# and both XDG roots from it. Renaming it on one side only does not fail a
# launch — it produces an attended session whose configuration writes land on
# a read-only layer and whose registration Hive's agent never finds — so every
# reference is checked against the path the launcher actually mounts.
guest_home="$(sed -nE 's/^.*--volume "hive-contribute-\$\{slug\}:([^:]+):rw".*$/\1/p' "$launcher" | head -1)"
[[ "$guest_home" == /* ]] || fail "the launcher mounts no persistent guest home"
grep -qF "WORKDIR ${guest_home}/workspace" "$containerfile" || fail "wrong workdir"
# shellcheck disable=SC2016 # launcher source is matched literally, not expanded
grep -qF -- "--volume \"\${REGISTRATION}:${guest_home}/.config/hive/contributor.env:ro,z\"" "$launcher" ||
  fail "the Podman registration mount is not inside ${guest_home}"
grep -qF 'USER 65532:65532' "$containerfile" || fail "wrong user"
grep -qF 'NODE_PATH=/usr/lib/hive/node_modules' "$containerfile" || fail "missing NODE_PATH"
grep -qF 'io.hivecommons.contribute="true"' "$containerfile" || fail "missing contribute label"
# shellcheck disable=SC2016 # matched literally in the Containerfile
# The RESOLVED COMMIT, not the branch. AGENTS.md records this label as where
# the SHA is stamped, and a label reading "v5" cannot tell two images built a
# month apart from each other.
grep -qF 'io.hivecommons.contribute.hive.ref="${HIVE_COMMIT}"' "$containerfile" ||
  fail "the hive.ref label must carry the resolved commit, not the branch"
grep -qE '^ARG FSDK_BASE_IMAGE HIVE_COMMIT ' "$containerfile" ||
  fail "the final stage must redeclare HIVE_COMMIT or its label ships empty"

# Every Hive file comes from ONE commit-addressed archive: the image is meant
# to BE upstream at a commit, and seven per-file requests describe a snapshot
# rather than being one. `bin/lib/` in particular has to arrive as a directory,
# because upstream's image does `COPY bin/lib/` and naming a file inside it
# would silently drop a module upstream added — a break that would surface at
# task time, inside a running contributor session.
# shellcheck disable=SC2016 # ${hive_commit} is matched literally in the Containerfile, not expanded here
grep -qF 'codeload.github.com/hivecommons/hive/tar.gz/${hive_commit}' "$containerfile" ||
  fail "Hive's runtime must be staged from a commit-addressed archive"
! grep -qF 'raw.githubusercontent.com/hivecommons/hive' "$containerfile" ||
  fail "Hive files must come from the single archive, not per-file fetches"
# shellcheck disable=SC2016 # matched literally against the Containerfile, not expanded here
grep -qF -- 'cp -a "$workdir/hive/bin/lib/." /out/usr/local/bin/lib/' "$containerfile" ||
  fail "bin/lib/ must be staged as a directory, not file by file"
grep -qF 'bin/lib/ staged empty' "$containerfile" ||
  fail "an empty bin/lib/ must fail the build rather than ship a runtime without it"

# Launcher defaults and settings
grep -qF 'DEFAULT_IMAGE="ghcr.io/projectbluefin/contribute:stable"' "$launcher" || fail "missing default image in launcher"
grep -qF 'DEFAULT_BACKEND="omp"' "$launcher" || fail "missing default backend in launcher"
grep -qF 'keep-id:uid=65532,gid=65532' "$launcher" || fail "wrong user namespace in launcher"
grep -qF 'AGENT_BACKEND=omp' "$containerfile" || fail "OMP must be the image default backend"
grep -qF 'supports only AGENT_BACKEND=omp' "$entry" || fail "entrypoint must reject alternate backends"

# Model and effort must not be hardcoded
if grep -R -nE 'AGENT_MODEL|AGENT_REASONING_EFFORT' "$launcher" image/contribute; then
  fail "provider, model, and effort belong to OMP configuration"
fi

[[ ! -d image/tui ]] || fail "legacy Textual UI must not ship"
[[ ! -e image/Containerfile ]] || fail "legacy compatibility image must not ship"

# Tmux configuration and locale
grep -qF 'COPY image/tmux.conf /etc/tmux.conf' "$containerfile" || fail "missing shared tmux.conf"
grep -qF 'set -g default-terminal "tmux-256color"' image/tmux.conf || fail "contributor panes must advertise tmux-256color"
grep -qF 'tmux_fallback_term=xterm-256color' "$entry" || fail "contributor attach fallback must match xterm-256color"
grep -qE '^ +LANG=C\.UTF-8 \\$' "$containerfile" || fail "contributor image must default to UTF-8 locale"

# OMP overlay settings
grep -qF 'COPY image/contribute/config.yml /usr/share/hive/contribute/omp-config.yml' "$containerfile" ||
  fail "contributor image must ship its OMP settings overlay"
grep -qE '^ +PI_CONFIG_FILES=/usr/share/hive/contribute/omp-config\.yml \\$' "$containerfile" ||
  fail "contributor image must load its OMP settings overlay through PI_CONFIG_FILES"
grep -qF 'symbolPreset: nerd' image/contribute/config.yml || fail "contributor overlay must select the Nerd Font symbol preset"
grep -qF 'checkUpdate: false' image/contribute/config.yml || fail "contributor overlay must not advertise an in-place update"
# The advisor ships enabled but unnamed. `advisor.enabled` is a workflow
# default the image may set; the model behind it is not, so the contributor's
# own modelRoles.advisor decides who reviews their work and who pays for it.
# An overlay that named one would spend a stranger's quota by default.
grep -qE '^ +enabled: true$' image/contribute/config.yml || fail "contributor overlay must enable the advisor"
grep -qE '^ +syncBacklog: 1$' image/contribute/config.yml ||
  fail "contributor overlay must bound how far the advisor may fall behind"
if grep -qE '^ *(model|modelRoles|reasoningEffort|thinkingLevel) *:' image/contribute/config.yml; then
  fail "the shipped overlay must not pin a model, role, or effort"
fi
if grep -qF 'xterm-direct' "$entry" || grep -qF 'tmux-direct' image/tmux.conf; then
  fail "contributor must not reintroduce direct-color TERM entries"
fi
grep -qF 'set -g set-titles-string "hive-contribute - #{pane_title}"' image/tmux.conf || fail "contributor terminal title must identify contribute mode"

# Attended terminal attach behavior in entrypoint
# shellcheck disable=SC2016 # the entrypoint source is matched literally, not expanded
grep -q '^/usr/local/bin/contributor-agent.sh "\$@" &$' "$entry" || fail "entrypoint must background contributor-agent.sh"
grep -qF 'tmux has-session -t contributor' "$entry" || fail "entrypoint must wait for contributor tmux session"
grep -qF 'tmux attach-session -t contributor' "$entry" || fail "entrypoint must attach attended terminal to tmux"
grep -qF 'attach_pid=' "$entry" || fail "the attach must have explicit PID-1 cleanup ownership"

# Task token cache redirect on read-only filesystems
grep -qF 'HIVE_GH_TOKEN_CACHE' "$entry" ||
  fail "entrypoint must redirect Hive's task token cache when its default is not writable"

# --- scripts/generate-contribute-sbom.py unit contract ------------------------
python3 "$root/tests/contribute_sbom_contract.py" || fail "tests/contribute_sbom_contract.py failed"

if [[ -z "$image" ]]; then
  echo "contribute-contract: static contract holds"
  exit 0
fi

# --- In-image runtime contract ------------------------------------------------
engine="${CONTAINER_ENGINE:-podman}"
inspect() { "$engine" image inspect "$image" --format "$1"; }
# Provenance has to survive the build, not just appear in the Containerfile:
# the label and the file inside the image must name the same resolved commit.
# A build that forgets --build-arg HIVE_COMMIT produces an empty label beside a
# populated file, which is exactly the mismatch this catches.
label_commit="$(inspect '{{index .Config.Labels "io.hivecommons.contribute.hive.ref"}}')"
file_commit="$("$engine" run --rm --entrypoint /usr/bin/bash "$image" -c 'cat /usr/share/hive/contribute/HIVE_COMMIT')"
[[ "$label_commit" =~ ^[0-9a-f]{40}$ ]] ||
  fail "hive.ref label is not a resolved commit SHA (got '${label_commit}')"
test "$label_commit" = "$file_commit" ||
  fail "hive.ref label (${label_commit}) disagrees with HIVE_COMMIT in the image (${file_commit})"

test "$(inspect '{{.Config.User}}')" = 65532:65532 || fail "image user"
test "$(inspect '{{.Config.WorkingDir}}')" = "${guest_home}/workspace" || fail "image workdir"
image_env() { inspect '{{range .Config.Env}}{{println .}}{{end}}' | sed -nE "s/^${1}=(.*)\$/\1/p" | head -1; }
test "$(image_env HOME)" = "$guest_home" || fail "image HOME is not the ${guest_home} the launcher mounts"
test "$(image_env XDG_CONFIG_HOME)" = "${guest_home}/.config" || fail "image XDG_CONFIG_HOME is outside ${guest_home}"
test "$(image_env XDG_STATE_HOME)" = "${guest_home}/.local/state" || fail "image XDG_STATE_HOME is outside ${guest_home}"
test "$(inspect '{{json .Config.Entrypoint}}')" = '["/usr/local/bin/hive-contribute"]' || fail "image entrypoint"

# shellcheck disable=SC2016 # the single-quoted $HOME expands inside the container, not this shell
"$engine" run --rm --entrypoint /usr/bin/bash "$image" -c 'set -eu; omp --version; node -e "require.resolve(\"ws\")"; python3 --version >/dev/null; gh --version >/dev/null; /opt/hive/bin/gh-real --version >/dev/null; tmux -V; git --version >/dev/null; curl --version >/dev/null; find --version >/dev/null; grep --version >/dev/null; sed --version >/dev/null; cmp --version >/dev/null; test -w "$HOME"; test -w "$HOME/workspace"; test -f /usr/local/bin/contributor-relay.js; test -f /usr/local/bin/pi-backend.js; test ! -e /usr/local/bin/omp-backend.js; test -f /usr/local/bin/lib/pane-classifier.js; test -f /usr/share/hive/contribute/HIVE_COMMIT; test ! -e /usr/bin/npm; test ! -e /usr/bin/corepack' >/dev/null || fail "runtime closure"

# Hive's gh policy layer, exercised as the agent meets it: the wrapper IS gh,
# it refuses the credential store and every mutating or unreviewed surface,
# and it still passes real work through to the binary behind it. Each probe
# below is decided before any network call, so none of them reaches GitHub.
# shellcheck disable=SC2016 # the probe expands inside the container, not here
gh_policy_probe='
set -eu
export HIVE_AGENT_ID=contributor HIVE_CONTRIBUTOR_USERNAME=probe HIVE_CONTRIBUTOR_CLI=omp
test "$(command -v gh)" = /usr/bin/gh
test -f /etc/hive/contributor-mode
# The marker decides contributor mode, so an agent must not be able to remove
# or forge it, and the wrapper itself must stay read-only to the agent.
! test -w /etc/hive/contributor-mode
! test -w /usr/bin/gh
! test -w /opt/hive/bin/gh-real
blocked() {
  if out="$(gh "$@" 2>&1)"; then
    printf "gh %s was not blocked\n" "$*" >&2
    return 1
  fi
  case "$out" in *BLOCKED*) return 0 ;; esac
  printf "gh %s failed without the policy message: %s\n" "$*" "$out" >&2
  return 1
}
blocked auth login
blocked auth token
blocked api -X POST repos/o/r/issues
blocked secret set FOO --body bar
blocked repo delete o/r
# A PR body that merely discusses authentication is not an auth command
# (hivecommons/hive#6659); blocking it would kill exactly the security fixes
# this fleet is meant to land. Reaching the network here means the gate let it
# through, which is the assertion — the call itself is expected to fail.
if gh pr create --title "use an auth file" --body "replace --creds with an auth file" 2>&1 | grep -q BLOCKED; then
  echo "a PR body mentioning auth must not be blocked" >&2
  exit 1
fi
gh version >/dev/null
'
"$engine" run --rm --network none --entrypoint /usr/bin/bash "$image" -c "$gh_policy_probe" ||
  fail "Hive's gh policy layer does not gate this image the way it gates an upstream contributor"

# Locale verification
# shellcheck disable=SC2016 # the probe expands inside the container, not this shell
width="$("$engine" run --rm --entrypoint /usr/bin/bash "$image" -c 'x=$(printf "\xe2\x94\x80"); printf %s "${#x}"')"
test "$width" = 1 || fail "image locale is not UTF-8 (U+2500 measured as ${width} characters, not 1)"

# OMP overlay resolution
resolved="$("$engine" run --rm --entrypoint /usr/bin/bash "$image" -c 'omp config get symbolPreset; omp config get startup.checkUpdate' | tr '\n' ' ')"
test "$resolved" = "nerd false " ||
  fail "OMP did not resolve the shipped overlay (symbolPreset/startup.checkUpdate = ${resolved})"
if "$engine" run --rm --env AGENT_BACKEND=goose "$image" >/dev/null 2>&1; then
  fail "alternate agent backends must be rejected"
fi

# A contributor whose session ends must stop, not park an attended terminal on
# a dead session while the relay keeps the registration alive and the hub keeps
# assigning work to it. Stand in for Hive's agent with a session that exits.
ended_agent="$(mktemp)"
cat >"$ended_agent" <<'AGENT'
#!/usr/bin/env bash
tmux new-session -d -s contributor 'sleep 2'
sleep 600
AGENT
chmod 0755 "$ended_agent"
ended_status=0
timeout 90 "$engine" run --rm --tty \
  --volume "${ended_agent}:/usr/local/bin/contributor-agent.sh:ro,z" \
  "$image" >"${ended_agent}.log" 2>&1 || ended_status=$?
grep -qF 'the contributor session ended' "${ended_agent}.log" ||
  fail "the entrypoint did not stop when the contributor session ended"
[[ "$ended_status" -eq 1 ]] || fail "a contributor whose session ended exited ${ended_status}, not 1"
rm -f "$ended_agent" "${ended_agent}.log"

size="$($engine history --format json "$image" | python3 -c 'import json,sys; print(sum(int(x.get("size") or 0) for x in json.load(sys.stdin)))')"
[[ "$size" =~ ^[0-9]+$ ]] || fail "could not measure image size"
((size <= size_ceiling_bytes)) || fail "contribute image is $((size / 1024 / 1024)) MiB, over the $((size_ceiling_bytes / 1024 / 1024)) MiB ceiling"
echo "contribute-contract: runtime contract holds ($((size / 1024 / 1024)) MiB)"
