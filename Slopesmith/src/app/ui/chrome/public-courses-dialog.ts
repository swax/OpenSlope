import './public-courses-dialog.css';
import { clientFetch } from '../../net/client';
import { modal } from '../components/modal';
import { currentAccount } from '../../net/account';
import type { PublicCourse } from '../../../core/session/public-courses';
import type { MapOriginSummary } from '../../../core/export/origin';
import { coursePublication } from '../../net/publication';
import { MAPS_PATH } from '../../navigation';
import { publicGlyph } from '../../public/presentation';
import { svg } from '../components/icons';

/** Server reference-map publication controls; the menu entry is currently hidden. */
export async function openPublicReferenceMapsDialog(): Promise<void> {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const { host, close } = modal();
  host.classList.add('sp-public-courses');
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'true');
  host.setAttribute('aria-label', 'Public reference maps');
  host.setAttribute('aria-busy', 'true');
  const dismiss = () => {
    document.removeEventListener('keydown', onKey, true);
    close();
    if (opener?.isConnected && opener !== document.body) opener.focus();
    else document.querySelector<HTMLButtonElement>('[aria-label="File menu"]')?.focus();
  };
  function onKey(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    }
    if (event.key !== 'Tab') return;
    const controls = [
      ...host.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]'),
    ].filter(control => control.getClientRects().length);
    const first = controls[0],
      last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  document.addEventListener('keydown', onKey, true);
  host.parentElement!.addEventListener('click', event => {
    if (event.target === host.parentElement) dismiss();
  });

  const header = document.createElement('header');
  header.className = 'sp-public-courses-head';
  const title = document.createElement('h2');
  title.textContent = 'Public reference maps';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'sp-btn sp-public-courses-close';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.innerHTML = svg('<path d="m6 6 12 12M18 6 6 18"/>');
  closeButton.onclick = dismiss;
  const explanation = document.createElement('p');
  explanation.textContent =
    'Choose which reference maps appear on the public Maps page. Visitors can ride without signing in.';
  header.append(title, closeButton, explanation);
  const body = document.createElement('div');
  body.className = 'sp-public-courses-body';
  const footer = document.createElement('footer');
  footer.className = 'sp-public-courses-footer';
  const status = document.createElement('p');
  status.className = 'sp-public-courses-status';
  status.setAttribute('role', 'status');
  status.textContent = 'Loading sharing settings…';
  const actions = document.createElement('div');
  actions.className = 'sp-public-courses-actions';
  const homepage = document.createElement('a');
  homepage.className = 'sp-btn';
  homepage.href = MAPS_PATH;
  homepage.textContent = 'Open public maps ↗';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'sp-btn accent';
  done.textContent = 'Done';
  done.onclick = dismiss;
  actions.append(homepage, done);
  footer.append(status, actions);
  host.append(header, body, footer);
  closeButton.focus();

  const account = await currentAccount();
  const moderator =
    account.accounts === 'open' || ('user' in account && ['admin', 'moderator'].includes(account.user.role));
  try {
    if (!moderator) {
      status.textContent = 'Only administrators and moderators can change reference-map sharing.';
      return;
    }
    const response = await clientFetch('/api/publication');
    if (!response.ok) throw new Error('The course publication settings could not be loaded.');
    const data = (await response.json()) as { courses: PublicCourse[]; references: MapOriginSummary[] };
    if (!host.isConnected) return;
    function section(title: string, detail: string) {
      const section = document.createElement('section');
      const heading = document.createElement('h3');
      heading.textContent = title;
      section.setAttribute('aria-label', title);
      const note = document.createElement('p');
      note.className = 'sp-public-courses-note';
      note.textContent = detail;
      const list = document.createElement('div');
      list.className = 'sp-public-courses-list';
      section.append(heading, note, list);
      body.append(section);
      return list;
    }
    function row(list: HTMLElement, id: string, name: string, detail: string, enabled: boolean) {
      const label = document.createElement('label');
      label.className = 'sp-public-course';
      label.dataset.enabled = String(enabled);
      const icon = document.createElement('span');
      icon.className = 'sp-public-course-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.append(publicGlyph('disc'));
      const info = document.createElement('span');
      info.className = 'sp-public-course-info';
      const title = document.createElement('strong');
      title.textContent = name;
      const note = document.createElement('small');
      note.textContent = detail;
      info.append(title, note);
      const control = document.createElement('span');
      control.className = 'sp-public-course-control';
      const state = document.createElement('span');
      state.setAttribute('aria-hidden', 'true');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.setAttribute('role', 'switch');
      check.setAttribute('aria-label', 'Share ' + name + ' publicly');
      check.checked = data.courses.some(course => course.kind === 'reference' && course.id === id);
      check.disabled = !enabled;
      const track = document.createElement('span');
      track.className = 'sp-public-course-track';
      track.setAttribute('aria-hidden', 'true');
      const paint = (saving = false) => {
        label.dataset.published = String(check.checked);
        label.setAttribute('aria-busy', String(saving));
        state.textContent = saving ? 'Saving…' : check.checked ? 'Public' : 'Private';
      };
      control.append(state, check, track);
      label.append(icon, info, control);
      list.append(label);
      paint();
      check.onchange = () => {
        const was = !check.checked;
        check.disabled = true;
        paint(true);
        status.dataset.state = 'saving';
        status.textContent = 'Saving ' + name + '…';
        void coursePublication('reference', id, check.checked)
          .then(published => {
            check.checked = published;
            status.dataset.state = 'saved';
            status.textContent = name + (published ? ' is public.' : ' is private.');
          })
          .catch(error => {
            check.checked = was;
            status.dataset.state = 'error';
            status.textContent = error instanceof Error ? error.message : String(error);
          })
          .finally(() => {
            check.disabled = !enabled;
            paint();
          });
      };
    }
    const references = section(
      'Reference maps',
      'Maps available on this server. ISO maps require the visitor’s own disc import.',
    );
    for (const reference of data.references)
      row(references, reference.name, reference.name, reference.retailData ? 'ISO required' : 'Server map', true);
    if (!data.references.length) references.textContent = 'No reference maps are available on this server.';
    status.textContent = 'Changes save automatically.';
  } catch (error) {
    status.dataset.state = 'error';
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    host.setAttribute('aria-busy', 'false');
  }
}
