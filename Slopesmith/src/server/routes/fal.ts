import {
  FAL_MODELS, FAL_PANORAMA_MODEL, fal3dModel, falEndpointMayGenerate, falInpaintModel,
} from '../../core/paint/fal-models';

/**
 * The fal.ai proxies behind POST /api/fal-texture (text-to-image) and POST /api/fal-inpaint (masked
 * repaint of a client-composed image — the dialog's Transition and Decal tabs). The browser hands these
 * routes a prompt and the user's key; the route calls fal, pulls the image down, and answers with PNG
 * bytes the Generate texture dialog can preview and store.
 *
 * Why proxy at all, when fal's REST API is reachable from a browser? Three reasons, in order of weight:
 *   • The key never leaves the machine's own origin, so it isn't in a cross-origin request, a preflight, or
 *     any extension's view of one.
 *   • fal returns the image on a CDN host; fetching it here means one round-trip for the client and no
 *     dependence on that host's CORS policy staying permissive.
 *   • Errors arrive as fal's JSON, which we can turn into a sentence the dialog can show, instead of the
 *     opaque "TypeError: Failed to fetch" a blocked browser request produces.
 *
 * The key is used for the one call and never stored — no file, no env write, no log line. See
 * docs/033-generate-texture.md.
 */

/** Only the catalogue's endpoints may be called. Without this the route would forward an arbitrary path to
 *  fal.run under the user's key, which is a credential-relay, not a texture generator. */
const ALLOWED = new Set(FAL_MODELS.filter(m => falEndpointMayGenerate(m.id)).map(m => m.id));

/** fal rejects non-multiples of 8 outright on some models and silently rounds on others; clamping here
 *  keeps the stored tile's aspect exactly square and the price exactly what the dialog quoted. */
const MIN_EDGE = 256, MAX_EDGE = 1536;

export interface FalTextureRequest {
  model: string;
  prompt: string;
  size: number;
  /** Height when the request is not square (the Generate skybox dialog's 2:1 equirect); defaults to size. */
  height?: number;
  /** null / undefined lets fal pick, which is what "new variation each click" means. */
  seed?: number | null;
}

export interface FalTextureResult {
  png: Buffer;
  /** The seed fal actually used, so the dialog can show it and the user can pin a result they liked. */
  seed: number | null;
}

/** A fal error body is either {detail: "..."} or {detail: [{msg, loc}]}; both show up in practice. */
function falErrorText(status: number, body: string): string {
  let detail: unknown;
  try { detail = (JSON.parse(body) as { detail?: unknown }).detail; } catch { /* not JSON — use the raw text */ }
  const text = typeof detail === 'string' ? detail
    : Array.isArray(detail)
      ? detail.map(d => (d as { msg?: string }).msg).filter(Boolean).join('; ')
      : body.slice(0, 300);
  if (status === 401 || status === 403) {
    return 'fal.ai rejected the API key (401). Check it in Settings ▸ Integrations — it should be the whole '
      + '"key id:key secret" pair copied from fal.ai/dashboard/keys.';
  }
  if (status === 402) return 'fal.ai reports no credit on this account. Top up at fal.ai/dashboard/billing.';
  if (status === 429) return 'fal.ai is rate-limiting this key. Wait a moment and generate again.';
  return `fal.ai returned ${status}${text ? `: ${text}` : ''}`;
}

/** What every fal image endpoint answers with, one way or another: most say {images:[...]}, Hunyuan World
 *  says a single {image}. */
interface FalImagePayload { images?: Array<{ url?: string }>; image?: { url?: string }; seed?: number }

/** Turn a fal response payload into PNG bytes — inlined data URI or CDN download, whichever came back. */
async function pngFromPayload(payload: FalImagePayload): Promise<FalTextureResult> {
  const url = payload.images?.[0]?.url ?? payload.image?.url;
  if (!url) throw new Error('fal.ai returned no image.');
  const seed = Number.isFinite(payload.seed) ? payload.seed as number : null;

  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    if (comma < 0) throw new Error('fal.ai returned a malformed data URI.');
    return { png: Buffer.from(url.slice(comma + 1), 'base64'), seed };
  }
  const img = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!img.ok) throw new Error(`could not download the generated image (${img.status})`);
  return { png: Buffer.from(await img.arrayBuffer()), seed };
}

/** POST a body to one fal endpoint synchronously and hand back the first image's PNG bytes — the shared
 *  back half of text-to-image and inpainting, which answer in seconds. Minutes-long models (Hunyuan World)
 *  go through callFalQueued instead: fal.run holds a socket open for the whole run, and past a few minutes
 *  that is a timeout looking for somewhere to happen. */
async function callFalEndpoint(key: string, model: string, body: Record<string, unknown>): Promise<FalTextureResult> {
  let res: Response;
  try {
    res = await fetch(`https://fal.run/${model}`, {
      method: 'POST',
      headers: { authorization: `Key ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError'
      ? 'fal.ai did not respond within three minutes'
      : `could not reach fal.ai (${e instanceof Error ? e.message : String(e)})`;
    throw new Error(reason, { cause: e });
  }
  if (!res.ok) throw new Error(falErrorText(res.status, await res.text().catch(() => '')));
  return pngFromPayload(await res.json() as FalImagePayload);
}

/**
 * The long-haul path: submit to fal's QUEUE (https://queue.fal.run), poll the job's status, fetch the
 * result when it completes. Same key and body as the sync path — only the waiting is different, which is
 * why this answers the raw payload rather than a decoded image: the panorama pass and the 3D models share
 * the queue but not the result shape. `capMs` bounds the whole affair; one flaky status poll is retried, a
 * FAILED job is not.
 */
async function callFalQueued(key: string, model: string, body: Record<string, unknown>, capMs = 600_000): Promise<unknown> {
  const auth = { authorization: `Key ${key}` };
  let submit: Response;
  try {
    submit = await fetch(`https://queue.fal.run/${model}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Error(`could not reach fal.ai (${e instanceof Error ? e.message : String(e)})`, { cause: e });
  }
  if (!submit.ok) throw new Error(falErrorText(submit.status, await submit.text().catch(() => '')));
  const job = await submit.json() as { request_id?: string; status_url?: string; response_url?: string };
  if (!job.request_id) throw new Error('fal.ai queue returned no request id.');
  const statusUrl = job.status_url ?? `https://queue.fal.run/${model}/requests/${job.request_id}/status`;
  const responseUrl = job.response_url ?? `https://queue.fal.run/${model}/requests/${job.request_id}`;

  const deadline = Date.now() + capMs;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`fal.ai is still working after ${Math.round(capMs / 60_000)} minutes — giving up here. `
        + 'The job may yet complete (and bill) on their side; see fal.ai/dashboard/requests.');
    }
    await new Promise(r => setTimeout(r, 2500));
    let st: Response;
    try {
      st = await fetch(statusUrl, { headers: auth, signal: AbortSignal.timeout(15_000) });
    } catch { continue; }   // one dropped poll is not a failed job
    if (!st.ok && st.status !== 202) throw new Error(falErrorText(st.status, await st.text().catch(() => '')));
    const s = await st.json().catch(() => ({})) as { status?: string };
    if (s.status === 'COMPLETED') break;
    if (s.status && s.status !== 'IN_QUEUE' && s.status !== 'IN_PROGRESS') {
      throw new Error(`fal.ai reports the job ${s.status}.`);
    }
  }
  const res = await fetch(responseUrl, { headers: auth, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(falErrorText(res.status, await res.text().catch(() => '')));
  return res.json();
}

/**
 * Generate one square image and return its PNG bytes. `sync_mode` asks fal to inline the result as a data
 * URI, which usually saves the CDN round-trip; the https branch remains because not every model honours it.
 */
export async function generateFalTexture(key: string, req: FalTextureRequest): Promise<FalTextureResult> {
  if (!key) throw new Error('No fal.ai API key — set one in Settings ▸ Integrations.');
  if (!ALLOWED.has(req.model)) throw new Error(`unsupported model "${req.model}"`);
  const prompt = (req.prompt ?? '').trim();
  if (!prompt) throw new Error('The prompt is empty.');
  const size = Math.round(req.size);
  if (!Number.isFinite(size) || size < MIN_EDGE || size > MAX_EDGE) {
    throw new Error(`size must be between ${MIN_EDGE} and ${MAX_EDGE}`);
  }
  const height = req.height == null ? size : Math.round(req.height);
  if (!Number.isFinite(height) || height < MIN_EDGE || height > MAX_EDGE) {
    throw new Error(`height must be between ${MIN_EDGE} and ${MAX_EDGE}`);
  }

  const body: Record<string, unknown> = {
    prompt,
    image_size: { width: size, height },
    num_images: 1,
    output_format: 'png',   // the library stores PNG, and a JPEG round-trip would add ringing to a 128² tile
    sync_mode: true,
  };
  if (req.seed != null && Number.isFinite(req.seed)) body.seed = Math.round(req.seed);
  return callFalEndpoint(key, req.model, body);
}

// ---- inpainting (the dialog's Transition and Decal tabs — docs/033) ----

/** Ceiling on each data-URI argument. The client sends its own composed canvas at ≤1536², which encodes to
 *  low single-digit megabytes; anything past this is not that client and gets refused before touching fal. */
const MAX_DATA_URI = 24_000_000;

export interface FalInpaintRequest {
  model: string;
  prompt: string;
  /** The composed source image as a PNG data URI (fal accepts data URIs wherever it takes an image URL). */
  image: string;
  /** The mask as a PNG data URI — white where fal should paint, black where it must not. */
  mask: string;
  seed?: number | null;
}

/** One masked repaint of a client-composed image. The image and mask stay data URIs end to end: they never
 *  touch disk here, and fal reads them straight out of the request body. */
export async function generateFalInpaint(key: string, req: FalInpaintRequest): Promise<FalTextureResult> {
  if (!key) throw new Error('No fal.ai API key — set one in Settings ▸ Integrations.');
  const model = falInpaintModel(req.model);
  if (!model || !falEndpointMayGenerate(model.id)) throw new Error(`unsupported inpainting model "${req.model}"`);
  const prompt = (req.prompt ?? '').trim();
  if (!prompt) throw new Error('The prompt is empty.');
  for (const [label, uri] of [['image', req.image], ['mask', req.mask]] as const) {
    if (typeof uri !== 'string' || !uri.startsWith('data:image/png;base64,')) {
      throw new Error(`the ${label} must be a PNG data URI`);
    }
    if (uri.length > MAX_DATA_URI) throw new Error(`the ${label} is too large`);
  }

  const body: Record<string, unknown> = {
    prompt,
    image_url: req.image,
    [model.maskParam]: req.mask,  // mask_url vs mask_image_url — the one schema split between vendors
    num_images: 1,
    output_format: 'png',
    sync_mode: true,
  };
  if (req.seed != null && Number.isFinite(req.seed)) body.seed = Math.round(req.seed);
  return callFalEndpoint(key, model.id, body);
}

// ---- panorama (the Generate skybox dialog's optional 360° pass — docs/025) ----

export interface FalPanoramaRequest {
  prompt: string;
  /** The 2:1 base view to re-imagine as a wrapping panorama, as a PNG data URI. */
  image: string;
}

/** One Hunyuan World call: base view + prompt in, a genuinely wrapping equirect panorama out. The model is
 *  fixed (there is exactly one on offer and it is flat-priced), so no allow-list to consult — the endpoint
 *  id ships from the catalogue constant, never from the request. */
export async function generateFalPanorama(key: string, req: FalPanoramaRequest): Promise<FalTextureResult> {
  if (!key) throw new Error('No fal.ai API key — set one in Settings ▸ Integrations.');
  if (!falEndpointMayGenerate(FAL_PANORAMA_MODEL)) throw new Error('the panorama model terms are not cleared');
  const prompt = (req.prompt ?? '').trim();
  if (!prompt) throw new Error('The prompt is empty.');
  if (typeof req.image !== 'string' || !req.image.startsWith('data:image/png;base64,')) {
    throw new Error('the image must be a PNG data URI');
  }
  if (req.image.length > MAX_DATA_URI) throw new Error('the image is too large');
  // minimal body on purpose (the endpoint's schema is prompt + image_url and nothing else), and QUEUED on
  // purpose: Hunyuan World runs for minutes, well past what a held-open fal.run socket tolerates
  return pngFromPayload(await callFalQueued(key, FAL_PANORAMA_MODEL, { prompt, image_url: req.image }) as FalImagePayload);
}

// ---- image-to-3D (the Prop Library's Generate prop dialog — docs/032) ----

/** What the 3D endpoints answer: one mesh file, plus (on some of them) the seed. */
interface FalMeshPayload { model_mesh?: { url?: string }; seed?: number }

/** Ceiling on a downloaded GLB. A model inside the 50k-triangle import cap encodes to single-digit
 *  megabytes even with 2k textures; anything past this is not going to import and isn't worth buffering. */
const MAX_GLB = 100_000_000;

export interface Fal3dRequest {
  model: string;
  prompt: string;
  /** The concept image the mesh is built from, as a PNG data URI. */
  image: string;
  /** A detail level from the model's own catalogue menu (Rodin's quality tiers / Sketch). Optional —
   *  absent means the model's default. */
  detail?: string;
}

export interface Fal3dResult {
  glb: Buffer;
  seed: number | null;
}

/** Turn a 3D endpoint's payload into GLB bytes — data URI or CDN download, whichever came back. */
async function glbFromPayload(payload: FalMeshPayload): Promise<Fal3dResult> {
  const url = payload.model_mesh?.url;
  if (!url) throw new Error('fal.ai returned no model file.');
  const seed = Number.isFinite(payload.seed) ? payload.seed as number : null;

  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    if (comma < 0) throw new Error('fal.ai returned a malformed data URI.');
    return { glb: Buffer.from(url.slice(comma + 1), 'base64'), seed };
  }
  const file = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!file.ok) throw new Error(`could not download the generated model (${file.status})`);
  const declared = Number(file.headers.get('content-length') ?? '0');
  if (declared > MAX_GLB) throw new Error('the generated model is implausibly large');
  const glb = Buffer.from(await file.arrayBuffer());
  if (glb.length > MAX_GLB) throw new Error('the generated model is implausibly large');
  return { glb, seed };
}

/**
 * One image-to-3D generation: concept image (and, where the model reads it, the prompt) in, a textured GLB
 * out. QUEUED like the panorama pass — these run for minutes. The body is assembled entirely from the
 * catalogue's recorded schema facts (imageParam / takesPrompt / extras), so adding a model is a catalogue
 * entry, not a new special case here.
 */
export async function generateFal3dMesh(key: string, req: Fal3dRequest): Promise<Fal3dResult> {
  if (!key) throw new Error('No fal.ai API key — set one in Settings ▸ Integrations.');
  const model = fal3dModel(req.model);
  if (!model || !falEndpointMayGenerate(model.id)) throw new Error(`unsupported 3D model "${req.model}"`);
  if (typeof req.image !== 'string' || !req.image.startsWith('data:image/png;base64,')) {
    throw new Error('the image must be a PNG data URI');
  }
  if (req.image.length > MAX_DATA_URI) throw new Error('the image is too large');
  // a PRESENT detail must name one of the model's own levels — rejected rather than defaulted, so a
  // tampered value never silently bills something other than what was asked for
  if (req.detail != null && (typeof req.detail !== 'string' || !model.details?.some(d => d.id === req.detail))) {
    throw new Error(`unsupported detail "${String(req.detail)}" for ${model.label}`);
  }
  const detail = model.details?.length ? (model.details.find(d => d.id === req.detail) ?? model.details[0]) : null;

  const body: Record<string, unknown> = {
    ...(model.extras ?? {}),
    ...(detail?.body ?? {}),
    [model.imageParam]: model.imageParam === 'input_image_urls' ? [req.image] : req.image,
  };
  const prompt = (req.prompt ?? '').trim();
  if (model.takesPrompt && prompt) body.prompt = prompt;
  return glbFromPayload(await callFalQueued(key, model.id, body) as FalMeshPayload);
}
