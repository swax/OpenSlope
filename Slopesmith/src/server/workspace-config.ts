import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { ensureDir, isDirectory, pathExists, writeJsonAtomic } from './fs-async';

/**
 * The machine-local settings Slopesmith needs before it can open user-owned state. This tiny bootstrap record
 * stays beside the app because `workspaceRoot` cannot be discovered from a settings file inside the workspace
 * it names. All ordinary settings and projects belong under that workspace.
 */
export interface BootstrapConfig {
  workspaceRoot: string;
  /** The map library: extracted reference levels are read from here and exports are written here, so an
   *  authored course can be reloaded as a reference beside the retail ones. */
  mapsRoot: string;
  /** Concurrent accounts admitted to the shared session channel. Role priority decides who may replace a
   * lower-role account when full; admins alone may exceed it, so administration can never be locked out. */
  maxPlayers: number;
}

/** A missing setting keeps existing installations on the multiplayer default. */
export const DEFAULT_MAX_PLAYERS = 16;

/** The variable that takes a field out of Settings' hands, for machines and automation. */
export const ENV_OVERRIDE: Record<keyof BootstrapConfig, string> = {
  workspaceRoot: 'SLOPESMITH_WORKSPACE_ROOT',
  mapsRoot: 'SLOPESMITH_MAPS_ROOT',
  maxPlayers: 'SLOPESMITH_MAX_PLAYERS',
};

export interface ResolvedBootstrapConfig extends BootstrapConfig {
  appRoot: string;
  configFile: string;
  configured: boolean;
  /** Fields the environment has taken over: Settings shows them read-only and never rewrites them. */
  overrides: Record<keyof BootstrapConfig, boolean>;
  /** The variable names actually in force, for the dialog to name in one line. */
  overrideVars: string[];
}

const MODULE_DIR = import.meta.dirname ?? process.cwd();
const inferredAppRoot = basename(MODULE_DIR) === 'dist-server'
  ? resolve(MODULE_DIR, '..')
  : resolve(MODULE_DIR, '..', '..');
/** Explicit in packaged deployments, and inferred correctly from either src/server or dist-server. */
export const APP_ROOT = resolve(process.env.SLOPESMITH_APP_ROOT?.trim() || inferredAppRoot);
export const BOOTSTRAP_DIR = join(APP_ROOT, '.slopesmith');
export const BOOTSTRAP_FILE = join(BOOTSTRAP_DIR, 'config.json');

const defaultWorkspaceRoot = () => join(APP_ROOT, 'workspace');

/**
 * The OpenSlope checkout this Slopesmith is part of, or null when it is a standalone clone.
 *
 * Detected from a sibling that SHIPS with the repository, never from `Maps/` itself. Keying off the library
 * folder made the default depend on whether anything had been extracted yet — and since the answer is resolved
 * once at startup, a server started before the first `snowknife import` kept reading a different library than
 * the one the extraction landed in, with no setting anywhere to explain the discrepancy.
 */
const openSlopeRoot = (appRoot: string): string | null => {
  const parent = resolve(appRoot, '..');
  return existsSync(join(parent, 'Snowknife')) ? parent : null;
};

/**
 * In the OpenSlope checkout the library is its `Maps/` — what every command, doc and generated `Repack.md`
 * already names. A standalone Slopesmith clone owns one inside its workspace instead.
 *
 * Takes both roots rather than reading `APP_ROOT`, so the policy is a plain function of two paths and one
 * probe, and can be checked for either layout without staging a whole app directory.
 */
export const defaultMapsRootFor = (appRoot: string, workspaceRoot: string): string => {
  const repository = openSlopeRoot(appRoot);
  return repository ? join(repository, 'Maps') : join(workspaceRoot, 'maps');
};

const defaultMapsRoot = (workspaceRoot: string) => defaultMapsRootFor(APP_ROOT, workspaceRoot);

/** Resolve a user-entered path against the app folder, falling back when the field is blank. */
function resolveFromApp(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (!raw) return '';
  return resolve(isAbsolute(raw) ? raw : join(APP_ROOT, raw));
}

/** Stored files and environment variables may contain numeric text; an API save must already be a number. */
function resolvedMaxPlayers(value: unknown, strict = false): number {
  const parsed = strict ? value : (typeof value === 'string' && value.trim() ? Number(value) : value);
  if (Number.isSafeInteger(parsed) && Number(parsed) >= 1) return Number(parsed);
  if (strict) throw new Error('Max players must be a whole number of at least 1');
  return DEFAULT_MAX_PLAYERS;
}

/** Public form of the same resolution, for callers holding a path a user just typed. */
export const resolveAppPath = (value: string): string => resolveFromApp(value, '');

/** The bootstrap file as written, or an empty record when it is absent or unreadable. */
function storedConfig(): Partial<BootstrapConfig> {
  try {
    const { referenceRoot, ...stored } =
      JSON.parse(readFileSync(BOOTSTRAP_FILE, 'utf8')) as Partial<BootstrapConfig> & { referenceRoot?: string };
    // `referenceRoot` names the same field on a machine configured before it became `mapsRoot`: adopt it so the
    // library is kept rather than silently reverting to the default. The next Save writes the current name.
    return referenceRoot && stored.mapsRoot === undefined ? { ...stored, mapsRoot: referenceRoot } : stored;
  } catch { return {}; /* first run or an invalid file: use safe, deterministic defaults */ }
}

/**
 * The resolved bootstrap record, memoised.
 *
 * This is the one place the server still reads a file synchronously, and it stays that way deliberately: the
 * record is process-startup state rather than per-request state, so it is read once and answered from memory
 * thereafter. Making it async instead would push a promise through all ~110 call sites that only want to know
 * where the map library is, for no concurrency gain — nothing is ever waiting on a read that does not happen.
 *
 * `saveWorkspaceConfig` clears the memo, so a newly selected workspace is visible to the next caller. A file
 * edited by hand underneath a running server is not, which matches the restart the Settings dialog already
 * advertises for a changed root.
 */
let memoisedConfig: ResolvedBootstrapConfig | null = null;
let ensuredWorkspace: { root: string; ready: Promise<void> } | null = null;

/** Drop the memo so the next read reflects a just-written bootstrap file. */
export function forgetWorkspaceConfig(): void {
  memoisedConfig = null;
  ensuredWorkspace = null;
}

export function workspaceConfig(): ResolvedBootstrapConfig {
  return memoisedConfig ??= resolveWorkspaceConfig();
}

/** The map library: extracted reference levels are read from it and exports are written into it. An accessor
 *  rather than a module constant, so a module imported before the workspace is chosen cannot freeze a stale
 *  path — the bug that made a changed library appear to be ignored until a restart. */
export const mapsRoot = (): string => workspaceConfig().mapsRoot;

function resolveWorkspaceConfig(): ResolvedBootstrapConfig {
  const stored = storedConfig();
  const env = (field: keyof BootstrapConfig) => process.env[ENV_OVERRIDE[field]];
  const chosen = (field: keyof BootstrapConfig) => env(field) ?? stored[field];
  const workspaceRoot = resolveFromApp(chosen('workspaceRoot'), defaultWorkspaceRoot());
  const mapsRoot = resolveFromApp(chosen('mapsRoot'), defaultMapsRoot(workspaceRoot));
  const maxPlayers = resolvedMaxPlayers(chosen('maxPlayers'));
  const overrides = Object.fromEntries(
    (Object.keys(ENV_OVERRIDE) as (keyof BootstrapConfig)[]).map(field => [field, !!env(field)]),
  ) as Record<keyof BootstrapConfig, boolean>;
  return {
    appRoot: APP_ROOT, configFile: BOOTSTRAP_FILE, configured: existsSync(BOOTSTRAP_FILE),
    workspaceRoot, mapsRoot, maxPlayers,
    overrides,
    overrideVars: Object.entries(overrides).filter(([, on]) => on)
      .map(([field]) => ENV_OVERRIDE[field as keyof BootstrapConfig]),
  };
}

async function ensureDirectory(path: string, create: boolean, label: string): Promise<void> {
  if (!await pathExists(path)) {
    if (!create) throw new Error(`${label} does not exist: ${path}`);
    await ensureDir(path);
  }
  if (!await isDirectory(path)) throw new Error(`${label} is not a folder: ${path}`);
}

/** Validate and persist the machine-local settings. Slopesmith's own folders may be created; a library it
 * only reads must already exist, so a typo cannot silently produce an empty catalogue that looks like data
 * loss or a bake that fails only at the end of an export. */
export async function saveWorkspaceConfig(input: Partial<BootstrapConfig>): Promise<{
  config: ResolvedBootstrapConfig;
  restartRequired: boolean;
}> {
  const before = workspaceConfig();
  // Start from the file as written, so a field the environment owns passes through untouched — including one
  // the record has never carried. A temporary variable is never baked in by an unrelated Save.
  const next: Partial<BootstrapConfig> = storedConfig();
  const owned = (name: keyof BootstrapConfig) => !before.overrides[name];
  // An omitted field keeps the current value; an explicitly emptied one clears it.
  const edited = (name: keyof BootstrapConfig) => input[name] === undefined ? before[name] : input[name];

  if (owned('workspaceRoot')) next.workspaceRoot = resolveFromApp(edited('workspaceRoot'), defaultWorkspaceRoot());
  const workspaceRoot = next.workspaceRoot ?? before.workspaceRoot;
  if (owned('mapsRoot')) next.mapsRoot = resolveFromApp(edited('mapsRoot'), defaultMapsRoot(workspaceRoot));
  if (owned('maxPlayers')) next.maxPlayers = resolvedMaxPlayers(edited('maxPlayers'), true);

  // Validate exactly what is about to be written; a field this save does not own is not its business.
  if (next.workspaceRoot) await ensureDirectory(next.workspaceRoot, true, 'Workspace folder');
  if (next.mapsRoot) await ensureDirectory(next.mapsRoot, false, 'Maps folder');
  await writeJsonAtomic(BOOTSTRAP_FILE, next);
  forgetWorkspaceConfig();
  const config = workspaceConfig();
  return {
    config,
    // Both roots are read once at startup by routes and file watchers, so a change to either only takes
    // effect on the next run.
    restartRequired: config.workspaceRoot !== before.workspaceRoot || config.mapsRoot !== before.mapsRoot,
  };
}

/** Ensure the stable top-level workspace layout without inventing a project. */
export async function ensureWorkspace(): Promise<ResolvedBootstrapConfig> {
  const config = workspaceConfig();
  if (!ensuredWorkspace || ensuredWorkspace.root !== config.workspaceRoot) {
    const folders = ['projects', 'library', 'cache', 'logs']
      .map(folder => ensureDir(join(config.workspaceRoot, folder)));
    // The DEFAULT library is Slopesmith's own folder by convention, so it is created like the rest. The
    // library WATCHER only attaches to a root that already exists, and a root that appears afterwards stays
    // unwatched until a restart — which is how a freshly extracted map can land in exactly the right place
    // and still show up nowhere. A CONFIGURED root is the user's and is never invented; `saveWorkspaceConfig`
    // refuses one that is not already there, so a typo cannot masquerade as an empty library.
    if (config.mapsRoot === defaultMapsRoot(config.workspaceRoot)) folders.push(ensureDir(config.mapsRoot));
    const ready = Promise.all(folders).then(() => undefined);
    ensuredWorkspace = { root: config.workspaceRoot, ready };
    // A failed first attempt must be retryable after the operator fixes the filesystem.
    void ready.catch(() => { if (ensuredWorkspace?.ready === ready) ensuredWorkspace = null; });
  }
  await ensuredWorkspace.ready;
  return config;
}
