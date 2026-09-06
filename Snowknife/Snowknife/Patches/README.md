# Executable patch definitions

Each file here describes one optional modification to a game executable inside an ISO you
dumped from your own disc. `snowknife` applies them in place and can take them back out
again: `snowknife noclip` and `snowknife skycolor` apply one each, and `repack --patches`
accepts a selection (`noclip`, `hud-text`, `skycolor`) while it builds.

## Reading a patch file

A definition names a target build — each supported boot executable gets its own file, and the
file name carries which — that build's exact size, and a list of regions. Every region has a
`fileOffset`, a `length`, an `originalSha256`, and a `patched` payload. A `formatVersion` of
2 or 3 says which shape it is; 3 adds `graft`, below.

**The hex in `patched` is this project's code, not the game's.** That is the single thing
worth knowing before reading one of these files. A region's `patched` value is what
`snowknife` *writes*: a branch to a hook, or a hook routine assembled from
`Trailmap/tools/patches/`. The bytes it replaces are never stored here — a region commits to
them only through `originalSha256`, so applying a patch verifies the site before writing to
it, and reverting replays the originals that were saved from your own image at apply time.
The largest payload in this directory is a few hundred bytes of hook code written for this
project.

## Grafts, and why they exist

There is one place where that claim would otherwise break down. A trampoline hook replaces an
instruction with a branch, so the hook body has to run the instruction it displaced before it
returns — and that instruction is the game's, not ours. Writing it into `patched` would put
retail machine code in a published file.

So a region can instead carry a `graft`: a list of `{at, fromFileOffset, length}` saying
*where in your own executable to copy those bytes from*, rather than what they are. Apply
resolves every graft before it writes anything, while the sites they read from are still
intact.

```json
"patched": "711d0c080d000000",
"graft": [ { "at": 4, "fromFileOffset": 521920, "length": 4 } ]
```

Two consequences worth knowing:

- **An unfilled graft window reads as `break`**, not as zero. A zero word is a `nop`, so a
  reader that ignored `graft` would produce a hook that silently skipped the displaced work.
  This one traps at the hook instead, which is a bug you find in the first second of play.
- **A grafted region is compared outside its windows.** Those bytes are the one part of a
  payload the file does not fix, so `snowknife` cannot use them to tell an applied region
  from a pristine one, and does not try.

Between them, `originalSha256` and `graft` mean a patch file names the bytes it expects and
the bytes it needs, and reproduces neither.

`sky-color.*.json` additionally carries a `table` block. Its `seed` is an extraction recipe
— where the executable's own world-configuration initializer starts, how long it runs, its
record stride, and which fields hold the colour channels — plus a digest of the expected
result. The retail colour values themselves are not in the file; they are reconstructed from
your executable on first use and checked against that digest.

## Reverting

Applying any patch writes `<iso>.snowknife-restore.json` beside the image. That file holds
bytes taken out of your own ISO, is specific to that one image, and is gitignored for the
same reason nothing else disc-derived is committed here. `--revert` replays it; `--from
<clean.iso>` rebuilds it from an unpatched copy if it goes missing.

See the `EXECUTABLE PATCHES` section of [`../../NOTICE`](../../NOTICE) for the scope this
sits in, including a frank note on what a digest over a very small region does and does not
conceal.
