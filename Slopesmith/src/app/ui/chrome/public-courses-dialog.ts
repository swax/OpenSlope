import { modal } from '../components/modal';
import { currentAccount } from '../../net/account';
import type { PublicCourse, PublicCourseKind } from '../../../core/session/public-courses';
import type { MapOriginSummary } from '../../../core/export/origin';

/** Publication controls stay with the member's File menu; public visitors receive only the play surface. */
export async function openPublicCoursesDialog(projectId: string | null, projectName: string, manages: boolean): Promise<void> {
  const { host, close } = modal();
  host.setAttribute('role', 'dialog'); host.setAttribute('aria-label', 'Public courses');
  const title = document.createElement('h2'); title.textContent = 'Public courses';
  const explanation = document.createElement('p');
  explanation.textContent = 'Public courses appear on the homepage. Visitors can ride and chat under a guest name. Game assets come from each visitor’s own ISO.';
  const homepage = document.createElement('a'); homepage.href = '/?play'; homepage.textContent = 'Open the public homepage ↗';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const done = document.createElement('button'); done.type = 'button'; done.textContent = 'Done'; done.onclick = close;
  host.append(title, explanation, homepage, status, done);
  const account = await currentAccount();
  const moderator = account.accounts === 'open' || ('user' in account && ['admin', 'moderator'].includes(account.user.role));
  try {
    const response = await fetch('/api/publication');
    if (!response.ok) throw new Error('The course publication settings could not be loaded.');
    const data = await response.json() as { courses: PublicCourse[]; references: MapOriginSummary[] };
    function row(kind: PublicCourseKind, id: string, name: string, enabled: boolean) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;gap:10px;align-items:center;margin:14px 0;';
      const check = document.createElement('input'); check.type = 'checkbox';
      check.checked = data.courses.some(course => course.kind === kind && course.id === id); check.disabled = !enabled;
      label.append(check, document.createTextNode(name)); host.insertBefore(label, status);
      check.onchange = () => {
        const was = !check.checked; check.disabled = true; status.textContent = 'Saving…';
        void fetch(`/api/publication?kind=${kind}&id=${encodeURIComponent(id)}`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ published: check.checked }),
        }).then(async response => {
          const result = await response.json() as { error?: string };
          if (!response.ok) throw new Error(result.error ?? 'Publishing failed.');
          status.textContent = check.checked ? `${name} is public.` : `${name} is private.`;
        }).catch(error => { check.checked = was; status.textContent = String(error instanceof Error ? error.message : error); })
          .finally(() => { check.disabled = false; });
      };
    }
    if (projectId) row('project', projectId, `${projectName} · current mountain`, manages);
    if (moderator) {
      const heading = document.createElement('h3'); heading.textContent = 'Reference maps'; host.insertBefore(heading, status);
      for (const reference of data.references) row('reference', reference.name, reference.name, true);
    }
  } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
}
