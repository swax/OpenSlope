/**
 * The server's log: levelled, one line per event, on the process's own stdout and stderr — which under systemd
 * is journald (docs/041).
 *
 * `SLOPESMITH_LOG_LEVEL` (debug | info | warn | error; default info) is the threshold, read once when this module
 * loads: the process is what systemd restarts to change it, so there is no live knob. `SLOPESMITH_LOG_FORMAT=json`
 * emits one JSON object per line for a collector; the default is a text line a person reads in a journal:
 *
 *   2026-09-01T12:00:00.000Z WARN  accounts failed login from 10.0.0.9 — 3 failures in this window
 *
 * Debug and info go to stdout, warn and error to stderr. They are written THROUGH `console` rather than to the
 * streams directly, on purpose: Node's console already routes log to stdout and warn/error to stderr, and the
 * checks that assert the server said nothing do it by capturing `console.error` — bypassing it would leave them
 * green for the wrong reason.
 *
 * Not `telemetry.ts`: that is one machine-readable heartbeat on its own interval, and it writes here like
 * everything else does.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;
type Say = (message: string, fields?: LogFields) => void;
export interface Logger { debug: Say; info: Say; warn: Say; error: Say }
export interface LogSettings { level: LogLevel; format: 'text' | 'json' }

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const isLevel = (value: string): value is LogLevel => (LEVELS as readonly string[]).includes(value);

let settings: LogSettings = { level: 'info', format: 'text' };

/** Read the environment. Called once below, at load; a check calls it again with an environment of its own. */
export function configureLog(env: Record<string, string | undefined> = process.env): LogSettings {
  const asked = env.SLOPESMITH_LOG_LEVEL?.trim() ?? '';
  const wanted = asked.toLowerCase();
  settings = {
    level: isLevel(wanted) ? wanted : 'info',
    format: env.SLOPESMITH_LOG_FORMAT?.trim().toLowerCase() === 'json' ? 'json' : 'text',
  };
  // Said once, at the level it fell back to, so a typo in a unit file is visible in the journal that unit fills.
  if (asked && !isLevel(wanted)) {
    createLogger('log').warn(`SLOPESMITH_LOG_LEVEL=${asked} is not a level; logging at info`,
      { levels: LEVELS.join('|') });
  }
  return settings;
}

/** What is in force — for the startup line that names it. */
export const logSettings = (): Readonly<LogSettings> => settings;

/** Looked up per call, not bound, so a console somebody has replaced is the one written to. */
const SINK: Record<LogLevel, (line: string) => void> = {
  debug: line => console.log(line),
  info: line => console.log(line),
  warn: line => console.warn(line),
  error: line => console.error(line),
};

/** A value that reads unambiguously without quoting: a bare word, a number, a boolean. Everything else is JSON. */
const simple = (value: unknown): boolean => typeof value === 'number' || typeof value === 'boolean'
  || (typeof value === 'string' && value !== '' && !/[\s"'\\=]/.test(value));

const encode = (value: unknown): string => {
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
};

/** An error's own fields do not survive `JSON.stringify`, which renders it as `{}`. */
const plain = (value: unknown): unknown =>
  value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;

function textLine(level: LogLevel, component: string, message: string, fields: LogFields): string {
  let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${component} ${message}`;
  const stacks: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Error) {
      line += ` ${key}=${encode(`${value.name}: ${value.message}`)}`;
      if (value.stack) stacks.push(value.stack);
    } else line += ` ${key}=${simple(value) ? String(value) : encode(value)}`;
  }
  // A stack follows its line indented, the way `console.error(error)` prints one: one event, several lines.
  return stacks.length ? `${line}\n${stacks.map(stack => stack.replace(/^/gm, '    ')).join('\n')}` : line;
}

function jsonLine(level: LogLevel, component: string, message: string, fields: LogFields): string {
  const record: LogFields = { time: new Date().toISOString(), level, component, message };
  for (const [key, value] of Object.entries(fields)) record[key] = plain(value);
  return encode(record);
}

function emit(level: LogLevel, component: string, message: string, fields: LogFields = {}): void {
  if (LEVELS.indexOf(level) < LEVELS.indexOf(settings.level)) return;
  SINK[level](settings.format === 'json'
    ? jsonLine(level, component, message, fields)
    : textLine(level, component, message, fields));
}

/** One per module, named for the subsystem an operator would search the journal for: `accounts`, `session`… */
export function createLogger(component: string): Logger {
  return {
    debug: (message, fields) => emit('debug', component, message, fields),
    info: (message, fields) => emit('info', component, message, fields),
    warn: (message, fields) => emit('warn', component, message, fields),
    error: (message, fields) => emit('error', component, message, fields),
  };
}

configureLog();
