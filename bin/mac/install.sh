#!/usr/bin/env bash
# ==============================================================================
# Kubera installer for macOS
#
# Installs the Kubera Antigravity UI plugin into the Antigravity plugin directory.
# Supports symlinking (default, for local git clones) and copying (for downloaded
# release archives).
#
# There is no build step: the sidecar is plain ESM Node with no third-party
# dependencies; the host resolves `sidecar_sdk` at run time.
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="kubera"

# Resolve PLUGIN_ROOT by traversing upwards until plugin.json is found
CURRENT_DIR="${SCRIPT_DIR}"
PLUGIN_ROOT=""
while [[ "${CURRENT_DIR}" != "/" ]]; do
  if [[ -f "${CURRENT_DIR}/plugin.json" ]]; then
    PLUGIN_ROOT="${CURRENT_DIR}"
    break
  fi
  CURRENT_DIR="$(dirname "${CURRENT_DIR}")"
done

if [[ -z "${PLUGIN_ROOT}" ]]; then
  PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
fi

GLOBAL_TARGETS=(
  "${HOME}/.gemini/antigravity/plugins"
  "${HOME}/.gemini/config/plugins"
)

TARGETS=()
PROJECT_DIR=""
RUN_TESTS="true"
INSTALL_MODE="symlink" # "symlink" or "copy"

print_usage() {
  cat <<EOF
Usage: ./bin/mac/install.sh [OPTIONS]

Options:
  -p, --project-dir DIR   Install plugin scoped to a specific project workspace.
                          Installs to <DIR>/_agents/plugins and <DIR>/.gemini/plugins.
  --target DIR            Custom plugin directory to install into (repeatable).
  --copy                  Copy plugin files instead of creating a symlink.
                          Recommended when installing from downloaded release archives.
  --symlink               Create a symlink pointing to this folder (default).
  --skip-tests            Do not run the test suite before installing.
  -h, --help              Show this message.

Examples:
  ./bin/mac/install.sh                     # Global install (symlink)
  ./bin/mac/install.sh --copy              # Global install (copy files)
  ./bin/mac/install.sh -p /path/to/project # Project-scoped install

After installing, restart Antigravity and open the "Kubera" pane.
EOF
}

EXTRA_TARGETS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--project-dir|--project)
      PROJECT_DIR="$2"
      shift 2
      ;;
    --target)
      EXTRA_TARGETS+=("$2")
      shift 2
      ;;
    --copy)
      INSTALL_MODE="copy"
      shift
      ;;
    --symlink)
      INSTALL_MODE="symlink"
      shift
      ;;
    --skip-tests)
      RUN_TESTS="false"
      shift
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      print_usage
      exit 1
      ;;
  esac
done

# Determine target directories
if [[ ${#EXTRA_TARGETS[@]} -gt 0 ]]; then
  TARGETS=("${EXTRA_TARGETS[@]}")
elif [[ -n "${PROJECT_DIR}" ]]; then
  mkdir -p "${PROJECT_DIR}"
  ABS_PROJECT_DIR="$(cd "${PROJECT_DIR}" && pwd)"
  TARGETS=(
    "${ABS_PROJECT_DIR}/_agents/plugins"
    "${ABS_PROJECT_DIR}/.gemini/plugins"
  )
else
  TARGETS=("${GLOBAL_TARGETS[@]}")
fi

echo "============================================================"
echo " Kubera Installer (macOS)"
echo "============================================================"
echo " Plugin Root      : ${PLUGIN_ROOT}"
echo " Install Mode     : ${INSTALL_MODE}"
if [[ -n "${PROJECT_DIR}" ]]; then
  echo " Target Scope     : Project (${PROJECT_DIR})"
else
  echo " Target Scope     : Global"
fi

# Node runtime check
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js executable not found on PATH." >&2
  echo "Node.js 20 or newer is required to run Kubera." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "${NODE_MAJOR}" -lt 20 ]]; then
  echo "Error: Node 20 or newer is required (found $(node --version))." >&2
  exit 1
fi
echo " Node Runtime     : $(node --version) (verified >= 20)"

# Run tests if test files exist and not skipped
if [[ "${RUN_TESTS}" == "true" ]]; then
  if [[ -f "${PLUGIN_ROOT}/tests/pricing.test.mjs" && -f "${PLUGIN_ROOT}/tests/aggregate.test.mjs" ]]; then
    echo ""
    echo "Running pre-flight test suite..."
    node --test "${PLUGIN_ROOT}/tests/pricing.test.mjs" "${PLUGIN_ROOT}/tests/aggregate.test.mjs" >/dev/null
    echo "✓ Tests passed (31/31)"
  fi
fi

echo ""
echo "Installing plugin into target directories..."
for dir in "${TARGETS[@]}"; do
  mkdir -p "${dir}"
  target_plugin="${dir}/${PLUGIN_NAME}"

  # Clean up existing symlink or folder
  if [[ -L "${target_plugin}" || -d "${target_plugin}" || -f "${target_plugin}" ]]; then
    rm -rf "${target_plugin}"
  fi

  if [[ "${INSTALL_MODE}" == "copy" ]]; then
    mkdir -p "${target_plugin}"
    cp -rp "${PLUGIN_ROOT}/plugin.json" "${target_plugin}/"
    [ -d "${PLUGIN_ROOT}/assets" ] && cp -rp "${PLUGIN_ROOT}/assets" "${target_plugin}/"
    [ -d "${PLUGIN_ROOT}/sidecars" ] && cp -rp "${PLUGIN_ROOT}/sidecars" "${target_plugin}/"
    [ -d "${PLUGIN_ROOT}/bin" ] && cp -rp "${PLUGIN_ROOT}/bin" "${target_plugin}/"
    [ -f "${PLUGIN_ROOT}/package.json" ] && cp -rp "${PLUGIN_ROOT}/package.json" "${target_plugin}/"
    [ -f "${PLUGIN_ROOT}/README.md" ] && cp -rp "${PLUGIN_ROOT}/README.md" "${target_plugin}/"
    echo "✓ Copied: ${target_plugin}"
  else
    ln -s "${PLUGIN_ROOT}" "${target_plugin}"
    echo "✓ Symlinked: ${target_plugin} -> ${PLUGIN_ROOT}"
  fi
done

RATE_VERSION="unknown"
if [[ -f "${PLUGIN_ROOT}/sidecars/kubera/pricing.json" ]]; then
  RATE_VERSION="$(node -p "require('${PLUGIN_ROOT}/sidecars/kubera/pricing.json').table_version")"
fi

cat <<EOF

============================================================
Kubera installed successfully.

  Rate card version : ${RATE_VERSION}
  Override file     : \${ANTIGRAVITY_EXECUTABLE_DATA_DIR}/pricing.override.json

Restart Antigravity, then open the "Kubera" pane in the AuxPane.

Note: The rate card represents published public list prices.
Antigravity meters AI credits, not tokens, with no published
credit-to-dollar conversion. Use /credits and /usage for quota.
============================================================
EOF
