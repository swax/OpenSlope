/**
 * The one text a document has (docs/039) — sorted keys, fixed number format — so that hashing a document is a
 * statement about the document rather than about the route it arrived by.
 *
 * `JSON.stringify` is not that text. It writes an object's keys in the order they were inserted, so a mountain
 * read off disk and the same mountain rebuilt by applying changes to it produce different bytes while holding
 * identical terrain, and any check built on those bytes reports drift constantly. Numbers are the other half:
 * the same authored position reached by a drag, an undo and a nudge differs from itself in the last bit or two,
 * which is a difference nobody made and nobody can see.
 *
 * This is a projection for comparing and hashing, never a storage format. `mountain.slope.json` is written by
 * `JSON.stringify` over `serializeMountain`'s output and keeps the field order and the full precision the
 * document has; canonicalization happens on the way into a hash and nowhere else.
 */

/**
 * Decimal places a number keeps: nine — a nanometre, in editor metres.
 *
 * Two bounds meet at that figure. Below it nothing authored is lost: a viewport drag resolves to
 * sub-millimetre at best and a typed field to a handful of decimals, so nine places sit four orders of
 * magnitude finer than the finest coordinate anyone can express, and a mountain-scale coordinate (10^4 m)
 * still carries ~10^-12 m of float64 resolution underneath it — two distinct authored positions can never
 * round together. Above it arithmetic noise is absorbed: 0.1 + 0.2 and 0.3 are different float64 values and
 * the same authored number, and a register must hash as the value it holds rather than as the sum that
 * reached it.
 */
export const CANONICAL_DECIMALS = 9;

/** Trailing zeros of a fixed-point number, and the point itself once nothing follows it. */
const TRAILING_ZEROS = /\.?0+$/;

/**
 * One number as canonical text.
 *
 * JSON carries no NaN or Infinity, so neither does a document; both become null, which is what
 * `JSON.stringify` writes for them and therefore what a reader would see. Negative zero is the same place as
 * zero and reads back as either, so it is written as one.
 */
export function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) return 'null';
  if (value === 0) return '0';
  // Past 10^21 `toFixed` gives up and returns exponential notation anyway; the engine's own shortest text is
  // already one string per value, and no editor-space quantity reaches it.
  if (Math.abs(value) >= 1e21) return String(value);
  const fixed = value.toFixed(CANONICAL_DECIMALS).replace(TRAILING_ZEROS, '');
  return fixed === '-0' ? '0' : fixed;
}

/**
 * A value as canonical JSON: object keys in code-unit order, numbers through `canonicalNumber`, arrays left
 * exactly as they are because their order is data rather than presentation.
 *
 * Absent and undefined are the same thing here, as they are in JSON: a field explicitly set to undefined is
 * dropped rather than written, so a document that assigns one and a document that never had it agree.
 */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(value, out);
  return out.join('');
}

function write(value: unknown, out: string[]): void {
  switch (typeof value) {
    case 'number': out.push(canonicalNumber(value)); return;
    case 'boolean': out.push(value ? 'true' : 'false'); return;
    case 'string': out.push(JSON.stringify(value)); return;
    case 'object': break;
    // Functions, symbols and bigints are not document data; a document that somehow carries one says nothing.
    default: out.push('null'); return;
  }
  if (value === null) { out.push('null'); return; }
  if (Array.isArray(value)) {
    out.push('[');
    value.forEach((item, at) => { if (at) out.push(','); write(item, out); });
    out.push(']');
    return;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
  out.push('{');
  keys.forEach((key, at) => {
    if (at) out.push(',');
    out.push(JSON.stringify(key), ':');
    write(record[key], out);
  });
  out.push('}');
}
