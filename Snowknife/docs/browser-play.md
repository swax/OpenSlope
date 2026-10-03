# Import a course for browser play

Slopesmith reads Snowknife's imported map folders directly. **No glTF or Unity build is needed.**
Use a user-supplied SSX Tricky PS2 ISO that you are permitted to make and use; imported content stays
local and must not be committed or distributed through this project. See [LEGAL.md](../../LEGAL.md).

## Build once

Start with an OpenSlope checkout and Node.js 24, Git, and the .NET SDK selected by
[`global.json`](../../global.json). Run these commands from the **OpenSlope repository root**:

```powershell
git submodule update --init --recursive
dotnet --version
dotnet build Snowknife/Snowknife/Snowknife.csproj -c Debug
npm ci --prefix Slopesmith
```

If `dotnet --version` reports a missing SDK, install the version named in `global.json`; a different
.NET 10 feature band may not satisfy the pin. If the build cannot find SSX-Library, rerun the submodule
command. The CLI is built inside the checkout and does not need to be added to `PATH`.

## Import one course

The following PowerShell commands import Garibaldi. Replace the ISO path with your own; quotes preserve
spaces in it. Use a fresh output folder, or back up an existing map before importing over it.

```powershell
$iso = "path/to/ssx-tricky.iso"
$snowknife = "Snowknife/Snowknife/bin/Debug/net10.0/snowknife.dll"
dotnet $snowknife import $iso GARI Maps/GARI
```

Wait for a successful import before opening the course. The import includes intro music and course
sound effects. To add interactive race music and shared board/audio/particle assets, run:

```powershell
dotnet $snowknife race-music $iso GARI Maps/GARI
dotnet $snowknife shared $iso Maps/Shared
```

`shared` is needed only once for this map library. To import another course, replace both `GARI`
arguments with its slot, such as `SNOW` or `ALASKA`. `dotnet $snowknife help import` lists the supported
slots. If a stage fails, resolve the reported error and rerun that command; there is no need to build
glTF or repeat successful earlier commands.

## Open and ride

```powershell
npm --prefix Slopesmith run dev
```

Open the local URL printed by the server (normally `http://localhost:5179`). In **Scene ▸ Reference**,
choose **GARI** from the mountain picker and wait for loading to finish. Enter **Test**, select
**Reference** as the ride target, then click **Play**. See the [ride guide](../../Slopesmith/docs/016-ride.md)
for controls.

The default map library in this checkout is the root `Maps/` folder. If the course is missing, reload
the browser after importing and check the **Maps folder** in Settings if you previously changed it.
For later sessions, run only the dev command above; stop it with **Ctrl+C** in its terminal.
