# 074 — Local development

Install Node.js 24 and run these commands from `Slopesmith/`:

```powershell
npm ci
npm run dev
```

Open `http://localhost:5179`. The API starts on a free port behind Vite's `/api` proxy.
The editor and API bind to loopback by default. The API has owner-level access to local maps
and projects. For an isolated trusted LAN, `npm run dev -- --host --unsafe-open-network`
explicitly permits that access for everyone who can reach it. Use the
[production deployment guide](041-production-deployment.md) for a persistent shared server.

## Choose a command

```powershell
npm run serve     # API only, on http://127.0.0.1:5180
npm test                  # fast edit-time checks
npm run test:integration  # server, socket, browser, and CPU-heavy checks
npm run test:dom          # UI/storage behavior in Node, without Vite or Chrome
npm run test:api          # actual HTTP service checks without a browser
npm run test:browser      # small native-browser smoke lane
npm run test:node         # complete Node/DOM/API lane
npm run test:browser:full # on-demand browser diagnostics, without c8; accepts -- --only <file-or-area>
npm run test:full         # on-demand diagnostics: every check under test/
npm run test:local        # diagnostics plus checks that read extracted Maps/ data
npm run test:ci           # complete Node/DOM/API lane and browser smoke
npm run typecheck # strict TypeScript check
npm run lint      # ESLint over src, test, scripts, and tools; the gate requires zero findings
npm run check     # typecheck, lint, fast tests
npm run check:smoke # check plus the small browser lane
npm run build     # production browser and server builds
npm run smoke     # default mountain -> export -> real Snowknife glTF -> verify GLB
```

Choose checks for the changed behavior using the [repository tools guide](../../tools/README.md#everyday-validation).
A documentation edit needs whitespace and link checks; the complete repository gate is reserved
for the cases in [CONTRIBUTING.md](../../CONTRIBUTING.md#complete-verification).

## Formatting

[`Slopesmith/.prettierrc.json`](../.prettierrc.json) defines the source style: two spaces, single quotes,
semicolons, and a 120-column wrapping target. Prettier is pinned in `devDependencies` and installed by
`npm ci` in `Slopesmith/`; no global formatter is needed. Run from the repository root:

```text
npm run format:slopesmith        # apply formatting
npm run format:slopesmith:check  # check without writing; exits nonzero on differences
```

Inside `Slopesmith/`, the equivalent commands are `npm run format` and `npm run format:check`.
They cover hand-written TypeScript, JavaScript, CSS, and HTML in `src/`, `test/`, `scripts/`, `tools/`,
and the top-level configuration and entry point, plus Rust sources in `multiplayer/` through `cargo fmt`.
Rust formatting requires Cargo with the rustfmt component (`rustup component add rustfmt`) and uses
rustfmt's default rules. Generated contracts, vendored code, upstream patches,
build output, and local map/workspace data are excluded by [`.prettierignore`](../.prettierignore).
Line endings match [`.gitattributes`](../../.gitattributes): LF for scripts and CRLF for CSS.
Embedded languages in template strings are left intact. Prettier runs as an explicit local command;
CI also checks Rust formatting with `cargo fmt --check`. ESLint and Clippy remain separate correctness checks.

## Rebuild the browser importer

Ordinary builds use the checked-in browser importer and need no native toolchain.
After changing the Native import code, activate Emscripten **6.0.12**, set `EMSDK`, and run
`npm run build:iso-importer` from `Slopesmith/`. The build copies JavaScript, WebAssembly and
dependency notices into `public/iso-importer/`.

`test/public-home.test.ts` covers publication, guest isolation, riding, chat, member multiplayer,
and a synthetic ISO extraction/cache reload without retail data.

## Import an existing mod ZIP

SSX Mod Manager loose-level ZIPs can be converted into a portable map folder for Slopesmith references
when Snowknife and a clean Tricky disc dump are available in the surrounding OpenSlope checkout:

```powershell
npm run import:mod-map -- "C:\Mods\My Course.zip" "C:\discs\ssx-tricky.iso" ALOHA MY_COURSE
```

The command infers the replaced course slot from `DATA/MODELS/<slot>.map`, rebuilds the native level archive
inside a temporary copy of the ISO, and publishes the completed folder beneath the configured Maps root. It
never writes to the supplied ISO and refuses to overwrite an existing map. Run
`npm run import:mod-map -- help` for destination, override, environment-variable, and diagnostic-workspace
options. Older mods are handled conservatively: missing optional MAP labels are repaired only in temporary
data, dangling effect-node targets are audited and replaced with the SSF format's native null value so valid
effects survive, structurally corrupt SSFs are reported and omitted as `Effects.json`, and a non-retail sky is
kept as merged geometry even when it cannot provide editable ring metadata.

## Optional native retopology

**QuadWild — native global solver** is not bundled. Install the patched checkout at
`../quadwild-bimdf/` relative to `Slopesmith/` using the
[QuadWild setup guide](../tools/retopology/quadwild-patches/README.md).
Without it, choose the built-in **Elevation loops — contour flow** strategy explicitly.

## Source and automation

- [Source layout](024-source-layout.md) describes module ownership and dependency boundaries.
- [Offline tools](../tools/README.md) covers authoring studies, recipes and generators.
- [HATEOAS API](052-hateoas-api.md) documents `GET /api`, personal access keys, `/api/explorer`,
  and the `scripts/hateoas-demo.ts` example.
- [Multiplayer setup](../multiplayer/README.md) covers the Rust service, tests and deployment.

## Access a local server from Quest or mobile

Use the account-enabled launcher when a standalone Quest, phone, or tablet needs to reach a Slopesmith instance
running on this computer. Install and authenticate the [ngrok agent](https://ngrok.com/docs/start).
From `Slopesmith/`, copy `.env.example` to the gitignored `.env` and give the editor endpoint an exact hostname:

```powershell
Copy-Item .env.example .env
# Edit .env: SLOPESMITH_ALLOWED_HOSTS is a hostname; SLOPESMITH_LOCAL_SERVER_NGROK_URL is its https:// URL.
npm run run:local-server
# In a second terminal:
npm run run:local-server:ngrok
```

`run:local-server` builds and starts Rust multiplayer alongside the account-enabled Node API and Vite,
configuring their shared secret and relay routing automatically. Rust 1.99+ is required. The same ngrok
tunnel carries multiplayer WebSockets; no second multiplayer tunnel is needed.

Open `SLOPESMITH_LOCAL_SERVER_NGROK_URL` on the remote device. This launcher requires Slopesmith accounts and
trusts ngrok's forwarded HTTPS metadata; do not expose the ordinary unauthenticated `npm run dev` process.
Name only endpoints you control in `SLOPESMITH_ALLOWED_HOSTS` and stop the tunnel when the session is over.

Reaching an optional local media server from a remote device needs a second, distinct endpoint of its own; the
[Jukebox guide](063-video-bridge.md#reaching-a-local-server-from-quest-or-mobile) covers that case.
