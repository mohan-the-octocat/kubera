#!/usr/bin/env bash
# ==============================================================================
# Kubera release packaging script
#
# Generates release packages for Linux, macOS (Darwin), Windows, and Universal.
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

VERSION="${1:-}"
if [[ -z "${VERSION}" ]]; then
  VERSION="v$(node -p "require('${REPO_ROOT}/package.json').version")"
fi

STAGING_DIR="${REPO_ROOT}/staging"
DIST_DIR="${REPO_ROOT}/dist"

echo "============================================================"
echo " Building Kubera Release Packages (${VERSION})"
echo "============================================================"
echo " Repo Root   : ${REPO_ROOT}"
echo " Staging Dir : ${STAGING_DIR}"
echo " Output Dir  : ${DIST_DIR}"

rm -rf "${STAGING_DIR}" "${DIST_DIR}"
mkdir -p "${STAGING_DIR}/linux/kubera"
mkdir -p "${STAGING_DIR}/darwin/kubera"
mkdir -p "${STAGING_DIR}/windows/kubera"
mkdir -p "${STAGING_DIR}/universal/kubera"
mkdir -p "${DIST_DIR}"

# Helper function to stage common files
stage_common() {
  local target="$1"
  mkdir -p "${target}/assets"
  mkdir -p "${target}/sidecars"

  cp -p "${REPO_ROOT}/plugin.json" "${target}/"
  cp -p "${REPO_ROOT}/package.json" "${target}/"
  cp -p "${REPO_ROOT}/README.md" "${target}/"
  cp -p "${REPO_ROOT}/.gitignore" "${target}/"
  cp -rp "${REPO_ROOT}/assets/"* "${target}/assets/"
  cp -rp "${REPO_ROOT}/sidecars/"* "${target}/sidecars/"

  # Clean any temporary / editor files
  find "${target}" -name ".DS_Store" -delete 2>/dev/null || true
  find "${target}" -name "*.log" -delete 2>/dev/null || true
}

# ------------------------------------------------------------------------------
# 1. Linux Package
# ------------------------------------------------------------------------------
echo "Staging Linux package..."
PKG_LINUX="${STAGING_DIR}/linux/kubera"
stage_common "${PKG_LINUX}"
cp -p "${REPO_ROOT}/install.sh" "${PKG_LINUX}/"
cp -p "${REPO_ROOT}/uninstall.sh" "${PKG_LINUX}/"
chmod +x "${PKG_LINUX}/install.sh" "${PKG_LINUX}/uninstall.sh"

cat << 'EOF' > "${PKG_LINUX}/QUICKSTART.md"
# Kubera (Linux) Quickstart

Antigravity UI Plugin: Per-thread token consumption by model with FinOps counterfactuals.

## Prerequisites
- Google Antigravity
- Node.js 20+ on system PATH (`node --version`)

## Installation

Extract the archive and run the installer:
```bash
tar -xzf kubera-linux.tar.gz
cd kubera

# 1. Standard Installation (copies plugin into ~/.gemini/antigravity/plugins):
./install.sh --copy

# 2. Or Project-Scoped Installation (isolated to a specific workspace):
./install.sh --copy -p /path/to/my-project
```

Restart Antigravity and open the **Kubera** pane in the AuxPane.

## Uninstallation
```bash
./uninstall.sh
# Or for project-scoped:
./uninstall.sh -p /path/to/my-project
```
EOF

# ------------------------------------------------------------------------------
# 2. Darwin / macOS Package
# ------------------------------------------------------------------------------
echo "Staging Darwin / macOS package..."
PKG_DARWIN="${STAGING_DIR}/darwin/kubera"
stage_common "${PKG_DARWIN}"
cp -p "${REPO_ROOT}/install.sh" "${PKG_DARWIN}/"
cp -p "${REPO_ROOT}/uninstall.sh" "${PKG_DARWIN}/"
chmod +x "${PKG_DARWIN}/install.sh" "${PKG_DARWIN}/uninstall.sh"

cat << 'EOF' > "${PKG_DARWIN}/QUICKSTART.md"
# Kubera (macOS) Quickstart

Antigravity UI Plugin: Per-thread token consumption by model with FinOps counterfactuals.

## Prerequisites
- Google Antigravity
- Node.js 20+ on system PATH (`node --version`)

## Installation

Extract the archive and run the installer:
```bash
tar -xzf kubera-darwin.tar.gz
cd kubera

# 1. Standard Installation (copies plugin into ~/.gemini/antigravity/plugins):
./install.sh --copy

# 2. Or Project-Scoped Installation (isolated to a specific workspace):
./install.sh --copy -p /path/to/my-project
```

Restart Antigravity and open the **Kubera** pane in the AuxPane.

## Uninstallation
```bash
./uninstall.sh
# Or for project-scoped:
./uninstall.sh -p /path/to/my-project
```
EOF

# ------------------------------------------------------------------------------
# 3. Windows Package
# ------------------------------------------------------------------------------
echo "Staging Windows package..."
PKG_WINDOWS="${STAGING_DIR}/windows/kubera"
stage_common "${PKG_WINDOWS}"
cp -p "${REPO_ROOT}/install.ps1" "${PKG_WINDOWS}/"
cp -p "${REPO_ROOT}/install.cmd" "${PKG_WINDOWS}/"
cp -p "${REPO_ROOT}/install.bat" "${PKG_WINDOWS}/"
cp -p "${REPO_ROOT}/uninstall.ps1" "${PKG_WINDOWS}/"
cp -p "${REPO_ROOT}/uninstall.cmd" "${PKG_WINDOWS}/"
cp -p "${REPO_ROOT}/uninstall.bat" "${PKG_WINDOWS}/"

cat << 'EOF' > "${PKG_WINDOWS}/QUICKSTART.md"
# Kubera (Windows) Quickstart

Antigravity UI Plugin: Per-thread token consumption by model with FinOps counterfactuals.

## Prerequisites
- Google Antigravity
- Node.js 20+ on system PATH (`node --version`)

## Installation

Extract the archive (using tar built into Windows 10/11 or PowerShell):
```powershell
tar -xzf kubera-windows.tar.gz
cd kubera

# 1. Global Installation via PowerShell (Recommended):
.\install.ps1 -Copy

# 2. Or Project-Scoped Installation:
.\install.ps1 -Copy -ProjectDirectory C:\path\to\my-project

# 3. Alternatively via Windows Command Prompt (CMD):
.\install.cmd --copy
```

Restart Antigravity and open the **Kubera** pane in the AuxPane.

## Uninstallation
```powershell
.\uninstall.ps1
# Or CMD:
.\uninstall.cmd
```
EOF

# ------------------------------------------------------------------------------
# 4. Universal Package
# ------------------------------------------------------------------------------
echo "Staging Universal multi-platform package..."
PKG_UNIVERSAL="${STAGING_DIR}/universal/kubera"
stage_common "${PKG_UNIVERSAL}"
cp -p "${REPO_ROOT}/install.sh" "${PKG_UNIVERSAL}/"
cp -p "${REPO_ROOT}/uninstall.sh" "${PKG_UNIVERSAL}/"
cp -p "${REPO_ROOT}/install.ps1" "${PKG_UNIVERSAL}/"
cp -p "${REPO_ROOT}/install.cmd" "${PKG_UNIVERSAL}/"
cp -p "${REPO_ROOT}/install.bat" "${PKG_UNIVERSAL}/"
cp -p "${REPO_ROOT}/uninstall.ps1" "${PKG_UNIVERSAL}/"
cp -p "${REPO_ROOT}/uninstall.cmd" "${PKG_UNIVERSAL}/"
cp -p "${REPO_ROOT}/uninstall.bat" "${PKG_UNIVERSAL}/"
chmod +x "${PKG_UNIVERSAL}/install.sh" "${PKG_UNIVERSAL}/uninstall.sh"

cat << 'EOF' > "${PKG_UNIVERSAL}/QUICKSTART.md"
# Kubera Multi-Platform Quickstart

Antigravity UI Plugin: Per-thread token consumption by model with FinOps counterfactuals.

This package contains installables for Linux, macOS, and Windows.

## Prerequisites
- Google Antigravity
- Node.js 20+ on system PATH (`node --version`)

## Installation

### Linux & macOS:
```bash
./install.sh --copy
# Or project-scoped:
./install.sh --copy -p /path/to/my-project
```

### Windows (PowerShell):
```powershell
.\install.ps1 -Copy
# Or project-scoped:
.\install.ps1 -Copy -ProjectDirectory C:\path\to\my-project
```

### Windows (Command Prompt):
```cmd
.\install.cmd --copy
```

Restart Antigravity and open the **Kubera** pane in the AuxPane.
EOF

# ------------------------------------------------------------------------------
# 5. Archive Packages
# ------------------------------------------------------------------------------
echo ""
echo "Creating release archives..."

# Linux
tar -czf "${DIST_DIR}/kubera-linux.tar.gz" -C "${STAGING_DIR}/linux" kubera
(cd "${STAGING_DIR}/linux" && zip -rq "${DIST_DIR}/kubera-linux.zip" kubera)

# Darwin / macOS
tar -czf "${DIST_DIR}/kubera-darwin.tar.gz" -C "${STAGING_DIR}/darwin" kubera
(cd "${STAGING_DIR}/darwin" && zip -rq "${DIST_DIR}/kubera-darwin.zip" kubera)
cp -p "${DIST_DIR}/kubera-darwin.tar.gz" "${DIST_DIR}/kubera-macos.tar.gz"
cp -p "${DIST_DIR}/kubera-darwin.zip" "${DIST_DIR}/kubera-macos.zip"

# Windows
tar -czf "${DIST_DIR}/kubera-windows.tar.gz" -C "${STAGING_DIR}/windows" kubera
(cd "${STAGING_DIR}/windows" && zip -rq "${DIST_DIR}/kubera-windows.zip" kubera)

# Universal
tar -czf "${DIST_DIR}/kubera-universal.tar.gz" -C "${STAGING_DIR}/universal" kubera
(cd "${STAGING_DIR}/universal" && zip -rq "${DIST_DIR}/kubera-universal.zip" kubera)

# ------------------------------------------------------------------------------
# 6. Compute Cryptographic Checksums
# ------------------------------------------------------------------------------
echo ""
echo "Computing SHA-256 checksums..."
(cd "${DIST_DIR}" && sha256sum kubera* > SHA256SUMS.txt)
cat "${DIST_DIR}/SHA256SUMS.txt"

# Clean up staging directory
rm -rf "${STAGING_DIR}"

echo ""
echo "============================================================"
echo " All release packages created successfully in ${DIST_DIR}:"
ls -lh "${DIST_DIR}"
echo "============================================================"
