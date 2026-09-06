#!/usr/bin/env pwsh
# End-to-end neutral-importer smoke test + source-filtered coverage.
#
# Unity/ is a source library, not a Unity project itself, so this creates/reuses a minimal disposable project
# under the repository's ignored temp/ directory. No existing Unity project is modified.

[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9_-]+$')]
    [string]$Fixture = "AUTOTEST1",
    [string]$UnityExe = $env:UNITY_EXE,
    [switch]$SkipExport,
    [switch]$SkipSync
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

function Invoke-Checked([string]$Label, [string]$File, [string[]]$Arguments) {
    Write-Host "`n== $Label =="
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
}

function Remove-HarnessDirectory([string]$Path, [string]$AllowedRoot) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
    $resolvedRoot = (Resolve-Path -LiteralPath $AllowedRoot).Path.TrimEnd('\')
    if (-not $resolvedPath.StartsWith($resolvedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove test output outside $resolvedRoot`: $resolvedPath"
    }
    Remove-Item -LiteralPath $resolvedPath -Recurse -Force
}

function Invoke-Unity([string]$Label, [string[]]$Arguments) {
    Write-Host "`n== $Label =="
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $UnityExe
    $startInfo.UseShellExecute = $false
    foreach ($argument in $Arguments) { [void]$startInfo.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::Start($startInfo)
    $process.WaitForExit()
    return $process.ExitCode
}

$workRoot = Join-Path $repoRoot "temp\unity-importer-test"
$sourceRoot = Join-Path $workRoot "source"
$sourceMap = Join-Path $sourceRoot $Fixture
$resultRoot = Join-Path $workRoot "results"
$resultPath = Join-Path $resultRoot ($Fixture + ".json")
$logPath = Join-Path $resultRoot ($Fixture + ".log")
New-Item -ItemType Directory -Path $sourceRoot,$resultRoot -Force | Out-Null

if (-not $UnityExe) {
    $preferred = "C:\Program Files\Unity\Hub\Editor\2022.3.22f1\Editor\Unity.exe"
    if (Test-Path -LiteralPath $preferred -PathType Leaf) {
        $UnityExe = $preferred
    } else {
        $installed = Get-ChildItem -LiteralPath "C:\Program Files\Unity\Hub\Editor" -Directory -ErrorAction Stop |
            Sort-Object { try { [Version]($_.Name -replace '[^0-9.].*$', '') } catch { [Version]'0.0' } } -Descending |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "Editor\Unity.exe") } |
            Select-Object -First 1
        if (-not $installed) { throw "No Unity Hub editor installation found; pass -UnityExe explicitly." }
        $UnityExe = Join-Path $installed.FullName "Editor\Unity.exe"
    }
}
$UnityExe = (Resolve-Path -LiteralPath $UnityExe).Path
$unityEditorDir = Split-Path $UnityExe -Parent
$unityVersion = Split-Path (Split-Path $unityEditorDir -Parent) -Leaf
$projectRoot = Join-Path $workRoot ("project-" + $unityVersion)
$assetsRoot = Join-Path $projectRoot "Assets"

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "ProjectSettings\ProjectVersion.txt") -PathType Leaf)) {
    $createLog = Join-Path $resultRoot ("create-project-" + $unityVersion + ".log")
    $createExit = Invoke-Unity "Create disposable Unity $unityVersion project" @(
        "-batchmode", "-nographics", "-quit", "-createProject", $projectRoot, "-logFile", $createLog
    )
    if ($createExit -ne 0) { throw "Unity project creation failed (exit $createExit). See $createLog" }
}

# The importer reads its bundle manifests with Newtonsoft and its neutral HUD hand-off uses UnityEngine.UI.Text.
# Add those released packages; all other dependencies are Unity built-in modules from the default project template.
$manifestPath = Join-Path $projectRoot "Packages\manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -AsHashtable
if (-not $manifest.ContainsKey("dependencies")) { $manifest["dependencies"] = [ordered]@{} }
if ($manifest["dependencies"]["com.unity.nuget.newtonsoft-json"] -ne "3.2.1") {
    $manifest["dependencies"]["com.unity.nuget.newtonsoft-json"] = "3.2.1"
}
if ($manifest["dependencies"]["com.unity.ugui"] -ne "1.0.0") {
    $manifest["dependencies"]["com.unity.ugui"] = "1.0.0"
}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 20) + [Environment]::NewLine)

$stageName = "OPENSLOPE_IMPORTER_TEST_" + $Fixture.ToUpperInvariant()
# Levels stage beside the synced library, under the one Assets/OpenSlope root (MapLayout.AssetsRoot).
$openSlopeRoot = Join-Path $assetsRoot "OpenSlope"
$stageRoot = Join-Path $openSlopeRoot "Maps"
$stageMap = Join-Path $stageRoot $stageName
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null

if (-not $SkipExport) {
    Remove-HarnessDirectory -Path $sourceMap -AllowedRoot $sourceRoot
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    Invoke-Checked "Export Slopesmith $Fixture fixture" $npm @(
        "--prefix", (Join-Path $repoRoot "Slopesmith"), "run", "autotest:map", "--",
        $sourceMap, "--fixture", $Fixture, "--no-project", "--authored-only"
    )

    $snowknifeProject = Join-Path $repoRoot "Snowknife\Snowknife\Snowknife.csproj"
    $dotnet = (Get-Command dotnet -ErrorAction Stop).Source
    Invoke-Checked "Build Snowknife" $dotnet @("build", $snowknifeProject, "-c", "Debug", "--no-restore", "--nologo")
    $snowknife = Join-Path $repoRoot "Snowknife\Snowknife\bin\Debug\net10.0\snowknife.exe"
    if (-not (Test-Path -LiteralPath $snowknife -PathType Leaf)) { throw "Snowknife executable not found: $snowknife" }
    Invoke-Checked "Bake importer bundle" $snowknife @("gltf", $sourceMap, $Fixture.ToLowerInvariant(), "--no-overrides")
} else {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceMap "gltf\manifest.json") -PathType Leaf)) {
        throw "-SkipExport requested, but no baked fixture exists at $sourceMap."
    }
    $snowknife = Join-Path $repoRoot "Snowknife\Snowknife\bin\Debug\net10.0\snowknife.exe"
    if (-not (Test-Path -LiteralPath $snowknife -PathType Leaf)) { throw "Snowknife executable not found: $snowknife" }
}

# A clean, reserved destination prevents stale bundle/material assets from making a broken import look healthy.
Remove-HarnessDirectory -Path $stageMap -AllowedRoot $stageRoot
$stageMeta = $stageMap + ".meta"
if (Test-Path -LiteralPath $stageMeta -PathType Leaf) { Remove-Item -LiteralPath $stageMeta -Force }
Invoke-Checked "Stage fixture into Unity" $snowknife @("unity", $sourceMap, $stageMap, "--no-shared")

if (-not $SkipSync) {
    & (Join-Path $PSScriptRoot "sync-unity.ps1") -Target $projectRoot -Dirs @("Importer") -Prune
    if ($LASTEXITCODE -ne 0) { throw "Sync Importer failed with exit code $LASTEXITCODE." }
    # Particle/P6 construction is importer behavior, but the shaders are supplied by the platform library. Bring
    # only shader sources into the neutral project; syncing VRC C# would pull in its SDK/Udon dependencies.
    & (Join-Path $PSScriptRoot "sync-unity.ps1") -Target $projectRoot -Dirs @("VRC") `
        -Ext @("shader", "cginc", "hlsl") -Prune
    if ($LASTEXITCODE -ne 0) { throw "Sync OpenSlope platform shaders failed with exit code $LASTEXITCODE." }
}

Remove-Item -LiteralPath $resultPath,$logPath -Force -ErrorAction SilentlyContinue
$assetLevel = "Assets/OpenSlope/Maps/$stageName"
Write-Host "`n== Unity importer smoke + coverage =="
Write-Host "Unity:   $UnityExe"
Write-Host "Project: $projectRoot"
Write-Host "Fixture: $assetLevel"
$unityArgs = @(
    "-batchmode", "-nographics", "-quit",
    "-projectPath", $projectRoot,
    "-enableCodeCoverage",
    "-executeMethod", "OpenSlope.Importer.ImporterSmokeTest.Run",
    "-openslopeTestLevel", $assetLevel,
    "-openslopeTestResult", $resultPath,
    "-logFile", $logPath
)
# PowerShell does not wait when a native Windows GUI executable is invoked with `&`. Use the process API's
# ArgumentList so paths with spaces stay intact and the result is inspected only after Unity really exits.
$unityExit = Invoke-Unity "Run disposable Unity importer project" $unityArgs

if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
    if (Test-Path -LiteralPath $logPath) {
        Write-Host "`nUnity log tail:"
        Get-Content -LiteralPath $logPath -Tail 80
    }
    throw "Unity produced no smoke-test result (exit $unityExit). See $logPath"
}

$result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
Write-Host "`nOpenSlope Unity importer"
Write-Host ("  Scene:    {0} objects, {1} renderers, {2} colliders, {3} markers" -f
    $result.scene.gameObjects, $result.scene.renderers, $result.scene.meshColliders, $result.scene.markers)
Write-Host ("  Lines:    {0}/{1} ({2:N2}%)" -f
    $result.coverage.coveredLines, $result.coverage.totalLines, $result.coverage.linePercent)
Write-Host ("  Methods:  {0}/{1} ({2:N2}%)" -f
    $result.coverage.coveredMethods, $result.coverage.totalMethods, $result.coverage.methodPercent)
Write-Host ("  Seq pts:  {0}/{1} ({2:N2}%)" -f
    $result.coverage.coveredSequencePoints, $result.coverage.totalSequencePoints, $result.coverage.sequencePointPercent)
Write-Host "  Result:   $resultPath"
Write-Host "  Log:      $logPath"

if ($unityExit -ne 0 -or -not $result.passed) {
    foreach ($failure in $result.errors) { Write-Error $failure -ErrorAction Continue }
    throw "OpenSlope Unity importer test failed (Unity exit $unityExit)."
}
