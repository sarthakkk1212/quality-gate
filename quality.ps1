# Windows wrapper so you can run `./quality.ps1` instead of `python scan.py`.
# Passes every argument straight through. Read-only — see scan.py.
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = "python"
if (-not (Get-Command $py -ErrorAction SilentlyContinue)) { $py = "python3" }
& $py "$dir\scan.py" @args
exit $LASTEXITCODE
