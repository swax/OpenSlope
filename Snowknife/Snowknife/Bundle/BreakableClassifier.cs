using Snowknife.Engine;

namespace Snowknife.Bundle;

/// <summary>
/// Classifies the level's scripted-BREAK obstacle props from the SSF effect graph — the general case of the LCD-logo
/// break (Unity docs/028) generalised in Unity docs/036: wood fences, hole covers, tree branches. A breakable carries an
/// <c>EffectSlotIndex</c> whose ride-through COLLISION effect hides the source, reveals a pre-placed invisible
/// <c>_Junk</c> broken twin, or starts a mesh break animation on the source/twin.
///
/// The break is the SSF effect-slot path: a node list at
/// <c>EffectSlots[idx].CollisionEffectSlot → EffectHeaders[N]</c>, where <c>MainType 7</c> sets a named instance's
/// render state (hide a visible one / reveal a hidden one) and <c>MainType 0 type0</c> with a KILL sub-type
/// (Sub5 DeadNodeMode4, Sub20) kills the source. CRUCIAL (Unity docs/028): an <c>EffectSlotIndex</c> alone is NOT a
/// break — the directional sign just TextureFlips (PersistantEffectSlot), the chain-link fence flexes (type0
/// Sub12), the warning sign is a knock-over physics prop. So the collision chain is followed only when it carries
/// a hide-the-source / reveal-a-hidden-twin / mesh-animation break chain, with a break-action type0 node.
///
/// The main loop handles both the INLINE-effect breakables (fences/hole-covers/branches, via a hide/reveal chain
/// directly in the CollisionEffectSlot header) and the LCD jumbotrons (whose header runs a <c>MainType 21 →
/// Functions[BreakLogo*]</c> dispatch; FunctionRoles reads that function's M7 hide/reveal roles). Three further
/// passes read the shapes it cannot: <see cref="ScanCrackedGlass"/> (a fragile surface worn down by contact,
/// whose break lives in the slot's deferred-trigger column), <see cref="ScanTriggerDriven"/> (a solid prop broken
/// by a separate invisible volume) and <see cref="ScanSpills"/> (a knock body that also throws its contents).
///
/// Inline clusters key <c>"brk_"</c>, LCD clusters key <c>"lcd_"</c> (so the importer keeps hiding the identical
/// welded LCD twin rather than revealing it like a fence's junk twin). Output: per-instance role/cluster the
/// PropsBundle divert reads. Only the inline <c>"brk_"</c> set is handed to CollisionBundle to skip (pass-through
/// break trigger); LCD screens keep the collision they already had, and so does a cracked pane's
/// <c>"support"</c> twin — it is the collider the rider stands on until the glass gives way, so BundleExporter
/// holds it back from the skip set and gives it its own per-instance bucket instead.
/// </summary>
public static class BreakableClassifier
{
    // Throw = the cluster's mesh-throw (type0 Sub20) params when the break THROWS the broken pieces
    // (see Unity docs/036, [Trailmap: 230-level-ssf]): U1 = frame step (s), U2 = duration (s; stored as U2*60 frames),
    // U3-5 = authored throw direction (all zero = use the actual COLLISION direction), U6-8 = per-axis velocity
    // scale (SSX cm/s), U9 = direction scale. Null = no Sub20 in the chain (plain hide/reveal, e.g. LCD logos).
    // BurstColor (intact role only): the authored tint of the prop's "explode in stars" burst, read from a
    // type2Sub0 particle emitter sitting directly in the prop's CollisionEffectSlot (e.g. balloon
    // animals: hit one and it pops into a coloured star spray). Null = an ordinary break (the LCD/fence shard
    // shatter). The importer turns this into a tinted additive STAR burst instead of texture-fragment
    // shards. See Unity docs/036.
    // The SSF stores each colour stop as A,R,G,B: stop 0 is U33/U34/U35/U36, so its RGB really is
    // U34/U35/U36. The engine loader performs the same [U34,U35,U36,U33] -> RGBA rotation before P6; a
    // controlled PCSX2 red/green canary confirmed the static trace. See [Trailmap: 180-particles-data].
    // BreakSound (intact role only): a trigger-driven chain's MainType-8 raw course-bank slot - the smash's own
    // sound (glass panes 64, sewer walls 43, the globe's landing crash), since the intact prop itself is authored
    // silent. -1 = the chain plays nothing. Anim/BreakDelay (intact role only): the ROLL-AWAY sequenced break
    // (Unity docs/036 - the city globe sign). The trigger chain PLAYS the intact's own model clip (an M7 -> Sub256
    // AnimObject on the source: the globe rolls down the street), WAITS (MainType 4), then runs the
    // hide/reveal/throw. Anim = the Sub256/257 payload [U0..U7]; BreakDelay = the summed chain wait in seconds;
    // null/0 = the instant break every other cluster uses.
    // CrackStrength/CrackLifetime/CrackSound (intact role only): the FRAGILE-SURFACE break (the megaplex glass
    // panes - see ScanCrackedGlass). A positive CrackStrength is what marks a cluster as one: the prop is not
    // broken by the contact that hits it, it holds an impact-budget pool that contacts drain, and only when the
    // pool crosses zero does the break run. CrackSound is the glancing-hit CRACK (a MainType-8 raw slot on the
    // collision chain, 65), as distinct from BreakSound's smash (64). CrackLifetime is the crack's own lifetime
    // in seconds; -1 (every retail pane) never expires, a positive one HEALS the surface. 0 = an ordinary
    // instant breakable.
    public sealed class Member { public string ClusterKey = ""; public string Role = ""; public bool IsDebris; public float[]? Throw; public float[]? BurstColor; public float[]? Anim; public float BreakDelay; public int BreakSound = -1; public float CrackStrength; public float CrackLifetime; public int CrackSound = -1; }

    // Does a type0 node mark the prop as a break action? Two observed break actions, both DISTINCT from look-alikes:
    //  - Sub5 with DeadNodeMode==4: the hard kill the fences/hole-covers use to hide the intact. NOT Sub5/Dead2,
    //    which is what a SPEED-BOOST pad's effect carries (it's not a break) - so the DeadNodeMode==4 is load-bearing.
    //  - Sub20: mesh-throw (Unity docs/036). On branches it animates the source itself; on revealed _Junk twins it throws
    //    the broken pieces. NOT 11 (TextureFlip) / 12 (Fence flex) - persistent, non-break.
    static bool IsBreakAction(SsfType0 t) => (t.SubType == SsfType0Sub.DeadNode && t.DeadNodeMode == 4) || t.SubType == SsfType0Sub.MeshAnim;

    /// <summary>instance index → its breakable role/cluster. Empty if the effect document is absent/unparseable.
    /// <paramref name="spills"/> is the separate SPILL-SOURCE index (see ScanSpills): instance index → the cluster
    /// its collision chain throws. A prop can be in both maps, or in spills alone.</summary>
    public static Dictionary<int, Member> Build(string levelDir, List<SsxInstance>? instances,
                                                out Dictionary<int, string> spills)
    {
        var map = new Dictionary<int, Member>();
        spills = new Dictionary<int, string>();
        if (instances == null) return map;

        var root = SsfLogic.Load(levelDir);
        if (root?.EffectSlots == null || root.EffectHeaders == null) return map;
        var ES = root.EffectSlots; var EH = root.EffectHeaders;

        for (int i = 0; i < instances.Count; i++)
        {
            // The SOURCE of a break is a VISIBLE prop you smash (a fence/branch you see). Invisible volumes
            // (Mdl_Trigger_*/event/firework) are NOT breakables - their type0 Sub5/Dead4 is "this one-shot effect
            // node dies after firing", and their M7 targets are the pyro they fire, not broken pieces. Gating on
            // Visable drops every such trigger (and stops its targets being mis-tagged as break companions).
            if (!instances[i].Visable) continue;
            int e = instances[i].EffectSlotIndex;
            if (e < 0 || e >= ES.Length) continue;
            int ce = ES[e].CollisionEffectSlot;
            if (ce < 0 || ce >= EH.Length) continue;

            bool hideSelf = false;
            float[]? throwParams = null;
            var reveals = new List<int>();   // M7 targets currently invisible → the broken twin shown on break
            var hides = new List<int>();     // M7 targets currently visible → hidden on break (the source, or a scanline-like companion)
            Walk(EH, ce, instances, ref hideSelf, ref throwParams, reveals, hides, 0);
            // LCD jumbotrons drive the break through a MainType-21 BreakLogo function (not an inline chain): read
            // its M7 hide/reveal roles. Kept separate from Walk (roles only, no Sub20 recursion) so the LCD twin's
            // authored mesh-throw is NOT collected - the original LCD break is a screen-vanish + shard burst (Unity docs/028),
            // so its Throw stays null.
            bool viaFunction = false;
            FunctionRoles(EH, root.Functions, ce, instances, reveals, hides, ref viaFunction);

            bool sourceHidden = hideSelf || hides.Contains(i);
            if (!(sourceHidden || reveals.Count > 0)) continue;   // not a break (flex / textureflip / knock are excluded)

            // LCD (function-driven) clusters use a distinct "lcd_" namespace so the importer keeps HIDING the welded
            // twin (it looks identical; the shard burst is the real break) instead of REVEALING it the way it reveals
            // a fence/hole-cover's "brk_" _Junk twin. Inline breakables keep "brk_". The source (the CollisionEffect
            // carrier) is always the intact screen (CollsionMode-2 pass-through; RE-confirmed, uniform on all levels).
            string cluster = (viaFunction ? "lcd_" : "brk_") + i;
            Set(map, i, cluster, "intact", reveals.Count == 0, throwParams);
            foreach (int t in reveals) Set(map, t, cluster, "broken", false, throwParams);
            foreach (int t in hides) if (t != i) Set(map, t, cluster, "scanline", false, throwParams);

            // "Explode in stars": a type2Sub0 emitter sitting directly in this prop's collision effect (the
            // balloon animals) means the pop is a coloured star spray, not a shard shatter. Record its colour
            // on the intact member so the importer builds the star burst. Ordinary breaks have no emitter -> null.
            float[]? burst = FirstBurstColor(EH, ce);
            if (burst != null && map.TryGetValue(i, out var im)) im.BurstColor = burst;
        }

        // Cracked glass runs BEFORE the trigger-driven pass: 6 of the megaplex's 20 panes ALSO carry a
        // pass-through smash volume whose own collision chain breaks the same glass, and that volume is exactly
        // the shape ScanTriggerDriven matches. Claiming the pane here first makes that pass's
        // "already classified another way" guard fold the volume into this cluster instead of forking a second,
        // crack-less one over the same pane.
        ScanCrackedGlass(map, ES, EH, instances);
        ScanTriggerDriven(map, ES, EH, instances);
        ScanSpills(map, spills, ES, EH, instances);
        return map;
    }

    // Fourth pass: CRACKED-GLASS breakables (Unity docs/036 §Cracked glass - the megaplex's 20 window/floor panes, the
    // only place the game authors the Cracked node). Every pass above reads a chain that breaks the prop on the
    // contact that runs it. This one does not: the pane's COLLISION chain only installs a fragile-surface handler
    // ([Trailmap: 370-world-interaction], type0 Sub14) holding an impact-budget pool, and the break is the
    // continuation that handler fires when the pool runs out - the slot's DEFERRED-TRIGGER column
    // (EffectTriggerSlot, [Trailmap: 150-logic]), which none of the passes above walk. Without this pass a pane
    // imports as ordinary solid scenery: unbreakable, and silent.
    //
    // The authored unit is a SANDWICH of four instances, and the roles fall straight out of the flags:
    //   - Mdl_Glass_Pane_*        VISIBLE, response mass 0 (pass-through), owns the slot   -> "intact"
    //   - Mdl_Glass_Surface_*     invisible, response mass 1e30 (SOLID)                    -> "support"
    //   - Mdl_Glass_SurfaceBottom invisible, response mass 0 (pass-through volume)         -> "smash"
    //   - Mdl_Glass_Junk*_*       invisible, no collision, ~23 shard objects               -> "broken"
    // The pane you SEE is not the thing that holds you up: the invisible solid twin beside it is, which is why
    // the support role exists at all. The break has to take that collider away, so unlike every other breakable
    // the support must KEEP its collision until then (BundleExporter hands it to CollisionBundle as its own
    // per-instance bucket rather than dropping it from the break set).
    //
    // The gate is the Cracked node itself, and it is exact: firing column 5 on a fragile surface is that node's
    // whole purpose, so a trigger chain reached any other way (a Counter's count-down continuation) can never
    // match. On top of it we still require the authored break SHAPE - a hidden twin the chain throws - so a
    // fragile surface whose continuation does something other than shatter is not dressed up as a breakable.
    static void ScanCrackedGlass(Dictionary<int, Member> map, SsfSlot[] ES, SsfHeader[] EH, List<SsxInstance> inst)
    {
        for (int i = 0; i < inst.Count; i++)
        {
            var pane = inst[i];
            // The pane is VISIBLE and contact-eligible: you see the glass and you ride onto it. Its zero response
            // mass is not a disqualifier here the way it is for a solid wall - a fragile surface is authored
            // pass-through precisely because its solid twin does the holding.
            if (!pane.Visable || !pane.PlayerCollision) continue;
            int e = pane.EffectSlotIndex;
            if (e < 0 || e >= ES.Length) continue;
            var crack = HeaderCrack(EH, ES[e].CollisionEffectSlot);
            if (crack == null || crack.U1 <= 0f) continue;          // no pool to drain = not a fragile surface
            int te = ES[e].EffectTriggerSlot;
            if (te < 0 || te >= EH.Length) continue;
            var effs = EH[te].Effects;
            if (effs == null) continue;

            var broken = new List<int>();     // the hidden twin the chain THROWS - the shards
            var supports = new List<int>();   // hidden SOLID twins it kills - the collider that was holding you up
            var smashes = new List<int>();    // hidden PASS-THROUGH twins it kills - co-located smash volumes
            float[]? throwParams = null;
            int breakSnd = -1;
            foreach (var n in effs)
            {
                if (n == null) continue;
                if (n.MainType == SsfMainType.PlaySound) { breakSnd = n.SoundPlay; continue; }
                if (n.MainType != SsfMainType.ActOnInstance || n.Instance == null) continue;
                int t = n.Instance.InstanceIndex;
                // Every instance this chain names ships hidden - the shards and the two collision-only twins.
                // A visible target would be some other prop the shatter also drives, which is not this cluster.
                if (t < 0 || t >= inst.Count || inst[t].Visable) continue;
                float[]? twinThrow = HeaderThrow(EH, n.Instance.EffectIndex);
                if (twinThrow != null)
                {
                    if (!broken.Contains(t)) broken.Add(t);
                    throwParams ??= twinThrow;
                }
                else if (HeaderKills(EH, n.Instance.EffectIndex))
                {
                    // Response mass splits the two collision-only twins, and nothing else has to: a solid one is
                    // the support the rider stands on, a pass-through one is a volume that merely fires the break.
                    var list = inst[t].ResponseMass != 0f ? supports : smashes;
                    if (!list.Contains(t)) list.Add(t);
                }
            }
            if (throwParams == null || broken.Count == 0) continue;   // a fragile surface with no authored shatter
            if (map.ContainsKey(i)) continue;                         // already classified another way

            // "brk_" so the cluster rides the established inline-breakable path (PropsBundle divert, PropBuilder's
            // trigger + piece throw). The crack fields on the intact are what tell the importer this one is worn
            // down rather than smashed on contact.
            string cluster = "brk_" + i;
            Set(map, i, cluster, "intact", false, throwParams);
            if (map.TryGetValue(i, out var im))
            {
                im.CrackStrength = crack.U1;
                im.CrackLifetime = crack.U0;
                // The two sounds are different events and both are raw MainType-8 course-bank slots: the collision
                // chain's is the glancing-hit CRACK (65), the trigger chain's is the SMASH (64). Every instance in
                // the sandwich is CollisonSound -1, so dropping either leaves that half of the break mute.
                im.CrackSound = HeaderSound(EH, ES[e].CollisionEffectSlot);
                im.BreakSound = breakSnd;
            }
            foreach (int t in broken) Set(map, t, cluster, "broken", false, throwParams);
            foreach (int t in supports) Set(map, t, cluster, "support", false, null);
            foreach (int t in smashes) Set(map, t, cluster, "smash", false, null);
        }
    }

    // The Sub14 crack payload of the first Cracked node in a header (null if none) - the marker that separates a
    // fragile surface from every other breakable, and the pool/lifetime the importer wears down.
    static SsfCracked? HeaderCrack(SsfHeader[] EH, int hdr)
    {
        if (hdr < 0 || hdr >= EH.Length) return null;
        var effs = EH[hdr].Effects;
        if (effs == null) return null;
        foreach (var n in effs)
            if (n != null && n.MainType == SsfMainType.Property && n.type0 != null
                && n.type0.SubType == SsfType0Sub.Cracked && n.type0.type0Sub14 != null)
                return n.type0.type0Sub14;
        return null;
    }

    // The raw course-bank slot of the first MainType-8 node in a header (-1 if none).
    static int HeaderSound(SsfHeader[] EH, int hdr)
    {
        if (hdr < 0 || hdr >= EH.Length) return -1;
        var effs = EH[hdr].Effects;
        if (effs == null) return -1;
        foreach (var n in effs)
            if (n != null && n.MainType == SsfMainType.PlaySound) return n.SoundPlay;
        return -1;
    }

    // Does this header do nothing but END the instance it is run on? Any DeadNodeMode counts: the megaplex glass
    // kills its collision-only twins with mode 2 where the fences hard-kill with mode 4, and the mode chooses how
    // the node is torn down rather than whether. Used only to tell a killed twin from the dust/spark emitter a
    // break chain also reveals - never as the "is this a break" test, which the caller has already made.
    static bool HeaderKills(SsfHeader[] EH, int hdr)
    {
        if (hdr < 0 || hdr >= EH.Length) return false;
        var effs = EH[hdr].Effects;
        if (effs == null) return false;
        foreach (var n in effs)
            if (n != null && n.MainType == SsfMainType.Property && n.type0 != null
                && n.type0.SubType == SsfType0Sub.DeadNode)
                return true;
        return false;
    }

    // Third pass: SPILL SOURCES - a prop whose collision chain reveals-and-THROWS a hidden twin but does NOT hide
    // itself. A city map's street furniture is the whole class: a garbage can (and, separately, its lid), a news
    // box, a mail box. Hitting one authors TWO responses on the same header - an inline property.roller that topples
    // the prop (Unity docs/016) and an M7 hop to an invisible contents twin (Mdl_Garbage_Letters / Mdl_Mail_Letters)
    // whose own sub-effect is a type0 Sub20 mesh-throw. So the trash/letters fly out while the can rolls away.
    //
    // The main pass above already clusters the thrown twin (the M7 reveal passes its gate), so its pieces are
    // exported and split - but PropsBundle's divert Kind is single-valued and gives the Roller BODY priority, which
    // on its own drops the throw side and leaves the pieces in a cluster with no source to fire them. This pass records the
    // throw side separately, so a knock body can keep its body AND carry the cluster it throws. Deliberately
    // narrow, so an ordinary breakable's own M7 reveal (which the main pass already owns) costs nothing here:
    // the source must be VISIBLE, the target INVISIBLE, the target's own sub-effect must carry a Sub20, and the
    // target must already be a clustered break member. See Unity docs/036.
    static void ScanSpills(Dictionary<int, Member> map, Dictionary<int, string> spills,
                           SsfSlot[] ES, SsfHeader[] EH, List<SsxInstance> inst)
    {
        for (int i = 0; i < inst.Count; i++)
        {
            if (!inst[i].Visable) continue;                 // the thing you HIT is a prop you see
            int e = inst[i].EffectSlotIndex;
            if (e < 0 || e >= ES.Length) continue;
            int ce = ES[e].CollisionEffectSlot;
            if (ce < 0 || ce >= EH.Length) continue;
            var effs = EH[ce].Effects;
            if (effs == null) continue;
            foreach (var n in effs)
            {
                if (n?.MainType != SsfMainType.ActOnInstance || n.Instance == null) continue;
                int t = n.Instance.InstanceIndex;
                if (t < 0 || t >= inst.Count || inst[t].Visable) continue;          // the contents ship invisible
                if (HeaderThrow(EH, n.Instance.EffectIndex) == null) continue;      // ...and the chain THROWS them
                if (!map.TryGetValue(t, out var twin) || twin.ClusterKey.Length == 0) continue;
                if (!spills.ContainsKey(i)) spills[i] = twin.ClusterKey;
                break;
            }
        }
    }

    // Second pass: TRIGGER-DRIVEN breakables (Unity docs/036 §Trigger-driven - e.g. sewer brick walls + a smashable
    // globe sign). The main loop above only follows a VISIBLE prop's OWN collision effect, because on every
    // level studied for Unity docs/028+036 the breakable prop carried its own break chain, and the
    // Visable gate is what keeps the invisible firework/event trigger volumes out. This variant inverts that:
    // the intact prop is a SOLID wall carrying an EMPTY collision effect, and a SEPARATE invisible pass-through
    // TRIGGER volume carries the chain that hides the wall + reveals-and-THROWS its _Junk twin. So scan those
    // invisible pass-through triggers here. To NOT re-admit the firework/event triggers the Visable gate
    // rejects (a Mdl_Trigger_Fireworks topples visible trees + reveals spark/fire emitters), we
    // require the load-bearing break signature: the chain must hide a VISIBLE COLLIDABLE prop (the wall) AND
    // reveal an invisible twin whose own sub-effect is a Sub20 mesh-throw (the shattered geometry that flies).
    // A cinematic/gate trigger has no Sub20 mesh-throw of a hidden twin, so it never matches.
    static void ScanTriggerDriven(Dictionary<int, Member> map, SsfSlot[] ES, SsfHeader[] EH, List<SsxInstance> inst)
    {
        for (int i = 0; i < inst.Count; i++)
        {
            var trg = inst[i];
            if (trg.Visable || !trg.PlayerCollision || trg.ResponseMass != 0f) continue; // an invisible, ride-through contact volume
            int e = trg.EffectSlotIndex;
            if (e < 0 || e >= ES.Length) continue;
            int ce = ES[e].CollisionEffectSlot;
            if (ce < 0 || ce >= EH.Length) continue;
            var effs = EH[ce].Effects;
            if (effs == null) continue;

            int intact = -1;
            var broken = new List<int>();
            float[]? throwParams = null;
            // The SEQUENCED (roll-away) break shape, e.g. the globe sign: [M7 -> Sub256 roll on the source]
            // [Wait 2.71] [SoundPlay 64] [M7 hide source] [M7 reveal+throw twin]. Collect the played clip per
            // target + the chain wait + the raw-slot sound; they only stick if the clip target IS the intact.
            float[]? anim = null; int animTarget = -1;
            float delay = 0f; int breakSnd = -1;
            foreach (var n in effs)
            {
                if (n == null) continue;
                if (n.MainType == SsfMainType.Wait) { delay += n.WaitTime; continue; }
                if (n.MainType == SsfMainType.PlaySound) { breakSnd = n.SoundPlay; continue; }
                if (n.MainType != SsfMainType.ActOnInstance || n.Instance == null) continue;
                int t = n.Instance.InstanceIndex;
                if (t < 0 || t >= inst.Count) continue;
                float[]? twinThrow = HeaderThrow(EH, n.Instance.EffectIndex);
                if (anim == null)
                {
                    float[]? played = HeaderAnim(EH, n.Instance.EffectIndex);
                    if (played != null) { anim = played; animTarget = t; }
                }
                if (twinThrow != null && !inst[t].Visable)              // a revealed twin the chain THROWS = broken pieces
                {
                    if (!broken.Contains(t)) broken.Add(t);
                    throwParams ??= twinThrow;
                }
                else if (inst[t].Visable && inst[t].PlayerCollision && intact < 0)   // the solid wall it hides
                    intact = t;
                // an invisible target with no Sub20 (the dust/spark emitter the chain also fires) is neither role
            }
            if (intact < 0 || throwParams == null || broken.Count == 0) continue;   // gate/train/cinematic - not a break
            if (map.ContainsKey(intact)) continue;                                  // already classified another way

            // Cluster "brk_" so it flows through the inline-breakable path: PropsBundle diverts the wall out of the
            // merged static mesh, CollisionBundle SKIPS it (BundleExporter's brk_ breakSet) so you smash through
            // instead of bouncing, and PropBuilder builds a pass-through trigger over the wall + throws the twin.
            string cluster = "brk_" + intact;
            Set(map, intact, cluster, "intact", false, throwParams);
            if (map.TryGetValue(intact, out var im))
            {
                // The chain's raw-slot crash is the break's own sound (the glass panes' SoundPlay 64, the sewer
                // walls' 43) whether or not the break is sequenced - the intact prop itself is authored silent
                // (CollisonSound -1), so dropping this leaves the smash mute.
                im.BreakSound = breakSnd;
                // Roll-away: the chain plays the SOURCE's own clip before the swap. A clip played on some OTHER
                // instance (a cinematic side-effect) is not the source rolling and does not delay the break.
                if (anim != null && animTarget == intact) { im.Anim = anim; im.BreakDelay = delay; }
            }
            foreach (int t in broken) Set(map, t, cluster, "broken", false, throwParams);
        }
    }

    // The AnimObject/AnimDelta payload [U0..U7] of the first type0 Sub256/257 node in a header (null if none).
    // An M7 that plays this on the break SOURCE = the roll-away clip (the globe rolling down the street).
    static float[]? HeaderAnim(SsfHeader[] EH, int hdr)
    {
        if (hdr < 0 || hdr >= EH.Length) return null;
        var effs = EH[hdr].Effects;
        if (effs == null) return null;
        foreach (var n in effs)
        {
            if (n == null || n.MainType != SsfMainType.Property) continue;
            var s = n.type0?.type0Sub256 ?? n.type0?.type0Sub257;
            if (s != null) return new[] { s.U0, s.U1, s.U2, s.U3, s.U4, s.U5, s.U6, s.U7 };
        }
        return null;
    }

    // The Sub20 mesh-throw params of the first type0 Sub20 node in a header (null if none). Used to tell a
    // thrown _Junk twin (the broken pieces fly) from the dust/spark emitter a break chain also reveals.
    static float[]? HeaderThrow(SsfHeader[] EH, int hdr)
    {
        if (hdr < 0 || hdr >= EH.Length) return null;
        var effs = EH[hdr].Effects;
        if (effs == null) return null;
        foreach (var n in effs)
            if (n != null && n.MainType == SsfMainType.Property && n.type0 != null
                && n.type0.SubType == SsfType0Sub.MeshAnim && n.type0.type0Sub20 != null)
            {
                return ThrowArray(n.type0.type0Sub20);
            }
        return null;
    }

    static void Set(Dictionary<int, Member> map, int idx, string cluster, string role, bool debris, float[]? throwParams)
    {
        if (idx < 0 || map.ContainsKey(idx)) return;   // first classification wins (a twin shared across slots is rare)
        map[idx] = new Member { ClusterKey = cluster, Role = role, IsDebris = debris, Throw = throwParams };
    }

    // Walk one collision-effect header: top-level type0 break actions mark the SOURCE (depth 0 only);
    // MainType-7 nodes name a target whose CURRENT visibility decides hide(visible)/reveal(invisible). Follow each
    // M7's per-target effect one level (cycle-/depth-guarded) - that's where the twin's Sub20 piece-throw
    // lives (e.g. hole cover: source hides + M7 reveals the _Junk twin, whose own effect throws its boards).
    // MainType-21 "run function" nodes (the LCD BreakLogo dispatch) are handled separately by FunctionRoles.
    static void Walk(SsfHeader[] EH, int hdr, List<SsxInstance> inst,
                     ref bool hideSelf, ref float[]? throwParams, List<int> reveals, List<int> hides, int depth)
    {
        if (hdr < 0 || hdr >= EH.Length || depth > 3) return;
        var effs = EH[hdr].Effects;
        if (effs == null) return;
        foreach (var n in effs)
        {
            if (n == null) continue;
            if (n.MainType == SsfMainType.Property && depth == 0 && n.type0 != null && IsBreakAction(n.type0))
                hideSelf = true;
            if (n.MainType == SsfMainType.Property && n.type0 != null && n.type0.SubType == SsfType0Sub.MeshAnim && n.type0.type0Sub20 != null && throwParams == null)
            {
                throwParams = ThrowArray(n.type0.type0Sub20);
            }
            else if (n.MainType == SsfMainType.ActOnInstance && n.Instance != null)
            {
                int t = n.Instance.InstanceIndex;
                bool vis = t >= 0 && t < inst.Count && inst[t].Visable;
                var list = vis ? hides : reveals;
                if (!list.Contains(t)) list.Add(t);
                if (n.Instance.EffectIndex >= 0) Walk(EH, n.Instance.EffectIndex, inst, ref hideSelf, ref throwParams, reveals, hides, depth + 1);
            }
        }
    }

    // LCD-logo break path: a collision header whose only action is a MainType-21 "run function" node (the engine's
    // BreakLogo* dispatch). Read the named function's MainType-7 nodes for the intact/broken/scanline roles - a
    // visible target is hidden on break (the source screen + its scanline overlay), an invisible target is revealed
    // (the pre-placed broken twin) - the exact hide/reveal vocabulary Walk derives for inline breakables. Sets
    // viaFunction so the caller namespaces the cluster "lcd_". Roles ONLY: we do NOT recurse into each M7 target's
    // sub-effect (where the twin's authored Sub20 mesh-throw lives), because the original LCD break is a screen-vanish
    // + shard burst, not a piece-throw - so the LCD cluster's Throw stays null (Unity docs/028).
    static void FunctionRoles(SsfHeader[] EH, SsfFunction[]? FN, int hdr, List<SsxInstance> inst,
                              List<int> reveals, List<int> hides, ref bool viaFunction)
    {
        if (FN == null || hdr < 0 || hdr >= EH.Length) return;
        var effs = EH[hdr].Effects;
        if (effs == null) return;
        foreach (var n in effs)
        {
            if (n == null || n.MainType != SsfMainType.CallFunction) continue;
            int fi = n.FunctionRunIndex;
            if (fi < 0 || fi >= FN.Length) continue;
            var feffs = FN[fi].Effects;
            if (feffs == null) continue;
            viaFunction = true;
            foreach (var fn in feffs)
            {
                if (fn == null || fn.MainType != SsfMainType.ActOnInstance || fn.Instance == null) continue;
                int t = fn.Instance.InstanceIndex;
                if (t < 0 || t >= inst.Count) continue;
                var list = inst[t].Visable ? hides : reveals;
                if (!list.Contains(t)) list.Add(t);
            }
        }
    }

    // The RGB tint of the first top-level type2Sub0 particle emitter in a collision-effect header. The SSF's
    // first colour stop is raw A,R,G,B at U33..U36, hence RGB = U34/U35/U36. Null if the header has none - the
    // marker that separates a star-burst prop (balloon) from a shard breakable.
    static float[]? FirstBurstColor(SsfHeader[] EH, int hdr)
    {
        if (hdr < 0 || hdr >= EH.Length) return null;
        var effs = EH[hdr].Effects;
        if (effs == null) return null;
        foreach (var n in effs)
        {
            if (n == null || n.MainType != SsfMainType.Emitter || n.type2 == null || n.type2.SubType != SsfType2Sub.Emitter || n.type2.type2Sub0 == null) continue;
            var e = n.type2.type2Sub0;
            return e.FirstColorRgb();
        }
        return null;
    }

    // Build the 10-float throw record [U0..U9], reinterpreting the u32-stored authored direction (U3/U4/U5) as
    // the f32 it really is (bits -> float; 0 -> 0.0, so the collision-direction fallback is preserved).
    static float[] ThrowArray(SsfSub20 s) => new[]
    {
        s.U0, s.U1, s.U2,
        BitConverter.Int32BitsToSingle((int)s.U3), BitConverter.Int32BitsToSingle((int)s.U4), BitConverter.Int32BitsToSingle((int)s.U5),
        s.U6, s.U7, s.U8, s.U9,
    };
}
