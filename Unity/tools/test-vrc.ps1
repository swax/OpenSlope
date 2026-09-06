#!/usr/bin/env pwsh
# End-to-end VRChat/ClientSim autotest. Unlike the neutral importer smoke test, this runs in a real VRChat project
# with a visible Unity editor: ClientSim, VRCStation, the compiled Udon programs, and board physics are required.

[CmdletBinding()]
param(
    [string]$Target = $env:OPENSLOPE_UNITY_PROJECT,
    [ValidatePattern('^[A-Za-z0-9_-]+$')]
    [string]$Fixture = "GOLD",
    [string]$UnityExe = $env:UNITY_EXE,
    [switch]$SkipExport,
    [switch]$SkipSync,
    [ValidateRange(60, 3600)]
    [int]$TimeoutSeconds = 1200
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

function Invoke-Checked([string]$Label, [string]$File, [string[]]$Arguments) {
    Write-Host "`n== $Label =="
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
}

function Resolve-UnityProject([string]$Value) {
    if (-not $Value) { throw "No VRChat Unity project: pass -Target <path-or-name>, or set OPENSLOPE_UNITY_PROJECT." }
    if (Test-Path -LiteralPath $Value -PathType Container) { return (Resolve-Path -LiteralPath $Value).Path }
    if (-not $env:OPENSLOPE_UNITY_PROJECTS) {
        throw "A short -Target name needs OPENSLOPE_UNITY_PROJECTS set to the Unity-projects parent folder."
    }
    $candidate = Join-Path $env:OPENSLOPE_UNITY_PROJECTS $Value
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { throw "Unity project not found: $candidate" }
    return (Resolve-Path -LiteralPath $candidate).Path
}

function Remove-OwnedDirectory([string]$Path, [string]$AllowedRoot, [string]$RequiredName) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
    $resolvedRoot = (Resolve-Path -LiteralPath $AllowedRoot).Path.TrimEnd('\')
    if ((Split-Path $resolvedPath -Leaf) -ne $RequiredName -or
        -not $resolvedPath.StartsWith($resolvedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a directory outside the reserved autotest destination: $resolvedPath"
    }
    Remove-Item -LiteralPath $resolvedPath -Recurse -Force
}

function Resolve-UnityEditor([string]$Value) {
    if ($Value) { return (Resolve-Path -LiteralPath $Value).Path }
    $preferred = "C:\Program Files\Unity\Hub\Editor\2022.3.22f1\Editor\Unity.exe"
    if (Test-Path -LiteralPath $preferred -PathType Leaf) { return $preferred }
    $installed = Get-ChildItem -LiteralPath "C:\Program Files\Unity\Hub\Editor" -Directory -ErrorAction Stop |
        Sort-Object { try { [Version]($_.Name -replace '[^0-9.].*$', '') } catch { [Version]'0.0' } } -Descending |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "Editor\Unity.exe") } |
        Select-Object -First 1
    if (-not $installed) { throw "No Unity Hub editor installation found; pass -UnityExe explicitly." }
    return (Join-Path $installed.FullName "Editor\Unity.exe")
}

$projectRoot = Resolve-UnityProject $Target
$assetsRoot = Join-Path $projectRoot "Assets"
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "ProjectSettings\ProjectVersion.txt") -PathType Leaf) -or
    -not (Test-Path -LiteralPath $assetsRoot -PathType Container)) {
    throw "Target is not a Unity project root: $projectRoot"
}
if (Test-Path -LiteralPath (Join-Path $projectRoot "Temp\UnityLockfile")) {
    throw "The target project appears to be open already. Close it for the command-line run, or use OpenSlope/Dev/Run VRChat ClientSim Map... inside that editor."
}
$UnityExe = Resolve-UnityEditor $UnityExe

$workRoot = Join-Path $repoRoot "temp\vrc-autotest"
$sourceRoot = Join-Path $workRoot "source"
$sourceMap = Join-Path $sourceRoot $Fixture
$resultRoot = Join-Path $workRoot "results"
$resultPath = Join-Path $resultRoot ($Fixture + ".json")
$logPath = Join-Path $resultRoot ($Fixture + ".log")
New-Item -ItemType Directory -Path $sourceRoot,$resultRoot -Force | Out-Null

if (-not $SkipExport) {
    if (Test-Path -LiteralPath $sourceMap) {
        $resolvedSource = (Resolve-Path -LiteralPath $sourceMap).Path
        $resolvedSourceRoot = (Resolve-Path -LiteralPath $sourceRoot).Path.TrimEnd('\')
        if (-not $resolvedSource.StartsWith($resolvedSourceRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing fixture cleanup outside $resolvedSourceRoot`: $resolvedSource"
        }
        Remove-Item -LiteralPath $resolvedSource -Recurse -Force
    }
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    Invoke-Checked "Export Slopesmith $Fixture fixture" $npm @(
        "--prefix", (Join-Path $repoRoot "Slopesmith"), "run", "autotest:map", "--",
        $sourceMap, "--fixture", $Fixture, "--no-project"
    )

    $snowknifeProject = Join-Path $repoRoot "Snowknife\Snowknife\Snowknife.csproj"
    $dotnet = (Get-Command dotnet -ErrorAction Stop).Source
    Invoke-Checked "Build Snowknife" $dotnet @("build", $snowknifeProject, "-c", "Debug", "--no-restore", "--nologo")
    $snowknife = Join-Path $repoRoot "Snowknife\Snowknife\bin\Debug\net10.0\snowknife.exe"
    if (-not (Test-Path -LiteralPath $snowknife -PathType Leaf)) { throw "Snowknife executable not found: $snowknife" }
    Invoke-Checked "Bake VRChat autotest bundle" $snowknife @("gltf", $sourceMap, $Fixture.ToLowerInvariant(), "--no-overrides")
} else {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceMap "autotest-plan.json") -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $sourceMap "gltf\manifest.json") -PathType Leaf)) {
        throw "-SkipExport requested, but no planned+baked fixture exists at $sourceMap."
    }
    $snowknife = Join-Path $repoRoot "Snowknife\Snowknife\bin\Debug\net10.0\snowknife.exe"
    if (-not (Test-Path -LiteralPath $snowknife -PathType Leaf)) { throw "Snowknife executable not found: $snowknife" }
}

# This exact reserved map folder is the only target the harness removes/re-stages.
$stageName = "OPENSLOPE_VRC_AUTOTEST_" + $Fixture.ToUpperInvariant()
# Levels stage beside the synced library, under the one Assets/OpenSlope root (MapLayout.AssetsRoot).
$mapsRoot = Join-Path (Join-Path $assetsRoot "OpenSlope") "Maps"
$stageMap = Join-Path $mapsRoot $stageName
New-Item -ItemType Directory -Path $mapsRoot -Force | Out-Null
Remove-OwnedDirectory -Path $stageMap -AllowedRoot $mapsRoot -RequiredName $stageName
$stageMeta = $stageMap + ".meta"
if (Test-Path -LiteralPath $stageMeta -PathType Leaf) { Remove-Item -LiteralPath $stageMeta -Force }
Invoke-Checked "Stage fixture into the VRChat project" $snowknife @("unity", $sourceMap, $stageMap, "--no-shared")

if (-not $SkipSync) {
    & (Join-Path $PSScriptRoot "sync-unity.ps1") -Target $projectRoot -Dirs @("Importer", "VRC")
    if ($LASTEXITCODE -ne 0) { throw "Sync OpenSlope Unity sources failed with exit code $LASTEXITCODE." }
}

Remove-Item -LiteralPath $resultPath,$logPath -Force -ErrorAction SilentlyContinue
$assetLevel = "Assets/OpenSlope/Maps/$stageName"
Write-Host "`n== Unity VRChat ClientSim autotest =="
Write-Host "Unity:   $UnityExe"
Write-Host "Project: $projectRoot"
Write-Host "Fixture: $assetLevel"
Write-Host "Safety:  only no map or an importer-tagged autotest map may be loaded"

$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $UnityExe
$startInfo.UseShellExecute = $false
$unityArgs = @(
    "-projectPath", $projectRoot,
    "-executeMethod", "VrcAutoTest.Run",
    "-openslopeVrcTestLevel", $assetLevel,
    "-openslopeVrcTestResult", $resultPath,
    "-openslopeVrcTestExit",
    "-logFile", $logPath
)
foreach ($argument in $unityArgs) { [void]$startInfo.ArgumentList.Add($argument) }
$process = [Diagnostics.Process]::Start($startInfo)
if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $process.Kill($true)
    throw "Unity ClientSim autotest exceeded $TimeoutSeconds seconds and the harness-owned Unity process was stopped. See $logPath"
}
$unityExit = $process.ExitCode

if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
    if (Test-Path -LiteralPath $logPath) {
        Write-Host "`nUnity log tail:"
        Get-Content -LiteralPath $logPath -Tail 100
    }
    throw "Unity produced no VRChat autotest result (exit $unityExit). See $logPath"
}

$result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
Write-Host "`nOpenSlope VRChat ClientSim"
Write-Host ("  Entries: {0} pass, {1} fail, {2} unsupported, {3} open ({4} total)" -f
    $result.passedEntries, $result.failed, $result.unsupported, $result.open, $result.total)
Write-Host "  Result:  $resultPath"
Write-Host "  Log:     $logPath"

if ($unityExit -ne 0 -or -not $result.passed) {
    foreach ($failure in $result.errors) { Write-Error $failure -ErrorAction Continue }
    $failedRows = @($result.entries | Where-Object { $_.status -eq "fail" })
    foreach ($row in $failedRows) { Write-Error ("{0}: expected {1}; observer={2}" -f $row.id, $row.expected, $row.observer) -ErrorAction Continue }
    throw "OpenSlope VRChat ClientSim autotest failed (Unity exit $unityExit)."
}
