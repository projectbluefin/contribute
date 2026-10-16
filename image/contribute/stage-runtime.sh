#!/usr/bin/env bash
# Stage the FSDK runtime closure for the contributor appliance.
#
# Runs inside the shell-enabled FSDK builder and copies an explicit allowlist of
# binaries plus the shared libraries they actually resolve into a rootfs tree the
# final distroless stage overlays. Nothing here installs a package: the image is
# assembled from named files, so its contents are the allowlist and nothing else.
#
# Two binaries earn their place:
#   bash — omp's `bash` tool spawns a shell; without one the agent cannot run gh.
#   git  — the fix and land paths patch code and push it.
set -euo pipefail

dest="${1:?usage: stage-runtime <destdir>}"
shift

# Executables copied verbatim into /usr/bin.
#
# bash and git are the load-bearing pair: omp's `bash` tool spawns a shell, and
# the fix and land paths patch code and push it. The rest is the userland that
# every shell one-liner an agent writes assumes exists. FSDK's distroless base
# ships no executables at all, so without these `gh ... | grep` fails at the
# pipe and `#!/usr/bin/env bash` fails before the script starts.
python3_real="$(command -v python3 || true)"
[[ -n "$python3_real" ]] && python3_real="$(readlink -f "$python3_real")"
python3_ver=""
if [[ -n "$python3_real" && -x "$python3_real" ]]; then
  python3_ver="$("$python3_real" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || true)"
fi

binaries=(
  /usr/bin/bash
  /usr/bin/git
  /usr/bin/curl
  /usr/bin/diff
  /usr/bin/find
  /usr/bin/gawk
  /usr/bin/grep
  /usr/bin/gzip
  # FSDK's gzip command is a wrapper that execs this implementation.
  /usr/bin/gzip.bin
  /usr/bin/less
  /usr/bin/sed
  /usr/bin/tar
  /usr/bin/xargs
)
if [[ -n "$python3_real" && -x "$python3_real" ]]; then
  binaries+=("$python3_real")
fi

# GNU coreutils, the whole set: Hive's runtime, this entrypoint and every agent
# one-liner use it (cat, mkdir, env, sleep, timeout, ...). tests/
# contribute-contract.sh reads this array and executes each one in the image.
coreutils=(
  '[' arch b2sum base32 base64 basename basenc cat chcon chgrp chmod chown
  chroot cksum comm cp csplit cut date dd df dir dircolors dirname du echo env
  expand expr factor false fmt fold groups head hostid hostname id install join
  link ln logname ls md5sum mkdir mkfifo mknod mktemp mv nice nl nohup nproc
  numfmt od paste pathchk pinky pr printenv printf ptx pwd readlink realpath rm
  rmdir runcon seq sha1sum sha224sum sha256sum sha384sum sha512sum shred shuf
  sleep sort split stat stdbuf stty sum sync tac tail tee test timeout touch tr
  true truncate tsort tty uname unexpand uniq unlink users vdir wc who whoami
  yes
)
for name in "${coreutils[@]}"; do
  binaries+=("/usr/bin/${name}")
done

# Callers may name additional absolute executables after the destination. Their
# ELF closures are staged by the same ldd path as the appliance's fixed base.
for binary in "$@"; do
  [[ "$binary" == /* ]] || {
    echo "stage-runtime: extra executable must be absolute: $binary" >&2
    exit 1
  }
  binaries+=("$binary")
done

# git's helpers live on GIT_EXEC_PATH. Only the HTTPS remote helper is kept:
# the appliance talks to GitHub over https and nothing else.
helpers=(
  /usr/libexec/git-core/git-remote-http
)

# Libraries the distroless base already ships as part of its own glibc. Copying
# a second copy of the loader's core over itself is how a container starts
# failing in ways that look like corruption.
base_provided=(
  ld-linux-x86-64.so.2
  ld-linux-aarch64.so.1
  libc.so.6
  libdl.so.2
  libm.so.6
  libpthread.so.0
  libresolv.so.2
  librt.so.1
)

is_base_provided() {
  local candidate="$1" provided
  for provided in "${base_provided[@]}"; do
    [[ "$candidate" == "$provided" ]] && return 0
  done
  return 1
}

# Copy every library an ELF binary resolves, under its soname. ldd reports the
# path the loader picked, which is what has to exist in the final image; naming
# the copy after the soname keeps that resolution working without dragging the
# whole symlink chain along.
stage_libraries() {
  local binary="$1" soname resolved
  while read -r soname _arrow resolved _address; do
    [[ "$soname" == linux-vdso.so.* ]] && continue
    # ldd prints the loader itself without a "=>" arrow.
    if [[ -z "${resolved:-}" || "$resolved" != /* ]]; then
      [[ "$soname" == /* ]] || continue
      resolved="$soname"
      soname="$(basename "$soname")"
    fi
    is_base_provided "$soname" && continue
    [[ -e "$resolved" ]] || continue
    local libdir target
    libdir="$(dirname "$resolved")"
    target="${dest}${libdir}/${soname}"
    [[ -e "$target" ]] && continue
    install -D -m 0755 "$resolved" "$target"
  done < <(ldd "$binary" 2>/dev/null || true)
}

install -d -m 0755 "${dest}/usr/bin" "${dest}/usr/libexec/git-core"

for binary in "${binaries[@]}" "${helpers[@]}"; do
  [[ -x "$binary" ]] || {
    echo "stage-runtime: missing $binary" >&2
    exit 1
  }
done

for binary in "${binaries[@]}"; do
  install -m 0755 "$binary" "${dest}/usr/bin/$(basename "$binary")"
  stage_libraries "$binary"
done

for helper in "${helpers[@]}"; do
  install -m 0755 "$helper" "${dest}/usr/libexec/git-core/$(basename "$helper")"
  stage_libraries "$helper"
done

# git dispatches to `git-remote-https` by name; upstream ships it as a link to
# the same binary rather than a second copy.
ln -sf git-remote-http "${dest}/usr/libexec/git-core/git-remote-https"

# stdbuf works by LD_PRELOADing this library into the command it runs.
install -D -m 0755 /usr/libexec/coreutils/libstdbuf.so \
  "${dest}/usr/libexec/coreutils/libstdbuf.so"

# /bin is a symlink to /usr/bin in this base, so one link covers every caller
# that hardcodes /bin/sh.
ln -sf bash "${dest}/usr/bin/sh"

# `awk` is spelled that way in every script ever written.
ln -sf gawk "${dest}/usr/bin/awk"
if [[ -n "$python3_real" && -x "$python3_real" ]]; then
  ln -sf "$(basename "$python3_real")" "${dest}/usr/bin/python3"
  ln -sf "$(basename "$python3_real")" "${dest}/usr/bin/python"
  if [[ -n "$python3_ver" && -d "/usr/lib/python${python3_ver}" ]]; then
    install -d -m 0755 "${dest}/usr/lib"
    cp -a "/usr/lib/python${python3_ver}" "${dest}/usr/lib/python${python3_ver}"
    rm -rf "${dest}/usr/lib/python${python3_ver}/test" \
      "${dest}/usr/lib/python${python3_ver}/idlelib" \
      "${dest}/usr/lib/python${python3_ver}/tkinter" \
      "${dest}/usr/lib/python${python3_ver}/turtle"* 2>/dev/null || true
    find "${dest}/usr/lib/python${python3_ver}" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
    find "${dest}/usr/lib/python${python3_ver}" -type f \( -name "*.pyc" -o -name "*.pyo" \) -delete 2>/dev/null || true
    while IFS= read -r -d '' so; do
      stage_libraries "$so"
    done < <(find "${dest}/usr/lib/python${python3_ver}" -type f -name '*.so' -print0)
  fi
fi

# git init warns on every invocation without its template directory, and a tool
# that greets the maintainer with a warning it cannot act on is noise.
if [[ -d /usr/share/git-core/templates ]]; then
  install -d -m 0755 "${dest}/usr/share/git-core"
  cp -a /usr/share/git-core/templates "${dest}/usr/share/git-core/templates"
fi

printf 'staged %s binaries, %s libraries\n' \
  "$((${#binaries[@]} + ${#helpers[@]}))" \
  "$(find "${dest}/usr/lib" -type f -name '*.so*' 2>/dev/null | wc -l)"
