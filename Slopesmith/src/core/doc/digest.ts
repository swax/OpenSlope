import type { QuadMeshDoc } from './types';
import { canonicalJson } from './canonical';
import {
  documentSections, registerSection, sectionRegisters, structuralDocument, type RegisterKey,
} from './registers';

/**
 * Two-level hashing, so drift says WHERE (docs/039).
 *
 * Any change-streaming system drifts eventually, from bugs rather than from design, and a cheap always-on
 * detector is what keeps a bug from becoming two people silently editing different mountains. One hash over
 * everything says only THAT you diverged; on a large mesh the only remedy left is refetching the document.
 *
 * So the document hashes as a root over sections: vertices and quad attributes in chunks of about a thousand,
 * creases beside the corners that own them, one section per object family, one per global, one for the run,
 * and one for the topology the register model does not own. Comparing the roots costs one string; when they
 * disagree, comparing the section maps is one descent and names the chunk to refetch. Two levels is plenty —
 * a third would locate a divergence more precisely than it is worth transferring.
 *
 * The sections partition the whole document, so the root is a statement about the mountain rather than about
 * the part of it that happens to be register-shaped: any difference at all reaches exactly one section and
 * therefore the root.
 */

/** How a section is reduced to a name. Injected rather than chosen here, because `src/core` carries no crypto
 *  implementation, and because two participants only have to agree on one function to compare digests. */
export type HashText = (text: string) => string;

/**
 * The function participants sharing a mountain agree on — 64 bits over the canonical text, as hex.
 *
 * A drift digest is compared between two replicas that already trust each other, so what it has to be is
 * cheap, synchronous and identical everywhere. Cheap and synchronous rule out sha256 in a browser, where the
 * only built-in digest is `crypto.subtle` and it is async: a check that has to be awaited cannot sit on the
 * idle path of an editor. Identical everywhere rules out anything platform-supplied. Two 32-bit multiply-xor
 * accumulators mixed at the end give a 64-bit name over any text, in one pass, in both runtimes.
 *
 * Sixty-four bits is sized for the job: a mountain hashes as a few dozen sections, and this detects a bug that
 * has already made two people edit different documents. It is not a signature — the project service still
 * names a stored document by sha256 over the same canonical text.
 */
export function textHash(text: string): string {
  let low = 0xdeadbeef, high = 0x41c6ce57;
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at);
    low = Math.imul(low ^ unit, 2654435761);
    high = Math.imul(high ^ unit, 1597334677);
  }
  low = Math.imul(low ^ (low >>> 16), 2246822507) ^ Math.imul(high ^ (high >>> 13), 3266489909);
  high = Math.imul(high ^ (high >>> 16), 2246822507) ^ Math.imul(low ^ (low >>> 13), 3266489909);
  return (high >>> 0).toString(16).padStart(8, '0') + (low >>> 0).toString(16).padStart(8, '0');
}

/** The section holding what a document IS rather than what it holds — its format markers, its identity and
 *  its topology. Not chunked: a divergence here means refetching the mesh's structure whatever its size. */
export const TOPOLOGY_SECTION = 'topology';

export interface DocumentDigest {
  /** One hash over every section hash — the first thing two participants compare. */
  root: string;
  /** Section name → hash over that section's registers, in name order. An empty section is absent rather than
   *  hashed, so a family nothing has been placed in yet costs nothing. */
  sections: Record<string, string>;
}

/** Section names in order, so the record enumerates the same way whichever route built it. */
const ordered = (sections: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.keys(sections).sort().map(name => [name, sections[name]]));

const rootOf = (sections: Record<string, string>, hash: HashText): string => hash(canonicalJson(sections));

/**
 * The structural projection a drift digest compares.
 *
 * A T-junction's vertex and host edge are topology; its parameter on that edge is not. The editor re-fits
 * `t` from the vertex and the live host curve on every render, so a room holding the last saved parameter and
 * a client holding the re-fitted one still describe the same mountain. Hashing that derived float made a
 * topology repair self-defeating: adopting the room document launched a render, the render re-fitted `t`, and
 * the next idle check fetched the same document again. Keep the association in the topology hash while
 * leaving the derived parameter out of the comparison.
 */
function digestStructure(doc: QuadMeshDoc): Record<string, unknown> {
  const structure = structuralDocument(doc);
  if (doc.tJunctions === undefined) return structure;
  return {
    ...structure,
    tJunctions: doc.tJunctions.map(({ vertex, edge }) => ({ vertex, edge })),
  };
}

/** One section's hash, or null when the section holds nothing. */
function sectionDigest(doc: QuadMeshDoc, section: string, hash: HashText): string | null {
  if (section === TOPOLOGY_SECTION) return hash(canonicalJson(digestStructure(doc)));
  const registers = sectionRegisters(doc, section);
  return registers.size ? hash(canonicalJson([...registers])) : null;
}

/** The whole digest, computed from scratch. */
export function digestDocument(doc: QuadMeshDoc, hash: HashText): DocumentDigest {
  const sections: Record<string, string> = { [TOPOLOGY_SECTION]: hash(canonicalJson(digestStructure(doc))) };
  for (const [name, registers] of documentSections(doc)) sections[name] = hash(canonicalJson([...registers]));
  const named = ordered(sections);
  return { root: rootOf(named, hash), sections: named };
}

/**
 * The digest after a set of registers changed, rehashing only the sections those registers belong to — what
 * makes a vertex move cost its chunk rather than the mountain.
 *
 * `changed` names registers, so it covers every ordinary edit. A TOPOLOGY edit names none: it renumbers the
 * chunks and rewrites the section the register model does not own, so it is a full `digestDocument` instead.
 * That is also the fallback taken here whenever a changed key cannot be placed on the document — a name it
 * has never carried, or one it has since retired — because both mean the numbering moved underneath.
 */
export function updateDigest(doc: QuadMeshDoc, previous: DocumentDigest, changed: Iterable<RegisterKey>,
  hash: HashText): DocumentDigest {
  const dirty = new Set<string>();
  for (const key of changed) {
    const section = registerSection(doc, key);
    if (section === null) return digestDocument(doc, hash);
    dirty.add(section);
  }
  if (!dirty.size) return previous;
  const sections = { ...previous.sections };
  for (const name of dirty) {
    const digest = sectionDigest(doc, name, hash);
    if (digest === null) delete sections[name]; else sections[name] = digest;
  }
  const named = ordered(sections);
  return { root: rootOf(named, hash), sections: named };
}

/** Which sections two digests disagree about — the one descent, and the whole of what repair has to refetch.
 *  Empty when the roots agree, since the root is a hash over exactly this comparison. */
export function divergentSections(mine: DocumentDigest, theirs: DocumentDigest): string[] {
  const names = new Set([...Object.keys(mine.sections), ...Object.keys(theirs.sections)]);
  return [...names].filter(name => mine.sections[name] !== theirs.sections[name]).sort();
}
