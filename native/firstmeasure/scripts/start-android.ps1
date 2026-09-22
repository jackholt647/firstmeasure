param([string]$Avd = 'FirstMeasure_API35', [int]$Port = 5554)
$ErrorActionPreference = 'Stop'
if ($Port -lt 5554 -or $Port -gt 5682 -or $Port % 2) { throw 'Choose an even emulator port between 5554 and 5682.' }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
$adb = Join-Path $env:ANDROID_HOME 'platform-tools/adb.exe'
$emulator = Join-Path $env:ANDROID_HOME 'emulator/emulator.exe'
$apk = Join-Path $PSScriptRoot '../android/app/build/outputs/apk/development/debug/app-development-debug.apk'
if (-not (Test-Path -LiteralPath $apk)) { throw 'Build the development APK first with gradlew.bat assembleDevelopmentDebug.' }
$serial = "emulator-$Port"
$state = & $adb -s $serial get-state 2>$null
if ($state -ne 'device') {
    $names = & $emulator -list-avds
    if ($Avd -notin $names) { throw "Create the $Avd virtual device in Android Studio Device Manager first." }
    # This command is explicitly launched by the developer for interactive testing.
    Start-Process -FilePath $emulator -ArgumentList '-avd', $Avd, '-port', $Port -WindowStyle Normal
}
$deadline = (Get-Date).AddMinutes(3)
do {
    $booted = & $adb -s $serial shell getprop sys.boot_completed 2>$null
    if ($booted -eq '1') { break }
    Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)
if ($booted -ne '1') { throw 'The emulator did not finish booting. Check its window and retry.' }
& $adb -s $serial install -r $apk
if ($LASTEXITCODE -ne 0) { throw 'APK installation failed. Check whether a build signed by a different developer is installed.' }
& $adb -s $serial shell am start -n ai.firstmeasure.mobile.dev/ai.firstmeasure.mobile.MainActivity
