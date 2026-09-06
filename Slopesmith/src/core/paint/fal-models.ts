/**
 * The fal.ai text-to-image models the Generate texture flow offers, and what a run costs. Shared by the
 * client (labels, the live price estimate, the size menus) and the dev-server proxy (which uses MODELS as
 * its allow-list, so a tampered request can't turn the proxy into an open relay for the user's key).
 *
 * Every model here is priced PER MEGAPIXEL, which is what makes the estimate exact rather than indicative:
 * a 512² generation is a quarter of a megapixel, so it costs a quarter of a 1024² one. Per-second models
 * (fast-sdxl and friends) are deliberately excluded — their cost depends on queue-time hardware, so the
 * dialog could only ever show a guess, and a guess beside a real number reads as a real number.
 *
 * Prices were read from fal's pricing API. They are a display estimate, not a quote — fal is free to change
 * them, and the estimate ignores the per-request rounding fal applies. See docs/033-generate-texture.md.
 */

/** The model-specific permission shown beside an enabled endpoint. Membership in one of the catalogues
 * below means the endpoint is enabled; a catalogue entry without a current, commercial-use review is
 * refused by both the client and proxy. This describes use THROUGH fal.ai, not any separately downloaded
 * weights. */
export interface FalModelTerms {
  status: 'commercial-use' | 'research-only';
  statusLabel: string;
  /** Exact fal model page on which the status was reviewed. */
  modelPage: string;
  /** The endpoint's applicable licence/status source. fal presents this on the model page itself. */
  licenseUrl: string;
  reviewedAt: string;
}

export const FAL_TERMS_REVIEWED_AT = '2026-08-16';

const commercialTerms = (path: string, statusLabel = 'Commercial use through fal.ai'): FalModelTerms => {
  const modelPage = `https://fal.ai/models/${path}`;
  return { status: 'commercial-use', statusLabel, modelPage, licenseUrl: modelPage,
    reviewedAt: FAL_TERMS_REVIEWED_AT };
};

/** Provider documents archived by URL and review date in every saved generation record. */
export const FAL_PROVIDER_TERMS = {
  modelLicensingFaq: 'https://fal.ai/docs/documentation/model-apis/faq',
  termsOfService: 'https://fal.ai/legal/terms-of-service',
  apiServicesTerms: 'https://fal.ai/legal/api-services',
  acceptableUsePolicy: 'https://fal.ai/legal/acceptable-use-policy',
  reviewedAt: FAL_TERMS_REVIEWED_AT,
} as const;

export const FAL_OUTPUT_NOTICE = 'By generating, you confirm rights to every input and compliance with '
  + 'applicable model, territorial, and acceptable-use restrictions. Do not assume the linked terms transfer '
  + 'additional output rights or mean an output is exclusive, original, non-infringing, or otherwise cleared.';

export interface FalModel {
  /** fal endpoint id — the path POSTed to https://fal.run/<id>. */
  id: string;
  label: string;
  /** USD per megapixel of generated image. */
  usdPerMegapixel: number;
  /** One line on what this model is FOR, shown under the price in the model menu. */
  note: string;
  terms: FalModelTerms;
}

/** Ordered cheapest-first, which is also best-first for terrain tiles: a 128² PS2 tile shows none of what
 *  the pricier models buy you, so the default is the one at the top. */
export const FAL_MODELS: readonly FalModel[] = [
  {
    id: 'fal-ai/flux/schnell',
    label: 'FLUX.1 [schnell]',
    usdPerMegapixel: 0.003,
    terms: commercialTerms('fal-ai/flux/schnell'),
    note: 'Fastest and cheapest. Four steps; plenty for a material sample that ends up 128².',
  },
  {
    id: 'fal-ai/z-image/turbo',
    label: 'Z-Image Turbo',
    usdPerMegapixel: 0.005,
    terms: commercialTerms('fal-ai/z-image/turbo'),
    note: 'Comparable speed, different look — worth a try when schnell keeps missing the material.',
  },
  {
    id: 'fal-ai/flux/dev',
    label: 'FLUX.1 [dev]',
    usdPerMegapixel: 0.025,
    terms: commercialTerms('fal-ai/flux/dev'),
    note: 'Slower and ~8× the price, for when you want the tile to hold up at 512 in a Unity export.',
  },
] as const;

export const DEFAULT_FAL_MODEL = FAL_MODELS[0].id;

export function falModel(id: string): FalModel | undefined {
  return FAL_MODELS.find(m => m.id === id);
}

/**
 * The INPAINTING models behind the dialog's Transition and Decal tabs — same rules as FAL_MODELS (per
 * megapixel only, allow-list for the proxy), plus the one schema difference that can't be papered over:
 * Black Forest's fill endpoints call the mask `mask_url` while Tongyi's inpaint calls it `mask_image_url`.
 * Recording it here keeps the proxy free of per-model special cases.
 */
export interface FalInpaintModel extends FalModel {
  /** The body field this endpoint reads the mask from. */
  maskParam: 'mask_url' | 'mask_image_url';
}

export const FAL_INPAINT_MODELS: readonly FalInpaintModel[] = [
  {
    id: 'fal-ai/z-image/turbo/inpaint',
    label: 'Z-Image Turbo Inpaint',
    usdPerMegapixel: 0.01,
    terms: commercialTerms('fal-ai/z-image/turbo/inpaint'),
    maskParam: 'mask_image_url',
    note: 'Fast and cheap. Plenty for a transition strip or a small decal on a 128² tile.',
  },
  {
    id: 'fal-ai/flux-pro/v1/fill',
    label: 'FLUX.1 [pro] Fill',
    usdPerMegapixel: 0.05,
    terms: commercialTerms('fal-ai/flux-pro/v1/fill', 'Commercial use through fal.ai partnership'),
    maskParam: 'mask_url',
    note: 'The dedicated FLUX fill model — 5× the price, noticeably better at continuing the surrounding material.',
  },
] as const;

export const DEFAULT_FAL_INPAINT_MODEL = FAL_INPAINT_MODELS[0].id;

/**
 * Hunyuan World — the Generate skybox dialog's optional 360° pass: hand it a generated 2:1 view and it
 * re-imagines the scene as a genuinely wrapping panorama. Flat-priced per image rather than per megapixel,
 * which still keeps the estimate exact — it simply doesn't vary.
 */
export const FAL_PANORAMA_MODEL = 'fal-ai/hunyuan_world';
export const FAL_PANORAMA_USD = 0.15;
export const FAL_PANORAMA_TERMS = commercialTerms('fal-ai/hunyuan_world');

export function falInpaintModel(id: string): FalInpaintModel | undefined {
  return FAL_INPAINT_MODELS.find(m => m.id === id);
}

/**
 * The image-to-3D models behind the Prop Library's Generate prop dialog (docs/032): a concept image goes
 * in, a textured GLB comes out, and the GLB rides the ordinary imported-prop path from there. Flat-priced
 * PER GENERATION, which keeps the estimate exact the same way per-megapixel does for the image models —
 * it simply doesn't vary. (Hunyuan3D is deliberately absent: it prices in opaque "units" and its meshes
 * routinely land past the 50k-triangle import cap, so both the quote and the import would be a gamble.)
 *
 * Like maskParam on the inpainting catalogue, the schema differences between vendors are recorded HERE so
 * the proxy stays free of per-model special cases: which body field the image travels in, whether the
 * endpoint also reads the prompt, and any fixed extras the endpoint needs to answer with a textured GLB.
 */
export interface Fal3dModel {
  id: string;
  label: string;
  /** USD per generation — these bill flat per run, so the estimate is exact. */
  usdPerRun: number;
  note: string;
  terms: FalModelTerms;
  /** The body field this endpoint reads the source image from (Rodin takes a list of views). */
  imageParam: 'image_url' | 'input_image_urls';
  /** Whether the endpoint conditions on the prompt as well as the image. */
  takesPrompt: boolean;
  /** Fixed body fields this endpoint needs to come back as a textured GLB. */
  extras?: Readonly<Record<string, unknown>>;
  /** The detail levels this endpoint offers (Rodin's quality tiers and Sketch mode), FIRST entry the
   *  default. Same flat price either way — lower levels return a lighter mesh. Absent = one level only. */
  details?: readonly Fal3dDetail[];
}

/** One offered detail level: the id the dialog sends, its menu label, and the body fields selecting it. */
export interface Fal3dDetail {
  id: string;
  label: string;
  body: Readonly<Record<string, unknown>>;
}

export const FAL_3D_MODELS: readonly Fal3dModel[] = [
  {
    id: 'fal-ai/trellis',
    label: 'Trellis',
    usdPerRun: 0.02,
    terms: commercialTerms('fal-ai/trellis'),
    imageParam: 'image_url',
    takesPrompt: false,
    note: 'Cheap enough to just try again. Simplifies its own mesh hard, so it lands well inside the '
      + '50k-triangle import cap; textures can come out a little soft.',
  },
  {
    id: 'fal-ai/hyper3d/rodin',
    label: 'Hyper3D Rodin',
    usdPerRun: 0.4,
    terms: commercialTerms('fal-ai/hyper3d/rodin'),
    imageParam: 'input_image_urls',
    takesPrompt: true,
    extras: { geometry_file_format: 'glb', material: 'PBR' },
    details: [
      { id: 'medium', label: 'Medium — the full pass', body: { quality: 'medium', tier: 'Regular' } },
      { id: 'low', label: 'Low — fewer polygons', body: { quality: 'low', tier: 'Regular' } },
      { id: 'extra-low', label: 'Extra low — lightest mesh', body: { quality: 'extra-low', tier: 'Regular' } },
      { id: 'sketch', label: 'Sketch — fast rough tier', body: { tier: 'Sketch' } },
    ],
    note: '20× the price for production-grade geometry and texturing. Reads the prompt as well as the '
      + 'image. Runs a few minutes.',
  },
] as const;

export const DEFAULT_FAL_3D_MODEL = FAL_3D_MODELS[0].id;

export function fal3dModel(id: string): Fal3dModel | undefined {
  return FAL_3D_MODELS.find(m => m.id === id);
}

/** One lookup for disclosures, proxy gating, and provenance snapshots across all four catalogues. */
export function falEndpoint(id: string): { id: string; label: string; terms: FalModelTerms } | undefined {
  const model = falModel(id) ?? falInpaintModel(id) ?? fal3dModel(id);
  if (model) return model;
  return id === FAL_PANORAMA_MODEL
    ? { id, label: 'Hunyuan World', terms: FAL_PANORAMA_TERMS }
    : undefined;
}

/** Research-only or unreviewed endpoints must not become billable merely because an id reached a proxy. */
export function falEndpointMayGenerate(id: string): boolean {
  const endpoint = falEndpoint(id);
  return endpoint?.terms.status === 'commercial-use' && !!endpoint.terms.reviewedAt;
}

export interface FalGenerationProvenance {
  schema: 1;
  provider: 'fal.ai';
  generatedAt: string;
  models: Array<{
    id: string;
    label: string;
    status: FalModelTerms['status'];
    statusLabel: string;
    modelPage: string;
    licenseUrl: string;
    reviewedAt: string;
  }>;
  providerTerms: typeof FAL_PROVIDER_TERMS;
  notice: string;
}

/** Header used only when a generated PNG becomes a project asset. The server validates and canonicalises
 * its JSON before writing the sibling `.generation.json`; API keys and prompts are never part of it. */
export const FAL_GENERATION_HEADER = 'x-slopesmith-generation';

/** Snapshot the exact endpoints and legal references that produced an asset. The timestamp belongs to the
 * successful generation, not the later Save click, and repeated endpoints (a repair pass) are archived once. */
export function createFalGenerationProvenance(modelIds: readonly string[],
  generatedAt = new Date().toISOString()): FalGenerationProvenance {
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error('generation date is invalid');
  const models = [...new Set(modelIds)].map(id => {
    const endpoint = falEndpoint(id);
    if (!endpoint || !falEndpointMayGenerate(id)) throw new Error(`model terms are not cleared for "${id}"`);
    return { id: endpoint.id, label: endpoint.label, ...endpoint.terms };
  });
  if (!models.length) throw new Error('generation provenance needs at least one model');
  return {
    schema: 1,
    provider: 'fal.ai',
    generatedAt,
    models,
    providerTerms: { ...FAL_PROVIDER_TERMS },
    notice: FAL_OUTPUT_NOTICE,
  };
}

/** Validate an untrusted upload header. Only the generation time and model ids are accepted; all legal
 * wording and URLs are rebuilt from this reviewed catalogue so a client cannot archive invented terms. */
export function parseFalGenerationProvenance(value: unknown): FalGenerationProvenance | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { schema?: unknown; provider?: unknown; generatedAt?: unknown;
    models?: Array<{ id?: unknown }> };
  if (raw.schema !== 1 || raw.provider !== 'fal.ai' || typeof raw.generatedAt !== 'string'
    || !Array.isArray(raw.models) || raw.models.length < 1 || raw.models.length > 4
    || !raw.models.every(model => !!model && typeof model.id === 'string')) return undefined;
  try { return createFalGenerationProvenance(raw.models.map(model => model.id as string), raw.generatedAt); }
  catch { return undefined; }
}

/** Resolve a detail level for a model: the named one, else the model's default (its first entry), else
 *  null when the model offers no choice. For the client's stored pref — the proxy REJECTS an unknown
 *  detail instead of defaulting, so a tampered request never silently bills something else. */
export function fal3dDetail(modelId: string, detailId?: string): Fal3dDetail | null {
  const model = fal3dModel(modelId);
  if (!model?.details?.length) return null;
  return model.details.find(d => d.id === detailId) ?? model.details[0];
}

/** Estimated USD for one image at `size`², or null for an unknown model. */
export function estimateUsd(modelId: string, size: number): number | null {
  const model = falModel(modelId);
  return model ? model.usdPerMegapixel * ((size * size) / 1_000_000) : null;
}

/** The Transition / Decal counterpart of estimateUsd — inpainting bills by the megapixel too, so the
 *  estimate stays exact rather than indicative. */
export function estimateInpaintUsd(modelId: string, size: number): number | null {
  const model = falInpaintModel(modelId);
  return model ? model.usdPerMegapixel * ((size * size) / 1_000_000) : null;
}

/** Price text for the dialog. Sub-cent runs are the normal case here, so this keeps enough decimals to
 *  stay honest rather than collapsing every cheap model to "$0.00". */
export function usdText(usd: number): string {
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  if (usd >= 0.001) return `$${usd.toFixed(3)}`;
  return `<$0.001`;
}

/**
 * Generation sizes offered. Diffusion models are trained at 512 and up and produce mush below that, so the
 * floor here is 512 even though the tile is stored far smaller — the downscale to a PS2 size happens after
 * generation, where it acts as a free supersample rather than as a handicap on the model.
 */
export const GEN_SIZES = [512, 768, 1024] as const;

/** Stored tile edges. 128 is the dominant native SSX terrain tile size and the ISO export's cap. */
export const STORE_SIZES = [128, 256, 512] as const;
