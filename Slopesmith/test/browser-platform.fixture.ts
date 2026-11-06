import { openLocalProjects, readLocalProject } from '../src/app/state/local-projects';
import { blankMountain } from '../src/core/doc/mountain';
import { bundleAssets } from '../src/app/public/bundle-assets';
import { createMountainArchive, readMountainArchive } from '../src/app/mountain/archive';

Object.assign(window, {
  async browserPlatform(png: number[]) {
    let id = sessionStorage.getItem('platform-project');
    if (!id) {
      const projects = await openLocalProjects();
      try {
        const initial = await projects.seed(blankMountain('PLATFORM'));
        id = initial.project.id;
        const upload = await projects.request(new URL('/api/texture-upload?name=pixel', location.origin), {
          method: 'POST',
          body: new Blob([new Uint8Array(png)], { type: 'image/png' }),
        });
        if (!upload?.ok) throw new Error('browser texture upload failed');
        const edit = await projects.request(new URL(`/api/projects/${id}/document`, location.origin), {
          method: 'PUT',
          body: JSON.stringify({
            baseRevision: initial.project.revision,
            document: { ...initial.document, name: 'EDITED' },
          }),
        });
        if (!edit?.ok) throw new Error('browser document edit failed');
        sessionStorage.setItem('platform-project', id);
      } finally {
        projects.close();
      }
    }
    const bundle = await readLocalProject(id);
    if (!bundle) throw new Error('project did not survive IndexedDB reopen');
    const archive = createMountainArchive(bundle);
    const roundTrip = await readMountainArchive(archive.blob);
    const resolver = bundleAssets(roundTrip);
    try {
      const url = resolver.resolve('/api/texture?level=Custom&name=pixel.png');
      const response = await fetch(url);
      const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return {
        id,
        name: roundTrip.document.name,
        bytes,
        pixel: Array.from(context.getImageData(0, 0, 1, 1).data),
        filename: archive.filename,
      };
    } finally {
      resolver.dispose();
    }
  },
});
