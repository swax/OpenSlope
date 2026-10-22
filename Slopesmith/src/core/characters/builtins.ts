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
  /** A few words on who this is, for pickers that have room to say. */
  blurb?: string;
  /** A diagnostic rather than a character: offered in pickers, never handed out at random. */
  diagnostic?: boolean;
}

export const BLOCKY_RIDER_CHARACTER_ID = 'builtin:blocky-rider';
export const KESTREL_CHARACTER_ID = 'builtin:kestrel';
export const ROBIN_CHARACTER_ID = 'builtin:robin';
export const RAVEN_CHARACTER_ID = 'builtin:raven';
export const ALPINE_EXO_CHARACTER_ID = 'builtin:alpine-exo';
export const SERVO_SCOUT_CHARACTER_ID = 'builtin:servo-scout';
export const STICK_FIGURE_CHARACTER_ID = 'builtin:stick-figure';
/** The retired procedural body's id. It is no longer drawn or offered; anything still carrying it (an older
 *  client's pose, an old saved setting) rides the default character. */
export const PROCEDURAL_CHARACTER_ID = 'procedural';

/** Picker order. The blocky rider leads because it is the default and the lightest; the stick figure stays
 *  last because a rig painted front-cyan / rear-magenta is a diagnostic, not a character — it is the
 *  fastest way to read a pose that looks wrong. Kestrel, Robin and Raven are the textured rider family built
 *  in Blender (tools/character-models/riders). */
export const BUILTIN_CHARACTERS: readonly BuiltinCharacter[] = [
  {
    id: BLOCKY_RIDER_CHARACTER_ID,
    file: 'blocky-rider-rigged.glb',
    revision: '4831f850b62f789b5b17b79c5121661ed14fa7f591efb28dea297c2b87ae1bb2',
    label: 'Blocky Rider',
  },
  {
    id: KESTREL_CHARACTER_ID,
    file: 'kestrel-rigged.glb',
    revision: 'f50a2f40f869002436b496591de779bf9ae29fde8dc115600bbd5c8ef554f74c',
    label: 'Kestrel',
    blurb: 'Backcountry freerider',
  },
  {
    id: ROBIN_CHARACTER_ID,
    file: 'robin-rigged.glb',
    revision: '7fce08af9ef670e6e90139185e0a9c5e60087666f65622a483158a8b232a0c3b',
    label: 'Robin',
    blurb: 'Big mountain, hood up',
  },
  {
    id: RAVEN_CHARACTER_ID,
    file: 'raven-rigged.glb',
    revision: 'dfdcebd24ccc8f8c48cb649f305bc84137438698d90d2650fedf8cbd7a5d90fe',
    label: 'Raven',
    blurb: 'Glow-in-the-dark skeleton',
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
    diagnostic: true,
  },
];

/** The characters handed out at random: a newcomer's first avatar, and the AI field's riders. */
export const RANDOM_AVATAR_POOL: readonly string[] = BUILTIN_CHARACTERS.filter(c => !c.diagnostic).map(c => c.id);

/** One character from the random pool. */
export function randomAvatarId(random: () => number = Math.random): string {
  return RANDOM_AVATAR_POOL[Math.min(RANDOM_AVATAR_POOL.length - 1, Math.floor(random() * RANDOM_AVATAR_POOL.length))];
}

/** The whole pool in a random order (Fisher-Yates), so a field of riders repeats nobody until it runs out. */
export function shuffledAvatars(random: () => number = Math.random): string[] {
  const deck = [...RANDOM_AVATAR_POOL];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

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

/** A server-library character is addressed by its file name. Bounded so a stored choice stays a short string. */
const LIBRARY_CHARACTER_ID = /^[^/\\]{1,120}\.glb$/i;

/**
 * Whether a value names something a rider can wear, canonicalized: a built-in (renamed ids resolve to their
 * current one) or a server-library file name. Anything else is null — including the procedural body, which is
 * only the fallback for a model that fails to load, not a choice. Shared by the editor's saved settings, the
 * play page and the account record, so all three accept the same choices.
 */
export function avatarId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const builtIn = builtinCharacter(value);
  if (builtIn) return builtIn.id;
  if (value.startsWith('builtin:')) return null;              // a built-in this build no longer ships
  return LIBRARY_CHARACTER_ID.test(value) ? value : null;
}
