<#
.SYNOPSIS
  Open an extracted SSX bundle (snowknife .glb + manifest + textures) in the
  Blender GUI, fully textured and framed.

.DESCRIPTION
  Locates blender.exe, then launches it (windowed) running
  open_bundle_in_blender.py, which imports the bundle's .glb meshes, reconnects
  the Textures/ PNGs by material name, applies each texture's alpha mode from
  manifest.json, and (by default) multiplies the baked LightmapAtlas over them.

.PARAMETER BundleDir
  The bundle folder - the gltf/ folder `snowknife gltf` writes (manifest.json + terrain.glb).
  Defaults to ..\Maps\MYMAP\gltf relative to this script.

.EXAMPLE
  .\open-bundle.ps1
.EXAMPLE
  .\open-bundle.ps1 -BundleDir C:\path\to\Maps\MYMAP\gltf
#>
param(
    [string]$BundleDir = "$PSScriptRoot\..\Maps\MYMAP\gltf"
)

$ErrorActionPreference = "Stop"

$pyScript = Join-Path $PSScriptRoot "open_bundle_in_blender.py"
if (-not (Test-Path $pyScript)) { throw "Missing $pyScript" }

if (-not (Test-Path $BundleDir)) { throw "Bundle folder not found: $BundleDir" }
$BundleDir = (Resolve-Path $BundleDir).Path
if (-not (Test-Path (Join-Path $BundleDir "manifest.json"))) {
    throw "No manifest.json in '$BundleDir'. Run the snowknife bundle export first."
}

# Find blender.exe: newest under Program Files, else PATH.
$blender =
    (Get-ChildItem "C:\Program Files\Blender Foundation\*\blender.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName)
if (-not $blender) { $blender = (Get-Command blender -ErrorAction SilentlyContinue).Source }
if (-not $blender) {
    throw "Could not find blender.exe. Install Blender or add it to PATH, or edit this script."
}

Write-Host "Opening bundle $BundleDir in Blender ($blender)..."
& $blender --python $pyScript -- $BundleDir
