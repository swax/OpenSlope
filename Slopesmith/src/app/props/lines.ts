import type { AuthoredModel, PlacedProp, PropLine, PropLineTemplate, PropSheet, V3 } from '../../core/doc/types';
import { applyBehaviour, baselineBehaviour } from '../../core/props/defaults';
import {
  footprintOfRawBox, groupFootprint, layoutPropLine, lineMemberId, lineMembers, lineNominalSpacing, membersOfLine,
  nextPropLineId, replaceLineMembers, type LineFootprint,
} from '../../core/props/prop-line';
import {
  sheetPieces, SHEET_DEFAULT_HEIGHT, SHEET_DEFAULT_SPAN, type SheetFamily,
} from '../../core/props/sheet-prop';
import { AUTHORED_MODEL_LEVEL, modelNumber, nextModelId } from '../../core/doc/models';
import { attachEffectToProp, detachEffectFromProp, effectAttachments } from '../../core/effects/authoring';
import type { GroupDef } from '../../core/reference/groups';
import type { ArmedProp, Store } from '../state/store';
import type { Viewport } from '../viewport/viewport';
import type { PropOps } from './operations';
import { dropScreensForProp } from './screens';
import { toast } from '../ui/components/toast';

/**
 * Prop lines (docs/070): the app half of a path that owns a row of placements.
 *
 * A line is started from a HELD prop — its model, its settings and its effect are what every member copies — and
 * drawn like a rail, a click per node. From then on every change to the path or a setting throws the members
 * away and lays them out again (`relayout`), so the members are never edited on their own: a click on one
 * selects the line, and "break into props" is the way out for the one-off tweak.
 *
 * A line under two nodes has nothing to lay out, so while it is being drawn it lives here rather than in the
 * document, and joins it with its second node. Abandoning the draw — another tool, an undo — leaves nothing
 * behind, which is the rule `discardUnfinishedRail` enforces for rails by hand.
 */

export type PropLineOpsDeps = {
  store: Store;
  viewport: Viewport;
  propOps: PropOps;
  groupDefIdx: Map<string, GroupDef>;
  setPropLibWanted: (want: boolean) => void;
  scheduleRebuild: () => void;
  rebuildTools: () => void;
  updateCmdSheet: () => void;
};

/** Longest span a picked lying sheet starts with (docs/071). */
const LIE_SPAN_CAP = 16;

/** The held prop a line is being drawn from: what its first members are stamped with. */
type Drawing = { line: PropLine & { id: string }; armed: ArmedProp };

export function createPropLineOps(deps: PropLineOpsDeps) {
  const { store, viewport, propOps, groupDefIdx, setPropLibWanted, scheduleRebuild, rebuildTools, updateCmdSheet } = deps;
  let drawing: Drawing | null = null;

  /** The line with this id — in the document, or the one still being drawn. */
  function lineById(id: string | null): (PropLine & { id: string }) | undefined {
    if (id === null) return undefined;
    if (drawing?.line.id === id) return drawing.line;
    return store.mdoc.propLines?.find(line => line.id === id) as (PropLine & { id: string }) | undefined;
  }

  /** The selected line, if any. */
  const selected = () => lineById(store.selectedLine);

  /** The draw in progress, while the store still says we are drawing it; a stale one (another tool took over,
   *  or an undo reset the selection) is forgotten here rather than chased from every place that ends a draw. */
  function liveDrawing(): Drawing | null {
    if (drawing && !(store.lineDrawing && store.selectedLine === drawing.line.id)) drawing = null;
    return drawing;
  }

  /** Every line the viewport should know about: the document's, and a line still being drawn. */
  function displayLines(): PropLine[] {
    const lines = store.mdoc.propLines ?? [];
    const draft = liveDrawing();
    return draft && !lines.includes(draft.line) ? [...lines, draft.line] : lines;
  }

  /**
   * The model's footprint (docs/070): its box, or a group's members boxed together. Null until the geometry —
   * and for a group its mined def — has loaded, in which case a re-layout leaves the members as they stand.
   */
  function footprintOf(template: PropLineTemplate): LineFootprint | null {
    if (!template.group) {
      const box = propOps.authoredBoxOf(template.level, template.model);
      return box ? footprintOfRawBox(box) : null;
    }
    const def = groupDefIdx.get(`${template.level}:${template.group}`);
    if (!def) return null;
    const members = def.props.map(member => {
      const box = propOps.authoredBoxOf(template.level, member.model);
      return box ? { footprint: footprintOfRawBox(box), relPos: member.relPos, relYaw: member.relYaw } : null;
    });
    return members.every(member => member) ? groupFootprint(members as NonNullable<typeof members[number]>[]) : null;
  }

  /** The spacing the line asks for before the fit — what the panel shows beside the count. */
  function nominalSpacing(line: PropLine): number | null {
    const footprint = footprintOf(line.template);
    return footprint ? lineNominalSpacing(line, footprint) : null;
  }

  const ground = (x: number, z: number, nearY: number) => viewport.groundHeightAt(x, z, nearY);

  /** The pieces a sheet owns (docs/071), in span order. */
  const piecesOf = (lineId: string): AuthoredModel[] => (store.mdoc.models ?? []).filter(model => model.line === lineId);

  /**
   * A SHEET's members (docs/071): cut the sheet into its pieces and give each span a one-quad tiled model of its
   * own — reusing the sheet's existing piece models in order, minting new ones, dropping the surplus — and one
   * placement of it at its anchor, carrying the sheet's template behaviour.
   */
  function sheetMembers(line: PropLine & { id: string; sheet: PropSheet }): PlacedProp[] {
    const pieces = sheetPieces(line, ground);
    const models = (store.mdoc.models ??= []);
    const owned = piecesOf(line.id);
    const sheet = line.sheet;
    const ids = pieces.map((piece, k) => {
      let model = owned[k];
      if (!model) {
        model = { id: nextModelId(models), name: '', anchor: [0, 0, 0], vertices: [], quads: [], line: line.id };
        models.push(model);
      }
      model.name = `${line.template.name} · ${k + 1}`;
      model.anchor = piece.anchor;
      model.vertices = piece.vertices;
      model.quads = piece.quads;
      if (sheet.texture) model.texture = sheet.texture; else delete model.texture;
      if (sheet.blend) model.blend = true; else delete model.blend;
      if (sheet.orient && (sheet.orient.rot || sheet.orient.mirror)) model.orient = { ...sheet.orient }; else delete model.orient;
      return model.id;
    });
    const surplus = new Set(owned.slice(pieces.length));
    if (surplus.size) store.mdoc.models = models.filter(model => !surplus.has(model));
    return pieces.map((piece, k) => ({
      id: lineMemberId(line.id, k),
      ...structuredClone(line.template),
      level: AUTHORED_MODEL_LEVEL,
      model: modelNumber(ids[k]),
      line: line.id,
      pos: piece.anchor,
      yaw: 0,
      scale: 1,
    }));
  }

  /** A LINE's members: a copy of the template's model at each pose. Null until the model's geometry has loaded. */
  function copyMembers(line: PropLine & { id: string }): PlacedProp[] | null {
    const footprint = footprintOf(line.template);
    return footprint ? lineMembers(line, layoutPropLine(line, footprint, ground)) : null;
  }

  /**
   * Lay one line's members out again from its path and settings, and move the attachments with them: a member
   * that leaves takes its effect attachment and any screen fitted to it; a member that arrives gets the effect
   * its siblings share — or, on a line still being drawn, the held prop's.
   */
  function relayout(line: PropLine & { id: string }): boolean {
    const members = line.sheet ? sheetMembers(line as PropLine & { id: string; sheet: PropSheet }) : copyMembers(line);
    if (!members) return false;
    const props = (store.mdoc.props ??= []);
    const { removed, added } = replaceLineMembers(props, line.id, members);
    const effects = store.mdoc.effects;
    for (const id of removed) {
      if (effects) detachEffectFromProp(effects, id);
      dropScreensForProp(store.mdoc, id);
    }
    if (added.length) {
      const arrived = new Set(added);
      const sibling = membersOfLine(props, line.id).find(member => !arrived.has(member.id!));
      const shared = sibling && effects
        ? effectAttachments(effects).filter(item => item.enabled && item.target.id === sibling.id) : [];
      if (shared.length) {
        for (const id of added) for (const item of shared) attachEffectToProp(effects!, id, item.slot, item.circumstance);
      } else if (drawing?.line === line) {
        for (const id of added) propOps.stampHeldEffects(id, drawing.armed);
      }
    }
    return true;
  }

  /** A line's setting changed in the panel: lay it out again and redraw. */
  function changed(line: PropLine & { id: string }) {
    relayout(line);
    scheduleRebuild();
  }

  // ---- drawing ------------------------------------------------------------------------------------------------

  /**
   * Start a line from the HELD prop: its model, settings and effect become the line's, the prop is put down,
   * and ground clicks lay the path until Enter / Esc. The held size (Shift+wheel) is the line's scale.
   */
  function startLine() {
    const armed = store.armedProp;
    if (!armed) return;
    const template = applyBehaviour<PropLineTemplate>({
      level: armed.level, model: armed.model, name: armed.name, ...(armed.group ? { group: armed.group } : {}),
    }, armed.behaviour);
    beginDraw({ template, scale: viewport.props.pendingScale }, armed);
    toast(`click the mountain to lay the line — ${propOps.shortPropName(armed.name)} follows it · Enter / Esc finishes`, 'info');
  }

  /**
   * Start a SHEET (docs/071) with `armed`'s behaviour and effect — the representative piece's, for a sheet picked
   * in the Prop Library — and the look the sheet names. Drawing begins at once: a sheet has no ghost to hold.
   */
  function startSheet(armed: ArmedProp, name: string, sheet: PropSheet, span: number) {
    const template = applyBehaviour<PropLineTemplate>({ level: AUTHORED_MODEL_LEVEL, model: 0, name }, armed.behaviour);
    beginDraw({ template, scale: 1, spacing: span, sheet }, armed);
    toast(`click the mountain to lay the ${name} sheet · Enter / Esc finishes`, 'info');
  }

  /**
   * A sheet picked in the Prop Library: pick up its representative piece exactly as middle-clicking that
   * reference instance would — its contact, hit sound and portable effect (docs/069) — and start a sheet that
   * wears the family's tile at its typical size and span.
   */
  function pickSheet(level: string, family: SheetFamily) {
    propOps.interceptNextPick(armed => {
      // A shipped river's pieces run ~45 m; chords that long would cut the corners of a winding new one.
      const span = family.lie ? Math.min(family.span, LIE_SPAN_CAP) : family.span;
      startSheet(armed, family.key.replace(/^(Mdl|Fnc)_/, ''), {
        ...(family.lie ? { lie: true } : {}),
        size: Math.round(family.size * 100) / 100,
        ...(family.texture ? { texture: family.texture } : {}),
        ...(family.blend ? { blend: true } : {}),
      }, Math.round(span * 100) / 100);
      return true;
    });
    void propOps.armProp(level, family.representative.model, family.key, { sourceIndex: family.representative.sourceIndex });
  }

  /** The launcher's Add sheet: a blank standing sheet, untextured, to be given a tile in its panel. */
  function startBlankSheet() {
    const armed: ArmedProp = { level: AUTHORED_MODEL_LEVEL, model: 0, name: 'Sheet', from: 'defaults',
      behaviour: baselineBehaviour(AUTHORED_MODEL_LEVEL) };
    startSheet(armed, 'Sheet', { size: SHEET_DEFAULT_HEIGHT }, SHEET_DEFAULT_SPAN);
  }

  /** Put a new line or sheet in hand and start drawing its path: whatever was held is put down. */
  function beginDraw(fields: Pick<PropLine, 'template' | 'scale' | 'spacing' | 'sheet'>, armed: ArmedProp) {
    const lines = store.mdoc.propLines ?? [];
    drawing = { line: { id: nextPropLineId(lines), nodes: [], ...fields }, armed: structuredClone(armed) };
    store.armedProp = null;
    viewport.setPropArmed(null);
    store.selectedProp = null; store.multiSel = [];
    store.selectedLine = drawing.line.id;
    store.selectedLineNode = null;
    store.lineDrawing = true;
    viewport.setLineDrawing(true);
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
  }

  /** A ground click while drawing: append a node. The second node puts the line in the document. */
  function appendNode(pos: V3) {
    const line = selected();
    if (!line || !store.lineDrawing) return;
    line.nodes.push(pos);
    const lines = (store.mdoc.propLines ??= []);
    if (line.nodes.length >= 2 && !lines.includes(line)) lines.push(line);
    store.selectedLineNode = null; // keep the gizmo off the last node so it does not catch the next click
    if (line.nodes.length >= 2) relayout(line);
    scheduleRebuild();
    rebuildTools(); // the member count moved
  }

  /** Stop drawing. A line that never got its second node was never in the document, and is simply dropped. */
  function finishLine() {
    const draft = liveDrawing();
    store.lineDrawing = false;
    viewport.setLineDrawing(false);
    drawing = null;
    if (draft && !(store.mdoc.propLines ?? []).includes(draft.line)) leaveLine();
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
  }

  /** Lay more nodes onto the end of the selected line (the panel's "add more points"). The effect new members
   *  get is their siblings', so no held prop is needed to resume. */
  function resumeLine() {
    const line = selected();
    if (!line) return;
    store.selectedLineNode = null;
    store.lineDrawing = true;
    viewport.setLineDrawing(true);
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
    toast('click the mountain to add more points — Enter / Esc to finish', 'info');
  }

  // ---- editing ------------------------------------------------------------------------------------------------

  /** A node was dragged: it stays on the ground under where it was dropped, and the line lays out again. */
  function moveNode(id: string, node: number, pos: V3) {
    const line = lineById(id);
    if (!line?.nodes[node]) return;
    line.nodes[node] = [pos[0], viewport.groundHeightAt(pos[0], pos[2], pos[1]) ?? pos[1], pos[2]];
    relayout(line);
    scheduleRebuild();
  }

  /** Remove the selected node; a line left under two nodes has nothing to lay out and goes entirely. */
  function deleteSelectedNode() {
    const line = selected();
    if (!line || store.selectedLineNode === null) return;
    line.nodes.splice(store.selectedLineNode, 1);
    store.selectedLineNode = null;
    if (line.nodes.length < 2) { removeLine(line); leaveLine(); }
    else relayout(line);
    scheduleRebuild(); rebuildTools();
  }

  /** Remove the selected line and every member it laid out. */
  function deleteSelectedLine() {
    const line = selected();
    if (!line) return;
    removeLine(line);
    leaveLine();
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
  }

  /** Take a line out of the document along with its members (and their attachments) — and a sheet's pieces. */
  function removeLine(line: PropLine & { id: string }) {
    const props = store.mdoc.props ?? [];
    const { removed } = replaceLineMembers(props, line.id, []);
    for (const id of removed) {
      if (store.mdoc.effects) detachEffectFromProp(store.mdoc.effects, id);
      dropScreensForProp(store.mdoc, id);
    }
    if (store.mdoc.models?.some(model => model.line === line.id))
      store.mdoc.models = store.mdoc.models.filter(model => model.line !== line.id);
    store.mdoc.propLines = (store.mdoc.propLines ?? []).filter(other => other !== line);
    if (drawing?.line === line) drawing = null;
  }

  /**
   * Break the line into props: its members stay exactly where they stand but belong to nothing, so each can
   * be moved, turned or deleted on its own — and the line, with its path, is gone.
   */
  function breakLine() {
    const line = selected();
    if (!line) return;
    const members = membersOfLine(store.mdoc.props, line.id);
    for (const member of members) delete member.line;
    // A sheet's pieces become the author's own tiled props, listed and editable like any other (docs/071).
    for (const model of piecesOf(line.id)) delete model.line;
    store.mdoc.propLines = (store.mdoc.propLines ?? []).filter(other => other !== line);
    leaveLine();
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
    toast(`${members.length} ${line.sheet ? 'piece' : 'prop'}${members.length === 1 ? '' : 's'} on their own now `
      + `— undo puts the ${line.sheet ? 'sheet' : 'line'} back.`, 'ok');
  }

  /**
   * Swap the line's prop: the next prop picked up — from the Library, or middle-clicked in the world — becomes
   * the line's model, with that pick's settings and effect, and every member is laid out afresh as it.
   */
  function swapProp() {
    const line = selected();
    if (!line) return;
    propOps.interceptNextPick(armed => {
      const target = lineById(line.id);
      if (!target) return false;
      // Every member goes and comes back as the new model, so each gets the new pick's effect rather than
      // keeping the old model's under the same id.
      removeMembers(target);
      target.template = applyBehaviour<PropLineTemplate>({
        level: armed.level, model: armed.model, name: armed.name, ...(armed.group ? { group: armed.group } : {}),
      }, armed.behaviour);
      const swapping: Drawing = { line: target, armed };
      const held = drawing;
      drawing = swapping;
      relayout(target);
      drawing = held;
      scheduleRebuild(); rebuildTools();
      toast(`The line is ${propOps.shortPropName(armed.name)} now.`, 'ok');
      return true;
    });
    setPropLibWanted(true);
    toast('Pick a prop in the Prop Library — or middle-click one in the world — and the line takes it.', 'info');
  }

  /** Drop every member of a line (with their attachments) without touching the line itself. */
  function removeMembers(line: PropLine & { id: string }) {
    const { removed } = replaceLineMembers(store.mdoc.props ?? [], line.id, []);
    for (const id of removed) {
      if (store.mdoc.effects) detachEffectFromProp(store.mdoc.effects, id);
      dropScreensForProp(store.mdoc, id);
    }
  }

  /** Let go of the selected line: nothing selected, nothing being drawn, no swap waiting on the library. */
  function leaveLine() {
    store.selectedLine = null;
    store.selectedLineNode = null;
    store.lineDrawing = false;
    viewport.setLineDrawing(false);
    propOps.interceptNextPick(null);
    drawing = null;
  }

  return {
    lineById, selected, displayLines, footprintOf, nominalSpacing, relayout, changed,
    startLine, pickSheet, startBlankSheet, appendNode, finishLine, resumeLine,
    moveNode, deleteSelectedNode, deleteSelectedLine, breakLine, swapProp, leaveLine,
  };
}

export type PropLineOps = ReturnType<typeof createPropLineOps>;
