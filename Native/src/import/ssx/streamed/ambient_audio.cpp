#include "import/ssx/formats.hpp"
#include "openslope/audio_data.hpp"
#include "riding_audio_condition.hpp"
#include <algorithm>
#include <cctype>
#include <fstream>
#include <nlohmann/json.hpp>
#include <set>

namespace openslope {
namespace {
using Json = nlohmann::json;

Json read(const std::filesystem::path& path) {
    if (std::filesystem::file_size(path) > 64 * 1024 * 1024)
        throw std::runtime_error("Ambient metadata exceeds limit");
    std::ifstream stream(path);
    return Json::parse(stream);
}

void write(const std::filesystem::path& path, const Json& value) {
    std::ofstream stream(path, std::ios::binary);
    stream << value.dump() << '\n';
    if (!stream)
        throw std::runtime_error("Cannot save ambient metadata");
}

std::string lower(std::string name) {
    for (auto& c : name)
        c = char(std::tolower(static_cast<unsigned char>(c)));
    return name;
}

std::string role(const std::string& name) {
    const auto has = [&](const char* token) { return name.find(token) != std::string::npos; };
    if (has("crowd"))
        return "Crowd";
    if (has("chairpole") || has("lifttower") || has("chairlift"))
        return "Lift";
    if (has("gondola") || has("stationg"))
        return "Gondola";
    if (has("flag"))
        return "Flag";
    if (has("lodge"))
        return "Lodge";
    if (has("flamestack"))
        return "Fire";
    if (has("waterfall"))
        return "Waterfall";
    return {};
}

std::string stem(unsigned slot) {
    auto name = std::to_string(slot);
    name.insert(0, 3 - std::min<std::size_t>(3, name.size()), '0');
    return name;
}
} // namespace

namespace import_detail {
// [Trailmap: 523] Explicit application approximation over source-owned emitters.
Json write_streamed_ambient_audio(const std::filesystem::path& map, bool tour, const ImportCancel& cancel) {
    const auto root = std::filesystem::weakly_canonical(map), audio = root / "Audio";
    for (const auto& path : {audio, audio / "SFX", audio / ".openslope-ambient-staging",
                             audio / "SFX/openslope_ambient", audio / "Instances.before-ambience.json"}) {
        const auto relative = std::filesystem::weakly_canonical(path).lexically_relative(root);
        if (relative.empty() || relative.is_absolute() || *relative.begin() == "..")
            throw std::runtime_error("Ambient destination escapes map");
    }
    if (!std::filesystem::is_regular_file(root / "SoundBindings.json"))
        return nullptr;
    const auto manifest_path = audio / "AmbientImport.json";
    if (std::filesystem::exists(manifest_path)) {
        const auto existing = read(manifest_path);
        if (existing.value("Schema", "") != "openslope-ambient-import/v1" ||
            existing.value("Game", "") != (tour ? "ssx-on-tour" : "ssx-3") ||
            !std::filesystem::is_regular_file(audio / "SFX/openslope_ambient/bank.json"))
            throw std::runtime_error("Conflicting ambient adapter");
        return existing;
    }
    auto document = read(root / "Instances.json");
    auto& instances = document.at("Instances");
    const auto bindings = read(root / "SoundBindings.json");
    if (bindings.value("Schema", "") != "openslope-streamed-sound-bindings/v1" ||
        bindings.value("Game", "") != (tour ? "ssx-on-tour" : "ssx-3"))
        throw std::runtime_error("Invalid streamed sound bindings");
    const auto index = read(audio / "SoundIndex.json");
    std::map<std::uint32_t, std::size_t> placements;
    for (std::size_t i = 0; i < instances.size(); ++i)
        if (instances[i].contains("SourceResource"))
            placements.emplace(instances[i].at("SourceResource").get<std::uint32_t>(), i);
    std::map<int, std::map<std::string, std::set<std::uint32_t>>> hints;
    for (const auto& row : bindings.at("Bindings")) {
        check_cancel(cancel);
        const auto source = row.at("SourceResource").get<std::uint32_t>();
        const auto found = placements.find(source);
        if (found == placements.end())
            continue;
        const auto kind = role(lower(instances[found->second].value("InstanceName", "")));
        if (kind.empty())
            continue;
        for (const auto& sound : row.at("ExternalSounds"))
            hints[sound.at("SoundIndex").get<int>()][kind].insert(source);
    }
    const auto named = [&](const std::string& key) { return index.at("NamedBanks").value(key, key); };
    std::map<std::string, std::vector<std::pair<std::string, unsigned>>> choices;
    if (tour) {
        choices = {{"Crowd", {{named("CROWD_MED_CHANT"), 1}, {named("CROWD_MED_CHANT_02"), 1}}},
                   {"Lift", {{named("EMTR_CHAIRLIFT"), 1}}},
                   {"Gondola", {{named("EMTR_GONDOLA_BASE"), 1}, {named("EMTR_GONDOLA"), 1}}},
                   {"Flag", {{named("EMTR_FLAGRUSTLE"), 1}, {named("EMTR_YETTI_FLAG"), 1}}},
                   {"Waterfall", {{named("EMTR_WATER_FALL"), 1}}}};
    } else {
        choices = {{"Crowd", {{named("CROWD"), 0}, {named("CROWD"), 1}, {named("CROWD"), 2}}},
                   {"Flag", {{"FlagWind_loop", 0}}},
                   {"Lodge", {{"PartyLodge", 0}}},
                   {"Fire", {{"Culdron", 0}}},
                   {"Waterfall", {{"Waterfall1", 0}}}};
    }
    AudioBank bank;
    Json routes = Json::array();
    std::map<int, unsigned> events;
    std::map<std::pair<std::string, unsigned>, unsigned> reused;
    std::map<std::string, unsigned> variants;
    std::uint64_t generated = 0;
    for (const auto& [event, candidates] : hints) {
        if (event <= 0)
            continue;
        std::string kind;
        std::size_t best = 0;
        bool tied = false;
        for (const auto& [candidate, owners] : candidates)
            if (owners.size() > best) {
                kind = candidate;
                best = owners.size();
                tied = false;
            } else if (owners.size() == best)
                tied = true;
        if (tied || !choices.contains(kind))
            continue;
        auto options = choices.at(kind);
        if (kind == "Crowd") {
            const auto shift = variants[kind]++ % options.size();
            std::rotate(options.begin(), options.begin() + shift, options.end());
        }
        for (const auto& [source_bank, source_slot] : options) {
            check_cancel(cancel);
            if (!valid_map_name(source_bank))
                continue;
            const auto folder = std::filesystem::weakly_canonical(audio / "SFX" / source_bank);
            const auto relative = folder.lexically_relative(root);
            if (relative.empty() || relative.is_absolute() || *relative.begin() == "..")
                throw std::runtime_error("Ambient source escapes map");
            const auto file = folder / (stem(source_slot) + ".wav");
            if (!std::filesystem::is_regular_file(file) || !std::filesystem::exists(folder / "bank.json"))
                continue;
            const auto metadata = read(folder / "bank.json");
            const auto& slots = metadata.at("Slots");
            if (source_slot >= slots.size() || slots[source_slot].is_null())
                continue;
            const auto& info = slots[source_slot];
            const auto first = info.value("LoopStart", std::size_t(0)), end = info.value("LoopEnd", std::size_t(0));
            if (!end || first >= end)
                continue;
            if (std::filesystem::file_size(file) > 64 * 1024 * 1024)
                throw std::runtime_error("Ambient source WAV exceeds limit");
            const auto key = std::pair{source_bank, source_slot};
            unsigned slot;
            if (reused.contains(key))
                slot = reused.at(key);
            else {
                auto clip = PcmClip::load(file);
                if (end > clip.frames())
                    throw std::runtime_error("Invalid ambient loop interval");
                if (double(end - first) / clip.rate < .75)
                    continue;
                PcmClip loop;
                loop.rate = clip.rate;
                loop.channels = clip.channels;
                loop.samples = {clip.samples.begin() + first * clip.channels,
                                clip.samples.begin() + end * clip.channels};
                loop.loop_end = loop.frames();
                condition_riding_audio(loop, "openslope_board", 4);
                const auto bytes = 88 + loop.samples.size() * 4;
                if (bytes > 128 * 1024 * 1024 - generated)
                    throw std::runtime_error("Ambient bank exceeds budget");
                generated += bytes;
                slot = unsigned(bank.slots.size());
                bank.slots.push_back(std::move(loop));
                reused.emplace(key, slot);
            }
            events[event] = slot;
            routes.push_back({{"Event", event},
                              {"Role", kind},
                              {"OwnerHints", best},
                              {"SourceBank", source_bank},
                              {"SourceSlot", source_slot},
                              {"Slot", slot}});
            break;
        }
    }
    std::map<std::size_t, Json> attached;
    unsigned deferred = 0, count = 0;
    std::set<std::pair<std::uint32_t, std::string>> seen;
    for (const auto& row : bindings.at("Bindings")) {
        check_cancel(cancel);
        const auto source = row.at("SourceResource").get<std::uint32_t>();
        const auto found = placements.find(source);
        for (auto sound : row.at("ExternalSounds")) {
            const auto event = sound.at("SoundIndex").get<int>();
            if (found == placements.end() || !events.contains(event) || sound.at("U0").get<unsigned>() > 2) {
                ++deferred;
                continue;
            }
            auto& instance = instances[found->second];
            if ((instance.contains("Sounds") && !instance.at("Sounds").is_null()) ||
                (instance.contains("IncludeSound") && !instance.at("IncludeSound").get<bool>()))
                continue;
            if (!seen.emplace(source, sound.dump()).second)
                continue;
            sound["SoundBank"] = "openslope_ambient";
            sound["SoundSlot"] = events.at(event);
            sound["Activation"] = "Proximity";
            attached.try_emplace(found->second, Json::array()).first->second.push_back(sound);
            ++count;
        }
    }
    for (const auto& [i, sounds] : attached) {
        instances[i]["IncludeSound"] = true;
        instances[i]["Sounds"] = {{"CollisonSound", -1}, {"ExternalSounds", sounds}};
    }
    Json manifest = {{"Schema", "openslope-ambient-import/v1"},
                     {"Game", tour ? "ssx-on-tour" : "ssx-3"},
                     {"Fidelity", "Approximate"},
                     {"Emitters", count},
                     {"DeferredEmitters", deferred},
                     {"AccountedBytes", generated},
                     {"Routes", routes}};
    const auto staging = audio / ".openslope-ambient-staging", target = audio / "SFX/openslope_ambient",
               backup = audio / "Instances.before-ambience.json";
    for (const auto& path : {staging, target, backup})
        if (std::filesystem::exists(path))
            throw std::runtime_error("Ambient destination already exists");
    std::uint64_t bytes = 0;
    unsigned files = 0;
    for (const auto& entry : std::filesystem::recursive_directory_iterator(audio)) {
        check_cancel(cancel);
        if (++files > 20000)
            throw std::runtime_error("Ambient audio file count exceeds limit");
        if (entry.is_regular_file())
            bytes += entry.file_size();
    }
    if (files + bank.slots.size() * 2 + 4 > 20000 ||
        bytes + generated + std::filesystem::file_size(root / "Instances.json") + manifest.dump().size() + 1024 * 1024 >
            512ull * 1024 * 1024)
        throw std::runtime_error("Course Audio exceeds ambient budget");
    std::filesystem::create_directory(staging);
    bool published = false, moved = false, reported = false;
    try {
        write_audio_bank(staging / "openslope_ambient", bank, [&] { check_cancel(cancel); });
        write(staging / "Instances.json", document);
        write(staging / "AmbientImport.json", manifest);
        check_cancel(cancel);
        std::filesystem::rename(staging / "openslope_ambient", target);
        published = true;
        std::filesystem::rename(root / "Instances.json", backup);
        moved = true;
        std::filesystem::rename(staging / "Instances.json", root / "Instances.json");
        std::filesystem::rename(staging / "AmbientImport.json", manifest_path);
        reported = true;
        std::filesystem::remove(staging);
    } catch (...) {
        if (moved) {
            std::filesystem::remove(root / "Instances.json");
            std::filesystem::rename(backup, root / "Instances.json");
        }
        if (reported)
            std::filesystem::remove(manifest_path);
        if (published)
            std::filesystem::remove_all(target);
        std::filesystem::remove_all(staging);
        throw;
    }
    return manifest;
}
} // namespace import_detail

std::string adapt_course_ambience(const std::filesystem::path& map, const ImportCancel& cancel) {
    const auto game = read(map / "Import.json").value("Game", "");
    if (game != "ssx-3" && game != "ssx-on-tour")
        throw std::runtime_error("Unsupported ambience game");
    if (!std::filesystem::is_regular_file(map / "SoundBindings.json"))
        throw std::runtime_error("Course ambience requires streamed SoundBindings.json");
    return import_detail::write_streamed_ambient_audio(map, game == "ssx-on-tour", cancel).dump();
}
} // namespace openslope
