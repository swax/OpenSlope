import type { ReferenceMusicGraph, ReferenceMusicNode, ReferenceMusicSummary } from '../../../core/reference/music';
import {
  decodeMusicLink, musicEventRoutes, musicNodeKind, musicNodeSection, musicWalkAtLevel,
} from '../../../core/reference/music';
import { fetchJson } from '../../net/fetch-json';
import { auditionReferenceMusicWalk, stopAudition } from '../components/audition';

const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] =>
  document.createElementNS(SVG_NS, tag);

function button(label: string, title: string, action: () => void, className = ''): HTMLButtonElement {
  const out = document.createElement('button');
  out.type = 'button';
  out.className = `sp-btn ${className}`.trim();
  out.textContent = label;
  out.title = title;
  out.onclick = action;
  return out;
}

const seconds = (value: number): string => value >= 60
  ? `${Math.floor(value / 60)}m ${(value % 60).toFixed(1)}s`
  : `${value.toFixed(2)}s`;

function sectionText(sections: number[], total: number): string {
  if (sections.length === total) return 'all sections';
  return `section${sections.length === 1 ? '' : 's'} ${sections.join(', ')}`;
}

/** Full-screen, read-only PathFinder graph study. The layout is intentionally a long score: native node index
 * runs left-to-right while authored section is a lane. That makes loops, conditional alternatives and event
 * jumps visible without a force-layout randomly moving the same reference between openings. */
export function openMusicGraphDialog(level: string, song: ReferenceMusicSummary): void {
  const back = document.createElement('div');
  back.className = 'sp-modal-back sp-music-graph-back';
  const modal = document.createElement('section');
  modal.className = 'sp-music-graph-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', `${song.title} PathFinder graph`);
  back.appendChild(modal);

  const header = document.createElement('header');
  header.className = 'sp-music-graph-head';
  const heading = document.createElement('div');
  const title = document.createElement('h2'); title.textContent = `${song.title} · music graph`;
  const sub = document.createElement('p');
  sub.textContent = `${level} · ${song.bpm.toFixed(1)} BPM · ${song.nodes} nodes · ${song.samples} samples · ${song.sections} sections · ${song.events} events`;
  heading.append(title, sub);
  const closeButton = button('✕', 'Close music graph', () => close(), 'sp-music-graph-close');
  header.append(heading, closeButton);
  modal.appendChild(header);

  const toolbar = document.createElement('div');
  toolbar.className = 'sp-music-graph-toolbar';
  const hint = document.createElement('span'); hint.textContent = 'Click a dot for its native record · click an event to jump to its router target';
  const toolActions = document.createElement('div');
  toolbar.append(hint, toolActions);
  modal.appendChild(toolbar);

  const loading = document.createElement('div');
  loading.className = 'sp-music-graph-loading';
  loading.textContent = 'Loading extracted graph…';
  modal.appendChild(loading);
  document.body.appendChild(back);

  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', event => { if (event.target === back) close(); });
  function close() {
    document.removeEventListener('keydown', onKey);
    stopAudition();
    back.remove();
  }

  void fetchJson<ReferenceMusicGraph>(`/api/reference-music?level=${encodeURIComponent(level)}&song=${encodeURIComponent(song.id)}`)
    .then(graph => render(graph))
    .catch(error => {
      loading.classList.add('error');
      loading.textContent = `Could not load graph: ${error instanceof Error ? error.message : String(error)}`;
    });

  function render(graph: ReferenceMusicGraph) {
    loading.remove();
    const routes = musicEventRoutes(graph);
    const byTarget = new Map<number, typeof routes>();
    for (const route of routes) {
      const list = byTarget.get(route.target) ?? [];
      list.push(route);
      byTarget.set(route.target, list);
    }

    const body = document.createElement('div');
    body.className = 'sp-music-graph-body';
    const side = document.createElement('aside');
    side.className = 'sp-music-graph-side';
    const viewport = document.createElement('div');
    viewport.className = 'sp-music-graph-view';
    body.append(side, viewport);
    modal.appendChild(body);

    const explainer = document.createElement('p');
    explainer.className = 'sp-music-graph-explainer';
    explainer.textContent = 'The walker drains one short sample, then follows a link selected by path level. Gameplay events use the table below to route directly to another node.';
    side.appendChild(explainer);

    const legend = document.createElement('div');
    legend.className = 'sp-music-graph-legend';
    for (const [kind, label] of [['audio', 'audio sample'], ['marker', 'control / sync'], ['loop', 'loop counter'], ['event', 'event target']] as const) {
      const item = document.createElement('span');
      const dot = document.createElement('i'); dot.className = `kind-${kind}`;
      item.append(dot, label); legend.appendChild(item);
    }
    side.appendChild(legend);

    const eventTitle = document.createElement('h3'); eventTitle.textContent = `Event routes (${routes.length})`;
    side.appendChild(eventTitle);
    const eventList = document.createElement('div');
    eventList.className = 'sp-music-event-list';
    side.appendChild(eventList);

    const inspectorTitle = document.createElement('h3'); inspectorTitle.textContent = 'Selected node';
    const inspector = document.createElement('div'); inspector.className = 'sp-music-node-inspector';
    side.append(inspectorTitle, inspector);

    const normalSections = [...new Set(graph.Nodes.map(musicNodeSection).filter(section => section < 0x7f))].sort((a, b) => a - b);
    const hasLoopLane = graph.Nodes.some(node => musicNodeSection(node) === 0x7f);
    const lanes = [...normalSections, ...(hasLoopLane ? [0x7f] : [])];
    const laneIndex = new Map(lanes.map((value, index) => [value, index]));
    const xStep = 30, yStep = 88, left = 92, top = 66;
    const worldWidth = Math.max(720, left * 2 + Math.max(1, graph.Nodes.length - 1) * xStep);
    const worldHeight = Math.max(360, top * 2 + Math.max(1, lanes.length - 1) * yStep);
    const positions = graph.Nodes.map(node => ({
      x: left + node.Index * xStep,
      y: top + (laneIndex.get(musicNodeSection(node)) ?? 0) * yStep,
    }));

    const diagram = svg('svg');
    diagram.classList.add('sp-music-graph-svg');
    diagram.setAttribute('viewBox', `0 0 ${worldWidth} ${worldHeight}`);
    diagram.setAttribute('aria-label', `${graph.Song} PathFinder node graph`);
    diagram.setAttribute('role', 'img');
    viewport.appendChild(diagram);

    const defs = svg('defs');
    const marker = svg('marker');
    marker.id = `music-arrow-${Math.random().toString(36).slice(2)}`;
    marker.setAttribute('viewBox', '0 0 8 8'); marker.setAttribute('refX', '7'); marker.setAttribute('refY', '4');
    marker.setAttribute('markerWidth', '5'); marker.setAttribute('markerHeight', '5'); marker.setAttribute('orient', 'auto-start-reverse');
    const arrow = svg('path'); arrow.setAttribute('d', 'M 0 0 L 8 4 L 0 8 z');
    marker.appendChild(arrow); defs.appendChild(marker); diagram.appendChild(defs);

    const laneLayer = svg('g'); laneLayer.classList.add('music-lanes');
    for (const lane of lanes) {
      const y = top + (laneIndex.get(lane) ?? 0) * yStep;
      const line = svg('line'); line.setAttribute('x1', `${left - 24}`); line.setAttribute('x2', `${worldWidth - left + 24}`);
      line.setAttribute('y1', `${y}`); line.setAttribute('y2', `${y}`); laneLayer.appendChild(line);
      const label = svg('text'); label.setAttribute('x', '12'); label.setAttribute('y', `${y + 4}`);
      label.textContent = lane === 0x7f ? 'loop' : `section ${lane}`; laneLayer.appendChild(label);
    }
    diagram.appendChild(laneLayer);

    const edgeLayer = svg('g'); edgeLayer.classList.add('music-edges');
    for (const node of graph.Nodes) {
      const from = positions[node.Index];
      if (!from) continue;
      node.LinkRaw.forEach(raw => {
        const link = decodeMusicLink(raw);
        const to = positions[link.target];
        if (!to) return;
        const path = svg('path');
        const bend = Math.max(14, Math.min(52, Math.abs(to.x - from.x) * 0.12));
        path.setAttribute('d', `M ${from.x + 6} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x - 7} ${to.y}`);
        path.classList.add(link.unconditional ? 'unconditional' : 'conditional');
        path.setAttribute('marker-end', `url(#${marker.id})`);
        const title = svg('title');
        title.textContent = link.unconditional ? `node ${node.Index} → ${link.target} · unconditional`
          : `node ${node.Index} → ${link.target} · path level ${link.min}…${link.max}`;
        path.appendChild(title); edgeLayer.appendChild(path);
      });
    }
    diagram.appendChild(edgeLayer);

    const eventLayer = svg('g'); eventLayer.classList.add('music-event-annotations');
    for (const [target, targetRoutes] of byTarget) {
      const pos = positions[target]; if (!pos) continue;
      const textValue = targetRoutes.map(route => `E${route.event}`).join(' · ');
      const width = Math.max(30, textValue.length * 6 + 10);
      const group = svg('g'); group.classList.add('music-event-tag');
      group.setAttribute('transform', `translate(${pos.x - width / 2} ${pos.y - 28})`);
      const rect = svg('rect'); rect.setAttribute('width', `${width}`); rect.setAttribute('height', '15'); rect.setAttribute('rx', '4');
      const text = svg('text'); text.setAttribute('x', `${width / 2}`); text.setAttribute('y', '11'); text.textContent = textValue;
      group.append(rect, text); eventLayer.appendChild(group);
    }
    diagram.appendChild(eventLayer);

    const nodeLayer = svg('g'); nodeLayer.classList.add('music-nodes');
    const nodeGroups = new Map<number, SVGGElement>();
    let selected: number | null = null;
    let auditionActive = false;
    let auditionStatus: HTMLElement | null = null;
    let auditionPathLevel = 80;
    for (const node of graph.Nodes) {
      const pos = positions[node.Index];
      const group = svg('g'); group.classList.add('music-node', `kind-${musicNodeKind(node)}`);
      if (node.Flags & 0x80) group.classList.add('entry');
      if (byTarget.has(node.Index)) group.classList.add('event-target');
      group.setAttribute('transform', `translate(${pos.x} ${pos.y})`);
      group.setAttribute('tabindex', '0'); group.setAttribute('role', 'button');
      const circle = svg('circle'); circle.setAttribute('r', musicNodeKind(node) === 'audio' ? '5' : '6');
      const label = svg('text'); label.setAttribute('y', '17'); label.textContent = `${node.Index}`;
      const title = svg('title'); title.textContent = nodeTooltip(node, graph);
      group.append(circle, label, title);
      group.onclick = () => selectNode(node.Index, false);
      group.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') selectNode(node.Index, false); };
      nodeGroups.set(node.Index, group); nodeLayer.appendChild(group);
    }
    diagram.appendChild(nodeLayer);

    let zoom = 1;
    function applyZoom(next: number) {
      zoom = Math.max(0.08, Math.min(2.5, next));
      diagram.style.width = `${worldWidth * zoom}px`;
      diagram.style.height = `${worldHeight * zoom}px`;
      zoomReadout.textContent = `${Math.round(zoom * 100)}%`;
    }
    function fit() {
      const availableW = Math.max(200, viewport.clientWidth - 20);
      const availableH = Math.max(180, viewport.clientHeight - 20);
      applyZoom(Math.min(availableW / worldWidth, availableH / worldHeight));
      viewport.scrollTo({ left: 0, top: 0 });
    }
    function focusNode(index: number) {
      if (zoom < 0.65) applyZoom(0.8);
      const pos = positions[index]; if (!pos) return;
      viewport.scrollTo({ left: pos.x * zoom - viewport.clientWidth / 2,
        top: pos.y * zoom - viewport.clientHeight / 2, behavior: 'smooth' });
    }
    function selectNode(index: number, focus: boolean) {
      if (selected !== null && selected !== index) stopMusicAudition('Audition stopped when the selection changed.');
      if (selected !== null) nodeGroups.get(selected)?.classList.remove('selected');
      selected = index;
      nodeGroups.get(index)?.classList.add('selected');
      renderInspector(graph.Nodes[index]);
      if (focus) focusNode(index);
    }

    function renderInspector(node: ReferenceMusicNode) {
      inspector.replaceChildren();
      const kind = musicNodeKind(node);
      const facts: Array<[string, string]> = [
        ['identity', `node ${node.Index} · ${kind}`],
        ['section', musicNodeSection(node) === 0x7f ? 'loop sentinel (127)' : `${musicNodeSection(node)}`],
      ];
      if (node.Sample > 0) {
        const sample = graph.Samples[node.Sample - 1];
        facts.push(['sample', `${node.Sample} · ${sample?.Wav ?? 'missing'}`]);
        if (sample) facts.push(['audio', `${seconds(sample.Seconds)} · ${sample.Rate.toLocaleString()} Hz · ${sample.Channels} ch`]);
      }
      facts.push(['chunk count', `${(node.Word1 >>> 8) & 0xff}`]);
      const nodeRoutes = byTarget.get(node.Index) ?? [];
      if (nodeRoutes.length) facts.push(['event target', nodeRoutes.map(route => `E${route.event} ${route.label}`).join(' · ')]);
      for (const [name, value] of facts) {
        const row = document.createElement('div');
        const key = document.createElement('span'); key.textContent = name;
        const val = document.createElement('b'); val.textContent = value;
        row.append(key, val); inspector.appendChild(row);
      }
      const audition = document.createElement('div'); audition.className = 'sp-music-audition';
      const levelControl = document.createElement('label'); levelControl.className = 'path-level';
      const levelLabel = document.createElement('span'); levelLabel.textContent = 'path level';
      const levelInput = document.createElement('input'); levelInput.type = 'range'; levelInput.min = '0'; levelInput.max = '127';
      levelInput.value = `${auditionPathLevel}`;
      const levelOutput = document.createElement('output'); levelOutput.textContent = `${auditionPathLevel}`;
      levelControl.title = 'The game defaults to 80 while racing and uses 90 inside an uber tier. Lower values reveal the calmer branches.';
      levelControl.append(levelLabel, levelInput, levelOutput);
      const auditionActions = document.createElement('div'); auditionActions.className = 'actions';
      if (node.Sample > 0 && node.Sample <= graph.Samples.length) {
        const playSample = button('▶ sample', `Play sample ${node.Sample} from node ${node.Index}`, () => {
          startMusicAudition([{ node: node.Index, sample: node.Sample }], [node.Index],
            `sample ${node.Sample} from node ${node.Index}`);
        });
        auditionActions.appendChild(playSample);
      }
      const playWalk = button('▶ follow path', `Follow the game’s first matching link from node ${node.Index}`, () => {
        const walk = musicWalkAtLevel(graph, node.Index, auditionPathLevel);
        startMusicAudition(walk.samples, walk.nodes,
          `level ${auditionPathLevel} · ${walkStopText(walk.stop, walk.at, walk.branches)}`);
      });
      const stop = button('■ stop', 'Stop the reference-music audition', () => stopMusicAudition('Stopped.'));
      auditionActions.append(playWalk, stop);
      const status = document.createElement('small'); status.className = 'status';
      function refreshWalkPreview() {
        const walk = musicWalkAtLevel(graph, node.Index, auditionPathLevel);
        const secondsTotal = walk.samples.reduce((sum, step) => sum + (graph.Samples[step.sample - 1]?.Seconds ?? 0), 0);
        playWalk.disabled = !walk.samples.length;
        status.textContent = walk.samples.length
          ? `level ${auditionPathLevel} · ${walk.samples.length} sample${walk.samples.length === 1 ? '' : 's'} · ${seconds(secondsTotal)} · ${walkStopText(walk.stop, walk.at, walk.branches)}`
          : `Level ${auditionPathLevel}: no audio before ${walkStopText(walk.stop, walk.at, walk.branches)}.`;
      }
      levelInput.oninput = () => {
        if (auditionActive) stopMusicAudition('');
        auditionPathLevel = Number(levelInput.value); levelOutput.textContent = `${auditionPathLevel}`;
        refreshWalkPreview();
      };
      refreshWalkPreview();
      audition.append(levelControl, auditionActions, status); inspector.appendChild(audition);
      const links = document.createElement('div'); links.className = 'links';
      if (!node.LinkRaw.length) links.textContent = 'No outgoing links (terminal).';
      else for (const raw of node.LinkRaw) {
        const link = decodeMusicLink(raw);
        const line = document.createElement('button'); line.type = 'button';
        line.textContent = `${link.unconditional ? 'always' : `${link.min}…${link.max}`} → node ${link.target}`;
        line.onclick = () => selectNode(link.target, true); links.appendChild(line);
      }
      inspector.appendChild(links);
    }

    function clearAuditionMarks() {
      for (const group of nodeGroups.values()) group.classList.remove('audition-path', 'playing');
    }

    function stopMusicAudition(message: string) {
      stopAudition(); auditionActive = false; clearAuditionMarks();
      if (auditionStatus?.isConnected && message) auditionStatus.textContent = message;
    }

    function startMusicAudition(steps: Array<{ node: number; sample: number }>, path: number[], finish: string) {
      stopMusicAudition('');
      auditionStatus = inspector.querySelector<HTMLElement>('.sp-music-audition .status');
      if (!steps.length) { if (auditionStatus) auditionStatus.textContent = 'This walk contains no audio samples.'; return; }
      auditionActive = true;
      for (const index of path) nodeGroups.get(index)?.classList.add('audition-path');
      if (auditionStatus) auditionStatus.textContent = `Loading ${steps.length} sample${steps.length === 1 ? '' : 's'}…`;
      void auditionReferenceMusicWalk(level, song.id, steps, {
        onReady: duration => {
          if (auditionStatus?.isConnected) auditionStatus.textContent =
            `Playing ${steps.length} sample${steps.length === 1 ? '' : 's'} · ${seconds(duration)} · ${finish}`;
        },
        onStep: step => {
          for (const group of nodeGroups.values()) group.classList.remove('playing');
          nodeGroups.get(step.node)?.classList.add('playing');
        },
        onEnded: () => {
          auditionActive = false;
          for (const group of nodeGroups.values()) group.classList.remove('playing');
          if (auditionStatus?.isConnected) auditionStatus.textContent = `Finished · ${finish}`;
        },
        onError: error => {
          auditionActive = false; clearAuditionMarks();
          if (auditionStatus?.isConnected) auditionStatus.textContent = `Could not play: ${error.message}`;
        },
      });
    }

    for (const route of routes) {
      const action = document.createElement('button'); action.type = 'button';
      const tag = document.createElement('span'); tag.textContent = `E${route.event}`;
      const copy = document.createElement('div');
      const name = document.createElement('b'); name.textContent = route.label;
      const meta = document.createElement('small'); meta.textContent = `${sectionText(route.sections, graph.Sections)} · router ${route.router} → node ${route.target}`;
      copy.append(name, meta); action.append(tag, copy);
      action.onclick = () => selectNode(route.target, true);
      eventList.appendChild(action);
    }
    if (!routes.length) {
      const empty = document.createElement('p'); empty.textContent = 'No node-changing event routers in this graph.';
      eventList.appendChild(empty);
    }

    const zoomReadout = document.createElement('output'); zoomReadout.className = 'sp-music-zoom';
    toolActions.append(
      button('Fit', 'Fit the complete graph in the viewport', fit),
      button('−', 'Zoom out', () => applyZoom(zoom / 1.25)),
      zoomReadout,
      button('+', 'Zoom in', () => applyZoom(zoom * 1.25)),
      button('Entry', 'Focus the entry node', () => selectNode(graph.Nodes.find(node => (node.Flags & 0x80) !== 0)?.Index ?? 0, true)),
    );
    viewport.addEventListener('wheel', event => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      applyZoom(zoom * (event.deltaY > 0 ? 0.88 : 1.14));
    }, { passive: false });

    selectNode(graph.Nodes.find(node => (node.Flags & 0x80) !== 0)?.Index ?? 0, false);
    requestAnimationFrame(fit);
  }
}

function walkStopText(stop: 'terminal' | 'loop' | 'unresolved' | 'limit', at: number, branches: number[]): string {
  if (stop === 'loop') return `stops before revisiting node ${at}`;
  if (stop === 'unresolved') return `stops at state-driven node ${at}${branches.length ? ` → ${branches.join(' / ')}` : ''}`;
  if (stop === 'terminal') return `ends at node ${at}`;
  return `stops at the safety limit near node ${at}`;
}

function nodeTooltip(node: ReferenceMusicNode, graph: ReferenceMusicGraph): string {
  const kind = musicNodeKind(node);
  const section = musicNodeSection(node);
  const sample = node.Sample > 0 ? graph.Samples[node.Sample - 1] : null;
  return `node ${node.Index} · ${kind} · section ${section}` +
    (sample ? ` · sample ${node.Sample} (${sample.Seconds.toFixed(3)} s)` : '') +
    ` · ${node.Links.length} link${node.Links.length === 1 ? '' : 's'}`;
}
