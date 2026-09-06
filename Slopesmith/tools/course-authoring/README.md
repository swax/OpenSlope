# Course-authoring toolkit

Shared offline machinery used by authored course packages:

- `project.ts` writes the tracked source snapshot, updates or creates its workspace project, reopens it for
  round-trip assertions, and optionally exports the playable map.
- `props.ts` measures imported prop geometry in editor space and solves placement orientation and reach.
- `sky.ts` conditions a generated panorama for the native open cylinder and stages both the course copy and
  shared sky-library copy.

These are libraries rather than standalone commands. A course keeps its own configuration and authored source
under `courses/<name>/scripts` and imports only the reusable operation from here.
