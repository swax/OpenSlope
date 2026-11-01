import * as THREE from 'three';
import { PropLibrary } from '../src/app/props/library';
import { ThumbRenderer } from '../src/app/props/thumb-renderer';
import type { LevelProps } from '../src/core/reference/props';

const geometry = new THREE.BoxGeometry(100, 100, 100);
let failNext = false;
let renderCanvas: HTMLCanvasElement;
let contextLoss: WEBGL_lose_context | null = null;
const render = ThumbRenderer.prototype.render;
ThumbRenderer.prototype.render = async function (...args) {
  renderCanvas = this.canvas;
  if (failNext) {
    failNext = false;
    throw new Error('Fixture render failure');
  }
  return render.apply(this, args);
};
const picked: number[] = [];
const library = new PropLibrary({
  levels: async () => ['TEST'],
  async loadLevel(level): Promise<LevelProps> {
    return {
      level,
      models:
        level === '@models'
          ? []
          : ['Textured crate', 'Solid marker', 'Missing texture', 'Another crate'].map((name, id) => ({
              id,
              name,
              subs: [
                {
                  mat: id === 1 ? -1 : id === 2 ? 1 : 0,
                  positions: geometry.getAttribute('position').array as Float32Array,
                  uvs: geometry.getAttribute('uv').array as Float32Array,
                  indices: new Uint32Array(geometry.index!.array),
                },
              ],
            })),
      materials: new Map([
        [0, { tex: 'crate.png', frames: [] }],
        [1, { tex: 'missing.png', frames: [] }],
      ]),
      instances: [],
      crowdFrames: [],
    };
  },
  groups: async level => [
    {
      id: 'pair',
      level,
      name: 'Crate pair',
      props: [
        { model: 0, name: 'Crate', relPos: [0, 0, 0], relYaw: 0 },
        { model: 3, name: 'Crate', relPos: [1.5, 0, 0], relYaw: 25 },
      ],
      lights: [],
      occurrences: 2,
    },
  ],
  onPick(_level, model) {
    picked.push(model);
  },
  onPickGroup() {},
});
library.el.style.cssText = 'width:780px;height:300px;flex-direction:column';
await library.init('TEST');
library.show();

window.propThumbnails = {
  picked,
  refresh(fail = false) {
    failNext = fail;
    library.invalidateThumbnails();
  },
  async loseContext() {
    const canvas = renderCanvas;
    contextLoss = canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context');
    if (!contextLoss) throw new Error('No context-loss extension');
    const lost = new Promise<void>(resolve =>
      canvas.addEventListener('webglcontextlost', () => resolve(), { once: true }),
    );
    contextLoss.loseContext();
    await lost;
    library.invalidateThumbnails();
  },
  restoreContext() {
    contextLoss!.restoreContext();
  },
};
declare global {
  interface Window {
    propThumbnails: {
      picked: number[];
      refresh(fail?: boolean): void;
      loseContext(): Promise<void>;
      restoreContext(): void;
    };
  }
}
