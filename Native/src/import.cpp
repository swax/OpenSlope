#include "import_internal.hpp"
#include "openslope/collision.hpp"
#include "openslope/particles.hpp"
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
#include <map>
#include <nlohmann/json.hpp>
#include <set>
#include <sstream>

namespace openslope {
namespace {
using import_detail::Bytes;
using Json = nlohmann::json;

std::string upper(std::string s) {
    for (auto& c : s)
        c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    return s;
}

std::string trim(std::string s) {
    while (!s.empty() && (s.back() == ' ' || s.back() == '\r'))
        s.pop_back();
    return s;
}

struct Extent {
    std::string name;
    std::uint64_t offset{}, size{};
    bool directory{};
};

std::vector<Extent> archive_index(const DiscInput& disc, const Extent& extent) {
    const auto header = disc.read(extent.offset, static_cast<std::size_t>(std::min<std::uint64_t>(extent.size, 16)));
    Bytes h{header};
    const bool compact = header.size() >= 6 && h.be(0, 2) == 0xc0fb;
    if (!compact && (header.size() < 16 || (h.text(0, 4) != "BIGF" && h.text(0, 4) != "BIG4")))
        throw std::runtime_error("Unsupported audio archive");
    const unsigned width = compact ? 3 : 4;
    const std::size_t end = compact ? h.be(2, 2) + 4 : h.be(12), start = compact ? 6 : 16;
    if (end < start || end > extent.size || end > 4 * 1024 * 1024)
        throw std::runtime_error("Invalid archive index extent");
    const auto table = disc.read(extent.offset, end);
    Bytes b{table};
    std::vector<Extent> result;
    std::set<std::string> names;
    std::size_t entries = 0;
    for (std::size_t p = start; p < end;) {
        if (++entries > 65535 || end - p < 2 * width + 1)
            throw std::runtime_error("Invalid archive index count");
        const auto offset = b.be(p, width), size = b.be(p + width, width);
        p += 2 * width;
        const auto begin = p;
        while (p < end && table[p])
            ++p;
        if (p == end || p - begin > 512)
            throw std::runtime_error("Invalid archive member name");
        auto name = b.text(begin, p - begin);
        ++p;
        std::replace(name.begin(), name.end(), '\\', '/');
        if (name.empty() || name.front() == '/')
            throw std::runtime_error("Unsafe archive member");
        std::istringstream path(name);
        std::string segment;
        while (std::getline(path, segment, '/'))
            if (segment != "*" && !valid_map_name(segment))
                throw std::runtime_error("Unsafe archive member segment");
        if (!offset || name.find('*') != std::string::npos)
            continue;
        if (offset < end || offset > extent.size || size > extent.size - offset || !names.insert(upper(name)).second)
            throw std::runtime_error("Invalid or duplicate archive member");
        result.push_back({name, extent.offset + offset, size, false});
    }
    return result;
}

// [Trailmap: 200-iso] ISO9660 primary directory records, logical sectors of 2048 bytes.
class Iso {
    const DiscInput& disc_;
    Extent root_;

    Extent record(Bytes b, std::size_t p) const {
        const auto length = b.le(p, 1);
        if (length < 34)
            throw std::runtime_error("Invalid ISO directory record");
        b.range(p, length);
        const auto name_length = b.le(p + 32, 1);
        if (name_length > length - 33)
            throw std::runtime_error("Invalid ISO filename length");
        const auto lba = b.le(p + 2), size = b.le(p + 10);
        if (lba != b.be(p + 6) || size != b.be(p + 14))
            throw std::runtime_error("ISO endian fields disagree");
        if (b.le(p + 1, 1) || b.le(p + 26, 1) || b.le(p + 27, 1) || (b.le(p + 25, 1) & 0x80))
            throw std::runtime_error("Extended, interleaved or multi-extent ISO files are unsupported");
        const std::uint64_t offset = std::uint64_t(lba) * 2048;
        if (offset > disc_.size || size > disc_.size - offset)
            throw std::runtime_error("ISO directory points outside image");
        auto name = b.text(p + 33, name_length);
        const auto semi = name.find(';');
        if (semi != std::string::npos)
            name.resize(semi);
        return {name, offset, size, (b.le(p + 25, 1) & 2) != 0};
    }

public:
    explicit Iso(const DiscInput& disc) : disc_(disc) {
        for (unsigned sector = 16; sector < 48; ++sector) {
            const auto raw = disc.read(std::uint64_t(sector) * 2048, 2048);
            Bytes b{raw};
            if (b.text(1, 5) != "CD001" || b.le(6, 1) != 1)
                throw std::runtime_error("This is not an ISO9660 disc image");
            if (b.le(0, 1) == 255)
                break;
            if (b.le(0, 1) == 1) {
                if (b.le(128, 2) != 2048 || b.be(130, 2) != 2048)
                    throw std::runtime_error("ISO logical sector size is unsupported");
                root_ = record(b, 156);
                if (!root_.directory)
                    throw std::runtime_error("Invalid ISO root");
                return;
            }
        }
        throw std::runtime_error("ISO primary volume descriptor is missing");
    }

    std::vector<Extent> children(const Extent& directory) const {
        if (!directory.directory || directory.size > 4 * 1024 * 1024)
            throw std::runtime_error("Invalid or oversized ISO directory");
        const auto data = disc_.read(directory.offset, static_cast<std::size_t>(directory.size));
        Bytes b{data};
        std::vector<Extent> result;
        for (std::size_t p = 0; p < data.size();) {
            const auto size = data[p];
            if (!size) {
                p = std::min(data.size(), (p / 2048 + 1) * 2048);
                continue;
            }
            if (size > 2048 - p % 2048)
                throw std::runtime_error("ISO record crosses a sector boundary");
            auto entry = record(b, p);
            p += size;
            if (entry.name.size() == 1 && (entry.name[0] == 0 || entry.name[0] == 1))
                continue;
            if (!valid_map_name(entry.name))
                throw std::runtime_error("Unsafe ISO filename");
            if (result.size() >= 65535)
                throw std::runtime_error("ISO directory has too many entries");
            result.push_back(std::move(entry));
        }
        return result;
    }

    Extent find(const std::string& path) const {
        Extent current = root_;
        std::istringstream stream(path);
        std::string part;
        while (std::getline(stream, part, '/')) {
            if (!valid_map_name(part))
                throw std::runtime_error("Invalid disc path");
            const auto entries = children(current);
            const auto it = std::find_if(entries.begin(), entries.end(),
                                         [&](const auto& e) { return upper(e.name) == upper(part); });
            if (it == entries.end())
                throw std::runtime_error("Disc has no " + path);
            current = *it;
        }
        return current;
    }
};

// [Trailmap: 200-c0fb, 200-bigf, 200-c0fb-entries] Offsets are absolute;
// header end bounds the entry walk, including placeholder entries.
std::map<std::string, std::vector<std::uint8_t>> archive(const DiscInput& disc, const Extent& extent,
                                                         const ImportCancel& cancelled) {
    const auto raw = disc.read(extent.offset, static_cast<std::size_t>(extent.size));
    Bytes b{raw};
    const bool compact = raw.size() >= 6 && b.be(0, 2) == 0xc0fb;
    if (!compact && (raw.size() < 16 || (b.text(0, 4) != "BIGF" && b.text(0, 4) != "BIG4")))
        throw std::runtime_error("Unsupported level archive");
    const unsigned width = compact ? 3 : 4;
    const std::size_t end = compact ? b.be(2, 2) + 4 : b.be(12);
    std::size_t p = compact ? 6 : 16;
    if (end < p || end > raw.size())
        throw std::runtime_error("Invalid BIG header extent");
    std::map<std::string, std::vector<std::uint8_t>> members;
    std::size_t total = 0, entries = 0;
    while (p < end) {
        import_detail::check_cancel(cancelled);
        if (++entries > 65535 || end - p < 2 * width + 1)
            throw std::runtime_error("Invalid BIG entry table");
        const auto offset = b.be(p, width), size = b.be(p + width, width);
        p += 2 * width;
        const auto start = p;
        while (p < end && raw[p])
            ++p;
        if (p == end || p - start > 512)
            throw std::runtime_error("Unterminated BIG member name");
        auto name = b.text(start, p - start);
        ++p;
        std::replace(name.begin(), name.end(), '\\', '/');
        std::istringstream path(name);
        std::string segment;
        while (std::getline(path, segment, '/'))
            if (segment != "*" && !valid_map_name(segment))
                throw std::runtime_error("Unsafe BIG member path");
        if (name.empty() || name.front() == '/')
            throw std::runtime_error("Unsafe BIG member path");
        if (!offset || name.find('*') != std::string::npos)
            continue;
        if (offset < end)
            throw std::runtime_error("BIG member overlaps its table");
        b.range(offset, size);
        auto bytes = decode_refpack(b.data.subspan(offset, size));
        total += bytes.size();
        if (total > 256 * 1024 * 1024)
            throw std::runtime_error("Level archive exceeds import memory limit");
        name = upper(name.substr(name.find_last_of('/') == std::string::npos ? 0 : name.find_last_of('/') + 1));
        if (!members.emplace(name, std::move(bytes)).second)
            throw std::runtime_error("Duplicate level member");
    }
    return members;
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

void pbd_header(Bytes b) {
    b.range(0, 136);
    if (b.le(0) != 0x011b1500)
        throw std::runtime_error("Only SSX Tricky PS2 courses are supported by this importer");
    if (b.le(44) > 4000)
        throw std::runtime_error("PBD model count exceeds its format limit");
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
    Json rows = Json::array();
    for (std::size_t i = 0; i < count; ++i) {
        const auto p = offset + i * 448;
        Json points = Json::array(), uv = Json::array(), tile = Json::array();
        // [Trailmap: 220-power-basis] Tensor-product monomial-to-Bernstein
        // conversion, with reversed on-disc row-major coefficient storage.
        std::array<std::array<double, 3>, 16> coefficients{};
        for (std::size_t j = 0; j < 16; ++j)
            for (unsigned axis = 0; axis < 3; ++axis)
                coefficients[j][axis] = b.number(p + 80 + (15 - j) * 16 + axis * 4);
        // t^k = sum(i=k..3) C(i,k)/C(3,k) B_i^3(t). Apply this
        // identity directly in both dimensions; no decoder-specific recurrence.
        constexpr double binomial[4][4] = {{1, 0, 0, 0}, {1, 1, 0, 0}, {1, 2, 1, 0}, {1, 3, 3, 1}};
        for (std::size_t u = 0; u < 4; ++u)
            for (std::size_t v = 0; v < 4; ++v) {
                std::array<double, 3> control{};
                for (std::size_t a = 0; a <= u; ++a)
                    for (std::size_t c = 0; c <= v; ++c) {
                        const double weight = (binomial[u][a] / binomial[3][a]) * (binomial[v][c] / binomial[3][c]);
                        for (unsigned axis = 0; axis < 3; ++axis)
                            control[axis] += coefficients[a * 4 + c][axis] * weight;
                    }
                points.push_back(control);
            }
        for (unsigned c = 0; c < 4; ++c) {
            uv.push_back({b.number(p + 16 + c * 16), b.number(p + 20 + c * 16)});
            tile.push_back(b.number(p + c * 4));
        }
        const auto texture = b.signed16(p + 432), lightmap = b.signed16(p + 434);
        if (texture < 0 || static_cast<std::size_t>(texture) >= images.size())
            throw std::runtime_error("Terrain references a missing texture");
        rows.push_back({{"PatchName", names[i]},
                        {"LightMapPoint", tile},
                        {"UVPoints", uv},
                        {"Points", points},
                        {"SurfaceType", b.le(p + 424)},
                        {"TrickOnlyPatch", b.signed16(p + 430) < 0},
                        {"TexturePath", images[static_cast<std::size_t>(texture)].name + ".png"},
                        {"LightmapID", lightmap}});
    }
    return {{"Patches", rows}};
}

void write_json(const std::filesystem::path& path, const Json& document) {
    std::ofstream stream(path, std::ios::binary);
    stream << document.dump() << '\n';
    if (!stream)
        throw std::runtime_error("Cannot write map output");
}
} // namespace

std::vector<DiscCourse> disc_courses(const DiscInput& disc, const ImportCancel& cancelled) {
    Iso iso(disc);
    std::vector<DiscCourse> result;
    for (const auto& entry : iso.children(iso.find("DATA/MODELS"))) {
        import_detail::check_cancel(cancelled);
        const auto name = upper(entry.name);
        if (entry.directory || !name.ends_with(".BIG") || name == "SSXFE.BIG")
            continue;
        const auto stem = name.substr(0, name.size() - 4);
        // Discovery needs the PBD format header, not decoded textures, audio or
        // source sidecars for every course. Validate the full index and leaf
        // names now; extraction still decodes and validates every member.
        std::map<std::string, Extent> files;
        for (auto file : archive_index(disc, entry)) {
            import_detail::check_cancel(cancelled);
            const auto slash = file.name.find_last_of('/');
            const auto leaf = upper(file.name.substr(slash == std::string::npos ? 0 : slash + 1));
            if (!files.emplace(leaf, std::move(file)).second)
                throw std::runtime_error("Duplicate level member");
        }
        const auto it = files.find(stem + ".PBD");
        if (it != files.end()) {
            const auto geometry =
                decode_refpack(disc.read(it->second.offset, static_cast<std::size_t>(it->second.size)));
            pbd_header(Bytes{geometry});
            if (!files.contains(stem + ".MAP") || !files.contains(stem + ".SSH"))
                throw std::runtime_error("Course archive is incomplete");
            result.push_back({stem, entry.size});
        }
    }
    if (result.empty())
        throw std::runtime_error("No supported SSX Tricky PS2 courses were found");
    std::sort(result.begin(), result.end(), [](const auto& a, const auto& b) { return a.name < b.name; });
    return result;
}

std::vector<DiscEntry> disc_directory(const DiscInput& disc, const std::string& path) {
    Iso iso(disc);
    std::vector<DiscEntry> result;
    for (const auto& entry : iso.children(iso.find(path)))
        result.push_back({entry.name, entry.size, entry.directory});
    return result;
}

std::vector<std::uint8_t> disc_file(const DiscInput& disc, const std::string& path) {
    Iso iso(disc);
    const auto entry = iso.find(path);
    if (entry.directory)
        throw std::runtime_error("Disc path names a directory");
    return disc.read(entry.offset, static_cast<std::size_t>(entry.size));
}

std::vector<DiscEntry> disc_archive_directory(const DiscInput& disc, const std::string& path) {
    Iso iso(disc);
    std::vector<DiscEntry> result;
    for (const auto& entry : archive_index(disc, iso.find(path)))
        result.push_back({entry.name, entry.size, false});
    return result;
}

std::vector<std::uint8_t> disc_archive_file(const DiscInput& disc, const std::string& path,
                                            const std::string& member_name) {
    Iso iso(disc);
    const auto entries = archive_index(disc, iso.find(path));
    const auto it = std::find_if(entries.begin(), entries.end(),
                                 [&](const auto& entry) { return upper(entry.name) == upper(member_name); });
    if (it == entries.end())
        throw std::runtime_error("Archive member not found: " + member_name);
    return decode_refpack(disc.read(it->offset, static_cast<std::size_t>(it->size)));
}

void extract_course(const DiscInput& disc, const std::string& course, const std::filesystem::path& output,
                    const ImportProgress& progress, const ImportCancel& cancelled) {
    const auto stem = upper(course);
    if (!valid_map_name(stem))
        throw std::runtime_error("Invalid course name");
    if (!std::filesystem::create_directory(output))
        throw std::runtime_error("Import destination already exists");

    struct Cleanup {
        std::filesystem::path path;
        bool complete = false;

        ~Cleanup() {
            if (!complete) {
                std::error_code ec;
                std::filesystem::remove_all(path, ec);
            }
        }
    } cleanup{std::filesystem::absolute(output)};

    const auto notify = [&](const std::string& text) {
        import_detail::check_cancel(cancelled);
        if (progress)
            progress(text);
    };
    notify("Reading " + stem + " archive");
    Iso iso(disc);
    const auto files = archive(disc, iso.find("DATA/MODELS/" + stem + ".BIG"), cancelled);
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
        const auto& geometry = member(files, stem + "_SKY.PBD");
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
                for (const auto [sprite, slot] :
                     {std::pair{"part", "Puff"}, std::pair{"tral", "Wake"}, std::pair{"spry", "Sheet"}})
                    if (bank.contains(sprite))
                        profile[slot] = bank[sprite];
                write_json(output / "RidingEffects.json", profile);
                outputs.push_back("RidingEffects.json");
            }
        }
    }
    write_json(output / "Origin.json", {{"Schema", "openslope-origin/v1"},
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
    cleanup.complete = true;
}
} // namespace openslope
