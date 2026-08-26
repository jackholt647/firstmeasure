$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $projectRoot "local-stack.config.json"
if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Missing local-stack.config.json. Copy local-stack.config.example.json and set local tool paths."
}

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$listenHost = [string]$config.listenHost
$listenPort = [int]$config.listenPort
$apiPort = [int]$config.apiPort
$phpPorts = @($config.phpPorts | ForEach-Object { [int]$_ })
$phpRoot = [string]$config.phpRoot
$nginxRoot = [string]$config.nginxRoot

if (-not $listenHost) { $listenHost = "127.0.0.1" }
if (-not $listenPort) { $listenPort = 8021 }
if (-not $apiPort) { $apiPort = 3111 }
if ($phpPorts.Count -eq 0) { $phpPorts = @(9084, 9085, 9086, 9087) }

$phpCgi = Join-Path $phpRoot "php-cgi.exe"
$nginxExe = Join-Path $nginxRoot "nginx.exe"
$publicRoot = Join-Path $projectRoot "public"
$apiDir = Join-Path $publicRoot "v1"
$nginxTemplate = Join-Path $projectRoot "nginx\nginx.conf.template"
$phpTemplate = Join-Path $projectRoot "nginx\php.ini.template"

$runtimeRoot = Join-Path $projectRoot ".local-runtime"
$logsDir = Join-Path $runtimeRoot "logs"
$sessionsDir = Join-Path $runtimeRoot "sessions"
$nginxRuntime = Join-Path $runtimeRoot "nginx"
$nginxLogsDir = Join-Path $nginxRuntime "logs"
$nginxTempDir = Join-Path $nginxRuntime "temp"
$nginxConfDir = Join-Path $nginxRuntime "conf"
$nginxConf = Join-Path $nginxConfDir "nginx.conf"
$nginxPidPath = Join-Path $nginxLogsDir "nginx.pid"
$phpIni = Join-Path $runtimeRoot "php.ini"
$pidFile = Join-Path $runtimeRoot "stack-pids.json"

foreach ($requiredPath in @($phpCgi, $nginxExe, $publicRoot, $apiDir, $nginxTemplate, $phpTemplate)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required path not found: $requiredPath"
    }
}

$allPorts = @($listenPort, $apiPort) + $phpPorts
foreach ($port in $allPorts) {
    $binding = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($binding) {
        $owner = Get-Process -Id $binding.OwningProcess -ErrorAction SilentlyContinue
        $ownerLabel = if ($owner) { "$($owner.ProcessName) (PID $($owner.Id))" } else { "PID $($binding.OwningProcess)" }
        throw "FirstMeasure port $port is already in use by $ownerLabel. No processes were stopped."
    }
}

if (Test-Path -LiteralPath $pidFile) {
    throw "FirstMeasure stack metadata already exists at $pidFile. Run .\stop-local.ps1 first."
}

New-Item -ItemType Directory -Force -Path `
    $runtimeRoot, $logsDir, $sessionsDir, $nginxRuntime, $nginxLogsDir, $nginxTempDir, $nginxConfDir | Out-Null

function Convert-ToNginxPath([string]$path) {
    return ($path -replace '\\', '/')
}

function Write-RenderedTemplate([string]$source, [string]$destination, [hashtable]$replacements) {
    $content = Get-Content -LiteralPath $source -Raw
    foreach ($key in $replacements.Keys) {
        $content = $content.Replace($key, [string]$replacements[$key])
    }
    Set-Content -LiteralPath $destination -Value $content -Encoding ASCII
}

$phpUpstreams = ($phpPorts | ForEach-Object { "        server 127.0.0.1:$_;" }) -join "`r`n"
Write-RenderedTemplate $phpTemplate $phpIni @{
    "__PHP_ERROR_LOG__" = Convert-ToNginxPath (Join-Path $logsDir "php-error.log")
    "__PHP_EXT_DIR__" = Convert-ToNginxPath (Join-Path $phpRoot "ext")
    "__PHP_SESSION_PATH__" = Convert-ToNginxPath $sessionsDir
}

Write-RenderedTemplate $nginxTemplate $nginxConf @{
    "__NGINX_MIME_TYPES__" = Convert-ToNginxPath (Join-Path $nginxRoot "conf\mime.types")
    "__NGINX_FASTCGI_PARAMS__" = Convert-ToNginxPath (Join-Path $nginxRoot "conf\fastcgi_params")
    "__PUBLIC_ROOT__" = Convert-ToNginxPath $publicRoot
    "__ACCESS_LOG__" = Convert-ToNginxPath (Join-Path $logsDir "access.log")
    "__ERROR_LOG__" = Convert-ToNginxPath (Join-Path $logsDir "nginx-error.log")
    "__NGINX_PID__" = Convert-ToNginxPath $nginxPidPath
    "__PHP_UPSTREAMS__" = $phpUpstreams
    "__LISTEN_HOST__" = $listenHost
    "__LISTEN_PORT__" = $listenPort
    "__EXTRA_LISTEN_DIRECTIVES__" = ""
    "__API_PORT__" = $apiPort
}

$startedProcesses = @()
try {
    $phpProcesses = @()
    foreach ($port in $phpPorts) {
        $phpStart = New-Object System.Diagnostics.ProcessStartInfo
        $phpStart.FileName = $phpCgi
        $phpStart.Arguments = "-b 127.0.0.1:$port -c `"$runtimeRoot`""
        $phpStart.WorkingDirectory = $projectRoot
        $phpStart.UseShellExecute = $false
        $phpStart.CreateNoWindow = $true
        $phpStart.Environment["PHPRC"] = $runtimeRoot
        $phpStart.Environment["PHP_INI_SCAN_DIR"] = ""
        $phpProcess = [System.Diagnostics.Process]::Start($phpStart)
        if (-not $phpProcess) { throw "Failed to start php-cgi on port $port." }
        $startedProcesses += $phpProcess
        $phpProcesses += [PSCustomObject]@{ id = $phpProcess.Id; port = $port }
    }

    Push-Location $apiDir
    try {
        $typescriptCommand = Join-Path $apiDir "node_modules\.bin\tsc.cmd"
        if (-not (Test-Path -LiteralPath $typescriptCommand)) {
            Write-Host "Installing FirstMeasure Node dependencies..."
            & npm.cmd ci
            if ($LASTEXITCODE -ne 0) { throw "The FirstMeasure dependency install failed." }
        }
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw "The FirstMeasure Node build failed." }
    } finally {
        Pop-Location
    }

    $nodeCommand = Get-Command node.exe -ErrorAction Stop
    $apiOutputLog = Join-Path $logsDir "api-output.log"
    $apiErrorLog = Join-Path $logsDir "api-error.log"
    $apiLauncher = Join-Path $runtimeRoot "start-api.cmd"
    @(
        "@echo off"
        "`"$($nodeCommand.Source)`" --experimental-sqlite dist/src/server.js 1>>`"$apiOutputLog`" 2>>`"$apiErrorLog`""
    ) | Set-Content -LiteralPath $apiLauncher -Encoding ASCII

    $apiStart = New-Object System.Diagnostics.ProcessStartInfo
    $apiStart.FileName = "cmd.exe"
    $apiStart.Arguments = "/d /s /c `"`"$apiLauncher`"`""
    $apiStart.WorkingDirectory = $apiDir
    $apiStart.UseShellExecute = $false
    $apiStart.CreateNoWindow = $true
    $apiStart.Environment["V1_HOST"] = "127.0.0.1"
    $apiStart.Environment["V1_PORT"] = [string]$apiPort
    $apiStart.Environment["V1_WEB_WORKERS"] = "1"
    $apiStart.Environment["CORS_ALLOWED_ORIGINS"] = "http://${listenHost}:$listenPort,http://localhost:$listenPort"
    $apiProcess = [System.Diagnostics.Process]::Start($apiStart)
    if (-not $apiProcess) { throw "Failed to start the FirstMeasure Node API." }
    $startedProcesses += $apiProcess

    $apiReady = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 250
        if (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $apiPort -State Listen -ErrorAction SilentlyContinue) {
            $apiReady = $true
            break
        }
        if ($apiProcess.HasExited) { break }
    }
    if (-not $apiReady) { throw "FirstMeasure API did not bind to 127.0.0.1:$apiPort." }
    $apiBinding = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $apiPort -State Listen -ErrorAction Stop |
        Select-Object -First 1
    $apiServerPid = [int]$apiBinding.OwningProcess

    if (Test-Path -LiteralPath $nginxPidPath) {
        Remove-Item -LiteralPath $nginxPidPath -Force
    }
    Start-Process -FilePath $nginxExe -WorkingDirectory $nginxRuntime `
        -ArgumentList @("-p", ".", "-c", "conf/nginx.conf") -WindowStyle Hidden

    $nginxReady = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        if ((Test-Path -LiteralPath $nginxPidPath) -and
            (Get-NetTCPConnection -LocalAddress $listenHost -LocalPort $listenPort -State Listen -ErrorAction SilentlyContinue)) {
            $nginxReady = $true
            break
        }
    }
    if (-not $nginxReady) { throw "NGINX did not bind to ${listenHost}:$listenPort." }

    $nginxPid = [int]((Get-Content -LiteralPath $nginxPidPath -Raw).Trim())
    [PSCustomObject]@{
        nginx = [PSCustomObject]@{
            id = $nginxPid
            exe = $nginxExe
            prefix = $nginxRuntime
        }
        php = $phpProcesses
        api = [PSCustomObject]@{
            id = $apiServerPid
            launcherId = $apiProcess.Id
            port = $apiPort
        }
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $pidFile -Encoding ASCII

    Write-Host ""
    Write-Host "FirstMeasure local stack is running."
    Write-Host "Web: http://${listenHost}:$listenPort"
    Write-Host "Portal: http://${listenHost}:$listenPort/portal/"
    Write-Host "API: http://127.0.0.1:$apiPort/v1"
    Write-Host "Stop with .\stop-local.ps1"
    Write-Host ""
} catch {
    foreach ($process in $startedProcesses) {
        if ($process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
    throw
}
