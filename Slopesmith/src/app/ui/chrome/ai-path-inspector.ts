import type GUI from 'lil-gui';
import type { RefAiPath, RefAiPathEvent } from '../../../core/reference/terrain';
import type { AuthoredAiPath } from '../../../core/doc/types';
import { hasAiPathNodeReselect, setAiPathNodeReselect } from '../../../core/doc/ai-paths';
import { aiPathMetrics } from '../../../core/reference/ai-paths';
import {
  AI_PATH_EVENT_SHAPE_PATHS,
  AI_PATH_RATING_COLORS,
  aiPathCssColor,
  aiPathEventStyle,
} from '../../ai-path-style';
import { clearGui, detail, note, tip } from '../components/gui';

/** Shared path inspector, with optional authored metadata/node editing. Source indices are identities. */
export function createAiPathInspector(
  folder: GUI,
  deps: {
    paths(): readonly RefAiPath[];
    visible(): boolean;
    setVisible(on: boolean): void;
    highlight(index: number | null): void;
    authored?: {
      editable(index: number): AuthoredAiPath | undefined;
      selectedNode(): number | null;
      editNodes(index: number, node: number, action: 'before' | 'after' | 'delete'): void;
      changed(): void;
      remove(id: string): void;
      options?(folder: GUI): void;
    };
  },
  displayFolder: GUI | null = folder,
) {
  let selected: number | null = null;
  const metres = (value: number) => `${value.toFixed(2)} m`;

  function eventSymbol(type: number) {
    const style = aiPathEventStyle(type);
    const symbol = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    symbol.setAttribute('viewBox', '0 0 32 32');
    symbol.setAttribute('aria-hidden', 'true');
    symbol.style.cssText = 'width:14px;height:14px;flex-shrink:0;vertical-align:middle';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', AI_PATH_EVENT_SHAPE_PATHS[style.shape]);
    path.setAttribute('fill', aiPathCssColor(style.color));
    symbol.appendChild(path);
    return symbol;
  }

  function eventDetail(parent: GUI, event: RefAiPathEvent, index: number) {
    const style = aiPathEventStyle(event.type);
    const eventFolder = parent.addFolder(`${index + 1}. ${style.name}`);
    const symbol = eventSymbol(event.type);
    symbol.style.marginRight = '5px';
    eventFolder.$title.prepend(symbol);
    detail(eventFolder, String(event.type), 'type');
    detail(eventFolder, String(event.value), 'raw value');
    detail(eventFolder, metres(event.start), 'start station');
    detail(eventFolder, metres(event.end), 'end station');
    if (event.type === 100) {
      detail(eventFolder, `${event.value >>> 2} km/h`, 'target speed');
      detail(eventFolder, event.value & 1 ? 'Yes' : 'No', 'trick flag A');
      detail(eventFolder, event.value & 2 ? 'Yes' : 'No', 'trick flag B');
    } else if (event.type === 101) {
      detail(eventFolder, `${event.value} km/h`, 'cruise target');
    } else if (event.type === 102) {
      note(
        eventFolder,
        'A presence checker exists, but no active caller was found in the inspected US or PAL Tricky builds. Its original purpose remains unknown.',
      );
    } else if (event.type === 300) {
      note(
        eventFolder,
        'Re-evaluates nearby paths when the rider crosses this point or region. The current path may still win; the raw value does not specify a destination.',
      );
    }
    eventFolder.close();
  }

  function rebuild() {
    clearGui(folder);
    if (displayFolder && displayFolder !== folder) clearGui(displayFolder);
    deps.authored?.options?.(folder);
    const paths = deps.paths();
    const path = paths.find(candidate => candidate.originalIndex === selected);
    if (selected !== null && !path) {
      selected = null;
      deps.highlight(null);
    }
    if (displayFolder) {
      const state = {
        get visible() {
          return deps.visible();
        },
        set visible(on: boolean) {
          deps.setVisible(on);
        },
      };
      displayFolder.add(state, 'visible').name('show AI paths').listen();
      const legend = note(displayFolder, 'Rating: 0 (green) → 50 (orange) → 100 (red). Dashed = not respawnable.');
      const ramp = document.createElement('div');
      ramp.style.cssText = `height:5px;margin-top:6px;border-radius:3px;background:linear-gradient(to right,${AI_PATH_RATING_COLORS.map(aiPathCssColor).join(',')})`;
      ramp.setAttribute('role', 'img');
      ramp.setAttribute('aria-label', 'Path colour by line rating: green 0, orange 50, red 100');
      legend.appendChild(ramp);
      const eventCaption = document.createElement('div');
      eventCaption.style.marginTop = '6px';
      eventCaption.textContent = 'Event spans on all paths. Numbers identify events on the selected path.';
      legend.appendChild(eventCaption);
      const colors = document.createElement('div');
      colors.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:6px';
      for (const type of [100, 101, 103, 300, 102, -1]) {
        const item = document.createElement('span');
        item.style.cssText = 'display:inline-flex;align-items:center;gap:4px';
        item.append(eventSymbol(type), type === 103 ? 'Reset regions' : aiPathEventStyle(type).name);
        colors.appendChild(item);
      }
      legend.appendChild(colors);
    }
    if (!paths.length) {
      note(
        folder,
        deps.authored
          ? 'Record an AI run in Test, then click a path in the viewport to inspect it.'
          : 'Load a reference mountain with AI paths to inspect its routes.',
      );
      return;
    }
    note(folder, `${paths.length} paths. Click a visible path to inspect its events and properties.`);
    if (!path) return;

    const editable = deps.authored?.editable(path.originalIndex);
    if (deps.authored) {
      const properties = folder.addFolder('AI path');
      if (editable) {
        properties.add(editable, 'name').name('name').onFinishChange(deps.authored.changed);
        tip(
          properties.add(editable, 'rating', 0, 100, 1).name('line rating').onFinishChange(deps.authored.changed),
          'A preference used when the AI chooses a path. Give fork branches different ratings to suit different rider moods.',
          'Equal ratings usually favor the closest route, including the current path. Reselection is scored rather than a random split; the rider’s board class, placement, boost meter and skill determine its preferred rating.',
        );
        properties.add(editable, 'respawnable').onChange(deps.authored.changed);
        note(properties, 'Click a node to move it with the gizmo, insert a neighboring node, or delete it.');
        const node = deps.authored.selectedNode();
        if (node !== null && editable.points[node]) {
          detail(properties, String(node + 1), 'selected node');
          for (const [axis, index] of ['X', 'Y', 'Z'].map((axis, index) => [axis, index] as const))
            properties
              .add(
                {
                  get value() {
                    return deps.authored?.editable(path.originalIndex)?.points[node]?.[index] ?? 0;
                  },
                },
                'value',
              )
              .name(`${axis} (m)`)
              .decimals(2)
              .listen()
              .disable();
          const state = {
            get reselect() {
              const current = deps.authored!.editable(path.originalIndex);
              return !!current && hasAiPathNodeReselect(current, node);
            },
            set reselect(on: boolean) {
              const current = deps.authored!.editable(path.originalIndex);
              if (current) current.events = setAiPathNodeReselect(current, node, on).events;
            },
          };
          tip(
            properties
              .add(state, 'reselect')
              .name('Reselect path here')
              .listen()
              .onChange(() => {
                deps.authored!.changed();
                rebuild();
              }),
            'Reconsider nearby paths when the AI crosses this node. The current path can still win. Turn off to remove this point event.',
          );
          for (const action of ['before', 'after'] as const) {
            const control = properties
              .add({ insert: () => deps.authored!.editNodes(path.originalIndex, node, action) }, 'insert')
              .name(`Insert node ${action}`);
            if (
              (action === 'before' ? node === 0 : node === editable.points.length - 1) ||
              editable.points.length >= 100000
            )
              control.disable();
            tip(
              control,
              `Insert halfway between this node and the ${action === 'before' ? 'previous' : 'next'} one, then select the new node.`,
            );
          }
          const remove = properties
            .add({ remove: () => deps.authored!.editNodes(path.originalIndex, node, 'delete') }, 'remove')
            .name('Delete node');
          if (editable.points.length <= 2) remove.disable();
          tip(
            remove,
            'Remove this node and its reselect flag. Event ranges follow the remaining geometry. A path must keep at least two nodes.',
          );
        }
        properties.add({ remove: () => deps.authored!.remove(editable.id) }, 'remove').name('delete path');
      } else {
        detail(properties, path.name, 'name');
        detail(properties, `${path.rating} / 100`, 'line rating');
        note(
          properties,
          'Automatically generated from the course. Edit the course or record a run to author a custom path.',
        );
      }
    }

    const events = folder.addFolder(`Events (${path.events.length})`);
    note(
      events,
      'Numbered markers match this list; coloured spans show event ranges. Stations use horizontal metres.',
      'Labels describe observed SSX Tricky behavior, rather than recovered original names. Meanings in other games are unconfirmed. Type 102 remains unidentified.',
    );
    if (!path.events.length) note(events, 'This path has no events.');
    path.events.forEach((event, i) => eventDetail(events, event, i));

    if (!deps.authored) {
      const referencePath = folder.addFolder('Reference path');
      detail(referencePath, path.name, 'name');
      detail(referencePath, String(path.originalIndex), 'source index');
      tip(
        detail(referencePath, `${path.rating} / 100`, 'line rating'),
        'Matched against an AI rider’s current mood when it chooses a path.',
        'A selection preference, influenced by boost, placement and skill; it is not a speed limit.',
      );
      detail(referencePath, path.respawnable ? 'Yes' : 'No', 'respawnable');
      tip(
        detail(
          referencePath,
          path.startSlots.length ? path.startSlots.map(slot => slot + 1).join(', ') : 'None',
          'start-grid slots',
        ),
        'Grid slots initialized on this path. Riders choose from shared paths as they descend.',
      );
    }

    const geometry = folder.addFolder('Geometry');
    const metrics = aiPathMetrics(path.points);
    tip(
      detail(geometry, metres(metrics.length), 'length'),
      'Horizontal path length, using the same distance scale as event stations.',
    );
    detail(geometry, String(metrics.segments), 'segments');
    detail(geometry, metres(metrics.average), 'avg segment length');
  }

  function select(index: number | null) {
    const next = deps.paths().some(path => path.originalIndex === index) ? index : null;
    if (selected === next) return;
    selected = next;
    deps.highlight(next);
    rebuild();
  }

  function reset() {
    selected = null;
    deps.highlight(null);
    rebuild();
  }

  return { select, reset, rebuild };
}
