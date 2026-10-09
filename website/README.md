# Slopesmith website

Static public website and illustrated handbook for Slopesmith: a homepage, getting started,
an editor tour, terrain and trails, textures and surfaces, and PCSX2 export.
The site builds to normal HTML, CSS, and JavaScript with no npm dependencies, external fonts,
or analytics. The development montage loads a YouTube embed only when a visitor clicks its
load button. The editor itself is a separate application.

## Preview locally

From the OpenSlope repository root, with Node.js 24 installed:

```powershell
npm --prefix website run dev
```

Open **http://localhost:4173**. The preview binds only to this computer. Source changes rebuild the
pages automatically; refresh the browser to see them. Stop the server with Ctrl+C.

If that port is occupied:

```powershell
npm --prefix website run dev -- --port 4174
```

No `npm install` is needed. This preview does not start the Slopesmith editor.

## Edit the website

- `src/home.html`: homepage content.
- `src/getting-started.html`: local setup and first-course guide.
- `src/editor-tour.html`: workspace, camera, course lines, props, effects, and testing.
- `src/terrain.html`: patches, edge loops, cages, trails, and speed profiles.
- `src/materials.html`: painting textures and assigning ride surfaces.
- `src/exporting.html`: export and private PS2 repack guide.
- `public/styles.css`: shared layout, colors, typography, and responsive rules.
- `public/site.js`: navigation, screenshot switching/enlargement, command copying, and the video embed.
- `public/assets/editor/`: optimized WebP screenshots and smaller page previews.
- `media.json`: screenshot dimensions and original filenames.
- `image-captions.json`: screenshot alt text and explanatory captions.
- `scripts/build.mjs`: page metadata, shared navigation/footer, sitemap, and static output.
- `scripts/serve.mjs`: local preview server.

Changes to the build or server scripts require restarting the preview. Changes under `src/` and
`public/`, as well as the two image metadata files, rebuild automatically. The build copies the
existing Slopesmith screenshots and icons from their tracked locations. The 19 additional screenshots
provided for the handbook are stored here as WebP assets; building does not depend on the original
Desktop folder. Each has a smaller `-preview.webp` for pages and a full-resolution `.webp` for enlargement.

Use `{{figure:image-slug}}` in a page to insert an expandable screenshot and caption, or
`{{image:image-slug}}` for just the preview image. Add its dimensions and caption to the metadata files.

## Build for hosting

```powershell
npm --prefix website run build
```

Publish only `website/dist/`. It includes all six pages, styles, scripts, images, a custom 404,
`robots.txt`, `sitemap.xml`, and `.nojekyll`. Generated output is gitignored. URLs assume the domain
root, such as `https://slopesmith.com/`; a GitHub project subpath needs a base-path adjustment.

Canonical URLs, sitemap entries, and structured data currently target `https://slopesmith.com`.
Change the `origin` constant in `scripts/build.mjs` if the primary domain changes.

`.github/workflows/website.yml` builds and publishes `website/dist/` to GitHub Pages when the
website or shared media changes on `main`. Pull requests build without deploying. You can also
run **Publish Slopesmith website** manually in Actions. No separate website branch is needed.

The repository's Pages source is **GitHub Actions**, with **slopesmith.com** as the custom domain.
Namecheap manages DNS; `www` points to `swax.github.io` and redirects to the primary domain through
Pages. Domain verification TXT records should remain in DNS. `slopesmith.net` is not configured by
this deployment. The local build and preview scripts do not change DNS or publish anything.

## Content sources

Keep the public workflow consistent with the repository's root and Slopesmith READMEs,
`Snowknife/docs/browser-play.md`, and `Snowknife/REPACK.md`. Original authoring and browser riding
need no game disc; disc-backed importing and repacking require a user-supplied permitted image.
The browser runtime does not include SSX Tricky's original characters or trick system.
The illustrated guides also reference the feature documents in `Slopesmith/docs/`. Some screenshots
show earlier interfaces or locally imported assets; their captions explain that context. The Maya
image is development research, not part of the Slopesmith workflow. The video is a development
montage, not a tutorial: https://www.youtube.com/watch?v=xKN78hJIUl4.
