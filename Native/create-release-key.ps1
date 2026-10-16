param([Parameter(Mandatory = $true)][string]$Directory)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskJava = Join-Path $taskRoot '.openslope/native-android/jdk/bin/keytool.exe'
if (-not (Test-Path -LiteralPath $taskJava)) { throw 'Run Native/setup-android.ps1 first.' }
$taskDirectory = [IO.Path]::GetFullPath($Directory)
$taskCheckout = [IO.Path]::GetFullPath($taskRoot).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
if (($taskDirectory + [IO.Path]::DirectorySeparatorChar).StartsWith($taskCheckout, [StringComparison]::OrdinalIgnoreCase)) { throw 'Save the release key outside the checkout.' }
if (Test-Path -LiteralPath $taskDirectory) { throw 'Choose a new private directory. Existing signing files are never overwritten.' }
New-Item -ItemType Directory -Path $taskDirectory | Out-Null
$taskAcl = Get-Acl -LiteralPath $taskDirectory
$taskAcl.SetAccessRuleProtection($true, $false)
$taskRights = [Security.AccessControl.FileSystemRights]::FullControl
$taskInherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$taskPropagation = [Security.AccessControl.PropagationFlags]::None
$taskAllow = [Security.AccessControl.AccessControlType]::Allow
$taskUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($taskSid in @($taskUser, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
    $taskAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($taskSid, $taskRights, $taskInherit, $taskPropagation, $taskAllow))
}
Set-Acl -LiteralPath $taskDirectory -AclObject $taskAcl
$taskBytes = New-Object byte[] 32
$taskGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $taskGenerator.GetBytes($taskBytes) } finally { $taskGenerator.Dispose() }
$taskPassword = [Convert]::ToBase64String($taskBytes)
$taskSecurePassword = ConvertTo-SecureString -String $taskPassword -AsPlainText -Force
$taskPasswordFile = Join-Path $taskDirectory 'password.dpapi'
ConvertFrom-SecureString -SecureString $taskSecurePassword | Set-Content -LiteralPath $taskPasswordFile -Encoding ASCII
$taskPrevious = [Environment]::GetEnvironmentVariable('OPENSLOPE_KEY_GENERATION_PASSWORD')
$env:OPENSLOPE_KEY_GENERATION_PASSWORD = $taskPassword
try {
    $taskKey = Join-Path $taskDirectory 'openslope-native-release.p12'
    & $taskJava -genkeypair -keystore $taskKey -storetype PKCS12 -alias openslope-native -storepass:env OPENSLOPE_KEY_GENERATION_PASSWORD -keypass:env OPENSLOPE_KEY_GENERATION_PASSWORD -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=OpenSlope Native, O=OpenSlope'
    if ($LASTEXITCODE -ne 0) { throw 'Release key creation failed. Preserve the directory for recovery; do not silently replace an existing key.' }
    & $taskJava -exportcert -rfc -keystore $taskKey -alias openslope-native -storepass:env OPENSLOPE_KEY_GENERATION_PASSWORD -file (Join-Path $taskDirectory 'release-certificate.pem')
    if ($LASTEXITCODE -ne 0) { throw 'Public certificate export failed.' }
    @'
OpenSlope Native release signing identity

The .p12 file is the permanent private signing key. Keep it private and back it up.
The public .pem certificate can be shared to verify the identity.
Alias: openslope-native. The store and key passwords are the same.

password.dpapi is encrypted to this Windows user/account on this machine.
Copying that file alone to another machine is NOT a portable password backup.
While signed in as this Windows user, recover the password locally for your
password manager with PowerShell; do not paste it into chat or an issue:

$taskSecure = (Get-Content -LiteralPath .\password.dpapi -Raw).Trim() | ConvertTo-SecureString
$taskCredential = [PSCredential]::new('openslope-native', $taskSecure)
$taskCredential.GetNetworkCredential().Password

Back up the .p12 AND its recovered password in a secure location/password manager.
Do this before relying on this identity for public updates. Ordinary APK updates
must keep the same signing identity. Never commit or upload this directory as a
release asset. See Native/docs/releases.md for local builds and GitHub secrets.
'@ | Set-Content -LiteralPath (Join-Path $taskDirectory 'BACKUP-INSTRUCTIONS.txt') -Encoding UTF8
    Write-Output "Created release key and backup instructions in $taskDirectory"
    Write-Output 'No private key or password was printed or uploaded.'
} finally {
    [Environment]::SetEnvironmentVariable('OPENSLOPE_KEY_GENERATION_PASSWORD', $taskPrevious, 'Process')
    $taskPassword = $null
    $taskSecurePassword.Dispose()
    [Array]::Clear($taskBytes, 0, $taskBytes.Length)
}
