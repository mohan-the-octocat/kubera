#!/usr/bin/env bash
# ==============================================================================
# Kubera installer
#
# Symlinks this repository into the Antigravity plugin directory. There is no
# build step: the sidecar is plain ESM Node with no third-party dependencies,
# and the host resolves `sidecar_sdk` at run time.
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="kubera"
TARGETS=("${HOME}/.gemini/antigravity/plugins")
RUN_TESTS="true"

print_usage() {
  cat <<EOF
Usage: ./install.sh [OPTIONS]

Options:
  --target DIR    Additional plugin directory to install into. Repeatable.
                  Default: \${HOME}/.gemini/antigravity/plugins
  --skip-tests    Do not run the test suite before installing.
  -h, --help      Show this message.

After installing, restart Antigravity and open the "Kubera" pane.
EOF
}

EXTRA_TARGETS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)   EXTRA_TARGETS+=("$2"); shift 2 ;;
    --skip-tests) RUN_TESTS="false"; shift ;;
    -h|--help)  print_usage; exit 0 ;;
    *)          echo "Unknown option: $1" >&2; print_usage; exit 1 ;;
  esac
done
if [[ ${#EXTRA_TARGETS[@]} -gt 0 ]]; then
  TARGETS=("${EXTRA_TARGETS[@]}")
fi

# The sidecar reads the local conversation store through node:sqlite, which
# landed in Node 22.5. Antigravity ships its own Node; this only checks the
# Node used to run the tests.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "${NODE_MAJOR}" -lt 20 ]]; then
  echo "Error: Node 20 or newer is required (found $(node --version))." >&2
  exit 1
fi

if [[ "${RUN_TESTS}" == "true" ]]; then
  echo "Running tests..."
  node --test "${SCRIPT_DIR}/tests/pricing.test.mjs" "${SCRIPT_DIR}/tests/aggregate.test.mjs" >/dev/null
  echo "✓ Tests passed"
fi

for dir in "${TARGETS[@]}"; do
  mkdir -p "${dir}"
  rm -f "${dir}/${PLUGIN_NAME}"
  ln -s "${SCRIPT_DIR}" "${dir}/${PLUGIN_NAME}"
  echo "✓ Installed: ${dir}/${PLUGIN_NAME} -> ${SCRIPT_DIR}"
done

RATE_VERSION="$(node -p "require('${SCRIPT_DIR}/sidecars/kubera/pricing.json').table_version")"

cat <<EOF

============================================================
Kubera installed.

  Rate card version : ${RATE_VERSION}
  Override file     : \${ANTIGRAVITY_EXECUTABLE_DATA_DIR}/pricing.override.json

Restart Antigravity, then open the "Kubera" pane.

The rate card is public list price, captured by hand with a
source URL and access date per model. It is not a bill and it
is not the AI-credit quota Antigravity actually meters. Use
/credits and /usage for quota.
============================================================
EOF
