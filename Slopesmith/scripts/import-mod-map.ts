/**
 * Turn an SSX Mod Manager loose-level ZIP into a Snowknife Maps/<NAME> reference folder.
 *
 *   npm run import:mod-map -- <mod.zip> <clean-tricky.iso>
 *   npm run import:mod-map -- <mod.zip> <clean-tricky.iso> ALOHA ALOHA_HOLE
 *
 * Level mods are HostFS-shaped replacements: native files live below DATA/MODELS rather than in the
 * Patches.json/Instances.json contract Slopesmith reads. This command bridges that boundary without asking
 * the author to operate SSX Mod Manager: validate and unpack the ZIP, RefPack its loose native members, build
 * a temporary C0FB course archive, install it into a temporary ISO copy, and run Snowknife's normal import.
 * The user's ISO is opened only by copyFile and Snowknife reads/writes only the copy.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { crc32 } from '../src/app/export/crc32';
import { safeDataName } from '../src/core/export/names';
import { mapsRoot } from '../src/server/workspace-config';
import { snowknifeExe } from './snowknife-cli';

const TRICKY_SLOTS = new Set([
  'GARI', 'MESA', 'ELYSIUM', 'SNOW', 'ALASKA', 'ALOHA', 'MEGAPLE', 'MERQUER', 'PIPE', 'UNTRACK', 'TRICK',
]);
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 4096;
const REQUIRED_MAIN_EXTENSIONS = ['.adl', '.aip', '.ltg', '.map', '.pbd', '.sop', '.ssf', '.ssh'];
const REQUIRED_MAP_OUTPUTS = ['Patches.json', 'Instances.json', 'Models.json', 'Origin.json'];
const textDecoder = new TextDecoder();

interface ZipEntry {
  name: string;
  directory: boolean;
  method: number;
  compressed: Uint8Array;
  size: number;
  crc: number;
}

export interface NativeModMember {
  /** Basename beneath the rebuilt archive's canonical data/models directory. */
  name: string;
  bytes: Buffer;
}

export interface InspectedLevelMod {
  title: string;
  metadataWarning?: string;
  inferredSlot: string;
  mapEntry: string;
  members: NativeModMember[];
}

export interface ImportModMapOptions {
  zipPath: string;
  isoPath: string;
  slot?: string;
  name?: string;
  mapsRoot?: string;
  withOverrides?: boolean;
  keepWork?: boolean;
}

export interface ImportedModMap {
  destination: string;
  name: string;
  slot: string;
  title: string;
  members: number;
  keptWork?: string;
}

export type SnowknifeCommandRunner = (args: readonly string[]) => Promise<void>;

export interface ImportModMapDependencies {
  runSnowknife?: SnowknifeCommandRunner;
  log?: (line: string) => void;
  tempRoot?: string;
}

/** ZIP paths are untrusted input. Nothing is written using them directly, but rejecting traversal and
 * platform-specific separators here also prevents two hostile names from collapsing onto one native member. */
function safeZipPath(value: string): { name: string; directory: boolean } {
  if (!value || value.includes('\\') || value.startsWith('/') || value.includes('\0')) {
    throw new Error(`ZIP entry has an invalid path: ${JSON.stringify(value)}`);
  }
  const directory = value.endsWith('/');
  const name = directory ? value.slice(0, -1) : value;
  const parts = name.split('/');
  if (!name || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`ZIP entry has an invalid path: ${JSON.stringify(value)}`);
  }
  return { name, directory };
}

/** Read ordinary stored/deflated ZIPs through their central directory. ZIP64 and multi-part archives are
 * deliberately out of scope: a Tricky level mod is a few megabytes, and accepting giant container variants
 * would only enlarge the zip-bomb and parser surface. */
function zipDirectory(input: Uint8Array): ZipEntry[] {
  if (input.byteLength > MAX_ARCHIVE_BYTES) throw new Error('the mod ZIP is larger than 512 MB');
  const bytes = input instanceof Buffer
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  const earliest = Math.max(0, bytes.length - 65_557);
  for (let at = bytes.length - 22; at >= earliest; at--) {
    if (view.getUint32(at, true) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error('that file is not a ZIP archive');
  const disk = view.getUint16(end + 4, true);
  const centralDisk = view.getUint16(end + 6, true);
  const count = view.getUint16(end + 10, true);
  const centralBytes = view.getUint32(end + 12, true);
  const centralAt = view.getUint32(end + 16, true);
  if (disk || centralDisk) throw new Error('multi-part ZIP archives are not supported');
  if (count === 0xffff || centralAt === 0xffffffff || centralBytes === 0xffffffff) {
    throw new Error('ZIP64 mod archives are not supported');
  }
  if (count > MAX_ARCHIVE_FILES || centralAt + centralBytes > end) {
    throw new Error('the ZIP directory is invalid');
  }

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let expanded = 0;
  let at = centralAt;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) {
      throw new Error('the ZIP directory is invalid');
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > end || localAt + 30 > bytes.length || view.getUint32(localAt, true) !== 0x04034b50) {
      throw new Error('the ZIP directory points outside the archive');
    }
    if (flags & 1) throw new Error('encrypted ZIP entries are not supported');
    if (method !== 0 && method !== 8) throw new Error(`ZIP compression method ${method} is not supported`);
    const decoded = textDecoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const path = safeZipPath(decoded);
    const folded = path.name.toLowerCase();
    if (!path.directory && names.has(folded)) throw new Error(`the ZIP contains ${path.name} more than once`);
    if (!path.directory) names.add(folded);
    const localName = view.getUint16(localAt + 26, true);
    const localExtra = view.getUint16(localAt + 28, true);
    const dataAt = localAt + 30 + localName + localExtra;
    if (dataAt + compressedSize > bytes.length) throw new Error(`ZIP entry ${path.name} is truncated`);
    expanded += size;
    if (expanded > MAX_ARCHIVE_BYTES) throw new Error('the expanded mod ZIP is larger than 512 MB');
    entries.push({
      ...path, method, size, crc,
      compressed: bytes.subarray(dataAt, dataAt + compressedSize),
    });
    at = next;
  }
  return entries;
}

function inflateEntry(entry: ZipEntry): Buffer {
  let bytes: Buffer;
  if (entry.method === 0) {
    if (entry.compressed.length !== entry.size) throw new Error(`ZIP entry ${entry.name} has the wrong size`);
    bytes = Buffer.from(entry.compressed);
  } else {
    bytes = inflateRawSync(entry.compressed);
    if (bytes.length !== entry.size) throw new Error(`ZIP entry ${entry.name} has the wrong expanded size`);
  }
  if (crc32(bytes) !== entry.crc) throw new Error(`ZIP entry ${entry.name} failed its CRC check`);
  return bytes;
}

function modTitle(entries: readonly ZipEntry[], fallback: string): { title: string; warning?: string } {
  const metadata = entries.filter(entry => !entry.directory && /(^|\/)modinfo\.json$/i.test(entry.name));
  if (metadata.length > 1) throw new Error('the ZIP contains more than one ModInfo.json');
  if (!metadata.length) return { title: fallback };
  try {
    const parsed = JSON.parse(inflateEntry(metadata[0]).toString('utf8')) as { Name?: unknown };
    return { title: typeof parsed.Name === 'string' && parsed.Name.trim() ? parsed.Name.trim() : fallback };
  } catch (error) {
    return {
      title: fallback,
      warning: `invalid optional ModInfo.json; using the ZIP filename (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

/** Inspect and fully CRC-check the native course members without writing any archive-controlled path. */
export function inspectLevelModZip(input: Uint8Array, archiveName = 'mod.zip'): InspectedLevelMod {
  const entries = zipDirectory(input);
  const maps = entries.filter(entry => {
    if (entry.directory || extname(entry.name).toLowerCase() !== '.map') return false;
    return dirname(entry.name).replace(/\\/g, '/').toLowerCase().endsWith('data/models');
  });
  if (!maps.length) throw new Error('the ZIP has no loose DATA/MODELS/*.map course');
  if (maps.length > 1) throw new Error('the ZIP contains more than one loose course .map');

  const map = maps[0];
  const parent = dirname(map.name).replace(/\\/g, '/');
  const stem = basename(map.name, extname(map.name));
  const foldedStem = stem.toLowerCase();
  if (!TRICKY_SLOTS.has(stem.toUpperCase())) {
    throw new Error(`the loose course stem ${JSON.stringify(stem)} is not a supported Tricky slot`);
  }
  const siblings = entries.filter(entry => !entry.directory
    && dirname(entry.name).replace(/\\/g, '/').toLowerCase() === parent.toLowerCase());
  const mainNames = REQUIRED_MAIN_EXTENSIONS.map(extension => foldedStem + extension);
  const skyNames = [`${foldedStem}_sky.pbd`, `${foldedStem}_sky.ssh`];
  const lightmaps = [`${foldedStem}_l.ssh`, `${foldedStem.slice(0, -1)}_l.ssh`];
  const wanted = new Set([...mainNames, ...skyNames, ...lightmaps]);
  // Pack only the native course family, never arbitrary siblings or the donor PIPE.BIG found in one known mod.
  const native = siblings.filter(entry => wanted.has(basename(entry.name).toLowerCase()));
  const byName = new Map(native.map(entry => [basename(entry.name).toLowerCase(), entry]));

  const missing = mainNames.filter(name => !byName.has(name));
  for (const name of skyNames) {
    if (!byName.has(name)) missing.push(name);
  }
  if (!lightmaps.some(name => byName.has(name))) missing.push(`${foldedStem}[_trimmed]_L.ssh`);
  if (missing.length) throw new Error(`the loose course is incomplete; missing ${missing.join(', ')}`);

  const members = native.map(entry => ({ name: basename(entry.name), bytes: inflateEntry(entry) }));
  const metadata = modTitle(entries, basename(archiveName, extname(archiveName)));
  return {
    title: metadata.title,
    ...(metadata.warning ? { metadataWarning: metadata.warning } : {}),
    inferredSlot: stem.toUpperCase(),
    mapEntry: map.name,
    members,
  };
}

/** Human labels become conservative Maps folder names; an explicit --name is validated rather than silently
 * changed, so the command always prints and creates exactly what its caller asked for. */
export function suggestedMapName(title: string): string {
  const ascii = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return safeDataName(ascii.replace(/[’']/g, '').replace(/[^A-Za-z0-9_-]+/g, '_'))
    .replace(/^_+|_+$/g, '').toUpperCase();
}

function requireMapName(value: string): string {
  const name = value.trim();
  if (!name || name !== safeDataName(name) || name === '.' || name === '..') {
    throw new Error(`map name must use only letters, numbers, _ and - (received ${JSON.stringify(value)})`);
  }
  return name;
}

function requireSlot(value: string): string {
  const slot = value.trim().toUpperCase();
  if (!TRICKY_SLOTS.has(slot)) {
    throw new Error(`unknown Tricky course slot ${JSON.stringify(value)}; choose ${[...TRICKY_SLOTS].join(', ')}`);
  }
  return slot;
}

async function requireFile(path: string, label: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`${label} is not a file: ${path}`);
}

async function requireDirectory(path: string, label: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`${label} is not a folder: ${path}`);
}

async function pathExists(path: string): Promise<boolean> {
  return !!await stat(path).catch(() => null);
}

const shownArg = (value: string): string => /\s/.test(value) ? JSON.stringify(value) : value;

/** Live runner used by the CLI. Keeping shell:false and passing an argument vector means ZIP names, map names,
 * and ISO paths are data even when they contain shell metacharacters. */
export async function runSnowknifeLive(args: readonly string[]): Promise<void> {
  const executable = snowknifeExe();
  if (!executable) {
    throw new Error('Snowknife is not built; run `dotnet build ../Snowknife/Snowknife/Snowknife.csproj` '
      + 'or set SLOPESMITH_SNOWKNIFE_EXE');
  }
  console.log(`\n$ ${shownArg(executable)} ${args.map(shownArg).join(' ')}`);
  await new Promise<void>((accept, reject) => {
    const child = spawn(executable, [...args], { stdio: 'inherit', windowsHide: true, shell: false });
    child.once('error', reject);
    child.once('close', (status, signal) => {
      if (status === 0) accept();
      else reject(new Error(`snowknife ${args[0]} failed${signal ? ` on ${signal}` : ` with exit ${status}`}`));
    });
  });
}

/** Execute the import. The final folder is a same-volume rename of a validated hidden sibling, so Slopesmith's
 * library watcher cannot observe half an import and a failed command never leaves a folder that looks usable. */
export async function importModMap(options: ImportModMapOptions,
  dependencies: ImportModMapDependencies = {}): Promise<ImportedModMap> {
  const log = dependencies.log ?? console.log;
  const runSnowknife = dependencies.runSnowknife ?? runSnowknifeLive;
  const zipPath = resolve(options.zipPath);
  const isoPath = resolve(options.isoPath);
  const outputRoot = resolve(options.mapsRoot ?? mapsRoot());
  await requireFile(zipPath, 'Mod ZIP');
  await requireFile(isoPath, 'Base ISO');
  await requireDirectory(outputRoot, 'Maps root');

  log(`[1/5] Inspecting ${zipPath}`);
  const inspected = inspectLevelModZip(await readFile(zipPath), basename(zipPath));
  if (inspected.metadataWarning) log(`WARNING: ${inspected.metadataWarning}`);
  const slot = requireSlot(options.slot ?? inspected.inferredSlot);
  const name = requireMapName(options.name ?? suggestedMapName(inspected.title));
  const destination = join(outputRoot, name);
  if (await pathExists(destination)) {
    throw new Error(`destination already exists (choose another --name): ${destination}`);
  }

  const work = await mkdtemp(join(resolve(dependencies.tempRoot ?? tmpdir()), 'slopesmith-mod-map-'));
  const memberRoot = join(work, 'members');
  const packedRoot = join(work, 'packed');
  const memberModels = join(memberRoot, 'data', 'models');
  const packedModels = join(packedRoot, 'data', 'models');
  const big = join(work, `${slot}.BIG`);
  const workingIso = join(work, `${name}.iso`);
  const staging = join(outputRoot, `.${name}.import-${randomUUID()}`);
  let published = false;
  try {
    await Promise.all([mkdir(memberModels, { recursive: true }), mkdir(packedModels, { recursive: true })]);
    log(`[2/5] RefPacking ${inspected.members.length} loose course members`);
    let effectsMode: 'strict' | 'salvage' | 'omit' = 'strict';
    let ssfSource = '';
    for (const member of inspected.members) {
      const source = join(memberModels, member.name);
      const packed = join(packedModels, member.name);
      await writeFile(source, member.bytes);
      if (extname(member.name).toLowerCase() === '.ssf') ssfSource = source;
      await runSnowknife(['refpack', source, packed]);
    }
    // `snowknife import` is intentionally strict about SSF instance references. Some old level mods changed
    // their PBD population without fixing those references; that should cost the broken effects, not make the
    // otherwise-usable terrain impossible to browse. Preflight the exact SSF and select import's explicit
    // no-effects path only when it fails.
    try {
      await runSnowknife(['effects-export', ssfSource, join(work, 'Effects.preflight.json'), '--level', slot]);
    } catch (error) {
      log(`WARNING: the mod's SSF has invalid references; attempting a safe effects salvage (${error instanceof Error ? error.message : String(error)})`);
      try {
        await runSnowknife([
          'effects-export', ssfSource, join(work, 'Effects.preflight.json'), '--level', slot,
          '--salvage-dangling-references',
        ]);
        effectsMode = 'salvage';
      } catch (salvageError) {
        effectsMode = 'omit';
        log(`WARNING: effects salvage failed; importing terrain/props without Effects.json (${salvageError instanceof Error ? salvageError.message : String(salvageError)})`);
      }
    }

    log(`[3/5] Building ${slot}.BIG and installing it into a temporary ISO copy`);
    await runSnowknife(['big-create', packedRoot, big, 'c0fb', '--store']);
    await copyFile(isoPath, workingIso);
    await runSnowknife(['iso-replace', workingIso, `DATA\\MODELS\\${slot}.BIG`, big]);

    log(`[4/5] Importing the modified ${slot} slot with Snowknife`);
    // Third-party native files can omit optional text-MAP names for otherwise valid PBD records. Ask
    // Snowknife to synthesize those names only in its unpacked temporary copy so a cosmetic linker gap
    // cannot prevent the terrain and props from becoming a browsable map.
    const importArgs = [
      'import', workingIso, slot, staging, '--repair-missing-map-links', '--allow-nonring-sky',
    ];
    if (!options.withOverrides) importArgs.push('--no-overrides');
    if (effectsMode === 'salvage') importArgs.push('--salvage-effects');
    else if (effectsMode === 'omit') importArgs.push('--no-effects');
    await runSnowknife(importArgs);
    for (const required of REQUIRED_MAP_OUTPUTS) {
      await requireFile(join(staging, required), `Imported ${required}`);
    }

    log('[5/5] Publishing the validated map folder');
    await rename(staging, destination);
    published = true;
    return {
      destination, name, slot, title: inspected.title, members: inspected.members.length,
      ...(options.keepWork ? { keptWork: work } : {}),
    };
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (!options.keepWork) await rm(work, { recursive: true, force: true }).catch(() => undefined);
    else log(`Kept temporary BIG and ISO copy: ${work}`);
  }
}

export type ParsedImportModArgs = ImportModMapOptions;

export function parseImportModArgs(args: readonly string[]): ParsedImportModArgs {
  const positional: string[] = [];
  let isoPath = process.env.SLOPESMITH_TRICKY_ISO?.trim() ?? '';
  let slot: string | undefined;
  let name: string | undefined;
  let outputRoot: string | undefined;
  let withOverrides = false;
  let keepWork = false;
  const value = (flag: string, index: number): string => {
    const next = args[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value`);
    return next;
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--iso') isoPath = value(arg, index++);
    else if (arg === '--slot') slot = value(arg, index++);
    else if (arg === '--name') name = value(arg, index++);
    else if (arg === '--maps-root') outputRoot = value(arg, index++);
    else if (arg === '--with-overrides') withOverrides = true;
    else if (arg === '--keep-work') keepWork = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  const zipPath = positional.shift() ?? '';
  if (!isoPath) isoPath = positional.shift() ?? '';
  if (!slot) slot = positional.shift();
  if (!name) name = positional.shift();
  if (positional.length) throw new Error(`unexpected extra argument: ${positional[0]}`);
  if (!zipPath) throw new Error('missing <mod.zip>');
  if (!isoPath) throw new Error('missing <clean-tricky.iso> (or --iso / SLOPESMITH_TRICKY_ISO)');
  return {
    zipPath: isAbsolute(zipPath) ? zipPath : resolve(zipPath),
    isoPath: isAbsolute(isoPath) ? isoPath : resolve(isoPath),
    ...(slot ? { slot } : {}),
    ...(name ? { name } : {}),
    ...(outputRoot ? { mapsRoot: isAbsolute(outputRoot) ? outputRoot : resolve(outputRoot) } : {}),
    withOverrides,
    keepWork,
  };
}

const USAGE = `
Import an SSX Mod Manager loose-level ZIP as a Slopesmith reference map.

Usage:
  npm run import:mod-map -- <mod.zip> <clean-tricky.iso> [SLOT] [MAP_NAME]
  npm run import:mod-map -- help

  Direct tsx invocation also accepts --iso, --slot, --name, and --maps-root.

Options:
  --slot SLOT          ISO course slot; inferred from DATA/MODELS/<slot>.map when omitted
  --name MAP_NAME      destination folder; inferred from ModInfo.json when omitted
  --maps-root DIR      destination library; defaults to Slopesmith's configured Maps folder
  --with-overrides     apply Maps/Overrides prop remodels (off by default for a faithful mod import)
  --keep-work          keep the temporary rebuilt BIG and modified ISO copy for diagnosis

Environment:
  SLOPESMITH_TRICKY_ISO       default for --iso
  SLOPESMITH_SNOWKNIFE_EXE    explicit Snowknife executable
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // npm consumes --help itself even after its argument separator; the positional spelling reaches this script.
  if (args[0] === 'help' || args.includes('--help') || args.includes('-h')) { console.log(USAGE.trim()); return; }
  const result = await importModMap(parseImportModArgs(args));
  console.log(`\nImported ${result.title} (${result.slot}, ${result.members} native members)`);
  console.log(`Slopesmith reference: ${result.destination}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(`\nimport:mod-map failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
