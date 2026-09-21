#!/usr/bin/env bash
# ==============================================================================
# Kubera uninstaller for macOS
#
# Removes the Kubera Antigravity UI plugin from target plugin directories.
# ==============================================================================
set -euo pipefail

PLUGIN_NAME="kubera"

GLOBAL_TARGETS=(
  "${HOME}/.gemini/antigravity/plugins"
  "${HOME}/.gemini/config/plugins"
)

TARGETS=()
PROJECT_DIR=""

print_usage() {
  cat <<EOF
Usage: ./bin/mac/uninstall.sh [OPTIONS]

Options:
  -p, --project-dir DIR   Remove plugin from a specific project workspace.
  --target DIR            Remove plugin from custom directory (repeatable).
  -h, --help              Show this message.

Examples:
  ./bin/mac/uninstall.sh                     # Remove from global plugin directories
  ./bin/mac/uninstall.sh -p /path/to/project # Remove from project workspace
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

if [[ ${#EXTRA_TARGETS[@]} -gt 0 ]]; then
  TARGETS=("${EXTRA_TARGETS[@]}")
elif [[ -n "${PROJECT_DIR}" ]]; then
  ABS_PROJECT_DIR="$(cd "${PROJECT_DIR}" && pwd)"
  TARGETS=(
    "${ABS_PROJECT_DIR}/_agents/plugins"
    "${ABS_PROJECT_DIR}/.gemini/plugins"
  )
else
  TARGETS=("${GLOBAL_TARGETS[@]}")
fi

echo "============================================================"
echo " Kubera Uninstaller (macOS)"
echo "============================================================"

REMOVED=0
for dir in "${TARGETS[@]}"; do
  target_plugin="${dir}/${PLUGIN_NAME}"
  if [[ -L "${target_plugin}" || -d "${target_plugin}" || -f "${target_plugin}" ]]; then
    rm -rf "${target_plugin}"
    echo "✓ Removed: ${target_plugin}"
    REMOVED=$((REMOVED + 1))
  fi
done

if [[ ${REMOVED} -eq 0 ]]; then
  echo "No active Kubera installations found in target directories."
else
  echo "Kubera uninstalled successfully. Restart Antigravity to apply changes."
fi
