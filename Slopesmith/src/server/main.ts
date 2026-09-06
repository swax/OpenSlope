import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminCodeBanner, bootstrapPending, issueAdminCode } from './accounts/bootstrap';
import { DEFAULT_INVITE_DAYS, listInvites, mintInvite, revokeInvite } from './accounts/invites';
import { generatePassword } from './accounts/passwords';
import { ROLES, behindProxy, configureAccounts, isRole, requiresAccounts, type Role } from './accounts/policy';
import { authorityRefusal } from './accounts/guard';
import { countUserSessions, revokeUserSessions } from './accounts/sessions';
import { forgetAccounts, readAccounts } from './accounts/store';
import { listUsers, setUserDisabled, setUserInviteHandle, setUserPassword, setUserRole } from './accounts/users';
import { watchMapsRoot } from './api/maps-watch';
import { handleApiRequest } from './app';
import { createLogger, logSettings } from './log';
import { migrateLegacyWorkspaceAssets } from './project-assets';
import { characterLibraryDir } from './routes/characters';
import { deleteProject, listProjects, watchProjectWrites } from './projects';
import { attachSessionChannel } from './session/channel';
import { observeApiRequest, startServerTelemetry } from './telemetry';
import { configuredUpdateRoot } from './update';
import { attachVoiceProxy, proxyVoiceRequest } from './voice-proxy';
import { ensureWorkspace } from './workspace-config';

const DEFAULT_PORT = 5180;
const LOOPBACK = '127.0.0.1';

/** Addresses that reach only this machine. Everything else publishes the API to the network. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const log = createLogger('api');
const accountsLog = createLogger('accounts');
/** Command results, for the person or script that ran the command: not events, so no timestamp or level. */
const print = (text: string): void => { process.stdout.write(`${text}\n`); };

export interface ApiServiceOptions {
  /** TCP port to bind. Defaults to `PORT`, then 5180. */
  port?: number;
  /** Interface to bind. Defaults to `HOST`, then loopback. */
  host?: string;
  /**
   * Whether this server has members (docs/038).
   *
   * Omitted, it serves its owner as admin: no account file, no bootstrap code, no sign-in — which is what
   * the loopback service running over somebody's own workspace should be. `--accounts` is what makes a
   * deployment demand a sign-in instead. Either way the request path below is the same one.
   */
  accounts?: boolean;
  /** Deliberately publish the owner-equivalent, account-free API beyond loopback. Unsafe by design. */
  unsafeOpenNetwork?: boolean;
  /** Whether a reverse proxy in front is terminating TLS, and its `x-forwarded-*` headers may be believed. */
  behindProxy?: boolean;
  /** DNS authorities accepted by the API in addition to loopback names and literal IP addresses. */
  allowedAuthorities?: readonly string[];
  /** Mint a fresh one-time admin-enrolment code, for a server whose log has scrolled past the last one. */
  newAdminCode?: boolean;
  /**
   * Recreate this API service after a request accepted through the admin-only restart route. A production
   * host closes with a failure status so systemd replaces the process; development rebuilds it in place.
   * Omitted for tests and unsupervised embeddings, where stopping would have no guaranteed return path.
   */
  restart?: () => void | Promise<void>;
}

export interface ApiService {
  host: string;
  port: number;
  url: string;
  /** The one-time enrolment code, while this server is waiting for its first admin. It is handed back rather
   *  than printed because the address a person opens to redeem it is not always this service's own. */
  adminCode: string | null;
  close(): Promise<void>;
}

/**
 * The `/api/*` service, as its own long-lived process — and the one that owns every project, including the
 * ones a person edits on their own machine (docs/038).
 *
 * It binds loopback unless told otherwise, because without `--accounts` it serves whoever reaches it as the
 * owner of the workspace: the map library, the workspace and every project on this machine. Publishing that
 * is a deliberate act with a flag on it, not something a default arranges quietly.
 */
export async function startApiService(options: ApiServiceOptions = {}): Promise<ApiService> {
  const port = options.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
  const host = options.host ?? (process.env.HOST?.trim() || LOOPBACK);
  configureAccounts({
    ...(options.accounts === undefined ? {} : { required: options.accounts }),
    ...(options.behindProxy === undefined ? {} : { behindProxy: options.behindProxy }),
    ...(options.allowedAuthorities === undefined ? {} : { allowedAuthorities: options.allowedAuthorities }),
  });
  const loopback = LOOPBACK_HOSTS.has(host.toLowerCase());
  if (!requiresAccounts() && !loopback && options.unsafeOpenNetwork !== true) {
    throw new Error(`Refusing to publish Slopesmith without accounts on ${host}. Add --accounts, or explicitly`
      + ' accept owner-level network access with --unsafe-open-network.');
  }
  await migrateLegacyWorkspaceAssets();
  await characterLibraryDir();
  const stopWatchingMaps = await watchMapsRoot();
  // Writes from outside this process — a headless recipe, a second server, a restored backup — reach the file
  // and no listener. The watch turns them into the revision event rooms and clients already handle.
  const stopWatchingProjects = await watchProjectWrites();
  const telemetry = startServerTelemetry();
  const instance = randomUUID();
  let restartClaimed = false;
  const controls = options.restart ? {
    restart: {
      instance,
      request: (): boolean => {
        if (restartClaimed) return false;
        restartClaimed = true;
        // Let the 202 and its final TCP bytes leave before closing this listener and all session sockets.
        setTimeout(() => {
          void Promise.resolve(options.restart!()).catch(error => {
            log.error('requested restart failed', { error });
            restartClaimed = false;
          });
        }, 750);
        return true;
      },
    },
  } : {};

  const server = createServer((req, res) => {
    observeApiRequest(req, res);
    const authority = authorityRefusal(req);
    if (authority) {
      res.statusCode = authority.status;
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'private, no-store');
      res.end(JSON.stringify(authority.body));
      return;
    }
    if (proxyVoiceRequest(req, res)) return;
    const url = req.url ?? '/';
    void handleApiRequest(req, res, controls).then(handled => {
      if (handled || res.headersSent) return;
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: `Unknown route: ${req.method ?? 'GET'} ${url}` }));
    });
  });

  // Presence, awareness and register changes, over one socket per tab (docs/038, docs/039). It belongs here
  // rather than in a Vite plugin: this process outlives Vite's restarts and hot updates, so a table held in
  // it is not reset at a moment nobody chose.
  const stopSessionChannel = attachSessionChannel(server);
  const stopVoiceProxy = attachVoiceProxy(server);

  try {
    await new Promise<void>((ready, failed) => {
      server.once('error', failed);
      server.listen(port, host, () => { server.off('error', failed); ready(); });
    });
  } catch (error) {
    telemetry.stop();
    stopVoiceProxy();
    await stopSessionChannel();
    stopWatchingMaps();
    stopWatchingProjects();
    throw error;
  }

  // `--port 0` asks the OS for a free one, so what was bound is what callers must be told — never the 0 that
  // was asked for.
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${bound}`;
  // The enrolment code names a URL a person is meant to open, and this service is not always that URL — in
  // development an editor sits in front of it and forwards `/api`. So the code is handed back rather than
  // printed, and whoever knows where the browser goes announces it.
  const adminCode = requiresAccounts()
    ? await announceAccounts(url, loopback, options.newAdminCode === true)
    : null;
  if (!requiresAccounts() && !loopback) {
    log.warn(`UNSAFE open network on ${host}: anyone who can reach this port is served as the owner`
      + ' of this machine\'s maps, workspace and projects.');
  }

  return {
    host, port: bound, url, adminCode,
    close: async () => {
      telemetry.stop();
      stopWatchingMaps();
      stopWatchingProjects();
      stopVoiceProxy();
      // Sessions end before the sockets carrying them do, so a map whose last client is going still gets the
      // checkpoint that closing it owes, and that write finishes before the process is told it may stop.
      await stopSessionChannel();
      server.closeAllConnections();
      await new Promise<void>((closed, failed) => server.close(error => error ? failed(error) : closed()));
    },
  };
}

/**
 * What a server with members says on start: the one-time admin code while enrolment is outstanding, and who
 * is enrolled once it is not.
 *
 * The code is minted fresh every start rather than reprinted, because only its digest is stored — which is
 * also what makes a restart the simplest way to get another when the log has scrolled.
 */
async function announceAccounts(url: string, loopback: boolean, regenerate: boolean): Promise<string | null> {
  if (!loopback && !behindProxy()) {
    accountsLog.warn('this server refuses passwords over plain HTTP, so nobody off this machine can'
      + ' sign in until TLS is in front of it. Add --behind-proxy once a reverse proxy terminates TLS.');
  }
  const code = await issueAdminCode();
  if (code) return code;
  if (regenerate) {
    accountsLog.info('this server already has an admin, so there is no enrolment code to regenerate —'
      + ' use `invite --role admin` instead.');
  }
  const users = await listUsers();
  const enabled = users.filter(user => !user.disabled).length;
  accountsLog.info(`sign-in required — ${enabled} member${enabled === 1 ? '' : 's'}`
    + `${users.length > enabled ? `, ${users.length - enabled} disabled` : ''}.`);
  return null;
}

/** `--host` alone binds every interface; `--host <addr>` names one. `--port <n>` matches `PORT`. */
export function parseApiArgs(argv: readonly string[]): ApiServiceOptions {
  const options: ApiServiceOptions = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--host') {
      const next = argv[index + 1];
      if (next && !next.startsWith('-')) { options.host = next; index++; } else options.host = '0.0.0.0';
    } else if (arg.startsWith('--host=')) {
      options.host = arg.slice('--host='.length) || '0.0.0.0';
    } else if (arg === '--port') {
      options.port = Number(argv[++index]);
    } else if (arg.startsWith('--port=')) {
      options.port = Number(arg.slice('--port='.length));
    } else if (arg === '--accounts') {
      options.accounts = true;
    } else if (arg === '--no-accounts') {
      options.accounts = false;
    } else if (arg === '--unsafe-open-network') {
      options.unsafeOpenNetwork = true;
    } else if (arg === '--behind-proxy') {
      options.behindProxy = true;
    } else if (arg === '--new-admin-code') {
      options.newAdminCode = true;
    }
  }
  return options;
}

// ---- the management surface (docs/038) ----

/**
 * The CLI is the source of truth and always works, including when nothing can connect: mint an invite, list
 * users, disable an account, reset a password, list and delete maps.
 *
 * It reads and writes the same workspace record the server does rather than calling the server, so it works
 * with the service stopped, with the service refusing every request because nobody is enrolled yet, and with
 * an admin who has locked themselves out. A running server re-reads the record when its stamp moves, so a
 * change made here is in force on the very next request rather than at the next restart.
 */

/** `--role editor`, `--uses 5`, `--days 14`, `--url https://…` — and bare values for the commands that take
 *  positional arguments. */
function flags(argv: readonly string[]): { values: Record<string, string>; rest: string[] } {
  const values: Record<string, string> = {};
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) values[arg.slice(2, eq)] = arg.slice(eq + 1);
      else {
        const next = argv[index + 1];
        values[arg.slice(2)] = next && !next.startsWith('--') ? (index++, next) : 'true';
      }
    } else rest.push(arg);
  }
  return { values, rest };
}

function requireRole(value: string | undefined, fallback: Role = 'editor'): Role {
  const role = (value ?? fallback).toLowerCase();
  if (!isRole(role)) throw new Error(`Unknown role: ${value} — one of ${ROLES.join(', ')}`);
  return role;
}

const columns = (rows: string[][]): string =>
  rows.map(row => row.map((cell, at) =>
    at === row.length - 1 ? cell : cell.padEnd(Math.max(...rows.map(other => other[at]?.length ?? 0)))).join('  '))
    .join('\n');

const USAGE = `Slopesmith server

  serve                             start the /api service (default)
    --accounts                      require an account for every route but enrolment
    --unsafe-open-network           allow account-free owner access beyond loopback (dangerous)
    --behind-proxy                  believe x-forwarded-proto from a TLS-terminating reverse proxy
    --host [addr] --port <n>        where to bind; loopback unless --host is given
    --new-admin-code                mint a fresh one-time admin-enrolment code

  invite <handle> [--role viewer|editor|moderator|admin] [--days N] [--url BASE]
                                    mint an invite link; the token is shown once
  invites                           list invites and what became of them
  revoke-invite <id>                withdraw an unredeemed invite
  users                             list members, their roles and their sessions
  set-role <username> <role>        change what a member may do, in force immediately
  set-handle <username> <handle>    change private invitation provenance
  disable <username>                refuse sign-in and end every session the account holds
  enable <username>                 undo a disable
  reset-password <username> [pw]    set a password; one is generated and printed when omitted
  sign-out <username>               end every session, everywhere
  new-admin-code                    mint a fresh one-time admin-enrolment code
  maps                              list the maps in this workspace
  delete-map <id|name>              delete a map and retire its name`;

async function runCommand(command: string, argv: readonly string[]): Promise<number> {
  const { values, rest } = flags(argv);
  // Every command works against the workspace record, so the layout has to exist before one writes into it.
  await ensureWorkspace();
  forgetAccounts();

  switch (command) {
    case 'invite': {
      const handle = rest[0];
      if (!handle) throw new Error('invite <handle>');
      const { invite, token } = await mintInvite({
        role: requireRole(values.role),
        handle,
        days: values.days ? Number(values.days) : DEFAULT_INVITE_DAYS,
        by: 'cli',
      });
      const base = (values.url ?? '').replace(/\/+$/, '');
      print(`Invite minted for ${invite.handle}: ${invite.role}, expires `
        + new Date(invite.expiresAt).toLocaleString());
      print('');
      print(base ? `  ${base}/#invite=${token}` : `  #invite=${token}`);
      print('');
      print('The link is the credential until it is redeemed, and worthless afterwards. It is shown'
        + ' once — the server keeps only its digest.');
      return 0;
    }
    case 'invites': {
      const invites = await listInvites();
      if (!invites.length) { print('No invites.'); return 0; }
      print(columns([['ID', 'HANDLE', 'ROLE', 'STATE', 'EXPIRES', 'REDEEMED BY'],
        ...invites.map(invite => [invite.id.slice(0, 8), invite.handle, invite.role, invite.state,
          new Date(invite.expiresAt).toISOString().slice(0, 16), invite.redeemedBy ?? '—'])]));
      return 0;
    }
    case 'revoke-invite': {
      const id = rest[0];
      if (!id) throw new Error('revoke-invite <id>');
      const all = await listInvites();
      const match = all.find(invite => invite.id === id || invite.id.startsWith(id));
      if (!match) throw new Error(`No such invite: ${id}`);
      await revokeInvite(match.id);
      print(`Invite ${match.id.slice(0, 8)} withdrawn.`);
      return 0;
    }
    case 'users': {
      const users = await listUsers();
      if (!users.length) {
        print(await bootstrapPending()
          ? 'No members yet — start the server with --accounts and redeem the admin code it prints.'
          : 'No members.');
        return 0;
      }
      const sessions = await Promise.all(users.map(user => countUserSessions(user.id)));
      const records = new Map((await readAccounts()).users.map(user => [user.id, user]));
      print(columns([['USERNAME', 'INVITE HANDLE', 'ROLE', 'STATE', 'SESSIONS', 'CREATED'],
        ...users.map((user, at) => [user.username, records.get(user.id)?.inviteHandle ?? '—', user.role,
          user.disabled ? 'disabled' : 'active', String(sessions[at]), user.createdAt.slice(0, 10)])]));
      return 0;
    }
    case 'set-role': {
      const [username, role] = rest;
      if (!username || !role) throw new Error('set-role <username> <role>');
      const user = await setUserRole(username, requireRole(role, 'viewer'));
      print(`${user.username} is now a ${user.role}, on their next request.`);
      return 0;
    }
    case 'set-handle': {
      const [username, handle] = rest;
      if (!username || !handle) throw new Error('set-handle <username> <handle>');
      const user = await setUserInviteHandle(username, handle);
      print(`${user.username}'s private invite handle is now ${handle}.`);
      return 0;
    }
    case 'disable':
    case 'enable': {
      const username = rest[0];
      if (!username) throw new Error(`${command} <username>`);
      const user = await setUserDisabled(username, command === 'disable');
      print(command === 'disable'
        ? `${user.username} is disabled and signed out everywhere.`
        : `${user.username} may sign in again.`);
      return 0;
    }
    case 'reset-password': {
      const username = rest[0];
      if (!username) throw new Error('reset-password <username> [password]');
      const password = rest[1] ?? generatePassword();
      const user = await setUserPassword(username, password);
      print(`${user.username}'s password is set, and every session it protected has ended.`);
      if (!rest[1]) print(`\n  ${password}\n\nHand it over out of band; they change it once they are in.`);
      return 0;
    }
    case 'sign-out': {
      const username = rest[0];
      if (!username) throw new Error('sign-out <username>');
      const users = await listUsers();
      const user = users.find(entry => entry.username === username.trim().toLowerCase());
      if (!user) throw new Error(`No such user: ${username}`);
      const ended = await revokeUserSessions(user.id);
      print(`${ended} session${ended === 1 ? '' : 's'} ended for ${user.username}.`);
      return 0;
    }
    case 'new-admin-code': {
      const code = await issueAdminCode();
      if (!code) {
        print('This server already has an admin, so there is no enrolment code to regenerate.'
          + ' Use `invite --role admin`, or `reset-password <admin>`.');
        return 1;
      }
      print(adminCodeBanner(code, (values.url ?? 'the server').replace(/\/+$/, '')));
      return 0;
    }
    case 'maps': {
      const maps = await listProjects();
      if (!maps.length) { print('No maps in this workspace.'); return 0; }
      print(columns([['NAME', 'ID', 'REVISION', 'UPDATED'],
        ...maps.map(map => [map.name, map.id, `r${map.revision}`, map.updatedAt.slice(0, 16)])]));
      return 0;
    }
    case 'delete-map': {
      const wanted = rest[0];
      if (!wanted) throw new Error('delete-map <id|name>');
      const maps = await listProjects();
      const match = maps.find(map => map.id === wanted)
        ?? maps.find(map => map.name.toLowerCase() === wanted.toLowerCase());
      if (!match) throw new Error(`No such map: ${wanted}`);
      const deleted = await deleteProject(match.id);
      print(`Deleted ${deleted.name} (${deleted.folder}). Its name is retired rather than returned to`
        + ` the pool, so the next map called ${deleted.name} lands beside it under a suffixed name.`);
      return 0;
    }
    case 'accounts': {
      // What the record holds, for an operator working out why a server is refusing them.
      const accounts = await readAccounts();
      print(`users ${accounts.users.length} · invites ${accounts.invites.length}`
        + ` · sessions ${accounts.sessions.length}`
        + ` · enrolment ${await bootstrapPending() ? 'outstanding' : 'done'}`);
      return 0;
    }
    default:
      print(USAGE);
      return command === 'help' || command === '--help' || command === '-h' ? 0 : 1;
  }
}

/** Which words start the management surface rather than the service. Anything else — including no argument
 *  at all and a bare `serve` — starts the server. */
const COMMANDS = new Set(['invite', 'invites', 'revoke-invite', 'users', 'set-role', 'disable', 'enable',
  'set-handle', 'reset-password', 'sign-out', 'new-admin-code', 'maps', 'delete-map', 'accounts',
  'help', '--help', '-h']);

// Running this file is running the service; importing it (`scripts/dev.ts`) only borrows the starter.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const first = argv[0] ?? '';
  if (COMMANDS.has(first)) {
    try {
      process.exitCode = await runCommand(first, argv.slice(1));
    } catch (error) {
      process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
      process.exitCode = 1;
    }
  } else {
    const options = parseApiArgs(first === 'serve' ? argv.slice(1) : argv);
    let stopping = false;
    const stop = async (signal: string) => {
      if (stopping) return;
      stopping = true;
      log.info(`${signal}; closing sessions and snapshots`);
      try { await service.close(); }
      catch (error) {
        log.error('graceful shutdown failed', { error });
        process.exitCode = 1;
      }
    };
    // The updater drop-in is installed only on the supervised production service. Its systemd unit uses
    // Restart=on-failure, so a deliberate non-zero exit recreates the whole startup graph without granting
    // the web process permission to invoke systemctl.
    const restart = configuredUpdateRoot() ? async () => {
      process.exitCode = 1;
      await stop('restart requested');
    } : undefined;
    const service = await startApiService({ ...options, ...(restart ? { restart } : {}) });
    // Nothing is in front of this one, so the service's own address is where enrolment happens. The banner is
    // a boxed block an operator copies the code out of (docs/041), so it goes to stdout as it is: a timestamp
    // and level on each of its lines would break the box.
    if (service.adminCode) print(adminCodeBanner(service.adminCode, service.url));
    log.info(`serving ${service.url}/api/`, { logLevel: logSettings().level });

    // systemd's SIGTERM and a terminal's Ctrl+C take the same graceful path as tests: sockets stop first so
    // every room lands the snapshot its last participant leaving owes, then the HTTP listener closes.
    process.once('SIGTERM', () => { void stop('SIGTERM'); });
    process.once('SIGINT', () => { void stop('SIGINT'); });
  }
}
