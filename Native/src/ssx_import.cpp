#include "import_internal.hpp"
#include "openslope/collision.hpp"
#include "openslope/paths.hpp"
#include "openslope/props.hpp"
#include "openslope/rails.hpp"
#include "openslope/terrain.hpp"
#include "openslope/world.hpp"
#include "openslope/world_logic.hpp"
#include <fstream>
#include <nlohmann/json.hpp>
#include <set>

namespace openslope::import_detail {
namespace {
using Json = nlohmann::json;
using Buffer = std::vector<std::uint8_t>;

void write(const std::filesystem::path& path, const Json& doc) {
    const auto text = doc.dump();
    if (text.size() > 64 * 1024 * 1024)
        throw std::runtime_error("SSX portable document exceeds its limit");
    std::ofstream file(path, std::ios::binary);
    file << text << '\n';
    if (!file)
        throw std::runtime_error("Cannot write SSX map document");
}

Json vector(Bytes b, std::size_t p) { return Json::array({b.number(p), b.number(p + 4), b.number(p + 8)}); }

void append(Buffer& to, Bytes from, std::size_t p, std::size_t size) {
    from.range(p, size);
    if (to.size() + size > 64 * 1024 * 1024)
        throw std::runtime_error("SSX world array exceeds its limit");
    to.insert(to.end(), from.data.begin() + std::ptrdiff_t(p), from.data.begin() + std::ptrdiff_t(p + size));
}

void word(Buffer& to, std::size_t p, std::uint32_t value) {
    Bytes{to}.range(p, 4);
    for (unsigned j = 0; j < 4; ++j)
        to[p + j] = std::uint8_t(value >> (j * 8));
}

Json paths(Bytes b, std::size_t& p, unsigned count, bool race, const ImportCancel& cancel) {
    if (count > 4000)
        throw std::runtime_error("SSX path count exceeds its limit");
    Json rows = Json::array();
    for (unsigned i = 0; i < count; ++i) {
        check_cancel(cancel);
        b.range(p, 48);
        const auto points = b.le(p + 4), events = b.le(p + 8);
        if (points > 100000 || events > 100000)
            throw std::runtime_error("SSX path extent exceeds its limit");
        Json row = {{"Name", std::string(race ? "Race Line " : "AI Path ") + std::to_string(i)},
                    {"PathPos", vector(b, p + 12)},
                    {"PathPoints", Json::array()},
                    {"PathEvents", Json::array()}};
        if (race)
            row["DistanceToFinish"] = b.number(p);
        // SSX does not declare rating/respawn attributes. Leave those absent
        // so consumers apply the portable contract's ordinary path defaults.
        p += 48;
        b.range(p, std::size_t(points + events) * 16);
        for (unsigned j = 0; j < points; ++j, p += 16) {
            const auto length = b.number(p + 12);
            if (length < 0)
                throw std::runtime_error("Invalid SSX path step");
            row["PathPoints"].push_back(
                {double(b.number(p)) * length, double(b.number(p + 4)) * length, double(b.number(p + 8)) * length});
        }
        for (unsigned j = 0; j < events; ++j, p += 16)
            row["PathEvents"].push_back({{"EventType", static_cast<std::int32_t>(b.le(p))},
                                         {"EventValue", b.le(p + 4)},
                                         {"EventStart", b.number(p + 8)},
                                         {"EventEnd", b.number(p + 12)}});
        rows.push_back(row);
    }
    return rows;
}

Json effects(Bytes b, const std::string& course, const Json& instances, const ImportCancel& cancel) {
    b.range(0, 40);
    const auto slots = b.le(8), chains = b.le(32), table = b.le(36);
    if (slots > 8192 || chains > 8192)
        throw std::runtime_error("SSX effects count exceeds its limit");
    b.range(b.le(12), std::size_t(slots) * 28);
    b.range(table, std::size_t(chains) * 8);
    const auto identity = [](const char* kind, std::size_t id) { return std::string(kind) + ":" + std::to_string(id); };
    Json doc = {{"$schema", "openslope-effects-v1.schema.json"},
                {"kind", "openslope-effects"},
                {"version", 1},
                {"header", {{"U1", b.le(0)}, {"U2", b.le(4)}, {"U3", 0}}},
                {"target", {{"game", "ssx"}, {"platform", "ps2"}, {"region", "unknown"}, {"level", course}}}};
    for (const auto key :
         {"slots", "graphs", "functions", "objectProperties", "instances", "physics", "collisionModels", "splines"})
        doc[key] = Json::array();
    const auto base = std::size_t(table) + std::size_t(chains) * 8;
    std::size_t total = 0;
    for (unsigned i = 0; i < chains; ++i) {
        check_cancel(cancel);
        const auto count = b.le(table + i * 8);
        if (count > 10000 || (total += count) > 100000)
            throw std::runtime_error("SSX effects node count exceeds its limit");
        auto p = base + b.le(table + i * 8 + 4);
        Json nodes = Json::array();
        for (unsigned j = 0; j < count; ++j) {
            const auto type = b.le(p, 2), size = b.le(p + 2, 2);
            if (size < 4 || size % 4)
                throw std::runtime_error("Invalid SSX effects node frame");
            b.range(p, size);
            Json words = Json::array();
            for (unsigned k = 0; k < size; k += 4)
                words.push_back(b.le(p + k));
            nodes.push_back({{"originalIndex", j}, {"mainType", type}, {"nativeWords", words}});
            p += size;
        }
        // [Trailmap: 500-nodes] Packed frames are known; payload semantics
        // are not established. Preserve them without executing Tricky opcodes.
        doc["graphs"].push_back({{"id", identity("graph", i)},
                                 {"originalIndex", i},
                                 {"nodes", Json::array()},
                                 {"extensions", {{"ssxUnresolvedNodes", nodes}}}});
    }
    constexpr std::array<const char*, 7> columns{"persistent", "collision", "slot3", "slot4",
                                                 "trigger",    "slot6",     "slot7"};
    for (unsigned i = 0; i < slots; ++i) {
        Json circumstances;
        for (unsigned j = 0; j < 7; ++j) {
            const auto id = static_cast<std::int32_t>(b.le(b.le(12) + i * 28 + j * 4));
            if (id < -1 || (id >= 0 && unsigned(id) >= chains))
                throw std::runtime_error("SSX effect slot references a missing graph");
            circumstances[columns[j]] = id < 0 ? Json(nullptr) : Json(identity("graph", std::size_t(id)));
        }
        doc["slots"].push_back({{"id", identity("slot", i)}, {"originalIndex", i}, {"circumstances", circumstances}});
    }
    for (std::size_t i = 0; i < instances.size(); ++i) {
        const auto slot = instances[i].at("EffectSlotIndex").get<int>();
        if (slot < -1 || (slot >= 0 && unsigned(slot) >= slots))
            throw std::runtime_error("SSX instance references a missing effect slot");
        doc["instances"].push_back(
            {{"id", identity("instance", i)}, {"originalIndex", i}, {"property", identity("property", i)}});
        const auto mode = instances[i].at("CollsionMode").get<int>();
        const auto physics = instances[i].at("PhysicsIndex").get<int>(),
                   proxy = instances[i].at("CollisionProxyIndex").get<int>();
        doc["objectProperties"].push_back(
            {{"id", identity("property", i)},
             {"originalIndex", i},
             {"data", instances[i]},
             {"references",
              {{"effectSlot", slot < 0 ? Json(nullptr) : Json(identity("slot", std::size_t(slot)))},
               {"physics", mode == 3 && physics >= 0 ? Json(identity("physics", std::size_t(physics))) : Json(nullptr)},
               {"collisionModel",
                mode == 1 && proxy >= 0 ? Json(identity("collision", std::size_t(proxy))) : Json(nullptr)}}}});
    }
    for (const auto table_id : {1u, 2u}) {
        const auto count = b.le(8 + table_id * 8), offset = b.le(12 + table_id * 8);
        b.range(offset, std::size_t(count) * 12);
        for (unsigned i = 0; i < count; ++i)
            doc[table_id == 1 ? "physics" : "collisionModels"].push_back(
                {{"id", identity(table_id == 1 ? "physics" : "collision", i)},
                 {"originalIndex", i},
                 {"data", {{"ByteSize", b.le(offset + i * 12 + 4)}, {"Count", b.le(offset + i * 12 + 8)}}}});
    }
    return doc;
}
} // namespace

void ssx_header(std::span<const std::uint8_t> index) {
    Bytes b{index};
    b.range(0, 72);
    if (b.number(0) != 9.71f || b.number(4) != .03f || b.le(8) != 11)
        throw std::runtime_error("Unsupported SSX PS2 world index version");
    const auto width = b.le(40), height = b.le(44), models = b.le(48), materials = b.le(52), books = b.le(56),
               splines = b.le(60);
    if (!width || !height || width > 1024 || height > 1024 || std::size_t(width) * height > 65535 || !models ||
        models > 4000 || materials > 65535 || books > 65535 || splines > 10000)
        throw std::runtime_error("SSX world index exceeds its limits");
    const auto bytes = 72 + std::size_t(models) * 8 + std::size_t(width) * height * 8 + std::size_t(books) * 20 +
                       std::size_t(materials) * 12 + std::size_t(splines) * 52;
    b.range(0, bytes);
    if (bytes != index.size())
        throw std::runtime_error("SSX world index length disagrees with its tables");
}

void write_ssx_course(const DiscInput& disc, const std::map<std::string, Buffer>& files, const std::string& course,
                      const std::filesystem::path& output, const ImportProgress& progress, const ImportCancel& cancel) {
    const auto notify = [&](const std::string& text) {
        check_cancel(cancel);
        if (progress)
            progress(text);
    };
    const auto index_file =
        std::find_if(files.begin(), files.end(), [](const auto& file) { return file.first.ends_with(".WDX"); });
    if (index_file == files.end())
        throw std::runtime_error("The selected archive is not an SSX course");
    const auto base = index_file->first.substr(0, index_file->first.size() - 4);
    const auto file = [&](const std::string& suffix) -> const Buffer& {
        const auto it = files.find(base + suffix);
        if (it == files.end())
            throw std::runtime_error("SSX archive is missing " + base + suffix);
        return it->second;
    };
    ssx_header(index_file->second);
    Bytes index{index_file->second}, world{file(".WDF")};
    notify("Decoding SSX textures and lightmaps");
    const auto images = decode_ssh(file(".SSH"), false, cancel, false, true);
    const auto lightmaps = decode_ssh(file("L.SSH"), true, cancel, false, true);
    std::filesystem::create_directory(output / "Textures");
    std::filesystem::create_directory(output / "Lightmaps");
    for (const auto& image : images) {
        notify("Texture " + image.name);
        write_png(output / "Textures" / (image.name + ".png"), image);
    }
    for (const auto& image : lightmaps) {
        notify("Lightmap " + image.name);
        write_png(output / "Lightmaps" / (image.name + ".png"), image);
    }
    notify("Converting SSX world cells");
    Buffer placements, patches;
    std::vector<std::string> patch_names;

    struct Segment {
        unsigned cell{}, local{};
        Buffer bytes;
    };

    std::vector<Segment> segments;
    Json lights = Json::array();
    const auto grid = std::size_t(index.le(40)) * index.le(44), cell_table = 72 + std::size_t(index.le(48)) * 8;
    for (std::size_t cell = 0; cell < grid; ++cell) {
        check_cancel(cancel);
        const auto offset = index.le(cell_table + cell * 8), size = index.le(cell_table + cell * 8 + 4);
        world.range(offset, size);
        if (!size)
            continue;
        Bytes b{world.data.subspan(offset, size)};
        b.range(0, 48 + 16 * 48);
        const auto instances = b.le(36, 2), count = b.le(38, 2), light_count = b.le(40, 2), segment_count = b.le(42, 2);
        std::size_t p = (48 + 16 * 48 + std::size_t(b.le(44, 2)) * 4 + 15) & ~std::size_t(15);
        append(placements, b, p, std::size_t(instances) * 272);
        p += std::size_t(instances) * 272;
        append(patches, b, p, std::size_t(count) * 448);
        p += std::size_t(count) * 448;
        for (unsigned j = 0; j < count; ++j)
            patch_names.push_back("Cell " + std::to_string(cell) + " Patch " + std::to_string(j));
        if (patch_names.size() > 100000 || segments.size() + segment_count > 100000 ||
            lights.size() + light_count > 100000)
            throw std::runtime_error("SSX world record count exceeds its limit");
        for (unsigned j = 0; j < segment_count; ++j, p += 128) {
            Buffer bytes;
            append(bytes, b, p, 128);
            segments.push_back({unsigned(cell), j, std::move(bytes)});
        }
        for (unsigned j = 0; j < light_count; ++j, p += 88) {
            // Only the first 76 bytes carry portable light data; trailing
            // bookkeeping/padding may be shared with the next cell extent.
            b.range(p, 76);
            lights.push_back({{"LightName", "Light " + std::to_string(lights.size())},
                              {"Type", b.le(p)},
                              {"SpriteRes", 0},
                              {"UnknownFloat1", b.number(p + 4)},
                              {"Colour", vector(b, p + 12)},
                              {"Direction", vector(b, p + 24)},
                              {"Position", vector(b, p + 36)},
                              {"LowestXYZ", vector(b, p + 48)},
                              {"HighestXYZ", vector(b, p + 60)}});
        }
    }
    if (patch_names.empty())
        throw std::runtime_error("SSX course has no terrain");
    const auto material_table = cell_table + grid * 8 + std::size_t(index.le(56)) * 20;
    for (std::size_t p = 0; p < patches.size(); p += 448) {
        const auto material = Bytes{patches}.le(p + 432);
        if (material >= index.le(52))
            throw std::runtime_error("SSX terrain references a missing material");
        const auto texture = index.signed16(material_table + std::size_t(material) * 12 + 4);
        if (texture < 0)
            throw std::runtime_error("SSX terrain material has no texture");
        word(patches, p + 432, unsigned(texture));
    }
    auto terrain = Json::parse(patch_document(patches, patch_names, images, true));
    for (const auto& patch : terrain.at("Patches")) {
        const auto id = patch.at("LightmapID").get<int>();
        if (id < 0 || std::size_t(id) >= lightmaps.size())
            throw std::runtime_error("SSX patch references a missing lightmap");
    }
    write(output / "Patches.json", terrain);
    write(output / "Lights.json", {{"Lights", lights}});
    notify("Converting SSX prop models, placements and lighting");
    const bool repaired_lighting =
        write_ssx_props(index_file->second, file(".WDR"), placements, images, output, cancel);
    notify("Converting SSX collision proxies and physics bodies");
    write_collision(file(".WFX"), output, cancel, true);
    notify("Converting SSX paths");
    Bytes aip{file(".AIP")};
    aip.range(0, 44);
    Json starts = Json::array();
    for (unsigned j = 0; j < 8; ++j) {
        const auto id = aip.le(12 + j * 4);
        if (id >= aip.le(4))
            throw std::runtime_error("Invalid SSX start path");
        starts.push_back(id);
    }
    std::size_t path_cursor = 44;
    auto race = paths(aip, path_cursor, aip.le(0), true, cancel);
    auto ai = paths(aip, path_cursor, aip.le(4), false, cancel);
    if (path_cursor != aip.data.size())
        throw std::runtime_error("SSX path length disagrees with its records");
    write(output / "AIP.json", {{"StartPosList", starts}, {"AIPaths", ai}, {"RaceLines", race}});
    notify("Preserving SSX effect graphs");
    std::ifstream instance_file(output / "Instances.json");
    const auto instance_doc = Json::parse(instance_file);
    write(output / "Effects.json", effects(Bytes{file(".WFX")}, course, instance_doc.at("Instances"), cancel));
    notify("Converting SSX splines");
    Json splines = Json::array();
    for (unsigned i = 0; i < index.le(60); ++i)
        splines.push_back({{"SplineName", "Spline " + std::to_string(i)},
                           {"U0", -1},
                           {"U1", 0},
                           {"SplineStyle", -1},
                           {"Segments", Json::array()}});
    for (std::size_t i = 0; i < segments.size(); ++i) {
        Bytes b{segments[i].bytes};
        const auto owner = b.le(88, 2);
        if (owner >= splines.size())
            throw std::runtime_error("Invalid SSX spline owner");
        Json power = Json::array(), points = Json::array(), arc = Json::array();
        for (unsigned j = 0; j < 4; ++j) {
            power.push_back(vector(b, j * 16));
            arc.push_back(b.number(64 + j * 4));
        }
        for (unsigned j = 0; j < 4; ++j) {
            Json point = Json::array();
            for (unsigned a = 0; a < 3; ++a) {
                const auto v = [&](unsigned k) { return power[k][a].get<double>(); };
                point.push_back(v(3) + (j ? v(2) * j / 3 : 0) + (j >= 2 ? v(1) * (j == 2 ? 1. / 3 : 1) : 0) +
                                (j == 3 ? v(0) : 0));
            }
            points.push_back(point);
        }
        const auto link = [&](unsigned at) -> int {
            const auto cell = b.signed16(at), local = b.signed16(at + 2);
            if (cell == -1 && local == -1)
                return -1;
            for (std::size_t n = 0; n < segments.size(); ++n)
                if (int(segments[n].cell) == cell && int(segments[n].local) == local)
                    return int(n);
            throw std::runtime_error("SSX spline link references a missing segment");
        };
        splines[owner]["Segments"].push_back({{"Points", points},
                                              {"PowerCoefficients", power},
                                              {"ArcLengthCoefficients", arc},
                                              {"Length", b.number(116)},
                                              {"Distance", b.number(120)},
                                              {"Previous", link(80)},
                                              {"Next", link(84)},
                                              {"SourceSegment", i}});
    }
    for (auto& spline : splines)
        std::sort(spline["Segments"].begin(), spline["Segments"].end(), [](const auto& a, const auto& b) {
            return a.at("Distance").template get<double>() < b.at("Distance").template get<double>();
        });
    write(output / "Splines.json", {{"Splines", splines}});
    Json outputs = {"Patches.json",   "Textures",     "Lightmaps",    "Models.json", "Materials.json",
                    "Instances.json", "Meshes",       "Lights.json",  "Collision",   "Physics.json",
                    "AIP.json",       "Effects.json", "Splines.json", "Origin.json", "Source"};
    Json deferred = {"effects-node-semantics", "animated-models", "rail-candidacy", "world",
                     "audio-assets",           "audio-runtime"};
    Json warnings = Json::array();
    if (repaired_lighting)
        warnings.push_back(
            "Non-finite source instance lighting replaced with neutral lighting; original data retained in Source.");
    if (files.contains(base + "_SKY.MDR") || files.contains(base + "_SKY.SSH")) {
        notify("Converting SSX sky backdrop");
        const auto& mdr = file("_SKY.MDR");
        Bytes sky{mdr};
        const auto size = sky.le(8);
        const auto books = sky.le(size), materials = sky.le(size + 4);
        if (books > 65535 || materials > 65535)
            throw std::runtime_error("SSX sky material count exceeds its limit");
        sky.range(size + 8, std::size_t(books) * 20 + std::size_t(materials) * 12);
        if (std::size_t(size) + 8 + std::size_t(books) * 20 + std::size_t(materials) * 12 != mdr.size())
            throw std::runtime_error("SSX sky length disagrees with its materials");
        Buffer sky_index(88);
        word(sky_index, 48, 1);
        word(sky_index, 52, materials);
        word(sky_index, 56, books);
        word(sky_index, 40, 1);
        word(sky_index, 44, 1);
        word(sky_index, 76, size);
        append(sky_index, sky, size + 8, std::size_t(books) * 20 + std::size_t(materials) * 12);
        const auto art = decode_ssh(file("_SKY.SSH"), false, cancel, false, true);
        std::filesystem::create_directories(output / "Skybox/Textures");
        for (const auto& image : art)
            write_png(output / "Skybox/Textures" / (image.name + ".png"), image);
        write_ssx_props(sky_index, sky.data.first(size), {}, art, output / "Skybox", cancel);
        outputs.push_back("Skybox");
    } else
        deferred.push_back("skybox");
    write(output / "Origin.json", {{"Schema", "openslope-origin/v1"},
                                   {"Origin", "retail"},
                                   {"Course", course},
                                   {"RetailData", true},
                                   {"Reasons", {"retail-extract"}}});
    std::filesystem::create_directory(output / "Source");
    for (const auto& [name, bytes] : files) {
        notify("Saving source " + name);
        std::ofstream stream(output / "Source" / name, std::ios::binary);
        stream.write(reinterpret_cast<const char*>(bytes.data()), std::streamsize(bytes.size()));
        if (!stream)
            throw std::runtime_error("Cannot save SSX source sidecar");
    }
    write(output / "Import.json", {{"Schema", "openslope-native-import/v1"},
                                   {"Game", "ssx"},
                                   {"Course", course},
                                   {"Complete", false},
                                   {"Outputs", outputs},
                                   {"Deferred", deferred},
                                   {"Warnings", warnings}});
    static_cast<void>(disc);
    notify("Validating SSX map");
    static_cast<void>(Terrain::load(output));
    static_cast<void>(Props::load(output));
    static_cast<void>(World::load(output));
    static_cast<void>(Rails::load(output));
    static_cast<void>(CoursePaths::load(output));
    static_cast<void>(CollisionWorld::load(output));
    static_cast<void>(WorldLogic::load(output));
}
} // namespace openslope::import_detail
