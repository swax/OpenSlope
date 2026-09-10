import { VIEW_FLAGS, VIEW_MODES } from '../../core/view-link';
import type { HateoasEnvelope } from './hateoas';

const vector = { type: 'string', description: 'Three comma-separated finite numbers. Metres, Y up, authored axes; each magnitude at most 10000000.' };
export const BROWSER_VIEW_SCHEMA = {
  title: 'Browser view fragment parameters', type: 'object', additionalProperties: false,
  description: 'URL-encode each value. Open the resulting HTML URL in a WebGL browser. Explicit pos/look override framing; label and pos/look are mutually exclusive. Defaults always start from the clean preset, never local preferences.',
  properties: {
    view: { const: '1', default: '1' }, pos: vector, look: vector,
    up: { ...vector, description: 'Nonzero camera-up vector in authored axes; default 0,1,0.' },
    space: { enum: ['world', 'mountain', 'reference'], default: 'world' },
    projection: { enum: ['perspective', 'orthographic'], default: 'perspective' },
    fov: { type: 'number', minimum: 1, maximum: 175, default: 55 },
    height: { type: 'number', minimum: 0.01, maximum: 10000000, description: 'Full orthographic view height in metres. Omit to fit the framed terrain/label; explicit pos/look defaults to 200.' },
    label: { type: 'string', minLength: 1, maxLength: 256, description: 'Authored label id or exact name. Frames its curved patches and placed props; missing or empty labels are errors.' },
    az: { type: 'number', minimum: -360, maximum: 360, default: 45, description: 'Framing azimuth: 0 views from +Z, 90 from +X, in authored coordinates.' },
    el: { type: 'number', minimum: -89.9, maximum: 89.9, default: 35, description: 'Framing elevation above the horizon.' },
    reference: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', default: 'none' },
    refOffset: { ...vector, description: 'Reference placement in authored world coordinates. Default 2000,0,0. Requires reference.' },
    revision: { type: 'integer', minimum: 0, description: 'Optional exact revision check. A mismatch is an error; this does not load a historical revision.' },
    size: { type: 'string', description: 'PNG width,height: integers 64–4096, maximum 8388608 pixels. Sets the render buffer and letterboxes the viewport to this aspect ratio.' },
    preset: { enum: ['clean', 'topology', 'surface'], default: 'clean' },
    shade: { enum: ['textured', 'surface', 'none'] },
    mode: { enum: VIEW_MODES, default: 'scene', description: 'test opens ride setup; it does not launch a ride.' },
    ui: { enum: ['0', '1'], default: '1', description: '0 hides editor chrome. Escape or Show editor restores it. Save screenshot always excludes chrome.' },
    ...Object.fromEntries(Object.keys(VIEW_FLAGS).map(key => [key, { enum: ['0', '1'] }])),
  },
};

export function browserProjectLinks(id: string, revision?: number): HateoasEnvelope {
  const page = `/?project=${encodeURIComponent(id)}#view=1`;
  const check = revision === undefined ? '' : `&revision=${revision}`;
  return {
    _links: [
      { rel: 'browser-workflows', href: '/api/browser', title: 'Browser capture, inspection, test ride and export workflows' },
      { rel: 'browser-view', href: `${page}${check}&preset=clean`, title: 'Open this mountain framed in the browser', execution: 'browser' },
    ],
    _linkTemplates: [
      { rel: 'screenshot-view', hrefTemplate: `${page}${check}&pos={pos}&look={look}&fov={fov}&preset=clean&size={size}&ui=0`,
        title: 'Prepare an exact camera view; wait for capture-status ready, then Save screenshot. Returns HTML, not PNG.',
        execution: 'browser', schema: '/api/schemas/BrowserView' },
      { rel: 'frame-label', hrefTemplate: `${page}${check}&label={label}&az={az}&el={el}&preset={preset}`,
        title: 'Frame the curved terrain and props in an authored label by id or exact name',
        execution: 'browser', schema: '/api/schemas/BrowserView' },
    ],
  };
}

export const BROWSER_WORKFLOWS = {
  title: 'Browser workflows', version: 1, execution: 'browser',
  description: 'Follow an HTML view link in a browser with WebGL2. HTTP fetch alone does not render it or return a screenshot. View links do not edit the mountain.',
  authentication: 'Use a signed-in browser on account-enabled servers. API bearer credentials do not sign a browser in; never put credentials in view URLs. Loopback owner mode needs no login.',
  _links: [{ rel: 'self', href: '/api/browser' }, { rel: 'root', href: '/api' },
    { rel: 'maps', href: '/api/projects' }, { rel: 'view-schema', href: '/api/schemas/BrowserView' }],
  screenshot: {
    steps: ['Read a project and follow its screenshot-view or frame-label template; URL-encode substituted values.',
      'Open the URL in a browser. The project query selects a stable map id; the fragment sets the view after loading.',
      'Wait for #capture-status[data-state="ready"] in that tab. Confirm data-project-id, data-revision and data-request match the desired map, revision and fragment.',
      'Click Save screenshot and collect the PNG download. In ui=0 the capture controls appear on hover or keyboard focus and remain accessible to browser tools.',
      'Alternatively capture the browser canvas with the browser tool. Its CSS pixels may differ from the PNG render-buffer dimensions.'],
    status: {
      selector: '#capture-status', states: ['loading', 'ready', 'error', 'changed'],
      attributes: ['data-state', 'data-project-id', 'data-revision', 'data-request', 'data-frame', 'data-width', 'data-height', 'data-camera', 'data-options', 'data-pending', 'data-errors'],
      meaning: 'ready means initialization and scene rebuilds are complete, tracked scene asset loads succeeded, and at least two frames of the settled requested view have rendered. It is local to this tab, never a server-global flag.',
      camera: 'data-camera uses renderer world coordinates (Z mirrored); URL parameters use authored Y-up coordinates.',
      failures: 'error reports invalid parameters, wrong revision/map, missing/empty label, build errors or failed scene assets. changed means navigation altered the requested view: reopen the link or copy a new one. No scene-ready timeout is reported as success.',
      limits: 'Readiness does not freeze animation, wait for future triggered effects, or certify ride results. Tracked scene asset failures remain reported for this page; reload after repairing them.',
    },
    presets: {
      clean: 'Textured terrain, props, tricks, effects, lighting and skybox on; cage, grid, orientation, course, AI paths, normals and sources off.',
      topology: 'Clean defaults with cage on; solid shading, props, tricks, effects and skybox off for a plain background.',
      surface: 'Clean defaults with surface-type colouring.',
    },
  },
  workflows: [
    { rel: 'camera', entry: 'Scene → Camera', controls: ['Apply', 'Restore', 'Read current', 'Copy view link', 'Save screenshot'],
      description: 'Read or set the camera. Copy view link captures the live applied camera and display settings, not pending form edits.' },
    { rel: 'inspect', entry: 'Development builds only: add ?agent=1, or &agent=1 when project is present.',
      description: 'Labelled scene entity proxies support real browser clicks. The existing window.slopesmith observation API has snapshot(), entities(), locate(), pickAt(), errors() and settled(). Observe only; use normal UI controls for actions. Entity coverage is bounded and reports truncation.',
      note: 'settled() is a rebuild observation, not the screenshot asset readiness contract. Prefer capture-status for capture.' },
    { rel: 'test-ride', entry: 'View link with mode=test, then use Play or Watch the AI.',
      description: 'Use the Test panel for race/showoff/free ride, AI riders and telemetry. Opening the URL does not automatically run a simulation.' },
    { rel: 'export', entry: 'File menu → export controls',
      description: 'Unity/Snowknife/ISO composition runs in the browser. The project download link separately returns a portable document/assets bundle over HTTP.' },
  ],
};
