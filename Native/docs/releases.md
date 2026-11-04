# Distributing the native player

Native releases use `native-v<Native/VERSION.txt>` tags, separately from other
OpenSlope components. Start with a GitHub **prerelease** while gameplay and device
coverage remain incomplete. Release packages contain the application and notices;
users provide their own custom maps or import their own local disc image.

## What users download

| File | Purpose |
|---|---|
| `OpenSlope-Native-<version>-Windows-x64.zip` | Portable player, import/inspection tools, launchers, empty Maps library, instructions and complete notices. |
| `OpenSlope-Native-<version>-Linux-x64.tar.gz` | Linux desktop player, import/inspection tools, executable launcher and notices. Built on Ubuntu 22.04. |
| `OpenSlope-Native-<version>-macOS-arm64.zip` | Apple Silicon application with MoltenVK, tools and notices bundled inside. |
| `OpenSlope-Native-<version>-macOS-x64.zip` | Intel Mac application with the same bundled runtime and tools. |
| `OpenSlope-Native-<version>-Quest-arm64.apk` | Installable standalone Quest app with the map/ISO picker and embedded notices. |
| `RELEASE-NOTES.md` | Installation, controls, upgrade advice and known limits. |
| `release-manifest.json` | Source commit, per-platform inventories/dependencies, APK identity, Mac signing status and hashes. |
| `SHA256SUMS.txt` | SHA-256 for every other release asset. |

The Windows release uses a static C++ runtime; users need a current Vulkan
graphics driver, not Visual Studio, Python or a separate C++ redistributable.
No shader compiler, SDK, ADB, test executable, instrumentation APK or private map
is shipped. PC VR requires an installed active OpenXR runtime.

## One-time Quest signing identity

Use a dedicated, backed-up signing key for public releases. Do not reuse the
development debug key. Android accepts an app update only when its signing
identity is compatible with the installed app, and the version code does not
decrease. Keep the key for the lifetime of this app; losing it prevents ordinary
in-place updates. See [Android app signing](https://developer.android.com/studio/publish/app-signing).

If there is no existing release key, the Windows helper creates one outside the
checkout, restricts its folder to the current user/administrators/system, and saves
its random password encrypted with Windows DPAPI. It never overwrites a directory:

```powershell
./Native/create-release-key.ps1 -Directory C:\private\OpenSlopeSigning
```

Read the generated `BACKUP-INSTRUCTIONS.txt` before publishing. DPAPI is bound to
this Windows user/machine; the `.p12` file and password must also be backed up in a
portable secure location. The helper prints no private key or password and uploads
nothing. Alternatively, this command prompts for your own passwords:

```powershell
keytool -genkeypair -v -keystore C:\private\openslope-native-release.jks -alias openslope-native -keyalg RSA -keysize 3072 -validity 10000
```

Back up that file and passwords securely before publishing. The build accepts:

- `OPENSLOPE_ANDROID_KEYSTORE`: absolute path to the key file.
- `OPENSLOPE_ANDROID_STORE_PASSWORD`: store password.
- `OPENSLOPE_ANDROID_KEY_ALIAS`: alias, for example `openslope-native`.
- `OPENSLOPE_ANDROID_KEY_PASSWORD`: private-key password.

The passwords are read from the environment, never command arguments or tracked
Gradle properties. Set them through your secret manager or a private local shell
session, and clear them when finished. Neither key material nor passwords belong
in issues, chat, source, release assets or logs.

The current local headset test builds are debug signed. A first public release
using a different certificate cannot replace them with `adb install -r`. Before
deliberately moving a tester to that signing identity, back up app-owned maps:

```powershell
adb pull /sdcard/Android/data/org.openslope.nativeplayer/files/Maps C:\private\Quest-Maps-backup
```

Verify the backup before uninstalling; uninstall can delete app-specific maps and
preferences. Future releases using the public key can update in place. There is
no need to switch the currently installed test headset merely to prepare a release.

## Build locally

Install the Windows C++ build prerequisites in Native/README.md. From the root:

```powershell
./Native/release.ps1 -Setup
```

This requires committed, clean source and the four signing variables. It runs the
central repository hygiene gate, packaging tests, a separate x64 Release build
with static CRT, all portable native conformance checks, and a signed non-debuggable
ARM64 release build. It verifies the APK signature, ID/version, architecture and
embedded notices, then creates the five files under
`temp/native-release-artifacts/OpenSlope-Native-<version>/`.

Use a fresh `-OutputDirectory` to repeat a package; existing output is never
replaced. Dependency archives and Android toolchains use the repository's existing
version/checksum pins. Builds are repeatable from source, but APK/PE bytes are not
promised identical across build machines. Each actual download has its own hash.

For a local package rehearsal without the public key:

```powershell
./Native/release.ps1 -Setup -Preview
```

These explicitly named `-preview` assets permit dirty release-tooling source and
use a debug APK. Do not attach them as the public signed release. The manifest
records the dirty state and certificate. This mode does not install anything.

## Build and draft on GitHub

Configure these repository Actions secrets once:

| GitHub secret | Value |
|---|---|
| `NATIVE_ANDROID_KEYSTORE_BASE64` | Base64 bytes of the backed-up release key file. |
| `NATIVE_ANDROID_STORE_PASSWORD` | Store password. |
| `NATIVE_ANDROID_KEY_ALIAS` | Key alias. |
| `NATIVE_ANDROID_KEY_PASSWORD` | Key password. |

Use GitHub's encrypted secret settings or `gh secret set`; do not paste a base64
key into a commit or a workflow. After the first successful build, set the Actions
variable `NATIVE_ANDROID_CERT_SHA256` to the manifest's `quest.signer_sha256` to
reject accidental signing-identity changes in later builds.

1. Increment `Native/VERSION.txt` and the Android `versionCode` in
   `Native/android/app/build.gradle`; add `Native/releases/<version>.md`.
2. Run the full repository gate (`npm run verify`) and check the desktop package
   and Quest app. Commit and push the tested source to `main`.
3. In Actions, run **Native release packages** on `main`. Leave **Create a draft**
   off to download CI artifacts only, or enable it to attach the checked assets
   to a draft prerelease. The workflow does not run on ordinary pushes or PRs.
4. Review the draft's files, notes, version and certificate. Test installation
   and a same-key upgrade that preserves Maps. Publish the draft in GitHub when ready.

The workflow targets the exact checked-out commit. Its draft uses
`native-v<version>`; GitHub creates the tag on publication if it does not exist.
An existing release is never overwritten. Updating an already published version
requires a new version/code and a fresh build.

For already checked local packages, an authenticated maintainer can create the
same draft without running CI again:

```powershell
$taskVersion = (Get-Content Native/VERSION.txt -Raw).Trim()
$taskDirectory = "temp/native-release-artifacts/OpenSlope-Native-$taskVersion"
$taskManifest = Get-Content "$taskDirectory/release-manifest.json" -Raw | ConvertFrom-Json
if ($taskManifest.schema -ne 'openslope-native-release/v2') { throw 'Download the complete assembled native-release-packages artifact; local Windows/Quest packages are only one release input.' }
$taskAssets = @(Get-ChildItem -LiteralPath $taskDirectory -File | ForEach-Object { $_.FullName })
gh release create "native-v$taskVersion" @taskAssets --target $taskManifest.source_commit --draft --prerelease --title "OpenSlope Native $taskVersion (preview)" --notes-file "$taskDirectory/RELEASE-NOTES.md"
```

See [GitHub's release CLI](https://cli.github.com/manual/gh_release_create) and
[managing releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository).
Creating a draft uploads those files to GitHub; the build/package script itself
does not upload, create tags, publish or install to the headset.

## Distribution checks

The packager takes only three named Windows executables and tracked notices plus
the distribution templates. It never copies the build tree, Maps, local test
launchers or screenshots. It checks x64 PE imports for unbundled DLL dependencies.
APK assets must exactly match the tracked notices; only the ARM64 player library
and Android application resources are admitted. Unexpected assets fail packaging.
Public mode rejects unsigned/debug APKs and uncommitted source. Package tests
exercise asset exclusion, stale notices, incorrect versions/architectures,
debug signing, hash verification and overwrite protection.

Release preparation is independent of the local Trailmap workspace and all other
ports' runtime implementations. No private media is required by the workflow.

## Linux and macOS packages

The **Native release packages** workflow builds Windows/Quest, Linux x64, macOS
arm64 and macOS x64 in separate jobs. Linux uses Ubuntu 22.04 to keep its minimum
glibc/libstdc++ requirements stable. Mac jobs use `macos-15` (Apple Silicon) and
`macos-15-intel`; each builds and tests its native architecture. All jobs must pass
before the assembly job creates the complete artifact or optional draft. The
assembly script rejects missing platforms, mixed versions/commits, dirty/preview
inputs, unexpected artifact names and modified download hashes. It writes a v2
manifest and a fresh `SHA256SUMS.txt` covering all five application downloads.

Native CI also builds the complete Linux/macOS player, runs conformance, exercises
the window/swapchain and empty library, and tests the SDL audio callback with a
dummy device. A separate Metal probe checks device availability, nonzero placement-heap
requirements and shared-buffer allocation. Some hosted virtual GPUs cannot provide
these resources. That specific condition skips graphics smoke in GitHub Actions and
is recorded in the manifest/release notes; application failures still fail the job.
Conformance, audio and package checks remain required on those hosts. The dummy device
verifies audio delivery without requiring a CI speaker; physical audio, GPU/driver
and desktop integration still need device tests.

For local Unix packaging, first build and test as described in Native/README.md,
then select the host platform:

```sh
python3 Native/tools/package_desktop.py --build temp/native-desktop --output temp/native-release-artifacts --platform linux-x64
# On an Apple Silicon Mac, use --platform macos-arm64; on Intel, macos-x64.
```

Public packages require clean committed source. `--preview` permits local dirty
source and labels the archive accordingly; the final release assembler rejects
these rehearsal packages. Package inputs are explicitly selected executables,
notices and templates. Linux verifies ELF architecture and dynamic dependencies;
tar preserves executable permissions. Mac verifies Mach-O architecture and library
paths, selects only the application executable, two tools, Info.plist and the
checksum-pinned MoltenVK runtime, then signs the resulting bundle before archiving.
The Mac archive uses Apple's `ditto` to retain permissions and ticket metadata;
the extracted download is checked again with `codesign` and, when notarized, `stapler`.
Build-tree maps and other local files are excluded. Unix Maps and cache data live
in user data directories, outside downloaded archives/application bundles.

## Optional Apple Developer ID signing and notarization

By default Mac previews use an ad-hoc signature. They are executable on supported
hardware but are **not Apple notarized** and can be blocked by Gatekeeper. This
status appears in each platform manifest and the assembled release notes. For
normal public installation, configure these Actions secrets:

| Secret | Purpose |
|---|---|
| `NATIVE_MACOS_CERTIFICATE_BASE64` | Base64-encoded Developer ID Application certificate and private key exported as `.p12`. |
| `NATIVE_MACOS_CERTIFICATE_PASSWORD` | Password protecting that export. |
| `NATIVE_MACOS_SIGN_IDENTITY` | Developer ID Application identity accepted by `codesign`. |
| `NATIVE_MACOS_NOTARY_APPLE_ID` | Apple account used for notarization. |
| `NATIVE_MACOS_NOTARY_TEAM_ID` | Apple Developer team ID. |
| `NATIVE_MACOS_NOTARY_PASSWORD` | App-specific password for that account. |

Signing credentials are imported into an ephemeral runner keychain and removed
after packaging. With the notarization credentials present, the packager submits
the signed bundle, requires Apple's Accepted result, staples and validates the
ticket, and verifies the complete signature. A configured signing/notarization
failure fails the job; it does not fall back to an ad-hoc package. Local packaging
uses `OPENSLOPE_MACOS_SIGN_IDENTITY` and optionally a preconfigured
`OPENSLOPE_MACOS_NOTARY_PROFILE` keychain profile for the same process.
See [Apple's notarization guide](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
