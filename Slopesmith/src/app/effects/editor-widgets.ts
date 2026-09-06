/**
 * Stateless view helpers for the Effects editor: DOM primitives, node/template labelling, the shared
 * described-menu pickers, and the effect/node tree builders. Everything here takes what it needs as
 * arguments and returns an element or a string, so none of it reads the editor factory’s selection,
 * source, or viewport state — which is why it lives beside `editor.ts` rather than inside it.
 */
import {
  EFFECT_LATCH_SUMMARY,
  EFFECT_TEMPLATES,
  UNAUTHORABLE_EFFECT_NODES,
  effectCircumstanceLabel,
  effectGraphDisplayName,
  isEffectLatchCircumstance,
  type EffectCircumstance,
  type EffectNodeTemplateId,
  type EffectSelection,
  type EffectTemplateId,
  type EffectTemplateKind,
  type EffectTemplateProof,
} from '../../core/effects/authoring';
import { type RgbaColor } from '../../core/effects/emitter-colors';
import { type EffectGraph, type EffectNode } from '../../core/effects/document';
import { effectNodeLabel } from '../../core/effects/node-detail';
import {
  referenceIncomingEffectCalls,
} from '../../core/reference/effects';
import { menu, type MenuItem } from '../ui/components/controls';

export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const out = document.createElement(tag);
  if (cls) out.className = cls;
  if (text !== undefined) out.textContent = text;
  return out;
};

export const button = (text: string, title: string, action: () => void, danger = false): HTMLButtonElement => {
  const out = el('button', `sp-fx-btn${danger ? ' danger' : ''}`, text);
  out.type = 'button'; out.title = title; out.onclick = action;
  return out;
};

export const iconButton = (icon: string, label: string, title: string, action: () => void, danger = false): HTMLButtonElement => {
  const out = button('', title, action, danger);
  out.classList.add('sp-fx-icon-btn');
  out.innerHTML = icon;
  out.setAttribute('aria-label', label);
  return out;
};

export const navigationButton = (text: string, icon: string, title: string, action: () => void): HTMLButtonElement => {
  const out = button('', title, action);
  out.classList.add('sp-fx-label-icon');
  const glyph = el('span', 'sp-inline-action-icon');
  glyph.innerHTML = icon;
  out.append(glyph, el('span', '', text));
  return out;
};

export const section = (title: string): { root: HTMLElement; body: HTMLElement } => {
  const root = el('section', 'sp-fx-section');
  root.appendChild(el('div', 'sp-fx-section-title', title));
  const body = el('div', 'sp-fx-section-body'); root.appendChild(body);
  return { root, body };
};

/** Fold a related detail section into an existing inspector without nesting a second toolbox card. */
/** Fold a built section's contents into a body that is already open, under its own sub-heading. */
export const embedSectionBody = (parentBody: HTMLElement, child: HTMLElement, title: string): boolean => {
  const childBody = child.querySelector<HTMLElement>(':scope > .sp-fx-section-body');
  if (!childBody) return false;
  const embedded = el('div', 'sp-fx-embedded-panel');
  embedded.append(el('div', 'sp-fx-embedded-title', title), ...Array.from(childBody.childNodes));
  parentBody.appendChild(embedded);
  return true;
};

export const embedSection = (parent: HTMLElement, child: HTMLElement, title: string): boolean => {
  const parentBody = parent.querySelector<HTMLElement>(':scope > .sp-fx-section-body');
  return !!parentBody && embedSectionBody(parentBody, child, title);
};

/** Counted meta chips in the effect trees. A "1 nodes" row is small on its own and constant in aggregate —
 * a counter target lists one per caller. */
export const countLabel = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

export interface EffectHostListItem {
  label: string;
  meta: string;
  active: boolean;
  title: string;
  select: () => void;
}

export const effectHostListPanel = (items: readonly EffectHostListItem[], note: string): HTMLElement => {
  const s = section(`Selected effects · ${items.length}`);
  s.body.appendChild(el('div', 'sp-fx-note', note));
  const list = el('div', 'sp-fx-list');
  for (const entry of items) {
    const item = el('button', `sp-fx-list-row${entry.active ? ' on' : ''}`);
    item.type = 'button'; item.title = entry.title; item.onclick = entry.select;
    item.append(el('span', 'sp-fx-node-index', entry.active ? '›' : '✓'),
      el('span', 'sp-fx-list-name', entry.label), el('span', 'sp-fx-kind', entry.meta));
    list.appendChild(item);
  }
  s.body.appendChild(list);
  return s.root;
};

export const row = (label: string, control: HTMLElement, title?: string): HTMLElement => {
  const out = el('label', 'sp-fx-field');
  const name = el('span', 'sp-fx-field-name', label);
  if (title) { out.title = title; name.title = title; }
  out.append(name, control); return out;
};

export const checkboxRow = (label: string, checked: boolean, title: string,
  change: (value: boolean) => void): HTMLElement => {
  const box = el('input', 'sp-fx-check');
  box.type = 'checkbox'; box.checked = checked;
  box.onchange = () => change(box.checked);
  const out = el('label', 'sp-fx-field sp-fx-check-field');
  out.title = title;
  out.append(box, el('span', 'sp-fx-field-name', label));
  return out;
};

export const helpIcon = (help: string, label = 'More information'): HTMLSpanElement => {
  const out = el('span', 'sp-fx-help', '?');
  out.title = help;
  out.tabIndex = 0;
  out.setAttribute('role', 'img');
  out.setAttribute('aria-label', `${label}: ${help}`);
  return out;
};

export const input = (value: string, change: (value: string) => void, opts: { readonly?: boolean; type?: string } = {}): HTMLInputElement => {
  const out = el('input', 'sp-fx-input'); out.type = opts.type ?? 'text'; out.value = value; out.readOnly = !!opts.readonly;
  if (!opts.readonly) out.onchange = () => change(out.value);
  return out;
};

export const numberInput = (value: number, change: (value: number) => void, step = 'any'): HTMLInputElement => {
  const out = input(String(value), raw => {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) change(parsed); else out.value = String(value);
  }, { type: 'number' });
  out.step = step; return out;
};

export const clampNumber = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export const colorHex = (color: RgbaColor): string => `#${color.slice(0, 3)
  .map(component => Math.round(clampNumber(component, 0, 1) * 255).toString(16).padStart(2, '0')).join('')}`;

export const colorRgbFromHex = (value: string): [number, number, number] | null => {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return null;
  const packed = Number.parseInt(match[1], 16);
  return [(packed >> 16) / 255, ((packed >> 8) & 0xff) / 255, (packed & 0xff) / 255];
};

/**
 * One name per node, from the shared registry, so an authored node and the retail node it was copied from
 * read identically. The wire `semanticType` is the Snowknife interchange contract and is deliberately NOT
 * renamed — `core/effects/node-detail.ts` is the display layer, derived from the templates so a label cannot
 * drift from the picker's.
 */
export const nodeDisplayName = (node: EffectNode): string => effectNodeLabel(node);

/** Circumstance-aware node label without the circumstance prefix — for rows nested under their effect row,
 * where the parent already names the circumstance. */
export const nodeDisplayNameForCircumstance = (node: EffectNode, circumstance: EffectCircumstance): string =>
  node.semanticType === 'particle.timer'
    ? (circumstance === 'persistent' ? 'Particle emitter' : 'Particle burst')
    : nodeDisplayName(node);

export const nodeDisplayNameInGraph = (node: EffectNode, circumstance: EffectCircumstance): string =>
  `${effectCircumstanceLabel(circumstance)} · ${nodeDisplayNameForCircumstance(node, circumstance)}`;

export const nodeTemplateLabelInGraph = (template: (typeof EFFECT_TEMPLATES)[number], circumstance?: EffectCircumstance): string => {
  return template.id === 'timer-emitter' && circumstance && circumstance !== 'persistent'
    ? 'Particle burst' : template.label;
};

export const TEMPLATE_GROUP: Record<EffectTemplateKind, string> = {
  container: 'Empty', node: 'Nodes', recipe: 'Recipes',
};

/** Everything in this group has been packed into an ISO, run on PS2 hardware by the test harness, and had
 *  the relevant result read back from the console. */
export const VALIDATED_GROUP = 'Validated';

/** The hover tier: the usage guidance, and then what hardware was seen to do. Both are optional and most
 *  templates carry neither — the visible summary is the whole story for them. */
export const templateHover = (template: { summary: string; detail?: string; proven?: EffectTemplateProof }): string =>
  [template.detail, template.proven && `Validated on PS2 — ${template.proven.observed}`]
    .filter(Boolean).join('\n\n') || template.summary;

/**
 * Add-effect / add-node buttons open the shared described menu instead of keeping a neighbouring combo box.
 *
 * The menu presents the WHOLE native vocabulary, and its running order is a confidence order rather than an
 * alphabet. First the templates a live PS2 run has demonstrated, because at the moment of choosing a node the
 * most useful thing to know is which ones are known to work on the console rather than only in the reader.
 * Then the rest of the vocabulary in three runs — an empty container to build in, the single nodes that are
 * the vocabulary, and the multi-node recipes whose parts are inert alone. Last, greyed, the nodes the editor
 * will not lay down, each carrying the reason on hover. Showing those is the point: an absent entry reads as
 * "SSX has no such thing", where a greyed one says what exists and what stands in the way.
 *
 * Every row shows its one-line summary beneath the label. Usage caveats and the hardware record stay in the
 * hover help so the menu stays scannable — a list this long is read by skimming.
 */
export const templatePicker = <T extends { id?: EffectTemplateId; label: string; summary: string; detail?: string;
  circumstance?: EffectCircumstance; kind?: EffectTemplateKind; proven?: EffectTemplateProof }>(
  triggerLabel: string,
  title: string,
  templates: readonly T[],
  onPick: (template: T) => void,
  labelFor: (template: T) => string = template => template.label,
): HTMLButtonElement => {
  const order: EffectTemplateKind[] = ['container', 'node', 'recipe'];
  const grouped = [...templates].sort((a, b) =>
    Number(!!b.proven) - Number(!!a.proven)
    || order.indexOf(a.kind ?? 'node') - order.indexOf(b.kind ?? 'node')
    || labelFor(a).localeCompare(labelFor(b)));
  const picker = menu(triggerLabel, [
    ...grouped.map(template => ({
      label: labelFor(template),
      detail: template.summary,
      desc: templateHover(template),
      group: template.proven ? VALIDATED_GROUP : TEMPLATE_GROUP[template.kind ?? 'node'],
      onClick: () => onPick(template),
    })),
    ...[...UNAUTHORABLE_EFFECT_NODES].sort((a, b) => a.label.localeCompare(b.label)).map(node => ({
      label: node.label,
      detail: node.reason,
      desc: `${node.semanticType} — ${node.reason}`,
      group: 'Not addable yet',
      disabled: true,
    })),
  ]);
  picker.el.classList.remove('sp-btn');
  picker.el.classList.add('sp-fx-btn', 'sp-fx-add-menu');
  picker.el.title = title;
  return picker.el;
};

export const treeActionMenu = (title: string, kind: 'effect' | 'node', items: MenuItem[]): HTMLButtonElement => {
  const actionMenu = menu('•••', items);
  actionMenu.el.type = 'button';
  actionMenu.el.classList.add('sp-fx-tree-menu', `sp-fx-tree-menu-${kind}`);
  actionMenu.el.title = title;
  actionMenu.el.setAttribute('aria-label', title);
  actionMenu.el.setAttribute('aria-haspopup', 'menu');
  return actionMenu.el;
};

export const EFFECT_NODE_TEMPLATES = EFFECT_TEMPLATES
  .filter((template): template is typeof template & { id: EffectNodeTemplateId } => !!template.nodes?.length)
  .sort((a, b) => a.label.localeCompare(b.label));

export const select = <T extends string>(value: T, options: readonly { value: T; label: string }[], change: (value: T) => void): HTMLSelectElement => {
  const out = el('select', 'sp-fx-input');
  for (const option of options) { const o = el('option'); o.value = option.value; o.textContent = option.label; out.appendChild(o); }
  out.value = value; out.onchange = () => change(out.value as T); return out;
};

export function effectNodeTree(bindings: readonly { circumstance: EffectCircumstance; graph: EffectGraph }[],
  current: EffectSelection | null, selectNode: (graph: EffectGraph, node: EffectNode) => void,
  displayNode: (node: EffectNode) => string = nodeDisplayName,
  addNodeControl?: (binding: { circumstance: EffectCircumstance; graph: EffectGraph }) => HTMLElement,
  rowActions?: {
    effect: (binding: { circumstance: EffectCircumstance; graph: EffectGraph }) => HTMLElement;
    node: (binding: { circumstance: EffectCircumstance; graph: EffectGraph }, node: EffectNode) => HTMLElement;
  }, selectGraph?: (graph: EffectGraph) => void, showNodes = true): HTMLElement {
  const tree = el('div', 'sp-fx-tree');
  if (bindings.length) tree.appendChild(el('div', 'sp-fx-tree-caption', showNodes ? 'Effects / Nodes' : 'Effects'));
  for (const binding of bindings) {
    const group = el('div', 'sp-fx-tree-group');
    const graphActive = current?.ownerKind === 'graph' && current.ownerId === binding.graph.id;
    const graphRow = selectGraph
      ? el('button', `sp-fx-attachment sp-fx-tree-effect sp-fx-tree-effect-select${graphActive ? ' on' : ''}`)
      : el('div', `sp-fx-attachment sp-fx-tree-effect${rowActions ? ' has-menu' : ''}`);
    if (graphRow instanceof HTMLButtonElement) {
      graphRow.type = 'button';
      graphRow.onclick = () => selectGraph?.(binding.graph);
    }
    graphRow.appendChild(el('span', 'sp-fx-list-name', effectGraphDisplayName(binding.graph, binding.circumstance)));
    if (rowActions) graphRow.appendChild(rowActions.effect(binding));
    group.appendChild(graphRow);
    if (showNodes) {
      for (const [index, node] of binding.graph.nodes.entries()) {
        const active = graphActive && current?.nodeId === node.id;
        const content = [
          el('span', 'sp-fx-node-index', String(index + 1)),
          el('span', 'sp-fx-node-name', displayNode === nodeDisplayName
            ? nodeDisplayNameForCircumstance(node, binding.circumstance) : displayNode(node)),
          el('span', 'sp-fx-kind', `M${node.mainType}`),
        ];
        if (rowActions) {
          const item = el('div', `sp-fx-node-row sp-fx-tree-node has-menu${active ? ' on' : ''}`);
          const select = el('button', 'sp-fx-tree-node-select');
          select.type = 'button'; select.onclick = () => selectNode(binding.graph, node);
          select.append(...content);
          item.append(select, rowActions.node(binding, node));
          group.appendChild(item);
        } else {
          const item = el('button', `sp-fx-node-row sp-fx-tree-node${active ? ' on' : ''}`);
          item.type = 'button'; item.onclick = () => selectNode(binding.graph, node);
          item.append(...content);
          group.appendChild(item);
        }
      }
      // An empty latch graph is the retail authored form, not missing content: the engine only tests
      // populated-ness, and its yes suppresses the default state revert [Trailmap: 150-logic §slot-columns].
      if (!binding.graph.nodes.length) group.appendChild(isEffectLatchCircumstance(binding.circumstance)
        ? el('div', 'sp-fx-empty sp-fx-tree-empty sp-fx-tree-latch',
          `⟨latch⟩ ${EFFECT_LATCH_SUMMARY[binding.circumstance]}`)
        : el('div', 'sp-fx-empty sp-fx-tree-empty', 'No nodes'));
      const addNode = addNodeControl?.(binding);
      if (addNode) {
        const create = el('div', 'sp-fx-node-add');
        create.appendChild(addNode);
        group.appendChild(create);
      }
    }
    tree.appendChild(group);
  }
  if (!tree.childElementCount) tree.appendChild(el('div', 'sp-fx-empty', 'This prop has no effects yet.'));
  return tree;
}

/**
 * Outgoing call branches: one selectable row per owning graph/function, whose nodes are deferred to the
 * selected-effect card below rather than inlined here. The prop's own effect rows in this same tree already
 * work that way, so a branch that listed its nodes in place was the only row reading as a different kind of
 * thing — and the only one that could not be opened.
 */
export function effectCallTree(
  incoming: ReturnType<typeof referenceIncomingEffectCalls>, current: EffectSelection | null,
  selectOwner: (entry: ReturnType<typeof referenceIncomingEffectCalls>[number]) => void): HTMLElement {
  const tree = el('div', 'sp-fx-tree');
  const groups = new Map<string, typeof incoming>();
  for (const entry of incoming) {
    const key = `${entry.ownerKind}:${entry.owner.id}`;
    const group = groups.get(key);
    if (group) group.push(entry); else groups.set(key, [entry]);
  }
  for (const entries of groups.values()) {
    const first = entries[0];
    const group = el('div', 'sp-fx-tree-group');
    const source = first.sources[0];
    // Say what kind of thing this row is, the way the effect rows beside it do. "Shared effect" is the word
    // the picker already uses for a function — its caller node is "Call shared effect" — so the row names
    // the other end of that node. The old "· from <prop>" tail is gone: `sources` is filtered to branches
    // this prop reaches, so it only ever named the prop already open, by a different field than the header.
    const ownerName = first.ownerKind === 'graph' && source
      ? effectGraphDisplayName(first.owner as EffectGraph, source.circumstance)
      : `Shared effect ${first.owner.name || first.owner.id}`;
    const active = current?.ownerKind === first.ownerKind && current.ownerId === first.owner.id;
    const graphRow = el('button',
      `sp-fx-attachment sp-fx-tree-effect sp-fx-tree-effect-select${active ? ' on' : ''}`);
    graphRow.type = 'button';
    graphRow.title = `Open ${ownerName} and list the props it acts on.`;
    graphRow.onclick = () => selectOwner(first);
    graphRow.append(el('span', 'sp-fx-list-name', ownerName),
      el('span', 'sp-fx-kind', countLabel(entries.length, 'call')));
    group.appendChild(graphRow);
    tree.appendChild(group);
  }
  return tree;
}
