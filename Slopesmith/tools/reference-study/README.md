# Reference study

What the shipped levels actually contain, measured rather than assumed. These read an extracted `Maps/`
library, so they only run on a machine that has one — which is why they are tools a person runs and not
part of the gate.

They exist because two of them caught real errors the hard way: the prop-lighting scale was guessed twice
and shipped wrong twice before `ref-lighting` measured it against retail's own baked output, and gem
placement was being laid out by whatever a loop happened to do until `ref-gems` counted how the shipped
courses actually string them.

| Command | Question it answers |
|---|---|
| `npx tsx tools/reference-study/ref-lighting.ts` | Does our prop-lighting model reproduce retail's baked output, given retail's own inputs? (`docs/032`) |
| `npx tsx tools/reference-study/ref-gems.ts` | How do the shipped courses actually string score-multiplier gems? |
| `npx tsx tools/reference-study/smoke-groups.ts [LEVEL…]` | Does group mining recover the known assemblies — MERQUER's hydrant, sign, and street lamp? (`docs/015`) |
| `npx tsx tools/reference-study/_probe-groups.ts` | Raw dump of a level's mined group geometry, for when the smoke above disagrees. |
