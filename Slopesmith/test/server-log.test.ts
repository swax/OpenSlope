// tier: fast

import { configureLog, createLogger, logSettings } from '../src/server/log';
import { check, failures } from './check';

/**
 * The server's log (src/server/log.ts): the threshold, which stream each level takes, how fields render, JSON
 * mode, and the fallback for a misspelt level.
 *
 * The logger writes through `console`, and Node's console looks `write` up on the stream at call time, so
 * swapping `process.stdout.write` and `process.stderr.write` catches every line. That is also why `check` is
 * only ever called OUTSIDE a capture: inside one, its own verdict would be swallowed with the lines.
 */
interface Captured { out: string[]; err: string[] }

function capture(run: () => void): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const wasOut = process.stdout.write;
  const wasErr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { run(); }
  finally { process.stdout.write = wasOut; process.stderr.write = wasErr; }
  return { out, err };
}

const TEXT_LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z) (DEBUG|INFO |WARN |ERROR) (\S+) (.*)$/;
const all = (log: ReturnType<typeof createLogger>) => () => {
  log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
};

const log = createLogger('check');

// ---- the threshold ----
configureLog({});
check(logSettings().level === 'info' && logSettings().format === 'text',
  'unset, the level is info and the format is text');
let seen = capture(all(log));
check(seen.out.length === 1 && seen.out[0].includes(' INFO  check i'), 'at info, debug is dropped and info written');
check(seen.err.length === 2 && seen.err[0].includes(' WARN  check w') && seen.err[1].includes(' ERROR check e'),
  'at info, warn and error are written');

configureLog({ SLOPESMITH_LOG_LEVEL: 'warn' });
seen = capture(all(log));
check(seen.out.length === 0 && seen.err.length === 2, 'at warn, nothing below warn is written');

configureLog({ SLOPESMITH_LOG_LEVEL: 'error' });
seen = capture(all(log));
check(seen.out.length === 0 && seen.err.length === 1 && seen.err[0].includes(' ERROR check e'),
  'at error, only errors are written');

configureLog({ SLOPESMITH_LOG_LEVEL: ' DEBUG ' });
seen = capture(all(log));
check(logSettings().level === 'debug' && seen.out.length === 2 && seen.err.length === 2,
  'the level is trimmed and case-insensitive, and at debug everything is written');

// ---- stream routing ----
check(seen.out[0].includes(' DEBUG check d') && seen.out[1].includes(' INFO  check i'), 'debug and info go to stdout');
check(seen.err[0].includes(' WARN  check w') && seen.err[1].includes(' ERROR check e'), 'warn and error go to stderr');
check([...seen.out, ...seen.err].every(line => line.endsWith('\n') && !line.slice(0, -1).includes('\n')),
  'each event is one line, ending in a newline');

// ---- text rendering ----
seen = capture(() => log.info('opened', {
  map: 'MOUNTAIN01', revision: 7, live: true, name: 'Big Air', tags: ['a', 'b'], none: null,
}));
const match = TEXT_LINE.exec(seen.out[0].trimEnd());
check(!!match && !Number.isNaN(Date.parse(match[1])), 'a text line starts with an ISO time');
check(match?.[2] === 'INFO ' && match?.[3] === 'check', 'then the level padded to a column, then the component');
check(match?.[4] === 'opened map=MOUNTAIN01 revision=7 live=true name="Big Air" tags=["a","b"] none=null',
  'then the message and key=value fields — JSON-encoded unless a bare word, number or boolean');

seen = capture(() => log.error('failed', { error: new TypeError('boom'), attempt: 2 }));
const [head, ...trailing] = seen.err[0].trimEnd().split('\n');
check(head.endsWith(' ERROR check failed error="TypeError: boom" attempt=2'),
  'an error field renders its name and message inline, and later fields still follow');
check(trailing.length > 1 && trailing[0] === '    TypeError: boom'
  && trailing.slice(1).every(line => line.startsWith('        at ')),
'and its stack follows the line, indented');

seen = capture(() => log.warn('no fields'));
check(seen.err[0].trimEnd().endsWith(' WARN  check no fields'), 'a line without fields ends at its message');

// ---- JSON mode ----
configureLog({ SLOPESMITH_LOG_FORMAT: 'JSON', SLOPESMITH_LOG_LEVEL: 'debug' });
check(logSettings().format === 'json', 'SLOPESMITH_LOG_FORMAT=json selects JSON lines, whatever its case');
seen = capture(() => {
  log.debug('hello', { count: 2, error: new RangeError('bad'), nested: { deep: [1, 2] } });
  log.error('x');
});
let record: any = null;
try { record = JSON.parse(seen.out[0]); } catch { /* left null, and reported below */ }
check(record !== null && !seen.out[0].slice(0, -1).includes('\n'), 'a JSON line parses as one object on one line');
check(record?.level === 'debug' && record?.component === 'check' && record?.message === 'hello'
  && !Number.isNaN(Date.parse(record?.time)), 'with time, level, component and message');
check(record?.count === 2 && record?.nested?.deep?.[1] === 2, 'fields are top-level keys, nested values kept');
check(record?.error?.name === 'RangeError' && record?.error?.message === 'bad'
  && typeof record?.error?.stack === 'string' && record.error.stack.includes('RangeError: bad'),
'an error field becomes {name, message, stack}');
check(seen.err.length === 1 && JSON.parse(seen.err[0]).level === 'error', 'JSON mode keeps the stream routing');

// ---- an unknown level ----
seen = capture(() => configureLog({ SLOPESMITH_LOG_LEVEL: 'loud' }));
check(logSettings().level === 'info' && logSettings().format === 'text', 'an unknown level falls back to info');
check(seen.err.length === 1 && seen.out.length === 0
  && / WARN {2}log SLOPESMITH_LOG_LEVEL=loud is not a level; logging at info levels=debug\|info\|warn\|error$/
    .test(seen.err[0].trimEnd()),
'and is reported once, on stderr, as a warning from the log component');
seen = capture(() => { log.debug('quiet'); log.info('heard'); });
check(seen.out.length === 1 && seen.out[0].includes(' INFO  check heard'), 'after which info is the threshold in force');
seen = capture(() => configureLog({ SLOPESMITH_LOG_LEVEL: '  ' }));
check(logSettings().level === 'info' && seen.err.length === 0, 'a blank value is the default, and nothing is said');

configureLog({});
if (failures) { console.error(`SERVER LOG FAIL (${failures})`); process.exitCode = 1; }
else console.log('SERVER LOG PASS');
