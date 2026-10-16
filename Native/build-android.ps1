param([switch]$Setup, [switch]$Tests, [switch]$Release,
    [string]$HostShaderDirectory = '')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskTools = Join-Path $taskRoot '.openslope/native-android'
if ($Setup) { & (Join-Path $PSScriptRoot 'setup-android.ps1') }
$taskGradle = Join-Path $taskTools 'gradle/bin/gradle.bat'
$taskJava = Join-Path $taskTools 'jdk'
$taskSdk = Join-Path $taskTools 'sdk'
if (-not (Test-Path -LiteralPath $taskGradle) -or -not (Test-Path -LiteralPath (Join-Path $taskJava 'bin/java.exe'))) { throw 'Run Native/setup-android.ps1 first, or use your own Android SDK/JDK/Gradle installation.' }
$taskShaderDirectory = if ($HostShaderDirectory) { [IO.Path]::GetFullPath($HostShaderDirectory) } else { Join-Path $taskRoot 'temp/native/generated' }
$taskShaders = Join-Path $taskShaderDirectory 'terrain_vert.hpp'
if (-not (Test-Path -LiteralPath $taskShaders)) { throw 'Build the host player with Native/build.ps1 -Player first.' }
if ($Release) {
    foreach ($taskName in @('OPENSLOPE_ANDROID_KEYSTORE', 'OPENSLOPE_ANDROID_STORE_PASSWORD', 'OPENSLOPE_ANDROID_KEY_ALIAS', 'OPENSLOPE_ANDROID_KEY_PASSWORD')) {
        if (-not [Environment]::GetEnvironmentVariable($taskName)) { throw "Release signing requires $taskName. See Native/docs/releases.md." }
    }
    if (-not (Test-Path -LiteralPath $env:OPENSLOPE_ANDROID_KEYSTORE -PathType Leaf)) { throw 'Release keystore file does not exist.' }
}
$env:JAVA_HOME = $taskJava
$env:ANDROID_HOME = $taskSdk
$env:ANDROID_SDK_ROOT = $taskSdk
$env:GRADLE_USER_HOME = Join-Path $taskTools 'gradle-cache'
$taskJavaHome = Join-Path $taskTools 'java-home'
New-Item -ItemType Directory -Force -Path $taskJavaHome | Out-Null
$taskSdkProperty = $taskSdk.Replace('\','/').Replace(':','\:')
$taskCmakeProperty = (Join-Path $taskSdk 'cmake/3.31.6').Replace('\','/').Replace(':','\:')
@("sdk.dir=$taskSdkProperty", "cmake.dir=$taskCmakeProperty") | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'android/local.properties') -Encoding ASCII
if ($Tests) {
    $taskPython = (Get-Command python -ErrorAction Stop).Source
    & $taskPython (Join-Path $PSScriptRoot 'tests/make_android_fixture.py') (Join-Path $PSScriptRoot 'android/app/build/generated/testAssets/fixture.iso')
    if ($LASTEXITCODE -ne 0) { throw 'Android test fixture generation failed.' }
}
$taskGradleTargets = @($(if ($Release) { 'assembleRelease' } else { 'assembleDebug' }))
if ($Tests) { $taskGradleTargets += 'assembleDebugAndroidTest' }
& $taskGradle -p (Join-Path $PSScriptRoot 'android') --no-daemon "-Duser.home=$taskJavaHome" "-PopenslopeHostShaderDir=$taskShaderDirectory" @taskGradleTargets
if ($LASTEXITCODE -ne 0) { throw 'Android APK build failed.' }
$taskVariant = if ($Release) { 'release' } else { 'debug' }
Write-Output "APK: Native/android/app/build/outputs/apk/$taskVariant/app-$taskVariant.apk"
