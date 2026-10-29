import type { PropLoadProgress } from '../props/level-loader';
import type { LoadStatusUpdate } from '../ui/components/load-status';
import type { ReferencePropBuildProgress } from '../viewport/scene/reference-decor';

const bytes = (value: number) =>
  value < 1024 * 1024 ? `${(value / 1024).toFixed(0)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;

export function referencePropLoadStatus(progress: PropLoadProgress): LoadStatusUpdate {
  switch (progress.phase) {
    case 'download':
      return {
        label: 'Downloading reference props',
        detail:
          progress.receivedBytes === 0
            ? 'Waiting for the server to prepare model geometry and collision data'
            : progress.totalBytes
              ? `${bytes(progress.receivedBytes)} / ${bytes(progress.totalBytes)} received`
              : `${bytes(progress.receivedBytes)} received`,
        progress: progress.totalBytes ? 80 + 5 * Math.min(1, progress.receivedBytes / progress.totalBytes) : 80,
      };
    case 'decode':
      return {
        label: 'Decoding reference props',
        detail: 'Unpacking model geometry and collision data',
        progress: 86,
      };
    case 'register':
    case 'ready':
      return {
        label: progress.phase === 'register' ? 'Preparing reference prop models' : 'Building reference props',
        detail: `${progress.models.toLocaleString()} models · ${progress.instances.toLocaleString()} placements`,
        progress: progress.phase === 'register' ? 89 : 91,
      };
  }
}

export function referencePropBuildStatus(progress: ReferencePropBuildProgress): LoadStatusUpdate {
  if (progress.phase === 'textures')
    return { label: 'Building reference props', detail: 'Loading prop texture pages', progress: 91 };
  const fraction = progress.total ? progress.completed / progress.total : 1;
  const count = `${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()}`;
  switch (progress.phase) {
    case 'models':
      return { label: 'Building reference props', detail: `${count} models prepared`, progress: 91 + 2 * fraction };
    case 'placements':
      return { label: 'Building reference props', detail: `${count} prop parts placed`, progress: 93 + 3 * fraction };
    case 'picking':
      return {
        label: 'Finishing reference props',
        detail: `${count} object groups ready to select`,
        progress: 96 + fraction,
      };
  }
}
