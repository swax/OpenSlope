#include "audio.hpp"
#include "import/strings.hpp"
#include "openslope/audio_data.hpp"
#include <fstream>
#include <map>
#include <nlohmann/json.hpp>
#include <tuple>

namespace openslope::import_detail {
namespace {
using Json = nlohmann::json;

void require(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(message);
}

void save(const std::filesystem::path& path, const Json& document) {
    std::ofstream file(path, std::ios::binary);
    file << document.dump() << '\n';
    require(bool(file), "Cannot write Mad Trix audio metadata");
}

// [Trailmap: 550-audio] VDEF's ten fixed-width names select the game's ski,
// edging and landing samples by source surface family.
std::vector<std::string> voices(const Pak& pak, const std::string& name, const ImportCancel& cancel) {
    if (!pak.contains(name))
        return {};
    const auto bytes = pak.file(name, cancel);
    const Bytes b{bytes};
    require(b.text(0, 4) == "LOAD" && b.text(36, 4) == "VDEF" && b.text(40, 4) == "VDEF" &&
                b.le(44) == bytes.size() - 48,
            "Unsupported Mad Trix voice definition");
    const auto count = b.le(48);
    require(count == 10, "Unsupported Mad Trix voice family count");
    b.range(52, count * 16);
    std::vector<std::string> result;
    for (unsigned i = 0; i < count; ++i) {
        auto value = b.text(52 + i * 16, 16);
        const auto end = value.find('\0');
        require(end != std::string::npos, "Unterminated Mad Trix voice name");
        value.resize(end);
        require(valid_map_name(value) && upper(value).ends_with(".VAG"), "Unsafe Mad Trix voice name");
        result.push_back(value);
    }
    return result;
}

PcmClip decode(const std::vector<std::uint8_t>& bytes, const ImportCancel& cancel) {
    const Bytes b{bytes};
    b.range(0, 48);
    const auto big = [&](unsigned p) {
        return (b.le(p) & 255) << 24 | (b.le(p) & 0xff00) << 8 | (b.le(p) >> 8 & 0xff00) | b.le(p) >> 24;
    };
    const auto size = big(12), rate = big(16);
    require(size > 0 && size <= 4 * 1024 * 1024 && size % 16 == 0 && bytes.size() == size + 48 && rate >= 4000 &&
                rate <= 48000,
            "Invalid Mad Trix VAG extent or rate");
    PcmClip clip;
    clip.rate = rate;
    for (unsigned p = 0; p < size; p += 16) {
        check_cancel(cancel);
        require((bytes[48 + p] >> 4) <= 4 && (bytes[48 + p] & 15) <= 12 && bytes[49 + p] <= 7,
                "Invalid Mad Trix VAG frame");
        const auto flags = bytes[49 + p];
        if (flags & 4)
            clip.loop_start = p / 16 * 28;
        if ((flags & 3) == 3)
            clip.loop_end = (p / 16 + 1) * 28;
    }
    require(!clip.loop_end || clip.loop_end > clip.loop_start, "Invalid Mad Trix VAG loop");
    AdpcmState history;
    const auto samples = decode_audio_frames(std::span(bytes).subspan(48), 5, size / 16 * 28, history);
    clip.samples.reserve(samples.size());
    for (const auto sample : samples)
        clip.samples.push_back(sample / 32768.f);
    return clip;
}
} // namespace

void write_madtrix_audio(const Pak& pak, const std::string& course, const std::filesystem::path& output,
                         const ImportCancel& cancel) {
    const auto root = output / "Audio";
    std::filesystem::create_directories(root / "SFX");
    AudioBank board;
    board.slots.resize(80);
    Json routes = Json::array();
    std::map<std::string, PcmClip> clips;
    // An explicit OpenSlope adaptation to its common board roles, not a claim
    // that Mad Trix uses SSX's slot numbers, physics or event routing.
    constexpr std::array<unsigned, 10> families{2, 4, 0, 1, 5, 7, 6, 9, 8, 1};
    for (const auto& [definition, mode, role] :
         {std::tuple{"normvocdef.bin", 4u, "Glide"}, {"edgevocdef.bin", 3u, "Carve"}, {"landvocdef.bin", 1u, "Land"}}) {
        const auto names = voices(pak, definition, cancel);
        if (names.empty())
            continue;
        for (unsigned group = 0; group < families.size(); ++group) {
            check_cancel(cancel);
            const auto& name = names[families[group]];
            if (!pak.contains(name))
                continue;
            auto entry = clips.find(name);
            if (entry == clips.end())
                entry = clips.emplace(name, decode(pak.file(name, cancel), cancel)).first;
            const auto slot = group * 8 + mode;
            board.slots[slot] = entry->second;
            auto& clip = *board.slots[slot];
            if (mode == 1)
                clip.loop_start = clip.loop_end = 0;
            else if (!clip.loop_end)
                clip.loop_end = clip.frames();
            routes.push_back(
                {{"Slot", slot}, {"Role", role}, {"SourceMember", name}, {"SourceFamily", families[group]}});
        }
    }
    Json banks = Json::object();
    if (!routes.empty()) {
        write_audio_bank(root / "SFX/openslope_board", board, [&] { check_cancel(cancel); });
        banks["1"] = "openslope_board";
    }
    save(root / "SoundIndex.json", {{"Schema", "openslope-sound-index/v1"},
                                    {"Level", course},
                                    {"Banks", banks},
                                    {"CollisionEvents", Json::object()},
                                    {"RidingFallback", "ssx-tricky"},
                                    {"ResolverState", "Deferred"}});
    // Portable surface types currently exported by this importer: snow, ice,
    // and hard scenery. Every unknown portable type retains the PACK family.
    auto groups = std::vector<unsigned>(128);
    groups[5] = 3;
    groups[9] = 7;
    save(root / "BoardSoundIndex.json", {{"Schema", "openslope-board-sound-index/v1"}, {"SurfaceGroups", groups}});
    save(root / "RidingImport.json", {{"Schema", "openslope-riding-import/v1"},
                                      {"Game", "jonny-moseley-mad-trix"},
                                      {"Fidelity", "Approximate"},
                                      {"Routes", routes},
                                      {"FallbackGame", "ssx-tricky"}});
}
} // namespace openslope::import_detail
