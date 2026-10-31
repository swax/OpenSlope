import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';

const root = fileURLToPath(new URL('../..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'slopesmith-import-cache-'));
const server = createServer();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const generated = spawnSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [
      '-c',
      [
        'import sys,json',
        'from pathlib import Path',
        'sys.path.insert(0,sys.argv[1])',
        'from import_session_test import fixtures',
        'from audio_import_test import fixture,archive,disc,graph',
        'from audio_container_test import bank,stream',
        'out=Path(sys.argv[2]); cases=[]',
        'for game,data,count in fixtures():',
        ' name=game+".iso"; (out/name).write_bytes(data); cases.append({"game":game,"file":name,"music":count})',
        'changed=fixture(); changed["DATA/AUDIO/MUSIC.BIG"]=archive({"song.mpf":graph(),"song.mus":stream().replace(bytes([12,24]),bytes([12,25]),1),"loop.bnk":bank()})',
        '(out/"modified.iso").write_bytes(disc(changed))',
        '(out/"cases.json").write_text(json.dumps(cases))',
      ].join('\n'),
      resolve('../Native/tests'),
      work,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(generated.status, 0, generated.stderr);
  for (const [entry, output] of [
    ['src/app/public/iso-worker.ts', 'worker.js'],
    ['src/app/public/iso-cache.ts', 'cache.js'],
  ]) {
    await build({
      entryPoints: [resolve(entry)],
      outfile: join(work, output),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      logLevel: 'silent',
    });
  }
  server.on('request', (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/cache.js' || path === '/iso-worker.ts') {
      response.setHeader('content-type', 'text/javascript');
      response.end(readFileSync(join(work, path === '/cache.js' ? 'cache.js' : 'worker.js')));
    } else if (/^\/iso-importer\/openslope_browser_import\.(js|wasm)$/.test(path)) {
      response.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : 'application/wasm');
      response.end(readFileSync(join(root, 'Slopesmith/public', path)));
    } else if (/^\/fixtures\/[a-z0-9]+\.iso$/.test(path))
      response.end(readFileSync(join(work, path.split('/').at(-1)!)));
    else response.end('<!doctype html><title>Importer cache checks</title>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  const page = await browser.newPage();
  await page.addInitScript('globalThis.__name = fn => fn;');
  await page.goto(`http://127.0.0.1:${address.port}`);
  const cases = JSON.parse(readFileSync(join(work, 'cases.json'), 'utf8')) as {
    game: string;
    file: string;
    music: number;
  }[];
  const results = await page.evaluate(async cases => {
    type Reply = {
      type: string;
      files?: number;
      batches?: number;
      stats?: { scans: number; extractions: number; musicHits: number; musicMisses: number };
    };
    const replies: Reply[] = [];
    let workers = 0;
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        ++workers;
        this.addEventListener('message', event => replies.push(event.data as Reply));
      }
    };
    const cacheUrl = '/cache.js';
    const api = (await import(cacheUrl)) as {
      scanIso(file: File): Promise<string[]>;
      importIso(file: File, courses: string[], progress: (text: string) => void): Promise<void>;
      unloadIsoCourse(course: string): Promise<void>;
      readCachedCourse(course: string): Promise<Map<string, Blob>>;
      closeIsoImporterSessions(): void;
      clearIsoCache(): Promise<void>;
    };
    const require = (value: unknown, text: string) => {
      if (!value) throw new Error(text);
    };
    const last = () => replies.filter(reply => reply.type === 'done').at(-1)!.stats!;
    const hashes = async (course: string) => {
      const files = await api.readCachedCourse(course),
        result: Record<string, string> = {};
      for (const [path, blob] of files)
        if (path.startsWith('audio/music/'))
          result[path] = Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())),
            b => b.toString(16).padStart(2, '0'),
          ).join('');
      return JSON.stringify(Object.entries(result).sort());
    };
    const reports = [];
    let trickyHashes = '',
      trickyFile: File | undefined;
    for (const fixture of cases) {
      const file = new File([await (await fetch(`/fixtures/${fixture.file}`)).arrayBuffer()], fixture.file, {
        lastModified: 42,
      });
      const before = workers;
      const courses = await api.scanIso(file),
        course = courses[0];
      await api.importIso(file, [course], () => {});
      require(workers === before + 1, `${fixture.game}: scan and import should share a worker`);
      require(last().scans === 1 &&
        last().musicMisses ===
          fixture.music, `${fixture.game}: unexpected cold import counts ${JSON.stringify(last())}`);
      const expected = await hashes(course);
      await api.unloadIsoCourse(course);
      await api.importIso(file, [course], () => {});
      require(workers === before + 1 &&
        last().scans === 1 &&
        last().extractions === 2, `${fixture.game}: session was recreated`);
      require(last().musicHits === fixture.music, `${fixture.game}: second import decoded shared music again`);
      require((await hashes(course)) === expected, `${fixture.game}: warm music differs`);
      const saved = replies.filter(reply => reply.type === 'progress' && reply.batches).at(-1)!;
      require(saved.batches! < saved.files!, `${fixture.game}: each file still uses a separate transaction`);
      api.closeIsoImporterSessions();
      await api.unloadIsoCourse(course);
      await api.importIso(file, [course], () => {});
      require(last().musicMisses === 0 &&
        last().musicHits === fixture.music, `${fixture.game}: persistent cache was not reused`);
      require((await hashes(course)) === expected, `${fixture.game}: reopened music differs`);
      reports.push({ game: fixture.game, files: saved.files, batches: saved.batches, music: last() });
      if (fixture.game === 'tricky') {
        trickyHashes = expected;
        trickyFile = file;
      }
      api.closeIsoImporterSessions();
    }
    // Damage a WAV without changing its size. Native validation must rebuild it from the ISO.
    const opening = indexedDB.open('slopesmith-import-music', 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const tx = db.transaction(['entries', 'files'], 'readwrite');
    const entries = tx.objectStore('entries').getAll();
    const rows = tx.objectStore('files').getAll();
    await new Promise<void>((resolve, reject) => {
      rows.onsuccess = () => {
        const entry = entries.result.find(entry =>
          entry.manifest.Files.some((file: { Path: string }) => file.Path === 'config.json'),
        );
        require(entry, 'Missing Tricky cache');
        const row = rows.result.find(row => row.generation === entry.generation && row.path === 'chunk_000.wav');
        require(row, 'Missing cached WAV');
        row.blob = new Blob([new Uint8Array(row.blob.size)]);
        tx.objectStore('files').put(row);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    const course = (await api.scanIso(trickyFile!))[0];
    await api.unloadIsoCourse(course);
    await api.importIso(trickyFile!, [course], () => {});
    require(last().musicMisses === 1 &&
      (await hashes(course)) === trickyHashes, 'Damaged persistent music must be repaired');
    api.closeIsoImporterSessions();
    const modified = new File([await (await fetch('/fixtures/modified.iso')).arrayBuffer()], trickyFile!.name, {
      lastModified: 42,
    });
    require(modified.size === trickyFile!.size, 'Modified source fixture should preserve file size');
    await api.importIso(modified, [course], () => {});
    require(last().musicMisses === 1 &&
      (await hashes(course)) !==
        trickyHashes, 'Source bytes, rather than filename or size, must identify cached music');
    await api.clearIsoCache();
    return reports;
  }, cases);
  console.log('ISO IMPORT CACHE BROWSER PASS:', JSON.stringify(results));
} finally {
  await browser?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(work, { recursive: true, force: true });
}
