import type { EnvironmentAudioBed } from '../audio/environment';

/** Read-only EA PathFinder race-music data exported by `snowknife race-music`. The source JSON deliberately keeps
 * native field names/casing so a reference study can show the exact graph without inventing an editor format. */
export interface ReferenceMusicNode {
  Index: number;
  Sample: number;
  Flags: number;
  Word1: number;
  Word2: number;
  Links: number[];
  LinkRaw: number[];
}

export interface ReferenceMusicSample {
  Index: number;
  Wav: string;
  MusOffset: number;
  Meta: number;
  Samples: number;
  Rate: number;
  Channels: number;
  Seconds: number;
}

export interface ReferenceMusicGraph {
  Song: string;
  Short: string;
  Bpm: number;
  Tracks: number;
  Sections: number;
  Events: number;
  /** JSON.NET serializes the native byte[] event table as base64. */
  EventTable: string;
  Routers: number[];
  Vars: number[];
  Nodes: ReferenceMusicNode[];
  Samples: ReferenceMusicSample[];
}

export interface ReferenceMusicSummary {
  id: string;
  title: string;
  short: string;
  bpm: number;
  tracks: number;
  sections: number;
  events: number;
  routers: number;
  nodes: number;
  samples: number;
  totalSeconds: number;
  averageChunkSeconds: number;
}

/** The one intro-music tier Unity chooses from the level's top-level stems. Snowknife preserves the native
 * filenames; the preferred tier is C, then A, then B, matching MusicDirectorSetup. */
export interface ReferenceIntroMusic {
  tier: 'A' | 'B' | 'C';
  stems: string[];
}

export interface ReferenceMusicIndex {
  level: string;
  environment: EnvironmentAudioBed | null;
  intro: ReferenceIntroMusic | null;
  songs: ReferenceMusicSummary[];
}

export type MusicNodeKind = 'audio' | 'marker' | 'loop';

export interface MusicLink {
  min: number;
  max: number;
  target: number;
  unconditional: boolean;
}

export interface MusicRouter {
  action: number;
  flags: number;
  target: number;
  changesNode: boolean;
  cancelsPending: boolean;
  marksSongEnd: boolean;
}

export interface MusicEventRoute {
  event: number;
  label: string;
  router: number;
  target: number;
  sections: number[];
  flags: number;
}

export interface MusicWalkStep {
  node: number;
  /** One-based MPF sample id; zero/control and negative/loop nodes are omitted from `samples`. */
  sample: number;
}

export interface MusicWalk {
  /** Every graph node visited, including silent control/loop nodes and the node where the walk stops. */
  nodes: number[];
  samples: MusicWalkStep[];
  stop: 'terminal' | 'loop' | 'unresolved' | 'limit';
  at: number;
  /** Distinct outgoing targets when a state-driven choice cannot be resolved; otherwise empty. */
  branches: number[];
}

/** Song events established from the game dispatcher. Seven/eight remain honest unknowns; nine is a
 * one-shot whose exact gameplay producer is unresolved, and ten is the finish stinger. */
export const MUSIC_EVENT_LABELS = [
  'neutral / race reset',
  'uber tier 1 enter',
  'uber tier 1 exit',
  'uber tier 2 enter',
  'uber tier 2 exit',
  'uber tier 3 enter',
  'uber tier 3 exit',
  'event 7 · unresolved',
  'event 8 · unresolved',
  'one-shot event 9',
  'finish stinger',
] as const;

const signedByte = (value: number): number => value >= 0x80 ? value - 0x100 : value;

export function musicNodeKind(node: ReferenceMusicNode): MusicNodeKind {
  return node.Sample < 0 ? 'loop' : node.Sample === 0 ? 'marker' : 'audio';
}

export function musicNodeSection(node: ReferenceMusicNode): number {
  return node.Flags & 0x7f;
}

export function decodeMusicLink(rawValue: number): MusicLink {
  const raw = rawValue >>> 0;
  const min = signedByte(raw & 0xff);
  const max = signedByte((raw >>> 8) & 0xff);
  return { min, max, target: (raw >>> 16) & 0xffff, unconditional: min === 0 && max === 127 };
}

export function decodeMusicRouter(rawValue: number): MusicRouter {
  const raw = rawValue >>> 0;
  const flags = (raw >>> 8) & 0xff;
  return {
    action: signedByte(raw & 0xff),
    flags,
    target: (raw >>> 16) & 0xffff,
    changesNode: (flags & 0x03) !== 0,
    cancelsPending: (flags & 0x04) !== 0,
    marksSongEnd: (flags & 0x40) !== 0,
  };
}

export function decodeMusicEventTable(encoded: string): Uint8Array {
  if (!encoded) return new Uint8Array();
  const binary = atob(encoded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export function musicEventLabel(event: number): string {
  return MUSIC_EVENT_LABELS[event] ?? `event ${event}`;
}

/** Resolve event-table entries to node-changing routers. MPF v3 stores the table event-major, then track,
 * then the current node's section. SSX Tricky songs are all single-track, but retain the track stride here. */
export function musicEventRoutes(graph: ReferenceMusicGraph, track = 0): MusicEventRoute[] {
  const table = decodeMusicEventTable(graph.EventTable);
  const grouped = new Map<string, MusicEventRoute>();
  if (track < 0 || track >= graph.Tracks) return [];
  for (let event = 0; event < graph.Events; event++) {
    for (let section = 0; section < graph.Sections; section++) {
      const at = ((event * graph.Tracks + track) * graph.Sections) + section;
      const routerIndex = table[at];
      if (routerIndex === undefined || routerIndex >= graph.Routers.length) continue;
      const router = decodeMusicRouter(graph.Routers[routerIndex]);
      if (!router.changesNode || router.target >= graph.Nodes.length) continue;
      const key = `${event}:${routerIndex}:${router.target}`;
      let route = grouped.get(key);
      if (!route) {
        route = { event, label: musicEventLabel(event), router: routerIndex,
          target: router.target, sections: [], flags: router.flags };
        grouped.set(key, route);
      }
      route.sections.push(section);
    }
  }
  return [...grouped.values()].sort((a, b) => a.event - b.event || a.target - b.target);
}

/** Simulate ordinary link selection at one fixed path level. Runtime scans links in authored order and takes
 * the first inclusive range containing the control value. Multi-link loop nodes use a live decrementing loop
 * counter instead, so this study stops at those rather than pretending the path level applies. Gameplay event
 * jumps and variable remaps are likewise outside this static walk. */
export function musicWalkAtLevel(graph: ReferenceMusicGraph, start: number, pathLevel = 80,
  maxSamples = 32): MusicWalk {
  const nodes: number[] = [];
  const samples: MusicWalkStep[] = [];
  const seen = new Set<number>();
  const level = Math.max(0, Math.min(127, Math.trunc(pathLevel)));
  const sampleCap = Math.max(1, Math.trunc(maxSamples));
  let at = Math.trunc(start);
  for (let count = 0; count < 1024; count++) {
    if (seen.has(at)) return { nodes, samples, stop: 'loop', at, branches: [] };
    const node = graph.Nodes[at];
    if (!node) return { nodes, samples, stop: 'terminal', at, branches: [] };
    seen.add(at); nodes.push(at);
    if (node.Sample > 0 && node.Sample <= graph.Samples.length) {
      samples.push({ node: at, sample: node.Sample });
      if (samples.length >= sampleCap) return { nodes, samples, stop: 'limit', at, branches: [] };
    }
    const links = node.LinkRaw.map(decodeMusicLink)
      .filter(link => link.target >= 0 && link.target < graph.Nodes.length);
    if (!links.length) return { nodes, samples, stop: 'terminal', at, branches: [] };
    // A loop node's branching control is its live counter, not the race path level. One link is unambiguous.
    if (node.Sample < 0 && links.length > 1)
      return { nodes, samples, stop: 'unresolved', at, branches: [...new Set(links.map(link => link.target))] };
    const chosen = node.Sample < 0 ? links[0] : links.find(link => link.min <= level && level <= link.max);
    if (!chosen)
      return { nodes, samples, stop: 'unresolved', at, branches: [...new Set(links.map(link => link.target))] };
    at = chosen.target;
  }
  return { nodes, samples, stop: 'limit', at, branches: [] };
}

export function summarizeReferenceMusic(id: string, graph: ReferenceMusicGraph): ReferenceMusicSummary {
  const totalSeconds = graph.Samples.reduce((sum, sample) => sum + Number(sample.Seconds || 0), 0);
  return {
    id,
    title: graph.Song,
    short: graph.Short,
    bpm: graph.Bpm,
    tracks: graph.Tracks,
    sections: graph.Sections,
    events: graph.Events,
    routers: graph.Routers.length,
    nodes: graph.Nodes.length,
    samples: graph.Samples.length,
    totalSeconds,
    averageChunkSeconds: graph.Samples.length ? totalSeconds / graph.Samples.length : 0,
  };
}
