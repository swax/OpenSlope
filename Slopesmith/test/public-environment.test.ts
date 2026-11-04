import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { blankMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { DEFAULT_SUN } from '../src/core/doc/types';
import { createFogVolume } from '../src/core/particles/volumes';
import { retailExtractOrigin } from '../src/core/export/origin';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';
import { createProject } from '../src/server/projects';
import { setPublished } from '../src/server/public-courses';
import { encodePng } from '../src/server/routes/png';
import type { PublicCourse } from '../src/core/session/public-courses';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-public-environment-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
forgetWorkspaceConfig();
forgetAccounts();
const donor = join(root, 'Maps', 'GARI');
mkdirSync(join(donor, 'Textures', 'Particles'), { recursive: true });
writeFileSync(join(donor, 'Patches.json'), JSON.stringify({ Patches: [] }));
writeFileSync(join(donor, 'Origin.json'), JSON.stringify(retailExtractOrigin('GARI')));
for (const name of ['Models', 'Materials', 'Instances'])
  writeFileSync(join(donor, name + '.json'), JSON.stringify({ [name]: [] }));
const sprite = encodePng({ w: 1, h: 1, data: new Uint8Array([255, 255, 255, 255]) });
writeFileSync(join(donor, 'Textures', 'Particles', 'fog0.png'), sprite);
writeFileSync(join(donor, 'Textures', 'tile.png'), sprite);
const document = blankMountain('ENVIRONMENT');
document.vertices = [0, 0, 0, 20, 0, 0, 0, 0, 20, 20, 0, 20];
document.quads = [[2, 3, 0, 1]];
document.quadTex = { 0: 'Custom/white.png' };
Object.assign(document, appendMeshIds(document, 4, 1));
document.sun = { ...DEFAULT_SUN, on: true, ambient: 0.1, sun: 0, ao: 0, shadow: 0, skyTint: '#ffffff' };
document.lights = [{ id: 'light:0', kind: 'point', pos: [10, 5, 10], color: '#ff0000', intensity: 6, reach: 30 }];
document.models = [
  {
    id: 'model:0000',
    name: 'Billboard',
    anchor: [0, 0, 0],
    vertices: [-1, 0, 0, 1, 0, 0, -1, 2, 0, 1, 2, 0],
    quads: [[0, 1, 2, 3]],
  },
];
document.props = [
  { id: 'prop:sign', level: '@models', model: 0, name: 'Mdl_Billboard_fixture', pos: [1000, 0, 0], yaw: 0, scale: 1 },
  {
    id: 'prop:group',
    level: '@models',
    model: 0,
    name: 'Lamp assembly',
    pos: [1000, 0, 0],
    yaw: 0,
    scale: 1,
    group: 'lamp',
    groupDefinition: {
      id: 'lamp',
      name: 'Lamp',
      level: '@models',
      occurrences: 1,
      props: [{ model: 0, name: 'Lamp', relPos: [0, 0, 0], relYaw: 0 }],
      lights: [
        {
          name: 'Lamp',
          kind: 'point',
          relPos: [0, 5, 0],
          dir: [0, -1, 0],
          color: '#0000ff',
          intensity: 1,
          reach: 4,
          coneCos: 1,
        },
      ],
    },
  },
];
document.particleVolumes = [createFogVolume([10, 5, 10])];
document.particleVolumes[0].objects[0].puffs = [{ position: [0, 0, 0], scale: [1, 1, 1], radius: 500 }];
const privateMap = await createProject(document, undefined, false);
mkdirSync(join(privateMap.project.folder, 'assets', 'textures'), { recursive: true });
writeFileSync(join(privateMap.project.folder, 'assets', 'textures', 'white.png'), sprite);
const publicDocument = structuredClone(document);
publicDocument.name = 'CUSTOM_FOG';
publicDocument.particleVolumes![0].texture = 'Custom/mist.png';
const publicMap = await createProject(publicDocument, undefined, false);
mkdirSync(join(publicMap.project.folder, 'assets', 'textures'), { recursive: true });
writeFileSync(join(publicMap.project.folder, 'assets', 'textures', 'mist.png'), sprite);
writeFileSync(join(publicMap.project.folder, 'assets', 'textures', 'white.png'), sprite);
await setPublished('project', publicMap.project.id, true, { id: 'owner', role: 'admin' });
const api = await startApiService({ host: '127.0.0.1', port: 0 });
process.env.PORT = String(api.port);
const vite = await createServer({
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
  plugins: [
    {
      name: 'public-environment-fixture',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== '/environment.html') return next();
          res.setHeader('content-type', 'text/html');
          res.end(
            '<!doctype html><style>html,body,#view{margin:0;width:100%;height:100%}</style><div id="view"></div><script type="module" src="/test/public-environment.fixture.ts"></script>',
          );
        });
      },
    },
  ],
});
await vite.listen();
const browser = await chromium.launch({
  executablePath: chromiumExecutable(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  for (const [snapshot, privateCourse] of [
    [privateMap, true],
    [publicMap, false],
  ] as const) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (
        response.status() >= 400 &&
        /\/api\/(?:texture\?|map-asset-|particle-texture\?name=fog0)/.test(response.url())
      )
        errors.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(vite.resolvedUrls!.local[0] + 'environment.html');
    await page.waitForFunction(() => !!window.checkPublicEnvironment);
    const course: PublicCourse = {
      kind: 'project',
      id: snapshot.project.id,
      name: snapshot.project.name,
      isoCourses: [],
      retailData: privateCourse,
      ...(privateCourse ? { private: true } : {}),
    };
    const result = (await page.evaluate(course => window.checkPublicEnvironment(course), course)) as {
      lights: number;
      lit: number[];
      unlit: number[];
      fogged: number[];
      fog: { instances: number; width: number; missing: boolean };
      markers: boolean;
      bounds: boolean;
    };
    assert.equal(result.lights, 3, 'free, derived sign and assembly lights reach the player rig');
    assert(result.lit[0] > result.unlit[0] + 20, `custom light reaches the framebuffer: ${JSON.stringify(result)}`);
    assert(result.lit[0] > result.lit[1] + 20, 'the light retains its authored red color');
    assert(result.fogged[1] > result.unlit[1] + 20, 'fog changes the framebuffer over the terrain');
    assert.deepEqual(result.fog, { instances: 1, width: 1, missing: false });
    assert.equal(result.markers, false, 'riding does not expose light editing handles');
    assert.equal(result.bounds, false, 'riding does not expose fog editing bounds');
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'PASS: private legacy fog and public custom fog render with authored free/sign/group lighting in the player.',
  );
} finally {
  await browser.close();
  await vite.close();
  await api.close();
}
