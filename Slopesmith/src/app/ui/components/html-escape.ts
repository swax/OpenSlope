const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/**
 * Escape a value for interpolation into markup that is assigned to `innerHTML`.
 *
 * Most of the UI builds DOM nodes and sets `textContent`, which needs no escaping. The few panels that
 * assemble an HTML string instead must not let a document-supplied value through raw: tile refs, prop
 * and sky names, and server error text are all values another editor can write into a shared mountain,
 * and a `<script>`-shaped one would run in the browser of whoever opens the panel next — an admin's
 * included, with that session's authority.
 */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch] ?? ch);
}
