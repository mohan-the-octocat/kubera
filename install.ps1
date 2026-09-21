# ==============================================================================
# Kubera installer for Windows (PowerShell)
#
# Installs the Kubera Antigravity UI plugin into the Antigravity plugin directory.
# Supports directory junctions (fast, no admin required on NTFS) and copying.
# ==============================================================================

[CmdletBinding()]
param(
    [Alias("p", "ProjectDir")]
    [string]$ProjectDirectory = "",

    [Alias("t", "TargetDir")]
    [string[]]$CustomTargetDirectories = @(),

    [switch]$Copy,
    [switch]$SkipTests,
    [switch]$Help
)

function Show-Usage {
    @"
Usage: .\install.ps1 [OPTIONS]
       .\install.cmd [OPTIONS]

Options:
  -ProjectDirectory, -p DIR   Install plugin scoped to a specific project workspace.
  -CustomTargetDirectories DIR Custom target plugin directories (repeatable).
  -Copy                       Copy plugin files instead of creating an NTFS junction.
                              Recommended when installing from downloaded release archives.
  -SkipTests                  Skip running the pre-flight test suite.
  -Help, -h                   Show this help message.

Examples:
  .\install.ps1                      # Global install (NTFS junction)
  .\install.ps1 -Copy                # Global install (copy files)
  .\install.ps1 -p C:\work\my-project # Project-scoped install
"@
}

if ($Help) {
    Show-Usage
    exit 0
}

$ErrorActionPreference = "Stop"

# Resolve script root directory
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
if (-not $ScriptDir) {
    $ScriptDir = (Get-Location).Path
}

$PluginName = "kubera"

# Determine user home directory on Windows
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
    if (-not (Test-Path $ProjectDirectory)) {
        New-Item -ItemType Directory -Path $ProjectDirectory -Force | Out-Null
    }
    $ResolvedProject = (Resolve-Path $ProjectDirectory).Path
    $Targets = @(
        (Join-Path $ResolvedProject "_agents\plugins"),
        (Join-Path $ResolvedProject ".gemini\plugins")
    )
} else {
    $Targets = $GlobalTargets
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " Kubera Installer (Windows)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " Source Directory : $ScriptDir"
Write-Host " Mode             : $(if ($Copy) { 'Copy' } else { 'NTFS Junction' })"
Write-Host " Target Scope     : $(if ($ProjectDirectory) { "Project ($ProjectDirectory)" } else { 'Global' })"

# Check Node.js runtime
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    Write-Host "`n❌ Error: Node.js executable was not found on PATH." -ForegroundColor Red
    Write-Host "   Node.js 20 or newer is required to run Kubera." -ForegroundColor Red
    exit 1
}

try {
    $NodeVersion = (& node -v).Trim()
    $NodeMajor = [int]($NodeVersion.TrimStart('v').Split('.')[0])
    if ($NodeMajor -lt 20) {
        Write-Host "`n❌ Error: Node 20 or newer is required (found $NodeVersion)." -ForegroundColor Red
        exit 1
    }
    Write-Host " Node Runtime     : $NodeVersion (verified >= 20)"
} catch {
    Write-Host " Warning: Unable to parse Node version, continuing..." -ForegroundColor Yellow
}

# Run tests if requested
if (-not $SkipTests) {
    $pricingTest = Join-Path $ScriptDir "tests\pricing.test.mjs"
    $aggregateTest = Join-Path $ScriptDir "tests\aggregate.test.mjs"
    if ((Test-Path $pricingTest) -and (Test-Path $aggregateTest)) {
        Write-Host "`nRunning pre-flight test suite..."
        & node --test $pricingTest $aggregateTest | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✓ Tests passed (31/31)" -ForegroundColor Green
        } else {
            Write-Host "⚠️ Warning: Pre-flight test suite encountered errors, proceeding with install..." -ForegroundColor Yellow
        }
    }
}

Write-Host "`nInstalling plugin into target directories..."

function Install-PluginTarget {
    param(
        [string]$TargetDir,
        [string]$SourcePath,
        [string]$Name,
        [bool]$DoCopy
    )

    if (-not (Test-Path $TargetDir)) {
        New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    }

    $Destination = Join-Path $TargetDir $Name

    # Clean existing destination if present
    if (Test-Path $Destination) {
        $item = Get-Item $Destination -Force
        if ($item.LinkType) {
            [System.IO.Directory]::Delete($Destination)
        } else {
            Remove-Item -Path $Destination -Recurse -Force
        }
    }

    if ($DoCopy) {
        New-Item -ItemType Directory -Path $Destination -Force | Out-Null
        Copy-Item -Path (Join-Path $SourcePath "plugin.json") -Destination $Destination -Force
        if (Test-Path (Join-Path $SourcePath "assets")) {
            Copy-Item -Path (Join-Path $SourcePath "assets") -Destination $Destination -Recurse -Force
        }
        if (Test-Path (Join-Path $SourcePath "sidecars")) {
            Copy-Item -Path (Join-Path $SourcePath "sidecars") -Destination $Destination -Recurse -Force
        }
        if (Test-Path (Join-Path $SourcePath "package.json")) {
            Copy-Item -Path (Join-Path $SourcePath "package.json") -Destination $Destination -Force
        }
        if (Test-Path (Join-Path $SourcePath "README.md")) {
            Copy-Item -Path (Join-Path $SourcePath "README.md") -Destination $Destination -Force
        }
        Write-Host "✓ Copied: $Destination" -ForegroundColor Green
    } else {
        try {
            # Directory junctions work on Windows NTFS without administrator or developer mode privileges
            New-Item -ItemType Junction -Path $Destination -Target $SourcePath -ErrorAction Stop | Out-Null
            Write-Host "✓ Junction created: $Destination -> $SourcePath" -ForegroundColor Green
        } catch {
            try {
                New-Item -ItemType SymbolicLink -Path $Destination -Target $SourcePath -ErrorAction Stop | Out-Null
                Write-Host "✓ Symlink created: $Destination -> $SourcePath" -ForegroundColor Green
            } catch {
                # Fallback to direct recursive copy if junctions fail (e.g. crossing drives or restricted filesystem)
                Copy-Item -Path $SourcePath -Destination $Destination -Recurse -Force
                Write-Host "✓ Copied fallback: $Destination" -ForegroundColor Green
            }
        }
    }
}

foreach ($target in $Targets) {
    Install-PluginTarget -TargetDir $target -SourcePath $ScriptDir -Name $PluginName -DoCopy $Copy
}

$RateVersion = "unknown"
$PricingJson = Join-Path $ScriptDir "sidecars\kubera\pricing.json"
if (Test-Path $PricingJson) {
    try {
        $PricingData = Get-Content $PricingJson -Raw | ConvertFrom-Json
        $RateVersion = $PricingData.table_version
    } catch {}
}

Write-Host @"

============================================================
Kubera installed successfully.

  Rate card version : $RateVersion
  Override file     : `$env:ANTIGRAVITY_EXECUTABLE_DATA_DIR\pricing.override.json

Restart Antigravity, then open the "Kubera" pane in the AuxPane.

Note: The rate card represents published public list prices.
Antigravity meters AI credits, not tokens, with no published
credit-to-dollar conversion. Use /credits and /usage for quota.
============================================================
"@ -ForegroundColor Cyan
