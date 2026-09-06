using Newtonsoft.Json.Linq;
using Snowknife.Formats;
using Snowknife.Services;

namespace Snowknife.Repack;

/// <summary>
/// Decide which course-bank SLOT each custom prop sound lands in, for the level it is actually being packed
/// into.
///
/// Slopesmith hands a custom clip one of eight reserved event ids, and for an export that does not yet know
/// its disc that is the right thing: the id is stable, unique and level-agnostic. It is the wrong thing for a
/// BANK. A rebuilt course bank must not exceed the size the level shipped with — over that line the ISO
/// builds, the ADL is right, the engine allocates voices at correct gain and position, and no sound arrives
/// [Trailmap: 260-bank-budget] — and those eight ids resolve, on every level tried, to slots the bank leaves
/// EMPTY. An empty slot charges a clip full price. A slot the bank already ships hands its own bytes back.
///
/// So the export's ids are read as identities rather than destinations, and re-pointed here, where the bank
/// is in hand and the built level is known. A candidate slot has to be one the bank ships and that nothing in
/// the built level still reaches:
///
///   - no surviving instance's collision sound or placed emitter resolves to it. `--bare-slot` hides the
///     donor's props but not the StageArea markers, and never the authored ones;
///   - no MainType-8 PlaySound node names it. Those carry a course-bank slot DIRECTLY rather than an event,
///     so the event table cannot see them — GARI's own logic plays slot 082 from 61 nodes, and taking that
///     slot for a custom clip would swap the sound those nodes make with no warning anywhere;
///   - its sample run is not SHARED with another slot. Shipped banks point two headers at one run (garibaldi1
///     50 and 51), and replacing one of a shared pair reclaims nothing at all, so such a slot scores zero
///     rather than its apparent size — an estimate that over-promises here spends a budget that does not
///     exist.
///
/// The hit-gated ids are never re-pointed. The engine's interactive class is three literal compares against
/// 16/28/57, so moving a clip off one silently un-gates it [Trailmap: 420-interactive-ambient] — that is a
/// change of behaviour, not of address, and no byte saving is worth it.
///
/// Slot 64 is worth naming on its own. All ten course banks carry the SAME 2.17 s stereo glass smash there,
/// and event 63 — the LCD screens, the windows, the skylights, the breakable shortcut covers — is the only id
/// that reaches it on any mountain [Trailmap: 260-slot-64]. A level that still ships one of those props
/// reserves the slot by the first rule above and it is never offered; a `--bare-slot` build ships none, and
/// then it is the largest single reclaim a course bank has to give at 54,688 bytes. It goes to hit sounds and
/// never to emitters.
/// </summary>
internal static class CustomSoundRouting
{
    /// <summary>Engine-fixed hit-gated ids. A clip on one of these carries its gating IN the id, so it is
    /// pinned wherever it lands [Trailmap: 420-interactive-ambient].</summary>
    private static readonly HashSet<int> HitGatedEvents = new() { 16, 28, 57 };

    /// <summary>
    /// The ordinary group-2 ids retail itself places as a CONTINUING EMITTER — the floodlight hum and two on
    /// Megaplex — counted over 555 shipped `ExternalSounds` records across all eight mountains.
    ///
    /// Recorded, and deliberately NOT used to restrict anything. A list like this looks like the fix for
    /// level loads that freeze at frame 0 whenever a bed lands somewhere new — first slot 064, then slot
    /// 052 — but every one of those beds carried a MALFORMED loop: one wrap frame where retail leaves two,
    /// and a declared length stopping part way into a frame [Trailmap: 260-psadpcm-loop]. A bad loop marker
    /// is independently known to freeze the EE during level load [Trailmap: 260-psadpcm-loopmark]. The slot
    /// was never the variable; the encoding was.
    ///
    /// With the encoding correct, slot 052 — the one that hung hardest — loads fast and sustains. So an emitter
    /// takes any slot the bank ships, and the only slot rule left is the multi-channel refusal in
    /// `Candidates`, which is where the one still-unexplained cliff sits.
    /// </summary>
    private static readonly HashSet<int> RetailEmitterEvents = new() { 68, 149, 151 };

    /// <summary>
    /// Slots that hold a sustaining loop correctly and make the console run at HALF SPEED while they do.
    ///
    /// garibaldi1 slot 083 is the only one found so far, and it is worth the ugliness of a hard-coded list
    /// because routing would otherwise pick it every time: it is the fattest mono slot in the bank, so the
    /// biggest ambient bed lands there by default and every GARI build with one pays the cost.
    ///
    /// Measured as wall-clock from launch to the rider being at the gate, PCSX2, `--bare-slot`, against an
    /// untouched retail disc at 51.4 / 51.7 s. A bed in slot 083 took 87.9 / 90.7 / 91.1 / 95.3 s; the same
    /// bed in slots 010, 052 and 081 took 50.6-56.2 s across ten runs. It is not the size of the write —
    /// a clip that SHRINKS 083 and one that GROWS it are both slow, and clips that shrink and grow slot 052
    /// are both fast. The GAME is not doing more work either: every run reaches the gate at frame 307-328,
    /// so the same frames simply take longer to emulate.
    ///
    /// Mechanism [open], and one confound is worth naming: on GARI only event 26 reaches slot 083, so
    /// "the slot" and "the id" cannot be told apart here and separating them needs another mountain. The
    /// list is keyed by BANK and slot rather than by event id, which is the narrower of the two guesses —
    /// it costs one level one slot rather than every level one id.
    /// </summary>
    private static readonly Dictionary<string, HashSet<int>> SlowSustainSlots =
        new(StringComparer.OrdinalIgnoreCase) { ["garibaldi1"] = new() { 83 } };

    internal sealed record Choice(string Wav, int FromEvent, int ToEvent, int FromSlot, int ToSlot,
                                  int Cost, int Reclaimed)
    {
        /// <summary>What this move does to the rebuilt bank's size, in bytes — negative is smaller.</summary>
        public int Delta => Cost - Reclaimed;
    }

    /// <summary>
    /// Re-point the export's reserved custom-sound events onto slots this level's own bank already ships,
    /// rewriting the work instances so the regenerated ADL agrees. Returns the remap the bank injection then
    /// resolves its clips through — empty when there is nothing to gain or nothing safe to take.
    /// </summary>
    /// <param name="donorInstances">How many rows at the head of the work instances came from the DONOR. The
    /// remap is applied only past that mark: a retail prop that happens to carry a reserved id is a reason to
    /// move the AUTHORED clip off it, never a row to rewrite.</param>
    public static Dictionary<int, int> Apply(IsoService iso, string outIso, string level, string customDir,
                                             string workDir, string tmp, int donorInstances, int soundRate)
    {
        var empty = new Dictionary<int, int>();
        string fxPath = Path.Combine(customDir, "Effects.json");
        if (!File.Exists(fxPath)) return empty;
        JObject doc;
        // Routing declining is not itself a loss — the export's own ids still work — but the same file is
        // about to be re-read by the injection, which will lose every authored clip over it. Warn once, here,
        // where it is first noticed.
        try { doc = JObject.Parse(File.ReadAllText(fxPath)); }
        catch (Exception e)
        {
            Log.Warn($"  WARN: {fxPath} could not be read ({e.Message}) — custom-sound routing is "
                + "skipped, and the injection that follows will have nothing to place.");
            return empty;
        }
        var customEventJoin = doc["extensions"]?["slopesmith"]?["customSoundEvents"] as JObject;
        if (customEventJoin == null || !customEventJoin.Properties().Any()) return empty;

        SoundIndexDocument soundIndex;
        BnkFile bank;
        try
        {
            soundIndex = new SoundIndexService(iso).Extract(outIso, level, tmp, write: false);
            if (soundIndex.CourseBank == null) return empty;
            string audioBigPath = Path.Combine(tmp, "AUDIO.BIG");
            // Extracted ONCE for the repack: CourseBankInject reads the same path later and leaves it alone
            // if it is already here, so the routing decision and the injection see identical bytes.
            if (!File.Exists(audioBigPath)) iso.ExtractFile(outIso, @"DATA\AUDIO\AUDIO.BIG", audioBigPath);
            var archive = BigfArchive.Load(File.ReadAllBytes(audioBigPath));
            var member = archive.Members.FirstOrDefault(m =>
                BigfPaths.FileNameWithoutExtension(m.Path).Equals(soundIndex.CourseBank, StringComparison.OrdinalIgnoreCase));
            if (member == null) return empty;
            bank = BnkFile.Load(member.Data);
        }
        catch (Exception e)
        {
            Log.Warn($"  WARN: custom-sound routing could not read the target bank ({e.Message}) — "
                + "the export's reserved event ids are kept.");
            return empty;
        }

        int targetRate = soundRate > 0 ? soundRate : CourseBankInject.ModalRate(bank);
        var customs = new List<(int Event, string Wav, int Cost)>();
        foreach (var property in customEventJoin.Properties())
        {
            if (!int.TryParse(property.Name, out int eventId)) continue;
            if ((string?)property.Value is not { Length: > 0 } wav) continue;
            string wavPath = Path.Combine(customDir, "Sounds", wav);
            if (!File.Exists(wavPath)) continue;
            try
            {
                var (samples, rate) = CourseBankInject.ReadWavPcm16Mono(File.ReadAllBytes(wavPath));
                long converted = targetRate > 0 && rate != targetRate
                    ? (long)Math.Ceiling(samples.Length * (double)targetRate / rate) : samples.Length;
                customs.Add((eventId, wav, (int)((converted + 27) / 28 * 16)));
            }
            catch { /* the injection reports an unreadable clip; routing simply cannot bid for it */ }
        }
        if (customs.Count == 0) return empty;

        // Which of these clips a prop CARRIES AS A CONTINUING EMITTER rather than as a hit. The two are
        // routed out of different pools, so this is not cosmetic — see RetailEmitterEvents.
        var emitterEvents = new HashSet<int>();
        foreach (var property in (doc["extensions"]?["slopesmith"]?["ambientSounds"] as JObject)?.Properties()
                                 ?? Enumerable.Empty<JProperty>())
            if ((property.Value as JObject)?["event"] is { Type: JTokenType.Integer } eventToken)
                emitterEvents.Add((int)eventToken);

        var reserved = ReservedSlots(workDir, donorInstances, customs.Select(c => c.Event).ToHashSet(), soundIndex);
        var choices = Choose(customs, bank, soundIndex, reserved, emitterEvents);
        if (choices.Count == 0) return empty;

        // Will the injection actually happen? Routing rewrites the instances and the ADL is regenerated from
        // them, both LONG before the bank is built and weighed — so if the budget then refuses, the retail
        // bank ships with the authored props still pointing at the events they were re-pointed onto. They do
        // not fall silent; they play whatever RETAIL put in those slots. Measured on a refused build: an
        // authored foghorn prop sounded garibaldi1's own glass smash, because that is what slot 64 ships.
        //
        // Best case is exactly computable, which is what makes this a refusal rather than a guess: every
        // donor fill can be shed, so the smallest bank the injection can reach is the shipped size, less what
        // the chosen slots hand back, plus what the clips cost. If THAT is over, the injection is certain to
        // refuse and the only honest thing routing can do is leave the export's own ids alone — an unplaced
        // clip on its reserved id resolves to an empty slot, which is silence.
        int overBy = ProjectedDelta(customs, bank, soundIndex, choices);
        if (overBy > 0)
        {
            Log.Warn($"  WARN: the custom clips cost {overBy:N0} bytes more than even the best slots "
                + $"in {soundIndex.CourseBank}.bnk can hand back, so the injection below will refuse them. "
                + "Leaving the export's own event ids in place — re-pointing them would leave these props "
                + "playing the RETAIL sounds of the slots they were moved onto. Shorten the longest clips.");
            return empty;
        }

        var remap = choices.ToDictionary(c => c.FromEvent, c => c.ToEvent);
        int rewritten = RewriteInstances(Path.Combine(workDir, "Instances.json"), remap, donorInstances);
        if (rewritten == 0)
        {
            Log.Warn("  WARN: custom-sound routing found better slots but no authored instance carried "
                + "the events — the export's reserved ids are kept.");
            return empty;
        }
        foreach (var choice in choices)
            Log.Info($"  custom sound \"{choice.Wav}\" routed to event {choice.ToEvent} "
                + $"(slot {choice.ToSlot:D3}, which {soundIndex.CourseBank} already ships) instead of "
                + $"event {choice.FromEvent} "
                + (choice.FromSlot < 0 ? "(which maps to no course-bank slot)" : $"(slot {choice.FromSlot:D3})")
                + $" — {choice.Reclaimed:N0} bytes reclaimed against {choice.Cost:N0} spent.");
        Log.Info($"  custom-sound routing: {choices.Count} clip(s) re-pointed across {rewritten} "
            + $"authored sound field(s), {-choices.Sum(c => c.Delta):N0} bytes off the bank.");
        return remap;
    }

    /// <summary>
    /// The pairing itself: biggest clip onto the biggest slot it can reclaim, and no move that does not pay.
    ///
    /// Greedy in descending cost is optimal for what is being minimised here — the total is
    /// Σ(cost) − Σ(reclaimed) and the costs are fixed, so only the reclaimed sum is in play and every clip
    /// reclaims a slot's whole size whatever its own. Pairing large with large is therefore not a heuristic;
    /// it just keeps the biggest reclaims from being spent on clips that would have taken them anyway.
    /// </summary>
    internal static List<Choice> Choose(IReadOnlyList<(int Event, string Wav, int Cost)> customs,
                                        BnkFile bank, SoundIndexDocument soundIndex,
                                        IReadOnlyCollection<int> reservedSlots,
                                        IReadOnlyCollection<int> emitterEvents)
    {
        var shared = SharedRuns(bank);
        int Reclaimable(int slot) => ReclaimableBytes(bank, shared, slot);

        // In a course bank this is slot 64 and only slot 64: the shared stereo glass smash. See
        // RetailEmitterEvents for why an EMITTER may not have it, and why a hit sound may.
        bool MultiChannel(int slot) =>
            slot >= 0 && slot < bank.Slots.Count && bank.Slots[slot]?.ChannelData.Count > 1;

        int SlotOf(int eventId) =>
            soundIndex.CollisionEvents.TryGetValue(eventId, out SoundIndexEvent? route) && route.Group == 2
                ? route.Slot : -1;

        var slowSustain = SlowSustainSlots.TryGetValue(soundIndex.CourseBank ?? "", out var slow)
            ? slow : new HashSet<int>();

        var takenSlots = new HashSet<int>(reservedSlots);
        // A clip's own destination is not for sale to another clip. The reserved ids usually resolve to slots
        // the bank leaves empty, which score zero and are never offered anyway — but a level that SHIPS one of
        // them (Megaplex carries sounds on 148-151) made the slot look like an ordinary reclaim, and routing
        // would hand clip A the event clip B was still sitting on. Both then resolve to one slot and the
        // injection writes whichever it reaches last, so A's props play B's sound with nothing logged.
        var customEvents = customs.Select(custom => custom.Event).ToHashSet();
        foreach (int slot in customEvents.Select(SlotOf).Where(slot => slot >= 0)) takenSlots.Add(slot);

        List<(int Slot, int Event, int Bytes)> Candidates(bool emitter) => soundIndex.CollisionEvents
            .Where(pair => pair.Value.Group == 2 && !HitGatedEvents.Contains(pair.Key)
                           && !customEvents.Contains(pair.Key))
            .GroupBy(pair => pair.Value.Slot)
            .Where(group => !takenSlots.Contains(group.Key) && Reclaimable(group.Key) > 0
                            && !(emitter && MultiChannel(group.Key))
                            && !(emitter && slowSustain.Contains(group.Key)))
            // One candidate per slot — the lowest event id reaching it, so a rebuild of the same export
            // against the same disc picks the same id every time.
            .Select(group => (Slot: group.Key, Event: group.Min(pair => pair.Key), Bytes: Reclaimable(group.Key)))
            .OrderByDescending(candidate => candidate.Bytes).ThenBy(candidate => candidate.Slot)
            .ToList();

        var choices = new List<Choice>();
        // Emitters bid FIRST, out of the narrow retail-proven set, so an ordinary hit sound cannot take the
        // one slot a loop is allowed to have. In practice the two pools rarely collide: the ids retail
        // sustains land on slots most banks leave empty, which is why an emitter usually stays where the
        // export put it and the budget is met out of the one-shots.
        foreach (bool emitter in new[] { true, false })
        {
            var candidates = Candidates(emitter);
            int next = 0;
            foreach (var custom in customs
                         .Where(c => !HitGatedEvents.Contains(c.Event)
                                     && emitterEvents.Contains(c.Event) == emitter)
                         .OrderByDescending(c => c.Cost).ThenBy(c => c.Event))
            {
                if (next >= candidates.Count) break;
                int fromSlot = SlotOf(custom.Event);
                var candidate = candidates[next];
                // Only a move that pays. A clip the author already pointed at a fat shipped slot is left
                // alone, and so is one whose own slot is worth more than anything still free.
                if (candidate.Bytes <= Reclaimable(fromSlot)) continue;
                next++;
                takenSlots.Add(candidate.Slot);
                choices.Add(new Choice(custom.Wav, custom.Event, candidate.Event, fromSlot, candidate.Slot,
                                       custom.Cost, candidate.Bytes));
            }
        }
        return choices.OrderBy(choice => choice.FromEvent).ToList();
    }

    /// <summary>Sample runs more than one slot header points at. Shipped banks do this (garibaldi1 50 and 51),
    /// and overwriting one of a pair hands back nothing at all.</summary>
    private static HashSet<string> SharedRuns(BnkFile bank)
    {
        var shared = new HashSet<string>();
        var seen = new HashSet<string>();
        foreach (var sound in bank.Slots)
            foreach (byte[] run in sound?.ChannelData ?? new List<byte[]>())
                if (!seen.Add(RunKey(run))) shared.Add(RunKey(run));
        return shared;
    }

    /// <summary>What overwriting this slot actually gives back — its whole size, or nothing when its run is
    /// shared with another slot.</summary>
    private static int ReclaimableBytes(BnkFile bank, HashSet<string> shared, int slot)
    {
        var sound = slot >= 0 && slot < bank.Slots.Count ? bank.Slots[slot] : null;
        if (sound == null) return 0;
        return sound.ChannelData.Any(run => shared.Contains(RunKey(run)))
            ? 0 : sound.ChannelData.Sum(run => run.Length);
    }

    /// <summary>
    /// How far over its own shipped size the rebuilt bank must end up, at BEST — positive means the injection
    /// is certain to refuse it.
    ///
    /// Exact rather than estimated, which is what lets `Apply` act on it: the injection sheds every donor fill
    /// before it gives up, so the smallest bank it can reach is the shipped one less what each clip's landing
    /// slot hands back, plus what the clips cost.
    /// </summary>
    internal static int ProjectedDelta(IReadOnlyList<(int Event, string Wav, int Cost)> customs,
                                       BnkFile bank, SoundIndexDocument soundIndex,
                                       IReadOnlyList<Choice> choices)
    {
        var shared = SharedRuns(bank);
        int delta = 0;
        foreach (var custom in customs)
            delta += custom.Cost - ReclaimableBytes(bank, shared, LandingSlot(custom.Event, soundIndex, choices));
        return delta;
    }

    /// <summary>The course-bank slot a clip will actually be written into: the one routing chose for it, or
    /// the one its own exported event resolves to when nothing was chosen.</summary>
    internal static int LandingSlot(int eventId, SoundIndexDocument soundIndex, IReadOnlyList<Choice> choices)
    {
        foreach (var choice in choices)
            if (choice.FromEvent == eventId) return choice.ToSlot;
        return soundIndex.CollisionEvents.TryGetValue(eventId, out SoundIndexEvent? route) && route.Group == 2
            ? route.Slot : -1;
    }

    private static string RunKey(byte[] run) =>
        Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(run));

    /// <summary>
    /// Every course-bank slot the BUILT level still reaches by some route other than the custom clips being
    /// placed: retail and authored collision sounds, retail and authored placed emitters, and the MainType-8
    /// PlaySound nodes that name a slot with no event in between.
    ///
    /// Read off the work directory rather than the export, because that is the level as it will ship — a prop
    /// `--bare-slot` hid reaches nothing, and an authored prop the export added does.
    /// </summary>
    internal static HashSet<int> ReservedSlots(string workDir, int donorInstances, HashSet<int> customEvents,
                                               SoundIndexDocument soundIndex)
    {
        var reserved = new HashSet<int>();
        void Reserve(JToken? raw, bool authored)
        {
            if (raw is not { Type: JTokenType.Integer }) return;
            int eventId = (int)raw;
            // An authored prop's OWN custom event is the thing being moved, so it does not pin its slot. A
            // donor prop carrying the same id is a different matter entirely: it keeps its sound, which is
            // exactly why the clip should move off that slot rather than onto it.
            if (authored && customEvents.Contains(eventId)) return;
            if (soundIndex.CollisionEvents.TryGetValue(eventId, out SoundIndexEvent? route) && route.Group == 2)
                reserved.Add(route.Slot);
        }
        try
        {
            string instancesPath = Path.Combine(workDir, "Instances.json");
            if (File.Exists(instancesPath))
            {
                var rows = JObject.Parse(File.ReadAllText(instancesPath))["Instances"] as JArray ?? new JArray();
                for (int i = 0; i < rows.Count; i++)
                {
                    if (rows[i] is not JObject instance) continue;
                    if ((bool?)instance["IncludeSound"] == false) continue;
                    bool authored = i >= donorInstances;
                    Reserve((instance["Sounds"] as JObject)?["CollisonSound"], authored);
                    foreach (var emitter in (instance["Sounds"] as JObject)?["ExternalSounds"] as JArray ?? new JArray())
                        Reserve((emitter as JObject)?["SoundIndex"], authored);
                }
            }
            string logicPath = Path.Combine(workDir, "SSFLogic.json");
            if (File.Exists(logicPath))
                foreach (int slot in PlaySoundSlots(JObject.Parse(File.ReadAllText(logicPath))))
                    reserved.Add(slot);
        }
        catch { /* a reservation we cannot read is one we must assume: fall through with what was gathered */ }
        return reserved;
    }

    /// <summary>Course-bank slots named directly by MainType-8 nodes anywhere in a level's effect logic.</summary>
    internal static IEnumerable<int> PlaySoundSlots(JToken? token)
    {
        if (token is JObject node)
        {
            if ((int?)node["MainType"] == 8 && (int?)node["SoundPlay"] is { } slot) yield return slot;
            foreach (var child in node.Properties())
                foreach (int found in PlaySoundSlots(child.Value)) yield return found;
        }
        else if (token is JArray array)
            foreach (var child in array)
                foreach (int found in PlaySoundSlots(child)) yield return found;
    }

    /// <summary>Point the authored instances' sound fields at the re-routed events. Returns how many fields
    /// moved, which is the check that the remap reached the rows the ADL is about to be built from.</summary>
    internal static int RewriteInstances(string instancesPath, IReadOnlyDictionary<int, int> remap, int fromIndex)
    {
        if (remap.Count == 0 || !File.Exists(instancesPath)) return 0;
        var root = JObject.Parse(File.ReadAllText(instancesPath));
        var rows = root["Instances"] as JArray ?? new JArray();
        int rewritten = 0;
        for (int i = Math.Max(0, fromIndex); i < rows.Count; i++)
        {
            if (rows[i] is not JObject instance || instance["Sounds"] is not JObject sounds) continue;
            if (sounds["CollisonSound"] is { Type: JTokenType.Integer } hit
                && remap.TryGetValue((int)hit, out int movedHit))
            { sounds["CollisonSound"] = movedHit; rewritten++; }
            foreach (var emitter in (sounds["ExternalSounds"] as JArray ?? new JArray()).OfType<JObject>())
                if (emitter["SoundIndex"] is { Type: JTokenType.Integer } id
                    && remap.TryGetValue((int)id, out int movedEmitter))
                { emitter["SoundIndex"] = movedEmitter; rewritten++; }
        }
        if (rewritten > 0) File.WriteAllText(instancesPath, root.ToString());
        return rewritten;
    }
}
