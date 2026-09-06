#!/usr/bin/env pwsh
# sync-unity.ps1 - push the OpenSlope library source (.cs/shader include files) from this repo into a Unity project.
#
# The repo is the source-of-truth for the VRC + Importer library scripts/shaders; the actual Unity
# projects hold their own copies. After editing a .cs/.shader here, run this to overlay the
# changes into the target project, then let Unity recompile. Only file CONTENTS are synced - .meta files are
# left alone (they're gitignored here; the target project owns its own GUIDs, components attach by type and
# Shader.Find by name, so no .meta needs to travel).
#
# Usage (from the repo root, or anywhere):
#   pwsh Unity/tools/sync-unity.ps1 -Target MyWorld    # short name -> <projects root>\MyWorld
#   pwsh Unity/tools/sync-unity.ps1 -Target C:\path\to\Project   # or a full project root (the folder holding Assets)
#   pwsh Unity/tools/sync-unity.ps1 -DryRun             # show what WOULD change, copy nothing
#   pwsh Unity/tools/sync-unity.ps1 -Prune              # also delete orphaned .cs/.shader (+ .meta) + dead U# program assets
#   pwsh Unity/tools/sync-unity.ps1 -AssetSubdir ""     # sync flat into Assets/, with no OpenSlope subfolder
#
# Destination: the library lands in <project>/Assets/OpenSlope/{VRC,Importer}, beside the levels
# `snowknife unity` stages into Assets/OpenSlope/Maps - one folder holding the whole OpenSlope install, so a
# host project's Assets/ stays legible. That root is MapLayout.AssetsRoot on the C# side; change both together.
#
# Exit code: 0 on success, 1 if the source/target can't be resolved.

[CmdletBinding()]
param(
    # Target Unity project: an existing path (the folder containing Assets), or a short name resolved under
    # the projects root, $env:OPENSLOPE_UNITY_PROJECTS. Required unless $env:OPENSLOPE_UNITY_PROJECT names a default.
    [string]$Target = $env:OPENSLOPE_UNITY_PROJECT,

    # Delete synced source/shader files in the target (under the synced dirs) that no longer exist in the repo, plus their
    # sibling .meta AND any orphaned UdonSharp program asset (<name>.asset whose <name>.cs is gone). Off by
    # default - stale scripts/assets cause compile + scene-upgrade errors, so this is worth running, but it's
    # destructive so you opt in. Without it, orphans are only reported.
    [switch]$Prune,

    # Report what would change/copy/prune without touching the target.
    [switch]$DryRun,

    # Library subfolders (under Unity/) treated as the source-of-truth; each maps 1:1 into the target's
    # Assets/<AssetSubdir>/ (so Unity/VRC/Editor/Foo.cs lands at Assets/OpenSlope/VRC/Editor/Foo.cs).
    [string[]]$Dirs = @("VRC", "Importer"),

    # Folder under the project's Assets/ that holds the whole OpenSlope install - the library dirs above and,
    # beside them, the levels `snowknife unity` stages. Keeping it to one folder is what lets a host project's
    # Assets/ stay legible. Must match MapLayout.AssetsRoot in Importer/Editor/MapLayout.cs; pass "" to sync
    # flat into Assets/ with no subfolder.
    [string]$AssetSubdir = "OpenSlope",

    # File extensions (no dot) to sync.
    [string[]]$Ext = @("cs", "shader", "cginc", "hlsl")
)

$ErrorActionPreference = "Stop"

# Delete an orphaned target file plus its sibling .meta (used when pruning).
function Remove-OrphanFile([string]$path) {
    if (Test-Path $path) { Remove-Item -Path $path -Force }
    $meta = "$path.meta"
    if (Test-Path $meta) { Remove-Item -Path $meta -Force }
}

# --- resolve source (this repo) and target project ---------------------------------------------------------
$SrcAssets = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path $SrcAssets)) { Write-Error "Source Unity/ not found: $SrcAssets"; exit 1 }

# Root that short -Target names resolve under. Set $env:OPENSLOPE_UNITY_PROJECTS to your Unity projects folder,
# or pass -Target with a full path to the project root.
$ProjectsRoot = $env:OPENSLOPE_UNITY_PROJECTS
if (-not $Target) { Write-Error "No target project: pass -Target <path-or-name>, or set OPENSLOPE_UNITY_PROJECT."; exit 1 }
if (-not $ProjectsRoot -and -not (Test-Path $Target)) { Write-Error "A short -Target name needs OPENSLOPE_UNITY_PROJECTS set to your Unity projects folder."; exit 1 }

if (Test-Path $Target) {
    $TargetRoot = (Resolve-Path $Target).Path
} else {
    $TargetRoot = Join-Path $ProjectsRoot $Target
}
$ProjectAssets = Join-Path $TargetRoot "Assets"
if (-not (Test-Path $ProjectAssets)) {
    Write-Error "Target Assets not found: $ProjectAssets  (pass -Target as a project name under $ProjectsRoot or a full path; set OPENSLOPE_UNITY_PROJECTS to change the projects root)"
    exit 1
}
# Everything the sync writes lands under Assets/<AssetSubdir>/. Created on first sync into a fresh project;
# Unity generates the .meta for it on import, same as any other folder we add.
$DstAssets = if ($AssetSubdir) { Join-Path $ProjectAssets $AssetSubdir } else { $ProjectAssets }
if (-not $DryRun -and -not (Test-Path $DstAssets)) { New-Item -ItemType Directory -Force -Path $DstAssets | Out-Null }

$mode = if ($DryRun) { " (DRY RUN - nothing will be written)" } else { "" }
Write-Host "Syncing $($Ext -join '/') from"
Write-Host "  $SrcAssets"
Write-Host "into"
Write-Host "  $DstAssets$mode"
Write-Host "  dirs: $($Dirs -join ', ')`n"

$copied = 0; $unchanged = 0; $created = 0; $orphans = @()

foreach ($dir in $Dirs) {
    $srcDir = Join-Path $SrcAssets $dir
    if (-not (Test-Path $srcDir)) { Write-Warning "skip (source directory unavailable): Unity/$dir"; continue }

    # Source files, by path relative to Unity/ (so VRC/Editor/Foo.cs maps 1:1 into the target's Assets/).
    $srcFiles = Get-ChildItem -Path $srcDir -Recurse -File -Include ($Ext | ForEach-Object { "*.$_" })
    $srcRel = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

    foreach ($f in $srcFiles) {
        $rel = [System.IO.Path]::GetRelativePath($SrcAssets, $f.FullName)
        [void]$srcRel.Add($rel)
        $dst = Join-Path $DstAssets $rel

        if (Test-Path $dst) {
            if ((Get-FileHash $f.FullName).Hash -eq (Get-FileHash $dst).Hash) { $unchanged++; continue }
            $copied++
            Write-Host "  ~ $rel"
        } else {
            $created++
            Write-Host "  + $rel"
        }
        if (-not $DryRun) {
            $dstParent = Split-Path -Parent $dst
            if (-not (Test-Path $dstParent)) { New-Item -ItemType Directory -Force -Path $dstParent | Out-Null }
            Copy-Item -Path $f.FullName -Destination $dst -Force
        }
    }

    # Orphans: target .cs/.shader under this dir that the repo no longer has.
    $dstDir = Join-Path $DstAssets $dir
    if (Test-Path $dstDir) {
        $dstFiles = Get-ChildItem -Path $dstDir -Recurse -File -Include ($Ext | ForEach-Object { "*.$_" })
        foreach ($f in $dstFiles) {
            $rel = [System.IO.Path]::GetRelativePath($DstAssets, $f.FullName)
            if (-not $srcRel.Contains($rel)) { $orphans += $rel }
        }
    }
}

# --- orphan handling ---------------------------------------------------------------------------------------
# For each orphaned .cs we also look for a sibling UdonSharp program asset (<name>.asset in the same folder -
# the convention EnsureProgramAsset follows). Once the class .cs is gone that .asset is dead weight whose null
# source script breaks UdonSharp's scene upgrade (the "Source C# script ... is null" errors you'd otherwise
# hand-clean in the editor), so it's pruned alongside. Name-match heuristic, scoped to the synced lib dirs.
# NOTE: a stale SCENE reference to a deleted U# behaviour isn't a file the sync can touch - re-run the matching
# OpenSlope/Setup step to rebuild that object.
$assetOrphans = @()
foreach ($rel in $orphans) {
    if ([System.IO.Path]::GetExtension($rel) -ne ".cs") { continue }
    $assetRel = [System.IO.Path]::ChangeExtension($rel, ".asset")
    if (Test-Path (Join-Path $DstAssets $assetRel)) { $assetOrphans += $assetRel }
}

if ($orphans.Count -gt 0 -or $assetOrphans.Count -gt 0) {
    Write-Host ""
    $verb = if ($Prune) { "pruning" } else { "ORPHANS (in target, not in repo)" }
    Write-Host "$($verb):"
    foreach ($rel in $orphans) {
        Write-Host "  - $rel"
        if ($Prune -and -not $DryRun) { Remove-OrphanFile (Join-Path $DstAssets $rel) }
    }
    foreach ($rel in $assetOrphans) {
        Write-Host "  - $rel  (orphaned UdonSharp program asset)"
        if ($Prune -and -not $DryRun) { Remove-OrphanFile (Join-Path $DstAssets $rel) }
    }
    if (-not $Prune) { Write-Host "  (re-run with -Prune to delete these + their .meta)" }
}

# --- summary ---------------------------------------------------------------------------------------------- -
Write-Host ""
$assetNote = if ($assetOrphans.Count -gt 0) { " + $($assetOrphans.Count) program-asset(s)" } else { "" }
Write-Host "Done: $created new, $copied changed, $unchanged unchanged, $($orphans.Count) orphan(s)$assetNote$(if ($Prune -and -not $DryRun) { ' pruned' } else { '' })."
if (-not $DryRun -and ($created + $copied -gt 0 -or ($Prune -and ($orphans.Count + $assetOrphans.Count) -gt 0))) {
    Write-Host "Unity will pick up the changes on focus (or trigger a recompile)."
}
