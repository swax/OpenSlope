/** A stable identity for every authored bicubic control point. */
export type MeshControlPointId<Id = string> =
  | { kind: 'vertex'; vertex: Id }
  | { kind: 'edge'; from: Id; to: Id }
  | { kind: 'twist'; quad: Id; corner: 0 | 1 | 2 | 3 };
