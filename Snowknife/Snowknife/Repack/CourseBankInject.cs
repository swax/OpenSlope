using Newtonsoft.Json.Linq;
using Snowknife.Formats;
using Snowknife.Services;

namespace Snowknife.Repack;

/// <summary>
/// Repack step that makes authored hit sounds RELIABLE on the target level by rebuilding its course sound
/// bank inside DATA\AUDIO\AUDIO.BIG [Trailmap: 260-audio-files, 420-audio-runtime]:
///
///  - DONOR FILL — an authored prop's collision-sound event id resolves to a course-bank slot with a fixed
///    global meaning, but each level's bank ships only the subset it uses and the engine has no empty-slot
///    fallback. Every slot the export's `collisionSounds` join needs that the target bank leaves empty is
///    copied verbatim (raw PS-ADPCM frames, no re-encode) from the first sibling course bank that ships it.
///  - CUSTOM SOUNDS — `customSoundEvents` carries reserved event id → WAV for prop channels, resolved here
///    against the target ISO; `customSounds` carries direct PlaySound slot → WAV. Each is PS-ADPCM-encoded
///    into the resulting slot, overwriting whatever the bank shipped there (a conflict check warns when the
///    target level's own instances reference an overridden slot).
///
/// AUDIO.BIG is a BIGF archive with RAW members (verified: BNKl bytes at the member offsets, no RefPack), so
/// the rebuild is a verbatim member round-trip with one member replaced — BigfArchive reproduces the retail
/// layout exactly (size field = headerSize + Σ member sizes, members 128-aligned in table order). The ISO
/// write rides IsoService.ReplaceFile, whose relocate branch absorbs the growth.
/// </summary>
internal static class CourseBankInject
{
    /// <summary>Fallback rate when a target bank declares none of its own. Retail's own ceiling; nothing
    /// should reach it, because a bank with sounds in it says what it is played at.</summary>
    public const int RetailSoundRate = 22050;

    /// <param name="soundRate">Convert every custom clip to this rate; 0 takes the target bank's own, which
    /// is what the engine plays it at whatever the clip's tag says.</param>
    /// <param name="eventRemap">Where <see cref="CustomSoundRouting"/> re-pointed the export's reserved event
    /// ids for this level. The work instances were rewritten with the same map before the ADL was
    /// regenerated, so resolving clips through it here is what keeps the shipped rows and the encoded slots
    /// talking about the same sound.</param>
    public static void Apply(IsoService iso, string outIso, string level, string customDir, string workDir,
                             string tmp, int soundRate = 0, IReadOnlyDictionary<int, int>? eventRemap = null)
    {
        int Routed(int eventId) =>
            eventRemap != null && eventRemap.TryGetValue(eventId, out int moved) ? moved : eventId;
        string fxPath = Path.Combine(customDir, "Effects.json");
        if (!File.Exists(fxPath)) return;
        JObject doc;
        // An unreadable Effects.json means every authored sound is about to be left out of the disc, and
        // silence is the one symptom this whole subsystem is bad at telling apart from a dozen other causes.
        // Say so where every other degradation says so, rather than returning as if there were nothing here.
        try { doc = JObject.Parse(File.ReadAllText(fxPath)); }
        catch (Exception e)
        {
            Log.Warn($"  WARN: {fxPath} could not be read ({e.Message}) — the export's custom sounds "
                + "are NOT injected and the retail banks ship unchanged.");
            return;
        }
        var ext = doc["extensions"]?["slopesmith"] as JObject;
        var customJoin = ext?["customSounds"] as JObject;
        var customEventJoin = ext?["customSoundEvents"] as JObject;
        var collisionJoin = ext?["collisionSounds"] as JObject;
        var soundIndexes = new SoundIndexService(iso);
        SoundIndexDocument soundIndex = soundIndexes.Extract(outIso, level, tmp, write: false);
        DiscSoundBanks discBanks = soundIndexes.ReadBanks(outIso, level);

        // Which authored events drive a CONTINUING emitter rather than a one-shot. The slot behind one has to
        // be encoded with a loop region or the SPU stops the voice at the end of the sample and the emitter is
        // simply never heard — retail's own hit-gated slots all carry one [Trailmap: 420-audio-runtime].
        var emitterEvents = new HashSet<int>();
        foreach (var property in (ext?["ambientSounds"] as JObject)?.Properties() ?? Enumerable.Empty<JProperty>())
            if ((property.Value as JObject)?["event"] is { Type: JTokenType.Integer } eventToken)
                emitterEvents.Add(Routed((int)eventToken));

        var custom = new Dictionary<int, string>();
        var loopingSlots = new HashSet<int>();
        // What the DISC ends up carrying, written out beside it. Since routing moves a clip off the event id
        // the export gave it, "which event is my sound on" stops being answerable from the export alone — and
        // it is the question both an author and the audio probe have to ask, the latter because the engine's
        // voice pool reports event ids and nothing else [Trailmap: 420-audio-runtime].
        var shipped = new JArray();
        if (customJoin != null)
            foreach (var property in customJoin.Properties())
                if (int.TryParse(property.Name, out int slot) && (string?)property.Value is { Length: > 0 } wav)
                    custom[slot] = wav;
        if (customEventJoin != null)
            foreach (var property in customEventJoin.Properties())
                if (int.TryParse(property.Name, out int exported)
                    && (string?)property.Value is { Length: > 0 } wav
                    && soundIndex.CollisionEvents.TryGetValue(Routed(exported), out SoundIndexEvent? route))
                {
                    int eventId = Routed(exported);
                    if (route.Group != 2)
                    { Log.Warn($"  WARN: custom sound event {eventId} does not route to the target's course bank — {wav} skipped."); continue; }
                    custom[route.Slot] = wav;
                    if (emitterEvents.Contains(eventId)) loopingSlots.Add(route.Slot);
                    shipped.Add(new JObject
                    {
                        ["Wav"] = wav,
                        ["ExportedEvent"] = exported,
                        ["Event"] = eventId,
                        ["Slot"] = route.Slot,
                    });
                }
        var donorSlots = new SortedSet<int>();
        if (collisionJoin != null)
            foreach (var property in collisionJoin.Properties())
                // Routed as well: a prop carrying a CUSTOM hit clip appears in this join under the reserved
                // event id it was exported with, and reading that id literally donor-fills the slot the clip
                // has just been moved off — bytes spent to borrow a sibling bank's sound nothing will play.
                if (property.Value.Type == JTokenType.Integer
                    && soundIndex.CollisionEvents.TryGetValue(Routed((int)property.Value), out SoundIndexEvent? route)
                    && route.Group == 2 && !custom.ContainsKey(route.Slot))
                    donorSlots.Add(route.Slot);
        if (custom.Count == 0 && donorSlots.Count == 0) return;

        string? bankName = soundIndex.CourseBank;
        if (bankName == null)
        { Log.Warn($"  WARN: no course-bank mapping for {level} — authored hit sounds keep the retail banks."); return; }

        string audioBigPath = Path.Combine(tmp, "AUDIO.BIG");
        // Routing extracted this already if it ran, and the ISO's copy has not been touched since — reusing
        // it costs nothing and guarantees the slots chosen there are the slots encoded here.
        if (!File.Exists(audioBigPath)) iso.ExtractFile(outIso, @"DATA\AUDIO\AUDIO.BIG", audioBigPath);
        var archive = BigfArchive.Load(File.ReadAllBytes(audioBigPath));
        var member = archive.Members.FirstOrDefault(m =>
            BigfPaths.FileNameWithoutExtension(m.Path).Equals(bankName, StringComparison.OrdinalIgnoreCase));
        if (member == null)
        { Log.Warn($"  WARN: {bankName}.bnk not found in AUDIO.BIG — authored hit sounds keep the retail banks."); return; }

        var bank = BnkFile.Load(member.Data);
        int changed = 0;
        var loopedSlots = new HashSet<int>();

        // What this bank is actually played at. The per-sound rate tag is not honoured, so a custom clip has
        // to arrive at the bank's own rate or it comes out at the wrong speed; the bank tells us what that is
        // rather than a constant having to. Modal rather than mean: garibaldi1 is 16,000 in 21 of its 23
        // slots and 22,050 in the two that are not ordinary prop one-shots.
        int targetRate = soundRate;
        if (targetRate == 0)
        {
            targetRate = ModalRate(bank);
            Log.Info($"  custom sounds convert to {targetRate} Hz, the rate {bankName}.bnk is played at.");
        }

        var donorCache = new Dictionary<string, BnkFile?>(StringComparer.OrdinalIgnoreCase);
        var filled = new List<(int Slot, string From, int Bytes)>();
        foreach (int slot in donorSlots)
        {
            if (slot < bank.Slots.Count && bank.Slots[slot] != null) continue; // the target bank ships it
            BnkFile.Sound? donorSound = null;
            string? donorName = null;
            foreach (string candidate in discBanks.CourseBanks)
            {
                if (candidate.Equals(bankName, StringComparison.OrdinalIgnoreCase)) continue;
                if (!donorCache.TryGetValue(candidate, out var donor))
                {
                    var donorMember = archive.Members.FirstOrDefault(m =>
                        BigfPaths.FileNameWithoutExtension(m.Path).Equals(candidate, StringComparison.OrdinalIgnoreCase));
                    try { donor = donorMember == null ? null : BnkFile.Load(donorMember.Data); }
                    catch { donor = null; }
                    donorCache[candidate] = donor;
                }
                var sound = donor != null && slot < donor.Slots.Count ? donor.Slots[slot] : null;
                if (sound != null) { donorSound = sound; donorName = candidate; break; }
            }
            if (donorSound == null)
            { Log.Warn($"  WARN: no course bank ships slot {slot:D3} — authored hit sounds using it stay silent."); continue; }
            EnsureSlot(bank, slot);
            bank.Slots[slot] = donorSound;
            changed++;
            filled.Add((slot, donorName!, donorSound.ChannelData.Sum(run => run.Length)));
            Log.Info($"  hit-sound slot {slot:D3} filled from {donorName} (the target bank left it empty).");
        }

        foreach (var (slot, wav) in custom)
        {
            string wavPath = Path.Combine(customDir, "Sounds", wav);
            if (!File.Exists(wavPath))
            { Log.Warn($"  WARN: custom sound {wav} missing from the export — slot {slot:D3} unchanged."); continue; }
            try
            {
                var (samples, rate) = ReadWavPcm16Mono(File.ReadAllBytes(wavPath));
                int sourceRate = rate;
                // The engine does NOT play a course-bank sound at the rate its own 0x84 tag declares — a
                // 440 Hz tone authored at 22,050 came back audibly flat beside the same tone authored at
                // 16,000, in the ratio the bank's own rate predicts. So a clip that does not match the bank
                // plays at the wrong speed and pitch, which is why this converts rather than merely capping.
                if (targetRate > 0 && rate != targetRate)
                {
                    samples = PcmResampler.Resample(samples, rate, targetRate);
                    rate = targetRate;
                }
                // A continuing emitter loops as much of the clip as it can. Two constraints, and both are read
                // off retail rather than reasoned about:
                //
                //  - the region ends one 28-sample frame short of the data, so the final frame is free to
                //    carry the wrap marker; without that spare frame the voice reaches the end of the sample
                //    with nothing telling it to repeat;
                //  - the region STARTS one frame in, never at sample 0. All three of the slots retail loops
                //    begin at 13580, 84 and 28 — the last of those being exactly one frame — and a loop
                //    written from 0 played once and stopped on hardware, which is what a zero start being
                //    read as "no loop region" looks like. One frame is the smallest value retail itself uses.
                int frameCount = (samples.Length + 27) / 28;
                // The shape costs FIVE frames: one to open, one before the marker, the marker itself, and the
                // two past the region that carry the wrap — retail leaves two, without exception, and leaving
                // one produced a bed that played once and stopped [Trailmap: 260-psadpcm-loop]. The guard has
                // to agree with what the shape actually costs, or the encoder silently writes a one-shot that
                // every report calls a loop.
                bool loop = loopingSlots.Contains(slot) && frameCount >= 5;
                int loopStart = loop ? 28 : -1;
                int loopEnd = loop ? (frameCount - 2) * 28 - 1 : -1;
                // A LOOPING slot declares the whole final frame, never part of one. All three of retail's
                // sustaining slots land their sample count exactly on a frame boundary — merqurycity1 24 is
                // 18,004 = 643x28, 35 is 3,304 = 118x28, 36 is 4,564 = 163x28 — and no one-shot needs to,
                // because nothing reads past its end. Declaring a length that stops part way into the last
                // frame is the one structural difference a loop cannot carry. The bytes are unchanged; only
                // the declared length moves, and what it exposes is the encoder's own zero padding, sitting
                // past the wrap frames where a sustaining voice never reaches it.
                int declared = loop ? frameCount * 28 : samples.Length;
                EnsureSlot(bank, slot);
                bank.Slots[slot] = BnkFile.BuildPsAdpcm(PsAdpcmEncoder.Encode(samples, loopStart, loopEnd),
                                                        declared, rate, loopStart, loopEnd);
                changed++;
                if (loop) loopedSlots.Add(slot);
                Log.Info($"  custom {(loop ? "emitter loop" : "hit sound")} \"{wav}\" encoded into course-bank slot {slot:D3} "
                    + $"({samples.Length / (double)rate:0.0}s PS-ADPCM @ {rate} Hz"
                    + (rate == sourceRate ? "" : $", converted from {sourceRate} Hz")
                    + $"{(loop ? ", looping" : "")}).");
                if (loopingSlots.Contains(slot) && !loop)
                    Log.Warn($"  WARN: \"{wav}\" is too short to carry a loop region — slot {slot:D3} plays once and stops.");
            }
            catch (Exception e)
            { Log.Warn($"  WARN: custom sound {wav} failed to encode ({e.Message}) — slot {slot:D3} unchanged."); }
        }

        if (changed == 0)
        { Log.Info("  authored hit sounds: the target bank already ships every needed slot — AUDIO.BIG untouched."); return; }

        // THE BUDGET. A rebuilt course bank must not exceed the size the level shipped with: measured across
        // ten discs, every build whose bank came in at or under garibaldi1's own 324,992 bytes played its
        // custom sounds, and every build over it was silent — with nothing else to tell them apart. The
        // failure mode is the worst kind: the ISO builds, the ADL is right, the engine allocates voices at
        // correct gain and position, and no sound arrives. So this refuses rather than warns.
        //
        // Note the budget is THIS bank's own size, not the largest bank on the disc. Comparing against the
        // latter reads as headroom that is not there: garibaldi1 is 325 KB while merqurycity1 is 484 KB, so a
        // 446 KB garibaldi1 looks comfortably inside "what retail ships" and cannot play a note.
        int original = member.Data.Length;
        byte[] rebuilt = bank.Write();

        // Over budget, the DONOR FILLS go first. A fill is a convenience — it borrows a sibling bank's clip so
        // an authored prop using a retail event still makes its retail noise — whereas a custom clip is the
        // thing the author asked for, and there is no version of "the bank is full" where the right answer is
        // to drop the author's own sound to keep a borrowed one. Largest first, and only as many as it takes.
        var shed = new List<(int Slot, string From, int Bytes)>();
        foreach (var fill in filled.OrderByDescending(fill => fill.Bytes))
        {
            if (rebuilt.Length <= original) break;
            bank.Slots[fill.Slot] = null;
            changed--;
            shed.Add(fill);
            rebuilt = bank.Write();
        }
        foreach (var fill in shed)
            Log.Warn($"  WARN: slot {fill.Slot:D3} borrowed from {fill.From} dropped ({fill.Bytes:N0} bytes) "
                + $"— {bankName}.bnk has no room for it inside the {original:N0} bytes this level ships. "
                + "Props using that event stay silent; the custom sounds are kept.");

        if (rebuilt.Length > original)
        {
            Log.Warn($"  WARN: {bankName}.bnk would grow to {rebuilt.Length:N0} bytes from {original:N0} — "
                + $"{rebuilt.Length - original:N0} over what this level ships. A course bank past its own size "
                + "plays NO custom sound at all, so the retail banks are kept instead of shipping a silent one.");
            foreach (var (slot, wav) in custom.OrderByDescending(pair => bank.Slots[pair.Key]?.SampleCount ?? 0))
            {
                var sound = bank.Slots[slot];
                if (sound == null) continue;
                int cost = (sound.SampleCount + 27) / 28 * 16 * sound.ChannelData.Count;
                Log.Info($"    \"{wav}\" costs {cost:N0} bytes ({sound.SampleCount / (double)sound.SampleRate:0.0}s)");
            }
            Log.Info("    Shorten the longest clips: routing already took every shipped slot this level "
                + "no longer reaches, and what is left over is clip length.");
            return;
        }
        if (changed == 0)
        { Log.Info("  authored hit sounds: nothing left to inject once the bank budget was met — AUDIO.BIG untouched."); return; }
        Log.Info($"  bank budget: {rebuilt.Length:N0} of {original:N0} bytes "
            + $"({original - rebuilt.Length:N0} spare).");
        // Only once the injection is going to happen: a build that refused the budget overwrites nothing, and
        // warning there about sounds that are about to change would be warning about a thing that did not.
        WarnRetailConflicts(workDir, customDir, level, custom.Keys, soundIndex);
        member.Data = rebuilt;
        // The biggest course bank retail ships is merqurycity1 at 484,112 bytes, so anything past that is
        // outside the envelope the engine was ever asked for. Nothing here can prove it does not fit — the
        // sound RAM is the console's — but a bank that has quietly doubled is worth naming before a ride.
        const int LargestRetailCourseBank = 484_112;
        if (member.Data.Length > LargestRetailCourseBank)
            Log.Warn($"  WARN: {bankName}.bnk is now {member.Data.Length:N0} bytes, past the {LargestRetailCourseBank:N0} "
                + "of the largest bank retail ships — shorten the custom clips if course sounds misbehave.");
        string newBig = Path.Combine(tmp, "AUDIO.new.BIG");
        File.WriteAllBytes(newBig, archive.Write());
        iso.ReplaceFile(outIso, @"DATA\AUDIO\AUDIO.BIG", newBig);
        Log.Info($"  AUDIO.BIG rebuilt: {changed} slot(s) injected into {bankName}.bnk ({member.Data.Length:N0} bytes).");
        WriteDiscSoundManifest(outIso, level, bankName, member.Data.Length, original, shipped, loopedSlots);
    }

    /// <summary>
    /// Record what this disc's course bank ends up carrying, next to the disc.
    ///
    /// Only written when slots were actually injected, so the file's existence means the sounds are on the
    /// image — a build that refused the budget leaves the previous manifest rather than claiming a shipment it
    /// did not make. Its readers are the author, who otherwise has no way to learn that routing moved a clip
    /// off the event the export named, and `Trailmap/tools/autotest/audio_voices.py`, which grades the engine's
    /// voice pool and sees event ids and nothing else.
    /// </summary>
    private static void WriteDiscSoundManifest(string outIso, string level, string bankName, int bytes,
                                               int budget, JArray shipped, HashSet<int> loopedSlots)
    {
        if (shipped.Count == 0) return;
        foreach (var entry in shipped.OfType<JObject>())
            entry["Looping"] = loopedSlots.Contains((int)entry["Slot"]!);
        var manifest = new JObject
        {
            ["Schema"] = "openslope-disc-sounds/v1",
            ["Level"] = level,
            ["Bank"] = bankName,
            ["BankBytes"] = bytes,
            ["BankBudget"] = budget,
            ["Sounds"] = shipped,
        };
        try { File.WriteAllText(Path.ChangeExtension(outIso, ".sounds.json"), manifest.ToString()); }
        catch (Exception e)
        { Log.Warn($"  WARN: could not write the disc sound manifest ({e.Message})."); }
    }

    /// <summary>The rate a bank is actually played at, which is not what any individual clip's 0x84 tag says.
    /// Modal rather than mean: garibaldi1 reads 16,000 in 21 of its 23 slots and 22,050 in the two that are
    /// not ordinary prop one-shots.</summary>
    internal static int ModalRate(BnkFile bank) =>
        bank.Slots.Where(s => s != null).GroupBy(s => s!.SampleRate)
            .OrderByDescending(g => g.Count()).ThenBy(g => g.Key)
            .Select(g => (int?)g.Key).FirstOrDefault() ?? RetailSoundRate;

    private static void EnsureSlot(BnkFile bank, int slot)
    {
        while (bank.Slots.Count <= slot) bank.Slots.Add(null);
    }

    /// <summary>`bank-verify &lt;AUDIO.BIG | bank.bnk&gt;` — prove the write side before trusting an injected
    /// ISO: BIGF Load→Write must be byte-identical to the shipped archive, every bank must survive a no-op
    /// BnkFile rebuild with all slots semantically intact (tags, rates, counts, raw sample bytes), and the
    /// PS-ADPCM encoder must round-trip through the library decoder at sane fidelity.</summary>
    public static int Verify(string[] args)
    {
        if (args.Length < 2)
        { Log.Error("bank-verify needs <AUDIO.BIG or bank.bnk>"); return 1; }
        byte[] bytes = File.ReadAllBytes(args[1]);
        int failures = 0;
        if (bytes.Length > 4 && bytes[0] == 'B' && bytes[1] == 'I' && bytes[2] == 'G' && bytes[3] == 'F')
        {
            var archive = BigfArchive.Load(bytes);
            bool same = archive.Write().SequenceEqual(bytes);
            Log.Info($"BIGF round-trip: {archive.Members.Count} member(s), {(same ? "byte-identical" : "MISMATCH")}");
            if (!same) failures++;
            foreach (var member in archive.Members.Where(m => m.Path.EndsWith(".bnk", StringComparison.OrdinalIgnoreCase)))
                failures += VerifyBank(member.Path, member.Data);
        }
        else if (bytes.Length > 3 && bytes[0] == 'B' && bytes[1] == 'N' && bytes[2] == 'K')
            failures += VerifyBank(args[1], bytes);
        else { Log.Error("not a BIGF archive or BNKl bank"); return 1; }
        failures += VerifyEncoder();
        Log.Info(failures == 0 ? "bank-verify: PASS" : $"bank-verify: {failures} FAILURE(S)");
        return failures == 0 ? 0 : 1;
    }

    private static int VerifyBank(string name, byte[] original)
    {
        BnkFile before, after;
        try
        {
            before = BnkFile.Load(original);
            after = BnkFile.Load(before.Write());
        }
        catch (Exception e)
        {
            Log.Warn($"  {name}: REBUILD FAILED ({e.Message})");
            return 1;
        }
        var problems = new List<string>();
        if (after.Slots.Count != before.Slots.Count) problems.Add("slot count changed");
        int sounds = 0;
        for (int i = 0; i < Math.Min(before.Slots.Count, after.Slots.Count); i++)
        {
            var a = before.Slots[i];
            var b = after.Slots[i];
            if ((a == null) != (b == null)) { problems.Add($"slot {i} presence changed"); continue; }
            if (a == null || b == null) continue;
            sounds++;
            if (a.SampleCount != b.SampleCount || a.SampleRate != b.SampleRate
                || a.Channels != b.Channels || a.Codec != b.Codec) problems.Add($"slot {i} fields changed");
            if (a.ChannelData.Count != b.ChannelData.Count
                || a.ChannelData.Zip(b.ChannelData).Any(pair => !pair.First.SequenceEqual(pair.Second)))
                problems.Add($"slot {i} sample bytes changed");
            if (a.Tags.Count != b.Tags.Count
                || a.Tags.Zip(b.Tags).Any(pair => pair.First.Tag != pair.Second.Tag
                    || (pair.First.Tag is not (0x88 or 0x89) && !pair.First.Value.SequenceEqual(pair.Second.Value))))
                problems.Add($"slot {i} tags changed");
        }
        // Semantic faithfulness is what a REBUILT bank needs, but it is a weaker claim than it reads as: the
        // engine is handed bytes, not our model of them, so a layout our own reader round-trips can still be
        // one the console does not accept. Byte identity on an untouched bank is the claim that actually
        // covers that, and it is free to check here.
        byte[] rewritten = before.Write();
        string identity;
        if (rewritten.Length != original.Length)
            identity = $"LAYOUT DIFFERS ({original.Length:N0} -> {rewritten.Length:N0} bytes)";
        else
        {
            int at = 0;
            while (at < original.Length && original[at] == rewritten[at]) at++;
            identity = at == original.Length ? "byte-identical" : $"DIFFERS from 0x{at:X}";
        }
        Log.Info(problems.Count == 0
            ? $"  {name}: {sounds} sound(s) / {before.Slots.Count} slot(s), rebuild faithful, {identity}"
            : $"  {name}: REBUILD UNFAITHFUL — {string.Join("; ", problems.Take(4))}");
        return problems.Count == 0 ? 0 : 1;
    }

    private static int VerifyEncoder()
    {
        static double Snr(short[] x)
        {
            byte[] frames = PsAdpcmEncoder.Encode(x);
            var decoded = new List<short>(x.Length);
            int p = 0, h1 = 0, h2 = 0;
            SSXLibrary.FileHandlers.Audio.PsAdpcmCodec.DecodeChannel(frames, ref p, x.Length, decoded, ref h1, ref h2);
            double signal = 0, noise = 0;
            for (int i = 0; i < x.Length; i++)
            {
                signal += (double)x[i] * x[i];
                double d = x[i] - decoded[i];
                noise += d * d;
            }
            return noise == 0 ? double.PositiveInfinity : 10 * Math.Log10(signal / noise);
        }

        var sine = new short[16000];
        for (int i = 0; i < sine.Length; i++)
            sine[i] = (short)(12000 * Math.Sin(2 * Math.PI * 440 * i / 16000.0));
        var noiseSignal = new short[8000];
        uint seed = 0x12345678;
        for (int i = 0; i < noiseSignal.Length; i++)
        {
            seed = seed * 1664525 + 1013904223;
            noiseSignal[i] = (short)((seed >> 16) - 32768 >> 2);
        }
        double sineSnr = Snr(sine), noiseSnr = Snr(noiseSignal);
        byte[] flags = PsAdpcmEncoder.Encode(sine);
        bool flagsOk = flags[1] == 0x00 && flags[^15] == 0x01;

        // The loop shape is the half that decides whether a placed emitter is audible at all, so prove it here
        // rather than only in-game: a sustaining sample must mark its repeat address and must terminate with
        // end+repeat, never with the one-shot's bare end flag [Trailmap: 420-audio-runtime].
        int loopFrames = (sine.Length + 27) / 28;
        byte[] looped = PsAdpcmEncoder.Encode(sine, 28, (loopFrames - 1) * 28 - 1);
        byte LoopFlag(int frame) => looped[frame * 16 + 1];
        // Retail's placement, asserted rather than approximated: the repeat marker lands one frame PAST the
        // frame the loop-start sample falls in (merqurycity1 36 points at sample 28 and marks frame 2), the
        // body sustains, the last frame wraps, and "end, do not repeat" appears nowhere.
        bool loopOk = LoopFlag(0) == 0x00
            && LoopFlag(1) == 0x02
            && LoopFlag(2) == 0x06
            && LoopFlag(loopFrames - 1) == 0x03
            && !looped.Where((_, i) => i % 16 == 1).Contains((byte)0x01);
        Log.Info($"  PS-ADPCM encoder: sine SNR {sineSnr:0.0} dB, noise SNR {noiseSnr:0.0} dB, "
            + $"end-flag {(flagsOk ? "ok" : "BAD")}, loop flags {(loopOk ? "ok" : "BAD")}");
        bool pass = sineSnr > 25 && noiseSnr > 6 && flagsOk && loopOk;
        return pass ? 0 : 1;
    }

    /// <summary>A custom sound OVERWRITES a shipped slot; if the target level's own instances reference that
    /// slot through their collision-sound event ids, their hit sounds change too — say so.
    ///
    /// The work directory holds the DONOR slot's instances with the authored ones already appended, so the
    /// authored props have to be excluded by hash or every custom sound reports itself as a conflict with
    /// retail content. A warning that fires on the thing the author just asked for is one they learn to skip,
    /// which costs exactly the case it exists for.</summary>
    private static void WarnRetailConflicts(string workDir, string customDir, string level,
                                            IEnumerable<int> customSlots, SoundIndexDocument soundIndex)
    {
        var slots = new HashSet<int>(customSlots);
        if (slots.Count == 0) return;
        string instancesPath = Path.Combine(workDir, "Instances.json");
        if (!File.Exists(instancesPath)) return;
        try
        {
            var authored = new HashSet<int>();
            string authoredPath = Path.Combine(customDir, "Instances.json");
            if (File.Exists(authoredPath))
                foreach (var inst in (JObject.Parse(File.ReadAllText(authoredPath))["Instances"] as JArray
                                      ?? new JArray()).OfType<JObject>())
                    if ((int?)inst["Hash"] is { } hash) authored.Add(hash);

            int conflicts = 0, emitterConflicts = 0;
            var root = JObject.Parse(File.ReadAllText(instancesPath));
            bool Overridden(JToken? raw) =>
                raw is { Type: JTokenType.Integer }
                && soundIndex.CollisionEvents.TryGetValue((int)raw, out SoundIndexEvent? route)
                && route.Group == 2 && slots.Contains(route.Slot);
            foreach (var inst in (root["Instances"] as JArray ?? new JArray()).OfType<JObject>())
            {
                if ((bool?)inst["IncludeSound"] == false) continue;
                if ((int?)inst["Hash"] is { } instanceHash && authored.Contains(instanceHash)) continue;
                if (Overridden((inst["Sounds"] as JObject)?["CollisonSound"])) conflicts++;
                // Placed EMITTERS resolve through the same event->slot table, so overriding a slot rewrites a
                // continuing loop exactly as it rewrites a hit sound. The loudest case is event 28: taking it
                // for a custom hit-gated loop silently replaces every hydrant's spray.
                foreach (var sound in (inst["Sounds"] as JObject)?["ExternalSounds"] as JArray ?? new JArray())
                    if (Overridden((sound as JObject)?["SoundIndex"])) emitterConflicts++;
            }
            if (conflicts > 0)
                Log.Warn($"  WARN: {conflicts} retail instance(s) in {level} resolve to a custom-overridden slot — their hit sounds change to the custom WAV.");
            if (emitterConflicts > 0)
                Log.Warn($"  WARN: {emitterConflicts} retail ambient emitter(s) in {level} resolve to a custom-overridden slot — their continuing loops change to the custom WAV.");
        }
        catch { /* best-effort advisory only */ }
    }

    /// <summary>Slopesmith exports store custom sounds as canonical PCM16-mono RIFF WAVs; accept exactly
    /// that (mixing stereo down defensively).</summary>
    internal static (short[] Samples, int Rate) ReadWavPcm16Mono(byte[] d)
    {
        if (d.Length < 44 || d[0] != 'R' || d[1] != 'I' || d[2] != 'F' || d[3] != 'F' || d[8] != 'W' || d[9] != 'A')
            throw new InvalidDataException("not a RIFF WAV");
        int at = 12, fmtAt = -1, dataAt = -1, dataLen = 0;
        while (at + 8 <= d.Length)
        {
            string id = System.Text.Encoding.ASCII.GetString(d, at, 4);
            int size = BitConverter.ToInt32(d, at + 4);
            if (id == "fmt ") fmtAt = at + 8;
            if (id == "data") { dataAt = at + 8; dataLen = Math.Min(size, d.Length - dataAt); }
            at += 8 + size + (size & 1);
        }
        if (fmtAt < 0 || dataAt < 0) throw new InvalidDataException("WAV missing fmt/data");
        int format = BitConverter.ToInt16(d, fmtAt);
        int channels = BitConverter.ToInt16(d, fmtAt + 2);
        int rate = BitConverter.ToInt32(d, fmtAt + 4);
        int bits = BitConverter.ToInt16(d, fmtAt + 14);
        if (format != 1 || bits != 16 || channels < 1 || channels > 2)
            throw new InvalidDataException($"expected PCM16 mono/stereo, got format {format} {bits}-bit {channels}ch");
        int frames = dataLen / (2 * channels);
        var samples = new short[frames];
        for (int i = 0; i < frames; i++)
        {
            int left = BitConverter.ToInt16(d, dataAt + i * 2 * channels);
            samples[i] = channels == 1 ? (short)left
                : (short)Math.Clamp((left + BitConverter.ToInt16(d, dataAt + i * 2 * channels + 2)) / 2, short.MinValue, short.MaxValue);
        }
        return (samples, rate);
    }
}
