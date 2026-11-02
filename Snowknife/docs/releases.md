# Releasing Snowknife

The **Snowknife release packages** GitHub Actions workflow builds Windows x64, Linux x64,
macOS Intel and macOS Apple Silicon downloads. Each contains the .NET runtime, dependencies,
patch descriptors, license notices, `REPACK.md` and build metadata. Users extract the archive
and run `snowknife` from a terminal. The packages contain no game files.

## Build downloads

1. Commit the changes to `main`, including the pinned `SSX-Library` submodule revision.
2. Run the repository's `npm run verify` gate before preparing a release. Existing pre-push
   and CI checks still apply.
3. Open **Actions → Snowknife release packages → Run workflow**, selecting `main`.
4. Leave **Create a draft GitHub prerelease** unchecked for a build-only run. Download the
   platform archives and matching source from the run's artifacts; artifacts expire after 14 days.

Each platform runs the synthetic Snowknife suite, publishes an untrimmed self-contained build,
archives it, extracts the archive, and tests that extracted executable with `PATH` empty and
the .NET installation paths unavailable. The checks exercise help, embedded contract schemas,
Snowknife ZIP input and a synthetic PNG/SSH texture round trip from outside the source checkout.
Patch descriptors must match the checkout exactly. The workflow retains Snowknife's supported
`Debug` configuration; distribution packages do not require a `Release` build configuration.

## Publish a release

Increment [`Snowknife/VERSION.txt`](../VERSION.txt) to an unused `major.minor.patch` version and
merge it with the release's changes. Run the workflow on `main` with **Create a draft GitHub
prerelease** checked. After every platform succeeds, the workflow verifies the SHA-256 checksums
and creates `snowknife-v<version>` at that run's exact commit, with a draft prerelease and all
downloads attached. It refuses existing version tags and never overwrites release assets.

Review the draft and publish it in GitHub Releases when ready. It uses `latest=false` so Snowknife
does not replace the repository's Native download as the general Latest release. No publishing
secret is needed: only the final release job receives `contents: write` through `GITHUB_TOKEN`.
Build and source jobs have read-only repository permissions.

The source archive contains tracked repository sources **and the pinned format-library submodule**.
GitHub's automatic source archives omit that library's contents and do not replace this archive.
The included `SOURCE-README.txt` explains building the extracted source without Git metadata.
`SOURCE-REVISION.json`, each binary's `release.json`, NuGet metadata and checksums identify the
build inputs. Package license texts are copied from the restored packages; missing upstream MIT
notices are fetched at the immutable repository commit recorded in the package metadata. A missing
notice fails packaging. Dependencies and the bundled .NET runtime keep their license notices.

## Check packaging locally

From the repository root, with Python 3.13+ and the SDK from `global.json` installed:

```text
python -m unittest discover -s tools -p test_snowknife_release.py
python tools/snowknife-release.py package --runtime win-x64
python tools/snowknife-release.py source
```

Use the runtime matching the host: `win-x64`, `linux-x64`, `osx-x64` or `osx-arm64`. Downloads land
in `temp/snowknife-release/`. Existing archives are not overwritten. Packaging requires a clean
checkout and the pinned submodule. For a local development check, `--allow-dirty --output <new-folder>`
marks the package as an uncommitted validation build; the workflow never enables that option.

The Windows executable is unsigned and macOS builds are not notarized. Linux builds use glibc,
not Alpine's musl runtime. Other OS/architecture combinations are not currently packaged.
