#Requires -Version 5.1
<#
.SYNOPSIS
    Configure coding tools to use context-mode via MCP.
.DESCRIPTION
    Writes MCP server registration and hook configs for the selected tools.
    Existing JSON files are merged - your other settings are preserved.

    Supported tools:
      claudecode  - adds MCP server via 'claude mcp add'
      gemini      - merges ~/.gemini/settings.json
      vscode      - creates .vscode/mcp.json + .github/hooks/context-mode.json
      cursor      - creates .cursor/mcp.json, hooks.json, rules/context-mode.mdc
      opencode    - creates/merges opencode.json in project dir
      kilo        - creates/merges kilo.json in project dir
      codex       - merges ~/.codex/config.toml
      kiro        - creates .kiro/mcp.json + .kiro/hooks/context-mode.json
      antigravity - merges ~/.gemini/antigravity/mcp_config.json

.PARAMETER Tool
    One or more tool names, or 'all'. If omitted, shows an interactive menu.

.PARAMETER ProjectDir
    Directory to write project-scoped configs into (vscode, cursor, opencode,
    kilo, kiro). Defaults to the current directory.

.EXAMPLE
    .\scripts\setup-tools.ps1
    .\scripts\setup-tools.ps1 -Tool claudecode, cursor
    .\scripts\setup-tools.ps1 -Tool all -ProjectDir C:\projects\myapp
#>
[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('claudecode','gemini','antigravity','vscode','cursor','opencode','kilo','codex','kiro','all')]
    [string[]]$Tool,

    [string]$ProjectDir = (Get-Location).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot   = Split-Path $PSScriptRoot -Parent
$ConfigsDir = Join-Path $RepoRoot 'configs'

# ── Resolve absolute MCP server command ────────────────────────────────────────
# Using bare 'context-mode' requires it to be on PATH, which tools like VS Code
# and Cursor may not inherit. Prefer: node <absolute-path-to-cli.bundle.mjs>

$npmPrefix = (npm config get prefix 2>&1).Trim()
$CliBundle = Join-Path (Join-Path (Join-Path $npmPrefix 'node_modules') 'context-mode') 'cli.bundle.mjs'
$_nodeCmd  = Get-Command node -ErrorAction SilentlyContinue
$NodeExe   = if ($_nodeCmd) { $_nodeCmd.Source } else { 'node' }

if (Test-Path $CliBundle) {
    $McpCmd  = $NodeExe
    $McpArgs = @($CliBundle)
} else {
    # Global install not found - fall back to PATH-based command
    $McpCmd  = 'context-mode'
    $McpArgs = @()
}

function New-McpServerEntry {
    if ($script:McpArgs.Count -gt 0) {
        return [PSCustomObject]@{ command = $script:McpCmd; args = $script:McpArgs }
    }
    return [PSCustomObject]@{ command = $script:McpCmd }
}

# ── Helpers ────────────────────────────────────────────────────────────────────

function Write-Step([string]$msg) { Write-Host "  >> $msg" -ForegroundColor Cyan }
function Write-OK([string]$msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  !!  $msg" -ForegroundColor Yellow }
function Write-Err([string]$msg)  { Write-Host "  ERR $msg" -ForegroundColor Red }

function Ensure-Dir([string]$path) {
    if (-not (Test-Path $path)) {
        New-Item -Path $path -ItemType Directory -Force | Out-Null
    }
}

# Load JSON from a file, or return an empty PSCustomObject if file doesn't exist.
function Read-JsonFile([string]$path) {
    if (Test-Path $path) {
        return Get-Content $path -Raw | ConvertFrom-Json
    }
    return [PSCustomObject]@{}
}

# Ensure a PSCustomObject has a given property, creating it if absent.
function Ensure-Prop {
    param(
        [PSCustomObject]$obj,
        [string]$name,
        $defaultValue
    )
    if (-not $obj.PSObject.Properties[$name]) {
        $obj | Add-Member -NotePropertyName $name -NotePropertyValue $defaultValue
    }
}

# Write a PSCustomObject to a JSON file with clean formatting (no BOM).
# Set-Content -Encoding UTF8 writes a BOM in PS5.1 which breaks JSON parsers.
function Write-JsonFile([string]$path, $obj) {
    $json = $obj | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
}

# ── Per-tool setup functions ────────────────────────────────────────────────────

function Setup-ClaudeCode {
    Write-Step "Claude Code - adding MCP server via CLI"

    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        Write-Warn "'claude' CLI not found. Install Claude Code first, then re-run."
        Write-Warn "Alternatively, add manually:"
        Write-Warn "  claude mcp add context-mode -- $McpCmd $($McpArgs -join ' ')"
        return
    }

    # Remove from all scopes before re-adding with the current absolute path.
    foreach ($scope in @('local', 'user', 'project', 'dynamic', 'enterprise', 'claudeai', 'managed')) {
        try { claude mcp remove context-mode --scope $scope 2>&1 | Out-Null } catch { }
    }

    $addArgs = @('mcp', 'add', 'context-mode', '--') + @($McpCmd) + $McpArgs
    $out = & claude @addArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Err "claude mcp add failed: $out"
        return
    }
    Write-OK "MCP server registered in Claude Code (claude mcp)"

    # Write hooks to ~/.claude/settings.json
    $settingsPath = Join-Path (Join-Path $HOME '.claude') 'settings.json'
    Ensure-Dir (Split-Path $settingsPath -Parent)
    $settings = Read-JsonFile $settingsPath
    Ensure-Prop $settings 'hooks' ([PSCustomObject]@{})

    $hooksDir  = Join-Path (Join-Path (Join-Path $npmPrefix 'node_modules') 'context-mode') 'hooks'
    $nodeQ     = "`"$NodeExe`""
    $preToolMatcher = 'Bash|WebFetch|Read|Grep|Agent|Task|mcp__plugin_context-mode_context-mode__ctx_execute|mcp__plugin_context-mode_context-mode__ctx_execute_file|mcp__plugin_context-mode_context-mode__ctx_batch_execute'

    $hookDefs = @{
        PreToolUse       = @{ matcher = $preToolMatcher; script = 'pretooluse.mjs' }
        PostToolUse      = @{ matcher = '';              script = 'posttooluse.mjs' }
        PreCompact       = @{ matcher = '';              script = 'precompact.mjs' }
        SessionStart     = @{ matcher = '';              script = 'sessionstart.mjs' }
        UserPromptSubmit = @{ matcher = '';              script = 'userpromptsubmit.mjs' }
    }

    foreach ($hookType in $hookDefs.Keys) {
        $def     = $hookDefs[$hookType]
        $script  = Join-Path $hooksDir $def.script
        $cmd     = "$nodeQ `"$script`""
        $entry   = [PSCustomObject]@{ hooks = @(@{ type = 'command'; command = $cmd }) }
        if ($def.matcher) { $entry | Add-Member -NotePropertyName 'matcher' -NotePropertyValue $def.matcher }

        # Merge: keep existing non-context-mode entries, replace context-mode entry
        $existing = @()
        if ($settings.hooks.PSObject.Properties[$hookType]) {
            $existing = @($settings.hooks.$hookType | Where-Object {
                -not ($_.hooks | Where-Object { $_.command -match 'context-mode' })
            })
        }
        $settings.hooks | Add-Member -NotePropertyName $hookType `
            -NotePropertyValue ($existing + $entry) -Force
    }

    Write-JsonFile $settingsPath $settings
    Write-OK "~/.claude/settings.json (hooks)"

    # Also write to Claude Desktop config
    $desktopCfgPath = Join-Path (Join-Path $env:APPDATA 'Claude') 'claude_desktop_config.json'
    if (Test-Path (Split-Path $desktopCfgPath -Parent)) {
        $desktop = Read-JsonFile $desktopCfgPath
        Ensure-Prop $desktop 'mcpServers' ([PSCustomObject]@{})
        $desktop.mcpServers | Add-Member -NotePropertyName 'context-mode' `
            -NotePropertyValue (New-McpServerEntry) -Force

        Ensure-Prop $desktop 'hooks' ([PSCustomObject]@{})
        foreach ($hookType in $hookDefs.Keys) {
            $def    = $hookDefs[$hookType]
            $script = Join-Path $hooksDir $def.script
            $cmd    = "$nodeQ `"$script`""
            $entry  = [PSCustomObject]@{ hooks = @(@{ type = 'command'; command = $cmd }) }
            if ($def.matcher) { $entry | Add-Member -NotePropertyName 'matcher' -NotePropertyValue $def.matcher }

            $existingD = @()
            if ($desktop.hooks.PSObject.Properties[$hookType]) {
                $existingD = @($desktop.hooks.$hookType | Where-Object {
                    -not ($_.hooks | Where-Object { $_.command -match 'context-mode' })
                })
            }
            $desktop.hooks | Add-Member -NotePropertyName $hookType `
                -NotePropertyValue ($existingD + $entry) -Force
        }

        Write-JsonFile $desktopCfgPath $desktop
        Write-OK "claude_desktop_config.json (mcpServers + hooks)"
    }
}

function Setup-Gemini {
    Write-Step "Gemini CLI - merging ~/.gemini/settings.json"

    $settingsPath = Join-Path (Join-Path $HOME '.gemini') 'settings.json'
    Ensure-Dir (Split-Path $settingsPath -Parent)

    $settings = Read-JsonFile $settingsPath

    # mcpServers
    Ensure-Prop $settings 'mcpServers' ([PSCustomObject]@{})
    $settings.mcpServers | Add-Member -NotePropertyName 'context-mode' `
        -NotePropertyValue (New-McpServerEntry) -Force

    # hooks - each type is replaced wholesale (single-entry arrays)
    Ensure-Prop $settings 'hooks' ([PSCustomObject]@{})
    $templateHooks = @{
        BeforeTool  = @(@{
            matcher = 'run_shell_command|read_file|read_many_files|grep_search|search_file_content|web_fetch|activate_skill|mcp__plugin_context-mode'
            hooks   = @(@{ type = 'command'; command = 'context-mode hook gemini-cli beforetool' })
        })
        AfterTool   = @(@{ matcher = ''; hooks = @(@{ type = 'command'; command = 'context-mode hook gemini-cli aftertool' }) })
        PreCompress = @(@{ matcher = ''; hooks = @(@{ type = 'command'; command = 'context-mode hook gemini-cli precompress' }) })
        SessionStart= @(@{ matcher = ''; hooks = @(@{ type = 'command'; command = 'context-mode hook gemini-cli sessionstart' }) })
    }
    foreach ($hookType in $templateHooks.Keys) {
        $settings.hooks | Add-Member -NotePropertyName $hookType `
            -NotePropertyValue $templateHooks[$hookType] -Force
    }

    Write-JsonFile $settingsPath $settings
    Write-OK "~/.gemini/settings.json updated"
}

function Setup-VSCode {
    Write-Step "VS Code Copilot - writing .vscode/mcp.json and .github/hooks/context-mode.json"

    # .vscode/mcp.json
    $mcpDir  = Join-Path $ProjectDir '.vscode'
    $mcpPath = Join-Path $mcpDir 'mcp.json'
    Ensure-Dir $mcpDir

    $mcp = Read-JsonFile $mcpPath
    Ensure-Prop $mcp 'servers' ([PSCustomObject]@{})
    $mcp.servers | Add-Member -NotePropertyName 'context-mode' `
        -NotePropertyValue (New-McpServerEntry) -Force
    Write-JsonFile $mcpPath $mcp
    Write-OK ".vscode/mcp.json"

    # .github/hooks/context-mode.json
    $hooksDir  = Join-Path (Join-Path $ProjectDir '.github') 'hooks'
    $hooksPath = Join-Path $hooksDir 'context-mode.json'
    Ensure-Dir $hooksDir
    Copy-Item (Join-Path (Join-Path $ConfigsDir 'vscode-copilot') 'hooks.json') $hooksPath -Force
    Write-OK ".github/hooks/context-mode.json"
}

function Setup-Cursor {
    Write-Step "Cursor - writing .cursor/mcp.json, hooks.json, and rules/context-mode.mdc"

    $cursorDir = Join-Path $ProjectDir '.cursor'

    # .cursor/mcp.json
    $mcpPath = Join-Path $cursorDir 'mcp.json'
    Ensure-Dir $cursorDir
    $mcp = Read-JsonFile $mcpPath
    Ensure-Prop $mcp 'mcpServers' ([PSCustomObject]@{})
    $mcp.mcpServers | Add-Member -NotePropertyName 'context-mode' `
        -NotePropertyValue (New-McpServerEntry) -Force
    Write-JsonFile $mcpPath $mcp
    Write-OK ".cursor/mcp.json"

    # .cursor/hooks.json - copy from repo (overwrite; it's context-mode-specific)
    $hooksPath = Join-Path $cursorDir 'hooks.json'
    Copy-Item (Join-Path (Join-Path $ConfigsDir 'cursor') 'hooks.json') $hooksPath -Force
    Write-OK ".cursor/hooks.json"

    # .cursor/rules/context-mode.mdc - routing rules (required for Cursor)
    $rulesDir  = Join-Path $cursorDir 'rules'
    $mdcPath   = Join-Path $rulesDir 'context-mode.mdc'
    Ensure-Dir $rulesDir
    Copy-Item (Join-Path (Join-Path $ConfigsDir 'cursor') 'context-mode.mdc') $mdcPath -Force
    Write-OK ".cursor/rules/context-mode.mdc"
}

function Setup-OpenCode {
    Write-Step "OpenCode - writing opencode.json in project dir"

    $cfgPath = Join-Path $ProjectDir 'opencode.json'
    $cfg = Read-JsonFile $cfgPath

    # Preserve $schema if already set
    if (-not $cfg.PSObject.Properties['$schema']) {
        $cfg | Add-Member -NotePropertyName '$schema' -NotePropertyValue 'https://opencode.ai/config.json'
    }

    Ensure-Prop $cfg 'mcp' ([PSCustomObject]@{})
    $ocCmd = if ($script:McpArgs.Count -gt 0) { @($script:McpCmd) + $script:McpArgs } else { @($script:McpCmd) }
    $cfg.mcp | Add-Member -NotePropertyName 'context-mode' `
        -NotePropertyValue ([PSCustomObject]@{ type = 'local'; command = $ocCmd }) -Force

    # plugin array
    if (-not $cfg.PSObject.Properties['plugin']) {
        $cfg | Add-Member -NotePropertyName 'plugin' -NotePropertyValue @('context-mode')
    } elseif ($cfg.plugin -notcontains 'context-mode') {
        $cfg.plugin = @($cfg.plugin) + 'context-mode'
    }

    Write-JsonFile $cfgPath $cfg
    Write-OK "opencode.json"

    # Optional AGENTS.md routing file
    $agentsPath = Join-Path $ProjectDir 'AGENTS.md'
    if (-not (Test-Path $agentsPath)) {
        Copy-Item (Join-Path (Join-Path $ConfigsDir 'opencode') 'AGENTS.md') $agentsPath
        Write-OK "AGENTS.md (routing instructions)"
    } else {
        Write-Warn "AGENTS.md already exists - skipped (add routing instructions manually if needed)"
    }
}

function Setup-Kilo {
    Write-Step "KiloCode - writing kilo.json in project dir"

    $cfgPath = Join-Path $ProjectDir 'kilo.json'
    $cfg = Read-JsonFile $cfgPath

    if (-not $cfg.PSObject.Properties['$schema']) {
        $cfg | Add-Member -NotePropertyName '$schema' -NotePropertyValue 'https://app.kilo.ai/config.json'
    }

    Ensure-Prop $cfg 'mcp' ([PSCustomObject]@{})
    $kiloCmd = if ($script:McpArgs.Count -gt 0) { @($script:McpCmd) + $script:McpArgs } else { @($script:McpCmd) }
    $cfg.mcp | Add-Member -NotePropertyName 'context-mode' `
        -NotePropertyValue ([PSCustomObject]@{ type = 'local'; command = $kiloCmd }) -Force

    if (-not $cfg.PSObject.Properties['plugin']) {
        $cfg | Add-Member -NotePropertyName 'plugin' -NotePropertyValue @('context-mode')
    } elseif ($cfg.plugin -notcontains 'context-mode') {
        $cfg.plugin = @($cfg.plugin) + 'context-mode'
    }

    Write-JsonFile $cfgPath $cfg
    Write-OK "kilo.json"
}

function Setup-Codex {
    Write-Step "Codex CLI - merging ~/.codex/config.toml"

    $tomlPath = Join-Path (Join-Path $HOME '.codex') 'config.toml'
    Ensure-Dir (Split-Path $tomlPath -Parent)

    $cmdVal = if ($script:McpArgs.Count -gt 0) { $script:McpCmd } else { 'context-mode' }
    $argsVal = if ($script:McpArgs.Count -gt 0) { "`nargs = [`"$($script:McpArgs[0])`"]" } else { '' }
    $entry = "[mcp_servers.context-mode]`ncommand = `"$cmdVal`"$argsVal"

    if (Test-Path $tomlPath) {
        $content = Get-Content $tomlPath -Raw
        if ($content -match '\[mcp_servers\.context-mode\]') {
            Write-Warn "~/.codex/config.toml already contains context-mode entry - skipped"
            return
        }
        Add-Content -Path $tomlPath -Value "`n$entry"
    } else {
        [System.IO.File]::WriteAllText($tomlPath, $entry, [System.Text.UTF8Encoding]::new($false))
    }
    Write-OK "~/.codex/config.toml"
}

function Setup-Antigravity {
    Write-Step "Antigravity - merging ~/.gemini/antigravity/mcp_config.json"

    $cfgPath = Join-Path (Join-Path (Join-Path $HOME '.gemini') 'antigravity') 'mcp_config.json'
    Ensure-Dir (Split-Path $cfgPath -Parent)

    $cfg = Read-JsonFile $cfgPath
    Ensure-Prop $cfg 'mcpServers' ([PSCustomObject]@{})
    $cfg.mcpServers | Add-Member -NotePropertyName 'context-mode' `
        -NotePropertyValue (New-McpServerEntry) -Force

    Write-JsonFile $cfgPath $cfg
    Write-OK "~/.gemini/antigravity/mcp_config.json (mcpServers)"
    Write-Warn "Note: Antigravity does not support hooks - MCP only."
}

function Setup-Kiro {
    Write-Step "Kiro - writing .kiro/mcp.json and .kiro/hooks/context-mode.json"

    $kiroDir = Join-Path $ProjectDir '.kiro'

    # .kiro/mcp.json
    $mcpPath = Join-Path $kiroDir 'mcp.json'
    Ensure-Dir $kiroDir
    $mcp = Read-JsonFile $mcpPath
    Ensure-Prop $mcp 'mcpServers' ([PSCustomObject]@{})
    $mcp.mcpServers | Add-Member -NotePropertyName 'context-mode' `
        -NotePropertyValue (New-McpServerEntry) -Force
    Write-JsonFile $mcpPath $mcp
    Write-OK ".kiro/mcp.json"

    # .kiro/hooks/context-mode.json
    $hooksDir  = Join-Path $kiroDir 'hooks'
    $hooksPath = Join-Path $hooksDir 'context-mode.json'
    Ensure-Dir $hooksDir
    Copy-Item (Join-Path (Join-Path $ConfigsDir 'kiro') 'agent.json') $hooksPath -Force
    Write-OK ".kiro/hooks/context-mode.json"
}

# ── Interactive menu ────────────────────────────────────────────────────────────

$allTools = @('claudecode','gemini','antigravity','vscode','cursor','opencode','kilo','codex','kiro')
$toolLabels = @{
    claudecode  = 'Claude Code'
    gemini      = 'Gemini CLI'
    antigravity = 'Antigravity'
    vscode      = 'VS Code Copilot'
    cursor      = 'Cursor'
    opencode    = 'OpenCode'
    kilo        = 'KiloCode'
    codex       = 'Codex CLI'
    kiro        = 'Kiro'
}

if (-not $Tool) {
    Write-Host ""
    Write-Host "context-mode: setup tools" -ForegroundColor White
    Write-Host ("=" * 40)
    Write-Host "Project dir: $ProjectDir" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "Select tools to configure:" -ForegroundColor White
    for ($i = 0; $i -lt $allTools.Count; $i++) {
        Write-Host "  [$($i+1)] $($toolLabels[$allTools[$i]])"
    }
    Write-Host "  [A] All"
    Write-Host "  [Q] Quit"
    Write-Host ""
    $input = Read-Host "Enter numbers separated by commas (e.g. 1,3), A for all, or Q to quit"

    if ($input -match '^[Qq]') { exit 0 }
    if ($input -match '^[Aa]') {
        $Tool = $allTools
    } else {
        $indices = $input -split '[,\s]+' | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d+$' }
        $Tool = $indices | ForEach-Object {
            $idx = [int]$_ - 1
            if ($idx -ge 0 -and $idx -lt $allTools.Count) { $allTools[$idx] }
        }
        if (-not $Tool) {
            Write-Err "No valid selection."
            exit 1
        }
    }
}

if ($Tool -contains 'all') { $Tool = $allTools }

# ── Run selected setups ─────────────────────────────────────────────────────────

Write-Host ""
Write-Host "context-mode: setup tools" -ForegroundColor White
Write-Host ("=" * 40)
Write-Host "Project dir: $ProjectDir" -ForegroundColor DarkGray
Write-Host ""

# Verify context-mode binary exists
if (-not (Get-Command context-mode -ErrorAction SilentlyContinue)) {
    Write-Warn "'context-mode' not found in PATH - run deploy.ps1 first for best results."
    Write-Warn "Continuing anyway (configs will still be written)."
    Write-Host ""
}

$errors = 0
foreach ($t in $Tool) {
    $label = $toolLabels[$t]
    Write-Host "$label" -ForegroundColor White
    try {
        switch ($t) {
            'claudecode'  { Setup-ClaudeCode }
            'gemini'      { Setup-Gemini }
            'antigravity' { Setup-Antigravity }
            'vscode'      { Setup-VSCode }
            'cursor'      { Setup-Cursor }
            'opencode'    { Setup-OpenCode }
            'kilo'        { Setup-Kilo }
            'codex'       { Setup-Codex }
            'kiro'        { Setup-Kiro }
        }
    } catch {
        Write-Err "Failed: $_"
        $errors++
    }
    Write-Host ""
}

if ($errors -gt 0) {
    Write-Host "$errors tool(s) had errors." -ForegroundColor Yellow
    exit 1
}

Write-Host "Done. Restart your tools for changes to take effect." -ForegroundColor Green
Write-Host ""
