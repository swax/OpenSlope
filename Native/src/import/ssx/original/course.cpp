#include "import/ssx/common/executable_internal.hpp"
#include "openslope/collision.hpp"
#include "openslope/particles.hpp"
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

Json ssx_light(Bytes b, std::size_t p, std::size_t i) {
    // [Trailmap: 500-light-cone] The portable fields end at the cone cosine;
    // later bookkeeping/padding may share the following cell's extent.
    b.range(p, 76);
    Json row = {{"LightName", "Light " + std::to_string(i)},
                {"Type", b.le(p)},
                {"SpriteRes", 0},
                {"UnknownFloat1", b.number(p + 4)},
                {"Colour", vector(b, p + 12)},
                {"Direction", vector(b, p + 24)},
                {"Position", vector(b, p + 36)},
                {"LowestXYZ", vector(b, p + 48)},
                {"HighestXYZ", vector(b, p + 60)}};
    if (b.le(p) == 1) {
        const auto cone = b.number(p + 72);
        if (cone < -1 || cone > 1)
            throw std::runtime_error("Invalid SSX spotlight cone");
        row["UnknownFloat2"] = row["OuterConeCosine"] = cone;
    }
    return row;
}

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

std::size_t particles(const DiscInput& disc, const std::filesystem::path& output, const ImportCancel& cancel) {
    const auto entries = disc_directory(disc, "DATA");
    if (std::none_of(entries.begin(), entries.end(), [](const auto& e) { return e.directory && e.name == "TEXTURES"; }))
        return 0;
    const auto textures = disc_directory(disc, "DATA/TEXTURES");
    if (std::none_of(textures.begin(), textures.end(), [](const auto& e) { return e.name == "PARTICLE.SSH"; }))
        return 0;
    const auto boot = executable_detail::boot_executable(disc, cancel);
    if (!boot)
        return 0;
    const auto& executable = boot->bytes;
    Bytes elf{executable};
    elf.range(0, 16);
    if (elf.text(0, 4) != std::string("\x7f"
                                      "ELF",
                                      4) ||
        elf.le(4, 1) != 1 || elf.le(5, 1) != 1)
        throw std::runtime_error("Invalid original SSX particle registration executable");
    const auto sprites = decode_ssh(disc_file(disc, "DATA/TEXTURES/PARTICLE.SSH"), false, cancel, true);
    Json bank = Json::object(), registration;
    for (const auto& sprite : sprites)
        bank[sprite.name] = "Particles/" + sprite.name + ".png";
    // Independently measured NTSC-U registration: 34 twelve-byte records,
    // four-character image tag, runtime cache word, and mip selector. This
    // order differs from SSH image order and intentionally repeats mip1.
    for (std::size_t p = 0; p + 34 * 12 <= executable.size(); p += 4) {
        if ((p & 65535) == 0)
            check_cancel(cancel);
        if (elf.text(p, 4) != "part" || elf.text(p + 12, 4) != "snfl" || elf.text(p + 24, 4) != "clod")
            continue;
        Json candidate = Json::array();
        for (unsigned i = 0; i < 34; ++i) {
            const auto name = elf.text(p + i * 12, 4);
            if (!bank.contains(name) || elf.le(p + i * 12 + 4) != 0 || elf.le(p + i * 12 + 8) > 2)
                break;
            candidate.push_back(bank.at(name));
        }
        if (candidate.size() != 34)
            continue;
        if (!registration.is_null())
            throw std::runtime_error("Ambiguous original SSX particle registration");
        registration = std::move(candidate);
    }
    if (registration.is_null())
        return 0;
    std::filesystem::create_directories(output / "Textures/Particles");
    for (const auto& sprite : sprites) {
        check_cancel(cancel);
        write_png(output / "Textures" / bank.at(sprite.name).get<std::string>(), sprite);
    }
    Json profile = {{"Schema", "openslope-riding-effects/v1"}, {"Enabled", true},
                    {"Profile", "ssx-riding-effects/v1"},      {"SpriteBank", bank},
                    {"EmitterSprites", registration},          {"SourceExecutable", boot->name}};
    for (const auto& [tag, slot] : {std::pair{"part", "Puff"}, std::pair{"tral", "Wake"}, std::pair{"spry", "Sheet"}})
        if (bank.contains(tag))
            profile[slot] = bank.at(tag);
    write(output / "RidingEffects.json", profile);
    return registration.size();
}

// Original SSX frames have a packed u16 opcode/u16 size header. Payloads
// below were measured from original disc records; canonical opcodes belong
// to the shared effects contract, not to the original executable.
Json effect_node(Bytes b, const std::string& graph, unsigned index,
                 const std::map<unsigned, std::pair<std::size_t, unsigned>>& cells, unsigned chains,
                 std::size_t particle_sprites) {
    const auto main = b.le(0, 2);
    const auto size = b.data.size();
    Json payload = Json::object(), refs = Json::object();
    unsigned canonical = main;
    const auto fields = [&](std::size_t at, const std::string& layout) {
        Json values = Json::object();
        for (std::size_t i = 0; i < layout.size(); ++i)
            values["U" + std::to_string(i)] = layout[i] == 'f' ? Json(b.number(at + i * 4)) : Json(b.le(at + i * 4));
        return values;
    };
    if (main == 0 && size >= 8) {
        const auto sub = b.le(4);
        Json property = {{"SubType", sub}};
        if (sub == 10 && size == 32)
            property["UVScroll"] = fields(8, "ifffff");
        else if (sub == 11 && size == 24)
            property["TextureFlip"] = {
                {"U0", b.le(8)}, {"Direction", b.le(12)}, {"Speed", b.number(16)}, {"Length", b.number(20)}, {"U4", 0}};
        else if (sub == 2 && size == 12)
            property["Debounce"] = b.number(8);
        else if (sub == 5 && size == 12)
            property["DeadNodeMode"] = b.le(8);
        else if (sub == 12 && size == 16)
            property["Fence"] = {{"U0", b.le(8)}, {"FlexAmmount", b.number(12)}};
        else if (sub == 13 && size == 24)
            property["type0Sub13"] = fields(8, "ifff");
        else if (sub == 256 && size == 36) {
            const auto packed = b.le(8), loop = packed & 65535, reverse = packed >> 16;
            if (loop > 2 || (reverse != 3 && reverse != 4))
                return nullptr;
            property["type0Sub256"] = {{"U0", loop},
                                       {"U1", b.number(12)},
                                       {"U2", b.number(16)},
                                       {"U3", b.number(20) * 30.},
                                       {"U4", b.number(24) * 30.},
                                       {"U5", b.number(28)},
                                       {"U6", b.le(32)},
                                       {"U7", reverse}};
        } else
            return nullptr;
        payload["type0"] = property;
    } else if (main == 1 && size == 212 && b.le(4) == 0 && particle_sprites) {
        const auto values = fields(8, "ii" + std::string(47, 'f') + "ii");
        std::array<double, 51> law{};
        for (unsigned i = 0; i < law.size(); ++i)
            law[i] = values.at("U" + std::to_string(i)).get<double>();
        const auto decoded = ParticleLaw::decode(law);
        if (decoded.texture >= particle_sprites)
            throw std::runtime_error("SSX emitter references a missing sprite");
        canonical = 2;
        payload["type2"] = {{"SubType", 0}, {"type2Sub0", values}};
    } else if (main == 3 && size == 8) {
        canonical = 4;
        payload["WaitTime"] = b.number(4);
    } else if ((main == 2 || main == 8) && size == 12) {
        canonical = main == 2 ? 3 : 9;
        payload[main == 2 ? "type3" : "type9"] = fields(4, "if");
    } else if (main == 4 && size == 16) {
        canonical = 5;
        payload["type5"] = fields(4, "ifi");
    } else if (main == 6 && size == 16) {
        const auto cell = cells.find(b.le(4));
        if (cell == cells.end() || b.le(8) >= cell->second.second || b.le(12) >= chains)
            throw std::runtime_error("SSX effect references a missing cell instance or graph");
        const auto instance = cell->second.first + b.le(8);
        const auto effect = b.le(12);
        canonical = 7;
        payload["Instance"] = {{"InstanceIndex", instance}, {"EffectIndex", effect}};
        refs = {{"instance", "instance:" + std::to_string(instance)},
                {"effectGraph", "graph:" + std::to_string(effect)}};
    } else if (main == 7 && size == 8) {
        canonical = 8;
        payload["SoundPlay"] = b.le(4);
    } else if (main == 13 && size == 8) {
        const auto tier = b.number(4);
        if (tier != 2 && tier != 3 && tier != 5)
            return nullptr;
        canonical = 14;
        payload["MultiplierScore"] = tier;
    } else
        return nullptr;
    return {{"id", graph + "/node:" + std::to_string(index)},
            {"originalIndex", index},
            {"mainType", canonical},
            {"payload", payload},
            {"references", refs},
            {"extensions", {{"ssxMainType", main}}}};
}

Json effects(Bytes b, const std::string& course, const Json& instances,
             const std::map<unsigned, std::pair<std::size_t, unsigned>>& cells, std::size_t particle_sprites,
             const ImportCancel& cancel) {
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
        Json nodes = Json::array(), decoded = Json::array();
        bool supported = true;
        for (unsigned j = 0; j < count; ++j) {
            const auto type = b.le(p, 2), size = b.le(p + 2, 2);
            if (size < 4 || size % 4)
                throw std::runtime_error("Invalid SSX effects node frame");
            b.range(p, size);
            Json words = Json::array();
            for (unsigned k = 0; k < size; k += 4)
                words.push_back(b.le(p + k));
            nodes.push_back({{"originalIndex", j}, {"mainType", type}, {"nativeWords", words}});
            auto node =
                effect_node(Bytes{b.data.subspan(p, size)}, identity("graph", i), j, cells, chains, particle_sprites);
            if (node.is_null())
                supported = false;
            else
                decoded.push_back(std::move(node));
            p += size;
        }
        // Keep complete original frames, including supported nodes. Unknown
        // semantics block the entire chain rather than dropping a condition or
        // lifecycle command and executing a misleading partial effect.
        doc["graphs"].push_back(
            {{"id", identity("graph", i)},
             {"originalIndex", i},
             {"nodes", supported ? decoded : Json::array()},
             {"extensions", {{"ssxNativeNodes", nodes}, {"ssxUnresolvedNodes", supported ? Json::array() : nodes}}}});
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

std::size_t label_gems(Json& instances, Json& models, Json& logic) {
    std::map<std::string, unsigned> rewards;
    for (const auto& graph : logic.at("graphs")) {
        std::set<unsigned> tiers;
        for (const auto& node : graph.at("nodes"))
            if (node.at("mainType") == 14)
                tiers.insert(node.at("payload").at("MultiplierScore").get<unsigned>());
        if (tiers.size() == 1)
            rewards[graph.at("id").get<std::string>()] = *tiers.begin();
    }
    std::map<int, unsigned> slots;
    for (const auto& slot : logic.at("slots")) {
        const auto& collision = slot.at("circumstances").at("collision");
        if (!collision.is_null() && rewards.contains(collision.get<std::string>()))
            slots[slot.at("originalIndex").get<int>()] = rewards.at(collision.get<std::string>());
    }
    std::map<std::size_t, std::set<unsigned>> model_tiers;
    std::size_t count = 0;
    for (std::size_t i = 0; i < instances.size(); ++i) {
        auto& row = instances[i];
        const auto slot = row.at("EffectSlotIndex").get<int>();
        if (!slots.contains(slot))
            continue;
        const auto tier = slots.at(slot);
        row["SourceInstanceName"] = row.at("InstanceName");
        row["InstanceName"] = "Gem x" + std::to_string(tier) + " (Instance " + std::to_string(i) + ")";
        row["LTGState"] = 2;
        model_tiers[row.at("ModelID").get<std::size_t>()].insert(tier);
        logic["objectProperties"][i]["data"] = row;
        ++count;
    }
    for (const auto& [id, tiers] : model_tiers) {
        auto& row = models.at(id);
        row["SourceModelName"] = row.at("ModelName");
        // Keep the SSX prefix: only reward-bearing placements get Showoff state,
        // not decorative copies of the same mesh with no pickup effect.
        const auto tier = tiers.size() == 1 ? "x" + std::to_string(*tiers.begin()) : "";
        row["ModelName"] = "SSX_Gem_Multiplier" + tier + " (Model " + std::to_string(id) + ")";
    }
    return count;
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

std::string ssx_light_document(std::span<const std::uint8_t> index_bytes, std::span<const std::uint8_t> world_bytes) {
    ssx_header(index_bytes);
    Bytes index{index_bytes}, world{world_bytes};
    const auto grid = std::size_t(index.le(40)) * index.le(44), table = 72 + std::size_t(index.le(48)) * 8;
    Json lights = Json::array();
    for (std::size_t i = 0; i < grid; ++i) {
        const auto offset = index.le(table + i * 8), size = index.le(table + i * 8 + 4);
        world.range(offset, size);
        if (!size)
            continue;
        Bytes cell{world.data.subspan(offset, size)};
        cell.range(0, 48 + 16 * 48);
        const auto count = cell.le(40, 2);
        if (lights.size() + count > 100000)
            throw std::runtime_error("SSX light table exceeds its limit");
        const auto start = ((48 + 16 * 48 + std::size_t(cell.le(44, 2)) * 4 + 15) & ~std::size_t(15)) +
                           std::size_t(cell.le(36, 2)) * 272 + std::size_t(cell.le(38, 2)) * 448 +
                           std::size_t(cell.le(42, 2)) * 128;
        for (unsigned j = 0; j < count; ++j)
            lights.push_back(ssx_light(cell, start + std::size_t(j) * 88, lights.size()));
    }
    return Json{{"Lights", lights}}.dump();
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
    std::map<unsigned, std::pair<std::size_t, unsigned>> cell_instances;
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
        cell_instances[unsigned(cell)] = {placements.size() / 272, instances};
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
        for (unsigned j = 0; j < light_count; ++j, p += 88)
            lights.push_back(ssx_light(b, p, lights.size()));
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
    const auto particle_sprites = particles(disc, output, cancel);
    std::ifstream instance_file(output / "Instances.json");
    auto instance_doc = Json::parse(instance_file);
    auto logic =
        effects(Bytes{file(".WFX")}, course, instance_doc.at("Instances"), cell_instances, particle_sprites, cancel);
    std::ifstream model_file(output / "Models.json");
    auto model_doc = Json::parse(model_file);
    const auto gem_count = label_gems(instance_doc.at("Instances"), model_doc.at("Models"), logic);
    instance_file.close();
    model_file.close();
    write(output / "Instances.json", instance_doc);
    write(output / "Models.json", model_doc);
    write(output / "Effects.json", logic);
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
    Json deferred = {"effects-node-semantics",
                     "animation-properties-257-258",
                     "rail-candidacy",
                     "world",
                     "audio-spatial-and-collision-routing",
                     "race-music-graphs"};
    Json warnings = Json::array();
    notify("Converting original SSX sound banks");
    const auto audio = write_ssx_audio(disc, output, course, progress, cancel);
    if (audio) {
        outputs.push_back("Audio");
    } else
        deferred.push_back("audio-assets");
    if (particle_sprites)
        outputs.push_back("RidingEffects.json");
    else
        deferred.push_back("particle-registration");
    std::size_t active_graphs = 0, active_nodes = 0, unresolved_graphs = 0;
    for (const auto& graph : logic.at("graphs")) {
        active_nodes += graph.at("nodes").size();
        active_graphs += !graph.at("nodes").empty();
        unresolved_graphs += !graph.at("extensions").at("ssxUnresolvedNodes").empty();
    }
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
                                   {"Effects",
                                    {{"ActiveGraphs", active_graphs},
                                     {"ActiveNodes", active_nodes},
                                     {"DeferredGraphs", unresolved_graphs},
                                     {"MultiplierPickups", gem_count}}},
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
