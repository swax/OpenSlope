param([switch]$Setup, [switch]$Tests)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskTools = Join-Path $taskRoot '.openslope/native-android'
if ($Setup) { & (Join-Path $PSScriptRoot 'setup-android.ps1') }
$taskGradle = Join-Path $taskTools 'gradle/bin/gradle.bat'
$taskJava = Join-Path $taskTools 'jdk'
$taskSdk = Join-Path $taskTools 'sdk'
if (-not (Test-Path -LiteralPath $taskGradle) -or -not (Test-Path -LiteralPath (Join-Path $taskJava 'bin/java.exe'))) { throw 'Run Native/setup-android.ps1 first, or use your own Android SDK/JDK/Gradle installation.' }
$taskShaders = Join-Path $taskRoot 'temp/native/generated/terrain_vert.hpp'
if (-not (Test-Path -LiteralPath $taskShaders)) { throw 'Build the host player with Native/build.ps1 -Player first.' }
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
$taskGradleTargets = @('assembleDebug')
if ($Tests) { $taskGradleTargets += 'assembleDebugAndroidTest' }
& $taskGradle -p (Join-Path $PSScriptRoot 'android') --no-daemon "-Duser.home=$taskJavaHome" @taskGradleTargets
if ($LASTEXITCODE -ne 0) { throw 'Android APK build failed.' }
Write-Output 'APK: Native/android/app/build/outputs/apk/debug/app-debug.apk'
