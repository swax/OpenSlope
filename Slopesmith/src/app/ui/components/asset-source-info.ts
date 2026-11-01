import { installStyles } from './styles';

/** Secondary asset provenance stays available without crowding the selected asset's preview. */
export function assetSourceInfo(content: HTMLElement): HTMLDetailsElement {
  installStyles(
    'asset-source-info',
    `
.sp-asset-source-info { align-self: stretch; min-width: 0; padding-top: 4px; border-top: 1px solid #294055; }
.sp-asset-source-info > summary { color: #9fb3c8; cursor: pointer; font: 11px/1.5 system-ui, sans-serif;
  user-select: none; }
.sp-asset-source-info > summary:hover { color: #cfe3f5; }
.sp-asset-source-info > summary:focus-visible { outline: 1px solid #6ee7a8; outline-offset: 2px; border-radius: 2px; }
.sp-asset-source-info > summary + * { margin-top: 6px; }
`,
  );
  const info = document.createElement('details');
  info.className = 'sp-asset-source-info';
  const summary = document.createElement('summary');
  summary.textContent = 'Source info';
  info.append(summary, content);
  return info;
}
