#!/usr/bin/env pwsh
# check-importer-neutral.ps1 - the boundary guard for the platform-neutral level importer.
#
# Unity/Importer must build the level as neutral geometry + *Marker components ONLY - no VRChat/Udon (or any
# platform) dependency. Each platform plugin (Unity/VRC, Unity/Basis) references the importer + its own SDK
# and realizes the markers into its own runtime behaviours (VrcWiring / BasisWiring). This script fails if any
# VRChat/Udon reference creeps back into the importer, so the inversion can't silently rot (there are no .asmdefs to
# enforce it at compile time - see docs/authoring/00-pipeline.md).
#
# The boundary is a NAMESPACE, so the guard asks the only question that matters: does importer code name
# OpenSlope.VrcPlugin or OpenSlope.BasisPlugin at all - as an import, an alias, or a qualified type? A platform type is
# unreachable from the importer without one of those, so nothing has to be kept in sync here and a new
# platform type is covered the moment it is declared.
#
# Matching platform type NAMES instead would not work: the types carry no layer prefix, so their names are
# ordinary words - `Refresh`, `Map`, `GemPickup`, `PlayerFlight` - and a name scan flags `AssetDatabase.Refresh()`,
# a `_cfg.GemPickup` field and a `"HudMessageDisplay"` GameObject name. A name cannot tell you which layer it
# belongs to; a namespace can.
#
# Because the namespace IS the boundary, a layer file that declares no namespace would sit in the global
# namespace and be reachable from the importer with no import to find. So the layout is asserted first: every
# .cs under a layer must declare that layer's namespace. That check is what makes the scan below sufficient.
#
# Comments are stripped before matching. The importer's prose legitimately names the platform behaviours its
# markers get realized into; only a reference in real code is a dependency.
#
# Run from anywhere:  pwsh Unity/tools/check-importer-neutral.ps1
# Exit code: 0 clean, 1 if any forbidden reference is found.

$ErrorActionPreference = "Stop"
$unityRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $unityRoot
$importer = Join-Path $unityRoot "Importer"
if (-not (Test-Path $importer)) { Write-Error "Not found: $importer"; exit 1 }

$layers = [ordered]@{ Importer = "OpenSlope.Importer"; VRC = "OpenSlope.VrcPlugin"; Basis = "OpenSlope.BasisPlugin" }

# Replace every non-newline character of a match with a space: the text keeps its exact length and line
# breaks, so line numbers and match offsets still point at the real file.
$blank = { param($m) ($m.Value -replace '[^\r\n]', ' ') }

# Comments -> spaces. Returns the whole file as one string.
function Get-CodeText([string]$path) {
    $raw = Get-Content -Raw -LiteralPath $path
    if ($null -eq $raw) { return "" }
    $raw = [regex]::Replace($raw, '/\*.*?\*/', $blank, 'Singleline')   # block comments
    [regex]::Replace($raw, '//[^\r\n]*', $blank)                       # line comments
}

# Blank out comments while preserving line numbering, so reported lines still match the file.
function Get-CodeLines([string]$path) { (Get-CodeText $path) -split "`r?`n" }

# --- assert the layout the scan depends on ----------------------------------------------------------------
# A file with no namespace is in the global namespace, where the importer could reach it without an import -
# so an unnamespaced layer file is a hole in the boundary, not a style nit.
$stray = @()
$counted = 0
foreach ($layer in $layers.Keys) {
    $dir = Join-Path $unityRoot $layer
    if (-not (Test-Path $dir)) { continue }
    $want = $layers[$layer]
    foreach ($f in Get-ChildItem -Path $dir -Recurse -File -Filter *.cs) {
        $counted++
        if ((Get-CodeText $f.FullName) -notmatch ("(?m)^\s*namespace\s+" + [regex]::Escape($want) + "\s*$")) {
            $stray += "{0} (expected 'namespace {1}')" -f [System.IO.Path]::GetRelativePath($repoRoot, $f.FullName), $want
        }
    }
}
if ($stray) {
    Write-Error ("These layer sources declare no namespace, so the importer could reference them with no import to find:`n  " +
                 ($stray -join "`n  "))
    exit 1
}
if ($counted -eq 0) { Write-Error "Found 0 layer sources - the layout scan is broken, refusing to pass"; exit 1 }

# --- scan the importer ------------------------------------------------------------------------------------
# `OpenSlope.VrcPlugin` / `OpenSlope.BasisPlugin` in any form: a using, a using alias, or a qualified type reference.
$platformNsRx = [regex]'\bOpenSlope\.(VrcPlugin|BasisPlugin)\b'
$sdkRx        = [regex]'using\s+(VRC|UdonSharp)\b'

$hits = @()
foreach ($f in Get-ChildItem -Path $importer -Recurse -File -Filter *.cs) {
    $n = 0
    foreach ($line in Get-CodeLines $f.FullName) {
        $n++
        if ($line -match '^\s*$') { continue }
        $what = $null
        $m = $sdkRx.Match($line)
        if ($m.Success) { $what = $m.Value } else {
            $m = $platformNsRx.Match($line)
            if ($m.Success) { $what = $m.Value }
        }
        if ($what) {
            $hits += [pscustomobject]@{
                Path = [System.IO.Path]::GetRelativePath($repoRoot, $f.FullName); Line = $n
                What = $what; Text = $line.Trim()
            }
        }
    }
}

if ($hits) {
    Write-Host "Importer neutrality guard FAILED - platform references found in importer code:`n"
    foreach ($h in $hits) { Write-Host ("  {0}:{1}: [{2}]  {3}" -f $h.Path, $h.Line, $h.What, $h.Text) }
    Write-Host "`nThe importer must be platform-neutral: build geometry + *Markers only. Move any VRChat/Udon"
    Write-Host "wiring into VRC (VrcWiring / the *Setup menus). See docs/unity/060-platform-neutral-importer.md."
    exit 1
}

Write-Host "Importer neutrality guard PASSED - $counted layer sources correctly namespaced, and no VRChat/Udon import or OpenSlope.VrcPlugin/OpenSlope.BasisPlugin reference in the importer."
exit 0
