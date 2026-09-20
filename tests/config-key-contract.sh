#!/usr/bin/env bash
# The appliance configuration key roster, asserted against every place that
# restates it.
#
# WHY THIS EXISTS. `bin/hive-contribute` reads a flat `key: value` file with a
# fixed set of keys. That set is not written down once — it is restated six
# times, in three files:
#
#   1. load_config()          reads each key                    (the owner)
#   2. write_default_config() seeds the file the launcher writes
#   3. that same heredoc's comment block documents each key
#   4. run_config()           prints each resolved value
#   5. README.md              a sample config block and a key table
#   6. docs/skills/launcher.md the roster a reader is told to expect
#
# Three of those sites also spell the COUNT in prose ("six flat keys").
#
# Adding, renaming, or removing a key touches one of them and silently leaves
# the rest wrong: the launcher keeps working, the README documents a key that
# no longer exists or omits one that does, and the prose count is off by one.
# Nothing in CI notices, because every site is prose to the tools.
#
# So: derive the roster from load_config(), which is the only site that
# decides what the launcher actually reads, and require the other five to
# agree — both the roster and the spelled count.
#
# Hermetic: reads the repository's own files, executes nothing.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
launcher="$repo_root/bin/hive-contribute"
readme="$repo_root/README.md"
skill="$repo_root/docs/skills/launcher.md"

failures=0
fail() {
  printf 'config key contract: %s\n' "$1" >&2
  failures=$((failures + 1))
}

for required in "$launcher" "$readme" "$skill"; do
  [[ -f "$required" ]] || {
    fail "missing file: ${required#"$repo_root"/}"
    exit 1
  }
done

# ── The owner ────────────────────────────────────────────────────────────────
# Every key load_config() resolves through config_value. The definition line
# (`config_value() {`) does not match: it is followed by `(`, not a key.
declare -a roster=()
while IFS= read -r key; do
  roster+=("$key")
done < <(grep -oE 'config_value [a-z_]+' "$launcher" | awk '{print $2}' | sort -u)

((${#roster[@]} > 0)) || {
  fail "bin/hive-contribute load_config() resolves no keys through config_value"
  exit 1
}

in_roster() {
  local candidate="$1" key
  for key in "${roster[@]}"; do
    [[ "$key" == "$candidate" ]] && return 0
  done
  return 1
}

# Compare a site's key set against the roster, in both directions: a missing
# key is an undocumented setting, an extra one is a setting that does not exist.
compare_to_roster() {
  local site="$1"
  shift
  local -a found=("$@")
  local key
  for key in "${roster[@]}"; do
    local seen=0 candidate
    for candidate in ${found[@]+"${found[@]}"}; do
      [[ "$candidate" == "$key" ]] && seen=1
    done
    ((seen)) || fail "$site does not mention the '$key' key that load_config() reads"
  done
  for key in ${found[@]+"${found[@]}"}; do
    in_roster "$key" || fail "$site names '$key', which load_config() never reads"
  done
}

# ── The spelled count ────────────────────────────────────────────────────────
number_word() {
  local -a words=(zero one two three four five six seven eight nine ten eleven twelve)
  local n="$1"
  ((n < ${#words[@]})) && printf '%s\n' "${words[n]}" && return 0
  printf '%d\n' "$n"
}

expected_word="$(number_word "${#roster[@]}")"

check_spelled_count() {
  local label="$1" file="$2" pattern="$3" line word
  line="$(grep -nE "$pattern" "$file" | head -1 || true)"
  [[ -n "$line" ]] || {
    fail "$label no longer states how many configuration keys there are"
    return
  }
  word="$(sed -E "s/.*$pattern.*/\1/" <<<"${line#*:}")"
  [[ "$word" == "$expected_word" ]] ||
    fail "$label says '$word' configuration keys; load_config() reads ${#roster[@]} ($expected_word)"
}

check_spelled_count "bin/hive-contribute" "$launcher" \
  'the file has ([a-z]+) keys'
check_spelled_count "README.md" "$readme" \
  'The configuration has ([a-z]+) flat keys'
check_spelled_count "docs/skills/launcher.md" "$skill" \
  'The file has ([a-z]+) flat keys'

# ── write_default_config()'s heredoc: the file the launcher writes ───────────
heredoc="$(awk '/cat >"\$CONFIG_PATH" <<EOF$/ {flag=1; next} /^EOF$/ {flag=0} flag' "$launcher")"
[[ -n "$heredoc" ]] || fail "bin/hive-contribute write_default_config() writes no heredoc"

declare -a seeded=()
while IFS= read -r key; do
  seeded+=("$key")
done < <(grep -oE '^[a-z_]+:' <<<"$heredoc" | tr -d ':' | sort -u)
compare_to_roster "the config file write_default_config() seeds" ${seeded[@]+"${seeded[@]}"}

# The same heredoc documents each key in its comment block: `# hub  the hive…`.
declare -a documented=()
while IFS= read -r key; do
  documented+=("$key")
done < <(grep -oE '^# [a-z_]+ +[A-Za-z]' <<<"$heredoc" | awk '{print $2}' | sort -u)
compare_to_roster "the comment block in write_default_config()" ${documented[@]+"${documented[@]}"}

# ── run_config(): what `hive-contribute config` reports ─────────────────────
config_output="$(awk '/^run_config\(\) \{$/ {flag=1} flag {print} /^\}$/ {if (flag) exit}' "$launcher")"
[[ -n "$config_output" ]] || fail "bin/hive-contribute has no run_config()"

declare -a reported=()
while IFS= read -r key; do
  # `config:` is the path of the file itself, not a key inside it.
  [[ "$key" == "config" ]] && continue
  reported+=("$key")
done < <(grep -oE 'echo "[a-z_]+:' <<<"$config_output" | sed -E 's/echo "([a-z_]+):/\1/' | sort -u)
compare_to_roster "the output of 'hive-contribute config'" ${reported[@]+"${reported[@]}"}

# ── README.md: the sample block and the key table ───────────────────────────
sample="$(awk '/^```yaml$/ {flag=1; next} /^```$/ {flag=0} flag' "$readme")"
[[ -n "$sample" ]] || fail "README.md has no yaml sample configuration block"

declare -a sampled=()
while IFS= read -r key; do
  sampled+=("$key")
done < <(grep -oE '^[a-z_]+:' <<<"$sample" | tr -d ':' | sort -u)
compare_to_roster "the README.md sample configuration" ${sampled[@]+"${sampled[@]}"}

# The key table: rows whose first cell is a single backticked lowercase word.
declare -a tabled=()
# shellcheck disable=SC2016 # backticks are markdown table syntax, not a command substitution
while IFS= read -r key; do
  tabled+=("$key")
done < <(grep -oE '^\| `[a-z_]+` \|' "$readme" | tr -d '|` ' | sort -u)
compare_to_roster "the README.md configuration key table" ${tabled[@]+"${tabled[@]}"}

# ── docs/skills/launcher.md: the roster a reader is told to expect ──────────
roster_line="$(grep -E 'The file has [a-z]+ flat keys' "$skill" | head -1 || true)"
declare -a described=()
if [[ -n "$roster_line" ]]; then
  # shellcheck disable=SC2016 # backticks are markdown, not a command substitution
  while IFS= read -r key; do
    described+=("$key")
  done < <(grep -oE '`[a-z_]+`' <<<"$roster_line" | tr -d '`' | sort -u)
  compare_to_roster "the key roster in docs/skills/launcher.md" ${described[@]+"${described[@]}"}
fi

if ((failures > 0)); then
  printf 'config key contract: %d problem(s) across %d key(s)\n' \
    "$failures" "${#roster[@]}" >&2
  exit 1
fi

printf 'config key contract OK: %d keys, consistent across launcher, README, and skill docs\n' \
  "${#roster[@]}"
