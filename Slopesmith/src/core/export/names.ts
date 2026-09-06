/** Keep one extracted-data path segment within the filename alphabet used by SSX level assets. Export bakes
 *  spell material, group and staged-file names with it, so the same sanitiser has to be reachable from core:
 *  the names it produces are folder contents, not an implementation detail of whoever read the source data. */
export const safeDataName = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '');

/**
 * The label one patch ships under in `Patches.json`, from the quad's own stable id (docs/039). A patch keeps
 * its name across topology surgery, because the id it is made of is what the mountain calls that face for as
 * long as the face exists — while the ordinal it sits at moves with every insertion below it.
 *
 * Every writer of the file names patches as bare identifiers — retail's `Cell_r12_c4`, the cage bridge's own —
 * and the linker table these names land in is a fixed-width text column (SSX-Library `MapHandler`), so the
 * id's `:` separator is written as `_`: quad `local:12` ships as `Cell_local_12`. Flattening the separator
 * loses nothing, because `Slopesmith.json` carries the exact id behind each ordinal; that table, not the
 * name, is what a re-export is rejoined and diffed through.
 */
export const patchName = (quadId: string): string => `Cell_${quadId.replace(/[^A-Za-z0-9]/g, '_')}`;
