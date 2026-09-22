param([string]$Serial = 'emulator-5554')
$ErrorActionPreference = 'Stop'
$androidRoot = Join-Path $PSScriptRoot '../android'
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
if (-not $env:JAVA_HOME) { throw 'Set JAVA_HOME to your JDK 17 installation.' }
$env:ANDROID_SERIAL = $Serial
$adb = Join-Path $env:ANDROID_HOME 'platform-tools/adb.exe'
& $adb -s $Serial get-state
if ($LASTEXITCODE -ne 0) { throw "Start an emulator first, or pass -Serial for an explicitly selected test device." }
Push-Location $androidRoot
try {
  & ./gradlew.bat assembleDevelopmentDebug testDevelopmentDebugUnitTest connectedDevelopmentDebugAndroidTest bundleProductionRelease --console=plain
  if ($LASTEXITCODE -ne 0) { throw 'Android checks failed.' }
} finally { Pop-Location }
