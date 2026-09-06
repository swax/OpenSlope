<#
.SYNOPSIS
  Open an extracted SSX level in the Blender GUI, already framed and de-clipped.

.DESCRIPTION
  Locates blender.exe, then launches it (windowed) running open_in_blender.py,
  which imports Terrain.obj + Props.obj from the given level folder.

.PARAMETER LevelDir
  The extracted level folder (the one containing Terrain.obj / Props.obj).
  Defaults to ..\Maps\MYMAP relative to this script.

.EXAMPLE
  .\open-level.ps1
.EXAMPLE
  .\open-level.ps1 -LevelDir C:\path\to\Maps\MYMAP
#>
param(
    [string]$LevelDir = "$PSScriptRoot\..\Maps\MYMAP"
)

$ErrorActionPreference = "Stop"

$pyScript = Join-Path $PSScriptRoot "open_in_blender.py"
if (-not (Test-Path $pyScript)) { throw "Missing $pyScript" }

if (-not (Test-Path $LevelDir)) { throw "Level folder not found: $LevelDir" }
$LevelDir = (Resolve-Path $LevelDir).Path
# Props.obj is the gate, not Terrain.obj: terrain lives in the glTF bundle, so `snowknife import` writes no
# Terrain.obj. open_in_blender.py warns-and-continues per missing file, so a props-only level still opens -
# for terrain, use open-bundle.ps1 on the level's gltf/ folder.
if (-not (Test-Path (Join-Path $LevelDir "Props.obj"))) {
    throw "No Props.obj in '$LevelDir'. Run `snowknife import <iso> <courseSlot> $LevelDir` first."
}

# Find blender.exe: newest under Program Files, else PATH.
$blender =
    (Get-ChildItem "C:\Program Files\Blender Foundation\*\blender.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName)
if (-not $blender) { $blender = (Get-Command blender -ErrorAction SilentlyContinue).Source }
if (-not $blender) {
    throw "Could not find blender.exe. Install Blender or add it to PATH, or edit this script."
}

Write-Host "Opening $LevelDir in Blender ($blender)..."
& $blender --python $pyScript -- $LevelDir
