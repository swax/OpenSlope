import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

export const BROWSER_INVENTORY = 'ThirdPartyNotices/npm-browser-packages.json';
export const BROWSER_NOTICE_ASSET = 'ThirdPartyNotices/npm-browser-dependencies.txt';
export const VIRTUAL_NOTICE_ID = 'virtual:slopesmith-dependency-notices';
const RESOLVED_NOTICE_ID = `\0${VIRTUAL_NOTICE_ID}`;
const POLICY_LINE = /^\s*npm-(runtime-browser|runtime-server|development-only):\s+(\S+)\s+—\s+(.+?)\s*$/;
const LEGAL_FILE = /^(?:licen[cs]e|notice|copying)(?:\..*)?$/i;

const posix = (value) => value.replaceAll('\\', '/');
const sorted = (values) => [...values].sort((a, b) => a.localeCompare(b));

function packageNameFromSpecifier(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return null;
  const parts = specifier.split('/');
  return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function setDifference(left, right) {
  return sorted([...left].filter((item) => !right.has(item)));
}

function assertSameSet(label, actual, expected) {
  const missing = setDifference(expected, actual);
  const extra = setDifference(actual, expected);
  if (!missing.length && !extra.length) return;
  const details = [
    missing.length ? `missing: ${missing.join(', ')}` : '',
    extra.length ? `unexpected: ${extra.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  throw new Error(`${label} does not match (${details})`);
}

/** Read the machine-checkable dependency categories embedded in the human NOTICE. */
export async function readDependencyPolicy(appRoot) {
  const manifest = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'));
  const notice = await readFile(join(appRoot, 'NOTICE'), 'utf8');
  const categories = {
    'runtime-browser': new Map(),
    'runtime-server': new Map(),
    'development-only': new Map(),
  };
  for (const line of notice.split(/\r?\n/)) {
    const match = line.match(POLICY_LINE);
    if (!match) continue;
    const [, category, name, license] = match;
    if (categories[category].has(name)) throw new Error(`NOTICE lists ${name} twice as npm-${category}`);
    categories[category].set(name, license);
  }

  const runtime = new Set(Object.keys(manifest.dependencies ?? {}));
  const development = new Set(Object.keys(manifest.devDependencies ?? {}));
  const classifiedRuntime = new Set([
    ...categories['runtime-browser'].keys(),
    ...categories['runtime-server'].keys(),
  ]);
  assertSameSet('NOTICE runtime dependency classification', classifiedRuntime, runtime);
  assertSameSet('NOTICE development-only dependency classification',
    new Set(categories['development-only'].keys()), development);
  const categoryOverlap = setDifference(
    new Set(categories['development-only'].keys()),
    new Set([...runtime, ...development].filter((name) => development.has(name) && !runtime.has(name))),
  );
  if (categoryOverlap.length) throw new Error(`NOTICE classifies runtime packages as development-only: ${categoryOverlap.join(', ')}`);

  return {
    manifest,
    browser: new Set(categories['runtime-browser'].keys()),
    server: new Set(categories['runtime-server'].keys()),
    development: new Set(categories['development-only'].keys()),
  };
}

/** Return the installed package root that owns a Vite/Rollup module id. */
export function packageRootFromModuleId(moduleId) {
  if (!moduleId || moduleId.startsWith('\0')) return null;
  const clean = posix(moduleId.split('?', 1)[0]);
  const marker = '/node_modules/';
  const at = clean.lastIndexOf(marker);
  if (at < 0) return null;
  const prefix = clean.slice(0, at + marker.length);
  const parts = clean.slice(at + marker.length).split('/');
  const count = parts[0]?.startsWith('@') ? 2 : 1;
  if (parts.length < count || parts.slice(0, count).some((part) => !part)) return null;
  return normalize(prefix + parts.slice(0, count).join('/'));
}

async function exists(path) {
  try { await access(path); return true; }
  catch { return false; }
}

async function installedRecord(packageRoot, appRoot) {
  const manifestPath = join(packageRoot, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest.name || !manifest.version) throw new Error(`installed package lacks name/version: ${manifestPath}`);
  const legalFiles = (await readdir(packageRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && LEGAL_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  return {
    root: packageRoot,
    path: posix(relative(appRoot, packageRoot)),
    name: manifest.name,
    version: manifest.version,
    license: typeof manifest.license === 'string' ? manifest.license : JSON.stringify(manifest.license ?? 'not declared'),
    manifest,
    legalFiles,
  };
}

export async function recordsFromModuleIds(moduleIds, appRoot) {
  const roots = new Set([...moduleIds].map(packageRootFromModuleId).filter(Boolean));
  const records = await Promise.all([...roots].map((root) => installedRecord(root, appRoot)));
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

export function inventoryDocument(records) {
  return {
    version: 1,
    generatedBy: 'npm run notices:inventory',
    packages: records.map(({ path, name, version }) => ({ path, name, version })),
  };
}

async function recordsFromInventory(appRoot, inventory) {
  const records = [];
  for (const expected of inventory.packages ?? []) {
    const packageRoot = resolve(appRoot, expected.path);
    const relativePath = relative(appRoot, packageRoot);
    if (relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(`browser notice inventory escapes Slopesmith/: ${expected.path}`);
    }
    const record = await installedRecord(packageRoot, appRoot);
    if (record.path !== expected.path || record.name !== expected.name || record.version !== expected.version) {
      throw new Error(`installed package drift for ${expected.path}: expected ${expected.name}@${expected.version}, `
        + `found ${record.name}@${record.version}`);
    }
    records.push(record);
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

function inventoryKeys(records) {
  return new Set(records.map(({ path, name, version }) => `${path}\0${name}\0${version}`));
}

function inventoryMismatch(actual, expected) {
  const actualKeys = inventoryKeys(actual);
  const expectedKeys = inventoryKeys(expected);
  return {
    missing: expected.filter((record) => !actualKeys.has(`${record.path}\0${record.name}\0${record.version}`)),
    extra: actual.filter((record) => !expectedKeys.has(`${record.path}\0${record.name}\0${record.version}`)),
  };
}

/** Render root legal files verbatim. The report is reproducible: it contains no time or machine path. */
export async function renderInstalledNotices(records, heading) {
  const lines = [
    heading,
    '',
    'Generated from the installed package tree. Package versions and legal files are build inputs.',
    'The browser build also fails when its direct bundled set drifts from the checked inventory.',
    '',
    'PACKAGES',
    ...records.map((record) => `- ${record.name}@${record.version} (${record.license})`),
  ];
  for (const record of records) {
    lines.push('', '='.repeat(80), `${record.name}@${record.version}`, `Installed path: ${record.path}`,
      `Declared license: ${record.license}`);
    if (!record.legalFiles.length) {
      lines.push('', '[No root LICENSE, NOTICE, or COPYING file is present in this installed package. '
        + 'Its package.json license metadata is recorded above.]');
    }
    for (const filename of record.legalFiles) {
      const body = (await readFile(join(record.root, filename), 'utf8')).trimEnd();
      lines.push('', '-'.repeat(80), filename, '-'.repeat(80), body);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function findInstalledPackageRoot(name, fromRoot, appRoot) {
  let cursor = fromRoot;
  const boundary = resolve(appRoot);
  for (;;) {
    const candidate = join(cursor, 'node_modules', ...name.split('/'));
    if (await exists(join(candidate, 'package.json'))) return candidate;
    if (resolve(cursor) === boundary) return null;
    const parent = dirname(cursor);
    if (parent === cursor || !resolve(parent).toLowerCase().startsWith(boundary.toLowerCase())) return null;
    cursor = parent;
  }
}

/** Resolve the actually installed runtime closure for external server packages (development packages excluded). */
export async function installedDependencyClosure(appRoot, directNames) {
  const queue = [];
  for (const name of sorted(directNames)) {
    const root = await findInstalledPackageRoot(name, appRoot, appRoot);
    if (!root) throw new Error(`required installed dependency is missing: ${name}`);
    queue.push(root);
  }
  const seen = new Set();
  const records = [];
  while (queue.length) {
    const root = queue.shift();
    const key = resolve(root).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const record = await installedRecord(root, appRoot);
    records.push(record);
    const required = Object.keys(record.manifest.dependencies ?? {});
    const optional = Object.keys(record.manifest.optionalDependencies ?? {});
    for (const name of sorted(new Set([...required, ...optional]))) {
      const child = await findInstalledPackageRoot(name, root, appRoot);
      if (child) queue.push(child);
      else if (required.includes(name)) throw new Error(`${record.name} requires missing installed package ${name}`);
    }
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

export function externalPackageNames(metafile) {
  const names = new Set();
  for (const output of Object.values(metafile.outputs ?? {})) {
    for (const imported of output.imports ?? []) {
      if (!imported.external) continue;
      const name = packageNameFromSpecifier(imported.path);
      if (name) names.add(name);
    }
  }
  return names;
}

export function assertPolicyCategory(label, actual, expected) {
  assertSameSet(label, new Set(actual), new Set(expected));
}

/** Vite plugin: embed installed legal text, emit it beside dist/, and prove the inventory is the bundle graph. */
export function dependencyNoticesPlugin(appRoot) {
  let policy;
  let expectedRecords = [];
  let report = '';
  let loaded;
  const inventoryPath = join(appRoot, BROWSER_INVENTORY);
  const updateInventory = process.env.SLOPESMITH_WRITE_NOTICE_INVENTORY === '1';
  const printInventory = process.env.SLOPESMITH_PRINT_NOTICE_INVENTORY === '1';
  const refreshingInventory = updateInventory || printInventory;

  const loadInputs = async () => {
    if (!loaded) loaded = (async () => {
      policy = await readDependencyPolicy(appRoot);
      try {
        const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
        expectedRecords = await recordsFromInventory(appRoot, inventory);
      } catch (error) {
        if (!refreshingInventory) throw error;
        expectedRecords = [];
      }
      const closure = await installedDependencyClosure(appRoot,
        expectedRecords.map((record) => record.name));
      report = await renderInstalledNotices(closure,
        'Slopesmith browser bundle and installed runtime closure — third-party licenses and notices');
    })();
    await loaded;
  };

  return {
    name: 'slopesmith-dependency-notices',
    async buildStart() { await loadInputs(); },
    resolveId(id) { return id === VIRTUAL_NOTICE_ID ? RESOLVED_NOTICE_ID : null; },
    async load(id) {
      if (id !== RESOLVED_NOTICE_ID) return null;
      await loadInputs();
      return `export default ${JSON.stringify(report)};`;
    },
    async generateBundle() {
      await loadInputs();
      const actualRecords = await recordsFromModuleIds(this.getModuleIds(), appRoot);
      const actualDirect = new Set(actualRecords.map((record) => record.name)
        .filter((name) => Object.hasOwn(policy.manifest.dependencies ?? {}, name)));
      assertSameSet('NOTICE browser-bundled dependencies', actualDirect, policy.browser);

      const nextInventory = inventoryDocument(actualRecords);
      if (printInventory) console.log(`SLOPESMITH_BROWSER_NOTICE_INVENTORY\n${JSON.stringify(nextInventory, null, 2)}`);
      if (updateInventory) {
        await writeFile(inventoryPath, `${JSON.stringify(nextInventory, null, 2)}\n`, 'utf8');
        this.warn(`updated ${BROWSER_INVENTORY}; run npm run build:client to verify and emit the notices`);
        return;
      }

      const mismatch = inventoryMismatch(actualRecords, expectedRecords);
      if (mismatch.missing.length || mismatch.extra.length) {
        const describe = (record) => `${record.name}@${record.version} (${record.path})`;
        const details = [
          mismatch.missing.length ? `no longer bundled: ${mismatch.missing.map(describe).join(', ')}` : '',
          mismatch.extra.length ? `newly bundled: ${mismatch.extra.map(describe).join(', ')}` : '',
        ].filter(Boolean).join('; ');
        this.error(`browser dependency notice inventory drift (${details}). Run npm run notices:inventory, review it, then rebuild.`);
      }
      this.emitFile({ type: 'asset', fileName: BROWSER_NOTICE_ASSET, source: report });
    },
  };
}
