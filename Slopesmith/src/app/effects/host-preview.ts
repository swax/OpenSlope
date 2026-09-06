import type { LevelProps } from '../../core/reference/props';
import { ThumbRenderer, THUMB_DEFAULT_AZIMUTH, THUMB_DEFAULT_ELEVATION } from '../props/thumb-renderer';

const PREVIEW_SIZE = 104;

/**
 * A single reusable model viewer for the selected Effects host. The Effects inspector rebuilds its DOM often,
 * so keeping one canvas and moving it into the current host card avoids creating a WebGL context per render.
 * Trigger volumes have no mesh by design; their preview is the compact yellow box/X symbol instead.
 */
export class EffectHostPreview {
  readonly el = document.createElement('div');
  private content = document.createElement('div');
  private status = document.createElement('span');
  private thumb: ThumbRenderer | null = null;
  private key = '';
  private token = 0;
  /** One shared renderer means builds must stay ordered; the newest queued request always renders last. */
  private renderQueue: Promise<void> = Promise.resolve();

  constructor(private loadLevel: (level: string) => Promise<LevelProps>, label = 'Effect host model preview') {
    this.el.className = 'sp-fx-host-preview';
    this.el.setAttribute('aria-label', label);
    this.content.className = 'sp-fx-host-preview-content';
    this.status.className = 'sp-fx-host-preview-status';
    this.el.append(this.content, this.status);
  }

  showTrigger(): HTMLElement {
    if (this.key === 'trigger') return this.el;
    this.key = 'trigger';
    ++this.token;
    this.el.classList.remove('loading', 'unavailable');
    this.el.classList.add('trigger');
    this.status.textContent = '';
    this.content.replaceChildren();
    const symbol = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    symbol.setAttribute('viewBox', '0 0 120 90');
    symbol.setAttribute('role', 'img');
    symbol.setAttribute('aria-label', 'Yellow trigger box');
    symbol.innerHTML = `
      <path class="sp-fx-trigger-fill" d="M25 29h61v42H25z" />
      <g class="sp-fx-trigger-lines">
        <path d="M25 29h61v42H25zM25 29l13-11h61v42L86 71M86 29l13-11M99 18v42" />
        <path class="sp-fx-trigger-x" d="M31 35l49 30M80 35L31 65" />
      </g>`;
    this.content.appendChild(symbol);
    return this.el;
  }

  showModel(level: string, model: number): HTMLElement {
    const key = `${level}:${model}`;
    if (this.key === key) return this.el;
    this.key = key;
    const mine = ++this.token;
    this.el.classList.remove('trigger', 'unavailable');
    this.el.classList.add('loading');
    this.status.textContent = 'Loading preview…';
    this.content.replaceChildren();

    let thumb: ThumbRenderer;
    try {
      thumb = this.thumb ??= new ThumbRenderer(PREVIEW_SIZE);
      thumb.canvas.setAttribute('aria-hidden', 'true');
      this.content.appendChild(thumb.canvas);
    } catch {
      this.showUnavailable(mine);
      return this.el;
    }

    this.renderQueue = this.renderQueue.catch(() => {}).then(async () => {
      const props = await this.loadLevel(level);
      if (mine !== this.token) return;
      const propModel = props.models.find(candidate => candidate.id === model);
      if (!propModel?.subs.length) { this.showUnavailable(mine); return; }
      await thumb.prepare(propModel, level, props.materials);
      if (mine !== this.token) return;
      thumb.view(THUMB_DEFAULT_AZIMUTH, THUMB_DEFAULT_ELEVATION);
      this.el.classList.remove('loading', 'unavailable');
      this.status.textContent = '';
    }).catch(() => this.showUnavailable(mine));
    return this.el;
  }

  private showUnavailable(token: number): void {
    if (token !== this.token) return;
    this.el.classList.remove('loading');
    this.el.classList.add('unavailable');
    this.status.textContent = 'Preview unavailable';
  }
}
