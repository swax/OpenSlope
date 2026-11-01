import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator } from 'playwright-core';

/** Open the actions belonging to one map before exercising a menu-only control. */
export async function openMapActionsFor(action: Locator): Promise<void> {
  const trigger = action.locator('xpath=ancestor::article[1]').getByRole('button', { name: /^Map actions for / });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
    await trigger.scrollIntoViewIfNeeded();
    // Let scrolling finish before opening a menu that dismisses on page scroll.
    await trigger.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await trigger.click();
  }
}

export async function clickMapAction(action: Locator): Promise<void> {
  await action.and(action.page().locator('button:enabled')).waitFor({ state: 'attached' });
  await openMapActionsFor(action);
  await action.click();
}

/**
 * The installed Chromium-family browser the real-WebGL checks launch through playwright-core, which ships no
 * browser of its own here. `SLOPESMITH_CHROMIUM` names one outright; otherwise the usual install locations of
 * Chrome, Edge and Chromium on this platform are tried in that order. Fails the check plainly when none is
 * present rather than letting playwright complain about an executable it never had.
 */
export function chromiumExecutable(): string {
  const candidates =
    process.platform === 'win32'
      ? [
          process.env.SLOPESMITH_CHROMIUM,
          process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          process.env['PROGRAMFILES(X86)'] &&
            join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ]
      : process.platform === 'darwin'
        ? [
            process.env.SLOPESMITH_CHROMIUM,
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : [
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
