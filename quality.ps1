# Windows wrapper so you can run `./quality.ps1` instead of `node scan.js`.
# Passes every argument straight through. Read-only — see scan.js.
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js not found on PATH. Install Node 18+ (20+ recommended): https://nodejs.org"
    exit 2
}
& node "$dir\scan.js" @args
exit $LASTEXITCODE
