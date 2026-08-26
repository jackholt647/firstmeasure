param(
    [string]$Date = (Get-Date -Format 'yyyy-MM-dd'),
    [switch]$Overwrite,
    [string[]]$PackageNames = @('v1', 'measure', 'portal', 'libraries', 'includes', 'images', 'fonts')
)

$ErrorActionPreference = 'Stop'

$baseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$publicDir = Join-Path $baseDir 'public'
$updatesDir = Join-Path $baseDir 'updates'

function Test-SnapshotExcludedPath {
    param([string]$RelativePath)

    $normalized = $RelativePath.Replace('\', '/')
    if ($normalized -match '(^|/)storage/') { return $true }
    if ($normalized -match '(^|/)logs/') { return $true }
    if ($normalized -match '(^|/)node_modules/') { return $true }
    if ($normalized -match '(^|/)dist/') { return $true }
    if ($normalized -match '(^|/)error_log$') { return $true }
    if ($normalized -match '\.log$') { return $true }

    return $false
}

if (-not (Test-Path -LiteralPath $publicDir -PathType Container)) {
    throw "Public directory not found: $publicDir"
}

if (-not $PackageNames.Count) {
    throw 'At least one package name is required.'
}

$missingPackages = @($PackageNames | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $publicDir $_) -PathType Container)
})
if ($missingPackages.Count) {
    throw "Source directories not found under public: $($missingPackages -join ', ')"
}

New-Item -ItemType Directory -Path $updatesDir -Force | Out-Null

$targetDir = Join-Path $updatesDir $Date
if ((Test-Path -LiteralPath $targetDir) -and -not $Overwrite) {
    $stamp = Get-Date -Format 'HHmmss'
    $targetDir = Join-Path $updatesDir "$Date-$stamp"
}
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

foreach ($name in $PackageNames) {
    $sourceDir = Join-Path $publicDir $name
    $zipPath = Join-Path $targetDir "$($name)_snapshot.zip"
    if (Test-Path -LiteralPath $zipPath) {
        if ($Overwrite) {
            Remove-Item -LiteralPath $zipPath -Force
        } else {
            throw "Zip already exists: $zipPath. Re-run with -Overwrite or use a different -Date."
        }
    }

    $zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $sourceRoot = (Resolve-Path -LiteralPath $sourceDir).Path.TrimEnd(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar
        )

        Get-ChildItem -LiteralPath $sourceRoot -Force -Recurse -File |
            Where-Object {
                $relativePath = $_.FullName.Substring($sourceRoot.Length + 1).Replace(
                    [System.IO.Path]::DirectorySeparatorChar,
                    '/'
                )
                -not (Test-SnapshotExcludedPath $relativePath)
            } |
            ForEach-Object {
                $relativePath = $_.FullName.Substring($sourceRoot.Length + 1).Replace(
                    [System.IO.Path]::DirectorySeparatorChar,
                    '/'
                )
                [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $zip,
                    $_.FullName,
                    $relativePath,
                    [System.IO.Compression.CompressionLevel]::Optimal
                ) | Out-Null
            }
    } finally {
        $zip.Dispose()
    }

    Write-Host "Created $zipPath"
}

Write-Host "Update snapshot complete: $targetDir"
