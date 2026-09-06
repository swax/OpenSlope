import { brand, group, iconBar, label, menu, segmented, spacer } from '../components/controls';
import { tooltip } from '../components/tooltip';
import { MODE_ICON, HIST_ICON, MENU_ICON, USERS_ICON, VIEW_ICON } from '../components/icons';
import type { Mode, ShadeMode, Viewport } from '../../viewport/viewport';
import type { HistoryEntry } from '../../state/history';

/**
 * The top dock (#dock-top): the three clusters of the editor's chrome — the Slopesmith brand, File and
 * undo/redo on the left, the
 * Scene / Edit / Sculpt / Paint / Props / Effects / Test mode segment in the centre with Users beside it, and
 * the View controls on the right (the shade controls, the tile-orientation overlay, the Props / Tricks show
 * filters, the light cluster, and Frame map). It's pure wiring: every button's action and active/enabled state
 * is an injected callback into the host, and the objects the host repaints (the mode segment, history bar, the
 * show + lighting pills, and the view pills whose enabled states track the shade view) are handed back. The
 * toggle *behaviour* lives in the host — this module just lays out the bar and routes clicks.
 */

export type TopBarDeps = {
  viewport: Viewport;                         // read shade mode for the radio's active state (+ setShade writes it)
  applyCage: () => void;                      // re-derive the effective cage after a shade change (setShade)
  cageActive: () => boolean;                  // the EFFECTIVE cage: the toggle, or forced-on in Edit / with no solid view
  persistUi: () => void;                      // remember the shade choice (setShade)
  getMode: () => Mode;
  setMode: (m: Mode) => void;
  /** Current open project name; empty while no workspace mountain is open. */
  getMountainName: () => string;
  /** Loaded comparison level name; empty while no reference is loaded. */
  getReferenceName: () => string;
  /** Users mode (docs/038): its own mode, reached from beside the numbered row rather than inside it, so it
   *  costs neither a mode number nor a shortcut digit. */
  usersActive: () => boolean;
  toggleUsers: () => void;
  undo: () => void; redo: () => void;
  /** Passive save-state icon, seated immediately after the undo-history dropdown. */
  saveStatus: HTMLElement;
  canUndo: () => boolean; canRedo: () => boolean;
  undoSummary: () => string | null; redoSummary: () => string | null;
  recentUndo: () => string[]; recentRedo: () => string[];
  historyEntries: () => HistoryEntry[]; jumpHistory: (index: number) => void;
  toggleProps: () => void; getPropsVisible: () => boolean;
  toggleTricks: () => void; getTricksVisible: () => boolean;
  toggleWorldEffects: () => void; getWorldEffectsVisible: () => boolean;
  toggleLights: () => void; getLightRigVisible: () => boolean;
  toggleSunLight: () => void; getSunOn: () => boolean;
  toggleSkybox: () => void; getSkyboxVisible: () => boolean;
  toggleCage: () => void;
  toggleFOverlay: () => void; getFOverlayOn: () => boolean;
  focusActive: () => void;
  newMountainDialog: () => void;
  canCreateMountains: () => boolean;
  canManageMountain: () => boolean;
  openProjectDialog: () => void;
  historyDialog: () => void;
  renameMountain: () => void;
  closePreview: () => void; isPreviewing: () => boolean;
  conflictDialog: () => void; hasConflict: () => boolean;
  duplicateMountain: () => void;
  deleteMountain: () => void;
  exportMountain: () => void;
  importMountain: () => void;
  exportDialog: () => void;
  settingsDialog: () => void;
};

export function createTopBar(deps: TopBarDeps) {
  const { viewport, applyCage, cageActive, persistUi, getMode, setMode, getMountainName, getReferenceName, usersActive, toggleUsers,
    undo, redo, saveStatus, canUndo, canRedo,
    undoSummary, redoSummary, recentUndo, recentRedo, historyEntries, jumpHistory,
    toggleProps, getPropsVisible, toggleTricks, getTricksVisible, toggleWorldEffects, getWorldEffectsVisible,
    toggleLights, getLightRigVisible,
    toggleSunLight, getSunOn, toggleSkybox, getSkyboxVisible, toggleCage,
    toggleFOverlay, getFOverlayOn, focusActive, newMountainDialog, canCreateMountains, canManageMountain,
    openProjectDialog, historyDialog, renameMountain,
    closePreview, isPreviewing, conflictDialog, hasConflict, duplicateMountain, deleteMountain,
    exportMountain, importMountain, exportDialog, settingsDialog } = deps;

  const bar = document.getElementById('dock-top')!;
  // The bar opens with the app identity — mark + wordmark — and File beside it. The open mountain's name is
  // not repeated here: the URL carries it, and the browser tab title below follows it.
  const brandEl = brand('Slopesmith');
  const mountainName = () => getMountainName().trim() || 'Mountain';
  const referenceName = () => getReferenceName().trim() || 'Reference';
  const refreshMountainTitle = () => {
    const name = getMountainName().trim();
    document.title = name ? `${name} - Slopesmith` : 'Slopesmith';
  };
  refreshMountainTitle();

  // Mode switch: a compact row of icons (Scene / Edit / Sculpt / Paint / Props / Effects / Test). One line
  // and the 1–7 shortcut ride as the hover tooltip; the command sheet at the bottom teaches each mode's
  // controls, so the tips stay short.
  const modeSeg = segmented<Mode>(
    [
      { value: 'info', label: 'Scene', icon: MODE_ICON.info, title: 'Scene [1] — load a reference world and inspect lighting, sound, skybox, and course.' },
      { value: 'edit', label: 'Edit', icon: MODE_ICON.edit, title: 'Edit [2] — drag knots and corners to shape the mountain; Shift-drag for height.' },
      { value: 'sculpt', label: 'Sculpt', icon: MODE_ICON.sculpt, title: 'Sculpt [3] — brush the terrain: raise, lower, smooth, flatten, grab, push.' },
      { value: 'paint', label: 'Paint', icon: MODE_ICON.paint, title: 'Paint [4] — paint terrain textures, each with its ride feel.' },
      { value: 'props', label: 'Props', icon: MODE_ICON.props, title: 'Props [5] — select and place props.' },
      { value: 'effects', label: 'Effects', icon: MODE_ICON.effects, title: 'Effects [6] — author and inspect SSF effect graphs.' },
      { value: 'play', label: 'Test', icon: MODE_ICON.play, title: () => `Test [7] — ride ${mountainName()} or ${referenceName()} with the real carve physics.` },
    ],
    // Users mode is the server rather than the map, so while it holds the dock no numbered mode is lit — the
    // row reads as "none of these" rather than leaving the mode you were on looking active.
    () => usersActive() ? null : getMode(),
    m => setMode(m),
  );
  // Users, beside the numbered row rather than in it (docs/038): it costs no mode number and no shortcut
  // digit, and its list takes the right dock while it is on.
  const usersBar = iconBar([
    {
      icon: USERS_ICON, label: 'Users',
      title: 'Users — who is on this server, where they are, and account management.',
      onClick: toggleUsers, active: () => usersActive(),
    },
  ]);
  // Undo / redo as icons (HIST_ICON, ui/icons.ts), dimmed when there's no history to step through.
  const historyTip = (kind: 'Undo' | 'Redo', next: () => string | null, recent: () => string[], keys: string) => () => {
    const action = next();
    if (!action) return `${kind} (${keys}) · no ${kind.toLowerCase()} history`;
    const entries = recent().filter((entry, i) => i > 0 || entry !== action);
    return `${kind}: ${action} (${keys})${entries.length ? `\n\n${kind} history\n${entries.map((entry, i) => `${i + 1}. ${entry}`).join('\n')}` : ''}`;
  };
  const histBar = iconBar([
    { icon: HIST_ICON.undo, label: 'Undo', title: historyTip('Undo', undoSummary, recentUndo, 'Ctrl+Z'), onClick: undo, enabled: () => canUndo() },
    { icon: HIST_ICON.redo, label: 'Redo', title: historyTip('Redo', redoSummary, recentRedo, 'Ctrl+Y / Ctrl+Shift+Z'), onClick: redo, enabled: () => canRedo() },
  ]);
  const historyMenu = menu('', () => historyEntries().slice().reverse().map(entry => ({
    label: `${entry.index + 1}. ${entry.summary}`,
    desc: entry.current ? 'Current state'
      : entry.direction === 'past' ? 'Earlier · click to jump back'
      : 'Later · click to jump forward',
    checked: entry.current,
    onClick: entry.current ? undefined : () => jumpHistory(entry.index),
  })));
  historyMenu.el.classList.add('sp-history-menu');
  historyMenu.el.setAttribute('aria-label', 'Undo and redo history');
  tooltip(historyMenu.el, 'Undo / redo history · jump to any saved state');
  // View controls: [control cage · surface · textures] occupies the old shade group. Surface / Textures are
  // mutually exclusive, but clicking the active one turns the solid off; that cage-only state forces the cage
  // on. The cage itself remains independently selectable alongside either solid view outside Edit mode.
  const toggleShade = (m: Exclude<ShadeMode, 'none'>) => {
    viewport.shadeMode = viewport.shadeMode === m ? 'none' : m;
    applyCage();
    persistUi();
  };
  const viewShade = iconBar([
    { icon: VIEW_ICON.cage, label: 'Control cage', title: 'Control cage — show the Bézier control net. Always on in Edit mode.', onClick: toggleCage, active: () => cageActive(), enabled: () => viewport.shadeMode !== 'none' && getMode() !== 'edit' },
    { icon: VIEW_ICON.surface, label: 'Surface type', title: 'Surface type — colour the terrain by ride feel (snow / ice / rock …). Needs the sun on.', onClick: () => toggleShade('surface'), active: () => viewport.shadeMode === 'surface' },
    { icon: VIEW_ICON.textures, label: 'Textures', title: 'Textures — show the real terrain tiles.', onClick: () => toggleShade('textured'), active: () => viewport.shadeMode === 'textured' },
  ]);
  // Show group — Props / Tricks govern geometry; Effects enables recovered always-on world motion + emitters.
  const viewShow = iconBar([
    { icon: VIEW_ICON.props, label: 'Props', title: 'Props — show placed and reference props.', onClick: toggleProps, active: () => getPropsVisible() },
    { icon: VIEW_ICON.tricks, label: 'Tricks', title: 'Tricks — show grind rails and gem pickups, placed and reference.', onClick: toggleTricks, active: () => getTricksVisible() },
    { icon: VIEW_ICON.effects, label: 'Effects', title: 'Effects — animate world effects: water, signs, fog, and persistent emitters.', onClick: toggleWorldEffects, active: () => getWorldEffectsVisible() },
  ]);
  // World-presentation cluster — three top-level questions, with detailed controls kept in Scene:
  //  • Sources: compact clickable bulb/speaker markers for reference + authored lights and prop-attached
  //    external sounds. Clicking one bulb expands only that light's rig; clicking one speaker expands only
  //    that emitter's listener range.
  //  • Lighting: the complete lit result — sun + sky fill + shadow/AO and, when enabled in Scene ▸ Lighting,
  //    the course's local lights. Local lights are subordinate because their pools need the lit terrain.
  //  • Skybox: the backdrop belonging to the camera-nearest mountain; Test rides lock it to their target.
  // (The Add light button lives in the Prop Tools' add row with Add rail / Add gem — see addTrickRow.)
  const viewLighting = iconBar([
    { icon: VIEW_ICON.lights, label: 'Sources', title: 'Sources — show clickable markers at every light, sound emitter, and video screen.', onClick: toggleLights, active: () => getLightRigVisible() },
    { icon: VIEW_ICON.light, label: 'Lighting', title: 'Lighting — preview sun, sky fill, baked shadows, and local lights (tune in Scene ▸ Lighting).', onClick: toggleSunLight, active: () => getSunOn() },
    { icon: VIEW_ICON.skybox, label: 'Skybox', title: 'Skybox — show the backdrop for the nearest mountain; a Test ride stays locked to its target.', onClick: toggleSkybox, active: () => getSkyboxVisible() },
  ]);
  // Tile-orientation overlay, left of the shade controls. Patch/edge sub-cages live in Edit ▸ Visibility
  // as a focused, sticky working set, not a mountain-wide top-bar toggle. Reading the F glyphs: texture
  // rotation is stored relative to the patch, so pink parallel to green is 0° and the pair can be matched by
  // eye; a selected prop additionally shows green facing-normal arrows — the side the game lights from —
  // for comparing an authored prop against a shipped one.
  const viewOverlays = iconBar([
    { icon: VIEW_ICON.fGlyph, label: 'Orientation', title: 'Orientation — an F on every tile: pink = texture orientation, green = patch orientation.', onClick: toggleFOverlay, active: () => getFOverlayOn() },
  ]);
  const viewFrame = iconBar([
    { icon: VIEW_ICON.focus, label: 'Frame map', title: 'Frame the whole map — start upper-right, finish lower-left.', onClick: focusActive },
  ]);
  // The menu re-reads its items on every open, so the two entries that only mean something in a particular
  // state — a preview standing in for the project, a save refused because the project moved on — appear when
  // they apply and are the way back into a dialog the author dismissed.
  const fileMenu = menu('File', () => {
    const mayCreate = canCreateMountains();
    const currentMountain = mountainName();
    return [
      // Workspace-wide entries lead the menu ungrouped — the brand beside the trigger already says whose
      // workspace this is, so a "Slopesmith" heading over them would only repeat it.
      { label: 'New mountain…', desc: mayCreate
        ? 'Loft a new mountain around an editable starter course, or start from a blank slope.'
        : 'Creating a mountain requires the editor role.', disabled: !mayCreate, onClick: newMountainDialog },
      { label: 'Open mountain…', desc: 'Open another mountain from this Slopesmith workspace.', onClick: openProjectDialog },
      { label: 'Import mountain…', desc: mayCreate
        ? 'Import an editable .slopesmith.zip as a new mountain.'
        : 'Importing a mountain requires the editor role.', disabled: !mayCreate, onClick: importMountain },
      { label: 'Settings…', desc: 'Account, browser-local, application, and server settings.', onClick: settingsDialog },

      { group: currentMountain, label: 'History…', desc: 'Preview, restore or fork one of this mountain’s saved checkpoints.', onClick: historyDialog },
      ...(isPreviewing() ? [{ group: currentMountain, label: 'Close preview', desc: 'Stop previewing the checkpoint and reopen the mountain as it stands on disk.', onClick: closePreview }] : []),
      ...(hasConflict() ? [{ group: currentMountain, label: 'Resolve conflict…', desc: 'Another editor saved this mountain — choose whose version to keep.', onClick: conflictDialog }] : []),
      { group: currentMountain, label: 'Rename mountain…', desc: canManageMountain()
        ? 'Give this workspace mountain a new name.'
        : 'Only its owner or a moderator can rename this mountain.', disabled: !canManageMountain(), onClick: renameMountain },
      { group: currentMountain, label: 'Duplicate mountain…', desc: mayCreate
        ? 'Create a fast independent copy of this mountain on the same server.'
        : 'Duplicating a mountain requires the editor role.', disabled: !mayCreate, onClick: duplicateMountain },
      { group: currentMountain, label: 'Export mountain…', desc: 'Download an editable mountain ZIP with its mountain-local assets.', onClick: exportMountain },
      { group: currentMountain, label: 'Export map…', desc: 'See what this mountain ships, then write its portable map folder.', onClick: exportDialog },
      { group: currentMountain, label: 'Delete mountain…', desc: canManageMountain()
        ? `Permanently delete ${currentMountain}, its history, and its mountain-local assets.`
        : 'Only its owner or a moderator can delete this mountain.', disabled: !canManageMountain(), onClick: deleteMountain },
    ];
  }, { collapseIcon: MENU_ICON });
  // Narrow bars drop the word for the hamburger (CSS owns the breakpoint), so the button keeps a spoken name
  // and a tooltip of its own rather than relying on the label being legible.
  fileMenu.el.classList.add('sp-app-menu');
  fileMenu.el.setAttribute('aria-label', 'File menu');
  tooltip(fileMenu.el, 'File — open and manage mountains; Settings.');
  bar.append(
    group(brandEl),              // left: the mark + Slopesmith wordmark
    group(fileMenu.el),          // ...then File (a hamburger once the bar is narrow); Export lives in here
    group(histBar.el, historyMenu.el, saveStatus), // left: undo / redo + history dropdown, then passive save state
    spacer(),
    group(label('Mode')),        // labels the centre mode segment
    group(modeSeg.el),           // centre: Scene / Edit / Sculpt / Paint / Props (Add rail / gem / light live in the Prop Tools)
    group(usersBar.el),          // ...and Users beside them: the server rather than the map
    spacer(),
    group(label('View')),        // labels the right-side view controls
    group(viewOverlays.el),      // tile-orientation F overlay
    group(viewShade.el),         // control cage plus the Surface / Textures solid-view toggles
    group(viewShow.el),          // show group: Props · Tricks (placed + reference), right of the shade controls
    group(viewLighting.el),      // sources · complete lighting · nearest-mountain skybox
    group(viewFrame.el),         // frame map
  );

  // Handed back: the objects the host repaints on programmatic state changes (mode / history / show filters /
  // lighting pills) + the view pills refreshed by applyCage.
  return {
    modeSeg, usersBar, histBar, viewShow, viewLighting, viewOverlays, viewShade,
    refreshMountainTitle,
  };
}

export type TopBar = ReturnType<typeof createTopBar>;
