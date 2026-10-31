import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';

const work = mkdtempSync(join(tmpdir(), 'slopesmith-run-picker-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(work, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(work, 'Maps');
forgetWorkspaceConfig();
forgetAccounts();
const fixture = join(work, 'runs.iso');
execFileSync(
  process.platform === 'win32' ? 'python' : 'python3',
  [
    '-c',
    [
      'import sys,struct; from pathlib import Path; sys.path.insert(0,sys.argv[1])',
      'from audio_import_test import archive,disc',
      'from ssx3_import_test import members',
      'from course_titles_test import executable,boot_files',
      "events='ABA1 ABC1 ARA1 ASS1 BHP1 BRA2 CBA2 CHP2 CRA3 DBC2 DRA4 DSS2 EBA3 EBC3 EHP3 ERA5 ESS3'.split()",
      "sections=['TRANSP','A','B','C','D','E','A_ARA1','ARA1_B']+events",
      'db=bytearray(80+88*len(sections));struct.pack_into("<II",db,0,0x01003800,0);struct.pack_into("<I",db,8,len(sections))',
      'for i,name in enumerate(sections):db[80+i*88:80+i*88+16]=name.encode().ljust(16,b"\\0")',
      'elf=bytearray(executable(streamed=True));elf[512:3000]=bytes(2488)',
      'for i,key in enumerate(sections[1:6]+events):',
      ' p=512+i*100;elf[p:p+32]=("Fixture "+key).encode().ljust(32,b"\\0");elf[p+48:p+64]=key.encode().ljust(16,b"\\0");elf[p+64:p+80]=b"BAM".ljust(16,b"\\0")',
      'files=members();files["data/worlds/bam.sdb"]=bytes(db)',
      'Path(sys.argv[2]).write_bytes(disc({"DATA/WORLDS/BAM.BIG":archive(files),**boot_files(bytes(elf))}))',
    ].join('\n'),
    resolve('../Native/tests'),
    fixture,
  ],
  { windowsHide: true },
);
const api = await startApiService({ host: '127.0.0.1', port: 0 });
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
});
await vite.listen();
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
const page = await browser.newPage();
try {
  const address = vite.httpServer!.address();
  assert(address && typeof address !== 'string');
  await page.goto(`http://127.0.0.1:${address.port}/isos`);
  await page.locator('#public-iso').setInputFiles(fixture);
  await page.locator('.public-iso-status').filter({ hasText: '27 maps found' }).waitFor({ timeout: 120_000 });
  const rows = page.locator('.public-iso-map');
  assert.equal(await rows.count(), 17);
  assert(await page.getByRole('button', { name: 'Load Fixture ARA1', exact: true }).isEnabled());
  assert.equal(await rows.filter({ hasText: 'Fixture ARA1' }).getAttribute('data-course'), 'SSX3_ARA1');
  const advanced = page.getByRole('checkbox', { name: 'Show all SSX 3 map types', exact: true });
  await advanced.check();
  assert.equal(await rows.count(), 27);
  assert(await page.getByRole('button', { name: 'Load Peak 1', exact: true }).isEnabled());
  await advanced.uncheck();
  assert.equal(await rows.count(), 17);
  await page.reload();
  await page.getByRole('button', { name: 'Load Fixture ARA1', exact: true }).waitFor();
  assert.equal(await rows.count(), 17);
  assert.equal(await advanced.isChecked(), false);
  const layout = await page.evaluate(async () => {
    const request = indexedDB.open('slopesmith-local-isos', 1);
    const db = await new Promise<IDBDatabase>(resolve => {
      request.onsuccess = () => resolve(request.result);
    });
    const row = db.transaction('discs').objectStore('discs').get('ssx3');
    const saved = await new Promise<{
      layouts: Record<string, { MapType: string; WorldId: string; SourceSections: string[] }>;
    }>(resolve => {
      row.onsuccess = () => resolve(row.result);
    });
    db.close();
    return saved.layouts.SSX3_ARA1;
  });
  assert.equal(layout.MapType, 'run');
  assert.equal(layout.WorldId, 'ssx-3:bam');
  assert.deepEqual(layout.SourceSections, ['A_ARA1', 'ARA1_B', 'ARA1']);
  await page.locator('#load-status').waitFor({ state: 'hidden', timeout: 90_000 });
  await page.screenshot({ path: join(work, 'named-runs.png') });
  console.log(
    `SSX3 RUN PICKER PASS: 17 defaults, 27 advanced entries, source names, stable IDs and persisted layout metadata. ${work}`,
  );
} finally {
  await browser.close();
  await vite.close();
  await api.close();
}
