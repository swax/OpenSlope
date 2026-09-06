# Open questions

> spec:390-gem-mode-presence

Reverse-engineering questions not yet resolved, grouped by topic. Each entry
notes what's confirmed, what's still unknown, and the next step to try if
picked up. Chapter-local leads live in each spec's DIRTY block; the ones
below are cross-chapter or need a live run.

## Gem mode presence — engine-side object set

An extracted-data census of GARI's 79 `Gem_TrickMultiplier_*` instances finds
**zero** targets in both `HideShowOff` and `HideRace`, yet live retail shows
**the gem layer exists only in Showoff** (absent in Race and Freeride, along
with the Showoff rails). The static submit walk reads its per-cell instance
count column by the game mode global (`elf-map.md` "Instance runtime status
word"), which is the likely mechanism — the LTG per-cell lists carry a
Showoff-only column — but the loader side that fills those columns from
`GemIndex` was not read.

Next step if picked up: read the per-cell count-column selection in the
static submit walk and the LTG loader that populates the Showoff column.

## Course reset — two behaviours read from code, not yet observed

- **Multi-rider forward bias in game mode 0** (`0x00118fa8..0x00119008`): the
  reset target station is advanced by the other riders' mean distance-to-
  finish — an absolute course distance added to a path station, which would
  throw the placement past the path end. Either mode 0 is never multi-rider
  or it is a shipped quirk. Decisive check: two-rider session in mode 0
  (dispatcher table `0x00365730`), press SELECT, measure displacement;
  compare modes 2/4/7 (expected ≈ 0.8 × the neighbouring rider's speed).
- **Wipeout timeout → course reset**: a racing rider whose tumble exceeds 7 s
  (or whose landing regime exceeds 3 s) is course-reset rather than stood up
  (`0x0010d638`). Decisive check: tumble > 7 s off-course mid-race; expect the
  0.8 s fade + 1 m drop-in rather than the get-up animation.

## Rider table — small leads

- Row `+0x00` of the 132-byte rider row is read at `0x00111ea8`/`0x001124e0`
  but written by none of the three initializers; store-scan the table base
  for its writer.
- `0x003364a4`/`0x003364a8`/`0x003364b4` are zero on disc, adjacent to the
  cheat words, not cheat-toggled, and gate a physics path at `0x00129730`
  (row `+0x78/+0x7c`); find their writers (debug menu?).
- Which stance value (0/1) is goofy: `0x001005f0` only shows the 0.8 rail
  penalty when riding switch.
- Attribute group display names g0..g3 (turn/carve, speed response, mass,
  trick/spin/boost) are inferred from readers only; the front-end attribute
  screen's slot order would pin them.

## Leads held in chapter DIRTY blocks

Listed so they are not lost; each carries its decisive next check in place.

- 200/210: RefPack 0x01 field order (two engine readers disagree); the SSH
  flag-13 (CLUT swizzle) reader; a VU1-side TEX0 with a different TFX.
- 220: instance `+0xF4` reader; light/colour W column on VU1 program 5;
  camera mask bits 13–15; the "RESOLVING MODELS DMA" mark fixup pass.
- 230: Flag node station-0 edge and amplitude unit; Debounce negative pin
  (live); bit-12 authoring rule (correlation only); multi-payload pool
  entry ↔ sub-object mapping (live check on MEGAPLE coll[74]); spline status
  upper half; MESA trunk-spline pre-toggle gate.
- 240: the per-layer mirror flag's gameplay source (goofy?); the animation
  state machine; VU program 4 entries 0x13c0/0x1288.
- 260/270: EA-XA per-channel prefix recipe; stream tag 0x06 consumer and
  0x8C bits 0x20/0x40/0x200; .evt unnamed head words; board-bank envelope
  tags.
- 395: AI entry into prewind 8/9 and state 17; whether the push gesture
  feeds the pairwise bump; `boarder+0x190`; button/axis slot names.
- 520: field-level items listed in that chapter's "Not established".
