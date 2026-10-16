param([switch]$Setup, [switch]$Preview,
    [string]$OutputDirectory = '', [int]$Jobs = 4)
$ErrorActionPreference = 'Stop'
if ($Jobs -lt 1 -or $Jobs -gt 64) { throw 'Jobs must be between 1 and 64.' }
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $taskRoot 'temp/native-release-artifacts' }
$taskBuild = Join-Path $taskRoot 'temp/native-release'
$taskCmake = (Get-Command cmake -ErrorAction SilentlyContinue).Source
if (-not $taskCmake) {
    $taskVswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    $taskVsRoot = & $taskVswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($taskVsRoot) { $taskCmake = Join-Path $taskVsRoot 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe' }
}
if (-not $taskCmake -or -not (Test-Path -LiteralPath $taskCmake)) { throw 'Install Visual Studio C++ Build Tools with CMake.' }
$taskPython = (Get-Command python -ErrorAction Stop).Source
if (-not $Preview) {
    $taskDirty = & git -C $taskRoot status --porcelain
    if ($LASTEXITCODE -ne 0 -or $taskDirty) { throw 'Commit the release source before building a public package, or use -Preview.' }
    foreach ($taskName in @('OPENSLOPE_ANDROID_KEYSTORE', 'OPENSLOPE_ANDROID_STORE_PASSWORD', 'OPENSLOPE_ANDROID_KEY_ALIAS', 'OPENSLOPE_ANDROID_KEY_PASSWORD')) {
        if (-not [Environment]::GetEnvironmentVariable($taskName)) { throw "Release signing requires $taskName. See Native/docs/releases.md." }
    }
}
& $taskPython (Join-Path $taskRoot 'tools/hygiene.py')
if ($LASTEXITCODE -ne 0) { throw 'Repository hygiene failed.' }
& $taskPython (Join-Path $PSScriptRoot 'tests/package_release_test.py')
if ($LASTEXITCODE -ne 0) { throw 'Release packaging checks failed.' }
# The portable Windows package carries its C++ runtime inside each executable.
& $taskCmake -S $PSScriptRoot -B $taskBuild -A x64 '-DOPENSLOPE_BUILD_PLAYER=ON' '-DOPENSLOPE_BUILD_TESTS=ON' '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded'
if ($LASTEXITCODE -ne 0) { throw 'Release configure failed.' }
& $taskCmake --build $taskBuild --config Release --parallel $Jobs
if ($LASTEXITCODE -ne 0) { throw 'Release build failed.' }
$taskCtest = Join-Path (Split-Path -Parent $taskCmake) 'ctest.exe'
& $taskCtest --test-dir $taskBuild -C Release --output-on-failure
if ($LASTEXITCODE -ne 0) { throw 'Release conformance failed.' }
$taskAndroidOptions = @{ HostShaderDirectory = (Join-Path $taskBuild 'generated') }
if ($Setup) { $taskAndroidOptions.Setup = $true }
if (-not $Preview) { $taskAndroidOptions.Release = $true }
& (Join-Path $PSScriptRoot 'build-android.ps1') @taskAndroidOptions
$taskVariant = if ($Preview) { 'debug' } else { 'release' }
$taskPackageOptions = @('--windows-build', $taskBuild, '--apk', (Join-Path $PSScriptRoot "android/app/build/outputs/apk/$taskVariant/app-$taskVariant.apk"), '--output', $OutputDirectory)
if ($Preview) { $taskPackageOptions += '--preview' }
$env:JAVA_HOME = Join-Path $taskRoot '.openslope/native-android/jdk'
& $taskPython (Join-Path $PSScriptRoot 'tools/package_release.py') @taskPackageOptions
if ($LASTEXITCODE -ne 0) { throw 'Release packaging failed.' }
Write-Output "Packages: $OutputDirectory"
