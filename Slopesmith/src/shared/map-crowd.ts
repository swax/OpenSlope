import { joinMapPath, type MapDataSource } from './map-data';

/** Filename discovery is retained for older exports that predate the explicit frame profile. */
export const isCrowdFrameFile = (name: string): boolean => /^(?:crowd-)?cd\d+\.png$/i.test(name);

export async function readCrowdFrames(source: MapDataSource, directory: string): Promise<string[]> {
  const profile = await source.readJsonOr<{ Schema?: string; Frames?: unknown } | null>(
    joinMapPath(directory, 'Crowd.json'), null);
  if (profile !== null) {
    if (profile.Schema !== 'openslope-crowd/v1' || !Array.isArray(profile.Frames) || profile.Frames.length !== 16
      || !profile.Frames.every((frame): frame is string => typeof frame === 'string'
        && frame.length <= 128 && !frame.startsWith('.') && /\.png$/i.test(frame)
        && !/[\\/:*?"<>|]/.test(frame) && [...frame].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)))
      throw new Error(`Invalid crowd frame profile for ${directory}.`);
    return [...profile.Frames];
  }
  const files = (await source.listDir(joinMapPath(directory, 'Textures'))).filter(isCrowdFrameFile);
  const legacy = files.filter(name => /^cd\d+\.png$/i.test(name));
  // Keep each bank separate if both naming styles are present; combining them would double the animation.
  return (legacy.length ? legacy : files).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
