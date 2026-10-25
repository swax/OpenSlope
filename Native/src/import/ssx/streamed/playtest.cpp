#include "import/ssx/formats.hpp"
#include <algorithm>
#include <array>
#include <cctype>
#include <fstream>
#include <nlohmann/json.hpp>
#include <optional>
#include <string_view>

namespace openslope::import_detail {
namespace {
using Json = nlohmann::json;
constexpr const char* reset_id = "openslope-playtest:reset";

std::string lower(std::string name) {
    for (auto& c : name)
        c = char(std::tolower(static_cast<unsigned char>(c)));
    return name;
}

bool contains(const std::string& name, std::initializer_list<const char*> words) {
    return std::any_of(words.begin(), words.end(), [&](const auto* word) { return name.find(word) != name.npos; });
}

// [Trailmap: 519-light] Optional colour data must not make a map unplayable.
std::optional<std::array<double, 3>> average_light(const Json& value) {
    if (!value.is_string())
        return {};
    const auto& text = value.get_ref<const std::string&>();
    if (text.empty() || text.size() % 4 || text.size() > (2 * 1024 * 1024 + 2) / 3 * 4)
        return {};
    std::array<std::uint64_t, 3> sums{};
    std::size_t bytes = 0;
    unsigned low = 0;
    for (std::size_t p = 0; p < text.size(); p += 4) {
        unsigned bits = 0, padding = 0;
        for (unsigned c = 0; c < 4; ++c) {
            const auto ch = text[p + c];
            const auto pos =
                std::string_view("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/").find(ch);
            if (ch == '=' && c >= 2 && p + 4 == text.size()) {
                ++padding;
                bits <<= 6;
            } else if (pos != std::string_view::npos && !padding) {
                bits = (bits << 6) | unsigned(pos);
            } else
                return {};
        }
        if ((padding == 1 && (bits & 0xff)) || (padding == 2 && (bits & 0xffff)))
            return {};
        for (unsigned c = 0; c < 3 - padding; ++c) {
            const auto byte = (bits >> (16 - c * 8)) & 255;
            if (!(bytes++ & 1))
                low = byte;
            else {
                const auto word = low | (byte << 8);
                for (unsigned channel = 0; channel < 3; ++channel)
                    sums[channel] += (word >> (5 * channel)) & 31;
            }
        }
    }
    if (!bytes || bytes % 2 || bytes > 2 * 1024 * 1024)
        return {};
    return std::array<double, 3>{double(sums[0]) * 32 / bytes, double(sums[1]) * 32 / bytes,
                                 double(sums[2]) * 32 / bytes};
}

} // namespace

// [Trailmap: 524] Complete names only; this does not infer a controller or gate.
bool ontour_boundary_helper(const std::string& label) {
    const auto name = lower(label);
    const auto alpha = [](char c) { return c >= 'a' && c <= 'z'; };
    const auto digit = [](char c) { return c >= '0' && c <= '9'; };
    if (!name.starts_with("mdl_") || name.size() < 8 || !alpha(name[4]) || !alpha(name[5]) || !digit(name[6]) ||
        name[7] != '_')
        return false;
    for (const auto* family : {"impassableleft", "impassableright"}) {
        const auto prefix = std::string("mdl_") + name.substr(4, 3) + "_" + family;
        if (name == prefix)
            return true;
        if (name.starts_with(prefix + "_") && name.size() > prefix.size() + 1 &&
            std::all_of(name.begin() + std::ptrdiff_t(prefix.size() + 1), name.end(), digit))
            return true;
    }
    return false;
}

// [Trailmap: 525] Restrict abbreviated trigger names to observed complete families.
bool ontour_course_helper(const std::string& label) {
    if (ontour_boundary_helper(label))
        return true;
    const auto name = lower(label);
    const auto digit = [](char c) { return c >= '0' && c <= '9'; };
    if (!name.starts_with("mdl_") || name.size() < 8 || name[4] < 'a' || name[4] > 'z' || name[5] < 'a' ||
        name[5] > 'z' || !digit(name[6]) || name[7] != '_')
        return false;
    for (const auto* family : {"trg_fw_archlights", "trg_fw_start", "trg_fw_finish", "trg_fw_finish_final"}) {
        const auto prefix = std::string("mdl_") + name.substr(4, 3) + "_" + family;
        if (!name.starts_with(prefix))
            continue;
        auto p = prefix.size();
        bool complete = true;
        while (p < name.size() && name[p] == '_') {
            const auto begin = ++p;
            while (p < name.size() && digit(name[p]))
                ++p;
            if (p == begin) {
                complete = false;
                break;
            }
        }
        if (complete && p == name.size())
            return true;
    }
    return false;
}

bool ontour_course_root(const std::filesystem::path& root) {
    if (lower(root.filename().string()).starts_with("ssxot_"))
        return true;
    for (const auto* name : {"Import.json", "Effects.json"}) {
        const auto path = root / name;
        if (!std::filesystem::is_regular_file(path))
            continue;
        const auto relative =
            std::filesystem::weakly_canonical(path).lexically_relative(std::filesystem::weakly_canonical(root));
        if (relative.empty() || relative.is_absolute() || *relative.begin() == ".." ||
            std::filesystem::file_size(path) > 64 * 1024 * 1024)
            throw std::runtime_error("Invalid boundary source metadata");
        std::ifstream stream(path);
        const auto metadata = Json::parse(stream, nullptr, false);
        if (!metadata.is_object())
            continue;
        const auto context =
            std::string_view(name) == "Import.json" ? metadata : metadata.value("target", Json::object());
        if (!context.is_object())
            continue;
        const auto field = context.find(std::string_view(name) == "Import.json" ? "Game" : "game");
        if (field != context.end() && field->is_string() && !field->get_ref<const std::string&>().empty())
            return field->get_ref<const std::string&>() == "ssx-on-tour";
    }
    return false;
}

unsigned prepare_ontour_helpers(Json& instances, const Json& models) {
    unsigned changed = 0;
    for (auto& row : instances) {
        const auto model = row.value("ModelID", std::size_t(-1));
        if (!ontour_course_helper(row.value("InstanceName", "")) &&
            !(model < models.size() && ontour_course_helper(models[model].value("ModelName", ""))))
            continue;
        const auto before = row;
        const auto mode = row.value("CollsionMode", 0);
        const auto paths = row.find("CollsionModelPaths");
        const bool shape = mode == 2 || (mode == 1 && paths != row.end() && paths->is_array() && !paths->empty()) ||
                           (mode == 3 && row.value("PhysicsIndex", -1) >= 0);
        row["Visable"] = false;
        row["PlayerCollision"] = shape;
        row["PlayerBounce"] = false;
        row["U0"] = 0;
        row["SurfaceType"] = -1;
        changed += row != before;
    }
    return changed;
}

unsigned repair_ontour_helper_instances(const std::filesystem::path& root, Json& instances) {
    if (!ontour_course_root(root))
        return 0;
    Json models = Json::array();
    const auto path = root / "Models.json";
    if (std::filesystem::is_regular_file(path)) {
        const auto relative =
            std::filesystem::weakly_canonical(path).lexically_relative(std::filesystem::weakly_canonical(root));
        if (relative.empty() || relative.is_absolute() || *relative.begin() == ".." ||
            std::filesystem::file_size(path) > 64 * 1024 * 1024)
            throw std::runtime_error("Invalid boundary model metadata");
        std::ifstream stream(path);
        models = Json::parse(stream).at("Models");
        if (!models.is_array() || models.size() > 16384)
            throw std::runtime_error("Invalid boundary model table");
    }
    return prepare_ontour_helpers(instances, models);
}

// [Trailmap: 513-helpers, 513-helper-proxies, 519-helpers] Ordinary fence art
// and noCollision art remain distinct from permanent proxies and script helpers.
std::pair<bool, bool> streamed_prop_admission(const std::string& label, bool debug) {
    const auto name = lower(label);
    bool collision = contains(name, {"proxy", "fence_coll_plane"});
    for (auto p = name.find("collision"); p != std::string::npos; p = name.find("collision", p + 1))
        collision = collision || p < 2 || name.substr(p - 2, 2) != "no";
    bool trigger = false;
    for (auto p = name.find("trig"); p != std::string::npos; p = name.find("trig", p + 1))
        trigger = trigger || p + 4 == name.size() || name[p + 4] != 'h';
    const bool load = name.ends_with("_load") || name.ends_with("_unload") ||
                      contains(name, {"_load_", "_unload_", "loadbox", "unloadbox"});
    const bool scripted =
        trigger || load || contains(name, {"reset", "volume", "teleport", "ridestate", "emit", "nis_"});
    const bool fence = collision && !contains(name, {"nis"});
    const bool hidden = debug || fence || scripted || contains(name, {"occluder", "portal", "invis"});
    const bool solid = !hidden || ((fence || (debug && contains(name, {"fence", "impassable"}))) && !scripted &&
                                   !contains(name, {"start", "end", "nis"}));
    return {!hidden, solid};
}

// [Trailmap: 521-retirement, 521-native] Retain array positions and identities.
void retire_streamed_reset_bindings(Json& effects) {
    for (auto& slot : effects.at("slots"))
        if (slot.value("id", "") == std::string(reset_id) + ":slot" &&
            slot.at("circumstances").value("collision", Json{}) == reset_id)
            slot["circumstances"]["collision"] = nullptr;
}

// [Trailmap: 519-light, 521-retirement] Names do not establish reset activation.
Json streamed_playtest_props(Json& instances, Json& effects, const ImportCancel& cancel) {
    Json report = {{"Schema", "openslope-playtest-import/v4"},
                   {"Fidelity", "Approximate"},
                   {"HelpersHidden", 0},
                   {"HelperWallsRemoved", 0},
                   {"ResetZonesAdded", 0},
                   {"ResetZonesRetired", 0},
                   {"LightingTints", 0}};
    int own_slot = -1;
    const auto& slots = effects.at("slots");
    if (!slots.is_array() || slots.size() >= 4096)
        throw std::runtime_error("Playtest effect slot exceeds limit");
    const auto next_slot = int(slots.size());
    for (int index = 0; index < next_slot; ++index) {
        const auto& slot = slots[std::size_t(index)];
        if (slot.value("id", "") == std::string(reset_id) + ":slot")
            own_slot = index;
    }
    for (const auto& row : instances) {
        const auto index = row.value("EffectSlotIndex", -1);
        if (index >= next_slot)
            throw std::runtime_error("Playtest instance references a missing effect slot");
    }
    retire_streamed_reset_bindings(effects);
    for (auto& row : instances) {
        check_cancel(cancel);
        const auto name = lower(row.value("InstanceName", ""));
        const auto [visible, solid] = streamed_prop_admission(name, false);
        const bool own_reset = own_slot >= 0 && row.value("EffectSlotIndex", -1) == own_slot;
        if (own_reset) {
            row["EffectSlotIndex"] = -1;
            row["PlayerCollision"] = false;
            report["ResetZonesRetired"] = report["ResetZonesRetired"].get<unsigned>() + 1;
        }
        if (!visible && row.value("Visable", true)) {
            row["Visable"] = false;
            report["HelpersHidden"] = report["HelpersHidden"].get<unsigned>() + 1;
        }
        if (!solid && row.value("PlayerCollision", false)) {
            row["PlayerCollision"] = false;
            report["HelperWallsRemoved"] = report["HelperWallsRemoved"].get<unsigned>() + 1;
        }
        const auto ambient = row.value("AmbentLightColour", Json{128, 128, 128, 128});
        if (!ambient.is_array() || ambient.size() != 4 || ambient[0] != 128 || ambient[1] != 128 || ambient[2] != 128 ||
            row.contains("LightColour1") || row.contains("LightColour2") || row.contains("LightColour3"))
            continue;
        if (const auto average = average_light(row.value("VertexLighting", Json{}))) {
            Json tint = {(*average)[0], (*average)[1], (*average)[2], ambient[3]};
            if (tint != ambient) {
                row["AmbentLightColour"] = tint;
                report["LightingTints"] = report["LightingTints"].get<unsigned>() + 1;
            }
        }
    }
    return report;
}

unsigned streamed_playtest_lights(Json& document) {
    unsigned changed = 0;
    for (auto& row : document.at("Lights")) {
        const auto before = row;
        if (row.value("Type", -1) == 1 && !row.contains("UnknownFloat2") && row.contains("OuterConeCosine"))
            row["UnknownFloat2"] = row.at("OuterConeCosine");
        if (row.value("Type", -1) == 2 && row.value("LightName", "").starts_with("Halo ")) {
            if (row.value("UnknownFloat1", 0.) == 0)
                row["UnknownFloat1"] = 1;
            row["LowestXYZ"] = row.at("Position");
            row["HighestXYZ"] = row.at("Position");
        }
        changed += row != before;
    }
    return changed;
}
} // namespace openslope::import_detail

namespace openslope {
// [Trailmap: 519-repair] Publish only changed common documents, with originals
// retained and a reversible transaction. Never touch geometry, source or audio.
std::string polish_streamed_map(const std::filesystem::path& map, const ImportCancel& cancel) {
    using Json = nlohmann::json;
    const auto root = std::filesystem::canonical(map);
    auto read = [&](const char* name) {
        const auto path = root / name;
        if (std::filesystem::is_symlink(std::filesystem::symlink_status(path)) ||
            std::filesystem::file_size(path) > 128 * 1024 * 1024)
            throw std::runtime_error("Invalid playtest map document");
        std::ifstream file(path);
        return Json::parse(file);
    };
    const auto game = read("Import.json").value("Game", "");
    if (game != "ssx-3" && game != "ssx-on-tour")
        throw std::runtime_error("Playtest polish supports only streamed SSX3 and On Tour maps");
    std::map<std::string, Json> documents;
    for (const auto* name : {"Instances.json", "Effects.json", "Lights.json"})
        documents.emplace(name, read(name));
    const auto original = documents;
    auto report = import_detail::streamed_playtest_props(documents.at("Instances.json").at("Instances"),
                                                         documents.at("Effects.json"), cancel);
    report["CourseHelpersPrepared"] =
        game == "ssx-on-tour"
            ? import_detail::repair_ontour_helper_instances(root, documents.at("Instances.json").at("Instances"))
            : 0;
    report["LightsPatched"] = import_detail::streamed_playtest_lights(documents.at("Lights.json"));
    for (auto it = documents.begin(); it != documents.end();)
        if (it->second == original.at(it->first))
            it = documents.erase(it);
        else
            ++it;
    if (documents.empty())
        return "Playtest polish already current: " + root.filename().string();
    documents.emplace("PlaytestImport.json", report);
    const auto staging = root / ".openslope-playtest-staging", backup = root / "PlaytestBackup-v4";
    const auto known_report = [&] {
        if (!std::filesystem::exists(root / "PlaytestImport.json"))
            return true;
        const auto schema = read("PlaytestImport.json").value("Schema", "");
        return schema == "openslope-playtest-import/v1" || schema == "openslope-playtest-import/v2" ||
               schema == "openslope-playtest-import/v3";
    };
    if (std::filesystem::exists(staging) || std::filesystem::exists(backup) || !known_report())
        throw std::runtime_error("Conflicting playtest backup/report; preserve or restore it before another repair");
    std::filesystem::create_directory(staging);
    std::vector<std::string> moved, published;
    try {
        std::filesystem::create_directory(staging / "before");
        std::filesystem::create_directory(staging / "after");
        for (const auto& [name, document] : documents) {
            import_detail::check_cancel(cancel);
            std::ofstream file(staging / "after" / name, std::ios::binary);
            file << document.dump() << '\n';
            if (!file)
                throw std::runtime_error("Cannot stage playtest document");
        }
        for (const auto& [name, unused] : documents) {
            import_detail::check_cancel(cancel);
            if (std::filesystem::exists(root / name)) {
                std::filesystem::rename(root / name, staging / "before" / name);
                moved.push_back(name);
            }
            std::filesystem::rename(staging / "after" / name, root / name);
            published.push_back(name);
        }
        import_detail::check_cancel(cancel);
        std::filesystem::rename(staging / "before", backup);
    } catch (...) {
        for (const auto& name : published)
            std::filesystem::remove(root / name);
        for (const auto& name : moved)
            std::filesystem::rename(staging / "before" / name, root / name);
        std::filesystem::remove_all(staging);
        throw;
    }
    std::filesystem::remove_all(staging);
    return report.dump();
}
} // namespace openslope
