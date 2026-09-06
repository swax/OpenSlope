namespace Snowknife.Engine;

/// <summary>
/// Fixed-bank half of the retail special/external sound dispatcher.
///
/// The normal global event resolver sends ids 79..96, 102, 103..147, 159..178, and 183..185 to sound
/// group 6 / slot 0. The group-6 loader then selects one global BNKl file per event through
/// a 107-entry table. Three of those entries pick their bank at resolve time rather than
/// copying a fixed name. [Trailmap: 420-audio-runtime]
///
/// Two of the three are resolvable to a fixed bank anyway and are listed below. Events 95 and 134 are
/// independent traffic channels over the same clip pair, each switching on one flag; both flags are
/// initialized to Trafficloop and nothing in retail ever clears either, so Traffic_Loop2 is unreachable
/// and both ids always resolve to Trafficloop. Only event 102 (the crowd name-chant, which picks a
/// per-character or generic chant bank from the local rider's race position) stays genuinely dynamic and
/// is excluded here. [Trailmap: 420-traffic, 420-chant-select]
///
/// The fixed bank names are generated from Trailmap/specs/data/external-sound-banks-v1.json. That catalog
/// contains short executable/file identifiers only, not player-facing prose. The RETAIL-DERIVED FACTS
/// section of Snowknife/NOTICE states the interoperability scope.
/// </summary>
internal static partial class ExternalSoundCatalog
{
    public static bool TryGetFixedBank(int eventId, out string bank) =>
        FixedBanks.TryGetValue(eventId, out bank!);

    public static bool IsSpecialBankEvent(int eventId) =>
        (eventId >= 79 && eventId <= 96) || eventId == 102 ||
        (eventId >= 103 && eventId <= 147) ||
        (eventId >= 159 && eventId <= 178) ||
        (eventId >= 183 && eventId <= 185);

    // Only the crowd chant is still context-selected; 95/134 resolve to a fixed bank above.
    public static bool IsDynamicSpecialEvent(int eventId) => eventId is 102;

    public static string ClipPath(string bank) => $"Audio/SFX/{OutputBankName(bank)}/000.wav";

    // The retail AUDIO.BIG member is literally "Wolf .bnk" (space before the extension). Normalize the
    // decoded output folder and manifest path, while AudioService's member lookup compares trimmed base names.
    public static string OutputBankName(string bank) => bank.Trim();
}
