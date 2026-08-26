$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptRoot "..\..")
$androidSdk = if ($env:ANDROID_SDK_ROOT -and (Test-Path $env:ANDROID_SDK_ROOT)) {
    [System.IO.Path]::GetFullPath($env:ANDROID_SDK_ROOT)
} elseif ($env:ANDROID_HOME -and (Test-Path $env:ANDROID_HOME)) {
    [System.IO.Path]::GetFullPath($env:ANDROID_HOME)
} else {
    "C:\Users\jackh\Code\2026\codex\android\sdk"
}

$adb = Join-Path $androidSdk "platform-tools\adb.exe"
$emulator = Join-Path $androidSdk "emulator\emulator.exe"
$avdManager = Join-Path $androidSdk "cmdline-tools\latest\bin\avdmanager.bat"
$avdName = "FirstMateCustomerApi36"
$systemImage = "system-images;android-36;google_apis;x86_64"
$apkPath = Join-Path $scriptRoot "android\app\build\outputs\apk\debug\app-debug.apk"

function Step($message) {
    Write-Host ""
    Write-Host "==> $message" -ForegroundColor Cyan
}

function Require-File($path, $label) {
    if (-not (Test-Path $path)) {
        throw "$label was not found at: $path"
    }
}

function Test-Port($port) {
    return [bool](Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Wait-Port($port, $seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Port $port) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Ensure-LocalStack {
    if ((Test-Port 8021) -and (Test-Port 3111)) {
        Write-Host "Local web/API stack is already listening on 8021 and 3111."
        return
    }

    Step "Starting local FirstMate stack"
    $startScript = Join-Path $repoRoot "start-nginx-local.ps1"
    Require-File $startScript "Local stack launcher"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScript

    if (-not (Wait-Port 8021 45)) {
        throw "Local web server did not start on 127.0.0.1:8021."
    }
    if (-not (Wait-Port 3111 90)) {
        throw "Platform API did not start on 127.0.0.1:3111."
    }
}

function Ensure-Avd {
    $avds = & $emulator -list-avds
    if ($avds -contains $avdName) {
        Write-Host "AVD $avdName already exists."
        return
    }

    Step "Creating Android emulator profile"
    Require-File $avdManager "Android AVD manager"
    "no" | & $avdManager create avd -n $avdName -k $systemImage --device "medium_phone" --force
}

function Ensure-EmulatorBooted {
    Step "Starting Android emulator"
    & $adb start-server | Out-Null
    $devices = & $adb devices
    $hasDevice = $devices | Where-Object { $_ -match "\bdevice$" }

    if (-not $hasDevice) {
        Start-Process -FilePath $emulator -ArgumentList @("-avd", $avdName, "-no-snapshot-load") | Out-Null
        & $adb wait-for-device
    } else {
        Write-Host "An Android device/emulator is already connected."
    }

    $deadline = (Get-Date).AddMinutes(5)
    do {
        Start-Sleep -Seconds 3
        $boot = (& $adb shell getprop sys.boot_completed 2>$null).Trim()
        if ($boot -eq "1") { return }
        Write-Host "Waiting for Android to finish booting..."
    } while ((Get-Date) -lt $deadline)

    throw "Android emulator did not finish booting within 5 minutes."
}

function Build-App {
    Step "Syncing and building Android debug APK"
    Push-Location $scriptRoot
    try {
        $env:ANDROID_SDK_ROOT = $androidSdk
        $env:ANDROID_HOME = $androidSdk
        Set-Content -Path "android\local.properties" -Value ("sdk.dir=" + ($androidSdk -replace "\\", "/")) -Encoding ASCII
        & npx.cmd cap sync android
        & .\android\gradlew.bat -p android assembleDebug --no-daemon
    } finally {
        Pop-Location
    }
    Require-File $apkPath "Debug APK"
}

function Install-And-Launch {
    Step "Forwarding localhost ports into emulator"
    & $adb reverse tcp:8021 tcp:8021 | Out-Host
    & $adb reverse tcp:3111 tcp:3111 | Out-Host

    Step "Installing and launching FirstMate Customer"
    & $adb install -r $apkPath | Out-Host
    & $adb shell am start -n ai.firstmate.customer/.MainActivity | Out-Host
}

Require-File $adb "ADB"
Require-File $emulator "Android emulator"

$env:ANDROID_SDK_ROOT = $androidSdk
$env:ANDROID_HOME = $androidSdk

Write-Host "FirstMate Customer Mobile Android launcher" -ForegroundColor Green
Write-Host "Repo: $repoRoot"
Write-Host "SDK:  $androidSdk"

Ensure-LocalStack
Ensure-Avd
Ensure-EmulatorBooted
Build-App
Install-And-Launch

Write-Host ""
Write-Host "Ready. The emulator should show the FirstMate Customer login screen." -ForegroundColor Green
Write-Host "Local URL: http://127.0.0.1:8021/apps/customer-mobile/"

