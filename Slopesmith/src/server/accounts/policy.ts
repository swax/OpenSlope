import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';

/**
 * Whether this server has members, and what counts as a secure origin to sign in over.
 *
 * A server that has not been configured for accounts serves its owner as admin — the loopback service a
 * person runs over their own workspace is exactly that server, so there is one project model and one request
 * path rather than a local mode beside a hosted one (docs/038). `--accounts` on `src/server/main.ts`, or
 * `SLOPESMITH_ACCOUNTS=require`, is what makes a deployment demand a sign-in instead.
 *
 * This setting is read in exactly one place — `identify` in guard.ts, which decides where a principal comes
 * from. Nothing downstream of that ever asks; every route sees a principal and checks a role either way.
 */

export type Role = 'admin' | 'moderator' | 'editor' | 'viewer';

/** Weakest first, which is also the order the CLI lists them in. */
export const ROLES: readonly Role[] = ['viewer', 'editor', 'moderator', 'admin'];

const RANK: Record<Role, number> = { viewer: 0, editor: 1, moderator: 2, admin: 3 };

/** Roles are server-wide and ordered (docs/038): admin manages the server; moderator manages maps and
 *  ordinary accounts; editor authors and creates maps; viewer follows read-only. A map may further narrow
 *  editor ids, but never promotes somebody above this floor. */
export const holds = (role: Role, required: Role): boolean => RANK[role] >= RANK[required];

/** The roles a moderator may grant and act on. Keeping this predicate beside the role order gives the HTTP
 *  route and the atomic account mutation one definition of the privilege boundary. */
export const isOrdinaryRole = (role: Role): role is 'viewer' | 'editor' =>
  role === 'viewer' || role === 'editor';

export const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && (ROLES as readonly string[]).includes(value);

export interface AccountsPolicy {
  /** Whether this server has members. Unset, it serves its owner as admin and enrols nobody. */
  required: boolean;
  /**
   * Whether `x-forwarded-proto` may be believed.
   *
   * A header any client can set is not evidence of TLS, so it is ignored unless the operator says a reverse
   * proxy is in front — and having said so, they owe binding the service where only that proxy reaches it.
   * Off by default, because a spoofable header believed by default is exactly the plain-HTTP shortcut the
   * secure-origin rule exists to remove.
   */
  behindProxy: boolean;
  /**
   * DNS names the API will accept in Host (or the trusted proxy's forwarded Host).
   *
   * Literal IP addresses and loopback names are intrinsically unambiguous and need no entry. Public/editor
   * DNS names are explicit because accepting whichever name resolves here recreates the DNS-rebinding
   * problem this boundary exists to prevent. A leading dot includes subdomains, matching Vite's syntax.
   */
  allowedAuthorities: readonly string[];
}

/** Shared with Vite: the editor and the separately reachable API must accept the same deliberate DNS names. */
export function allowedAuthoritiesFromEnvironment(): string[] {
  return (process.env.SLOPESMITH_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean);
}

const policy: AccountsPolicy = {
  required: process.env.SLOPESMITH_ACCOUNTS === 'require',
  behindProxy: process.env.SLOPESMITH_BEHIND_PROXY === '1',
  allowedAuthorities: allowedAuthoritiesFromEnvironment(),
};

/** Say that this server has members, or put it back to serving its owner. */
export function configureAccounts(patch: Partial<AccountsPolicy>): AccountsPolicy {
  return Object.assign(policy, patch);
}

/** Read by `identify`, which decides where a principal comes from, and by the failure path behind it, which
 *  decides which way a fault falls. Nothing else that governs a request consults it. */
export const requiresAccounts = (): boolean => policy.required;
export const behindProxy = (): boolean => policy.behindProxy;

/** Addresses that reach only this machine, which browsers already treat as a secure context. */
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|::1|0:0:0:0:0:0:0:1)$/i;
/** The same, as a socket reports its peer — including IPv4 loopback seen through an IPv6 listener. */
const LOOPBACK_ADDRESS = /^(?:(?:::ffff:)?127(?:\.\d{1,3}){3}|::1|0:0:0:0:0:0:0:1)$/i;

/** The authority a request was addressed to — `host[:port]` as the browser wrote it, or as the vouched-for
 *  proxy in front relayed it. */
function requestAuthority(req: IncomingMessage): string {
  const forwarded = behindProxy() ? header(req, 'x-forwarded-host')?.split(',')[0] : undefined;
  return (forwarded ?? header(req, 'host') ?? '').trim();
}

interface ParsedAuthority { hostname: string; port: string }

/** Parse only an HTTP Host-style authority — never credentials, a path, or another URL-shaped ambiguity. */
function parseAuthority(raw: string): ParsedAuthority | null {
  const value = raw.trim();
  if (!value || /[\\/?#@\s]/.test(value)) return null;
  let parsed: URL;
  try { parsed = new URL(`http://${value}`); } catch { return null; }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
  return { hostname: parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port: parsed.port };
}

function matchesConfiguredAuthority(candidate: ParsedAuthority, configured: string): boolean {
  const raw = configured.trim().toLowerCase();
  const subdomains = raw.startsWith('.');
  const expected = parseAuthority(subdomains ? raw.slice(1) : raw);
  if (!expected || (expected.port && expected.port !== candidate.port)) return false;
  return candidate.hostname === expected.hostname
    || (subdomains && candidate.hostname.endsWith(`.${expected.hostname}`));
}

/**
 * Whether this request was addressed to an API authority the operator intended to serve.
 *
 * Origin-vs-Host equality alone is not an authority boundary: after DNS rebinding, both carry the attacker's
 * name. IP literals are safe to accept because DNS cannot redefine them; DNS names must be loopback or be in
 * the configured list. Ports may be pinned by spelling one in the configured entry, while an unqualified
 * name deliberately covers the dev editor proxy and API listener on their two different ports.
 */
export function isAllowedAuthority(req: IncomingMessage): boolean {
  const candidate = parseAuthority(requestAuthority(req));
  if (!candidate) return false;
  if (LOOPBACK_HOST.test(candidate.hostname) || isIP(candidate.hostname) !== 0) return true;
  return policy.allowedAuthorities.some(configured => matchesConfiguredAuthority(candidate, configured));
}

/** The host a request was addressed to, without its port and without the brackets an IPv6 literal wears. */
function requestHost(req: IncomingMessage): string {
  const raw = requestAuthority(req);
  if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']') < 0 ? undefined : raw.indexOf(']'));
  const colon = raw.lastIndexOf(':');
  return (colon > 0 && !raw.slice(colon + 1).includes(':') ? raw.slice(0, colon) : raw).toLowerCase();
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Whether a password may cross this connection.
 *
 * A password to a VPS over plain HTTP is the actual exposure in this design, so it is refused rather than
 * left available as a shortcut (docs/038). Three things count: TLS terminated here, TLS terminated by a
 * proxy the operator has vouched for, and loopback — which never leaves the machine and is what keeps
 * `npm run dev` working while the rule is in force.
 */
export function isSecureOrigin(req: IncomingMessage): boolean {
  if ((req.socket as TLSSocket).encrypted) return true;
  // Both halves, because either alone is something the far side chose: the Host says where the browser meant
  // to go, and the peer address says the bytes never left this machine. A Host of `localhost` on a socket
  // from the network is a caller claiming an exemption, not a browser on this machine.
  if (LOOPBACK_HOST.test(requestHost(req)) && LOOPBACK_ADDRESS.test(req.socket.remoteAddress ?? '')) return true;
  return behindProxy() && (header(req, 'x-forwarded-proto') ?? '').split(',')[0].trim().toLowerCase() === 'https';
}

/**
 * Whether a browser request came from a page this server serves.
 *
 * A browser stamps the page's origin on every cross-site request and every WebSocket open, and a page on
 * another site can neither drop nor forge it. On a server with accounts SameSite=Lax already keeps the cookie
 * off a cross-site write; on one without, there is no cookie — whoever reaches the port is the owner — so this
 * is the only thing between a page on any site and the API `npm run serve` publishes on a fixed port. A
 * request with no Origin is a program rather than a page (curl, the Blender add-on, a script) and is let
 * through: the header is evidence of a browser, and its absence is not evidence of anything. The comparison
 * is against the authority the request was addressed to, which the dev editor's `/api` proxy and a production
 * reverse proxy both pass through untouched.
 */
export function isSameSiteOrigin(req: IncomingMessage): boolean {
  const origin = header(req, 'origin');
  if (origin === undefined) return true;
  let page: URL;
  try { page = new URL(origin); } catch { return false; } // includes the literal `null` an opaque origin sends
  const own = requestAuthority(req);
  if (!own) return false;
  // A browser leaves the scheme's default port off the origin; a Host header may still spell it out.
  const defaultPort = page.protocol === 'https:' ? ':443' : ':80';
  const trim = (authority: string) => authority.toLowerCase().replace(/:\d+$/, port => port === defaultPort ? '' : port);
  return trim(page.host) === trim(own);
}

/** Who a rate limit is counted against. Behind a vouched-for proxy every connection comes from the proxy and
 *  the client is the LAST entry of the forwarded chain — the one that proxy appended, after whatever the
 *  client sent ahead of it (Apache and Caddy both append rather than replace). The first entry is a header the
 *  client picks, which is a rate limit the client resets at will. Without a proxy the peer is the client. */
export function clientAddress(req: IncomingMessage): string {
  const forwarded = behindProxy() ? header(req, 'x-forwarded-for')?.split(',').pop()?.trim() : undefined;
  return forwarded || req.socket.remoteAddress || 'unknown';
}
