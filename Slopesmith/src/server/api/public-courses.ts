import { createGuest, guestMember } from '../accounts/guests';
import { isPublished, publicCourses, setPublished } from '../public-courses';
import { openProject } from '../projects';
import { jsonResponse, readJsonBody, type ApiHandler } from './common';
import type { ApiRequest } from './request';
import { listLevelOrigins } from '../routes/levels';

export const publicCourseRoutes: Record<string, ApiHandler> = {
  '/api/public': async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/courses' && req.method === 'GET') {
        const [courses, guest] = await Promise.all([publicCourses(), guestMember(req)]);
        jsonResponse(res, 200, { courses, guest }); return;
      }
      if (path === '/guest' && req.method === 'POST') {
        const body = await readJsonBody(req, 1024) as { name?: unknown };
        jsonResponse(res, 200, { member: await createGuest(req, res, body.name) }); return;
      }
      if (path === '/project' && req.method === 'GET') {
        const id = url.searchParams.get('id') ?? '';
        if (!await isPublished('project', id)) { jsonResponse(res, 404, { error: 'Course not found.' }); return; }
        const { document, project } = await openProject(id);
        // Imported effect graphs contain disc data. Their absence must not prevent riding authored terrain.
        const publicDocument = document.effects?.source ? { ...document, effects: undefined } : document;
        jsonResponse(res, 200, { document: publicDocument, project: { id: project.id, name: project.name, revision: project.revision } }); return;
      }
      jsonResponse(res, 404, { error: 'Public route not found.' });
    } catch (error) { jsonResponse(res, 400, { error: String(error instanceof Error ? error.message : error) }); }
  },
  '/api/publication': async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const identity = (req as ApiRequest).identity;
    if (!identity || !('user' in identity)) { jsonResponse(res, 401, { error: 'Sign in to publish a course.' }); return; }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const kind = url.searchParams.get('kind'), id = url.searchParams.get('id') ?? '';
      if (req.method === 'GET' && kind === null) {
        jsonResponse(res, 200, { courses: await publicCourses(), references: await listLevelOrigins() }); return;
      }
      if (kind !== 'project' && kind !== 'reference') { jsonResponse(res, 400, { error: 'Unknown course kind.' }); return; }
      if (req.method === 'GET') { jsonResponse(res, 200, { published: await isPublished(kind, id) }); return; }
      if (req.method !== 'PUT') { jsonResponse(res, 405, { error: 'GET or PUT only.' }); return; }
      const body = await readJsonBody(req, 1024) as { published?: unknown };
      if (typeof body.published !== 'boolean') throw new Error('published must be a boolean.');
      await setPublished(kind, id, body.published, identity.user);
      jsonResponse(res, 200, { published: body.published });
    } catch (error) { jsonResponse(res, 403, { error: String(error instanceof Error ? error.message : error) }); }
  },
};
