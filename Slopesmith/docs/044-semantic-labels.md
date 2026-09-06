# 044 — Semantic labels

## Decision

Slopesmith labels are document-backed semantic memberships, not saved index selections. A label such as
`river`, `cliffs`, or `cave` has a stable id and may be attached to many authored entities; one entity may
carry several labels. The first implementation supports terrain patches and placed props, which includes
authored-model placements such as a strawberry river.

This gives labels two immediate jobs:

- find a meaningful region in a dense map and select all of its members;
- assign or remove a meaning from the current patch/prop selection.

Labels do not affect rendering, physics, export, or ownership. Their optional colour is a toolbox swatch only.

## Document model

```ts
interface LabelDefinition {
  id: string;       // label:0000
  name: string;
  color?: string;   // #rrggbb
}

interface QuadMeshDoc {
  labels?: LabelDefinition[];
  quadLabels?: Record<number, string[]>;
}

interface PlacedProp {
  labels?: string[];
}
```

`quadLabels` uses in-memory quad indices and stable quad ids on disk, exactly like `quadPaint` and
`quadTex`. A placed prop already has stable identity, so its membership travels in that prop's record.
Definitions are independent `label` object registers; patch membership is the `labels` quad register; prop
membership remains part of the prop register. That grain lets two collaborators label different patches or
edit different definitions without replacing one document-wide list.

Loading normalizes definitions and removes dangling or duplicate membership. Names are display text and can
change without touching membership. The editor prevents blank and case-insensitively duplicate names.

## Edit toolbox

With no selection, Edit mode shows a Labels section. Each row shows the label name and current member count;
activating it replaces the current selection with every local patch and prop carrying that label. Shift adds
members and Ctrl/Cmd toggles them.

When one or more writable patches or props are selected, the Labels section becomes an assignment checklist.
An off checkbox applies the label to the entire selection; an on checkbox removes it. A mixed state is shown
when only part of the selection carries the label. The section can create a label and immediately apply it to
the selection. Definition rename/delete are available from the no-selection browser.

Reference geometry is never labelled: it belongs to an extracted source rather than this authored document.

## Topology and clipboard rules

- Cut/split: every child patch inherits the source patch's memberships.
- Delete: memberships on deleted patches leave with them; surviving indices remap.
- Merge/dissolve: a surviving result keeps the union of the participating patches where the operation has a
  single result; otherwise each surviving patch keeps its own memberships.
- Extrude: the continuation/top patch inherits the source. Newly created side walls start unlabelled unless
  the operation is itself a split of a labelled face.
- Copy/paste: patch memberships are copied with patch data. Definitions absent from the destination document
  are copied before membership is applied. If the same id already means a different label in the destination,
  paste reuses a same-named definition or mints a fresh id and remaps the copied membership.

## Deferred scopes

Points and edges do not carry labels in this version. They are primarily editing topology, and useful
semantics need explicit inheritance rules for split, weld, dissolve, and T-junction edits. Authored-model
internal faces are also deferred because model face indices are intentionally ephemeral; they need stable
face identity before semantic membership can be durable.

Saved selection sets and smart filters are separate concepts. A saved selection is an exact editing snapshot;
a smart filter is a query such as “all chocolate material patches.” Both can later produce a selection, but
neither should overload the meaning or lifecycle of semantic labels.
