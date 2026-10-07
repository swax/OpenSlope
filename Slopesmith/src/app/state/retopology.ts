import type { RetopologyCapabilities } from '../../core/mesh/retopology/job-contract';
import { fetchJson } from '../net/fetch-json';

/**
 * Whether this server offers retopology at all — off unless it was started with SLOPESMITH_RETOPOLOGY=1. Asked once
 * per page. Until the server answers, and if it cannot, the tool stays hidden: an editor never offers a workflow its
 * server will refuse.
 */
let enabled = false;
let asked: Promise<boolean> | null = null;

export const retopologyEnabled = (): boolean => enabled;

/** Ask the server, once; resolves true when retopology is on. */
export function loadRetopologyEnabled(): Promise<boolean> {
  asked ??= fetchJson<RetopologyCapabilities>('/api/retopology/capabilities', { cache: 'no-store' })
    .then(capabilities => (enabled = capabilities.enabled === true), () => false);
  return asked;
}
