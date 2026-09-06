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
    revision: 'abe69e6d159152dd31db902c027bc4f9282509365b8b2749faff9074395baaf9',
    label: 'Blocky Rider',
  },
  {
    id: ALPINE_EXO_CHARACTER_ID,
    file: 'alpine-exo-rigged.glb',
    revision: '0d70e283486ec2c22c301a876c6b519c7600985b77f3abd94a137aa278a27906',
    label: 'Alpine Exo',
  },
  {
    id: SERVO_SCOUT_CHARACTER_ID,
    file: 'servo-scout-rigged.glb',
    revision: '6929288f30a7f319a40ecdfc9f140be445a82b95d498728c791810b438ae0cdd',
    label: 'Servo Scout',
  },
  {
    id: STICK_FIGURE_CHARACTER_ID,
    file: 'stick-figure-rigged.glb',
    revision: 'e1a06ea45c5238cb6086acae5941d44684ffb64eb8021b0cea91632cd24fa5bf',
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
