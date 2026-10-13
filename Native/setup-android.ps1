$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskTools = Join-Path $taskRoot '.openslope/native-android'
$taskDownloads = Join-Path $taskTools 'downloads'
New-Item -ItemType Directory -Force -Path $taskDownloads | Out-Null
$taskManifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'android/toolchain-windows.json') -Raw | ConvertFrom-Json

foreach ($taskPackage in $taskManifest.packages) {
    $taskDestination = [IO.Path]::GetFullPath((Join-Path $taskTools $taskPackage.directory))
    $taskPrefix = $taskDestination + [IO.Path]::DirectorySeparatorChar
    if (-not $taskDestination.StartsWith($taskTools + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Toolchain destination escapes the workspace cache.' }
    $taskMarker = Join-Path $taskDestination '.openslope-installed.json'
    if (Test-Path -LiteralPath $taskMarker) { continue }
    $taskArchive = Join-Path $taskDownloads ([IO.Path]::GetFileName(([Uri]$taskPackage.url).AbsolutePath))
    if (-not (Test-Path -LiteralPath $taskArchive)) {
        Write-Output "Downloading $($taskPackage.name)..."
        Invoke-WebRequest -Uri $taskPackage.url -OutFile $taskArchive
    }
    if ((Get-FileHash -Algorithm $taskPackage.algorithm -LiteralPath $taskArchive).Hash -ne $taskPackage.checksum) { throw "Checksum mismatch: $taskArchive" }
    Write-Output "Installing $($taskPackage.name) in the workspace cache..."
    New-Item -ItemType Directory -Force -Path $taskDestination | Out-Null
    $taskZip = [IO.Compression.ZipFile]::OpenRead($taskArchive)
    try {
        # Some SDK archives have one wrapper folder; CMake has files at its root.
        # Strip a wrapper only when every entry shares that directory.
        $taskRootNames = @($taskZip.Entries | ForEach-Object { $_.FullName.Replace('\','/').Split('/')[0] } | Select-Object -Unique)
        $taskStripRoot = $taskRootNames.Count -eq 1 -and @($taskZip.Entries | Where-Object { -not $_.FullName.Contains('/') }).Count -eq 0
        foreach ($taskEntry in $taskZip.Entries) {
            if ($taskEntry.FullName.EndsWith('/')) { continue }
            $taskRelative = $taskEntry.FullName.Replace('\','/')
            if ($taskStripRoot) { $taskRelative = $taskRelative.Split([char[]]@('/'), 2, [StringSplitOptions]::None)[1] }
            if (-not $taskRelative) { continue }
            $taskOutput = [IO.Path]::GetFullPath((Join-Path $taskDestination $taskRelative))
            if (-not $taskOutput.StartsWith($taskPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Toolchain archive path escapes its destination.' }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $taskOutput) | Out-Null
            $taskInput = $taskEntry.Open()
            $taskFile = [IO.File]::Create($taskOutput)
            try { $taskInput.CopyTo($taskFile) } finally { $taskFile.Dispose(); $taskInput.Dispose() }
        }
    } finally { $taskZip.Dispose() }
    $taskPackage | ConvertTo-Json | Set-Content -LiteralPath $taskMarker -Encoding UTF8
}
Write-Output 'Android build tools are ready in .openslope/native-android.'
