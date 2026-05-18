<#
.SYNOPSIS
    Installs, builds, and launches the read-only MCP filesystem server.

.DESCRIPTION
    - Verifies Node.js and npm are installed.
    - Runs `npm install` and `npm run build` from the script's directory (skip with -SkipInstall).
    - Validates every -AllowedRoots entry exists.
    - Generates a 48-byte URL-safe random API key if one is not provided.
    - Saves the key to .\.mcp-api-key (gitignored) for convenience.
    - Prints the key, a Copilot mcp.json snippet, and the matching `cloudflared` command.
    - Launches the server in HTTP mode (default) or stdio mode (with -Stdio).

.PARAMETER AllowedRoots
    One or more directories the server is allowed to read from. Required.

.PARAMETER Port
    HTTP port to listen on. Defaults to 8787.

.PARAMETER Host
    HTTP bind address. Defaults to 127.0.0.1.

.PARAMETER ApiKey
    API key clients must present. If omitted, a fresh 48-byte URL-safe random key is generated.

.PARAMETER SkipInstall
    Skip `npm install` / `npm run build`. Use when you've already built.

.PARAMETER Stdio
    Run in stdio mode (no API key required) instead of HTTP mode.

.EXAMPLE
    .\install.ps1 -AllowedRoots 'C:\Users\you\projects'

.EXAMPLE
    .\install.ps1 -AllowedRoots 'C:\code','D:\notes' -Port 9000

.EXAMPLE
    .\install.ps1 -AllowedRoots 'C:\code' -Stdio
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string[]]$AllowedRoots,

    [Parameter()]
    [ValidateRange(1, 65535)]
    [int]$Port = 8787,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$Host = '127.0.0.1',

    [Parameter()]
    [string]$ApiKey,

    [Parameter()]
    [switch]$SkipInstall,

    [Parameter()]
    [switch]$Stdio
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-CommandOnPath {
    param([Parameter(Mandatory = $true)][string]$Name)
    return [bool](Get-Command -Name $Name -ErrorAction SilentlyContinue)
}

function New-UrlSafeRandomKey {
    param([Parameter(Mandatory = $true)][int]$NumBytes)
    $bytes = New-Object byte[] $NumBytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    }
    finally {
        $rng.Dispose()
    }
    $b64 = [System.Convert]::ToBase64String($bytes)
    return ($b64 -replace '\+', '-' -replace '/', '_' -replace '=', '')
}

$scriptDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($scriptDir)) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
}

Push-Location $scriptDir
try {
    Write-Host "==> Verifying prerequisites..." -ForegroundColor Cyan
    if (-not (Test-CommandOnPath -Name 'node')) {
        throw "Node.js is not on PATH. Install it from https://nodejs.org/ and re-run."
    }
    if (-not (Test-CommandOnPath -Name 'npm')) {
        throw "npm is not on PATH. Install Node.js (which ships with npm) and re-run."
    }
    $nodeVersion = (& node --version) 2>$null
    $npmVersion = (& npm --version) 2>$null
    Write-Host "    node: $nodeVersion"
    Write-Host "    npm:  $npmVersion"

    Write-Host "==> Validating allowed roots..." -ForegroundColor Cyan
    $resolvedRoots = @()
    foreach ($root in $AllowedRoots) {
        if (-not (Test-Path -LiteralPath $root)) {
            throw "Allowed root does not exist: $root"
        }
        $item = Get-Item -LiteralPath $root
        if (-not $item.PSIsContainer) {
            throw "Allowed root is not a directory: $root"
        }
        $resolvedRoots += $item.FullName
        Write-Host "    ok: $($item.FullName)"
    }

    if (-not $SkipInstall.IsPresent) {
        Write-Host "==> Running npm install..." -ForegroundColor Cyan
        & npm install
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed (exit code $LASTEXITCODE)."
        }

        Write-Host "==> Running npm run build..." -ForegroundColor Cyan
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "npm run build failed (exit code $LASTEXITCODE)."
        }
    }
    else {
        Write-Host "==> Skipping npm install / build (--SkipInstall)" -ForegroundColor Yellow
    }

    $distIndex = Join-Path $scriptDir 'dist\index.js'
    if (-not (Test-Path -LiteralPath $distIndex)) {
        throw "Build artifact missing: $distIndex. Re-run without -SkipInstall."
    }

    if ($Stdio.IsPresent) {
        Write-Host ""
        Write-Host "============================================================" -ForegroundColor Green
        Write-Host " Launching MCP filesystem server (stdio mode, read-only)"     -ForegroundColor Green
        Write-Host "============================================================" -ForegroundColor Green
        Write-Host ""
        Write-Host "Allowed roots:"
        $resolvedRoots | ForEach-Object { Write-Host "  - $_" }
        Write-Host ""
        Write-Host "Use this in your MCP client (Claude Desktop / VS Code):"
        $clientArgs = @('"' + $distIndex + '"') + ($resolvedRoots | ForEach-Object { '"' + $_ + '"' })
        Write-Host "  command: node"
        Write-Host "  args:    $($clientArgs -join ' ')"
        Write-Host ""
        $launchArgs = @($distIndex) + $resolvedRoots
        & node @launchArgs
        return
    }

    if ([string]::IsNullOrEmpty($ApiKey)) {
        Write-Host "==> Generating new 48-byte URL-safe API key..." -ForegroundColor Cyan
        $ApiKey = New-UrlSafeRandomKey -NumBytes 48
    }
    else {
        Write-Host "==> Using API key provided via -ApiKey" -ForegroundColor Cyan
    }

    $keyFile = Join-Path $scriptDir '.mcp-api-key'
    Set-Content -LiteralPath $keyFile -Value $ApiKey -NoNewline -Encoding ASCII

    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host " MCP filesystem server (read-only, HTTP mode)"                  -ForegroundColor Green
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Listening on:        http://$Host`:$Port"
    Write-Host "API key:             $ApiKey"
    Write-Host "Key saved to:        $keyFile (gitignored)"
    Write-Host "Allowed roots:"
    $resolvedRoots | ForEach-Object { Write-Host "  - $_" }
    Write-Host ""
    Write-Host "Expose this with Cloudflare Quick Tunnel (in a separate terminal):"
    Write-Host "    cloudflared tunnel --url http://$Host`:$Port" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Then point GitHub Copilot / any MCP client at the printed *.trycloudflare.com URL"
    Write-Host "using one of these auth headers:"
    Write-Host "    X-API-Key: $ApiKey"
    Write-Host "    Authorization: Bearer $ApiKey"
    Write-Host ""
    Write-Host "Example Copilot mcp.json snippet:"
    Write-Host '    {'
    Write-Host '      "servers": {'
    Write-Host '        "filesystem": {'
    Write-Host '          "type": "http",'
    Write-Host '          "url": "https://<your-tunnel>.trycloudflare.com",'
    Write-Host "          `"headers`": { `"X-API-Key`": `"$ApiKey`" }"
    Write-Host '        }'
    Write-Host '      }'
    Write-Host '    }'
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host ""

    $launchArgs = @(
        $distIndex,
        '--http',
        '--port', $Port,
        '--host', $Host,
        '--api-key', $ApiKey
    ) + $resolvedRoots

    & node @launchArgs
}
finally {
    Pop-Location
}
