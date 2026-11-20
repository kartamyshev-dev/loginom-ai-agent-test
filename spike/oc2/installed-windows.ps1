# B0.4b on the Windows stand: build the NSIS installer of the sandbox here, install it, check it, remove it.
# The SSH link to the stand uploads at tens of KB/s, so the stand fetches everything heavy itself: the v2.3.0 source
# from GitHub, packages from npm, Electron and the NSIS toolset from GitHub. installed-windows.sh uploads only the
# overlay (files the patches change, the product plugin, the tag's 29 symlinks as plain files) and the harness.
# Everything lives under -Root. Outside it only the installer writes its per-user entries (Start menu shortcut, HKCU
# uninstall key), and the uninstaller removes them; snapshots before and after list what changed.
#   -Action setup   portable Bun (baseline without AVX2), source + overlay, bun install
#   -Action build   CLI (bun build --compile, bun-windows-x64-baseline), Desktop out/, NSIS installer: the same
#                   upstream scripts and spike config as build-installed.sh on Linux
#   -Action run     snapshot, harness\installed.ts windows <installer>, snapshot, diff
#   -Action clean   stop processes started from -Root and delete it
param(
  [ValidateSet("setup", "build", "run", "clean")][string]$Action = "setup",
  [string]$Root = "C:\lab\b0-installed",
  [string]$BunVersion = "1.4.4",
  [string]$Tag = "v2.3.0",
  [string]$Version = "2.3.0-b04"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$oc2 = Join-Path $Root "oc2"
$src = Join-Path $oc2 "opencode"
$logs = Join-Path $Root "logs"
$dist = Join-Path $Root "dist"

# Native tools run through cmd with their own redirections: Windows PowerShell 5.1 turns redirected stderr lines into
# errors, and with "Stop" the first progress line would end the script.
function Invoke-Native([string]$line) {
  cmd /c $line
  if ($LASTEXITCODE -ne 0) { throw "exit $LASTEXITCODE`: $line" }
}

# A long step with its output in logs\<name>.log, the tail and the time printed.
function Invoke-Step([string]$name, [string]$dir, [string]$line) {
  Set-Location $dir
  $started = Get-Date
  cmd /c "$line > `"$logs\$name.log`" 2>&1"
  $code = $LASTEXITCODE
  Get-Content -Encoding UTF8 "$logs\$name.log" | Select-Object -Last 6
  "$name`: exit $code, $([int]((Get-Date) - $started).TotalSeconds) s"
  if ($code -ne 0) { throw "$name failed: exit $code" }
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

# Bun, the builds and electron-builder default to the user profile for caches and temp files; keep them under -Root.
# The run itself gives the app its own home, TEMP and userData (harness\installed.ts).
$env:TEMP = Join-Path $Root "tmp"
$env:TMP = $env:TEMP
$env:BUN_INSTALL = Join-Path $Root "bun-home"
$env:BUN_INSTALL_CACHE_DIR = Join-Path $Root "cache\bun-install"
$env:BUN_RUNTIME_TRANSPILER_CACHE_PATH = Join-Path $Root "cache\bun-transpiler"
$env:ELECTRON_BUILDER_CACHE = Join-Path $Root "cache\electron-builder"
$env:electron_config_cache = Join-Path $Root "cache\electron"
$env:XDG_CACHE_HOME = Join-Path $Root "cache"
$env:npm_config_cache = Join-Path $Root "cache\npm"
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = "1"
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
  # The release zip has no bunx; the scripts call it. Bun acts as `bun x` when its executable is named bunx.
  $bunx = Join-Path $bunDir "bunx.exe"
  if (-not (Test-Path -LiteralPath $bunx)) { New-Item -ItemType HardLink -Path $bunx -Target (Join-Path $bunDir "bun.exe") | Out-Null }
  "bun --version: $(cmd /c 'bun --version 2>&1')"
  if (Test-Path -LiteralPath (Join-Path $src "node_modules")) {
    "source and dependencies already in $src"
    Invoke-Step "electron-builder-version" (Join-Path $src "packages\desktop") "bunx electron-builder --version"
    exit 0
  }
  # The tag's source from GitHub; its symlinks are skipped (they come as plain files in the overlay), so extraction
  # does not depend on the session's right to create symlinks.
  $archive = Join-Path $Root "source.tgz"
  Invoke-Native "curl.exe -fsSL -o `"$archive`" https://codeload.github.com/anomalyco/opencode/tar.gz/refs/tags/$Tag 2>&1"
  "source $Tag sha256 $((Get-FileHash -Algorithm SHA256 $archive).Hash.ToLower()) bytes $((Get-Item $archive).Length)"
  $prefix = "opencode-$($Tag.TrimStart('v'))"
  Get-Content (Join-Path $Root "overlay-files.txt") | ForEach-Object { "$prefix/$_" } | Set-Content -Encoding ASCII (Join-Path $Root "exclude.txt")
  if (Test-Path -LiteralPath $src) { cmd /c rd /s /q "$src" }
  Invoke-Native "tar -xzf `"$archive`" -C `"$oc2`" -X `"$Root\exclude.txt`" 2>&1"
  Rename-Item -LiteralPath (Join-Path $oc2 $prefix) "opencode"
  Invoke-Native "tar -xf `"$Root\overlay.tar.xz`" -C `"$src`" 2>&1"
  Remove-Item -LiteralPath $archive
  Invoke-Step "bun-install" $src "bun install"
  Invoke-Step "electron-builder-version" (Join-Path $src "packages\desktop") "bunx electron-builder --version"
  exit 0
}

if ($Action -eq "build") {
  # The CLI takes the `latest` channel and the Desktop `prod`, as on Linux; the web UI is skipped, as the Desktop sets
  # OPENCODE_DISABLE_EMBEDDED_WEB_UI. On Windows script/build.ts names the copied CLI opencode-cli.exe itself.
  $env:OPENCODE_VERSION = $Version
  $env:OPENCODE_CHANNEL = "latest"
  $env:OPENCODE_TARGET = "windows-x64-baseline"
  Invoke-Step "cli-build" (Join-Path $src "packages\cli") "bun script/build.ts --skip-web-ui --skip-install"
  $env:OPENCODE_CHANNEL = "prod"
  $env:OPENCODE_TARGET = "windows-x64"
  $desktop = Join-Path $src "packages\desktop"
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $desktop "resources\opencode-cli*")
  Invoke-Step "desktop-build" $desktop "bun run script/build.ts"
  $env:B0_DIST = $dist
  if (Test-Path -LiteralPath $dist) { cmd /c rd /s /q "$dist" }
  Invoke-Step "nsis" $desktop "bunx electron-builder --win --x64 --publish never --config `"$oc2\harness\electron-builder.spike.ts`""
  Get-ChildItem -LiteralPath $dist -Filter *.exe | ForEach-Object { "$($_.Name) $($_.Length) sha256 $((Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLower())" }
  exit 0
}

# run
$installer = Get-ChildItem -LiteralPath $dist -Filter "opencode-desktop-win-*.exe" | Select-Object -First 1 -ExpandProperty FullName
if (-not $installer) { throw "no installer in $dist; run -Action build first" }
$before = Get-Snapshot
Set-Location (Join-Path $oc2 "harness")
cmd /c "bun installed.ts windows `"$installer`" > `"$logs\installed.out`" 2> `"$logs\installed.err`""
$code = $LASTEXITCODE
$after = Get-Snapshot
$diff = Compare-Snapshot $before $after
[ordered]@{ before = $before; after = $after; diff = $diff } | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $logs "snapshot.json")
Get-Content -Encoding UTF8 "$logs\installed.out"
"snapshot diff: $($diff | ConvertTo-Json -Depth 5 -Compress)"
exit $code
