import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const output = join(root, 'dist');
const origin = 'https://slopesmith.com';
const repository = 'https://github.com/swax/OpenSlope';

export const pages = [
  { file: 'home.html', path: '/', title: 'Slopesmith — SSX Tricky Map Editor & Course Builder', description: 'Build and ride SSX Tricky-compatible snowboard courses with Slopesmith, an open-source browser editor. Shape terrain, collaborate, and export your own maps.' },
  { file: 'getting-started.html', path: '/guides/getting-started/', title: 'Getting Started with SSX Tricky Map Editing | Slopesmith', description: 'Set up Slopesmith locally, shape your first original snowboard course, and test-ride it in the browser. A practical guide to getting started with map editing.' },
  { file: 'exporting.html', path: '/guides/exporting-to-pcsx2/', title: 'Export a Custom SSX Tricky Course for PCSX2 | Slopesmith', description: 'Take a Slopesmith mountain through map export, Snowknife preflight, and a private SSX Tricky PS2 repack for testing in PCSX2.' },
  { file: 'editor-tour.html', path: '/guides/editor-tour/', title: 'Slopesmith Editor Tour — Course, Props, Effects & Test Mode', description: 'Explore the Slopesmith interface with screenshots: find the mode bar, define a course, place custom props, inspect effects, and test-ride your mountain.' },
  { file: 'terrain.html', path: '/guides/terrain-and-trails/', title: 'Build Terrain & Bézier Trails in Slopesmith | SSX Tricky Map Editing', description: 'An illustrated guide to Slopesmith terrain: patches, edge loops, control cages, trail junctions, terrain integration, and predicted speed.' },
  { file: 'materials.html', path: '/guides/textures-and-surfaces/', title: 'Textures, Palettes & Ride Surfaces in Slopesmith', description: 'Learn how to select and paint terrain tiles, arrange texture palettes, inspect surface types, and test the way your Slopesmith course rides.' },
];

const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

function layout(page, content) {
  const guide = page.path.startsWith('/guides/');
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': guide ? 'TechArticle' : 'WebSite',
    name: page.title,
    description: page.description,
    url: origin + page.path,
    inLanguage: 'en',
    ...(guide ? { isPartOf: { '@type': 'WebSite', name: 'Slopesmith', url: origin } } : {}),
  };
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0c171e">
  <title>${escape(page.title)}</title>
  <meta name="description" content="${escape(page.description)}">
  <link rel="canonical" href="${origin}${page.path}">
  <meta property="og:type" content="${guide ? 'article' : 'website'}">
  <meta property="og:site_name" content="Slopesmith">
  <meta property="og:title" content="${escape(page.title)}">
  <meta property="og:description" content="${escape(page.description)}">
  <meta property="og:url" content="${origin}${page.path}">
  <link rel="icon" href="/assets/favicon.ico" sizes="any">
  <link rel="icon" href="/assets/slopesmith-icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/styles.css">
  <script type="application/ld+json">${JSON.stringify(structuredData).replaceAll('<', '\\u003c')}</script>
  <script src="/site.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="/" aria-label="Slopesmith home"><img src="/assets/slopesmith-icon.svg" width="40" height="40" alt=""><span>slopesmith<span class="brand-period">.</span></span></a>
      <button class="menu-toggle" aria-controls="site-nav" aria-expanded="false" hidden>Menu</button>
      <nav class="nav-links" id="site-nav" aria-label="Main navigation">
        <a href="/guides/editor-tour/"${page.path === '/guides/editor-tour/' ? ' aria-current="page"' : ''}>Editor tour</a>
        <a href="/#guides"${guide ? ' class="nav-active"' : ''}>Guides</a>
        <a href="/#development">Making Slopesmith</a>
        <a href="${repository}">GitHub</a>
        <a class="button button-small" href="/guides/getting-started/">Start building</a>
      </nav>
    </div>
  </header>
  <main id="main">${content}</main>
  <dialog class="image-dialog" aria-labelledby="image-dialog-title">
    <div class="image-dialog-bar"><h2 id="image-dialog-title">Screenshot</h2><button class="dialog-close" type="button" autofocus>Close image</button></div>
    <img class="image-dialog-content" alt="">
    <div class="image-dialog-footer"><p id="image-dialog-caption"></p><a class="image-original" target="_blank" rel="noopener">Open full-resolution image</a></div>
  </dialog>
  <footer class="site-footer">
    <div class="container footer-top">
      <div><a class="brand" href="/"><img src="/assets/slopesmith-icon.svg" width="34" height="34" alt=""><span>slopesmith<span class="brand-period">.</span></span></a><p>A mountain is only the beginning.</p></div>
      <nav aria-label="Footer navigation"><a href="/guides/getting-started/">Get started</a><a href="${repository}">Source code</a><a href="https://discord.gg/QFnt2x9vZ9">Discord</a><a href="${repository}/blob/main/LEGAL.md">Project &amp; legal</a></nav>
    </div>
    <div class="container footer-bottom"><span>Built with OpenSlope. Made for course creators.</span><span>Independent and unofficial. Not affiliated with EA. No retail game content included.</span></div>
  </footer>
</body>
</html>`;
}

export async function build() {
  const media = JSON.parse(await readFile(join(root, 'media.json'), 'utf8'));
  const captions = JSON.parse(await readFile(join(root, 'image-captions.json'), 'utf8'));
  await mkdir(join(output, 'assets'), { recursive: true });
  await cp(join(root, 'public'), output, { recursive: true });
  for (const name of ['slopesmith-authoring.png', 'slopesmith-riding.png']) {
    await copyFile(join(root, '..', 'Slopesmith', 'media', name), join(output, 'assets', name));
  }
  await copyFile(join(root, '..', 'Slopesmith', 'public', 'slopesmith_icon_light.svg'), join(output, 'assets', 'slopesmith-icon.svg'));
  await copyFile(join(root, '..', 'Slopesmith', 'public', 'favicon.ico'), join(output, 'assets', 'favicon.ico'));
  const built = [];
  for (const page of pages) {
    const source = await readFile(join(root, 'src', page.file), 'utf8');
    const content = source.replace(/\{\{(figure|image):([a-z0-9-]+)\}\}/g, (_, kind, slug) => {
      const image = media[slug];
      const caption = captions[slug];
      if (!image || !caption) throw new Error(`Missing screenshot or caption: ${slug}`);
      const full = `/assets/editor/${slug}.webp`;
      const picture = `<img src="/assets/editor/${slug}-preview.webp" width="${image.previewWidth}" height="${image.previewHeight}" alt="${escape(caption.alt)}" loading="lazy" decoding="async">`;
      if (kind === 'image') return picture;
      return `<figure class="doc-figure"><a class="screenshot-link" href="${full}" data-lightbox data-caption="${escape(caption.caption)}" aria-label="Enlarge screenshot: ${escape(caption.alt)}">${picture}<span class="image-expand" aria-hidden="true">Enlarge</span></a><figcaption>${escape(caption.caption)}</figcaption></figure>`;
    });
    const directory = join(output, page.path);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'index.html'), layout(page, content));
    built.push(origin + page.path);
  }
  await writeFile(join(output, '404.html'), layout({ path: '/404.html', title: 'Page not found | Slopesmith', description: 'Find your way back to Slopesmith.' }, '<section class="container not-found"><p class="eyebrow">Off the trail · 404</p><h1>Let’s find your line.</h1><p>This page doesn’t exist. Head back to the editor overview or start with a field guide.</p><a class="button" href="/">Back to Slopesmith</a></section>'));
  await writeFile(join(output, '.nojekyll'), '');
  await writeFile(join(output, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
  await writeFile(join(output, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${built.map(url => `  <url><loc>${url}</loc></url>`).join('\n')}\n</urlset>\n`);
  console.log(`Built ${built.length} pages in website/dist`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build();
