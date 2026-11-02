import type { ParticleVolume } from '../../core/particles/volumes';
import { parseTexRef } from '../../core/paint/textures';
import { particleTextureUrl, textureRefUrl } from '../net/asset-paths';
import { resolveFogTexture } from '../net/fog-texture';
import { assetWorkspaceGeneration } from '../net/workspace';
import { textureLoadState, watchAssetLoads } from '../state/asset-loads';
import { mapSourceDetails, watchMapSources } from '../state/map-sources';
import { assetSourceInfo } from '../ui/components/asset-source-info';
import { installStyles } from '../ui/components/styles';

/** Keep the same disclosure open while source resolution or the selected fog's controls update. */
export function createFogSourceInfo() {
  installStyles(
    'fog-source-info',
    `
.sp-fog-source-details { display: grid; gap: 2px; font: 11px system-ui, sans-serif; }
.sp-fog-source-row { display: grid; grid-template-columns: 66px minmax(0, 1fr); gap: 6px; }
.sp-fog-source-label { color: #6f8398; }
.sp-fog-source-value { color: #9fb3c8; overflow-wrap: anywhere; }
`,
  );
  const content = document.createElement('div');
  content.className = 'sp-fog-source-details';
  const info = assetSourceInfo(content);
  let selected: { volume: ParticleVolume; key: string; url: string; texture?: string; failed: boolean } | undefined;

  function update() {
    if (!selected) return;
    const { volume, texture, failed, url } = selected;
    const state = textureLoadState(url);
    const facts: Record<string, string | undefined> = texture
      ? mapSourceDetails(parseTexRef(texture).level)
      : volume.donor
        ? mapSourceDetails(volume.donor)
        : { source: failed ? 'Unavailable' : 'Resolving…' };
    facts.status = failed || state === 'missing' ? 'Missing texture' : state === 'ready' ? 'Ready' : 'Loading…';
    facts.filepath = texture ?? 'fog0.png (legacy shared sprite)';
    if (facts.status === 'Missing texture') facts['missing reference'] = facts.filepath;
    content.replaceChildren();
    for (const [label, value] of Object.entries(facts)) {
      if (!value) continue;
      const row = document.createElement('div');
      row.className = 'sp-fog-source-row';
      row.dataset.detail = label;
      const name = document.createElement('span');
      name.className = 'sp-fog-source-label';
      name.textContent = label;
      const text = document.createElement('span');
      text.className = 'sp-fog-source-value';
      text.textContent = text.title = value;
      row.append(name, text);
      content.appendChild(row);
    }
  }
  const refresh = () => {
    if (info.isConnected) update();
  };
  watchMapSources(refresh);
  watchAssetLoads(refresh);

  return {
    show(volume: ParticleVolume): HTMLDetailsElement {
      const key = `${assetWorkspaceGeneration()}:${volume.texture ?? ''}:${volume.donor ?? ''}`;
      if (selected?.volume !== volume || selected.key !== key) {
        const current: NonNullable<typeof selected> = {
          volume,
          key,
          texture: volume.texture,
          failed: false,
          url: volume.texture ? textureRefUrl(volume.texture) : particleTextureUrl('fog0.png', volume.donor ?? ''),
        };
        selected = current;
        if (!volume.texture)
          void resolveFogTexture(volume.donor)
            .then(texture => {
              if (selected !== current) return;
              current.texture = texture;
              update();
            })
            .catch(() => {
              if (selected !== current) return;
              current.failed = true;
              update();
            });
      }
      update();
      return info;
    },
  };
}
