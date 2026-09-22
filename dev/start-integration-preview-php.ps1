param([string]$Php = 'php')
$previewRoot = Split-Path $PSScriptRoot -Parent
$previewSessions = Join-Path $previewRoot 'public/v1/.tmp/integration-preview/sessions'
New-Item -ItemType Directory -Force -Path $previewSessions | Out-Null
Push-Location $previewRoot
try {
    & $Php -d session.name=FIRSTMEASURE_PREVIEW -d "session.save_path=$previewSessions" -d upload_max_filesize=8M -d post_max_size=12M -S 127.0.0.1:8011 -t public dev/integration-preview-router.php
} finally { Pop-Location }
