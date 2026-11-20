# B0.4b on the Windows stand. installed-windows.sh copies win-unpacked.tgz, nsis-kit\ and the harness to -Root.
# Everything of the check lives under -Root. Outside it only the installer writes its per-user entries (Start menu
# shortcut, HKCU uninstall key), and the uninstaller removes them. The snapshots before and after list what changed.
#   -Action setup   portable Bun (baseline without AVX2, SHA-256 checked), unpack win-unpacked, electron-builder for the kit
#   -Action nsis    NSIS installer around win-unpacked: electron-builder --prepackaged, as upstream's release flow does
#   -Action run     snapshot, harness\installed.ts windows <installer>, snapshot, diff; JSON on stdout
#   -Action clean   stop processes started from -Root and delete it
param(
  [ValidateSet("setup", "nsis", "run", "clean")][string]$Action = "setup",
  [string]$Root = "C:\lab\b0-installed",
  [string]$BunVersion = "1.4.4"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$kit = Join-Path $Root "nsis-kit"
$logs = Join-Path $Root "logs"

# Native tools run through cmd with their own redirections: Windows PowerShell 5.1 turns redirected stderr lines into
# errors, and with "Stop" the first progress line would end the script.
function Invoke-Native([string]$line) {
  cmd /c $line
  if ($LASTEXITCODE -ne 0) { throw "exit $LASTEXITCODE`: $line" }
}

# What a per-user install can touch, by name only. Known folders come from the shell, not from the redirected env.
function Get-Snapshot {
  $folder = { param($name) [Environment]::GetFolderPath($name) }
  $names = { param($path) @(Get-ChildItem -LiteralPath $path -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) }
  $userTemp = [Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable("TEMP", "User"))
  [ordered]@{
    uninstallKeys = @(Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue | ForEach-Object { $_.PSChildName })
    classes = @(Get-ChildItem "HKCU:\Software\Classes" -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match "opencode" } | ForEach-Object { $_.PSChildName })
    run = @((Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -ErrorAction SilentlyContinue).PSObject.Properties | Where-Object { $_.Name -notlike "PS*" } | ForEach-Object { $_.Name })
    startMenu = @(Get-ChildItem -LiteralPath (& $folder "Programs") -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName.Substring((& $folder "Programs").Length) })
    desktop = & $names (& $folder "Desktop")
    documents = & $names (& $folder "MyDocuments")
    profile = & $names (& $folder "UserProfile")
    appData = & $names (& $folder "ApplicationData")
    localAppData = & $names (& $folder "LocalApplicationData")
    programs = & $names (Join-Path (& $folder "LocalApplicationData") "Programs")
    temp = & $names $userTemp
    userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskPath + $_.TaskName })
    firewallRules = @(Get-NetFirewallRule -ErrorAction SilentlyContinue).Count
    services = @(Get-Service -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    listening = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalPort } | Sort-Object -Unique)
    processesFromRoot = @(Get-Process | Where-Object { $_.Path -like "$Root\*" } | ForEach-Object { "$($_.Id) $($_.Path)" })
  }
}

function Compare-Snapshot($before, $after) {
  $diff = [ordered]@{}
  foreach ($key in $before.Keys) {
    $a = @($before[$key]); $b = @($after[$key])
    $added = @($b | Where-Object { $a -notcontains $_ }); $removed = @($a | Where-Object { $b -notcontains $_ })
    if ($added.Count -or $removed.Count) { $diff[$key] = [ordered]@{ added = $added; removed = $removed } }
  }
  $diff
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

# Bun and electron-builder default to the user profile for caches and temp files; keep them under -Root. The run
# itself gives the app its own home, TEMP and userData (harness\installed.ts).
$env:TEMP = Join-Path $Root "tmp"
$env:TMP = $env:TEMP
$env:BUN_INSTALL = Join-Path $Root "bun-home"
$env:BUN_INSTALL_CACHE_DIR = Join-Path $Root "cache\bun-install"
$env:BUN_RUNTIME_TRANSPILER_CACHE_PATH = Join-Path $Root "cache\bun-transpiler"
$env:ELECTRON_BUILDER_CACHE = Join-Path $Root "cache\electron-builder"
$env:HUSKY = "0"
foreach ($dir in $env:TEMP, $logs) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

Add-Type -Name Cpu -Namespace Spike -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint feature);'
$bunName = if ([Spike.Cpu]::IsProcessorFeaturePresent(40)) { "bun-windows-x64" } else { "bun-windows-x64-baseline" }
$bunDir = Join-Path $Root "bun\$bunName"
$env:PATH = "$bunDir;$env:PATH"

if ($Action -eq "setup") {
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
    Remove-Item -LiteralPath $zip
    "bun $BunVersion $bunName sha256 $actual"
  }
  "bun --version: $(cmd /c 'bun --version 2>&1')"
  Invoke-Native "tar -xf `"$Root\win-unpacked.tgz`" -C `"$Root`" 2>&1"
  Remove-Item -LiteralPath "$Root\win-unpacked.tgz"
  Set-Location $kit
  $started = Get-Date
  cmd /c "bun install > `"$logs\kit-install.log`" 2>&1"
  $code = $LASTEXITCODE
  Get-Content -Encoding UTF8 "$logs\kit-install.log" | Select-Object -Last 8
  if ($code -ne 0) { throw "bun install failed: exit $code" }
  "kit bun install took $([int]((Get-Date) - $started).TotalSeconds) s"
  exit 0
}

if ($Action -eq "nsis") {
  Set-Location $kit
  $started = Get-Date
  cmd /c "bun x --bun electron-builder --win --x64 --prepackaged `"$Root\win-unpacked`" --config builder.json --publish never > `"$logs\nsis.log`" 2>&1"
  $code = $LASTEXITCODE
  Get-Content -Encoding UTF8 "$logs\nsis.log" | Select-Object -Last 15
  if ($code -ne 0) { throw "electron-builder failed: exit $code" }
  "nsis took $([int]((Get-Date) - $started).TotalSeconds) s"
  Get-ChildItem -LiteralPath (Join-Path $kit "dist") -Filter *.exe | ForEach-Object { "$($_.Name) $($_.Length) sha256 $((Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLower())" }
  exit 0
}

# run
$installer = Get-ChildItem -LiteralPath (Join-Path $kit "dist") -Filter "opencode-desktop-win-*.exe" | Select-Object -First 1 -ExpandProperty FullName
if (-not $installer) { throw "no installer in $kit\dist; run -Action nsis first" }
$before = Get-Snapshot
Set-Location (Join-Path $Root "oc2\harness")
cmd /c "bun installed.ts windows `"$installer`" > `"$logs\installed.out`" 2> `"$logs\installed.err`""
$code = $LASTEXITCODE
$after = Get-Snapshot
$diff = Compare-Snapshot $before $after
[ordered]@{ before = $before; after = $after; diff = $diff } | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $logs "snapshot.json")
Get-Content -Encoding UTF8 "$logs\installed.out"
"snapshot diff: $($diff | ConvertTo-Json -Depth 5 -Compress)"
exit $code
