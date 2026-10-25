#include "import/ssx/formats.hpp"
#include "openslope/audio_data.hpp"
#include <algorithm>
#include <fstream>
#include <nlohmann/json.hpp>

namespace openslope {
namespace {
using Json = nlohmann::json;

Json read(const std::filesystem::path& path) {
    if (std::filesystem::file_size(path) > 4 * 1024 * 1024)
        throw std::runtime_error("Riding audio metadata exceeds limit");
    std::ifstream stream(path);
    return Json::parse(stream);
}

void write(const std::filesystem::path& path, const Json& value) {
    std::ofstream stream(path, std::ios::binary);
    stream << value.dump() << '\n';
    if (!stream)
        throw std::runtime_error("Cannot write riding audio metadata");
}

struct Adapter {
    std::filesystem::path root;
    Json index, routes = Json::array();
    std::map<std::pair<std::string, unsigned>, std::optional<PcmClip>> clips;
    std::uint64_t bytes = 0;
    ImportCancel cancel;
    std::size_t cached_bytes = 0;

    std::string named(const std::string& role) const {
        const auto& names = index.at("NamedBanks");
        return names.contains(role) ? names.at(role).get<std::string>() : std::string{};
    }

    const PcmClip* clip(const std::string& bank, unsigned slot) {
        import_detail::check_cancel(cancel);
        if (bank.empty() || !valid_map_name(bank) || slot > 999)
            return nullptr;
        auto [entry, fresh] = clips.try_emplace({bank, slot});
        if (fresh) {
            auto stem = std::to_string(slot);
            stem.insert(0, 3 - std::min<std::size_t>(3, stem.size()), '0');
            const auto path = std::filesystem::weakly_canonical(root / "SFX" / bank / (stem + ".wav"));
            const auto relative = path.lexically_relative(root);
            if (relative.empty() || relative.is_absolute() || *relative.begin() == "..")
                throw std::runtime_error("Riding audio source escapes its map");
            if (std::filesystem::is_regular_file(path)) {
                if (std::filesystem::file_size(path) > 64 * 1024 * 1024)
                    throw std::runtime_error("Riding audio source exceeds file limit");
                if (std::filesystem::file_size(path) * 2 > 96 * 1024 * 1024 - cached_bytes)
                    throw std::runtime_error("Riding audio source cache exceeds limit");
                auto value = PcmClip::load(path);
                // WAVs retain PCM only; bank.json supplies the original loop region.
                const auto metadata = read(path.parent_path() / "bank.json");
                const auto& slots = metadata.at("Slots");
                if (slot >= slots.size() || slots[slot].is_null())
                    return nullptr;
                const auto& row = slots[slot];
                value.loop_start = row.value("LoopStart", std::size_t(0));
                value.loop_end = row.value("LoopEnd", std::size_t(0));
                if (value.loop_end > value.frames() || (value.loop_end && value.loop_start >= value.loop_end))
                    throw std::runtime_error("Invalid source riding loop region");
                if (value.frames() >= 32) {
                    cached_bytes += value.samples.size() * sizeof(float);
                    entry->second = std::move(value);
                }
            }
        }
        return entry->second ? &*entry->second : nullptr;
    }

    void assign(AudioBank& target, const std::string& output, unsigned slot, const std::string& role, bool loop,
                const std::vector<std::pair<std::string, unsigned>>& choices) {
        for (const auto& [bank, source] : choices) {
            const auto* value = clip(bank, source);
            if (!value)
                continue;
            const auto amount = 44 + value->samples.size() * 2 +
                                (loop ? 44 + (value->loop_end ? value->loop_end - value->loop_start : value->frames()) *
                                                 value->channels * 2
                                      : 0);
            if (amount > 128 * 1024 * 1024 - bytes)
                throw std::runtime_error("Adapted riding banks exceed limit");
            bytes += amount;
            target.slots[slot] = *value;
            auto& copy = *target.slots[slot];
            if (!loop)
                copy.loop_start = copy.loop_end = 0;
            else if (!copy.loop_end) {
                copy.loop_start = 0;
                copy.loop_end = copy.frames();
            }
            routes.push_back({{"Bank", output},
                              {"Slot", slot},
                              {"Role", role},
                              {"SourceBank", bank},
                              {"SourceSlot", source},
                              {"Loop", loop},
                              {"LoopPolicy", !loop             ? "OneShot"
                                             : value->loop_end ? "SourceRegion"
                                                               : "FullClip"}});
            return;
        }
    }
};
} // namespace

namespace import_detail {
// [Trailmap: 518-authored-riding-adapter] An explicit OpenSlope approximation,
// requested for common Maps playback; these are not original event-resolver rows.
Json write_streamed_riding_audio(const std::filesystem::path& map, bool tour, const ImportCancel& cancel) {
    const auto map_root = std::filesystem::weakly_canonical(map);
    const auto root = std::filesystem::weakly_canonical(map_root / "Audio");
    const auto relative = root.lexically_relative(map_root);
    if (relative.empty() || relative.is_absolute() || *relative.begin() == "..")
        throw std::runtime_error("Riding audio destination escapes its map");
    if (!std::filesystem::is_regular_file(root / "SoundIndex.json"))
        return nullptr;
    Adapter adapter{root, read(root / "SoundIndex.json"), Json::array(), {}, 0, cancel};
    auto& index = adapter.index;
    if (index.value("Schema", "") != "openslope-sound-index/v1" || !index.contains("NamedBanks"))
        throw std::runtime_error("Riding audio needs a named-bank index");
    if (std::filesystem::exists(root / "RidingImport.json")) {
        const auto existing = read(root / "RidingImport.json");
        if (existing.value("Schema", "") != "openslope-riding-import/v1" ||
            existing.value("Game", "") != (tour ? "ssx-on-tour" : "ssx-3") ||
            !std::filesystem::is_regular_file(root / "SFX/openslope_board/bank.json") ||
            !std::filesystem::is_regular_file(root / "SFX/openslope_rider/bank.json"))
            throw std::runtime_error("Conflicting existing riding audio adapter");
        return existing;
    }
    AudioBank board, rider;
    board.slots.resize(80);
    rider.slots.resize(123);
    for (unsigned group = 0; group < 10; ++group) {
        const auto bank = adapter.named(tour        ? group == 0  ? "BRD_PACK"
                                                      : group < 3 ? "BRD_POW"
                                                                  : "BRD_ICE"
                                        : group < 4 ? "SPUBOARD"
                                                    : "BOARD");
        const auto base = tour ? 0 : group * 8;
        for (const auto& [mode, label] : {std::pair{3u, "Carve"}, std::pair{4u, "Glide"}})
            adapter.assign(board, "openslope_board", group * 8 + mode, label, true,
                           {{!tour && group == 6 ? adapter.named("BOARD") : bank, !tour && group == 6 ? 35u
                                                                                  : tour              ? mode - 2
                                                                                                      : base + mode},
                            {adapter.named(tour ? "BRD_PACK" : "SPUBOARD"), tour ? mode - 2 : mode}});
        adapter.assign(board, "openslope_board", group * 8 + 1, "Land", false,
                       {{adapter.named(tour ? "SKI_BRD_COMMON" : "LAND"), tour ? 5u : group * 8 + 1},
                        {adapter.named(tour ? "SKI_BRD_COMMON" : "LAND"), tour ? 5u : 1u}});
        adapter.assign(board, "openslope_board", group * 8 + 2, "Jump", false,
                       {{adapter.named(tour ? "SKI_BRD_COMMON" : "LAND"), tour ? 4u : group * 8 + 2},
                        {adapter.named(tour ? "SKI_BRD_COMMON" : "LAND"), tour ? 4u : 2u}});
    }
    adapter.assign(rider, "openslope_rider", 32, "Wind", true,
                   {{adapter.named(tour ? "SKI_BRD_COMMON" : "MAIN"), tour ? 1u : 32u}});
    for (unsigned slot = 120; slot <= 122; ++slot)
        adapter.assign(rider, "openslope_rider", slot, "Boost", true,
                       {{adapter.named(tour ? "BOOST" : "MAIN"), tour ? 2u : 122u},
                        {adapter.named(tour ? "BOOST" : "MAIN"), tour ? 1u : 120u}});
    if (adapter.routes.empty())
        return nullptr;
    const auto staging = root / ".openslope-riding-staging";
    const auto backup = root / "SoundIndex.before-riding.json";
    for (const auto& path : {staging, backup, root / "SFX/openslope_board", root / "SFX/openslope_rider"})
        if (std::filesystem::exists(path))
            throw std::runtime_error("Riding audio destination already exists");
    std::uint64_t original = 0;
    unsigned files = 0;
    for (const auto& entry : std::filesystem::recursive_directory_iterator(root)) {
        if (++files > 20000)
            throw std::runtime_error("Audio file count exceeds limit");
        if (entry.is_regular_file())
            original += entry.file_size();
    }
    if (original + adapter.bytes + 1024 * 1024 > 512ull * 1024 * 1024)
        throw std::runtime_error("Course Audio exceeds budget after riding adaptation");
    if (files + adapter.routes.size() * 2 + 8 > 20000)
        throw std::runtime_error("Course Audio file count exceeds limit after riding adaptation");
    if (!std::filesystem::create_directory(staging))
        throw std::runtime_error("Cannot create riding audio staging directory");
    bool published_board = false, published_rider = false, moved_index = false, published_manifest = false;
    try {
        write_audio_bank(staging / "openslope_board", board, [&] { check_cancel(cancel); });
        write_audio_bank(staging / "openslope_rider", rider, [&] { check_cancel(cancel); });
        if (std::any_of(board.slots.begin(), board.slots.end(), [](const auto& slot) { return bool(slot); }))
            index["Banks"]["1"] = "openslope_board";
        if (std::any_of(rider.slots.begin(), rider.slots.end(), [](const auto& slot) { return bool(slot); }))
            index["Banks"]["0"] = "openslope_rider";
        Json manifest = {{"Schema", "openslope-riding-import/v1"},
                         {"Fidelity", "Approximate"},
                         {"Game", tour ? "ssx-on-tour" : "ssx-3"},
                         {"AccountedBytes", adapter.bytes},
                         {"Routes", adapter.routes}};
        write(staging / "SoundIndex.json", index);
        write(staging / "RidingImport.json", manifest);
        check_cancel(cancel);
        std::filesystem::rename(staging / "openslope_board", root / "SFX/openslope_board");
        published_board = true;
        std::filesystem::rename(staging / "openslope_rider", root / "SFX/openslope_rider");
        published_rider = true;
        std::filesystem::rename(root / "SoundIndex.json", backup);
        moved_index = true;
        std::filesystem::rename(staging / "SoundIndex.json", root / "SoundIndex.json");
        std::filesystem::rename(staging / "RidingImport.json", root / "RidingImport.json");
        published_manifest = true;
        std::filesystem::remove(staging);
        return manifest;
    } catch (...) {
        if (moved_index) {
            std::filesystem::remove(root / "SoundIndex.json");
            std::filesystem::rename(backup, root / "SoundIndex.json");
        }
        if (published_manifest)
            std::filesystem::remove(root / "RidingImport.json");
        if (published_board)
            std::filesystem::remove_all(root / "SFX/openslope_board");
        if (published_rider)
            std::filesystem::remove_all(root / "SFX/openslope_rider");
        std::filesystem::remove_all(staging);
        throw;
    }
}
} // namespace import_detail

std::string adapt_riding_audio(const std::filesystem::path& map, const ImportCancel& cancelled) {
    const auto document = read(map / "Import.json");
    const auto game = document.value("Game", "");
    if (game != "ssx-3" && game != "ssx-on-tour")
        throw std::runtime_error("Riding adaptation supports SSX 3 and On Tour maps");
    return import_detail::write_streamed_riding_audio(map, game == "ssx-on-tour", cancelled).dump();
}
} // namespace openslope
