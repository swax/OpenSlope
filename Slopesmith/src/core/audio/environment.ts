/** Portable Maps/<LEVEL>/Audio/Environment.json contract. The bed is a deliberate off-board fallback,
 * not a reconstruction of a retail ExternalSounds record or weather event. */
export interface EnvironmentAudioBed {
  Bank: string;
  Slot: number;
  /** Map-relative WAV. Consumers may prefer its adjacent `.loop.wav` sustain-region sibling. */
  Clip: string;
  Volume: number;
}

export interface EnvironmentAudioDocument {
  Schema: 'openslope-environment-audio/v1' | string;
  Bed: EnvironmentAudioBed | null;
}

export type EnvironmentBedBank = 'Wind1' | 'Wind2';

/** The small author-facing form; export expands it into the portable Maps contract. */
export interface AuthoredEnvironmentBed {
  bank: EnvironmentBedBank;
  volume: number;
}

export const DEFAULT_ENVIRONMENT_BED: Readonly<AuthoredEnvironmentBed> = Object.freeze({
  bank: 'Wind1',
  volume: 0.15,
});

const authoredBank = (value: unknown): EnvironmentBedBank | null =>
  value === 'Wind1' || value === 'Wind2' ? value : null;

/** Undefined is a mountain saved before the setting existed and receives today's default; null is authored off. */
export function normalizeEnvironmentBed(value: unknown): AuthoredEnvironmentBed | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return { ...DEFAULT_ENVIRONMENT_BED };
  const raw = value as Partial<AuthoredEnvironmentBed>;
  const bank = authoredBank(raw.bank) ?? DEFAULT_ENVIRONMENT_BED.bank;
  const volume = Number.isFinite(raw.volume)
    ? Math.min(1, Math.max(0, Number(raw.volume))) : DEFAULT_ENVIRONMENT_BED.volume;
  return { bank, volume };
}

export function environmentDocument(bed: AuthoredEnvironmentBed | null): EnvironmentAudioDocument {
  return {
    Schema: 'openslope-environment-audio/v1',
    Bed: bed ? {
      Bank: bed.bank,
      Slot: 0,
      Clip: `Audio/SFX/${bed.bank}/000.wav`,
      Volume: bed.volume,
    } : null,
  };
}

export function validEnvironmentDocument(value: EnvironmentAudioDocument | null | undefined):
  value is EnvironmentAudioDocument {
  if (!value || value.Schema !== 'openslope-environment-audio/v1') return false;
  const bed = value.Bed;
  return bed === null || (!!bed && /^[A-Za-z0-9_-]+$/.test(bed.Bank)
    && Number.isInteger(bed.Slot) && bed.Slot >= 0 && bed.Slot <= 999
    && /^Audio\/SFX\/[^/]+\/\d{3}\.wav$/.test(bed.Clip)
    && Number.isFinite(bed.Volume) && bed.Volume >= 0 && bed.Volume <= 1);
}
