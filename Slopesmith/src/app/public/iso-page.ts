import './home.css';
import type { PublicCourse } from '../../core/session/public-courses';
import { discCourseName } from '../../core/reference/disc-courses';
import { currentAccount } from '../net/account';
import { cachedIsoCourses, clearIsoCache, importIso, scanIso, unloadIsoCourse } from './iso-cache';
import { element, publicJson } from './dom';
import { publicHeader } from './header';
import { isoStatusBadges } from './iso-status';
import { createIsoLoadQueue } from './iso-load-queue';
import { publicCourseRequest, publicCourseUrl, resolvePublicCourse } from './links';
import { mapHeading, publicGlyph } from './presentation';

/** Disc files and extraction stay on this device; this page needs no member or guest session. */
export async function showIsoPage(): Promise<void> {
  document.body.classList.add('public-play', 'public-iso-page', 'sp-page-background');
  document.getElementById('load-status')?.classList.remove('show');
  document.title = 'ISO · Slopesmith';
  const account = await currentAccount();
  let cached = await cachedIsoCourses().catch(() => [] as string[]);
  let discovered: string[] = [];
  let file: File | null = null;
  let busy = false;
  let abort: AbortController | null = null;
  let target: PublicCourse | null = null;
  const { header } = publicHeader('iso', account);
  const main = element('main', 'public-home');
  const title = element('h1', 'public-visually-hidden', 'ISO');
  const back = element('a', 'public-manage-iso'); back.hidden = true;
  const dependencies = element('section', 'public-iso-requirements'); dependencies.hidden = true;
  dependencies.setAttribute('aria-label', 'Required ISO maps');
  const iso = element('section', 'public-iso');
  const input = element('input', ''); input.type = 'file'; input.accept = '.iso'; input.id = 'public-iso';
  const label = element('label', 'public-iso-button', 'Choose ISO'); label.htmlFor = input.id;
  label.prepend(publicGlyph('disc'));
  label.title = 'SSX Tricky PS2 ISO · Files stay on this device';
  const count = element('span', 'public-cache');
  const clear = element('button', 'public-clear', 'Clear'); clear.type = 'button'; clear.setAttribute('aria-label', 'Clear local assets');
  const loadRequired = element('button', 'public-primary', 'Load required maps'); loadRequired.type = 'button'; loadRequired.hidden = true;
  const cancel = element('button', '', 'Cancel scan'); cancel.type = 'button'; cancel.hidden = true;
  const actions = element('div', 'public-iso-actions'); actions.append(label, input, count, loadRequired, clear, cancel);
  const status = element('p', 'public-iso-status'); status.setAttribute('role', 'status');
  iso.append(actions, status);
  const heading = element('h2', 'public-visually-hidden', 'ISO maps');
  const rows = element('ul', 'public-iso-map-list'); rows.setAttribute('aria-label', 'Manage ISO maps');
  const empty = element('p', 'public-empty', 'No maps loaded.');
  main.append(title, back, dependencies, iso, heading, rows, empty);
  document.body.append(header, main);
  const cards = new Map<string, ReturnType<typeof createCard>>();
  let dependencyState = '';

  const loads = createIsoLoadQueue(async (selectedFile, slot, progress, signal) => {
    try { await importIso(selectedFile, [slot], progress, signal); }
    catch (error) { await unloadIsoCourse(slot); throw error; }
    finally { cached = await cachedIsoCourses().catch(() => cached); }
  }, render);

  function createCard(slot: string) {
    const row = element('li', 'public-iso-map public-map-tile'); row.dataset.course = slot;
    const heading = mapHeading(discCourseName(slot), 'disc');
    const badge = element('span', 'public-iso-badge');
    const controls = element('div', 'public-iso-map-actions');
    const button = element('button', ''); button.type = 'button';
    button.onclick = () => {
      const phase = loads.state(slot)?.phase;
      if (phase === 'queued' || phase === 'loading') loads.cancel(slot);
      else if (cached.includes(slot)) void operate(async () => unloadIsoCourse(slot), () => '', false);
      else loadMaps([slot]);
    };
    controls.append(button);
    const feedback = element('div', 'public-iso-feedback');
    const progress = element('progress', 'public-iso-progress');
    progress.setAttribute('aria-label', `Loading ${discCourseName(slot)}`);
    const message = element('p', 'public-iso-load-status'); message.setAttribute('role', 'status');
    feedback.append(progress, message);
    row.append(heading, badge, controls, feedback);
    return { row, badge, button, message };
  }

  function render() {
    count.textContent = `${cached.length} loaded`;
    input.disabled = clear.disabled = busy || loads.busy;
    clear.style.visibility = cached.length ? 'visible' : 'hidden';
    const required = target?.isoCourses ?? [];
    const missing = required.filter(slot => !cached.includes(slot));
    loadRequired.hidden = !required.length;
    loadRequired.style.visibility = missing.length ? 'visible' : 'hidden';
    loadRequired.disabled = busy || !file || !missing.some(slot => discovered.includes(slot)
      && !['queued', 'loading'].includes(loads.state(slot)?.phase ?? ''));
    const nextDependencies = JSON.stringify(required.map(slot => [slot, cached.includes(slot)]));
    if (target && required.length && dependencyState !== nextDependencies) {
      dependencies.replaceChildren(element('h2', '', 'Required maps'),
        isoStatusBadges(required, cached));
      dependencies.hidden = false;
      dependencyState = nextDependencies;
    }
    const maps = [...new Set([...required, ...cached, ...discovered])].sort((a, b) =>
      Number(required.includes(b)) - Number(required.includes(a)) || discCourseName(a).localeCompare(discCourseName(b)));
    empty.hidden = !!maps.length;
    for (const [slot, card] of cards) {
      if (!maps.includes(slot)) { card.row.remove(); cards.delete(slot); }
    }
    for (const [index, slot] of maps.entries()) {
      let card = cards.get(slot);
      if (!card) { card = createCard(slot); cards.set(slot, card); }
      const { row, badge, button, message } = card;
      const loaded = cached.includes(slot);
      const state = loads.state(slot);
      const pending = state?.phase === 'queued' || state?.phase === 'loading';
      const phase = state?.phase ?? (loaded ? 'loaded' : 'missing');
      row.dataset.state = phase;
      row.setAttribute('aria-busy', String(state?.phase === 'loading'));
      badge.className = `public-iso-badge ${phase}`;
      const badgeText = pending ? state.phase === 'queued' ? 'Queued' : 'Loading…'
        : state?.phase === 'error' ? 'Failed' : loaded ? 'Loaded' : 'Not loaded';
      if (badge.textContent !== badgeText) badge.textContent = badgeText;
      const feedback = state?.phase === 'error' || (state?.phase === 'loading' && state.message !== 'Loading…')
        ? state.message : file && !discovered.includes(slot) && !loaded ? 'Not found in the selected ISO.' : '';
      if (message.textContent !== feedback) { message.textContent = feedback; message.title = feedback; }
      const action = pending ? 'Cancel' : loaded ? 'Unload' : 'Load';
      if (button.textContent !== action) button.textContent = action;
      button.setAttribute('aria-label', `${pending ? 'Cancel loading' : loaded ? 'Unload' : 'Load'} ${discCourseName(slot)}`);
      button.disabled = busy || (loaded ? loads.busy : !pending && (!file || !discovered.includes(slot)));
      if (rows.children[index] !== row) rows.insertBefore(row, rows.children[index] ?? null);
    }
  }

  async function operate(run: (signal: AbortSignal) => Promise<void>, success: () => string, cancellable = true) {
    if (busy || loads.busy) return;
    busy = true; abort = new AbortController(); cancel.hidden = !cancellable; render();
    try { await run(abort.signal); status.textContent = success(); }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally {
      cached = await cachedIsoCourses().catch(() => cached);
      busy = false; abort = null; cancel.hidden = true; render();
    }
  }
  function loadMaps(slots: string[]) {
    if (!file || busy || !slots.length) return;
    status.textContent = '';
    void loads.add(file, slots);
  }
  input.onchange = () => {
    file = input.files?.[0] ?? null; discovered = [];
    if (!file) { render(); return; }
    const selectedFile = file;
    status.textContent = `Reading maps from ${selectedFile.name}…`;
    void operate(async signal => {
      try { discovered = await scanIso(selectedFile, signal); }
      catch (error) { file = null; input.value = ''; throw error; }
    }, () => `${selectedFile.name} · ${discovered.length} map${discovered.length === 1 ? '' : 's'} found`);
  };
  loadRequired.onclick = () => { loadMaps((target?.isoCourses ?? []).filter(slot => !cached.includes(slot) && discovered.includes(slot))); };
  clear.onclick = () => { void operate(clearIsoCache, () => '', false); };
  cancel.onclick = () => abort?.abort();
  window.addEventListener('pagehide', () => { abort?.abort(); loads.dispose(); }, { once: true });
  render();
  try {
    const request = publicCourseRequest(new URL(location.href));
    if (request) {
      const data = await publicJson<{ courses: PublicCourse[] }>('/api/public/courses');
      target = resolvePublicCourse(request, data.courses, cached);
      if (target) {
        back.textContent = `← ${target.name.replace(/[_-]/g, ' ')}`;
        back.href = publicCourseUrl(target); back.hidden = false;
      } else status.textContent = 'This public map is unavailable. You can still manage your local ISO maps.';
      render();
    }
  } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
}
