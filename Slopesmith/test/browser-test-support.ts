import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The installed Chromium-family browser the real-WebGL checks launch through playwright-core, which ships no
 * browser of its own here. `SLOPESMITH_CHROMIUM` names one outright; otherwise the usual install locations of
 * Chrome, Edge and Chromium on this platform are tried in that order. Fails the check plainly when none is
 * present rather than letting playwright complain about an executable it never had.
 */
export function chromiumExecutable(): string {
  const candidates = process.platform === 'win32' ? [
    process.env.SLOPESMITH_CHROMIUM,
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ] : process.platform === 'darwin' ? [
    process.env.SLOPESMITH_CHROMIUM,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : [
    process.env.SLOPESMITH_CHROMIUM,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const executable = candidates.find((path): path is string => !!path && existsSync(path));
  assert(executable, 'No Chromium browser found; install Chrome/Edge/Chromium or set SLOPESMITH_CHROMIUM');
  return executable;
}
