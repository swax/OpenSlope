using UnityEngine;
using UdonSharp;
using VRC.SDKBase;
using VRC.Udon.Common;

namespace OpenSlope.VrcPlugin
{

    // Part of RideableBoard (partial): the straight-down and contact-aligned ride probes (wall riding).
    // The surface table + fallback smooth-normal lookup live in RideableBoard.Surface.cs.
    public partial class RideableBoard
    {
        // Analytic seam RECOVERY (docs/021): consecutive ride-probe ticks the contact RAY missed and the patch march
        // (TerrainPatches.MarchTo) supplied the contact instead. Bounded: a real launch must still leave the ground,
        // so recovery bridges at most RECOVER_TICKS_MAX ticks (0.1 s) before the miss is allowed to read as air. Reset
        // by any ray-found probe.
        private int _recoverTicks;
        private const int RECOVER_TICKS_MAX = 6;
        // Nearest solid ground (skipping our own board) under 'atPos'. Results -> _pFound/_pNormal/_pSurf/_pGroundY.
        // Skipping _ownCollider matters: otherwise the ray lands on the board we're riding and the ground-stick climbs it
        // forever (the original "space elevator").
        void Probe(Vector3 atPos)
        {
            float above = RIDE_PROBE_ABOVE, below = RIDE_PROBE_BELOW;
            ProbeDown(new Vector3(atPos.x, atPos.y + above, atPos.z), above + below);
        }

        // Shared down-ray: cast from 'origin' straight down for 'length' and keep the nearest UP-facing terrain hit
        // (results -> _pFound/_pNormal/_pSurf/_pGroundY). Used by the ride probe.
        void ProbeDown(Vector3 origin, float length)
        {
            _pFound = false; _pAnalytic = false; _pSource = 0; _pNormal = Vector3.up; _pSurf = -2; _pAudioSurf = -2; _pResetHost = false; _pGroundY = -1e9f; _pPoint = origin;
            float nearest = 1e9f;
            int nHits = Physics.RaycastNonAlloc(origin, Vector3.down, _hitBuf, length);
            bool haveTerrain = _colliders != null && _colliders.Length > 0;
            for (int i = 0; i < nHits; i++)
            {
                Collider c = _hitBuf[i].collider;
                if (c == _ownCollider) continue;
                // Only the level's terrain surfaces are "ground" - without this the down-ray also lands the board on props
                // / crash bags / the start gate / banners, which read as the board "leveling off" in mid-air over one. (If
                // terrain wasn't wired we fall back to accepting all, so the board can't fall forever.)
                int ci = IndexOf(c);
                int ty = ci >= 0 ? _types[ci] : -1;
                int aty = ty;                                // the ride-audio table reads the contact's REAL type...
                if (haveTerrain && ty == -1)
                {
                    if (!IsRideableProp(c)) continue;        // skip non-surface props (sign boxes / triggers / crash bags)
                    aty = PropAudioSurfaceType(c);           // authored metadata first, legacy _T12 suffix second
                    ty = aty >= 0 ? aty : propRideSurfaceType; // authored customs use the real material feel; untyped props use object handling
                }
                // ...and only an UP-facing hit is a floor - skip undersides / vertical faces so we don't grab an overhang.
                if (_hitBuf[i].normal.y <= 0f) continue;
                if (_hitBuf[i].distance < nearest)
                {
                    nearest = _hitBuf[i].distance;
                    _pFound = true;
                    // Smooth (analytic Bezier) contact normal (docs/021): blend the hit triangle's three baked vertex
                    // normals by the barycentric weights instead of the flat per-triangle hit normal. Falls back to the
                    // raw hit normal when this collider has no baked normals.
                    _pSurf = ty;
                    _pAudioSurf = aty;
                    _pResetHost = ResetOnContact(c);   // riding onto a reset host's TOP face is still hitting it
                    // Resolve contact point + normal: EXACT bicubic patch (approach A) when available, else PN/faceted.
                    // ProbeDown cast straight down from 'origin', so that's the ray we refine the surface intersection on.
                    ResolveContact(ci, _hitBuf[i].triangleIndex, _hitBuf[i].barycentricCoordinate,
                                   _hitBuf[i].point, _hitBuf[i].normal, ty, origin, Vector3.down);
                }
            }
        }

        // Contact-aligned ride probe: cast ALONG the cached contact normal (from the active above endpoint back into the surface)
        // to find the surface the board is riding REGARDLESS of its orientation. This is the engine's model - its contact
        // probe is aimed by the previous contact normal (the previous normal aims the next probe) [Trailmap: 320-ground-contact],
        // which is what lets a boarder ride up and STICK to walls / quarter-pipes
        // (the wall is beside us, not below, so a down-ray never finds it). On flat ground _contactN ~ up so this is the
        // straight-down ride probe; if the contact cast finds nothing (first contact, a sharp seam, the surface dropped
        // away) it falls back to the plain down-probe, so flat-ground riding/landing never regress. Results ->
        // _pFound/_pNormal/_pSurf/_pGroundY/_pPoint, the same fields as ProbeDown.
        void ProbeContact(Vector3 atPos)
        {
            Vector3 n = _contactN.sqrMagnitude > 1e-6f ? _contactN.normalized : Vector3.up;
            float above = RIDE_PROBE_ABOVE, below = RIDE_PROBE_BELOW;
            Vector3 origin = atPos + n * above;   // start out from the surface along its normal...
            _pFound = false; _pAnalytic = false; _pSource = 0; _pNormal = n; _pSurf = -2; _pAudioSurf = -2; _pResetHost = false; _pGroundY = -1e9f; _pPoint = atPos;
            float nearest = 1e9f;
            int nHits = Physics.RaycastNonAlloc(origin, -n, _hitBuf, above + below); // ...and cast back INTO it
            bool haveTerrain = _colliders != null && _colliders.Length > 0;
            for (int i = 0; i < nHits; i++)
            {
                Collider c = _hitBuf[i].collider;
                if (c == _ownCollider) continue;
                int ci = IndexOf(c);
                int ty = ci >= 0 ? _types[ci] : -1;
                int aty = ty;                                                // the ride-audio table reads the contact's REAL type...
                if (haveTerrain && ty == -1)                                 // not a terrain surface...
                {
                    if (!IsRideableProp(c)) continue;                        // ...skip non-surface props (sign boxes / triggers / bags)
                    aty = PropAudioSurfaceType(c);                           // authored metadata first, legacy _T12 suffix second
                    ty = aty >= 0 ? aty : propRideSurfaceType;               // typed customs use the real material feel + audio
                }
                // Accept only a FRONT face we could rest on: its normal must point back toward us (roughly along the cached
                // contact normal), not a back-face / overhang we're casting through. This is the orientation-general
                // replacement for ProbeDown's up-only (normal.y > 0) test, so walls pass.
                if (Vector3.Dot(_hitBuf[i].normal, n) <= 0.1f) continue;
                if (_hitBuf[i].distance < nearest)
                {
                    nearest = _hitBuf[i].distance;
                    _pFound = true;
                    _pSurf = ty;
                    _pAudioSurf = aty;
                    _pResetHost = ResetOnContact(c);   // riding onto a reset host's TOP face is still hitting it
                    // Resolve contact point + normal: EXACT bicubic patch (approach A) when available, else PN/faceted.
                    // ProbeContact cast along -n (into the surface), so we refine the patch intersection on that ray -
                    // orientation-free, so it rides walls/quarter-pipes too. ContactGap measures along _pNormal.
                    ResolveContact(ci, _hitBuf[i].triangleIndex, _hitBuf[i].barycentricCoordinate,
                                   _hitBuf[i].point, _hitBuf[i].normal, ty, origin, -n);
                }
            }
            if (_pFound) { _recoverTicks = 0; return; }

            // Analytic seam RECOVERY: the contact ray missed (a chord gap between facets, or every hit failed the
            // front-face gate - both happen on walls/steep seams) while the last tick
            // rode a mapped patch. March the patch (u,v) to the closest true-surface point and contact THERE, instead of
            // dropping to the down-probe - which cannot see a wall beside us, making the miss unrecoverable. Gated to
            // steep contacts (n.y < 0.85) so flat-ground lips keep reading as air the way the traced model expects; the
            // contact error still decides grounded, so a genuine launch leaves even mid-recovery. No ray = no fresh
            // surface-type read: the surface we were riding stands for the bridged ticks. Costs ~3 Refine-equivalents,
            // ONLY on ray-miss ticks (docs/021).
            if (terrainPatches != null && terrainPatches.RHasPatch &&
                n.y < 0.85f && _recoverTicks < RECOVER_TICKS_MAX)
            {
                terrainPatches.MarchTo(atPos);
                if (terrainPatches.RFound)
                {
                    _recoverTicks++;
                    _pFound = true;
                    _pAnalytic = true;
                    _pSource = 3;
                    _pNormal = terrainPatches.RNormal;
                    _pPoint = terrainPatches.RPoint;
                    _pGroundY = terrainPatches.RPoint.y;
                    _pSurf = _rideSurf;
                    _pAudioSurf = _rideSurf;
                    return;
                }
            }

            Probe(atPos); // contact cast missed -> fall back to the straight-down ride probe (flat-ground / first-contact safe)
        }
    }
}
