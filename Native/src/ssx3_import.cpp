#include "import_internal.hpp"
#include "openslope/audio_data.hpp"
#include "openslope/collision.hpp"
#include "openslope/paths.hpp"
#include "openslope/props.hpp"
#include "openslope/rails.hpp"
#include "openslope/terrain.hpp"
#include "openslope/world.hpp"
#include "openslope/world_logic.hpp"
#include <algorithm>
#include <array>
#include <cctype>
#include <fstream>
#include <iomanip>
#include <nlohmann/json.hpp>
#include <set>

namespace openslope::import_detail {
namespace {
using Json = nlohmann::json;
using Buffer = std::vector<std::uint8_t>;
using Key = std::pair<unsigned, std::uint32_t>;
using Records = std::map<Key, Buffer>;

void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(std::string("SSX 3: ") + message);
}

void save(const std::filesystem::path& path, const Json& document) {
    const auto text = document.dump();
    require(text.size() <= 64 * 1024 * 1024, "portable document exceeds 64 MiB");
    std::ofstream file(path, std::ios::binary);
    file << text << '\n';
    require(bool(file), "cannot write map document");
}

void raw(const std::filesystem::path& path, std::span<const std::uint8_t> bytes) {
    std::ofstream file(path, std::ios::binary);
    file.write(reinterpret_cast<const char*>(bytes.data()), std::streamsize(bytes.size()));
    require(bool(file), "cannot save source record");
}

std::string number(unsigned n) {
    auto name = std::to_string(n);
    name.insert(0, 4 - std::min<std::size_t>(4, name.size()), '0');
    return name;
}

Json vector(Bytes b, std::size_t p, unsigned count = 3) {
    Json result = Json::array();
    for (unsigned c = 0; c < count; ++c)
        result.push_back(b.number(p + c * 4));
    return result;
}

std::string lower(std::string name) {
    for (auto& c : name)
        c = char(std::tolower(static_cast<unsigned char>(c)));
    return name;
}

bool contains(const std::string& name, std::initializer_list<const char*> tokens) {
    return std::any_of(tokens.begin(), tokens.end(),
                       [&](const auto* token) { return name.find(token) != std::string::npos; });
}

// [Trailmap: 510-container, 511-locations, 511-peaks] Fixed location rows
// are followed by the streaming directories; no world-space rebasing occurs.
std::vector<std::string> locations(Bytes b) {
    b.range(0, 80);
    require(b.le(0) == 0x01003800, "unsupported streaming database version");
    const auto count = b.le(8);
    require(count && count <= 255, "invalid location count");
    b.range(80, std::size_t(count) * 88);
    std::vector<std::string> result;
    std::set<std::string> unique;
    for (unsigned i = 0; i < count; ++i) {
        auto name = b.text(80 + i * 88, 16);
        name.resize(name.find('\0') == std::string::npos ? name.size() : name.find('\0'));
        require(!name.empty() && name.size() < 16 &&
                    std::all_of(
                        name.begin(), name.end(),
                        [](unsigned char c) { return (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_'; }) &&
                    unique.insert(name).second,
                "invalid or duplicate location name");
        result.push_back(name);
    }
    return result;
}

std::set<unsigned> selection(const std::vector<std::string>& names, const std::string& requested) {
    require(requested.starts_with("SSX3_"), "invalid selection");
    const auto name = requested.substr(5);
    std::set<unsigned> result;
    const std::string letters = name == "PEAK1" ? "AB" : name == "PEAK2" ? "CD" : name == "PEAK3" ? "E" : "";
    bool exact = false;
    for (unsigned i = 0; i < names.size(); ++i) {
        const auto& section = names[i];
        if (section == "TRANSP" || section.ends_with("SKY"))
            continue;
        if (section == name)
            exact = true;
        if ((!letters.empty() && letters.find(section.front()) != std::string::npos) || section == name ||
            (name.size() > 1 && (section.starts_with(name + "_") || section.ends_with("_" + name))))
            result.insert(i);
    }
    require(!result.empty() && (exact || !letters.empty()), "unknown mountain selection");
    return result;
}

// [Trailmap: 510-names, 510-ids] The five parallel name arrays use the
// same ordinal order. Resource ids, rather than names, bind all render data.
std::map<Key, std::string> resource_names(Bytes ids, Bytes strings) {
    require(ids.le(8) == 5 && strings.le(8) == 5, "invalid resource-name array count");
    std::map<Key, std::string> result;
    const std::array<unsigned, 5> bins{1, 3, 2, 8, 12};
    std::size_t p = 12, q = 12;
    for (unsigned array = 0; array < 5; ++array) {
        const auto count = ids.le(p + 4), size = ids.le(p + 1, 3), length = strings.le(q + 1, 3);
        require(count <= 100000 && size == std::size_t(count) * 16 && strings.le(q + 4) == count &&
                    ids.le(p, 1) == strings.le(q, 1),
                "resource-name arrays disagree");
        ids.range(p + 8, size);
        strings.range(q + 8, length);
        std::size_t cursor = q + 8;
        for (unsigned i = 0; i < count; ++i) {
            const auto begin = cursor;
            while (cursor < q + 8 + length && strings.data[cursor])
                ++cursor;
            require(cursor < q + 8 + length && cursor - begin <= 512, "unterminated resource name");
            const auto rid = ids.le(p + 8 + i * 16 + 8);
            require(result.emplace(Key{bins[array], rid}, strings.text(begin, cursor - begin)).second,
                    "duplicate resource name id");
            ++cursor;
        }
        p += 8 + size;
        q += 8 + length;
    }
    require(p == ids.data.size() && q == strings.data.size(), "resource-name extent mismatch");
    return result;
}

const Buffer& get(const Records& records, unsigned bin, std::uint32_t id) {
    const auto it = records.find({bin, id});
    require(it != records.end() && !it->second.empty(), "missing referenced world resource");
    return it->second;
}

// [Trailmap: 510-ssb, 510-empty, 512-ids] Keep one bounded group in
// memory, reading sectors on demand in the browser as well as on desktop.
Records read_world(const DiscInput& stream, const std::set<unsigned>& selected, const ImportProgress& progress,
                   const ImportCancel& cancel) {
    require(stream.size && stream.size % 32768 == 0 && stream.size <= 512ull * 1024 * 1024,
            "invalid world stream extent");
    Records records;
    Buffer group;
    std::size_t total = 0, count = 0;
    for (std::uint64_t p = 0; p < stream.size; p += 32768) {
        check_cancel(cancel);
        if (progress && p % (32768 * 64) == 0)
            progress("Reading mountain stream " + std::to_string(p * 100 / stream.size) + "%");
        const auto chunk = stream.read(p, 32768);
        Bytes b{chunk};
        const auto tag = b.text(0, 4);
        require((tag == "CBXS" || tag == "CEND") && b.le(4) == 32768, "invalid streaming chunk");
        require(b.le(8, 1) == 0x10 && b.le(9, 1) == 0xfb, "uncompressed streaming chunk is unsupported");
        auto payload = decode_refpack(b.data.subspan(8));
        require(group.size() + payload.size() <= 32 * 1024 * 1024, "streaming group exceeds 32 MiB");
        group.insert(group.end(), payload.begin(), payload.end());
        if (tag != "CEND")
            continue;
        Bytes data{group};
        std::size_t cursor = 0;
        while (cursor < group.size()) {
            check_cancel(cancel);
            data.range(cursor, 8);
            const auto bin = data.le(cursor, 1), size = data.le(cursor + 1, 3), rid = data.le(cursor + 4);
            require(bin <= 22 && ++count <= 250000, "invalid streaming resource header");
            cursor += 8;
            data.range(cursor, size);
            if (selected.contains(rid & 255) || bin == 9 || bin == 10) {
                const auto bytes = data.data.subspan(cursor, size);
                const auto found = records.find({bin, rid});
                if (found != records.end())
                    require(std::equal(bytes.begin(), bytes.end(), found->second.begin(), found->second.end()),
                            "conflicting repeated resource");
                else {
                    total += size;
                    require(total <= 192 * 1024 * 1024, "selected resources exceed memory limit");
                    records.emplace(Key{bin, rid}, Buffer(bytes.begin(), bytes.end()));
                }
            }
            cursor += size; // Empty slots are records too, never terminators.
        }
        group.clear();
    }
    require(group.empty(), "unterminated streaming group");
    return records;
}

// [Trailmap: 512-formats, 512-full-range, 512-alpha-scale,
// 512-palette-order, 512-palette-extent, 511-lm-pages]
Image image(Bytes b, unsigned id, bool lightmap) {
    b.range(0, 128);
    const auto type = b.le(0, 1), w = b.le(4, 2), h = b.le(6, 2);
    require((type == 1 || type == 2 || type == 5) && w && h && w <= 2048 && h <= 2048 && (!lightmap || type == 5),
            "unsupported world texture");
    const auto pixels = std::size_t(w) * h;
    const auto stride = type == 5 ? 4u : 1u;
    b.range(128, type == 1 ? (pixels + 1) / 2 : pixels * stride);
    std::size_t palette = b.le(1, 3);
    unsigned colours = 0;
    if (type != 5) {
        require(palette >= 128 + (type == 1 ? (pixels + 1) / 2 : pixels), "palette overlaps pixels");
        b.range(palette, 128);
        require(b.le(palette, 1) == 33, "missing world texture palette");
        colours = b.le(palette + 4, 2);
        require(colours && colours <= (type == 1 ? 16u : 256u), "invalid world palette count");
        palette += 128;
    }
    Image result{number(id), w, h, Buffer(pixels * 4)};
    for (std::size_t p = 0; p < pixels; ++p) {
        std::size_t source = 128 + p * 4;
        if (type != 5) {
            const auto packed = b.le(128 + (type == 1 ? p / 2 : p), 1);
            const auto index = type == 1 ? (packed >> ((p & 1) * 4)) & 15 : packed;
            require(index < colours, "texture references missing palette colour");
            const auto slot = type == 2 ? ((index & 0xe7) | ((index & 8) << 1) | ((index & 16) >> 1)) : index;
            source = palette + slot * 4;
        }
        b.range(source, 4);
        for (unsigned c = 0; c < 4; ++c)
            result.rgba[p * 4 + c] =
                std::uint8_t(c == 3 && !lightmap ? std::min(255u, b.le(source + c, 1) * 2) : b.le(source + c, 1));
    }
    return result;
}

// [Trailmap: 511-lm-base, 511-lm-edges] Resample edge coordinates onto
// the shared format's texel centres, then convert its two-term blend.
Image lightmap(const Image& source) {
    Image result{source.name, 128, 128, Buffer(128 * 128 * 4)};
    for (unsigned y = 0; y < 128; ++y)
        for (unsigned x = 0; x < 128; ++x) {
            const double sx = double(x) * source.width / 128 - .5, sy = double(y) * source.height / 128 - .5;
            std::array<double, 4> sample{};
            for (unsigned j = 0; j < 2; ++j)
                for (unsigned i = 0; i < 2; ++i) {
                    const auto px = std::clamp(int(std::floor(sx)) + int(i), 0, int(source.width) - 1),
                               py = std::clamp(int(std::floor(sy)) + int(j), 0, int(source.height) - 1);
                    const auto weight = (i ? sx - std::floor(sx) : 1 - sx + std::floor(sx)) *
                                        (j ? sy - std::floor(sy) : 1 - sy + std::floor(sy));
                    for (unsigned c = 0; c < 4; ++c)
                        sample[c] += source.rgba[(py * source.width + px) * 4 + c] * weight;
                }
            const double alpha = std::min(255., sample[3] * 2);
            for (unsigned c = 0; c < 3; ++c) {
                const double residual = alpha ? 127.5 - (255 - sample[c]) * sample[3] / alpha : 0;
                result.rgba[(y * 128 + x) * 4 + c] = std::uint8_t(std::clamp(std::lround(residual), 0l, 255l));
            }
            result.rgba[(y * 128 + x) * 4 + 3] = std::uint8_t(std::lround(alpha));
        }
    return result;
}

Buffer transfers(Bytes b, std::size_t base, std::size_t chain) {
    Buffer result;
    for (unsigned i = 0; i < 100000; ++i, chain += 16) {
        const auto tag = b.le(chain), address = b.le(chain + 4) & 0x7fffffffu;
        if ((tag >> 28) == 6)
            return result;
        require((tag >> 28) == 3, "unsupported model transfer chain");
        const auto start = base + std::size_t(address), length = std::size_t(tag & 65535) * 16;
        b.range(start, length);
        require(result.size() + length <= 16 * 1024 * 1024, "model transfer exceeds limit");
        result.insert(result.end(), b.data.begin() + std::ptrdiff_t(start),
                      b.data.begin() + std::ptrdiff_t(start + length));
    }
    throw std::runtime_error("SSX 3: unterminated model transfer chain");
}

std::string base64(std::span<const std::uint8_t> bytes) {
    constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    for (std::size_t i = 0; i < bytes.size(); i += 3) {
        const auto n = bytes.size() - i;
        const unsigned word =
            (unsigned(bytes[i]) << 16) | (n > 1 ? unsigned(bytes[i + 1]) << 8 : 0) | (n > 2 ? bytes[i + 2] : 0);
        out += alphabet[(word >> 18) & 63];
        out += alphabet[(word >> 12) & 63];
        out += n > 1 ? alphabet[(word >> 6) & 63] : '=';
        out += n > 2 ? alphabet[word & 63] : '=';
    }
    return out;
}

Buffer vertex_lighting(Bytes b) {
    const auto base = b.le(152);
    require(base >= 160 && base <= b.data.size(), "invalid instance lighting offset");
    Buffer result;
    // The directory references both shared model draws and private colours;
    // those references do not alternate on multipart draws. Private payloads
    // follow the directory in vertex-stream order and use packed colour UNPACK.
    std::size_t p = base;
    while (p + 16 <= b.data.size() && (b.le(p) >> 28 == 3 || b.le(p) >> 28 == 6))
        p += 16;
    for (std::size_t q = p; q + 4 <= b.data.size(); q += 4) {
        if ((b.le(q + 3, 1) & 0x7f) != 0x6f)
            continue;
        const auto count = b.le(q + 2, 1) ? b.le(q + 2, 1) : 256;
        b.range(q + 4, count * 2);
        result.insert(result.end(), b.data.begin() + std::ptrdiff_t(q + 4),
                      b.data.begin() + std::ptrdiff_t(q + 4 + count * 2));
        q += ((count * 2 + 3) & ~3u);
    }
    return result;
}

struct PropsExport {
    Json models = Json::array(), materials = Json::array(), instances = Json::array();
    std::map<std::uint32_t, unsigned> model_ids;
    std::map<std::uint32_t, std::size_t> vertices;
    std::set<unsigned> opaque, alpha;
    std::set<std::uint32_t> debug_models;
};

// [Trailmap: 513-models, 513-scale, 513-vertex-light, 512-render-state]
PropsExport props(const Records& records, const std::map<Key, std::string>& names, const std::set<unsigned>& sections,
                  const std::filesystem::path& output, Json& warnings, const ImportCancel& cancel) {
    PropsExport out;
    std::map<std::uint32_t, unsigned> material_ids;
    std::set<std::uint32_t> debug_materials;
    auto name = [&](unsigned kind, std::uint32_t rid) {
        const auto it = names.find({kind, rid});
        require(it != names.end(), "missing authored resource name");
        return it->second;
    };
    std::filesystem::create_directories(output / "Meshes");
    for (const auto& [key, bytes] : records) {
        if (key.first != 0)
            continue;
        Bytes b{bytes};
        b.range(0, 20);
        const auto texture = b.le(0, 2), state = b.le(12, 2);
        const bool alpha = (state & (2 | 4 | 64)) != 0;
        (alpha ? out.alpha : out.opaque).insert(texture);
        if (texture == 17)
            debug_materials.insert(key.second);
        material_ids[key.second] = unsigned(out.materials.size());
        out.materials.push_back({{"MaterialName", "Material " + std::to_string(key.second)},
                                 {"TexturePath", number(texture) + (alpha ? ".png" : "_o.png")},
                                 {"TextureFlipbook", Json::array()},
                                 {"UnknownInt18", alpha ? 0x40000 : 0},
                                 {"AlphaMode", state & 64  ? "additive"
                                               : state & 4 ? "blend"
                                               : state & 2 ? "cutout"
                                                           : "opaque"}});
    }
    for (const auto& [key, bytes] : records) {
        if (key.first != 2 || !sections.contains(key.second & 255))
            continue;
        check_cancel(cancel);
        Bytes b{bytes};
        b.range(0, 40);
        const auto count = b.le(4), table = b.le(8), material_table = b.le(12), base = b.le(36);
        require(count <= 256 && base <= bytes.size(), "invalid model header");
        const auto material_count = b.le(material_table);
        require(material_count <= 4096, "invalid model material count");
        b.range(material_table + 4, std::size_t(material_count) * 4);
        b.range(table, std::size_t(count) * 16);
        bool debug = true, drawn = false;
        std::size_t vertices = 0;
        Json objects = Json::array();
        for (unsigned j = 0; j < count; ++j) {
            const auto o = table + j * 16, header = b.le(o + 4);
            const auto parent = static_cast<std::int32_t>(b.le(o));
            require(parent >= -1 && parent < int(count), "invalid model object parent");
            Json object = {{"ObjectName", "Object " + std::to_string(j)},
                           {"ParentID", parent},
                           {"MeshData", Json::array()},
                           {"IncludeMatrix", false},
                           {"IncludeAnimation", false}};
            const auto matrix = static_cast<std::int32_t>(b.le(o + 12));
            if (matrix >= 0) {
                const auto pose = import_pose(b, std::size_t(matrix));
                object["IncludeMatrix"] = true;
                object["Position"] = pose.at("Location");
                object["Rotation"] = pose.at("Rotation");
                object["Scale"] = pose.at("Scale");
                object["TransformMatrix"] = pose.at("TransformMatrix");
            }
            if (header) {
                b.range(header, 36);
                object["CollisionBounds"] = {{"Min", vector(b, header)}, {"Max", vector(b, header + 12)}};
                const auto parts = b.le(header + 28), part_table = b.le(header + 32);
                require(parts <= 4096, "too many model parts");
                b.range(part_table, std::size_t(parts) * 4);
                for (unsigned k = 0; k < parts; ++k) {
                    const auto entry = b.le(part_table + k * 4), slot = b.le(entry, 2);
                    require(slot < material_count, "mesh material slot outside model table");
                    const auto material = b.le(material_table + 4 + slot * 4);
                    require(material_ids.contains(material), "model references missing material");
                    debug = debug && debug_materials.contains(material);
                    drawn = true;
                    const auto payload = transfers(b, base, base + b.le(entry + 4));
                    const auto file =
                        std::to_string(key.second) + "_" + std::to_string(j) + "_" + std::to_string(k) + ".obj";
                    const auto n = write_ssx3_mesh(Bytes{payload}, b.number(24), b.number(28), b.number(32),
                                                   output / "Meshes" / file, cancel);
                    object["MeshData"].push_back({{"MeshPath", file},
                                                  {"MaterialID", material_ids.at(material)},
                                                  {"VertexLightingBase", vertices}});
                    vertices += n;
                }
            }
            objects.push_back(object);
        }
        if (debug && drawn)
            out.debug_models.insert(key.second);
        out.model_ids[key.second] = unsigned(out.models.size());
        out.vertices[key.second] = vertices;
        out.models.push_back(
            {{"ModelName", name(2, key.second)}, {"AnimTime", b.number(20)}, {"ModelObjects", objects}});
    }
    for (const auto& [key, bytes] : records) {
        if (key.first != 3 || !sections.contains(key.second & 255))
            continue;
        check_cancel(cancel);
        Bytes b{bytes};
        b.range(0, 160);
        const auto model = b.le(128);
        require(out.model_ids.contains(model), "placement references missing model");
        auto row = import_pose(b, 16, b.number(132));
        const auto label = name(3, key.second), folded = lower(label);
        const bool hidden =
            out.debug_models.contains(model) || contains(folded, {"trigger", "volume", "loadbox", "unloadbox"});
        row["InstanceName"] = label;
        row["SourceResource"] = key.second;
        row["ModelID"] = out.model_ids.at(model);
        row["Visable"] = !hidden;
        row["PlayerCollision"] = false;
        row["CollsionMode"] = 0;
        row["PhysicsIndex"] = -1;
        row["EffectSlotIndex"] = -1;
        row["SurfaceType"] = -1;
        row["CollsionModelPaths"] = Json::array();
        row["AmbentLightColour"] = {128, 128, 128, 128};
        const auto lighting = vertex_lighting(b);
        if (lighting.size() == out.vertices.at(model) * 2)
            row["VertexLighting"] = base64(lighting);
        else
            warnings.push_back("Baked vertex colour count differs for " + label + "; neutral lighting exported.");
        out.instances.push_back(row);
    }
    return out;
}

void collision(const Records& records, const std::map<Key, std::string>& names, PropsExport& props,
               const std::filesystem::path& output, Json& warnings, const ImportCancel& cancel) {
    // [Trailmap: 513-proxy-layout, 513-binding, 513-helper-proxies]
    std::map<std::pair<unsigned, std::string>, std::size_t> placements;
    for (std::size_t i = 0; i < props.instances.size(); ++i)
        placements.emplace(std::pair{props.instances[i].at("SourceResource").get<unsigned>() & 255,
                                     props.instances[i].at("InstanceName").get<std::string>()},
                           i);
    std::map<unsigned, Json> bindings;
    std::filesystem::create_directory(output / "Collision");
    for (const auto& [key, bytes] : records) {
        if (key.first != 12 || bytes.empty())
            continue;
        check_cancel(cancel);
        const auto name = names.at(key);
        const auto marker = name.find("_CollideModel_");
        const auto owner = std::pair{key.second & 255, name.substr(0, marker)};
        require(marker != std::string::npos && placements.contains(owner), "collision owner is missing");
        const auto model = props.instances[placements.at(owner)].at("ModelID").get<unsigned>();
        Bytes b{bytes};
        b.range(0, 16);
        if (b.le(0, 2) == 3) {
            warnings.push_back("Sphere-tree collision retained in Source: " + name);
            continue;
        }
        require(b.le(0, 2) == 1 && b.le(2, 2) <= 256, "unsupported collision proxy kind");
        Json files = Json::array();
        std::size_t p = b.le(4);
        for (unsigned i = 0; i < b.le(2, 2); ++i) {
            const auto faces = b.le(p, 2), vertices = b.le(p + 2, 2);
            const auto indices = p + b.le(p + 4), points = p + b.le(p + 12), normals = p + b.le(p + 16);
            require(vertices <= 256 && (!faces || vertices), "invalid collision mesh counts");
            b.range(indices, std::size_t(faces) * 3);
            b.range(points, std::size_t(vertices) * 16);
            b.range(normals, std::size_t(faces) * 16);
            const auto file = std::to_string(key.second) + "_" + std::to_string(i) + ".obj";
            std::ofstream stream(output / "Collision" / file, std::ios::binary);
            stream << std::setprecision(9);
            for (unsigned v = 0; v < vertices; ++v)
                stream << "v " << b.number(points + v * 16) << ' ' << b.number(points + v * 16 + 4) << ' '
                       << b.number(points + v * 16 + 8) << '\n';
            for (unsigned f = 0; f < faces; ++f) {
                stream << 'f';
                for (unsigned c = 0; c < 3; ++c) {
                    const auto index = b.le(indices + f * 3 + c, 1);
                    require(index < vertices, "collision index outside vertex array");
                    stream << ' ' << index + 1;
                }
                stream << '\n';
            }
            require(bool(stream), "cannot write collision mesh");
            files.push_back(file);
            p = normals + std::size_t(faces) * 16;
        }
        if (bindings.contains(model))
            warnings.push_back("Multiple collision variants for model " + std::to_string(model) +
                               "; first triangle proxy selected.");
        else
            bindings[model] = files;
    }
    for (auto& row : props.instances) {
        const auto model = row.at("ModelID").get<unsigned>();
        if (!bindings.contains(model))
            continue;
        const auto name = lower(row.at("InstanceName").get<std::string>());
        // Undecoded triggers retain geometry without becoming solid walls.
        const bool solid =
            row.at("Visable").get<bool>() || (contains(name, {"fence", "collision"}) &&
                                              !contains(name, {"reset", "volume", "trigger", "load", "start", "end"}));
        row["CollsionModelPaths"] = bindings.at(model);
        row["CollsionMode"] = 1;
        row["PlayerCollision"] = solid;
    }
}

Json path_rows(Bytes b, std::size_t& p, unsigned count, bool race, const ImportCancel& cancel) {
    require(count <= 4000, "path count exceeds limit");
    Json rows = Json::array();
    for (unsigned i = 0; i < count; ++i) {
        check_cancel(cancel);
        require(b.le(p) == (race ? 1u : 2u), "unsupported path record");
        const auto points = b.le(p + (race ? 16 : 28)), events = b.le(p + (race ? 20 : 32));
        require(points <= 100000 && events <= 100000, "path arrays exceed limit");
        Json row = {{"Name", std::string(race ? "Race Line " : "AI Path ") + std::to_string(i)},
                    {"PathPos", vector(b, p + (race ? 24 : 36))},
                    {"PathPoints", Json::array()},
                    {"PathEvents", Json::array()}};
        if (race)
            row["DistanceToFinish"] = std::max(0.f, b.number(p + 12));
        else {
            // This title's rating word also carries values outside the shared
            // 0..100 scale. Preserve it without feeding packed flags to AI.
            row["SourceRatingWord"] = b.le(p + 12);
            row["U3"] = 50;
            row["Respawnable"] = bool(b.le(p + 24));
        }
        p += race ? 60 : 72;
        b.range(p, std::size_t(points + events) * 16);
        for (unsigned j = 0; j < points; ++j, p += 16) {
            const auto length = b.number(p + 12);
            require(length >= 0, "negative path step");
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

void paths(const Records& records, const std::set<unsigned>& sections, const std::string& course,
           const std::filesystem::path& output, const ImportCancel& cancel) {
    // [Trailmap: 510-paths, 514-path-slots, 514-start-slots]
    Json ai = Json::array(), race = Json::array(), starts = Json::array();
    std::vector<Json> grid;
    bool course_path = false;
    for (const auto& [key, bytes] : records) {
        if (key.first != 14 || bytes.empty() || !sections.contains(key.second & 255))
            continue;
        Bytes b{bytes};
        require(b.le(0) == 0x69696969, "unsupported path magic");
        std::size_t p = 8;
        auto local_ai = path_rows(b, p, b.le(4), false, cancel);
        const auto count = b.le(p);
        p += 4;
        auto local_race = path_rows(b, p, count, true, cancel);
        const auto slots = b.le(p + 52);
        require(slots <= 64, "invalid start position count");
        b.range(p, 56 + std::size_t(slots) * 40);
        const bool peak = course.ends_with("PEAK1") || course.ends_with("PEAK2") || course.ends_with("PEAK3");
        const bool preferred =
            peak ? (key.second >> 8) == 1 : (key.second >> 8) == 0 && !course_path && !local_race.empty();
        if (preferred) {
            for (const auto& row : local_race)
                race.push_back(row);
            if (slots &&
                (!course_path || (peak && (grid.empty() || b.number(p + 72) > grid.front()[2].get<double>())))) {
                grid.clear();
                for (unsigned i = 0; i < slots; ++i)
                    grid.push_back(vector(b, p + 64 + i * 40));
                course_path = true;
            }
        }
        for (const auto& row : local_ai)
            ai.push_back(row);
    }
    // Highest route is a useful spawn for combined selections. The path
    // network is retained in full; peak race lines cover hubs only.
    for (const auto& point : grid) {
        double best = 1e100;
        std::size_t index = 0;
        for (std::size_t i = 0; i < ai.size(); ++i) {
            double distance = 0;
            for (unsigned c = 0; c < 3; ++c) {
                const auto d = ai[i]["PathPos"][c].get<double>() - point[c].get<double>();
                distance += d * d;
            }
            if (distance < best) {
                best = distance;
                index = i;
            }
        }
        if (!ai.empty())
            starts.push_back(index);
    }
    save(output / "AIP.json", {{"AIPaths", ai}, {"RaceLines", race}, {"StartPosList", starts}});
}

void splines(const Records& records, const std::map<Key, std::string>& names, const std::filesystem::path& output,
             const ImportCancel& cancel) {
    // [Trailmap: 514-splines] Keep animation paths in Source. Rail admission
    // is a name-based approximation, never a claim about decoded scripts.
    Json rows = Json::array();
    for (const auto& [key, bytes] : records) {
        if (key.first != 8 || bytes.empty())
            continue;
        check_cancel(cancel);
        const auto label = names.at(key), folded = lower(label);
        if (!contains(folded, {"rail", "slide", "log", "fence", "boxcar", "bench"}) ||
            contains(folded, {"path", "gondola", "osprey", "eagle", "raven", "handplant", "dragon", "rocket"}))
            continue;
        Bytes b{bytes};
        const auto n = b.le(32);
        require(n <= 10000, "too many spline segments");
        b.range(48, std::size_t(n) * 144);
        Json segments = Json::array();
        for (unsigned j = 0; j < n; ++j) {
            const auto p = 64 + j * 144;
            Json power = Json::array(), points = Json::array();
            for (unsigned k = 0; k < 4; ++k)
                power.push_back(vector(b, p + k * 16));
            for (unsigned k = 0; k < 4; ++k) {
                Json point = Json::array();
                for (unsigned c = 0; c < 3; ++c) {
                    const double a = power[0][c], v = power[1][c], w = power[2][c], d = power[3][c];
                    point.push_back(k == 0 ? d : k == 1 ? d + w / 3 : k == 2 ? d + 2 * w / 3 + v / 3 : d + w + v + a);
                }
                points.push_back(point);
            }
            segments.push_back({{"Points", points},
                                {"PowerCoefficients", power},
                                {"ArcLengthCoefficients", vector(b, p + 64, 4)},
                                {"Length", b.number(p + 116)},
                                {"Distance", b.number(p + 120)},
                                {"Previous", j ? int(j - 1) : -1},
                                {"Next", j + 1 < n ? int(j + 1) : -1},
                                {"SourceSegment", j}});
        }
        rows.push_back({{"SplineName", label},
                        {"U0", -1},
                        {"U1", 1},
                        {"SplineStyle", contains(folded, {"log", "tree", "wood"}) ? 12 : 13},
                        {"Segments", segments}});
    }
    save(output / "Splines.json", {{"Splines", rows}});
}

void lights_and_fog(const Records& records, const std::set<unsigned>& sections, const std::filesystem::path& output) {
    // [Trailmap: 515-light-record, 515-placeholder, 515-halo-record,
    // 515-fog-model, 515-fog-placement] Do not read placeholder light bounds.
    Json lights = Json::array(), models = Json::array(), instances = Json::array();
    std::map<std::uint32_t, unsigned> ids;
    for (const auto& [key, bytes] : records) {
        if (!sections.contains(key.second & 255) || bytes.empty())
            continue;
        Bytes b{bytes};
        if (key.first == 6) {
            b.range(0, 112);
            const auto type = b.le(16);
            if (type != 1 && type != 2)
                continue;
            auto colour = vector(b, 32);
            for (auto& c : colour)
                c = c.get<double>() * b.number(20);
            lights.push_back({{"LightName", "Light " + std::to_string(key.second)},
                              {"Type", type},
                              {"SpriteRes", 0},
                              {"UnknownFloat1", b.number(28)},
                              {"Colour", colour},
                              {"Direction", vector(b, 44)},
                              {"Position", vector(b, 56)},
                              {"LowestXYZ", vector(b, 68)},
                              {"HighestXYZ", vector(b, 80)},
                              {"InnerConeCosine", b.number(92)},
                              {"OuterConeCosine", b.number(96)}});
        } else if (key.first == 7) {
            b.range(0, 80);
            lights.push_back({{"LightName", "Halo " + std::to_string(key.second)},
                              {"Type", 2},
                              {"SpriteRes", b.le(12)},
                              {"UnknownFloat1", 0},
                              {"Colour", vector(b, 16)},
                              {"Direction", {0, 0, 0}},
                              {"Position", vector(b, 28)},
                              {"LowestXYZ", vector(b, 40)},
                              {"HighestXYZ", vector(b, 52)}});
        } else if (key.first == 4) {
            const auto count = b.le(4), table = b.le(8);
            require(count <= 256, "invalid fog object count");
            Json objects = Json::array();
            for (unsigned i = 0; i < count; ++i) {
                const auto p = b.le(table + i * 16 + 4), n = b.le(p + 28), frames = p + b.le(p + 32);
                require(n <= 100000, "too many fog puffs");
                b.range(frames, std::size_t(n) * 28);
                Json rows = Json::array();
                for (unsigned j = 0; j < n; ++j)
                    rows.push_back({{"Position", vector(b, frames + j * 28)},
                                    {"Rotation", vector(b, frames + j * 28 + 12)},
                                    {"Unknown", b.number(frames + j * 28 + 24)}});
                objects.push_back(
                    {{"ParticleObject",
                      {{"LowestXYZ", vector(b, p)}, {"HighestXYZ", vector(b, p + 12)}, {"AnimationFrames", rows}}}});
            }
            ids[key.second] = unsigned(models.size());
            models.push_back(
                {{"ParticleModelName", "Fog " + std::to_string(key.second)}, {"ParticleObjectHeaders", objects}});
        }
    }
    for (const auto& [key, bytes] : records) {
        if (key.first != 5 || !sections.contains(key.second & 255))
            continue;
        Bytes b{bytes};
        require(ids.contains(b.le(96)), "fog placement has no model");
        auto row = import_pose(b, 16);
        row["ParticleModelIndex"] = ids.at(b.le(96));
        row["ParticleName"] = "Fog " + std::to_string(key.second);
        row["LowestXYZ"] = vector(b, 104);
        row["HighestXYZ"] = vector(b, 116);
        instances.push_back(row);
    }
    save(output / "Lights.json", {{"Lights", lights}});
    save(output / "ParticleModels.json", {{"ParticlePrefabs", models}});
    save(output / "ParticleInstances.json", {{"Particles", instances}});
}
} // namespace

std::vector<DiscCourse> ssx3_courses(std::span<const std::uint8_t> database, std::uint64_t bytes) {
    const auto names = locations(Bytes{database});
    std::vector<DiscCourse> result;
    for (const auto& name : names)
        if (name != "TRANSP" && !name.ends_with("SKY"))
            result.push_back({"SSX3_" + name, bytes});
    for (const auto* preset : {"PEAK1", "PEAK2", "PEAK3"}) {
        const auto name = std::string("SSX3_") + preset;
        if (!selection(names, name).empty())
            result.push_back({name, bytes});
    }
    return result;
}

void write_ssx3_course(const DiscInput& disc, const DiscInput& stream, std::span<const std::uint8_t> database,
                       std::span<const std::uint8_t> identifiers, std::span<const std::uint8_t> strings,
                       const std::string& course, const std::filesystem::path& output, const ImportProgress& progress,
                       const ImportCancel& cancel) {
    const auto notify = [&](const std::string& stage) {
        check_cancel(cancel);
        if (progress)
            progress(stage);
    };
    const auto names = locations(Bytes{database});
    const auto selected = selection(names, course);
    auto needed = selected;
    needed.insert(0); // Shared mountain materials live in TRANSP.
    const auto sky_letter = course.ends_with("PEAK3")   ? 'E'
                            : course.ends_with("PEAK2") ? 'C'
                            : course.ends_with("PEAK1") ? 'A'
                                                        : course[5];
    std::set<unsigned> sky;
    for (unsigned i = 0; i < names.size(); ++i)
        if (names[i] == std::string(1, sky_letter) + "SKY") {
            sky.insert(i);
            needed.insert(i);
        }
    const auto labels = resource_names(Bytes{identifiers}, Bytes{strings});
    const auto records = read_world(stream, needed, progress, cancel);
    Json warnings = Json::array();
    notify("Converting mountain props and baked vertex lighting");
    auto world_props = props(records, labels, selected, output, warnings, cancel);
    collision(records, labels, world_props, output, warnings, cancel);
    save(output / "Models.json", {{"Models", world_props.models}});
    save(output / "Materials.json", {{"Materials", world_props.materials}});
    save(output / "Instances.json", {{"Instances", world_props.instances}});
    save(output / "Physics.json", {{"Schema", "openslope-physics/v1"}, {"PhysicsHeaders", Json::array()}});
    notify("Converting mountain terrain, textures and lightmaps");
    std::map<unsigned, Image> textures, lightmaps;
    std::set<unsigned> terrain_pages, light_pages;
    Buffer patches;
    std::vector<std::string> patch_names;
    for (const auto& [key, bytes] : records) {
        if (key.first != 1 || !selected.contains(key.second & 255))
            continue;
        Bytes b{bytes};
        require(bytes.size() == 432, "invalid patch length");
        const auto texture = b.le(416, 2), light = b.le(418, 2);
        require(texture < 4096 && light < 4096, "invalid patch page reference");
        terrain_pages.insert(texture);
        light_pages.insert(light);
        if (!lightmaps.contains(light))
            lightmaps.emplace(light, image(Bytes{get(records, 10, (light << 8) | 255)}, light, true));
        const auto begin = patches.size();
        patches.resize(begin + 448);
        auto copy = [&](std::size_t from, std::size_t to, std::size_t length) {
            std::copy_n(bytes.begin() + std::ptrdiff_t(from), length, patches.begin() + std::ptrdiff_t(begin + to));
        };
        copy(16, 0, 16);
        for (unsigned i = 0; i < 4; ++i)
            copy(32 + i * 8, 16 + i * 16, 8);
        copy(64, 80, 256);
        auto put = [&](std::size_t p, unsigned value, unsigned width) {
            for (unsigned i = 0; i < width; ++i)
                patches[begin + p + i] = std::uint8_t(value >> (i * 8));
        };
        const auto surface = b.le(8, 2);
        put(424, surface == 2 ? 3 : surface == 3 ? 4 : surface == 4 ? 5 : surface == 9 ? 9 : surface == 10 ? 13 : 1, 4);
        put(432, texture, 2);
        put(434, light, 2);
        // Widen cells by one output texel, preserving their source edges.
        for (unsigned c = 2; c < 4; ++c) {
            const auto value = b.number(16 + c * 4) + 1.f / 128;
            put(c * 4, std::bit_cast<std::uint32_t>(value), 4);
        }
        patch_names.push_back(labels.at(key));
    }
    require(!patch_names.empty(), "selection has no terrain");
    for (const auto id : terrain_pages)
        world_props.opaque.insert(id);
    auto texture_pages = world_props.opaque;
    texture_pages.insert(world_props.alpha.begin(), world_props.alpha.end());
    for (const auto id : texture_pages)
        textures.emplace(id, image(Bytes{get(records, 9, (id << 8) | 255)}, id, false));
    std::filesystem::create_directory(output / "Textures");
    std::filesystem::create_directory(output / "Lightmaps");
    std::vector<Image> image_names(4096);
    for (const auto& [id, source] : textures) {
        check_cancel(cancel);
        auto opaque = source;
        for (std::size_t p = 3; p < opaque.rgba.size(); p += 4)
            opaque.rgba[p] = 255;
        opaque.name += "_o";
        if (world_props.opaque.contains(id))
            write_png(output / "Textures" / (opaque.name + ".png"), opaque);
        if (world_props.alpha.contains(id))
            write_png(output / "Textures" / (source.name + ".png"), source);
        bool holes = false;
        if (terrain_pages.contains(id)) {
            std::size_t clear = 0, solid = 0;
            for (std::size_t p = 3; p < source.rgba.size(); p += 4) {
                clear += source.rgba[p] < 8;
                solid += source.rgba[p] >= 250;
            }
            holes = clear * 20 >= source.rgba.size() / 4 && solid * 4 >= source.rgba.size() / 4;
            if (holes)
                write_png(output / "Textures" / (source.name + ".png"), source);
        }
        image_names[id].name = holes ? source.name : opaque.name;
    }
    for (const auto& [id, source] : lightmaps) {
        check_cancel(cancel);
        write_png(output / "Lightmaps" / (number(id) + ".png"), lightmap(source));
    }
    save(output / "Patches.json", Json::parse(patch_document(patches, patch_names, image_names)));
    notify("Converting paths, rails, lights and fog banks");
    paths(records, selected, course, output, cancel);
    splines(records, labels, output, cancel);
    lights_and_fog(records, selected, output);
    if (!sky.empty()) {
        notify("Converting sky dome");
        std::filesystem::create_directories(output / "Skybox/Textures");
        auto sky_props = props(records, labels, sky, output / "Skybox", warnings, cancel);
        save(output / "Skybox/Models.json", {{"Models", sky_props.models}});
        save(output / "Skybox/Materials.json", {{"Materials", sky_props.materials}});
        for (const auto id : sky_props.opaque) {
            texture_pages.insert(id);
            auto art = image(Bytes{get(records, 9, (id << 8) | 255)}, id, false);
            for (std::size_t p = 3; p < art.rgba.size(); p += 4)
                art.rgba[p] = 255;
            art.name += "_o";
            write_png(output / "Skybox/Textures" / (art.name + ".png"), art);
        }
        for (const auto id : sky_props.alpha) {
            texture_pages.insert(id);
            const auto art = image(Bytes{get(records, 9, (id << 8) | 255)}, id, false);
            write_png(output / "Skybox/Textures" / (art.name + ".png"), art);
        }
    }
    Json effects = {{"$schema", "openslope-effects-v1.schema.json"},
                    {"kind", "openslope-effects"},
                    {"version", 1},
                    {"header", {{"U1", 0}, {"U2", 0}, {"U3", 0}}},
                    {"target", {{"game", "ssx-3"}, {"platform", "ps2"}, {"region", "unknown"}, {"level", course}}}};
    for (const auto* key :
         {"slots", "graphs", "functions", "objectProperties", "instances", "physics", "collisionModels", "splines"})
        effects[key] = Json::array();
    save(output / "Effects.json", effects);
    notify("Decoding local sound banks and preserving source records");
    std::filesystem::create_directory(output / "Source");
    std::filesystem::create_directory(output / "Audio");
    raw(output / "Source/bam.sdb", database);
    raw(output / "Source/bam.phm", identifiers);
    raw(output / "Source/bam.psm", strings);
    Json source_index = Json::array();
    std::ofstream source_bundle(output / "Source/Resources.bin", std::ios::binary);
    std::uint64_t source_offset = 0;
    for (const auto& [key, bytes] : records) {
        check_cancel(cancel);
        // Per-location banks on this release contain speech. Character dialogue
        // is outside the map importer; shared environmental banks are separate.
        if (key.first == 20)
            continue;
        if ((key.first == 9 || key.first == 10) &&
            !((key.first == 9 ? texture_pages : light_pages).contains(key.second >> 8)))
            continue;
        source_bundle.write(reinterpret_cast<const char*>(bytes.data()), std::streamsize(bytes.size()));
        require(bool(source_bundle), "cannot save source resource bundle");
        source_index.push_back({{"Bin", key.first},
                                {"Resource", key.second},
                                {"File", "Resources.bin"},
                                {"Offset", source_offset},
                                {"Bytes", bytes.size()}});
        source_offset += bytes.size();
    }
    source_bundle.close();
    require(bool(source_bundle), "cannot finish source resource bundle");
    save(output / "Source/Resources.json", source_index);
    const auto audio = write_ssx3_audio(disc, output, progress, cancel);
    save(output / "Origin.json", {{"Schema", "openslope-origin/v1"},
                                  {"Origin", "retail"},
                                  {"RetailData", true},
                                  {"Course", course},
                                  {"Reasons", {"retail-extract"}}});
    Json outputs = {"Patches.json",
                    "Textures",
                    "Lightmaps",
                    "Models.json",
                    "Materials.json",
                    "Instances.json",
                    "Meshes",
                    "Collision",
                    "Physics.json",
                    "AIP.json",
                    "Splines.json",
                    "Lights.json",
                    "ParticleModels.json",
                    "ParticleInstances.json",
                    "Effects.json",
                    "Audio",
                    "Source",
                    "Origin.json"};
    if (!sky.empty())
        outputs.push_back("Skybox");
    save(output / "Import.json",
         {{"Schema", "openslope-native-import/v1"},
          {"Course", course},
          {"Complete", false},
          {"Sections", selected},
          {"Warnings", warnings},
          {"AudioAssets", audio},
          {"Outputs", outputs},
          {"Deferred",
           {"compiled-world-scripts", "sound-trigger-bindings", "sphere-tree-collision", "model-animation",
            "secondary-texture-pass", "surface-response-parity", "peak-race-connectors", "music-and-board-audio",
            "native-baked-vertex-lighting", "local-light-cone-playback", "path-rating-and-event-semantics"}}});
    notify("Validating shared map contracts");
    static_cast<void>(Terrain::load(output));
    static_cast<void>(Props::load(output));
    static_cast<void>(World::load(output));
    static_cast<void>(Rails::load(output));
    static_cast<void>(CoursePaths::load(output));
    static_cast<void>(CollisionWorld::load(output));
    static_cast<void>(WorldLogic::load(output));
}
} // namespace openslope::import_detail
