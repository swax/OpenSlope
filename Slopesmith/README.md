# Slopesmith

**Build and ride snowboard courses in your browser.** Slopesmith is OpenSlope's editor: shape
terrain, paint surfaces, add props and rails, then test-ride in the same window. It works on
desktop, mobile and standalone WebXR headsets, with shared editing and riding on a hosted server.
Original course authoring needs no disc image or separate modeling tool.

[Open Slopesmith](https://slopesmith.net) · [Documentation](docs/README.md)

## Run locally

Install Node.js 24, then run these commands from the OpenSlope repository root:

```powershell
cd Slopesmith
npm ci
npm run dev
```

Open `http://localhost:5179`. Keep this development server on your own machine; it can read and
write local projects and maps. For shared access, follow the [hosting guides](docs/README.md#hosting-and-collaboration).

## Make your first course

1. In the library, choose **New map**, name your mountain, and choose **Generated course** to start with terrain.
2. Use **Edit** to reshape it, **Sculpt** for terrain brushes, **Paint** for surfaces, and **Props** for scenery and rails.
3. Switch to **Test** and choose **Play** to ride. See the [riding guide](docs/016-ride.md) for controls and VR.
4. Use **Save to folder…** or **File → Export… → Another Slopesmith instance** to keep an editable backup.
5. To build a custom disc or mod, choose **File → Export… → Snowknife — Custom ISO** or
   **Snowknife — Mod Manager**, then follow [Snowknife's repack guide](../Snowknife/REPACK.md).

Browser saves stay with this browser profile and site address. Server maps save on the server.
The [library and offline guide](docs/073-map-library-and-offline.md) explains storage, backups,
loading your own game images, sharing maps and offline use.

## Go further

| Task | Guide |
|---|---|
| Learn the editor | [Getting started](https://slopesmith.net/guides/getting-started/) and [editor tour](https://slopesmith.net/guides/editor-tour/) |
| Build an original course | [Course authoring](docs/authoring/README.md) |
| Inspect an imported map | [References and browser play](../Snowknife/docs/browser-play.md) |
| Export to Unity or PS2 | [Export preflight](docs/011-export-target.md) and [portable map contract](docs/003-export-contract.md) |
| Host a private server | [Production deployment](docs/041-production-deployment.md) and [packaged releases](docs/060-packaged-deployment.md) |
| Develop or automate Slopesmith | [Local development](docs/074-development.md), [API](docs/052-hateoas-api.md) and [source layout](docs/024-source-layout.md) |

The [documentation index](docs/README.md) covers terrain tools, scene content, audio, collaboration and implementation details.

## Content and license

No game assets are included. Keep disc-derived maps and assets local/private; see
[LEGAL.md](../LEGAL.md). Public Unity projects use authored or rights-cleared assets and
`snowknife unity --public`.

Slopesmith is independent and unofficial. It is licensed under [Apache-2.0](LICENSE);
see [NOTICE](NOTICE). The optional [QuadWild patches](tools/retopology/quadwild-patches/README.md)
have their own scoped licensing terms.
