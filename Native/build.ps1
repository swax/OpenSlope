param([switch]$Player, [switch]$NoTests)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskBuild = Join-Path $taskRoot $(if ($Player) { 'temp/native' } else { 'temp/native-core' })
$taskCmake = (Get-Command cmake -ErrorAction SilentlyContinue).Source
if (-not $taskCmake) {
    $taskVswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (Test-Path -LiteralPath $taskVswhere) {
        $taskVsRoot = & $taskVswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($taskVsRoot) { $taskCmake = Join-Path $taskVsRoot 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe' }
    }
}
if (-not $taskCmake -or -not (Test-Path -LiteralPath $taskCmake)) { throw 'Install CMake 3.24+ and a C++20 compiler (Visual Studio C++ Build Tools on Windows).' }
$taskPlayerFlag = if ($Player) { 'ON' } else { 'OFF' }
& $taskCmake -S $PSScriptRoot -B $taskBuild "-DOPENSLOPE_BUILD_PLAYER=$taskPlayerFlag"
if ($LASTEXITCODE -ne 0) { throw 'Native configure failed.' }
& $taskCmake --build $taskBuild --config Release --parallel
if ($LASTEXITCODE -ne 0) { throw 'Native build failed.' }
if (-not $NoTests) {
    $taskCtest = Join-Path (Split-Path -Parent $taskCmake) 'ctest.exe'
    & $taskCtest --test-dir $taskBuild -C Release --output-on-failure
    if ($LASTEXITCODE -ne 0) { throw 'Native conformance failed.' }
}
