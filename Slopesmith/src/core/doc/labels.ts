import type { LabelDefinition, QuadMeshDoc } from './types';

const LABEL_COLORS = [
  '#f06292', '#ffb74d', '#ffd54f', '#81c784', '#4dd0e1', '#64b5f6', '#9575cd', '#ba68c8',
] as const;

/** Mint a short document-local id without coupling labels to geometry's id counter. */
export function nextLabelId(labels: readonly LabelDefinition[] | undefined): string {
  const used = new Set((labels ?? []).map(label => label.id));
  for (let i = 0; ; i++) {
    const id = `label:${i.toString().padStart(4, '0')}`;
    if (!used.has(id)) return id;
  }
}

/** A readable default swatch. The swatch is editor metadata; it never changes map materials. */
export function nextLabelColor(labels: readonly LabelDefinition[] | undefined): string {
  return LABEL_COLORS[(labels?.length ?? 0) % LABEL_COLORS.length];
}

const cleanMembership = (raw: unknown, known: ReadonlySet<string>): string[] => {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((id): id is string => typeof id === 'string' && known.has(id)))].sort();
};

/** Settle persisted label data onto the live document model and discard dangling membership. */
export function normalizeLabels(doc: QuadMeshDoc): void {
  const definitions: LabelDefinition[] = [];
  const used = new Set<string>();
  for (const raw of Array.isArray(doc.labels) ? doc.labels : []) {
    if (!raw || typeof raw !== 'object') continue;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) continue;
    let id = typeof raw.id === 'string' && raw.id && !used.has(raw.id) ? raw.id : nextLabelId(definitions);
    while (used.has(id)) id = nextLabelId(definitions);
    used.add(id);
    const color = typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color.toLowerCase() : undefined;
    definitions.push({ id, name, ...(color ? { color } : {}) });
  }
  if (definitions.length) doc.labels = definitions; else delete doc.labels;

  const known = new Set(definitions.map(label => label.id));
  const quadLabels: Record<number, string[]> = {};
  for (const [key, raw] of Object.entries(doc.quadLabels ?? {})) {
    const quad = Number(key);
    if (!Number.isInteger(quad) || quad < 0 || quad >= doc.quads.length) continue;
    const labels = cleanMembership(raw, known);
    if (labels.length) quadLabels[quad] = labels;
  }
  if (Object.keys(quadLabels).length) doc.quadLabels = quadLabels; else delete doc.quadLabels;

  for (const prop of doc.props ?? []) {
    const labels = cleanMembership(prop.labels, known);
    if (labels.length) prop.labels = labels; else delete prop.labels;
  }
}
