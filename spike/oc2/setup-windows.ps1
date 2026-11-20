# Windows half of the spike sandbox. setup-windows.sh builds oc2.tar on Linux (the stand needs no git) and copies it
# with this script to -Root. Everything stays under -Root: portable Bun, caches, temp files, home. Nothing is installed.
#   setup-windows.ps1 -Action setup            unpack oc2.tar, fetch Bun (SHA-256 checked), bun install
#   setup-windows.ps1 -Action run -Check s5    run harness\s5.ts; output in oc2\.run\s5.out and .err, .out also printed
#   setup-windows.ps1 -Action clean            stop processes started from -Root and delete -Root
param(
  [ValidateSet("setup", "run", "clean")][string]$Action = "setup",
  [string]$Check = "",
  [string]$Root = "C:\lab\b0-windows",
  [string]$BunVersion = "1.4.4"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$oc2 = Join-Path $Root "oc2"
$logs = Join-Path $oc2 ".run"

# Native tools run through cmd with their own redirections: Windows PowerShell 5.1 turns redirected stderr lines into
# errors, and with "Stop" the first progress line would end the script.
function Invoke-Native([string]$line) {
  cmd /c $line
  if ($LASTEXITCODE -ne 0) { throw "exit $LASTEXITCODE`: $line" }
}

if ($Action -eq "clean") {
  Set-Location C:\
  Get-Process | Where-Object { $_.Path -like "$Root\*" } | Stop-Process -Force
  Start-Sleep -Seconds 2
  # rd copes with paths longer than 260 characters inside node_modules; Remove-Item in PowerShell 5.1 does not.
  cmd /c rd /s /q "$Root"
  if (Test-Path -LiteralPath $Root) { throw "could not remove $Root" }
  "removed $Root"
  exit 0
}

# Bun, OpenCode and Electron default to the user profile for caches and temp files; keep all of it under -Root.
# os.homedir() on Windows follows USERPROFILE, not HOME.
$env:USERPROFILE = Join-Path $Root "home"
$env:HOME = $env:USERPROFILE
$env:TEMP = Join-Path $Root "tmp"
$env:TMP = $env:TEMP
$env:XDG_CACHE_HOME = Join-Path $Root "cache"
$env:BUN_INSTALL = Join-Path $Root "bun-home"
$env:BUN_INSTALL_CACHE_DIR = Join-Path $Root "cache\bun-install"
$env:BUN_RUNTIME_TRANSPILER_CACHE_PATH = Join-Path $Root "cache\bun-transpiler"
$env:npm_config_cache = Join-Path $Root "cache\npm"
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = "1"
$env:HUSKY = "0"
foreach ($dir in $env:USERPROFILE, $env:TEMP, $env:XDG_CACHE_HOME) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

# Bun's default Windows build needs AVX2; virtual CPUs without it get the baseline build.
Add-Type -Name Cpu -Namespace Spike -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint feature);'
$bunName = if ([Spike.Cpu]::IsProcessorFeaturePresent(40)) { "bun-windows-x64" } else { "bun-windows-x64-baseline" }
$bunDir = Join-Path $Root "bun\$bunName"
$env:PATH = "$bunDir;$env:PATH"

if ($Action -eq "run") {
  if (-not $Check) { throw "-Check is required, for example -Check s5" }
  New-Item -ItemType Directory -Force -Path $logs | Out-Null
  Set-Location (Join-Path $oc2 "harness")
  cmd /c "bun $Check.ts > `"$logs\$Check.out`" 2> `"$logs\$Check.err`""
  $code = $LASTEXITCODE
  Get-Content -Encoding UTF8 "$logs\$Check.out"
  exit $code
}

if (-not (Test-Path -LiteralPath (Join-Path $bunDir "bun.exe"))) {
  $base = "https://github.com/oven-sh/bun/releases/download/bun-v$BunVersion"
  $zip = Join-Path $Root "bun\$bunName.zip"
  New-Item -ItemType Directory -Force -Path (Split-Path $zip) | Out-Null
  Invoke-Native "curl.exe -fsSL -o `"$zip`" $base/$bunName.zip 2>&1"
  $sums = cmd /c "curl.exe -fsSL $base/SHASUMS256.txt 2>&1"
  $expected = (($sums | Where-Object { $_ -match "\s$bunName\.zip$" }) -split "\s+")[0]
  $actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
  if (-not $expected -or $actual -ne $expected.ToLower()) { throw "SHA-256 mismatch for $bunName.zip: $actual vs $expected" }
  Expand-Archive -Path $zip -DestinationPath (Join-Path $Root "bun") -Force
  "bun $BunVersion $bunName sha256 $actual"
}
"bun --version: $(cmd /c 'bun --version 2>&1')"

Invoke-Native "tar -xf `"$Root\oc2.tar`" -C `"$Root`" 2>&1"
New-Item -ItemType Directory -Force -Path $logs | Out-Null
Set-Location (Join-Path $oc2 "opencode")
$started = Get-Date
cmd /c "bun install > `"$logs\bun-install.log`" 2>&1"
$code = $LASTEXITCODE
Get-Content -Encoding UTF8 "$logs\bun-install.log" | Select-Object -Last 15
if ($code -ne 0) { throw "bun install failed: exit $code" }
"bun install took $([int]((Get-Date) - $started).TotalSeconds) s"
