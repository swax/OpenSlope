/**
 * Work held outside the document — a draft that only an explicit Apply or Finish saves — which leaving the page
 * would lose. The document itself never needs this: project and register sync flush it on pagehide. Each holder
 * registers a check that names what it holds, or null while it holds nothing worth asking about, and the
 * browser asks before unloading while any check answers. Browsers show their own wording, so the names are for
 * callers that want to say more than "you have unsaved changes".
 */

const holders = new Set<() => string | null>();

/** Register a check. Returns the function that removes it again, for a holder that outlives only a dialog. */
export function holdUnsavedWork(check: () => string | null): () => void {
  holders.add(check);
  return () => { holders.delete(check); };
}

/** What every holder is currently keeping, in registration order. */
export function unsavedWork(): string[] {
  const held: string[] = [];
  for (const check of holders) {
    const name = check();
    if (name) held.push(name);
  }
  return held;
}

/** The beforeunload listener: asks the browser to confirm leaving while anything is held. */
export function confirmUnloadWithUnsavedWork(event: BeforeUnloadEvent): void {
  if (!unsavedWork().length) return;
  event.preventDefault();
  event.returnValue = ''; // the legacy spelling some browsers still need before they show the prompt
}
