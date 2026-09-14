#!/usr/bin/bash
# The image is an immutable appliance: omp configuration that makes sense on a
# developer workstation must not silently become appliance startup policy.
set -eu

export COPILOT_INTEGRATION_ID="${COPILOT_INTEGRATION_ID:-copilot-developer-cli}"
export COPILOT_GITHUB_TOKEN="${COPILOT_GITHUB_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
export GITHUB_COPILOT_TOKEN="${GITHUB_COPILOT_TOKEN:-${COPILOT_GITHUB_TOKEN:-}}"
profile="bluefin-review-appliance"
if [ "${BLUEFIN_REVIEW_INHERIT_OMP_CONFIG:-0}" = 1 ]; then
  profile="review"
fi

case "${1:-}" in
update)
  cat >&2 <<'EOF'
Bluefin Review is an immutable appliance and cannot update itself.
Pull a newer container image and launch it to update.
EOF
  exit 2
  ;;
--help | -h | help)
  # OMP owns the rest of the help text. Remove its mutable-install update
  # command and replace it with the appliance contract below.
  omp --profile "$profile" --config /usr/share/bluefin/review/appliance-config.yml \
    --extension /usr/share/bluefin/review/extension "$@" |
    sed '/^[[:space:]]*update[[:space:]]/d'
  cat <<'EOF'

Appliance lifecycle:
  This image is immutable. Replace it to update; `omp update` is disabled.
  Host OMP profiles and their MCP servers are isolated by default. Set
  BLUEFIN_REVIEW_INHERIT_OMP_CONFIG=1 to explicitly use the host `review` profile.
EOF
  exit 0
  ;;
esac

exec omp --profile "$profile" \
  --config /usr/share/bluefin/review/appliance-config.yml \
  --extension /usr/share/bluefin/review/extension "$@"
