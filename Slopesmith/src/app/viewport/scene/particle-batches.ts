import * as THREE from 'three';

/**
 * The draw batches every SSF timer emitter's preview particles land in.
 *
 * A layer's blend state is chosen per DRAW CALL, not per vertex, so the authored `U50` selector cannot ride in
 * the vertex stream the way colour, size and sprite do. The caller packs additive sprites at the front and
 * alpha-blended/darkening ones behind them. Additive instances read that prefix directly; the alpha suffix is
 * copied into its own instance buffer because WebGL has no base-instance draw. Camera-facing quads preserve
 * world size in each XR eye and allow large fog sprites to exceed the hardware's point-size limit.
 *
 * The darkening batch is what puts Snowdream's road-flare smoke on screen. That plume is authored near-black at
 * alpha 0.08 with the framebuffer-darkening selector [Trailmap: 180-particles-data]; drawn additively it adds
 * essentially nothing to the frame, which is exactly how it went missing.
 */
export interface ParticleBatches {
  /** Additive sprites — sparks, flames, snow. */
  additiveMesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  /** Alpha-blended and darkening sprites, drawn after the additive ones so a plume darkens the glow it hangs
   *  in front of rather than the reverse. */
  alphaMesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  /** Per-particle arrays, written directly by the caller's per-frame packer. Sizes are world-space widths. */
  buffers: {
    position: Float32Array;
    color: Float32Array;
    alpha: Float32Array;
    size: Float32Array;
    sprite: Float32Array;
  };
  /** Publish this frame's packing: `additiveCount` sprites from index 0, then `alphaCount` behind them. */
  setDrawRanges(additiveCount: number, alphaCount: number): void;
  /** Release the two draw geometries and materials; the caller retains ownership of the atlas texture. */
  dispose(): void;
}

const VERTEX_SHADER = `
  attribute vec3 particlePosition;
  attribute vec3 particleColor;
  attribute float particleAlpha;
  attribute float particleSize;
  attribute float particleSprite;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSprite;
  varying vec2 vUv;
  uniform float halfViewportHeight;
  void main() {
    vColor = particleColor;
    vAlpha = particleAlpha;
    vSprite = particleSprite;
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(particlePosition, 1.0);
    // Expand in each eye's view space, keeping the authored world width. Only the former one-pixel minimum
    // depends on the viewport; it is read at draw time from this eye, never from the combined XR framebuffer.
    bool perspective = projectionMatrix[2][3] == -1.0;
    float depth = perspective ? max(0.1, -mvPosition.z) : 1.0;
    float pixelWidth = depth / max(0.0001, abs(projectionMatrix[1][1]) * halfViewportHeight);
    mvPosition.xy += position.xy * max(particleSize, pixelWidth);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = `
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSprite;
  varying vec2 vUv;
  uniform sampler2D particleAtlas;
  uniform vec2 particleAtlasGrid;
  void main() {
    float sprite = clamp(floor(vSprite + 0.5), 0.0, particleAtlasGrid.x * particleAtlasGrid.y - 1.0);
    vec2 cell = vec2(mod(sprite, particleAtlasGrid.x), floor(sprite / particleAtlasGrid.x));
    vec2 uv = (cell + vUv) / particleAtlasGrid;
    vec4 texel = texture2D(particleAtlas, uv);
    if (texel.a <= 0.001) discard;
    gl_FragColor = vec4(texel.rgb * vColor, texel.a * vAlpha);
  }
`;

/** Build both billboard batches over `capacity` sprite slots, sampling a `columns` x `rows` atlas. */
export function createParticleBatches(atlas: THREE.Texture, columns: number, rows: number,
  capacity: number): ParticleBatches {
  const makeBuffers = () => ({
    position: new Float32Array(capacity * 3),
    color: new Float32Array(capacity * 3),
    alpha: new Float32Array(capacity),
    size: new Float32Array(capacity),
    sprite: new Float32Array(capacity),
  });
  const buffers = makeBuffers();
  const alphaBuffers = makeBuffers();
  const uniforms = {
    halfViewportHeight: { value: 500 },
    particleAtlas: { value: atlas },
    particleAtlasGrid: { value: new THREE.Vector2(columns, rows) },
  };
  // One program, one uniform block, two blend states. A darkening particle reaches the alpha material with its
  // RGB already zeroed by the packer, so `src*a + dst*(1-a)` collapses to exactly the engine's multiply toward
  // black — colour ignored, alpha alone deciding how far the framebuffer darkens.
  const shared = {
    uniforms, vertexShader: VERTEX_SHADER, fragmentShader: FRAGMENT_SHADER,
    transparent: true, depthWrite: false,
    // Fog batches live below the mirrored world root, but their corners are expanded AFTER that transform.
    // Draw either winding in one pass, so the negative parent cannot cull or double-blend the billboard.
    side: THREE.DoubleSide, forceSinglePass: true,
  } as const;
  const additiveMaterial = new THREE.ShaderMaterial({
    ...shared, name: 'SSF particles additive', blending: THREE.AdditiveBlending,
  });
  const alphaMaterial = new THREE.ShaderMaterial({
    ...shared, name: 'SSF particles alpha', blending: THREE.NormalBlending,
  });

  const batch = (data: typeof buffers, material: THREE.ShaderMaterial, order: number) => {
    const instance = (array: Float32Array, width: number) =>
      new THREE.InstancedBufferAttribute(array, width).setUsage(THREE.DynamicDrawUsage);
    const attributes = {
      particlePosition: instance(data.position, 3),
      particleColor: instance(data.color, 3),
      particleAlpha: instance(data.alpha, 1),
      particleSize: instance(data.size, 1),
      particleSprite: instance(data.sprite, 1),
    };
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ], 3));
    // Point-sprite UVs start at the top left; retain that orientation for the existing atlas images.
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    for (const [name, attribute] of Object.entries(attributes)) geometry.setAttribute(name, attribute);
    geometry.instanceCount = 0;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    mesh.renderOrder = order;
    const viewport = new THREE.Vector4();
    mesh.onBeforeRender = renderer => {
      renderer.getCurrentViewport(viewport);
      uniforms.halfViewportHeight.value = Math.max(1, viewport.w * 0.5);
      material.uniformsNeedUpdate = true;
    };
    return {
      mesh,
      publish(count: number) {
        geometry.instanceCount = count;
        if (count) for (const attribute of Object.values(attributes)) {
          attribute.clearUpdateRanges();
          attribute.addUpdateRange(0, count * attribute.itemSize);
          attribute.needsUpdate = true;
        }
      },
    };
  };
  const additive = batch(buffers, additiveMaterial, 0);
  const alpha = batch(alphaBuffers, alphaMaterial, 1);

  return {
    additiveMesh: additive.mesh,
    alphaMesh: alpha.mesh,
    buffers,
    setDrawRanges(additiveCount, alphaCount) {
      if (alphaCount) for (const key of Object.keys(buffers) as (keyof typeof buffers)[]) {
        const width = key === 'position' || key === 'color' ? 3 : 1;
        alphaBuffers[key].set(buffers[key].subarray(additiveCount * width, (additiveCount + alphaCount) * width));
      }
      additive.publish(additiveCount);
      alpha.publish(alphaCount);
    },
    dispose() {
      additive.mesh.geometry.dispose();
      alpha.mesh.geometry.dispose();
      additiveMaterial.dispose();
      alphaMaterial.dispose();
    },
  };
}
