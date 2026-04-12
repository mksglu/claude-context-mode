#Requires -Version 5.1
<#
.SYNOPSIS
    Install context-mode globally from local source.
.DESCRIPTION
    Runs npm install -g . from the repo root so the context-mode binary
    is available system-wide. Run build.ps1 first.
.EXAMPLE
    .\scripts\deploy.ps1
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path $PSScriptRoot -Parent

function Write-Step([string]$msg) { Write-Host "  >> $msg" -ForegroundColor Cyan }
function Write-OK([string]$msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Err([string]$msg)  { Write-Host "  ERR $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "context-mode: deploy (global install)" -ForegroundColor White
Write-Host ("=" * 40)

# Check build artifacts exist
if (-not (Test-Path (Join-Path $RepoRoot 'server.bundle.mjs'))) {
    Write-Err "server.bundle.mjs not found. Run build.ps1 first."
    exit 1
}
if (-not (Test-Path (Join-Path $RepoRoot 'cli.bundle.mjs'))) {
    Write-Err "cli.bundle.mjs not found. Run build.ps1 first."
    exit 1
}

Write-Step "Running npm install -g ..."
Push-Location $RepoRoot
try {
    npm install -g .
    if ($LASTEXITCODE -ne 0) {
        Write-Err "npm install -g . failed (exit $LASTEXITCODE)"
        exit 1
    }
} finally {
    Pop-Location
}

# Verify binary is on PATH
$bin = Get-Command context-mode -ErrorAction SilentlyContinue
if (-not $bin) {
    Write-Err "'context-mode' not found in PATH after install."
    Write-Err "Check that npm's global bin directory is in your PATH:"
    Write-Err "  npm config get prefix"
    exit 1
}

$ver = (npm list -g context-mode --depth=0 2>&1) -match 'context-mode@' | ForEach-Object { ($_ -split '@')[1] }
Write-OK "context-mode@$ver installed at $($bin.Source)"
Write-Host ""
Write-Host "Next step: run setup-tools.ps1 to configure your coding tools." -ForegroundColor DarkGray
Write-Host ""
