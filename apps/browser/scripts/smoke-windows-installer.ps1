param(
  [ValidateSet("dev", "nightly", "prerelease", "release")]
  [string]$Channel = "release",
  [ValidateSet("arm64", "x64")]
  [string]$Arch = "x64",
  [Parameter(Mandatory = $true)]
  [string]$Version
)

$ErrorActionPreference = "Stop"

$baseName = switch ($Channel) {
  "dev" { "clodex-dev" }
  "nightly" { "clodex-nightly" }
  "prerelease" { "clodex-prerelease" }
  "release" { "clodex" }
}

$browserDir = Split-Path -Parent $PSScriptRoot
$setupPath = Join-Path $browserDir "out\$Channel\make\squirrel.windows\$baseName-$Version-$Arch-setup.exe"
$installRoot = Join-Path $env:LOCALAPPDATA $baseName
$temporaryRoot = if ($env:RUNNER_TEMP) {
  $env:RUNNER_TEMP
}
else {
  [System.IO.Path]::GetTempPath()
}
$profilePath = Join-Path $temporaryRoot "clodex-installer-smoke-profile-$([guid]::NewGuid().ToString('N'))"
$logPath = Join-Path $browserDir "out\$Channel\validation\windows-$Arch-$Version-installer-smoke.log"
$stderrLogPath = "$logPath.stderr"

if (-not (Test-Path -LiteralPath $setupPath)) {
  throw "Squirrel setup executable not found: $setupPath"
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) | Out-Null
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $profilePath
Remove-Item -Force -ErrorAction SilentlyContinue $logPath, $stderrLogPath

try {
  Write-Host "[windows-installer-smoke] Installing $setupPath"
  $installer = Start-Process -FilePath $setupPath -ArgumentList "--silent" -PassThru -Wait
  if ($installer.ExitCode -ne 0) {
    throw "Squirrel installer exited with $($installer.ExitCode)"
  }
  Get-Process -Name $baseName -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue

  $appExecutable = Get-ChildItem -LiteralPath $installRoot -Recurse -Filter "$baseName.exe" |
    Where-Object { $_.FullName -match "\\app-[^\\]+\\" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1 -ExpandProperty FullName
  if (-not $appExecutable) {
    throw "Installed application executable not found under $installRoot"
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $appExecutable
  if ($signature.Status -ne "Valid") {
    throw "Installed executable Authenticode status is $($signature.Status)"
  }

  Write-Host "[windows-installer-smoke] Running installed application"
  $arguments = @(
    "--disable-gpu",
    "--user-data-dir=$profilePath",
    "--smoke-test"
  )
  $process = Start-Process -FilePath $appExecutable -ArgumentList $arguments -PassThru -NoNewWindow `
    -RedirectStandardOutput $logPath -RedirectStandardError $stderrLogPath
  if (-not $process.WaitForExit(120000)) {
    try {
      $process.Kill($true)
    }
    catch {
      $process.Kill()
    }
    $process.WaitForExit()
    throw "Installed application smoke timed out"
  }
  if (Test-Path -LiteralPath $stderrLogPath) {
    Get-Content -LiteralPath $stderrLogPath | Add-Content -LiteralPath $logPath
    Remove-Item -Force -LiteralPath $stderrLogPath
  }
  Get-Content -LiteralPath $logPath
  if ($process.ExitCode -ne 0) {
    throw "Installed application smoke exited with $($process.ExitCode)"
  }
  if (-not (Select-String -LiteralPath $logPath -SimpleMatch `
      "[smoke-test] App ready — all modules loaded successfully." -Quiet)) {
    throw "Installed application did not emit the smoke success marker"
  }

  Write-Host "[windows-installer-smoke] Uninstalling $baseName"
  $updateExecutable = Join-Path $installRoot "Update.exe"
  if (-not (Test-Path -LiteralPath $updateExecutable)) {
    throw "Squirrel Update.exe not found: $updateExecutable"
  }
  $uninstaller = Start-Process -FilePath $updateExecutable -ArgumentList "--uninstall", "-s" -PassThru -Wait
  if ($uninstaller.ExitCode -ne 0) {
    throw "Squirrel uninstaller exited with $($uninstaller.ExitCode)"
  }

  $uninstallDeadline = [DateTime]::UtcNow.AddSeconds(30)
  while (
    (Test-Path -LiteralPath $appExecutable) -and
    [DateTime]::UtcNow -lt $uninstallDeadline
  ) {
    Start-Sleep -Milliseconds 500
  }
  if (Test-Path -LiteralPath $appExecutable) {
    throw "Installed executable remains after uninstall: $appExecutable"
  }

  Write-Host "[windows-installer-smoke] Passed"
}
finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $profilePath
  Remove-Item -Force -ErrorAction SilentlyContinue $stderrLogPath
  $updateExecutable = Join-Path $installRoot "Update.exe"
  if (Test-Path -LiteralPath $updateExecutable) {
    Start-Process -FilePath $updateExecutable -ArgumentList "--uninstall", "-s" -Wait `
      -WindowStyle Hidden -ErrorAction SilentlyContinue
  }
}
