import { decodeProps, type LevelProps, type PropsPayload } from '../../core/reference/props';
import { fetchText, type DownloadProgress } from '../net/fetch-json';
import { runDiagnosticPhase } from '../net/diagnostics';

export type PropLoadProgress =
  | ({ phase: 'download' } & DownloadProgress)
  | { phase: 'decode' }
  | { phase: 'register' | 'ready'; models: number; instances: number };

export type PropLoadOptions = {
  onProgress?: (progress: PropLoadProgress) => void;
  /** Present the next phase before its synchronous decoding/registration work starts. */
  afterPaint?: () => Promise<void>;
};

type Download = {
  text: Promise<string>;
  progress: PropLoadProgress;
  listeners: Set<NonNullable<PropLoadOptions['onProgress']>>;
  load?: Promise<LevelProps>;
};

/** Share downloads between reference prefetch, the library and placements. Prefetch only receives text:
 * JSON/base64 decoding and geometry registration wait for an actual consumer, after terrain's first paint. */
export function createPropLevelLoader(deps: {
  levels: Map<string, LevelProps>;
  url: (level: string) => string;
  register: (props: LevelProps, cached: boolean) => void;
}) {
  const downloads = new Map<string, Download>();
  const publish = (entry: Download, progress: PropLoadProgress) => {
    entry.progress = progress;
    for (const listener of entry.listeners) listener(progress);
  };
  function download(level: string): Download {
    const pending = downloads.get(level);
    if (pending) return pending;
    const entry: Download = {
      text: Promise.resolve(''),
      progress: { phase: 'download', receivedBytes: 0 },
      listeners: new Set(),
    };
    downloads.set(level, entry);
    entry.text = fetchText(deps.url(level), progress => publish(entry, { phase: 'download', ...progress }));
    // A failed speculative download must be handled even if terrain fails or the reference changes before
    // anyone consumes it. Consumers still receive the original rejection, and the next request can retry.
    void entry.text.catch(() => {
      if (downloads.get(level) === entry) downloads.delete(level);
    });
    return entry;
  }
  function prefetch(level: string): void {
    if (!deps.levels.has(level)) download(level);
  }
  function ensure(level: string, options: PropLoadOptions = {}): Promise<LevelProps> {
    const cached = deps.levels.get(level);
    if (cached) {
      runDiagnosticPhase('props', `${level}:register-models-cached`, () => deps.register(cached, true));
      options.onProgress?.({ phase: 'ready', models: cached.models.length, instances: cached.instances.length });
      return Promise.resolve(cached);
    }
    const entry = download(level);
    const listener = options.onProgress;
    if (listener) {
      entry.listeners.add(listener);
      listener(entry.progress);
    }
    if (!entry.load) {
      entry.load = (async () => {
        const text = await entry.text;
        publish(entry, { phase: 'decode' });
        await options.afterPaint?.();
        const payload = runDiagnosticPhase('props', `${level}:decode-json`, () => JSON.parse(text) as PropsPayload);
        if (payload.error) throw new Error(payload.error);
        payload.level = level;
        const detail = `${payload.models.length} models · ${payload.instances.length} instances`;
        const props = runDiagnosticPhase('props', `${level}:decode`, () => decodeProps(payload), detail);
        const counts = { models: props.models.length, instances: props.instances.length };
        publish(entry, { phase: 'register', ...counts });
        await options.afterPaint?.();
        runDiagnosticPhase('props', `${level}:register-models`, () => deps.register(props, false), detail);
        deps.levels.set(level, props);
        publish(entry, { phase: 'ready', ...counts });
        return props;
      })().finally(() => {
        if (downloads.get(level) === entry) downloads.delete(level);
      });
    }
    return entry.load.finally(() => {
      if (listener) entry.listeners.delete(listener);
    });
  }
  return { prefetch, ensure, invalidate: (level: string) => downloads.delete(level) };
}
