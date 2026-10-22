/**
 * The characters that ship inside every Slopesmith client build.
 *
 * These are the riders a clean checkout has before any workspace exists, so they are addressed as
 * `/characters/<file>` by the static build rather than through `/api/character-model` like the
 * server-wide library (docs/030). Ids carry a `builtin:` prefix precisely so they can never collide with
 * a library entry, whose id IS its `.glb` file name.
 */
export interface BuiltinCharacter {
  /** Stable id: persisted in localStorage and published to other players as an avatar (docs/048). */
  id: string;
  /** File under `public/characters/`. */
  file: string;
  /** SHA-256 of the shipped GLB. Makes its static URL change exactly when its bytes do. */
  revision: string;
  /** What the Rider model picker shows. */
  label: string;
}

export const BLOCKY_RIDER_CHARACTER_ID = 'builtin:blocky-rider';
export const ALPINE_EXO_CHARACTER_ID = 'builtin:alpine-exo';
export const SERVO_SCOUT_CHARACTER_ID = 'builtin:servo-scout';
export const STICK_FIGURE_CHARACTER_ID = 'builtin:stick-figure';

/** Picker order. The blocky rider leads because it is the default and the lightest; the stick figure stays
 *  last because a rig painted front-cyan / rear-magenta is a diagnostic, not a character — it is the
 *  fastest way to read a pose that looks wrong. */
export const BUILTIN_CHARACTERS: readonly BuiltinCharacter[] = [
  {
    id: BLOCKY_RIDER_CHARACTER_ID,
    file: 'blocky-rider-rigged.glb',
    revision: '4831f850b62f789b5b17b79c5121661ed14fa7f591efb28dea297c2b87ae1bb2',
    label: 'Blocky Rider',
  },
  {
    id: ALPINE_EXO_CHARACTER_ID,
    file: 'alpine-exo-rigged.glb',
    revision: '381d8fb751e578cd4a22538904b60c02ff98545024e69435bbcf02aa32202227',
    label: 'Alpine Exo',
  },
  {
    id: SERVO_SCOUT_CHARACTER_ID,
    file: 'servo-scout-rigged.glb',
    revision: 'bb21524df6d5b4e8b2742ded558e014794ab9122dce9268c9ba4a2aa109e241c',
    label: 'Servo Scout',
  },
  {
    id: STICK_FIGURE_CHARACTER_ID,
    file: 'stick-figure-rigged.glb',
    revision: '82a8459319daca2e180628ed8ffdead7bc9315c013afcc793a6d7f4b144142d7',
    label: 'Stick Figure',
  },
];

/** Persisted ids predate display-name changes. Resolve them at the catalogue boundary so saved sessions and
 * older multiplayer clients select the renamed character without putting legacy choices back in the picker. */
const LEGACY_BUILTIN_IDS: Readonly<Record<string, string>> = {
  'builtin:space-marine': ALPINE_EXO_CHARACTER_ID,
};

export function builtinCharacter(id: string): BuiltinCharacter | null {
  const canonical = LEGACY_BUILTIN_IDS[id] ?? id;
  return BUILTIN_CHARACTERS.find(character => character.id === canonical) ?? null;
}

/** The client-build URL for a built-in, or null for anything else — a library file or the procedural body. */
export function builtinCharacterUrl(id: string): string | null {
  const character = builtinCharacter(id);
  return character ? `/characters/${character.file}?v=${character.revision}` : null;
}

/** Fresh sessions ride the blocky character; the procedural body remains an explicit debug/failure fallback. */
export const DEFAULT_CHARACTER_MODEL_ID = BLOCKY_RIDER_CHARACTER_ID;
