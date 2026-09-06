import type { Identity } from '../accounts/guard';
import { holds, type Role } from '../accounts/policy';

/**
 * The HATEOAS envelope — how this API tells a client, human or agent, what can be done from here (docs/052).
 *
 * The audience is a program that arrives knowing only the base URL and (on a server with accounts) a bearer
 * key. It GETs `/api`, and every request after that is informed by the previous response: `_links` say where
 * to go, `_actions` are ready-to-invoke requests with an inline body stub, and `schema` points at the full
 * JSON Schema for the rare body the stub does not explain. Nothing is loaded up front, so the surface can
 * grow without growing what every caller must read first.
 *
 * Four members, each optional, spread into an ordinary JSON response rather than wrapping it — every response
 * keeps the exact shape the browser editor already reads, and the envelope is additive:
 *
 *   _links            navigation: self, collection, parent, related resources
 *   _actions          concrete requests this resource accepts right now (method + href + body stub)
 *   _linkTemplates    URL patterns for the items of a list, so a list row stays one slim object
 *   _actionTemplates  action patterns with `{variables}`, for actions that apply across many names
 *
 * `rel` is the stable name a client keys on; hrefs are what changes. Where the caller's identity is known and
 * the response is not shared through the response cache, an action the caller cannot invoke is emitted
 * disabled with the reason — discoverable, with recourse — rather than hidden. Cached responses are shared by
 * every caller, so envelopes built inside a cache producer must not read the identity at all; their actions
 * are emitted whole and the route itself still refuses with the same reason.
 */

export interface ApiLink {
  rel: string;
  href: string;
  title?: string;
}

/** How a request that cannot be a JSON body arrives — an upload's raw bytes, named by content type. */
export interface AlternateEncoding {
  contentType: string;
  /** Plain-English instruction: what the bytes are and where any parameters go (usually the query string). */
  description: string;
}

export interface ApiAction {
  rel: string;
  href: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  title?: string;
  /** URL of the full JSON Schema for the request body, under /api/schemas/. */
  schema?: string;
  /** Inline body stub — enough shape that a simple invocation never needs the schema round trip. */
  body?: unknown;
  /** Present instead of `body` when the request is raw bytes rather than JSON. */
  alternateEncoding?: AlternateEncoding;
  /** The action exists but this caller cannot invoke it right now; `disabledReason` is the recourse. */
  disabled?: true;
  disabledReason?: string;
}

export interface ApiLinkTemplate {
  rel: string;
  /** href with `{variable}` placeholders the client substitutes, RFC 6570 level 1. */
  hrefTemplate: string;
  title?: string;
}

export interface ApiActionTemplate {
  rel: string;
  hrefTemplate: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  title?: string;
  schema?: string;
  body?: unknown;
  alternateEncoding?: AlternateEncoding;
}

export interface HateoasEnvelope {
  _links?: ApiLink[];
  _actions?: ApiAction[];
  _linkTemplates?: ApiLinkTemplate[];
  _actionTemplates?: ApiActionTemplate[];
}

export const link = (rel: string, href: string, title?: string): ApiLink =>
  title === undefined ? { rel, href } : { rel, href, title };

/**
 * The fields that mark an action this caller cannot invoke, or nothing when they can — built to be spread
 * into the action literal, so the whole of what an action needs sits in one expression at its route.
 *
 * The reason is the message the route itself would refuse with, so what an agent reads on the disabled action
 * is what it would have been told had it tried. A personal access key holds its account's role but is barred
 * from administration outright (accounts/guard.ts); that refusal is worded here the same way.
 */
export function gate(identity: Identity | undefined, need: Role):
  { disabled: true; disabledReason: string } | Record<string, never> {
  if (!identity || !('user' in identity)) {
    return { disabled: true, disabledReason: 'Sign in to use this server.' };
  }
  if (identity.kind === 'token' && need === 'admin') {
    return {
      disabled: true,
      disabledReason: 'An access key cannot do that — it authors, it does not administer.',
    };
  }
  if (!holds(identity.user.role, need)) {
    return {
      disabled: true,
      disabledReason: `That needs the ${need} role; ${identity.user.username} is a ${identity.user.role}.`,
    };
  }
  return {};
}

/** The action list with every entry the caller cannot even see removed — for the rare action whose existence
 *  is itself not the caller's to know (naisys hides destructive admin-only actions the same way). */
export const visible = (actions: (ApiAction | null)[]): ApiAction[] =>
  actions.filter((entry): entry is ApiAction => entry !== null);
