using System.Numerics;

namespace Snowknife.Bundle;

/// <summary>
/// Decoder for Tricky's mode-3 physics body shape payloads - the engine's prop collision volume for
/// CollsionMode 3 props (signs, rocks, gateways, crowd stands; see Unity docs/037, [Trailmap: 130-collision-data]).
/// The SSF payload stores a depth-5 base-8 OCCUPANCY TREE over a cube around the body origin:
///   - UByteData = RLE-compressed child masks (decoder: ctrl&lt;0 literal run, &gt;0 repeat, 0 stop).
///   - uPhysicsStruct0[d].U0 = the node sphere radius at depth d (the leaf sphere the contact test accepts).
///   - uPhysicsStruct0[d].U1 = the child-center offset applied FROM depth d-1 TO depth d (U1[0] is 0).
///   - uPhysicsStruct0[d].U2 = the child mask-offset stride at depth d.
/// Mirrors the runtime sphere-tree walk: [Trailmap: 130-collision-data]
///   - child mask offset = parentOffset + (bit + 1) * U2[depth],
///     laying the levels out level-sequentially (root 0, depth1 at 1..8, depth2 at 9..72, depth3 at
///     73..584, depth4 at 585..4680). The +1 is load-bearing: without it every level aliases offset 0.
///   - child center = parent + octant[bit] * U1[depth+1], octant table = the static +/-1 corner table:
///     x=(bit&amp;4), y=(bit&amp;2), z=(bit&amp;1).
///   - a node whose mask is 0 (or at max depth) is a LEAF sphere of radius U0[depth].
/// Validated: Cavescaf (physIdx 52) leaves reproduce the 4.7x14x9.7 m scaffold slab with the cave
/// opening EMPTY; FinishArch (18) reproduces the hollow 23 m arch. Coordinates are raw SSX body space
/// (same frame as Props.obj before the X negation), centred on UFloat0-2, units cm.
/// </summary>
internal sealed class SsxPhysicsBodies
{
    readonly Dictionary<int, Body> _bodies = new();

    public sealed class Body
    {
        public int PhysicsIndex;
        public Vector3 RootCenter;     // body-space origin of the tree (F0-2)
        public int GridN;              // cells per axis at max depth (2^maxDepth, typically 16)
        public float LeafRadius;       // U0[maxDepth] - how far the engine's leaf spheres reach past a cell center
        public float[] AxisPos = System.Array.Empty<float>();  // lattice center position per cell index (same for all 3 axes)
        public HashSet<(int x, int y, int z)> Cells = new();   // occupied cells (early leaves fill their subtree cube)

        public float CellSpan => AxisPos.Length > 1 ? AxisPos[1] - AxisPos[0] : LeafRadius;  // approx lattice spacing

        /// <summary>
        /// True if the body contains a player-sized EMPTY through-corridor flanked by solid on both sides -
        /// i.e. a doorway/opening you are meant to pass through (gate arch, cave scaffold, waterfall curtain,
        /// the space under a crowd stand). A compact solid (rock, sign) has no such corridor: its empty bbox
        /// corners are open to the bbox faces, not flanked. Fully data-derived - the discrimination comes
        /// from the engine's own occupancy tree (Unity docs/037).
        /// </summary>
        public bool HasDoorway(float playerSize)
        {
            int n = GridN;
            var lo = new int[3]; var hi = new int[3];
            for (int a = 0; a < 3; a++) { lo[a] = n; hi[a] = -1; }
            foreach (var c in Cells)
            {
                lo[0] = Math.Min(lo[0], c.x); hi[0] = Math.Max(hi[0], c.x);
                lo[1] = Math.Min(lo[1], c.y); hi[1] = Math.Max(hi[1], c.y);
                lo[2] = Math.Min(lo[2], c.z); hi[2] = Math.Max(hi[2], c.z);
            }
            if (hi[0] < 0) return false;
            float cell = CellSpan;

            for (int A = 0; A < 3; A++)
            {
                int B = A == 0 ? 1 : 0, C = A == 2 ? 1 : 2;
                for (int b0 = lo[B]; b0 <= hi[B]; b0++)
                    for (int b1 = b0; b1 <= hi[B]; b1++)
                    {
                        if (AxisPos[b1] - AxisPos[b0] + cell < playerSize) continue;
                        for (int c0 = lo[C]; c0 <= hi[C]; c0++)
                            for (int c1 = c0; c1 <= hi[C]; c1++)
                            {
                                if (AxisPos[c1] - AxisPos[c0] + cell < playerSize) continue;
                                if (!CorridorEmpty(A, lo[A], hi[A], B, b0, b1, C, c0, c1)) continue;
                                // flanked: solid strictly on BOTH sides along one cross axis = a doorway,
                                // not an open corner gap
                                if (SolidBothSides(B, b0, b1) || SolidBothSides(C, c0, c1)) return true;
                            }
                    }
            }
            return false;
        }

        bool CorridorEmpty(int A, int a0, int a1, int B, int b0, int b1, int C, int c0, int c1)
        {
            var v = new int[3];
            for (int a = a0; a <= a1; a++)
                for (int b = b0; b <= b1; b++)
                    for (int c = c0; c <= c1; c++)
                    {
                        v[A] = a; v[B] = b; v[C] = c;
                        if (Cells.Contains((v[0], v[1], v[2]))) return false;
                    }
            return true;
        }

        bool SolidBothSides(int axis, int g0, int g1)
        {
            bool below = false, above = false;
            foreach (var c in Cells)
            {
                int v = axis == 0 ? c.x : axis == 1 ? c.y : c.z;
                if (v < g0) below = true;
                else if (v > g1) above = true;
                if (below && above) return true;
            }
            return false;
        }

        /// <summary>
        /// Occupied fraction of the occupancy's own cell-space bounding box, counting only
        /// PLAYER-REACHABLE air as open. A compact solid (rock, sign) fills most of its box, so one AABB
        /// stands in for it faithfully; a leaning trunk or thin pole leaves rider-usable space that a
        /// flattened box would wall off. EA's authoring tool sampled mesh surfaces, so boulders and car
        /// bodies decode as hollow crusts with window- and crevice-sized leaks - air a rider can never
        /// occupy. A cube of playerSize empty cells is slid in from outside the bounds (out-of-bounds is
        /// open world, face-step connectivity); air it can never reach counts as occupied. On lattices
        /// coarser than the player this degenerates to a plain boundary flood.
        /// </summary>
        public float FillFraction(float playerSize)
        {
            if (Cells.Count == 0) return 0f;
            int minX = int.MaxValue, minY = int.MaxValue, minZ = int.MaxValue;
            int maxX = int.MinValue, maxY = int.MinValue, maxZ = int.MinValue;
            foreach (var c in Cells)
            {
                minX = Math.Min(minX, c.x); maxX = Math.Max(maxX, c.x);
                minY = Math.Min(minY, c.y); maxY = Math.Max(maxY, c.y);
                minZ = Math.Min(minZ, c.z); maxZ = Math.Max(maxZ, c.z);
            }
            int sx = maxX - minX + 1, sy = maxY - minY + 1, sz = maxZ - minZ + 1;
            long vol = (long)sx * sy * sz;

            int d = Math.Max(1, (int)Math.Ceiling(playerSize / CellSpan));
            // The window can't fit inside the bounds at all: every void is sub-player, the body is a
            // compact solid smaller than the rider.
            if (d > Math.Max(sx, Math.Max(sy, sz))) return 1f;

            bool Occupied(int x, int y, int z) => x >= 0 && x < sx && y >= 0 && y < sy && z >= 0 && z < sz
                && Cells.Contains((x + minX, y + minY, z + minZ));
            bool WindowEmpty(int ax, int ay, int az)
            {
                for (int x = 0; x < d; x++)
                    for (int y = 0; y < d; y++)
                        for (int z = 0; z < d; z++)
                            if (Occupied(ax + x, ay + y, az + z)) return false;
                return true;
            }

            // Anchor lattice for the sliding window, padded by d-1 so windows overlapping the outside
            // world participate; a window containing any out-of-bounds cell is connected to outside.
            int pad = d - 1, nx = sx + pad, ny = sy + pad, nz = sz + pad;
            var reached = new bool[nx, ny, nz];
            var queue = new Queue<(int x, int y, int z)>();
            void Visit(int ix, int iy, int iz)
            {
                if (ix < 0 || ix >= nx || iy < 0 || iy >= ny || iz < 0 || iz >= nz || reached[ix, iy, iz]) return;
                int ax = ix - pad, ay = iy - pad, az = iz - pad;
                if (!WindowEmpty(ax, ay, az)) return;
                reached[ix, iy, iz] = true;
                queue.Enqueue((ix, iy, iz));
            }
            for (int ix = 0; ix < nx; ix++)
                for (int iy = 0; iy < ny; iy++)
                    for (int iz = 0; iz < nz; iz++)
                    {
                        int ax = ix - pad, ay = iy - pad, az = iz - pad;
                        bool touchesOutside = ax < 0 || ay < 0 || az < 0 || ax + d > sx || ay + d > sy || az + d > sz;
                        if (touchesOutside) Visit(ix, iy, iz);
                    }
            while (queue.Count > 0)
            {
                var (ix, iy, iz) = queue.Dequeue();
                Visit(ix - 1, iy, iz); Visit(ix + 1, iy, iz);
                Visit(ix, iy - 1, iz); Visit(ix, iy + 1, iz);
                Visit(ix, iy, iz - 1); Visit(ix, iy, iz + 1);
            }

            // Open air = in-bounds cells covered by any reached window (all such cells are empty).
            var open = new bool[sx, sy, sz];
            int openCount = 0;
            for (int ix = 0; ix < nx; ix++)
                for (int iy = 0; iy < ny; iy++)
                    for (int iz = 0; iz < nz; iz++)
                    {
                        if (!reached[ix, iy, iz]) continue;
                        int ax = ix - pad, ay = iy - pad, az = iz - pad;
                        for (int x = Math.Max(ax, 0); x < Math.Min(ax + d, sx); x++)
                            for (int y = Math.Max(ay, 0); y < Math.Min(ay + d, sy); y++)
                                for (int z = Math.Max(az, 0); z < Math.Min(az + d, sz); z++)
                                    if (!open[x, y, z]) { open[x, y, z] = true; openCount++; }
                    }
            return (float)((vol - openCount) / (double)vol);
        }

        /// <summary>Occupied-cell bounds plus leaf reach, body space (RootCenter applied).</summary>
        public (Vector3 Min, Vector3 Max) Bounds()
        {
            int minX = int.MaxValue, minY = int.MaxValue, minZ = int.MaxValue;
            int maxX = int.MinValue, maxY = int.MinValue, maxZ = int.MinValue;
            foreach (var c in Cells)
            {
                minX = Math.Min(minX, c.x); maxX = Math.Max(maxX, c.x);
                minY = Math.Min(minY, c.y); maxY = Math.Max(maxY, c.y);
                minZ = Math.Min(minZ, c.z); maxZ = Math.Max(maxZ, c.z);
            }
            float r = LeafRadius;
            return (RootCenter + new Vector3(AxisPos[minX] - r, AxisPos[minY] - r, AxisPos[minZ] - r),
                    RootCenter + new Vector3(AxisPos[maxX] + r, AxisPos[maxY] + r, AxisPos[maxZ] + r));
        }

        /// <summary>A sphere-swept segment in body space; A == B degenerates to a plain sphere.</summary>
        public readonly record struct Capsule(Vector3 A, Vector3 B, float Radius);

        // Minimum segment length as a multiple of capsule diameter: below this a piece is a blob, not a
        // run (a 26 m trunk of ~5 diameters passes; a dumpster's ~1-diameter pieces spill to boxes).
        const float ElongationMin = 1.75f;

        /// <summary>
        /// Decompose the occupancy into sphere-swept segments - the rounded surface the engine's own
        /// leaf-sphere contact walk presents, so a rider deflects off a trunk instead of hitting a flat
        /// box face. Each 26-connected cell component is fitted with a segment (principal axis through
        /// the component centroid); a component whose cells stray farther than maxPerpCells lattice
        /// steps from that axis - or whose core would sweep an EMPTY cell (a bent pole's pass-under
        /// gap) - is split at its projection median and refitted. Pieces that never fit (slab-like) land in
        /// leftover for a box decomposition; radius = axis stray + LeafRadius, matching leaf reach.
        /// </summary>
        public List<Capsule> GreedyCapsules(out HashSet<(int x, int y, int z)> leftover,
                                            int cap = 24, float maxPerpCells = 1.25f)
        {
            var capsules = new List<Capsule>();
            leftover = new HashSet<(int x, int y, int z)>();
            float maxPerp = maxPerpCells * CellSpan;

            var remaining = new HashSet<(int x, int y, int z)>(Cells);
            while (remaining.Count > 0)
            {
                // Flood one 26-connected component.
                var seed = remaining.First();
                var queue = new Queue<(int x, int y, int z)>();
                var component = new List<Vector3>();
                queue.Enqueue(seed); remaining.Remove(seed);
                while (queue.Count > 0)
                {
                    var c = queue.Dequeue();
                    component.Add(Point(c));
                    for (int dx = -1; dx <= 1; dx++)
                        for (int dy = -1; dy <= 1; dy++)
                            for (int dz = -1; dz <= 1; dz++)
                            {
                                var n = (c.x + dx, c.y + dy, c.z + dz);
                                if (remaining.Remove(n)) queue.Enqueue(n);
                            }
                }
                FitOrSplit(component, 0, capsules, leftover, maxPerp, cap);
            }
            return capsules;
        }

        Vector3 Point((int x, int y, int z) c) =>
            RootCenter + new Vector3(AxisPos[c.x], AxisPos[c.y], AxisPos[c.z]);

        void FitOrSplit(List<Vector3> pts, int depth, List<Capsule> outCapsules,
                        HashSet<(int x, int y, int z)> leftover, float maxPerp, int cap)
        {
            if (pts.Count == 0) return;
            if (outCapsules.Count >= cap) { Spill(pts, leftover); return; }
            if (pts.Count == 1) { outCapsules.Add(new Capsule(pts[0], pts[0], LeafRadius)); return; }

            // Principal axis through the centroid (power iteration on the covariance), seeded with the
            // two-sweep diameter direction. A farthest-pair axis alone is corner-biased: on a 2x2xN cell
            // column it runs corner-to-corner, so every cell strays a full half-diagonal off it and the
            // capsule fattens by ~half a cell (the ELYSIUM TreeBurnB trunks read r=266 cm where the
            // engine's own sphere column is 201 cm). The centroid axis is the tight cylinder around the
            // body's leaf-sphere union.
            Vector3 seed = Farthest(pts, pts[0]);
            Vector3 axis = Farthest(pts, seed) - seed;
            float len = axis.Length();
            if (len < 1e-3f) { outCapsules.Add(new Capsule(pts[0], pts[0], LeafRadius)); return; }
            axis /= len;

            Vector3 centroid = Vector3.Zero;
            foreach (var p in pts) centroid += p;
            centroid /= pts.Count;
            float xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
            foreach (var p in pts)
            {
                var d = p - centroid;
                xx += d.X * d.X; xy += d.X * d.Y; xz += d.X * d.Z;
                yy += d.Y * d.Y; yz += d.Y * d.Z; zz += d.Z * d.Z;
            }
            for (int iter = 0; iter < 24; iter++)
            {
                var next = new Vector3(
                    xx * axis.X + xy * axis.Y + xz * axis.Z,
                    xy * axis.X + yy * axis.Y + yz * axis.Z,
                    xz * axis.X + yz * axis.Y + zz * axis.Z);
                float n = next.Length();
                if (n < 1e-6f) break;   // isotropic blob: keep the seed, elongation gate rejects it anyway
                axis = next / n;
            }

            float tMin = float.MaxValue, tMax = float.MinValue, worstPerp = 0f;
            foreach (var p in pts)
            {
                float t = Vector3.Dot(p - centroid, axis);
                tMin = Math.Min(tMin, t); tMax = Math.Max(tMax, t);
                worstPerp = Math.Max(worstPerp, (p - (centroid + axis * t)).Length());
            }
            if (worstPerp <= maxPerp)
            {
                // A capsule must be genuinely elongated - a compact blob (dumpster, crate) that merely
                // fits the radius tolerance reads better, and far cheaper, as oriented boxes on the
                // rotated instance. Splitting a within-tolerance blob can never make it elongated, so
                // stubby pieces spill straight to the box fallback.
                float radius = worstPerp + LeafRadius;
                if (tMax - tMin < ElongationMin * 2f * radius) { Spill(pts, leftover); return; }
                // Occupancy-strict, the box merge's own guarantee: the capsule core may only sweep
                // occupied cells. A bent streetlight pole otherwise fits ONE fat capsule whose core
                // swallows the pass-under gap beside the kink; splitting instead lets the straight
                // sub-runs keep their capsules while the kink spills to boxes.
                if (!CoreCoversEmptyCell(centroid, axis, tMin, tMax, worstPerp))
                {
                    outCapsules.Add(new Capsule(centroid + axis * tMin, centroid + axis * tMax, radius));
                    return;
                }
            }
            if (depth >= 6) { Spill(pts, leftover); return; }

            // Split at the projection median; identical projections fall back to an index split so both
            // halves always shrink.
            var ordered = pts.OrderBy(p => Vector3.Dot(p - centroid, axis)).ToList();
            int half = ordered.Count / 2;
            FitOrSplit(ordered.Take(half).ToList(), depth + 1, outCapsules, leftover, maxPerp, cap);
            FitOrSplit(ordered.Skip(half).ToList(), depth + 1, outCapsules, leftover, maxPerp, cap);
        }

        // True if any EMPTY lattice cell center lies within the capsule's core radius of the segment -
        // the capsule would present solid collision where the engine's own body is open.
        bool CoreCoversEmptyCell(Vector3 centroid, Vector3 axis, float tMin, float tMax, float core)
        {
            int n = AxisPos.Length;
            for (int x = 0; x < n; x++)
                for (int y = 0; y < n; y++)
                    for (int z = 0; z < n; z++)
                    {
                        if (Cells.Contains((x, y, z))) continue;
                        var p = RootCenter + new Vector3(AxisPos[x], AxisPos[y], AxisPos[z]);
                        float t = Math.Clamp(Vector3.Dot(p - centroid, axis), tMin, tMax);
                        if ((p - (centroid + axis * t)).Length() <= core) return true;
                    }
            return false;
        }

        static Vector3 Farthest(List<Vector3> pts, Vector3 from)
        {
            Vector3 best = from; float bestD = -1f;
            foreach (var p in pts)
            {
                float d = (p - from).LengthSquared();
                if (d > bestD) { bestD = d; best = p; }
            }
            return best;
        }

        void Spill(List<Vector3> pts, HashSet<(int x, int y, int z)> leftover)
        {
            // Map body-space points back to lattice cells for the box fallback.
            foreach (var p in pts)
            {
                var q = p - RootCenter;
                leftover.Add((NearestIndex(q.X), NearestIndex(q.Y), NearestIndex(q.Z)));
            }
        }

        int NearestIndex(float pos)
        {
            int best = 0; float bestD = float.MaxValue;
            for (int i = 0; i < AxisPos.Length; i++)
            {
                float d = Math.Abs(AxisPos[i] - pos);
                if (d < bestD) { bestD = d; best = i; }
            }
            return best;
        }

        /// <summary>
        /// Decompose the occupancy into a few axis-aligned body-space boxes: repeatedly take the fully-occupied
        /// box covering the most not-yet-covered cells. Boxes never cover an empty cell, so an opening stays
        /// open; the ragged single-cell fringe that doesn't merge is dropped (slightly under-conservative,
        /// fine for free-roam). Extents are padded by LeafRadius - the reach of the engine's own leaf spheres.
        /// Pass subset to decompose only those cells (the capsule pass's slab-like remainder).
        /// </summary>
        public List<(Vector3 Min, Vector3 Max)> GreedyBoxes(int cap = 16, int minNewCells = 3,
                                                            HashSet<(int x, int y, int z)>? subset = null)
        {
            var cells = subset ?? Cells;
            var boxes = new List<(Vector3, Vector3)>();
            var covered = new HashSet<(int, int, int)>();
            var xs = cells.Select(c => c.x).Distinct().OrderBy(v => v).ToArray();
            var ys = cells.Select(c => c.y).Distinct().OrderBy(v => v).ToArray();
            var zs = cells.Select(c => c.z).Distinct().OrderBy(v => v).ToArray();
            if (xs.Length == 0) return boxes;

            while (boxes.Count < cap)
            {
                int bestNew = minNewCells - 1;
                (int i0, int i1, int j0, int j1, int k0, int k1) best = default;
                bool found = false;
                foreach (int i0 in xs) foreach (int i1 in xs) { if (i1 < i0) continue;
                foreach (int j0 in ys) foreach (int j1 in ys) { if (j1 < j0) continue;
                foreach (int k0 in zs) foreach (int k1 in zs) { if (k1 < k0) continue;
                    if ((i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1) <= bestNew) continue;
                    int fresh = 0; bool full = true;
                    for (int x = i0; x <= i1 && full; x++)
                        for (int y = j0; y <= j1 && full; y++)
                            for (int z = k0; z <= k1; z++)
                            {
                                if (!cells.Contains((x, y, z))) { full = false; break; }
                                if (!covered.Contains((x, y, z))) fresh++;
                            }
                    if (full && fresh > bestNew) { bestNew = fresh; best = (i0, i1, j0, j1, k0, k1); found = true; }
                } } }
                if (!found) break;
                for (int x = best.i0; x <= best.i1; x++)
                    for (int y = best.j0; y <= best.j1; y++)
                        for (int z = best.k0; z <= best.k1; z++) covered.Add((x, y, z));
                float r = LeafRadius;
                boxes.Add((
                    RootCenter + new Vector3(AxisPos[best.i0] - r, AxisPos[best.j0] - r, AxisPos[best.k0] - r),
                    RootCenter + new Vector3(AxisPos[best.i1] + r, AxisPos[best.j1] + r, AxisPos[best.k1] + r)));
            }
            return boxes;
        }
    }

    public bool TryGet(int physicsIndex, out Body body) => _bodies.TryGetValue(physicsIndex, out body!);

    public static SsxPhysicsBodies Load(string levelDir)
    {
        var result = new SsxPhysicsBodies();
        var root = SsfLogic.Load(levelDir);
        if (root?.PhysicsHeaders == null) return result;

        string effectsPath = Path.Combine(levelDir, "Effects.json");
        for (int i = 0; i < root.PhysicsHeaders.Length; i++)
        {
            var data = root.PhysicsHeaders[i]?.PhysicsDatas?.FirstOrDefault();
            if (data == null) continue;
            var body = Decode(effectsPath, i, data);
            if (body != null) result._bodies[i] = body;
        }
        return result;
    }

    static Body? Decode(string effectsPath, int physicsIndex, SsfPhysicsData data)
    {
        var levels = data.uPhysicsStruct0;
        if (levels == null || levels.Length < 2) return null;
        if (string.IsNullOrEmpty(data.UByteData)) return null;

        // The mask data lives inside Effects.json, so a corrupt record is named by file and body index; the
        // body is dropped and CollisionBundle falls through to the instance's other collision sources.
        Body? Unreadable(Exception e)
        {
            Log.Warn($"  WARN: {effectsPath} physics body {physicsIndex} is unreadable ({e.Message}) — its collision cells are left out.");
            return null;
        }

        byte[] compressed;
        try { compressed = Convert.FromBase64String(data.UByteData); }
        catch (Exception e) { return Unreadable(e); }

        byte[] masks = DecodeMaskRle(compressed);
        if (masks.Length == 0) return null;

        int maxDepth = levels.Length - 1;
        int n = 1 << maxDepth;
        var body = new Body
        {
            PhysicsIndex = physicsIndex,
            RootCenter = new Vector3(data.UFloat0, data.UFloat1, data.UFloat2),
            GridN = n,
            LeafRadius = levels[maxDepth].U0,
            AxisPos = new float[n],
        };
        // Cell i's lattice position = the signed sum of the per-depth child offsets along its bit path
        // (bit d of i, MSB = depth 1). The same table serves all 3 axes - the octant offsets are isotropic.
        for (int i = 0; i < n; i++)
        {
            float p = 0f;
            for (int d = 1; d <= maxDepth; d++)
                p += ((i >> (maxDepth - d)) & 1) != 0 ? levels[d].U1 : -levels[d].U1;
            body.AxisPos[i] = p;
        }

        try { Walk(levels, masks, maxDepth, 0, 0, 0, 0, 0, body.Cells); }
        catch (Exception e) { return Unreadable(e); }
        return body.Cells.Count > 0 ? body : null;
    }


    // Mask decompressor (RLE): signed control byte; negative = copy -ctrl literals, [Trailmap: 130-collision-data]
    // positive = repeat the next byte ctrl+1 times, zero = stop.
    static byte[] DecodeMaskRle(byte[] src)
    {
        var dst = new List<byte>(4681); // 1 + 8 + 64 + 512 + 4096, the common max-depth-4 tree size.
        int i = 0;
        while (i < src.Length)
        {
            int ctrl = unchecked((sbyte)src[i++]);
            if (ctrl == 0) break;
            if (ctrl < 0)
            {
                int n = -ctrl;
                if (i + n > src.Length) break;
                for (int k = 0; k < n; k++) dst.Add(src[i++]);
            }
            else
            {
                int n = ctrl + 1;
                if (i >= src.Length) break;
                byte b = src[i++];
                for (int k = 0; k < n; k++) dst.Add(b);
            }
        }
        return dst.ToArray();
    }

    // Mirrors the runtime recursion [Trailmap: 130-collision-data]: child mask offset = parent + (bit+1)*U2[depth]; an early
    // leaf (mask 0) is a solid node covering its whole 2^(maxDepth-depth) subtree cube of cells.
    static void Walk(SsfPhysStruct[] levels, byte[] masks, int maxDepth, int depth, int offset,
                     int px, int py, int pz, HashSet<(int, int, int)> cells)
    {
        byte mask = (uint)offset < (uint)masks.Length ? masks[offset] : (byte)0;
        if (depth >= maxDepth || mask == 0)
        {
            int span = 1 << (maxDepth - depth);
            for (int x = 0; x < span; x++)
                for (int y = 0; y < span; y++)
                    for (int z = 0; z < span; z++)
                        cells.Add((px * span + x, py * span + y, pz * span + z));
            return;
        }

        int stride = levels[depth].U2;
        for (int bit = 0; bit < 8; bit++)
        {
            if ((mask & (1 << bit)) == 0) continue;
            Walk(levels, masks, maxDepth, depth + 1, offset + (bit + 1) * stride,
                 px * 2 + ((bit >> 2) & 1), py * 2 + ((bit >> 1) & 1), pz * 2 + (bit & 1), cells);
        }
    }

}
