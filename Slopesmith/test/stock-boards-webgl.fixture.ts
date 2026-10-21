import * as THREE from 'three';
import { createBoard } from '../src/app/ride/gear';
import { StockBoardSelection, STOCK_BOARD_DESIGNS } from '../src/core/equipment/stock-boards';
import { TestRide } from '../src/app/ride/session';
import { RIDER_LIGHT_SOURCE } from '../src/app/ride/rider-lighting';
import { createRiderPose } from '../src/app/ride/pose';

const check = (value: unknown, what: string) => {
  if (!value) throw new Error(what);
};
const delay = () => new Promise(resolve => setTimeout(resolve, 20));
try {
  document.body.style.cssText = 'margin:16px;background:#ddd;display:flex;gap:12px;font:14px sans-serif';
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(180, 600);
  renderer.setClearColor(0xdddddd);
  renderer.debug.onShaderError = () => {
    throw new Error('Stock board shader failed');
  };
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, Math.PI));
  const camera = new THREE.OrthographicCamera(-0.25, 0.25, 0.9, -0.9, 0.01, 10);
  camera.up.set(0, 0, 1);
  const waitMaps = async (board: ReturnType<typeof createBoard>, urlPart: string) => {
    const mesh = board.group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial[]>;
    const deadline = performance.now() + 10000;
    while (performance.now() < deadline) {
      const image = mesh.material[1].map?.image as HTMLImageElement | undefined;
      if (image?.src?.includes(urlPart)) return mesh.material;
      await delay();
    }
    throw new Error(`Board texture did not load: ${urlPart}`);
  };
  const signatures: number[] = [];
  for (const design of STOCK_BOARD_DESIGNS) {
    const choice = new StockBoardSelection(() => 0, design.id);
    const board = createBoard('snowboard', 'goofy', undefined, choice);
    scene.add(board.group);
    const materials = await waitMaps(board, design.id);
    check(materials[0].map!.channel === 1 && materials[1].map!.channel === 1, 'stock art uses sidecut UVs');
    const mesh = board.group.children[0] as THREE.Mesh;
    check(
      Array.from(mesh.geometry.getAttribute('uv1').array).every(v => Number.isFinite(v) && v >= 0 && v <= 1),
      'stock UVs stay within their panel',
    );
    check(materials[1].map!.repeat.x < 0 && materials[0].map!.repeat.x > 0, 'outward faces keep nose-up lettering');
    const column = document.createElement('div');
    document.body.append(column);
    const title = document.createElement('b');
    title.textContent = design.name;
    column.append(title);
    for (const side of [1, -1]) {
      camera.position.set(0, side * 2, 0);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      const pixels = new Uint8Array(180 * 600 * 4),
        gl = renderer.getContext();
      gl.readPixels(0, 0, 180, 600, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let signature = 2166136261;
      for (const value of pixels) signature = Math.imul(signature ^ value, 16777619) >>> 0;
      signatures.push(signature);
      const image = document.createElement('img');
      image.src = renderer.domElement.toDataURL();
      image.style.width = '120px';
      column.append(image);
    }
    // Use the avatar's actual course source, independent of the bright studio lamp.
    renderer.setClearColor(0);
    camera.position.set(0, 2, 0);
    camera.lookAt(0, 0, 0);
    const energy = () => {
      renderer.render(scene, camera);
      const pixels = new Uint8Array(40 * 150 * 4),
        gl = renderer.getContext();
      gl.readPixels(70, 220, 40, 150, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const sum = [0, 0, 0];
      for (let i = 0; i < pixels.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += pixels[i + c];
      return sum;
    };
    scene.userData[RIDER_LIGHT_SOURCE] = () => ({ ambient: [1, 1, 1], keys: [] });
    const full = energy();
    scene.userData[RIDER_LIGHT_SOURCE] = () => ({ ambient: [0.2, 0.2, 0.2], keys: [] });
    const shade = energy();
    check(
      shade.every((v, c) => Math.abs(v / full[c] - 0.2) < 0.025),
      `${design.id} gets avatar shade`,
    );
    scene.userData[RIDER_LIGHT_SOURCE] = () => ({
      ambient: [0.1, 0.2, 0.3],
      keys: [{ color: [0.7, 0, 0], direction: [0, 1, 0] }],
    });
    const facing = energy();
    check(
      facing[0] > full[0] * 0.75 && Math.abs(facing[1] / full[1] - 0.2) < 0.025,
      'topsheet receives upward key and coloured ambient',
    );
    board.group.rotation.z = Math.PI / 2;
    camera.position.set(-2, 0, 0);
    camera.lookAt(0, 0, 0);
    const rolled = energy();
    check(rolled[0] < full[0] * 0.15, 'held/rolled board normals follow their world pose');
    board.group.rotation.z = 0;
    camera.position.set(0, 2, 0);
    camera.lookAt(0, 0, 0);
    board.group.position.x = 10;
    camera.position.x = 10;
    camera.lookAt(10, 0, 0);
    scene.userData[RIDER_LIGHT_SOURCE] = (position: THREE.Vector3) => ({
      ambient: position.x > 5 ? [0.2, 0.2, 0.2] : [1, 1, 1],
      keys: [],
    });
    const moved = energy();
    check(
      moved.every((v, c) => Math.abs(v / full[c] - 0.2) < 0.025),
      'loose boards sample light at their own position',
    );
    board.group.position.x = 0;
    camera.position.set(0, 2, 0);
    camera.lookAt(0, 0, 0);
    board.setAppearance({ snowboardTextureUrl: '/equipment/boards/contour.png?custom=1', edgeColor: '#123456' });
    choice.renew();
    const custom = await waitMaps(board, 'custom=1');
    check(custom[0].map!.channel === 0 && custom[1].map!.channel === 0, 'account art retains plan UVs');
    check(custom[1].map!.repeat.x === 0.5 && custom[2].color.getHex() === 0x123456, 'custom account art/UV/edge wins');
    scene.userData[RIDER_LIGHT_SOURCE] = () => ({ ambient: [1, 1, 1], keys: [] });
    const customFull = energy();
    scene.userData[RIDER_LIGHT_SOURCE] = () => ({ ambient: [0.2, 0.2, 0.2], keys: [] });
    const customShade = energy();
    check(
      customShade.every((v, c) => Math.abs(v / customFull[c] - 0.2) < 0.025),
      'account art retains scene lighting after texture replacement',
    );
    delete scene.userData[RIDER_LIGHT_SOURCE];
    renderer.setClearColor(0xdddddd);
    board.setAppearance({});
    choice.renew();
    choice.renew();
    await waitMaps(board, choice.design.id);
    scene.remove(board.group);
    board.dispose();
  }
  check(new Set(signatures).size === 8, 'all four top/base designs actually render differently');

  // AI ski tinting clones the topsheet; its lighting hook must survive that clone.
  const skiScene = new THREE.Scene();
  const skis = createRiderPose({ scene: skiScene, riderModel: 'procedural', gear: 'skis', tint: 0xffffff });
  for (const child of skiScene.children) child.visible = child === skis.board;
  renderer.setClearColor(0);
  camera.position.set(0, 2, 0);
  camera.lookAt(0, 0, 0);
  const skiEnergy = (value: number) => {
    skiScene.userData[RIDER_LIGHT_SOURCE] = () => ({ ambient: [value, value, value], keys: [] });
    renderer.render(skiScene, camera);
    const pixels = new Uint8Array(180 * 600 * 4),
      gl = renderer.getContext();
    gl.readPixels(0, 0, 180, 600, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels.reduce((sum, v, index) => sum + (index % 4 === 3 ? 0 : v), 0);
  };
  const skiFull = skiEnergy(1),
    skiShade = skiEnergy(0.2);
  check(skiFull > 1000 && Math.abs(skiShade / skiFull - 0.2) < 0.025, 'AI topsheet clones retain gear lighting');
  skis.dispose();

  // Exercise the public ride lifecycle with its actual physics/pose owner.
  const choice = new StockBoardSelection(() => 0, 'timberline');
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial());
  floor.updateMatrixWorld(true);
  const container = document.createElement('div');
  document.body.append(container);
  const rideOpts = {
    spawn: new THREE.Vector3(),
    heading: new THREE.Vector3(0, 0, 1),
    terrain: floor,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    container,
    surfaceOf: () => 1,
    oobFloorY: -50,
    label: 'stock board regression',
    onExit: () => {},
    riderModel: 'procedural',
    stockBoard: choice,
  };
  const ride = new TestRide(rideOpts);
  ride.start();
  const initialDesign = choice.design.id;
  check(
    ride.playerPose().stockBoard === initialDesign && initialDesign !== 'timberline',
    'starting a course selects a fresh board',
  );
  ride.resetToCourse();
  ride.seatAt(new THREE.Vector3(2, 0, 2), new THREE.Vector3(0, 0, 1));
  ride.setSnowboardStance('standard');
  ride.setEquipmentAppearance({});
  check(ride.playerPose().stockBoard === initialDesign, 'respawn/reseat/stance/account updates retain board');
  choice.renew();
  check(
    ride.playerPose().stockBoard === choice.design.id && choice.design.id !== initialDesign,
    'new board reaches ride and network pose',
  );
  const beforeRestart = choice.design.id;
  ride.stop();
  ride.start();
  const restartedDesign = choice.design.id;
  check(
    restartedDesign !== beforeRestart && ride.playerPose().stockBoard === restartedDesign,
    'desktop Stop/Play selects another board',
  );
  ride.resetToCourse();
  check(ride.playerPose().stockBoard === restartedDesign, 'course recovery keeps the restarted board');
  ride.stop();
  const vrRide = new TestRide({ ...rideOpts, view: 'vr' });
  vrRide.start();
  vrRide.startRun();
  check(choice.design.id === restartedDesign, 'XR mounting keeps the board chosen by the session');
  vrRide.stop();
  document.documentElement.dataset.stockBoards = JSON.stringify({ ok: true, signatures });
} catch (error) {
  document.documentElement.dataset.stockBoards = JSON.stringify({ ok: false, error: String(error) });
}
