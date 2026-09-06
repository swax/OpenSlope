import type { IncomingMessage } from 'node:http';
import type { Identity } from '../accounts/guard';

/** What every API route sees after the application authorization boundary. */
export type ApiRequest = IncomingMessage & { identity?: Identity };
