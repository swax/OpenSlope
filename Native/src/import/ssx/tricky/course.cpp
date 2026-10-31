#include "import/ssx/formats.hpp"
#include "import/strings.hpp"
#include "openslope/collision.hpp"
#include "openslope/particles.hpp"
#include "openslope/paths.hpp"
#include "openslope/props.hpp"
#include "openslope/rails.hpp"
#include "openslope/terrain.hpp"
#include "openslope/world.hpp"
#include "openslope/world_import.hpp"
#include "openslope/world_logic.hpp"
#include <algorithm>
#include <array>
#include <cctype>
#include <fstream>
#include <map>
#include <nlohmann/json.hpp>
#include <set>
#include <sstream>

namespace openslope::import_detail {
using Json = nlohmann::json;

void pbd_header(Bytes b) {
    b.range(0, 136);
    if (b.le(0) != 0x011b1500)
        throw std::runtime_error("Only SSX Tricky PS2 courses are supported by this importer");
    if (b.le(44) > 4000)
        throw std::runtime_error("PBD model count exceeds its format limit");
}

namespace {
std::string trim(std::string s) {
    while (!s.empty() && (s.back() == ' ' || s.back() == '\r'))
        s.pop_back();
    return s;
}

const std::vector<std::uint8_t>& member(const std::map<std::string, std::vector<std::uint8_t>>& files,
                                        const std::string& name) {
    const auto it = files.find(upper(name));
    if (it == files.end())
        throw std::runtime_error("Level archive is missing " + name);
    return it->second;
}

std::vector<std::string> patch_names(const std::vector<std::uint8_t>& bytes, std::size_t count) {
    const std::string text(bytes.begin(), bytes.end());
    std::istringstream stream(text);
    std::string line;
    bool in_section = false;
    std::vector<std::string> result;
    while (std::getline(stream, line)) {
        line = trim(line);
        if (!in_section) {
            if (line.starts_with('#')) {
                const auto start = line.find_first_not_of('#');
                if (start == std::string::npos)
                    continue;
                auto label = line.substr(start);
                while (!label.empty() && label.front() == ' ')
                    label.erase(0, 1);
                if (label == "PATCHES BEGIN")
                    in_section = true;
            }
            continue;
        }
        if (line.empty()) {
            if (!result.empty())
                break;
            continue;
        }
        if (line.front() == '#')
            continue;
        if (line.size() < 82)
            throw std::runtime_error("Invalid map linker row");
        result.push_back(trim(line.substr(0, 82)));
        if (result.size() > count)
            throw std::runtime_error("Too many patch linker rows");
    }
    if (result.size() != count)
        throw std::runtime_error("Patch linker count disagrees with PBD");
    return result;
}

Json patches(const std::vector<std::uint8_t>& raw, const std::vector<std::uint8_t>& linker,
             const std::vector<import_detail::Image>& images) {
    Bytes b{raw};
    pbd_header(b);
    const auto count = b.le(8), offset = b.le(68);
    if (!count || count > 100000)
        throw std::runtime_error("Invalid PBD patch count");
    b.range(offset, std::size_t(count) * 448);
    const auto names = patch_names(linker, count);
    return Json::parse(import_detail::patch_document(b.data.subspan(offset, std::size_t(count) * 448), names, images));
}

void write_json(const std::filesystem::path& path, const Json& document) {
    std::ofstream stream(path, std::ios::binary);
    stream << document.dump() << '\n';
    if (!stream)
        throw std::runtime_error("Cannot write map output");
}
} // namespace

void write_tricky_course(const DiscInput& disc, const std::map<std::string, std::vector<std::uint8_t>>& files,
                         const std::string& stem, const std::filesystem::path& output, const ImportProgress& progress,
                         const ImportCancel& cancelled) {
    const auto notify = [&](const std::string& text) {
        check_cancel(cancelled);
        if (progress)
            progress(text);
    };
    pbd_header(Bytes{member(files, stem + ".PBD")});
    notify("Decoding textures");
    auto images = import_detail::decode_ssh(member(files, stem + ".SSH"), false, cancelled);
    std::filesystem::create_directory(output / "Textures");
    for (const auto& image : images) {
        notify("Texture " + image.name);
        import_detail::write_png(output / "Textures" / (image.name + ".png"), image);
    }
    // [Trailmap: 210-lightmap-profile] Long course stems may shorten the
    // lightmap sidecar name by one character.
    const auto lightmap_name =
        files.contains(stem + "_L.SSH") ? stem + "_L.SSH" : stem.substr(0, stem.size() - 1) + "_L.SSH";
    const auto lightmaps = import_detail::decode_ssh(member(files, lightmap_name), true, cancelled);
    std::filesystem::create_directory(output / "Lightmaps");
    for (const auto& image : lightmaps) {
        notify("Lightmap " + image.name);
        import_detail::write_png(output / "Lightmaps" / (image.name + ".png"), image);
    }
    notify("Converting terrain");
    const auto document = patches(member(files, stem + ".PBD"), member(files, stem + ".MAP"), images);
    for (const auto& row : document.at("Patches")) {
        const auto id = row.at("LightmapID").get<int>();
        if (id < 0 || static_cast<std::size_t>(id) >= lightmaps.size())
            throw std::runtime_error("Terrain references a missing lightmap");
    }
    write_json(output / "Patches.json", document);
    notify("Converting static object models and placements");
    const auto behavior = files.find(stem + ".SSF");
    import_detail::write_props(member(files, stem + ".PBD"), member(files, stem + ".MAP"), images,
                               behavior == files.end() ? nullptr : &behavior->second, output, cancelled);
    Json outputs = {"Patches.json", "Origin.json",    "Textures",       "Lightmaps",
                    "Models.json",  "Instances.json", "Materials.json", "Meshes"};
    notify("Converting analytic rail splines");
    import_detail::write_rails(member(files, stem + ".PBD"), member(files, stem + ".MAP"),
                               behavior == files.end() ? nullptr : &behavior->second, output, cancelled);
    outputs.push_back("Splines.json");
    // [Trailmap: 220-model-header, 400-backdrop] The backdrop uses the same
    // model format, with its own art bank and no world-placement linker.
    const bool sky = files.contains(stem + "_SKY.PBD") || files.contains(stem + "_SKY.SSH");
    if (sky) {
        notify("Converting camera-centred sky panorama");
        const auto geometry_name = stem + "_SKY.PBD";
        const auto& geometry = member(files, geometry_name);
        pbd_header(Bytes{geometry});
        const auto art = import_detail::decode_ssh(member(files, stem + "_SKY.SSH"), false, cancelled);
        std::filesystem::create_directories(output / "Skybox/Textures");
        for (const auto& image : art)
            import_detail::write_png(output / "Skybox/Textures" / (image.name + ".png"), image);
        import_detail::write_props(geometry, {}, art, nullptr, output / "Skybox", cancelled, true);
        outputs.push_back("Skybox");
    }
    if (behavior != files.end()) {
        notify("Converting authored collision, physics and effect graphs");
        import_detail::write_collision(behavior->second, output, cancelled);
        import_detail::write_logic(behavior->second, output, stem, cancelled);
        outputs.push_back("Collision");
        outputs.push_back("Physics.json");
        outputs.push_back("Effects.json");
    }
    notify("Recovering course sun and sky settings");
    write_json(output / "Lights.json", Json::parse(import_detail::light_document(member(files, stem + ".PBD"))));
    outputs.push_back("Lights.json");
    const auto world = disc_world_profile(disc, stem, cancelled);
    if (!world.empty()) {
        write_json(output / "World.json", Json::parse(world));
        outputs.push_back("World.json");
    }
    for (const auto kind : {"AIP", "SOP"}) {
        const auto it = files.find(stem + "." + kind);
        if (it != files.end()) {
            notify(std::string("Converting ") + kind + " paths");
            const auto name = std::string(kind) + ".json";
            import_detail::write_paths(it->second, output / name, cancelled);
            outputs.push_back(name);
        }
    }
    notify("Converting course audio");
    const auto audio = import_detail::write_course_audio(disc, stem, files, output, progress, cancelled);
    if (audio)
        outputs.push_back("Audio");
    const auto directories = disc_directory(disc, "DATA");
    if (std::any_of(directories.begin(), directories.end(),
                    [](const auto& e) { return e.directory && upper(e.name) == "TEXTURES"; })) {
        const auto textures = disc_directory(disc, "DATA/TEXTURES");
        if (std::any_of(textures.begin(), textures.end(),
                        [](const auto& e) { return !e.directory && upper(e.name) == "CROWD.SSH"; })) {
            notify("Converting shared crowd frames");
            import_detail::write_crowd(disc_file(disc, "DATA/TEXTURES/CROWD.SSH"), output, cancelled);
            outputs.push_back("Crowd.json");
        }
        if (std::any_of(textures.begin(), textures.end(),
                        [](const auto& e) { return !e.directory && upper(e.name) == "PARTICLE.SSH"; })) {
            notify("Converting shared particle sprites");
            const auto sprites =
                import_detail::decode_ssh(disc_file(disc, "DATA/TEXTURES/PARTICLE.SSH"), false, cancelled, true);
            Json bank = Json::object();
            for (const auto& sprite : sprites) {
                notify("Particle sprite " + sprite.name);
                const auto name = "particle-" + sprite.name + ".png";
                if (std::filesystem::exists(output / "Textures" / name))
                    throw std::runtime_error("Particle sprite conflicts with a course texture");
                import_detail::write_png(output / "Textures" / name, sprite);
                bank[sprite.name] = name;
            }
            if (bank.contains("part") || bank.contains("tral") || bank.contains("spry")) {
                Json profile = {{"Schema", "openslope-riding-effects/v1"},
                                {"Enabled", true},
                                {"SpriteBank", bank},
                                {"Profile", "native-riding-effects/v3"}};
                profile["EmitterSprites"] = Json::array();
                for (const auto& sprite : particle_sprite_names())
                    profile["EmitterSprites"].push_back(bank.contains(sprite) ? bank[sprite] : Json(""));
                for (const auto& [sprite, slot] :
                     {std::pair{"part", "Puff"}, std::pair{"tral", "Wake"}, std::pair{"spry", "Sheet"}})
                    if (bank.contains(sprite))
                        profile[slot] = bank[sprite];
                write_json(output / "RidingEffects.json", profile);
                outputs.push_back("RidingEffects.json");
            }
        }
    }
    write_json(output / "Origin.json", {{"Schema", "openslope-origin/v1"},
                                        {"Game", "ssx-tricky"},
                                        {"Origin", "retail"},
                                        {"Course", stem},
                                        {"RetailData", true},
                                        {"Reasons", {"retail-extract"}}});
    // Lossless local source sidecars support later importer stages without
    // reselecting the ISO. They are not a replacement for portable contracts.
    std::filesystem::create_directory(output / "Source");
    for (const auto& [name, bytes] : files) {
        notify("Saving source " + name);
        std::ofstream stream(output / "Source" / name, std::ios::binary);
        stream.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
        if (!stream)
            throw std::runtime_error("Cannot write source sidecar");
    }
    Json deferred = {"live-object-effects", "effects", "world", "audio-resolvers", "audio-runtime"};
    if (behavior == files.end())
        deferred.push_back("rail-candidacy");
    if (!sky)
        deferred.push_back("skybox");
    if (!audio)
        deferred.push_back("audio-assets");
    write_json(output / "Import.json", {{"Schema", "openslope-native-import/v1"},
                                        {"Game", "ssx-tricky"},
                                        {"Course", stem},
                                        {"Complete", false},
                                        {"Outputs", outputs},
                                        {"Deferred", deferred}});
    notify("Validating map");
    static_cast<void>(Terrain::load(output));
    static_cast<void>(Props::load(output));
    static_cast<void>(World::load(output));
    static_cast<void>(Rails::load(output));
    static_cast<void>(CoursePaths::load(output));
    static_cast<void>(CollisionWorld::load(output));
    static_cast<void>(WorldLogic::load(output));
}
} // namespace openslope::import_detail
