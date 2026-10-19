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

unsigned sector(std::uint32_t id, bool tour) { return id & (tour ? 65535u : 255u); }

std::uint32_t texture_key(unsigned id, bool tour) { return tour ? id << 16 : (id << 8) | 255; }

void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(std::string("Streamed world: ") + message);
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
std::map<Key, std::string> resource_names(Bytes ids, Bytes strings, bool tour = false, bool sky = false) {
    const unsigned arrays = tour ? (sky ? 4 : 8) : 5;
    require(ids.le(8) == arrays && strings.le(8) == arrays, "invalid resource-name array count");
    std::map<Key, std::string> result;
    const std::vector<unsigned> bins =
        tour ? (sky ? std::vector<unsigned>{3, 2, 9, 15} : std::vector<unsigned>{1, 3, 2, 9, 8, 15, 24, 25})
             : std::vector<unsigned>{1, 3, 2, 8, 12};
    std::size_t p = 12, q = 12;
    for (unsigned array = 0; array < arrays; ++array) {
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
            const bool inserted = result.emplace(Key{bins[array], rid}, strings.text(begin, cursor - begin)).second;
            require(tour || inserted, "duplicate resource name id");
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
    if (it == records.end() || it->second.empty())
        throw std::runtime_error("Missing world resource bin " + std::to_string(bin) + " id " + std::to_string(id));
    return it->second;
}

// [Trailmap: 510-ssb, 510-empty, 512-ids] Keep one bounded group in
// memory, reading sectors on demand in the browser as well as on desktop.
Records read_world(const DiscInput& stream, const std::set<unsigned>& selected, const ImportProgress& progress,
                   const ImportCancel& cancel, bool tour = false, bool night = false, Bytes database = {}) {
    require(stream.size && stream.size % 32768 == 0 && stream.size <= 512ull * 1024 * 1024,
            "invalid world stream extent");
    Records records;
    Buffer group;
    std::vector<std::pair<std::size_t, bool>> boundaries;
    std::size_t total = 0, count = 0, group_index = 0;
    const unsigned first_sector = tour && database.data.empty() ? 1 : 2;
    for (std::uint64_t p = 0; p < stream.size; p += 32768) {
        check_cancel(cancel);
        if (progress && p % (32768 * 64) == 0)
            progress("Reading mountain stream " + std::to_string(p * 100 / stream.size) + "%");
        const bool skipped = tour && !selected.contains(unsigned(group_index + first_sector));
        const auto chunk = stream.read(p, skipped ? 12 : 32768);
        Bytes b{chunk};
        const auto tag = b.text(0, 4);
        require((tag == "CBXS" || tag == "CEND") && b.le(4) == 32768, "invalid streaming chunk");
        if (skipped) {
            if (tag == "CEND")
                ++group_index;
            continue;
        }
        const auto flags = tour ? b.le(8, 1) : 0;
        require(!tour || ((flags & 3) && !(flags & ~11u)), "invalid streaming block flags");
        auto payload = tour && (flags & 8) ? Buffer(chunk.begin() + 12, chunk.end())
                                           : decode_refpack(b.data.subspan(tour ? 12 : 8));
        if (tour) {
            const auto carry = b.le(8) >> 8;
            require(carry <= 32 * 1024 * 1024, "streaming carry exceeds limit");
            boundaries.emplace_back(group.size() + carry, tag == "CEND" && (flags & 8) && !carry);
        }
        require(group.size() + payload.size() <= 32 * 1024 * 1024, "streaming group exceeds 32 MiB");
        group.insert(group.end(), payload.begin(), payload.end());
        if (tag != "CEND")
            continue;
        Bytes data{group};
        std::size_t cursor = 0;
        std::set<std::size_t> starts;
        while (cursor < group.size()) {
            check_cancel(cancel);
            data.range(cursor, 8);
            const auto word = data.le(cursor), rid = data.le(cursor + 4);
            if (tour && !word && !rid) {
                require(std::all_of(group.begin() + std::ptrdiff_t(cursor), group.end(), [](auto v) { return v == 0; }),
                        "nonzero data after streaming padding");
                break;
            }
            const auto bin = word & 255, size = tour ? word >> 10 : word >> 8;
            if (tour)
                starts.insert(cursor);
            const auto mask = (word >> 8) & 3;
            require(bin <= (tour ? 27u : 22u) && ++count <= 250000 && (!tour || mask),
                    "invalid streaming resource header");
            require(!tour || sector(rid, true) == 0 || sector(rid, true) == group_index + first_sector,
                    "resource in wrong sector");
            cursor += 8;
            data.range(cursor, size);
            if (tour ? bool(mask & (night ? 2 : 1)) : (selected.contains(rid & 255) || bin == 9 || bin == 10)) {
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
        if (tour && !database.data.empty())
            require(cursor == database.le(328 + group_index * 108 + 36), "streaming database size mismatch");
        if (tour)
            for (const auto& [position, padding] : boundaries)
                require(padding || starts.contains(position) || position == cursor,
                        "streaming carry misses record boundary");
        boundaries.clear();
        group.clear();
        ++group_index;
    }
    require(group.empty(), "unterminated streaming group");
    if (tour && !database.data.empty())
        require(group_index + 2 == database.le(10, 2), "streaming group count mismatch");
    return records;
}

// [Trailmap: 512-formats, 512-full-range, 512-alpha-scale,
// 512-palette-order, 512-palette-extent, 511-lm-pages]
Image image(Bytes b, unsigned id, bool lightmap, bool tour = false) {
    b.range(0, 128);
    const auto type = b.le(0, 1), w = b.le(tour ? 24 : 4, tour ? 4 : 2), h = b.le(tour ? 28 : 6, tour ? 4 : 2);
    require((type == 1 || type == 2 || type == 5) && w && h && w <= 2048 && h <= 2048 && (!lightmap || type == 5),
            "unsupported world texture");
    const auto pixels = std::size_t(w) * h;
    const auto stride = type == 5 ? 4u : 1u;
    b.range(128, type == 1 ? (pixels + 1) / 2 : pixels * stride);
    std::size_t palette = tour ? b.le(4) : b.le(1, 3);
    unsigned colours = 0;
    if (type != 5) {
        require(palette >= 128 + (type == 1 ? (pixels + 1) / 2 : pixels), "palette overlaps pixels");
        b.range(palette, 128);
        require(b.le(palette, 1) == 33, "missing world texture palette");
        colours = tour ? (type == 1 ? 16 : 256) : b.le(palette + 4, 2);
        require(colours && colours <= (type == 1 ? 16u : 256u), "invalid world palette count");
        palette += 128;
    }
    Image result{number(id), w, h, Buffer(pixels * 4)};
    for (std::size_t p = 0; p < pixels; ++p) {
        std::size_t source = 128 + p * 4;
        if (type != 5) {
            const unsigned x = unsigned(p % w), y = unsigned(p / w);
            std::size_t offset = type == 1 ? p / 2 : p;
            unsigned nibble = unsigned(p & 1);
            // Streamed image payloads are arranged for a 32-bit GS upload.
            // Sub-tile images retain their compact linear representation.
            if (type == 2 && w >= 16 && h >= 4) {
                const auto swap = (((y + 2) >> 2) & 1) * 4;
                const auto row = (((y & ~3u) >> 1) + (y & 1)) & 7;
                offset = (y & ~15u) * w + (x & ~15u) * 2 + row * w * 2 + ((x + swap) & 7) * 4 + ((y >> 1) & 1) +
                         ((x >> 2) & 2);
            } else if (type == 1 && w >= 32 && h >= 16) {
                const auto pages = (w + 127) / 128, page = (y / 128) * pages + x / 128;
                const auto swap = (((y + 2) >> 2) & 1) * 4;
                const auto row = (((y & ~3u) >> 1) + (y & 1)) & 7;
                offset = (page / pages) * 32 * w * 2 + (page % pages) * 256 + ((x & 127) & ~31u) / 2 * h +
                         ((y & 127) & ~15u) * 2 + row * h * 2 + ((x + swap) & 7) * 4 + ((x >> 3) & 3);
                nibble = (y >> 1) & 1;
            }
            require(offset < (type == 1 ? (pixels + 1) / 2 : pixels), "invalid swizzled texture extent");
            const auto packed = b.le(128 + offset, 1);
            const auto index = type == 1 ? (packed >> (nibble * 4)) & 15 : packed;
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

Buffer vertex_lighting(Bytes b, bool tour = false) {
    const auto base = b.le(tour ? 144 : 152);
    require(base >= (tour ? 176u : 160u) && base <= b.data.size(), "invalid instance lighting offset");
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
                  const std::filesystem::path& output, Json& warnings, const ImportCancel& cancel, bool tour = false) {
    PropsExport out;
    std::map<std::uint32_t, unsigned> material_ids;
    std::set<std::uint32_t> debug_materials;
    auto name = [&](unsigned kind, std::uint32_t rid) {
        const auto it = names.find({kind, rid});
        require(tour || it != names.end(), "missing authored resource name");
        return it == names.end() ? "Resource " + std::to_string(rid) : it->second;
    };
    std::filesystem::create_directories(output / "Meshes");
    for (const auto& [key, bytes] : records) {
        if (key.first != 0)
            continue;
        Bytes b{bytes};
        b.range(0, 20);
        const auto texture = b.le(0, 2), state = b.le(14, 2);
        const bool alpha = (state & (2 | 4 | 64)) != 0;
        (alpha ? out.alpha : out.opaque).insert(texture);
        if (texture == (tour ? 36u : 17u))
            debug_materials.insert(key.second);
        material_ids[key.second] = unsigned(out.materials.size());
        out.materials.push_back({{"MaterialName", "Material " + std::to_string(key.second)},
                                 {"TexturePath", number(texture) + (alpha ? ".png" : "_o.png")},
                                 {"TextureFlipbook", Json::array()},
                                 {"UnknownInt18", alpha ? 0x40000 : 0},
                                 {"AlphaMode", state & 64  ? "glow"
                                               : state & 4 ? "blend"
                                               : state & 2 ? "cutout"
                                                           : "opaque"}});
    }
    for (const auto& [key, bytes] : records) {
        if (key.first != 2 || (!tour && !sections.contains(sector(key.second, tour))))
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
                const auto parts = b.le(header + (tour ? 24 : 28)), part_table = b.le(header + (tour ? 28 : 32));
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
        if (key.first != 3 || !sections.contains(sector(key.second, tour)))
            continue;
        check_cancel(cancel);
        Bytes b{bytes};
        b.range(0, 160);
        const auto model = b.le(tour ? 120 : 128);
        require(out.model_ids.contains(model), "placement references missing model");
        auto row = import_pose(b, 16, b.number(tour ? 124 : 132));
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
        const auto lighting = vertex_lighting(b, tour);
        if (lighting.size() == out.vertices.at(model) * 2)
            row["VertexLighting"] = base64(lighting);
        else
            warnings.push_back("Baked vertex colour count differs for " + label + "; neutral lighting exported.");
        out.instances.push_back(row);
    }
    return out;
}

void collision(const Records& records, const std::map<Key, std::string>& names, PropsExport& props,
               const std::filesystem::path& output, Json& warnings, const ImportCancel& cancel, bool tour = false) {
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
        const auto name = tour ? "Proxy " + std::to_string(key.second) : names.at(key);
        const auto marker = name.find("_CollideModel_");
        const auto owner = std::pair{key.second & 255, name.substr(0, marker)};
        require(tour || (marker != std::string::npos && placements.contains(owner)), "collision owner is missing");
        const auto model = tour ? key.second : props.instances[placements.at(owner)].at("ModelID").get<unsigned>();
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
        const Bytes original{get(records, 3, row.at("SourceResource").get<unsigned>())};
        if (tour && original.le(148) != 1)
            continue;
        const auto model = tour ? original.le(156) : row.at("ModelID").get<unsigned>();
        if (!bindings.contains(model))
            continue;
        const auto name = lower(row.at("InstanceName").get<std::string>());
        // Undecoded triggers retain geometry without becoming solid walls.
        const bool solid =
            row.at("Visable").get<bool>() || (contains(name, {"fence", "collision", "impassable"}) &&
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
             const ImportCancel& cancel, bool tour = false) {
    // [Trailmap: 514-splines] Keep animation paths in Source. Rail admission
    // is a name-based approximation, never a claim about decoded scripts.
    Json rows = Json::array();
    for (const auto& [key, bytes] : records) {
        if (key.first != 8 || bytes.empty())
            continue;
        check_cancel(cancel);
        const auto label = names.at(key), folded = lower(label);
        if (!(contains(folded, {"rail", "slide", "log", "fence", "boxcar", "bench"}) ||
              (tour && contains(folded, {"wood", "metal"}))) ||
            contains(folded, {"path", "gondola", "osprey", "eagle", "raven", "handplant", "dragon", "rocket"}))
            continue;
        Bytes b{bytes};
        const auto n = b.le(32);
        require(n <= 10000, "too many spline segments");
        const auto stride = tour ? ((b.le(28, 2) == 64) ? 144u : 128u) : 144u;
        b.range(48, std::size_t(n) * stride);
        Json segments = Json::array();
        for (unsigned j = 0; j < n; ++j) {
            const auto p = 64 + j * stride;
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
                                {"ArcLengthCoefficients", tour ? Json{0, 0, 0, 0} : vector(b, p + 64, 4)},
                                {"Length", tour ? 0.f : b.number(p + 116)},
                                {"Distance", tour ? 0.f : b.number(p + 120)},
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

void lights_and_fog(const Records& records, const std::set<unsigned>& sections, const std::filesystem::path& output,
                    bool tour = false) {
    // [Trailmap: 515-light-record, 515-placeholder, 515-halo-record,
    // 515-fog-model, 515-fog-placement] Do not read placeholder light bounds.
    Json lights = Json::array(), models = Json::array(), instances = Json::array();
    std::map<std::uint32_t, unsigned> ids;
    for (const auto& [key, bytes] : records) {
        if (!sections.contains(sector(key.second, tour)) || bytes.empty())
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
                              {"Colour", vector(b, tour ? 20 : 16)},
                              {"Direction", {0, 0, 0}},
                              {"Position", vector(b, tour ? 32 : 28)},
                              {"LowestXYZ", vector(b, tour ? 44 : 40)},
                              {"HighestXYZ", vector(b, tour ? 56 : 52)}});
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
        if (key.first != 5 || !sections.contains(sector(key.second, tour)))
            continue;
        Bytes b{bytes};
        const auto model = b.le(tour ? 100 : 96);
        require(ids.contains(model), "fog placement has no model");
        auto row = import_pose(b, 16);
        row["ParticleModelIndex"] = ids.at(model);
        row["ParticleName"] = "Fog " + std::to_string(key.second);
        row["LowestXYZ"] = vector(b, 104);
        row["HighestXYZ"] = vector(b, 116);
        instances.push_back(row);
    }
    save(output / "Lights.json", {{"Lights", lights}});
    save(output / "ParticleModels.json", {{"ParticlePrefabs", models}});
    save(output / "ParticleInstances.json", {{"Particles", instances}});
}

// [Trailmap: 520-sdb, 520-names, 520-daynight] Course identity comes from
// named terrain and per-track sidecars, never from a whole-world fallback.
unsigned tour_database(Bytes b) {
    b.range(0, 328);
    require(b.le(0) == 0x21004e00, "unsupported On Tour database version");
    const auto sectors = b.le(10, 2);
    require(sectors > 2 && sectors <= 4096, "invalid On Tour sector count");
    require(b.le(48) == 328 + std::size_t(sectors - 2) * 108 && b.le(52) >= b.le(48),
            "invalid On Tour database tables");
    b.range(328, std::size_t(sectors - 2) * 108);
    b.range(b.le(48), std::size_t(b.le(14, 2)) * 40);
    b.range(b.le(52), 0);
    for (unsigned i = 0; i < sectors - 2; ++i)
        require(b.le(328 + i * 108 + 26, 2) == i + 2, "invalid On Tour sector id");
    return sectors;
}

std::string tour_track(const std::string& course) {
    require(course.size() >= 13 && course.starts_with("SSXOT_") &&
                (course.ends_with("_DAY") || course.ends_with("_NIGHT")),
            "invalid On Tour selection");
    const auto end = course.find('_', 6);
    require(end == 9, "invalid On Tour track code");
    const auto track = lower(course.substr(6, 3));
    require(track != "all", "whole-mountain On Tour import is unavailable");
    require(std::all_of(track.begin(), track.end(), [](unsigned char c) { return std::isalnum(c); }),
            "invalid On Tour track name");
    return track;
}

std::set<unsigned> tour_sections(const std::map<Key, std::string>& names, const std::string& track, Bytes database) {
    const auto count = tour_database(database);
    std::set<unsigned> result, named;
    bool terrain = false;
    for (const auto& [key, name] : names) {
        const auto prefix = key.first == 1 ? "patch_" : key.first == 3 ? "mdl_" : key.first == 8 ? "spline_" : "";
        if (!*prefix)
            continue;
        const auto id = sector(key.second, true);
        if (id < 2 || id >= count) {
            require(key.first != 1, "On Tour terrain sector is outside database");
            continue; // Name maps retain mission objects absent from the stream.
        }
        named.insert(id);
        if (name.starts_with(std::string(prefix) + track + "_")) {
            result.insert(id);
            terrain = terrain || key.first == 1;
        }
    }
    require(terrain, "unknown On Tour terrain selection");
    // Some sectors contain only paths, lights or fog. Admit these by overlap
    // with a named course sector, without following a chain across the mountain.
    const auto seeds = result;
    const auto overlaps = [&](unsigned a, unsigned b) {
        const auto p = 328 + std::size_t(a - 2) * 108, q = 328 + std::size_t(b - 2) * 108;
        for (unsigned c = 0; c < 3; ++c) {
            const auto amin = database.number(p + c * 4), amax = database.number(p + 12 + c * 4),
                       bmin = database.number(q + c * 4), bmax = database.number(q + 12 + c * 4);
            if (amin > amax || bmin > bmax || amax < bmin || bmax < amin)
                return false;
        }
        return true;
    };
    for (unsigned id = 2; id < count; ++id)
        if (!named.contains(id) &&
            std::any_of(seeds.begin(), seeds.end(), [&](auto seed) { return overlaps(id, seed); }))
            result.insert(id);
    require(result.size() < count - 2, "whole-mountain On Tour selection is unavailable");
    return result;
}

void tour_paths(const Records& records, Bytes database, const std::string& track, const DiscInput& disc, bool night,
                const std::filesystem::path& output, const ImportCancel& cancel) {
    // [Trailmap: 520-paths] Packed normals precede the horizontal-unit,
    // slope and step tuple. Property words are retained without inventing ratings.
    Json rows = Json::array(), starts = Json::array();
    for (const auto& [key, bytes] : records) {
        if (key.first != 14 || bytes.empty())
            continue;
        check_cancel(cancel);
        Bytes b{bytes};
        require(b.le(0) == 0x69696923 && b.le(4) == 1 && b.le(8) == 3, "unsupported On Tour path header");
        for (unsigned i = 0; i < 3; ++i)
            require(b.le(12 + i * 12) == 100 + i && b.le(16 + i * 12) == 4, "invalid On Tour path properties");
        const auto points = b.le(48), events = b.le(52);
        require(points <= 100000 && events <= 100000, "On Tour path exceeds limits");
        require(bytes.size() == 96 + std::size_t(points) * 20 + std::size_t(events) * 16,
                "invalid On Tour path extent");
        Json row = {{"Name", "Path " + std::to_string(key.second)},
                    {"PathPos", vector(b, 56)},
                    {"PathPoints", Json::array()},
                    {"PathEvents", Json::array()},
                    {"U3", 50},
                    {"Respawnable", true},
                    {"SourceProperties", {b.le(20), b.le(32), b.le(44)}},
                    {"SourceNormals", Json::array()},
                    {"SourceEvents", Json::array()}};
        std::size_t p = 92;
        for (unsigned i = 0; i < points; ++i, p += 20) {
            const auto length = b.number(p + 16);
            require(length >= 0, "negative On Tour path step");
            row["PathPoints"].push_back({double(b.number(p + 4)) * length, double(b.number(p + 8)) * length,
                                         double(b.number(p + 12)) * length});
            row["SourceNormals"].push_back({static_cast<std::int8_t>(b.le(p, 1)),
                                            static_cast<std::int8_t>(b.le(p + 1, 1)),
                                            static_cast<std::int8_t>(b.le(p + 2, 1))});
        }
        p += 4;
        for (unsigned i = 0; i < events; ++i, p += 16)
            row["SourceEvents"].push_back({{"EventType", static_cast<std::int32_t>(b.le(p))},
                                           {"EventValue", b.le(p + 4)},
                                           {"EventStart", b.number(p + 8)},
                                           {"EventEnd", b.number(p + 12)}});
        rows.push_back(std::move(row));
    }
    double best_height = -1e30;
    Json start;
    for (unsigned i = 0; i < database.le(14, 2); ++i) {
        const auto p = database.le(48) + i * 40;
        const auto name = database.text(p, 12);
        if (name.starts_with(track + "_sl") && database.number(p + 24) > best_height) {
            best_height = database.number(p + 24);
            start = vector(database, p + 16);
        }
    }
    if (!rows.empty() && !start.is_null()) {
        double best = 1e100;
        unsigned chosen = 0;
        for (unsigned i = 0; i < rows.size(); ++i) {
            double d = 0;
            for (unsigned c = 0; c < 3; ++c)
                d += std::pow(rows[i]["PathPos"][c].get<double>() - start[c].get<double>(), 2);
            if (d < best) {
                best = d;
                chosen = i;
            }
        }
        starts.push_back(chosen);
    }
    const auto prefix = "data/worlds/" + track + (night ? "n" : "d");
    const auto sidecar = disc_archive_file(disc, "DATA/WORLDS/BAM.BIG", prefix + ".tp");
    Bytes b{sidecar};
    require(b.le(0) == 0x69696942 && b.le(4) <= 1024, "invalid On Tour race path header");
    Json race = Json::array();
    std::size_t p = 8;
    for (unsigned i = 0; i < b.le(4); ++i) {
        check_cancel(cancel);
        require(b.le(p) == 1 && b.le(p + 4) == 0 && b.le(p + 8) == 4, "invalid On Tour race path properties");
        const auto points = b.le(p + 16), events = b.le(p + 20);
        require(points <= 100000 && events <= 100000, "On Tour race path exceeds limits");
        Json row = {{"Name", "Race Line " + std::to_string(i)},
                    {"PathPos", vector(b, p + 24)},
                    {"DistanceToFinish", std::max(0.f, b.number(p + 12))},
                    {"PathPoints", Json::array()},
                    {"PathEvents", Json::array()},
                    {"SourceEvents", Json::array()}};
        p += 60;
        b.range(p, std::size_t(points) * 20 + 4 + std::size_t(events) * 16);
        for (unsigned j = 0; j < points; ++j, p += 20) {
            const auto length = b.number(p + 16);
            require(length >= 0, "negative On Tour race path step");
            row["PathPoints"].push_back({double(b.number(p + 4)) * length, double(b.number(p + 8)) * length,
                                         double(b.number(p + 12)) * length});
        }
        p += 4;
        for (unsigned j = 0; j < events; ++j, p += 16)
            row["SourceEvents"].push_back({{"EventType", static_cast<std::int32_t>(b.le(p))},
                                           {"EventValue", b.le(p + 4)},
                                           {"EventStart", b.number(p + 8)},
                                           {"EventEnd", b.number(p + 12)}});
        race.push_back(std::move(row));
    }
    require(p == sidecar.size(), "On Tour race path extent mismatch");
    std::filesystem::create_directories(output / "Source");
    raw(output / "Source" / (track + (night ? "n.tp" : "d.tp")), sidecar);
    for (const auto& entry : disc_archive_directory(disc, "DATA/WORLDS/BAM.BIG"))
        if (lower(entry.name) == prefix + ".sp")
            raw(output / "Source" / (track + (night ? "n.sp" : "d.sp")),
                disc_archive_file(disc, "DATA/WORLDS/BAM.BIG", entry.name));
    save(output / "AIP.json", {{"AIPaths", rows}, {"RaceLines", race}, {"StartPosList", starts}});
}
} // namespace

std::vector<DiscCourse> ontour_courses(std::span<const std::uint8_t> database, std::span<const std::uint8_t> ids,
                                       std::span<const std::uint8_t> strings, const std::vector<DiscEntry>& members,
                                       std::uint64_t bytes) {
    static_cast<void>(tour_database(Bytes{database}));
    const auto names = resource_names(Bytes{ids}, Bytes{strings}, true);
    std::vector<DiscCourse> result;
    std::set<std::string> seen;
    for (const auto& entry : members) {
        const auto path = lower(entry.name);
        const auto slash = path.find_last_of('/');
        const auto leaf = path.substr(slash == std::string::npos ? 0 : slash + 1);
        if (leaf.size() != 7 || !leaf.ends_with(".tp") || (leaf[3] != 'd' && leaf[3] != 'n'))
            continue;
        const auto track = leaf.substr(0, 3);
        if (track == "all")
            continue;
        static_cast<void>(tour_sections(names, track, Bytes{database}));
        std::string code = track;
        for (auto& c : code)
            c = char(std::toupper(static_cast<unsigned char>(c)));
        const auto course = "SSXOT_" + code + (leaf[3] == 'd' ? "_DAY" : "_NIGHT");
        if (seen.insert(course).second)
            result.push_back({course, bytes});
    }
    require(!result.empty(), "On Tour has no supported track selections");
    std::sort(result.begin(), result.end(), [](const auto& a, const auto& b) { return a.name < b.name; });
    return result;
}

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

void write_mountain_course(const DiscInput& disc, const DiscInput& stream, std::span<const std::uint8_t> database,
                           std::span<const std::uint8_t> identifiers, std::span<const std::uint8_t> strings,
                           const std::string& course, const std::filesystem::path& output,
                           const ImportProgress& progress, const ImportCancel& cancel) {
    const auto notify = [&](const std::string& stage) {
        check_cancel(cancel);
        if (progress)
            progress(stage);
    };
    const bool tour = course.starts_with("SSXOT_");
    const bool night = tour && course.ends_with("_NIGHT");
    const auto labels = resource_names(Bytes{identifiers}, Bytes{strings}, tour);
    const auto names = tour ? std::vector<std::string>{} : locations(Bytes{database});
    const auto selected = tour ? tour_sections(labels, tour_track(course), Bytes{database}) : selection(names, course);
    auto needed = selected;
    std::set<unsigned> sky;
    if (!tour) {
        needed.insert(0);
        const auto sky_letter = course.ends_with("PEAK3")   ? 'E'
                                : course.ends_with("PEAK2") ? 'C'
                                : course.ends_with("PEAK1") ? 'A'
                                                            : course[5];
        for (unsigned i = 0; i < names.size(); ++i)
            if (names[i] == std::string(1, sky_letter) + "SKY") {
                sky.insert(i);
                needed.insert(i);
            }
    }
    const auto records = read_world(stream, needed, progress, cancel, tour, night, tour ? Bytes{database} : Bytes{});
    Json warnings = Json::array();
    notify("Converting mountain props and baked vertex lighting");
    auto world_props = props(records, labels, selected, output, warnings, cancel, tour);
    collision(records, labels, world_props, output, warnings, cancel, tour);
    save(output / "Models.json", {{"Models", world_props.models}});
    save(output / "Materials.json", {{"Materials", world_props.materials}});
    save(output / "Instances.json", {{"Instances", world_props.instances}});
    save(output / "Physics.json", {{"Schema", "openslope-physics/v1"}, {"PhysicsHeaders", Json::array()}});
    notify("Converting mountain terrain, textures and lightmaps");
    std::map<unsigned, Image> textures, lightmaps;
    std::set<unsigned> terrain_pages, light_pages;
    std::map<unsigned, unsigned> light_ids;
    Buffer patches;
    std::vector<std::string> patch_names;
    for (const auto& [key, bytes] : records) {
        if (key.first != 1 || !selected.contains(sector(key.second, tour)))
            continue;
        Bytes b{bytes};
        require(bytes.size() == 432, "invalid patch length");
        if (tour && !labels.at(key).starts_with("patch_" + tour_track(course) + "_"))
            continue;
        const auto texture = b.le(tour ? 412 : 416, 2), source_light = b.le(tour ? 414 : 418, 2);
        require(texture < 4096 && source_light < 4096, "invalid patch page reference");
        const auto light_key = tour ? (source_light << 16) | sector(key.second, true) : (source_light << 8) | 255;
        const auto light =
            tour ? light_ids.try_emplace(light_key, unsigned(light_ids.size())).first->second : source_light;
        terrain_pages.insert(texture);
        light_pages.insert(tour ? light_key : source_light);
        if (!lightmaps.contains(light))
            lightmaps.emplace(light, image(Bytes{get(records, 10, light_key)}, light, true, tour));
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
        put(424,
            tour            ? 1
            : surface == 2  ? 3
            : surface == 3  ? 4
            : surface == 4  ? 5
            : surface == 9  ? 9
            : surface == 10 ? 13
                            : 1,
            4);
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
    for (const auto id : texture_pages) {
        if (tour && id == 32 && !records.contains({9, texture_key(id, true)})) {
            textures.emplace(id, Image{number(id), 1, 1, {255, 255, 255, 255}});
            warnings.push_back("Reserved engine texture 32 is absent from the stream; neutral white exported.");
        } else
            textures.emplace(id, image(Bytes{get(records, 9, texture_key(id, tour))}, id, false, tour));
    }
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
    if (tour)
        tour_paths(records, Bytes{database}, tour_track(course), disc, night, output, cancel);
    else
        paths(records, selected, course, output, cancel);
    splines(records, labels, output, cancel, tour);
    auto lighting_sections = selected;
    if (tour)
        lighting_sections.insert(0);
    lights_and_fog(records, lighting_sections, output, tour);
    if (!sky.empty()) {
        notify("Converting sky dome");
        std::filesystem::create_directories(output / "Skybox/Textures");
        auto sky_props = props(records, labels, sky, output / "Skybox", warnings, cancel);
        save(output / "Skybox/Models.json", {{"Models", sky_props.models}});
        save(output / "Skybox/Materials.json", {{"Materials", sky_props.materials}});
        for (const auto id : sky_props.opaque) {
            texture_pages.insert(id);
            auto art = image(Bytes{get(records, 9, texture_key(id, tour))}, id, false, tour);
            for (std::size_t p = 3; p < art.rgba.size(); p += 4)
                art.rgba[p] = 255;
            art.name += "_o";
            write_png(output / "Skybox/Textures" / (art.name + ".png"), art);
        }
        for (const auto id : sky_props.alpha) {
            texture_pages.insert(id);
            const auto art = image(Bytes{get(records, 9, texture_key(id, tour))}, id, false, tour);
            write_png(output / "Skybox/Textures" / (art.name + ".png"), art);
        }
    }
    if (tour) {
        const auto entries = disc_directory(disc, "DATA/WORLDS");
        if (std::any_of(entries.begin(), entries.end(), [](const auto& e) { return lower(e.name) == "skybox.big"; })) {
            notify("Converting On Tour sky dome");
            const auto inventory = disc_archive_directory(disc, "DATA/WORLDS/SKYBOX.BIG");
            auto prefix = "data/worlds/" + tour_track(course).substr(0, 2) + "sky" + (night ? "n" : "d");
            if (std::none_of(inventory.begin(), inventory.end(),
                             [&](const auto& e) { return lower(e.name) == prefix + ".ssb"; })) {
                prefix.back() = 'd';
                warnings.push_back("Night sky archive is absent; this track's day sky retained.");
            }
            const auto sky_bytes = disc_archive_file(disc, "DATA/WORLDS/SKYBOX.BIG", prefix + ".ssb");
            const auto sky_ids = disc_archive_file(disc, "DATA/WORLDS/SKYBOX.BIG", prefix + ".phm");
            const auto sky_names = disc_archive_file(disc, "DATA/WORLDS/SKYBOX.BIG", prefix + ".psm");
            DiscInput sky_stream{sky_bytes.size(), [&](std::uint64_t p, std::span<std::uint8_t> bytes) {
                                     std::copy_n(sky_bytes.begin() + std::ptrdiff_t(p), bytes.size(), bytes.begin());
                                 }};
            const auto sky_records = read_world(sky_stream, {1}, progress, cancel, true);
            const auto sky_labels = resource_names(Bytes{sky_ids}, Bytes{sky_names}, true, true);
            std::filesystem::create_directories(output / "Skybox/Textures");
            const auto sky_props = props(sky_records, sky_labels, {1}, output / "Skybox", warnings, cancel, true);
            save(output / "Skybox/Models.json", {{"Models", sky_props.models}});
            save(output / "Skybox/Materials.json", {{"Materials", sky_props.materials}});
            auto pages = sky_props.opaque;
            pages.insert(sky_props.alpha.begin(), sky_props.alpha.end());
            for (const auto id : pages) {
                auto art = image(Bytes{get(sky_records, 9, texture_key(id, true))}, id, false, true);
                if (sky_props.alpha.contains(id))
                    write_png(output / "Skybox/Textures" / (art.name + ".png"), art);
                if (sky_props.opaque.contains(id)) {
                    for (std::size_t i = 3; i < art.rgba.size(); i += 4)
                        art.rgba[i] = 255;
                    write_png(output / "Skybox/Textures" / (art.name + "_o.png"), art);
                }
            }
            sky.insert(1);
        }
    }
    Json effects = {
        {"$schema", "openslope-effects-v1.schema.json"},
        {"kind", "openslope-effects"},
        {"version", 1},
        {"header", {{"U1", 0}, {"U2", 0}, {"U3", 0}}},
        {"target",
         {{"game", tour ? "ssx-on-tour" : "ssx-3"}, {"platform", "ps2"}, {"region", "unknown"}, {"level", course}}}};
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
        if (key.first == (tour ? 18u : 20u))
            continue;
        if (key.first == 9 && !texture_pages.contains(key.second >> (tour ? 16 : 8)))
            continue;
        if (key.first == 10 && !light_pages.contains(tour ? key.second : key.second >> 8))
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
    const auto audio = tour ? write_ontour_audio(disc, output, course, progress, cancel)
                            : write_ssx3_audio(disc, output, course, progress, cancel);
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
          {"Game", tour ? "ssx-on-tour" : "ssx-3"},
          {"TimeOfDay", tour ? (night ? "night" : "day") : "source"},
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
