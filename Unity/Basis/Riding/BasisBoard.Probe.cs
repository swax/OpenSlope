using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Part of BasisBoard (partial): the ground / contact probes (straight-down + contact-aligned for wall riding),
    // the along-normal contact gap, and a simplified collide-and-slide off solid walls/props. Ported from the VRChat
    // board's RideableBoard.Probe.cs, minus the analytic-patch refine (we resolve the faceted hit + smooth normal
    // directly) and minus the VRChat prop-component / foliage / impact-audio hooks (not in the Basis MVP).
    public partial class BasisBoard
    {
        // Nearest solid ground (skipping our own board) under 'atPos'. Skipping _ownCollider matters: otherwise the ray
        // lands on the board we're riding and the ground-stick climbs it forever (the "space elevator").
        void Probe(Vector3 atPos)
        {
            ProbeDown(new Vector3(atPos.x, atPos.y + rayUp, atPos.z), rayUp + rayDown);
        }

        // Shared down-ray: cast from 'origin' straight down for 'length', keep the nearest UP-facing terrain hit.
        void ProbeDown(Vector3 origin, float length)
        {
            _pFound = false; _pNormal = Vector3.up; _pSurf = -2; _pResetHost = false; _pGroundY = -1e9f; _pPoint = origin;
            float nearest = 1e9f;
            int nHits = Physics.RaycastNonAlloc(origin, Vector3.down, _hitBuf, length);
            bool haveTerrain = _colliders != null && _colliders.Length > 0;
            for (int i = 0; i < nHits; i++)
            {
                Collider c = _hitBuf[i].collider;
                if (c == _ownCollider) continue;
                int ci = IndexOf(c);
                int ty = ci >= 0 ? _types[ci] : -1;
                if (haveTerrain && ty == -1)
                {
                    if (!IsRideableProp(c)) continue;    // skip non-surface props (sign boxes / triggers / crash bags)
                    int propType = PropSurfaceType(c);
                    ty = propType >= 0 ? propType : propRideSurfaceType;
                }
                if (_hitBuf[i].normal.y <= 0f) continue; // only an up-facing hit is a floor
                if (_hitBuf[i].distance < nearest)
                {
                    nearest = _hitBuf[i].distance;
                    _pFound = true;
                    _pSurf = ty;
                    _pResetHost = ResetOnContact(c);   // riding onto a reset host's TOP face is still hitting it
                    _pNormal = SmoothNormal(ci, _hitBuf[i].triangleIndex, _hitBuf[i].barycentricCoordinate, _hitBuf[i].normal);
                    _pPoint = _hitBuf[i].point;
                    _pGroundY = _pPoint.y;
                }
            }
        }

        // Ground Y under an arbitrary XZ (terrain only) WITHOUT touching the _p* ride-probe fields. Used by the landing
        // anticipation lookahead. Returns the nearest up-facing terrain hit's Y, or a large-negative sentinel.
        float SampleGroundY(Vector3 atXZ, float fromY, float length)
        {
            float best = -1e9f;
            float nearest = 1e9f;
            int nHits = Physics.RaycastNonAlloc(new Vector3(atXZ.x, fromY, atXZ.z), Vector3.down, _hitBuf, length);
            bool haveTerrain = _colliders != null && _colliders.Length > 0;
            for (int i = 0; i < nHits; i++)
            {
                Collider c = _hitBuf[i].collider;
                if (c == _ownCollider) continue;
                int ci = IndexOf(c);
                int ty = ci >= 0 ? _types[ci] : -1;
                if (haveTerrain && ty == -1) { if (!IsRideableProp(c)) continue; }
                if (_hitBuf[i].normal.y <= 0f) continue;
                if (_hitBuf[i].distance < nearest) { nearest = _hitBuf[i].distance; best = _hitBuf[i].point.y; }
            }
            return best;
        }

        // Contact-aligned ride probe: cast ALONG the cached contact normal (from a point rayUp out, back into the surface)
        // to find the surface the board is riding REGARDLESS of its orientation - the engine's contact-normal-aimed probe
        // [Trailmap: 320-ground-contact], which is what lets a boarder ride up and stick to walls / quarter-pipes. On flat
        // ground _contactN ~ up so this is the straight-down ride probe; a miss falls back to the plain down-probe.
        void ProbeContact(Vector3 atPos)
        {
            Vector3 n = _contactN.sqrMagnitude > 1e-6f ? _contactN.normalized : Vector3.up;
            Vector3 origin = atPos + n * rayUp;
            _pFound = false; _pNormal = n; _pSurf = -2; _pResetHost = false; _pGroundY = -1e9f; _pPoint = atPos;
            float nearest = 1e9f;
            int nHits = Physics.RaycastNonAlloc(origin, -n, _hitBuf, rayUp + rayDown);
            bool haveTerrain = _colliders != null && _colliders.Length > 0;
            for (int i = 0; i < nHits; i++)
            {
                Collider c = _hitBuf[i].collider;
                if (c == _ownCollider) continue;
                int ci = IndexOf(c);
                int ty = ci >= 0 ? _types[ci] : -1;
                if (haveTerrain && ty == -1)
                {
                    if (!IsRideableProp(c)) continue;
                    int propType = PropSurfaceType(c);
                    ty = propType >= 0 ? propType : propRideSurfaceType;
                }
                // Accept only a FRONT face we could rest on (normal points back along the cached contact normal), so walls
                // pass but we don't grab a back-face / overhang we're casting through.
                if (Vector3.Dot(_hitBuf[i].normal, n) <= 0.1f) continue;
                if (_hitBuf[i].distance < nearest)
                {
                    nearest = _hitBuf[i].distance;
                    _pFound = true;
                    _pSurf = ty;
                    _pResetHost = ResetOnContact(c);   // riding onto a reset host's TOP face is still hitting it
                    _pNormal = SmoothNormal(ci, _hitBuf[i].triangleIndex, _hitBuf[i].barycentricCoordinate, _hitBuf[i].normal);
                    _pPoint = _hitBuf[i].point;
                    _pGroundY = _pPoint.y;
                }
            }
            if (!_pFound) Probe(atPos); // contact cast missed -> fall back to the straight-down ride probe
        }

        // Distance from 'pos' to the probed contact surface, measured ALONG the surface normal (the engine's signed
        // contact error lives along the contact normal likewise). Positive = hovering off; <= the stick band = "on" it.
        float ContactGap(Vector3 pos)
        {
            return Vector3.Dot(pos - _pPoint, _pNormal);
        }

        // Collide-and-slide the intended move ('disp', from 'from') off solid walls/props, returning the resolved end
        // position and removing the into-wall part of _vel. Static prop buckets apply their authored bounce/slide value
        // and impact clip; untyped walls use obstacleBounce. Own deck box + rider probe are skipped; triggers are ignored.
        Vector3 ResolveObstacles(Vector3 from, Vector3 disp)
        {
            if (_capRadius <= 0f) return from + disp; // no probe capsule cached -> feature off
            Vector3 pos = from;
            Vector3 remaining = disp;
            int embeddedCount = 0;
            for (int it = 0; it < 4; it++)
            {
                float dist = remaining.magnitude;
                if (dist < 1e-5f) break;
                Vector3 dir = remaining / dist;
                // Raise the sweep's BOTTOM sphere to ~torso height so the deck + legs ride into a concave dip without the
                // capsule embedding in the faceted collider. Clamped below the top sphere so the capsule stays valid.
                float swLow = _capLow + sweepFootClearance; if (swLow > _capHigh) swLow = _capHigh;
                Vector3 p0 = pos + Vector3.up * swLow;
                Vector3 p1 = pos + Vector3.up * _capHigh;
                int nHits = Physics.CapsuleCastNonAlloc(p0, p1, _capRadius, dir, _hitBuf, dist + obstacleSkin, ~0, QueryTriggerInteraction.Ignore);
                float nearest = 1e9f; bool found = false; Vector3 hn = Vector3.up; Collider hitCol = null;
                for (int i = 0; i < nHits; i++)
                {
                    Collider c = _hitBuf[i].collider;
                    if (c == null) continue;                            // slot invalidated mid-sweep
                    if (_hitBuf[i].distance <= 0f)
                    {
                        // Already INSIDE this collider. A zero-distance cast hit carries no usable normal, so it
                        // cannot drive collide-and-slide - but skipping it outright is what let the rider take the
                        // whole move and sail through the thing they were embedded in, and then stay stuck in it.
                        // Remember it for the push-out below, which is the engine's own answer [Trailmap: 370-depenetrate].
                        // Props only: on the ground this capsule is buried in terrain by design, and pushing out of
                        // that is what jerks the ride through powder and dips [see OwnedByProps].
                        if (c != _ownCollider && c != _probeCol && embeddedCount < _embedded.Length
                            && c.GetComponent<BasisPhysicsProp>() == null && OwnedByProps(c))
                        {
                            bool already = false;
                            for (int k = 0; k < embeddedCount; k++) if (_embedded[k] == c) { already = true; break; }
                            if (!already) _embedded[embeddedCount++] = c;
                        }
                        continue;
                    }
                    if (_hitBuf[i].normal.y > wallNormalMax) continue;  // up-facing -> ridable ground (the down-probe owns it)
                    if (_hitBuf[i].distance >= nearest) continue;
                    if (c == _ownCollider || c == _probeCol) continue;  // our own deck box / probe capsule
                    if (c.GetComponent<BasisPhysicsProp>() != null) continue; // mode-3 knockable: physics-routed in the game - the poll knocks it, it never walls the rider (its solid box is for the walking player)
                    nearest = _hitBuf[i].distance;
                    hn = _hitBuf[i].normal;
                    hitCol = c;
                    found = true;
                }
                // The BODY SPHERE pass: a native mode-2 bounding box is met by one 0.85 m ball at the pelvis,
                // not by the probe capsule [Trailmap: 370-probe-modes]. The ball is larger than the swept
                // capsule everywhere the capsule exists, so it always reports the earlier hit on a box - which
                // is why the capsule sweep above does not exclude them, and why a box no longer slips under the
                // capsule's raised foot.
                if (bodySphereRadius > 0f && BoundsRoot() != null)
                {
                    Vector3 sc = pos + Vector3.up * bodySphereHeight;
                    int nSphere = Physics.SphereCastNonAlloc(sc, bodySphereRadius, dir, _hitBuf,
                                                             dist + obstacleSkin, ~0, QueryTriggerInteraction.Ignore);
                    for (int i = 0; i < nSphere; i++)
                    {
                        Collider c = _hitBuf[i].collider;
                        if (c == null) continue;
                        if (_hitBuf[i].distance <= 0f)
                        {
                            if (c != _ownCollider && c != _probeCol && embeddedCount < _embedded.Length
                                && c.transform.parent == _boundsRoot)
                            {
                                bool seen = false;
                                for (int k = 0; k < embeddedCount; k++) if (_embedded[k] == c) { seen = true; break; }
                                if (!seen) _embedded[embeddedCount++] = c;
                            }
                            continue;
                        }
                        if (_hitBuf[i].normal.y > wallNormalMax) continue;   // up-facing -> the down-probe owns it
                        if (_hitBuf[i].distance >= nearest) continue;
                        if (c.transform.parent != _boundsRoot) continue;     // not a mode-2 box: the capsule owns it
                        nearest = _hitBuf[i].distance;
                        hn = _hitBuf[i].normal;
                        hitCol = c;
                        found = true;
                    }
                }
                if (!found) { pos += remaining; break; }                // nothing in the way -> take the whole move
                float move = Mathf.Max(0f, nearest - obstacleSkin);
                pos += dir * move;                                      // advance up to (just shy of) the wall
                Vector3 leftover = remaining - dir * move;
                remaining = Vector3.ProjectOnPlane(leftover, hn);       // slide the rest along the wall face
                float into = Vector3.Dot(_vel, hn);
                if (into < 0f)
                {
                    float delta = -(1f + BounceForObstacle(hitCol)) * into;
                    if (PlayerBounceForObstacle(hitCol)) delta = Mathf.Max(delta, -into + 2f / 3.6f);
                    _vel += delta * hn;
                    PlayImpactSound(hitCol, -into);
                    // A prop carrying the host's MainType-13 on its own collision (an animated reset host - the
                    // megaplex doors) resets on CONTACT, which is where the engine puts it. Same gate as the impact
                    // sound, so it is a real hit rather than a graze.
                    if (ResetOnContact(hitCol)) TriggerReset();
                }
            }
            return Depenetrate(pos, embeddedCount);
        }

        /// <summary>
        /// Push the rider back out of anything the sweep found itself already inside.
        ///
        /// The engine resolves a solid prop contact by depenetration FIRST - the rider's position is moved along
        /// the contact normal by 1.1x the reported penetration - and only then applies the restitution
        /// [Trailmap: 370-depenetrate]. Collide-and-slide alone has no answer for an overlap that already exists:
        /// a sweep that starts inside a collider has nowhere to advance to, which is why the rider could end up
        /// passing through a prop and then stuck in it.
        ///
        /// Only the deepest overlap is resolved per call. Overlaps are rare (the sweep capsule's bottom sphere
        /// rides at torso height, so it does not sit in the ground), and resolving the deepest one first lets the
        /// next frame handle any remainder rather than fighting several pushes into each other.
        /// </summary>
        // The level's mode-2 bounding-box root, found once. Null on a map with no bounds colliders, which turns
        // the body-sphere pass off rather than making it search every frame.
        Transform BoundsRoot()
        {
            if (!_boundsRootSearched)
            {
                _boundsRootSearched = true;
                GameObject go = GameObject.Find("PropsBoundsCollision");
                if (go != null) _boundsRoot = go.transform;
            }
            return _boundsRoot;
        }

        // The three solid prop collision roots the importer builds (foliage and contact-sound roots are triggers,
        // which the sweeps ignore). Found once; a map without them simply has no prop to be pushed out of.
        Transform[] PropRoots()
        {
            if (!_propRootsSearched)
            {
                _propRootsSearched = true;
                _propRoots = new Transform[3];
                GameObject solid = GameObject.Find("PropsCollision");
                GameObject body = GameObject.Find("PropsBodyCollision");
                GameObject bounds = GameObject.Find("PropsBoundsCollision");
                if (solid != null) _propRoots[0] = solid.transform;
                if (body != null) _propRoots[1] = body.transform;
                if (bounds != null) _propRoots[2] = bounds.transform;
            }
            return _propRoots;
        }

        /// <summary>
        /// Is this collider part of a prop, as opposed to the terrain the rider is riding?
        ///
        /// Depenetration answers a solid PROP contact [Trailmap: 370-depenetrate]. The ride surface is owned by the
        /// down-probe and its sink spring, and that spring parks the board INSIDE the snow on purpose - 26 cm in
        /// deep powder (powderSinkDepth * 1.2). Through a dip the terrain facet rises around the rider, so even the
        /// raised sweep foot (sweepFootClearance) ends up embedded in ground that is behaving exactly as intended.
        /// Pushing out of that fights the contact model every frame, which is felt as the ride jerking.
        ///
        /// Reference compares up the parent chain: no per-hit GetComponent, and overlaps are rare enough that the
        /// walk never shows up in a frame.
        /// </summary>
        bool OwnedByProps(Collider col)
        {
            Transform[] roots = PropRoots();
            for (Transform t = col.transform; t != null; t = t.parent)
                for (int i = 0; i < roots.Length; i++)
                    if (roots[i] != null && t == roots[i]) return true;
            return false;
        }

        Vector3 Depenetrate(Vector3 pos, int embeddedCount)
        {
            if (embeddedCount <= 0 || _probeCol == null) return pos;
            Vector3 probeOffset = _probeCol.transform.position - transform.position;
            Vector3 bestDir = Vector3.zero;
            float bestDepth = 0f;
            for (int i = 0; i < embeddedCount; i++)
            {
                Collider c = _embedded[i];
                if (c == null) continue;
                if (!Physics.ComputePenetration(
                        _probeCol, pos + probeOffset, _probeCol.transform.rotation,
                        c, c.transform.position, c.transform.rotation,
                        out Vector3 dir, out float depth)) continue;
                // An up-facing push is the ground holding the rider up, which the down-probe owns; taking it here
                // would fight the contact model for the whole descent.
                if (dir.y > wallNormalMax) continue;
                if (depth > bestDepth) { bestDepth = depth; bestDir = dir; }
            }
            if (bestDepth <= 0f) return pos;
            pos += bestDir * (bestDepth * 1.1f);   // the engine's own 1.1x, so the rider ends up clear rather than resting on the surface
            float into = Vector3.Dot(_vel, bestDir);
            if (into < 0f) _vel -= into * bestDir;  // stop driving back into what we just left
            return pos;
        }

        float BounceForObstacle(Collider col)
        {
            if (col != null)
            {
                var prop = col.GetComponent<BasisPropBounce>();
                if (prop != null) return prop.PlayerBounce
                    ? Mathf.Max(0f, prop.PlayerBounceAmmount) * obstacleBounceScale : 0f;
            }
            return Mathf.Max(0f, obstacleBounce);
        }

        // The native PlayerBounce branch guarantees a 2 km/h outward component even for a soft, slow impact.
        // Native flag-off props are omitted from solid buckets; this remains separate for legacy/manual colliders.
        bool PlayerBounceForObstacle(Collider col)
        {
            if (col == null) return false;
            var prop = col.GetComponent<BasisPropBounce>();
            return prop != null && prop.PlayerBounce;
        }

        Collider _lastImpactCollider;
        float _lastImpactTime = -10f;
        void PlayImpactSound(Collider col, float speed)
        {
            const float minSpeed = 1.5f, fullSpeed = 16f, debounce = 0.3f;
            if (col == null || speed < minSpeed) return;
            if (col == _lastImpactCollider && Time.time - _lastImpactTime < debounce) return;
            var carrier = col.GetComponent<AudioSource>();
            if (carrier == null || carrier.clip == null) return;
            float volume = Mathf.Clamp01((speed - minSpeed) / (fullSpeed - minSpeed)) * soundVolume;
            var output = glideSource != null ? glideSource : carrier;
            output.PlayOneShot(carrier.clip, volume);
            _lastImpactCollider = col;
            _lastImpactTime = Time.time;
        }
    }
}
