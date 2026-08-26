$ErrorActionPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeRoot = Join-Path $projectRoot ".local-runtime"
$pidFile = Join-Path $runtimeRoot "stack-pids.json"

if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host "No FirstMeasure local stack metadata found."
    exit 0
}

$meta = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json

if ($meta.nginx -and (Test-Path -LiteralPath $meta.nginx.exe)) {
    Start-Process -FilePath $meta.nginx.exe `
        -WorkingDirectory $meta.nginx.prefix `
        -ArgumentList @("-p", ".", "-c", "conf/nginx.conf", "-s", "stop") `
        -Wait -WindowStyle Hidden | Out-Null
    Start-Sleep -Milliseconds 500
}

$processIds = @()
if ($meta.nginx.id) { $processIds += [int]$meta.nginx.id }
if ($meta.php) { $processIds += @($meta.php | ForEach-Object { [int]$_.id }) }
if ($meta.api.id) { $processIds += [int]$meta.api.id }
if ($meta.api.launcherId) { $processIds += [int]$meta.api.launcherId }

foreach ($processId in ($processIds | Select-Object -Unique)) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "FirstMeasure local stack stopped."
