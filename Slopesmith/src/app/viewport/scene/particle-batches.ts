import * as THREE from 'three';

/**
 * The draw batches every SSF timer emitter's preview particles land in.
 *
 * A layer's blend state is chosen per DRAW CALL, not per vertex, so the authored `U50` selector cannot ride in
 * the vertex stream the way colour, size and sprite do. The two batches here share ONE set of buffers and split
 * them by draw range instead: the caller packs additive sprites at the front, the alpha-blended and darkening
 * ones behind them, and each geometry draws only its own span. That keeps a single upload per frame while still
 * giving the engine's three blend modes their three different framebuffer laws.
 *
 * The darkening batch is what puts Snowdream's road-flare smoke on screen. That plume is authored near-black at
 * alpha 0.08 with the framebuffer-darkening selector [Trailmap: 180-particles-data]; drawn additively it adds
 * essentially nothing to the frame, which is exactly how it went missing.
 */
export interface ParticleBatches {
  /** Additive sprites — sparks, flames, snow. Draw range starts at zero. */
  additivePoints: THREE.Points;
  /** Alpha-blended and darkening sprites, drawn after the additive ones so a plume darkens the glow it hangs
   *  in front of rather than the reverse. */
  alphaPoints: THREE.Points;
  /** Shared, interleaved-by-range vertex arrays, written directly by the caller's per-frame packer. */
  buffers: {
    position: Float32Array;
    color: Float32Array;
    alpha: Float32Array;
    size: Float32Array;
    sprite: Float32Array;
  };
  uniforms: { halfViewportHeight: { value: number } };
  /** Publish this frame's packing: `additiveCount` sprites from index 0, then `alphaCount` behind them. */
  setDrawRanges(additiveCount: number, alphaCount: number): void;
  /** Release the two draw geometries and materials; the caller retains ownership of the atlas texture. */
  dispose(): void;
}

const VERTEX_SHADER = `
  attribute float particleAlpha;
  attribute float particleSize;
  attribute float particleSprite;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSprite;
  uniform float halfViewportHeight;
  void main() {
    vColor = color;
    vAlpha = particleAlpha;
    vSprite = particleSprite;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    // particleSize is a world-space width (native size units / 100, scaled by the host instance), so it
    // projects like any other world length: the vertical projection scale — projectionMatrix[1][1] is
    // 1/tan(fov/2) in perspective and 2*zoom/(top-bottom) in orthographic — times half the drawing buffer
    // height, over the view depth. Orthographic has no depth term, and carries its zoom in that same
    // matrix element, so both projections size a metre identically.
    bool perspective = projectionMatrix[2][3] == -1.0;
    float depth = perspective ? max(0.1, -mvPosition.z) : 1.0;
    gl_PointSize = max(1.0, particleSize * projectionMatrix[1][1] * halfViewportHeight / depth);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = `
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSprite;
  uniform sampler2D particleAtlas;
  uniform vec2 particleAtlasGrid;
  void main() {
    float sprite = clamp(floor(vSprite + 0.5), 0.0, particleAtlasGrid.x * particleAtlasGrid.y - 1.0);
    vec2 cell = vec2(mod(sprite, particleAtlasGrid.x), floor(sprite / particleAtlasGrid.x));
    vec2 uv = (cell + gl_PointCoord) / particleAtlasGrid;
    vec4 texel = texture2D(particleAtlas, uv);
    if (texel.a <= 0.001) discard;
    gl_FragColor = vec4(texel.rgb * vColor, texel.a * vAlpha);
  }
`;

/** Build both batches over `capacity` shared sprite slots, sampling `atlas` as a `columns` x `rows` sheet. */
export function createParticleBatches(atlas: THREE.Texture, columns: number, rows: number,
  capacity: number): ParticleBatches {
  const buffers = {
    position: new Float32Array(capacity * 3),
    color: new Float32Array(capacity * 3),
    alpha: new Float32Array(capacity),
    size: new Float32Array(capacity),
    sprite: new Float32Array(capacity),
  };
  const attributes = {
    position: new THREE.BufferAttribute(buffers.position, 3),
    color: new THREE.BufferAttribute(buffers.color, 3),
    particleAlpha: new THREE.BufferAttribute(buffers.alpha, 1),
    particleSize: new THREE.BufferAttribute(buffers.size, 1),
    particleSprite: new THREE.BufferAttribute(buffers.sprite, 1),
  };
  const additiveGeometry = new THREE.BufferGeometry();
  const alphaGeometry = new THREE.BufferGeometry();
  for (const geometry of [additiveGeometry, alphaGeometry]) {
    for (const [name, attribute] of Object.entries(attributes)) geometry.setAttribute(name, attribute);
    geometry.setDrawRange(0, 0);
  }
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
    vertexColors: true, transparent: true, depthWrite: false,
  } as const;
  const additiveMaterial = new THREE.ShaderMaterial({ ...shared, blending: THREE.AdditiveBlending });
  const alphaMaterial = new THREE.ShaderMaterial({ ...shared, blending: THREE.NormalBlending });

  const point = (geometry: THREE.BufferGeometry, material: THREE.Material, order: number): THREE.Points => {
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.raycast = () => {};
    points.renderOrder = order;
    return points;
  };

  return {
    additivePoints: point(additiveGeometry, additiveMaterial, 0),
    alphaPoints: point(alphaGeometry, alphaMaterial, 1),
    buffers,
    uniforms,
    setDrawRanges(additiveCount, alphaCount) {
      additiveGeometry.setDrawRange(0, additiveCount);
      alphaGeometry.setDrawRange(additiveCount, alphaCount);
      for (const attribute of Object.values(attributes)) attribute.needsUpdate = true;
    },
    dispose() {
      additiveGeometry.dispose();
      alphaGeometry.dispose();
      additiveMaterial.dispose();
      alphaMaterial.dispose();
    },
  };
}
