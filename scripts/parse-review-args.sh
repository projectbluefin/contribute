#!/usr/bin/env bash
# Parse review shorthand arguments into canonical OMP flags.
#
# Accepts:
#   owner/repo
#   owner/repo #123
#   owner/repo 123
#   owner/repo#123
#   #123 / 123
#   --repo owner/repo
#   --issues / issues
#   --all / all
#   and any mixed combination.
#
# Populates PARSED_REVIEW_ARGS array with the resulting arguments.
set -euo pipefail

parse_review_args() {
  local -a in_args=("$@")
  local -a out_args=()
  local i=0
  local len=${#in_args[@]}

  while ((i < len)); do
    local arg="${in_args[i]}"

    case "$arg" in
    --repo)
      if ((i + 1 < len)); then
        local val="${in_args[i + 1]}"
        i=$((i + 2))
        if [[ "$val" =~ ^(https?://github\.com/)?([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)(/(pull|issues)/|#)([0-9]+)$ ]]; then
          out_args+=(--repo "${BASH_REMATCH[2]}" --pr "${BASH_REMATCH[5]}")
        elif [[ "$val" =~ ^([A-Za-z0-9._-]+)#([0-9]+)$ ]]; then
          out_args+=(--repo "${BASH_REMATCH[1]}" --pr "${BASH_REMATCH[2]}")
        elif [[ "$val" =~ ^(https?://github\.com/)?([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)$ ]]; then
          out_args+=(--repo "${BASH_REMATCH[2]}")
        else
          out_args+=(--repo "$val")
        fi
      else
        out_args+=("$arg")
        i=$((i + 1))
      fi
      ;;
    --repo=*)
      local val="${arg#--repo=}"
      if [[ "$val" =~ ^(https?://github\.com/)?([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)(/(pull|issues)/|#)([0-9]+)$ ]]; then
        out_args+=(--repo "${BASH_REMATCH[2]}" --pr "${BASH_REMATCH[5]}")
      elif [[ "$val" =~ ^([A-Za-z0-9._-]+)#([0-9]+)$ ]]; then
        out_args+=(--repo "${BASH_REMATCH[1]}" --pr "${BASH_REMATCH[2]}")
      elif [[ "$val" =~ ^(https?://github\.com/)?([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)$ ]]; then
        out_args+=(--repo "${BASH_REMATCH[2]}")
      else
        out_args+=(--repo "$val")
      fi
      i=$((i + 1))
      ;;
    --pr)
      if ((i + 1 < len)); then
        local val="${in_args[i + 1]}"
        out_args+=(--pr "${val#\#}")
        i=$((i + 2))
      else
        out_args+=("$arg")
        i=$((i + 1))
      fi
      ;;
    --pr=*)
      local val="${arg#--pr=}"
      out_args+=(--pr "${val#\#}")
      i=$((i + 1))
      ;;
    --issues)
      out_args+=(--issues)
      i=$((i + 1))
      ;;
    issues)
      out_args+=(--issues)
      i=$((i + 1))
      ;;
    --all)
      out_args+=(--all)
      i=$((i + 1))
      ;;
    all)
      out_args+=(--all)
      i=$((i + 1))
      ;;
    --skip-repo | --profile | --extension | --model | --effort)
      if ((i + 1 < len)); then
        out_args+=("$arg" "${in_args[i + 1]}")
        i=$((i + 2))
      else
        out_args+=("$arg")
        i=$((i + 1))
      fi
      ;;
    -*)
      out_args+=("$arg")
      i=$((i + 1))
      ;;
    [0-9]* | \#[0-9]*)
      if [[ "$arg" =~ ^#?[0-9]+$ ]]; then
        out_args+=(--pr "${arg#\#}")
      else
        out_args+=("$arg")
      fi
      i=$((i + 1))
      ;;
    *)
      if [[ "$arg" =~ ^(https?://github\.com/)?([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)(/(pull|issues)/|#)([0-9]+)$ ]]; then
        out_args+=(--repo "${BASH_REMATCH[2]}" --pr "${BASH_REMATCH[5]}")
        i=$((i + 1))
      elif [[ "$arg" =~ ^(https?://github\.com/)?([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)$ || "$arg" =~ ^org:[A-Za-z0-9._-]+$ ]]; then
        local repo_val="${BASH_REMATCH[2]:-$arg}"
        out_args+=(--repo "$repo_val")
        i=$((i + 1))
        if ((i < len)) && [[ "${in_args[i]}" =~ ^#?[0-9]+$ ]]; then
          out_args+=(--pr "${in_args[i]#\#}")
          i=$((i + 1))
        fi
      elif [[ "$arg" =~ ^([A-Za-z0-9._-]+)#([0-9]+)$ ]]; then
        out_args+=(--repo "${BASH_REMATCH[1]}" --pr "${BASH_REMATCH[2]}")
        i=$((i + 1))
      elif [[ "$arg" =~ ^[A-Za-z0-9._-]+$ ]]; then
        out_args+=(--repo "$arg")
        i=$((i + 1))
        if ((i < len)) && [[ "${in_args[i]}" =~ ^#?[0-9]+$ ]]; then
          out_args+=(--pr "${in_args[i]#\#}")
          i=$((i + 1))
        fi
      else
        out_args+=("$arg")
        i=$((i + 1))
      fi
      ;;
    esac
  done

  PARSED_REVIEW_ARGS=("${out_args[@]}")
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  parse_review_args "$@"
  if ((${#PARSED_REVIEW_ARGS[@]} > 0)); then
    printf '%s\n' "${PARSED_REVIEW_ARGS[@]}"
  fi
fi
