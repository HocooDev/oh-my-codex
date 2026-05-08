$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$entry = Join-Path $scriptDir '..\..\dist\scripts\explore-windows-harness.js'
node $entry @args
