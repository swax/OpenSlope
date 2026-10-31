#include "assets.hpp"
#include "import/music_cache.hpp"
#include "openslope/audio_data.hpp"
#include "openslope/music.hpp"
#include <iomanip>
#include <map>
#include <sstream>

namespace openslope::import_detail::gba {
namespace {
constexpr unsigned rate = 10512;

PcmClip pcm(std::span<const std::uint8_t> data) {
    PcmClip clip;
    clip.rate = rate;
    clip.samples.reserve(data.size());
    for (const auto value : data)
        clip.samples.push_back(float(static_cast<std::int8_t>(value)) / 128.f);
    return clip;
}

PcmClip noise(unsigned seed, double gain) {
    PcmClip clip;
    clip.rate = rate;
    clip.samples.resize(rate * 2);
    double low = 0;
    for (auto& sample : clip.samples) {
        seed = seed * 1664525u + 1013904223u;
        const auto white = double(seed >> 8) / 8388608. - 1;
        low += .1 * (white - low);
        sample = float(gain * (white - low));
    }
    clip.loop_end = clip.frames();
    return clip;
}

std::vector<std::uint8_t> music_pcm(std::span<const std::uint8_t> data) {
    const Bytes b{data};
    const auto size = b.le(0);
    require(size > 0 && size <= 1024 * 1024, "Invalid GBA music chunk extent");
    b.range(0, std::size_t(size) + 7);
    unsigned at = 0, value = data[4];
    std::vector<std::uint8_t> out{std::uint8_t(value)};
    const auto nibble = [&]() {
        require(at < std::size_t(size + 2) * 2, "Truncated GBA music escape");
        const auto n = (data[5 + at / 2] >> (at % 2 ? 0 : 4)) & 15;
        ++at;
        return n;
    };
    while (at / 2 < size)
        for (unsigned j = 0; j < 2; ++j) {
            const auto n = nibble();
            if (n == 8) {
                const auto hi = nibble(), lo = nibble();
                value = hi * 16 + lo;
            } else
                value = (value + (n < 8 ? int(n) : int(n) - 16)) & 255;
            out.push_back(std::uint8_t(value));
        }
    return out;
}
} // namespace

void write_audio(const Rom& rom, const std::filesystem::path& output, const ImportCancel& cancel) {
    const auto root = output / "Audio";
    std::filesystem::create_directories(root / "SFX");
    AudioBank originals;
    originals.slots.resize(24);
    for (unsigned i = 1; i <= 23; ++i) {
        check_cancel(cancel);
        originals.slots[i] = pcm(rom.resource(i + 16));
    }
    write_audio_bank(root / "SFX/gba_effects", originals, [&] { check_cancel(cancel); });
    const auto glide = noise(0x47424101, .10), carve = noise(0x47424102, .18), grind = noise(0x47424103, .14);
    AudioBank board;
    board.slots.resize(80);
    for (unsigned group = 0; group < 10; ++group) {
        board.slots[group * 8 + 4] = group == 6 ? grind : glide;
        board.slots[group * 8 + 3] = group == 6 ? grind : carve;
        board.slots[group * 8 + 1] = originals.slots[2];
        board.slots[group * 8 + 2] = originals.slots[5];
    }
    AudioBank main;
    main.slots.resize(121);
    main.slots[32] = noise(0x47424104, .035);
    for (unsigned slot : {114u, 115u, 116u, 117u, 118u})
        main.slots[slot] = originals.slots[slot == 115 ? 9 : 16];
    main.slots[120] = originals.slots[9];
    main.slots[120]->loop_end = main.slots[120]->frames();
    write_audio_bank(root / "SFX/openslope_board", board, [&] { check_cancel(cancel); });
    write_audio_bank(root / "SFX/openslope_main", main, [&] { check_cancel(cancel); });
    save(root / "SoundIndex.json",
         {{"Schema", "openslope-sound-index/v1"},
          {"Banks", {{"0", "openslope_main"}, {"1", "openslope_board"}, {"2", "gba_effects"}}},
          {"CollisionEvents", Json::object()},
          {"ResolverState", "Adapted"}});
    std::vector<unsigned> groups(128);
    groups[13] = 6;
    save(root / "BoardSoundIndex.json", {{"Schema", "openslope-board-sound-index/v1"}, {"SurfaceGroups", groups}});
    save(root / "RidingImport.json",
         {{"Schema", "openslope-riding-import/v1"},
          {"Game", "ssx-tricky-gba"},
          {"Effects", 23},
          {"OriginalPcmBank", "gba_effects"},
          {"AuthoredContactBeds", {"glide", "carve", "grind"}},
          {"AuthoredAirBed", true},
          {"Policy",
           "Original jump, landing and pickup feedback adapted to common riding banks; contact noise is authored"},
          {"UnboundEffectIds", {8, 20}},
          {"NativeHardwareNoise", false}});
}

void write_music(const Rom& rom, const Course& course, const std::filesystem::path& output,
                 const ImportProgress& progress, const ImportCancel& cancel) {
    // [Trailmap: 610-audio] Native arrangement registration order, including repeated resource aliases.
    static const std::vector<std::vector<unsigned>> lookup{
        {142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 142, 143, 154, 155},
        {156, 157, 158, 159, 160, 160},
        {161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174},
        {175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187},
        {188},
        {189, 190, 191, 192, 193, 194, 195},
        {203, 204},
        {205, 206},
        {196, 197, 198, 199, 200, 201, 202, 202},
        {207, 208}};
    const auto root = output / "Audio/Music";
    std::filesystem::create_directories(root);
    Json playlist = Json::array();
    for (unsigned order = 0; order < lookup.size(); ++order) {
        check_cancel(cancel);
        const auto selection = (order + course.index) % lookup.size();
        std::ostringstream label;
        label << "gba_mix_" << std::setfill('0') << std::setw(2) << selection + 1;
        const auto id = label.str();
        const auto sequence = rom.source.read(0x21170 + selection * 92, 92);
        std::vector<std::uint8_t> key_bytes = sequence;
        std::map<unsigned, std::vector<std::uint8_t>> compressed;
        for (const auto rid : lookup[selection])
            if (!compressed.contains(rid)) {
                // The native DPCM consumer can read a few lookahead nibbles after the archive member.
                // Preserve those source bytes, bounded by the ROM rather than inventing zero padding.
                const auto& resource = rom.resources.at(rid);
                auto data = rom.source.read(
                    resource.offset,
                    std::size_t(std::min<std::uint64_t>(resource.size + 8ull, rom.source.size - resource.offset)));
                key_bytes.insert(key_bytes.end(), data.begin(), data.end());
                compressed.emplace(rid, std::move(data));
            }
        const auto key = music_key("ssx-gba-music-v2", std::to_string(selection), {key_bytes});
        if (progress)
            progress("Preparing GBA arrangement " + std::to_string(selection + 1));
        cached_music(
            rom.source, key, root / id,
            [&] {
                std::filesystem::create_directory(root / id);
                std::map<unsigned, std::vector<std::uint8_t>> decoded;
                std::vector<std::uint8_t> samples;
                for (const unsigned index : sequence) {
                    check_cancel(cancel);
                    require(index >= 32 && index - 32 < lookup[selection].size(), "Invalid GBA music playlist index");
                    const auto rid = lookup[selection][index - 32];
                    if (!decoded.contains(rid))
                        decoded.emplace(rid, music_pcm(compressed.at(rid)));
                    const auto& part = decoded.at(rid);
                    require(samples.size() + part.size() <= 4 * 1024 * 1024, "GBA arrangement exceeds sample limit");
                    samples.insert(samples.end(), part.begin(), part.end());
                }
                const unsigned chunks = unsigned((samples.size() + 32767) / 32768);
                Json rows = Json::array(), nodes = Json::array();
                const auto node = [](unsigned i, unsigned sample, unsigned next) {
                    return Json{{"Index", i},      {"Sample", sample},
                                {"Track", 0},      {"Flags", 0},
                                {"Word1", 0},      {"Word2", 0},
                                {"Links", {next}}, {"LinkRaw", {std::uint32_t(next << 16 | 127 << 8)}}};
                };
                nodes.push_back(node(0, 0, 1));
                for (unsigned i = 0; i < chunks; ++i) {
                    check_cancel(cancel);
                    const auto first = std::size_t(i) * 32768,
                               count = std::min<std::size_t>(32768, samples.size() - first);
                    const auto clip = pcm(std::span(samples).subspan(first, count));
                    std::ostringstream name;
                    name << "chunk_" << std::setfill('0') << std::setw(3) << i << ".wav";
                    write_wave(root / id / name.str(), clip);
                    rows.push_back({{"Index", i},
                                    {"Wav", name.str()},
                                    {"MusOffset", first},
                                    {"Meta", std::lround(count * 1000. / rate)},
                                    {"Samples", count},
                                    {"Rate", rate},
                                    {"Channels", 1},
                                    {"Seconds", double(count) / rate}});
                    nodes.push_back(node(i + 1, i + 1, i + 1 == chunks ? 1 : i + 2));
                }
                save(root / id / "graph.json", {{"Schema", "openslope-music-graph/v1"},
                                                {"Song", "GBA arrangement " + std::to_string(selection + 1)},
                                                {"Short", id},
                                                {"Artist", ""},
                                                {"Bpm", 0},
                                                {"Volume", 1},
                                                {"Tracks", 1},
                                                {"Sections", 1},
                                                {"Events", 0},
                                                {"EventTable", ""},
                                                {"Routers", Json::array()},
                                                {"Vars", Json::array()},
                                                {"Nodes", nodes},
                                                {"Samples", rows}});
                static_cast<void>(MusicGraph::load(root / id / "graph.json"));
            },
            cancel);
        playlist.push_back(id);
    }
    save(root / "playlist.json", playlist);
    save(root / "MusicImport.json",
         {{"Schema", "openslope-music-import/v1"},
          {"Game", "ssx-tricky-gba"},
          {"Songs", 10},
          {"Policy", "Native 92-chunk arrangement cycles; selection order adapted by course index"},
          {"OriginalCourseBindingVerified", false}});
}
} // namespace openslope::import_detail::gba
