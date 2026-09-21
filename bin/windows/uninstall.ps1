# ==============================================================================
# Kubera uninstaller for Windows (PowerShell)
#
# Removes the Kubera Antigravity UI plugin from target directories.
# ==============================================================================

[CmdletBinding()]
param(
    [Alias("p", "ProjectDir")]
    [string]$ProjectDirectory = "",

    [Alias("t", "TargetDir")]
    [string[]]$CustomTargetDirectories = @(),

    [switch]$Help
)

function Show-Usage {
    @"
Usage: .\bin\windows\uninstall.ps1 [OPTIONS]
       .\bin\windows\uninstall.cmd [OPTIONS]

Options:
  -ProjectDirectory, -p DIR   Remove plugin from a specific project workspace.
  -CustomTargetDirectories DIR Custom target plugin directories (repeatable).
  -Help, -h                   Show this help message.

Examples:
  .\bin\windows\uninstall.ps1                      # Remove from global plugin directories
  .\bin\windows\uninstall.ps1 -p C:\work\my-project # Remove from project workspace
"@
}

if ($Help) {
    Show-Usage
    exit 0
}

$ErrorActionPreference = "Stop"

$PluginName = "kubera"

$UserHome = [Environment]::GetFolderPath('UserProfile')
if (-not $UserHome) { $UserHome = $env:USERPROFILE }
if (-not $UserHome) { $UserHome = $env:HOME }

$GlobalTargets = @(
    (Join-Path $UserHome ".gemini\antigravity\plugins"),
    (Join-Path $UserHome ".gemini\config\plugins")
)

$Targets = @()
if ($CustomTargetDirectories.Count -gt 0) {
    $Targets = $CustomTargetDirectories
} elseif ($ProjectDirectory) {
    $ResolvedProject = (Resolve-Path $ProjectDirectory).Path
    $Targets = @(
        (Join-Path $ResolvedProject "_agents\plugins"),
        (Join-Path $ResolvedProject ".gemini\plugins")
    )
} else {
    $Targets = $GlobalTargets
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " Kubera Uninstaller (Windows)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

$Removed = 0
foreach ($target in $Targets) {
    $Destination = Join-Path $target $PluginName
    if (Test-Path $Destination) {
        $item = Get-Item $Destination -Force
        if ($item.LinkType) {
            [System.IO.Directory]::Delete($Destination)
        } else {
            Remove-Item -Path $Destination -Recurse -Force
        }
        Write-Host "✓ Removed: $Destination" -ForegroundColor Green
        $Removed++
    }
}

if ($Removed -eq 0) {
    Write-Host "No active Kubera installations found in target directories." -ForegroundColor Yellow
} else {
    Write-Host "Kubera uninstalled successfully. Restart Antigravity to apply changes." -ForegroundColor Cyan
}
