#include "importer.hpp"
#include "audio.hpp"
#include "import/containers/pak.hpp"
#include "import/strings.hpp"
#include "openslope/appearance.hpp"
#include "openslope/paths.hpp"
#include "openslope/rails.hpp"
#include "openslope/terrain.hpp"
#include "openslope/world.hpp"
#include "props.hpp"
#include <algorithm>
#include <fstream>
#include <iomanip>
#include <nlohmann/json.hpp>
#include <regex>
#include <set>
#include <sstream>

namespace openslope::import_detail {
namespace {
using Json = nlohmann::json;
constexpr auto manifest_path = "DATA/E942715C.DAT";
constexpr auto boot = "SLUS_202.29"; // repo-hygiene: allow[boot-elf] -- disc filename needed for game selection

void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}

void save(const std::filesystem::path& path, const Json& document) {
    std::ofstream file(path, std::ios::binary);
    file << document.dump() << '\n';
    require(bool(file), "Cannot write Mad Trix map document");
}

std::string terminated(Bytes b, std::size_t offset, std::size_t length) {
    auto value = b.text(offset, length);
    const auto end = value.find('\0');
    require(end != std::string::npos, "Unterminated Mad Trix name");
    value.resize(end);
    require(valid_map_name(value), "Unsafe Mad Trix name");
    return value;
}

bool accepts(const DiscInput& disc) {
    if (!iso9660_disc(disc))
        return false;
    Iso iso(disc);
    const auto root = iso.children(iso.find(""));
    // Identity is separate from the ISO/BIN and PAK containers.
    return std::any_of(root.begin(), root.end(), [](const auto& e) { return !e.directory && upper(e.name) == boot; });
}

struct Course {
    std::string name, package;
    Extent extent;
};

std::vector<Course> catalogue(const DiscInput& disc, const ImportCancel& cancel) {
    Iso iso(disc);
    const auto manifest = iso.find(manifest_path);
    require(!manifest.directory && manifest.size > 0 && manifest.size <= 65536 && manifest.size % 80 == 0,
            "Invalid Mad Trix package manifest");
    const auto bytes = disc.read(manifest.offset, std::size_t(manifest.size));
    const Bytes b{bytes};
    const auto entries = iso.children(iso.find("DATA"));
    std::vector<Course> result;
    std::set<std::string> names;
    for (std::size_t p = 0; p < bytes.size(); p += 80) {
        check_cancel(cancel);
        const auto package = terminated(b, p, 64), upper_name = upper(package);
        if (upper_name.size() < 8 || !upper_name.ends_with(".PAK") || upper_name[2] != '_' || upper_name[0] < 'A' ||
            upper_name[0] > 'Z' || upper_name[1] < 'A' || upper_name[1] > 'Z')
            continue;
        const auto hash = b.le(p + 64);
        require(Pak::name_hash(package) == hash, "Mad Trix package identity disagrees with manifest");
        std::ostringstream file;
        // Disc names omit leading zeroes (Machu Picchu's hash has seven digits).
        file << std::uppercase << std::hex << hash << ".DAT";
        const auto found = std::find_if(entries.begin(), entries.end(),
                                        [&](const auto& e) { return !e.directory && upper(e.name) == file.str(); });
        require(found != entries.end(), "Mad Trix course package is missing");
        require(std::uint64_t(b.le(p + 68)) + b.le(p + 72) + b.le(p + 76) + 12 == found->size,
                "Mad Trix course package size disagrees with manifest");
        const auto tail = disc.read(found->offset + found->size - 12, 12);
        const Bytes footer{tail};
        require(footer.le(0) == b.le(p + 72) && footer.le(4) == b.le(p + 76) && footer.le(8) == b.le(p + 68),
                "Mad Trix course package footer disagrees with manifest");
        const auto name = "MADTRIX_" + upper_name.substr(0, upper_name.size() - 4);
        require(names.insert(name).second, "Duplicate Mad Trix course");
        result.push_back({name, package, *found});
    }
    require(!result.empty(), "No Mad Trix course packages were found");
    std::sort(result.begin(), result.end(), [](const auto& a, const auto& b) { return a.name < b.name; });
    return result;
}

std::vector<DiscCourse> courses(const DiscInput& disc, const ImportCancel& cancel) {
    std::vector<DiscCourse> result;
    for (const auto& course : catalogue(disc, cancel))
        result.push_back({course.name, course.extent.size});
    return result;
}

// [Trailmap: 550-textures] These TEX1/PAL1 members carry linear pixels and
// palettes. Their alpha uses the PS2 half range; SSX SSH policies do not apply.
Image texture(const Pak& pak, const std::string& name, const ImportCancel& cancel,
              const std::string& group = "TerrainGroup", bool colour_key = true) {
    const auto data = group.empty() ? pak.equivalent_file("texture_" + name + "_tga.b", cancel)
                                    : pak.file(group + "/" + name + ".ps2_texture", cancel);
    const Bytes b{data};
    require(b.text(0, 4) == "TEX1", "Unsupported Mad Trix texture");
    const auto width = b.le(10, 2), height = b.le(12, 2), depth = b.le(14, 2), at = b.le(16);
    require(width > 0 && height > 0 && width <= 2048 && height <= 2048 && (depth == 4 || depth == 8 || depth == 32) &&
                at >= 32,
            "Unsupported Mad Trix texture dimensions or depth");
    const auto pixels = std::size_t(width) * height;
    b.range(at, (pixels * depth + 7) / 8);
    Image result{name, width, height, std::vector<std::uint8_t>(pixels * 4)};
    std::vector<std::uint8_t> palette;
    unsigned count = 0, palette_at = 0;
    if (depth != 32) {
        palette = group.empty() ? pak.equivalent_file("palette_" + name + "_tga.b", cancel)
                                : pak.file(group + "/" + name + ".ps2_palette", cancel);
        const Bytes p{palette};
        require(p.text(0, 4) == "PAL1" && p.le(12) == 32, "Unsupported Mad Trix palette");
        count = p.le(10, 2);
        palette_at = p.le(16);
        require(count > 0 && count <= (1u << depth) && palette_at >= 24, "Invalid Mad Trix palette count");
        p.range(palette_at, count * 4);
    }
    for (std::size_t i = 0; i < pixels; ++i) {
        std::size_t source = at + i * 4;
        auto rgba = b.data;
        if (depth != 32) {
            auto index = unsigned(data[at + (depth == 4 ? i / 2 : i)]);
            if (depth == 4)
                index = (index >> ((i & 1) * 4)) & 15;
            require(index < count, "Mad Trix pixel references missing palette colour");
            rgba = palette;
            source = palette_at + index * 4;
        }
        std::copy_n(rgba.begin() + std::ptrdiff_t(source), 3, result.rgba.begin() + std::ptrdiff_t(i * 4));
        // [Trailmap: 550-textures] Cutout art uses exact magenta as a colour
        // key even when the stored palette alpha is opaque. Nearby colours,
        // including pink neon, keep their source alpha.
        const auto keyed = colour_key && rgba[source] == 255 && rgba[source + 1] == 0 && rgba[source + 2] == 255;
        result.rgba[i * 4 + 3] = keyed ? 0 : std::uint8_t(std::min(255u, unsigned(rgba[source + 3]) * 2));
    }
    return result;
}

// OpenSlope's material-name surface policy is an approximation, not the
// source game's friction/interaction table.
int surface(std::string name) {
    name = upper(name);
    if (name.find("ICE") != std::string::npos)
        return 5;
    if (name.find("SNOW") != std::string::npos || name.find("SNW") != std::string::npos)
        return 1;
    return 9;
}

Json raw(Vec3 point) { return {point.x * 100, -point.z * 100, point.y * 100}; }

// [Trailmap: 550-terrain, 550-sky, 550-uv] Terrain and the non-colliding
// backdrop share a packed control quilt. The dome's texture-count header word
// is not meaningful; both quilts address the terrain's texture-name table.
struct Quilt {
    Bytes bytes;
    double scale;
    unsigned count, first;

    explicit Quilt(Bytes b) : bytes(b), scale(b.number(0) / 4096.), count(b.le(16)), first(b.le(20)) {
        require(scale > 0 && scale < 1 && count > 1 && count <= 100000 && first == 256 &&
                    b.le(28) == std::uint64_t(first) + std::uint64_t(count) * 256,
                "Unsupported Mad Trix quilt header");
        b.range(first, std::size_t(count) * 256);
    }

    unsigned material(unsigned i) const { return bytes.le(first + i * 256 + 248, 2) >> 5; }

    Patch patch(unsigned i) const {
        const auto at = first + i * 256;
        Patch result;
        // [Trailmap: 550-lighting] V3_16 signed RGB controls; the source VU
        // converts with ITOF4 and GS modulation has neutral RGB 128.
        require(bytes.le(at + 128) == 0x79108033, "Unsupported Mad Trix quilt lighting packet");
        result.light_colors.emplace();
        for (unsigned j = 0; j < 16; ++j) {
            const auto source = (j % 4) * 4 + j / 4;
            std::array<double, 3> point{};
            for (unsigned axis = 0; axis < 3; ++axis) {
                const auto origin = std::bit_cast<std::int32_t>(bytes.le(at + 4 + axis * 4));
                point[axis] = (double(origin) + bytes.le(at + 28 + source * 6 + axis * 2, 2)) * scale;
            }
            result.points[j] = {point[0], point[2], -point[1]};
            for (unsigned c = 0; c < 3; ++c)
                (*result.light_colors)[j][c] = bytes.signed16(at + 132 + source * 6 + c * 2) / 2048.;
        }
        // The four source UV pairs are bilinear coefficients, in mixed,
        // source-U, source-V, constant order. Texture parameters run opposite
        // the packed control order; transpose and reverse their arguments,
        // then expand to the portable corner contract.
        for (unsigned corner = 0; corner < 4; ++corner) {
            const auto u = double(corner & 1), v = double(corner >> 1);
            for (unsigned axis = 0; axis < 2; ++axis) {
                const auto coefficient = [&](unsigned k) {
                    return bytes.signed16(at + 232 + k * 4 + axis * 2) / 4096.;
                };
                result.uv[corner][axis] = coefficient(3) + coefficient(2) * (1 - u) + coefficient(1) * (1 - v) +
                                          coefficient(0) * (1 - u) * (1 - v);
            }
        }
        return result;
    }
};

std::vector<std::string> texture_table(const Pak& pak, Bytes b, const ImportCancel& cancel) {
    const auto table = pak.file("TerrainGroup/table.bin", cancel);
    const Bytes names{table};
    const auto textures = b.le(12);
    require(textures > 0 && textures <= 256, "Invalid Mad Trix terrain texture count");
    names.range(0, std::size_t(textures) * 256);
    std::vector<std::string> texture_names;
    for (unsigned i = 0; i < textures; ++i)
        texture_names.push_back(terminated(names, i * 256, 256));
    return texture_names;
}

std::vector<std::string> patch_document(Bytes geometry, const std::vector<std::string>& texture_names,
                                        const std::filesystem::path& output, const ImportCancel& cancel) {
    const Quilt quilt{geometry};
    std::set<unsigned> used;
    Json rows = Json::array();
    for (unsigned i = 1; i < quilt.count; ++i) {
        check_cancel(cancel);
        const auto material = quilt.material(i);
        require(material < texture_names.size(), "Mad Trix terrain references missing material");
        used.insert(material);
        const auto patch = quilt.patch(i);
        Json points = Json::array();
        for (const auto point : patch.points)
            points.push_back(raw(point));
        rows.push_back({{"PatchName", "Mad Trix terrain " + std::to_string(i)},
                        {"Points", points},
                        {"UVPoints", patch.uv},
                        {"LightColorPoints", *patch.light_colors},
                        {"TexturePath", texture_names[material] + ".png"},
                        {"SurfaceType", surface(texture_names[material])},
                        {"LightmapID", -1},
                        {"LightMapPoint", {0, 0, 0, 0}},
                        {"TrickOnlyPatch", false}});
    }
    save(output / "Patches.json", {{"Patches", rows}});
    std::vector<std::string> result;
    for (const auto id : used)
        result.push_back(texture_names[id]);
    return result;
}

Json rail_document(const Pak& pak, Bytes geometry, const std::vector<std::string>& names,
                   const std::filesystem::path& output, const ImportCancel& cancel) {
    // [Trailmap: 550-grind] The authored PropertyGroup colour, not the visible
    // texture's name, marks grindable texels. Adapt only entirely marked narrow,
    // sky-facing quilt strips. Broad/partly marked surfaces remain deferred.
    std::map<unsigned, Image> masks;
    for (unsigned i = 0; i < names.size(); ++i) {
        check_cancel(cancel);
        if (!pak.contains("PropertyGroup/" + names[i] + ".ps2_texture"))
            continue;
        auto image = texture(pak, names[i], cancel, "PropertyGroup", false);
        for (std::size_t p = 0; p < image.rgba.size(); p += 4)
            if (image.rgba[p] == 0 && image.rgba[p + 1] == 0 && image.rgba[p + 2] == 153) {
                masks.emplace(i, std::move(image));
                break;
            }
    }

    struct Line {
        std::array<Vec3, 4> points;
        unsigned patch;
    };

    std::vector<Line> lines;
    unsigned marked = 0;
    const Quilt quilt{geometry};
    for (unsigned i = 1; i < quilt.count; ++i) {
        check_cancel(cancel);
        const auto mask = masks.find(quilt.material(i));
        if (mask == masks.end())
            continue;
        const auto patch = quilt.patch(i);
        const auto& image = mask->second;
        bool all = true, any = false;
        for (unsigned u = 0; u <= 4; ++u)
            for (unsigned v = 0; v <= 4; ++v) {
                const auto uv = patch.texture_uv(u / 4., v / 4.);
                const auto x = unsigned((uv[0] - std::floor(uv[0])) * image.width),
                           y = unsigned((uv[1] - std::floor(uv[1])) * image.height);
                const auto p = (std::size_t(y) * image.width + x) * 4;
                const auto grind = image.rgba[p] == 0 && image.rgba[p + 1] == 0 && image.rgba[p + 2] == 153;
                all &= grind;
                any |= grind;
            }
        marked += any;
        if (!all || patch.normal(.5, .5).y < .4)
            continue;
        // Bilinear UVs stay inside their corner envelope. Every texel in that
        // envelope must be marked too, so sparse samples cannot jump over a
        // narrow unmarked stripe or mistake repeated UVs for an all-grind tile.
        std::array<double, 2> low{1e9, 1e9}, high{-1e9, -1e9};
        for (unsigned u = 0; u < 2; ++u)
            for (unsigned v = 0; v < 2; ++v) {
                const auto uv = patch.texture_uv(u, v);
                for (unsigned axis = 0; axis < 2; ++axis) {
                    low[axis] = std::min(low[axis], uv[axis]);
                    high[axis] = std::max(high[axis], uv[axis]);
                }
            }
        const auto x0 = int(std::floor(low[0] * image.width)), x1 = int(std::floor(high[0] * image.width)),
                   y0 = int(std::floor(low[1] * image.height)), y1 = int(std::floor(high[1] * image.height));
        if (high[0] - low[0] > 1 || high[1] - low[1] > 1 || std::uint64_t(x1 - x0 + 1) * (y1 - y0 + 1) > 65536)
            continue;
        for (int y = y0; all && y <= y1; ++y)
            for (int x = x0; all && x <= x1; ++x) {
                const auto ix = (x % int(image.width) + int(image.width)) % int(image.width),
                           iy = (y % int(image.height) + int(image.height)) % int(image.height);
                const auto p = (std::size_t(iy) * image.width + ix) * 4;
                all = image.rgba[p] == 0 && image.rgba[p + 1] == 0 && image.rgba[p + 2] == 153;
            }
        if (!all)
            continue;
        const auto du = length(patch.evaluate(1, .5) - patch.evaluate(0, .5)),
                   dv = length(patch.evaluate(.5, 1) - patch.evaluate(.5, 0));
        if (std::max(du, dv) < 1 || std::min(du, dv) > 2.5 || std::max(du, dv) < std::min(du, dv) * 2)
            continue;
        Line line{{}, i};
        constexpr std::array<double, 4> middle{.125, .375, .375, .125};
        for (unsigned a = 0; a < 4; ++a)
            for (unsigned b = 0; b < 4; ++b)
                line.points[a] += patch.points[du >= dv ? a * 4 + b : b * 4 + a] * middle[b];
        lines.push_back(line);
        require(lines.size() <= 10000, "Mad Trix rail strip count exceeds limit");
    }
    using Key = std::array<long long, 3>;
    const auto key = [](Vec3 p) -> Key {
        return {std::llround(p.x * 100), std::llround(p.y * 100), std::llround(p.z * 100)};
    };
    std::map<Key, std::vector<std::pair<unsigned, bool>>> ends;
    for (unsigned i = 0; i < lines.size(); ++i) {
        ends[key(lines[i].points.front())].emplace_back(i, false);
        ends[key(lines[i].points.back())].emplace_back(i, true);
    }
    std::vector<bool> used(lines.size());
    Json rows = Json::array();
    for (unsigned i = 0; i < lines.size(); ++i) {
        if (used[i])
            continue;
        auto current = i;
        bool reverse = ends[key(lines[i].points.front())].size() == 2 && ends[key(lines[i].points.back())].size() != 2;
        Json segments = Json::array();
        for (;;) {
            check_cancel(cancel);
            used[current] = true;
            auto points = lines[current].points;
            if (reverse)
                std::reverse(points.begin(), points.end());
            Json controls = Json::array();
            for (const auto point : points)
                controls.push_back(raw(point));
            segments.push_back({{"Points", controls}, {"SourcePatch", lines[current].patch}});
            const auto& next = ends[key(points.back())];
            if (next.size() != 2)
                break;
            const auto candidate =
                std::find_if(next.begin(), next.end(), [&](const auto& e) { return !used[e.first]; });
            if (candidate == next.end())
                break;
            current = candidate->first;
            reverse = candidate->second;
        }
        rows.push_back({{"SplineName", "Mad Trix Rail " + std::to_string(rows.size())},
                        {"SplineStyle", 13},
                        {"U0", -1},
                        {"U1", 1},
                        {"Segments", segments}});
    }
    save(output / "Splines.json", {{"Splines", rows}});
    const auto rails = Rails::load(output);
    return {{"Fidelity", "Approximate"},    {"Policy", "Property-mask narrow-strip centreline adaptation"},
            {"MarkedPatches", marked},      {"Splines", rails.splines()},
            {"Segments", rails.segments()}, {"PartialMasksDeferred", true}};
}

Json sky_document(const Pak& pak, const std::vector<std::string>& texture_names, const std::filesystem::path& output,
                  const ImportCancel& cancel) {
    constexpr auto member = "TerrainGroup/domepatch.bin";
    if (!pak.contains(member))
        return {{"Available", false}};
    const auto geometry = pak.file(member, cancel);
    const Quilt quilt{Bytes{geometry}};
    require(quilt.count <= 4097, "Mad Trix sky quilt exceeds limit");
    const auto root = output / "Skybox";
    std::filesystem::create_directories(root / "Textures");
    std::filesystem::create_directory(root / "Meshes");

    struct Mesh {
        std::ostringstream text;
        unsigned vertices = 0;
    };

    std::map<unsigned, Mesh> meshes;
    constexpr unsigned subdivisions = 8, stride = subdivisions + 1;
    for (unsigned i = 1; i < quilt.count; ++i) {
        check_cancel(cancel);
        const auto material = quilt.material(i);
        require(material < texture_names.size(), "Mad Trix sky references missing material");
        const auto patch = quilt.patch(i);
        auto& mesh = meshes[material];
        mesh.text << std::setprecision(12);
        for (unsigned u = 0; u <= subdivisions; ++u)
            for (unsigned v = 0; v <= subdivisions; ++v) {
                const auto point = patch.evaluate(u / double(subdivisions), v / double(subdivisions));
                const auto uv = patch.texture_uv(u / double(subdivisions), v / double(subdivisions));
                mesh.text << "v " << point.x * 100 << ' ' << -point.z * 100 << ' ' << point.y * 100 << '\n';
                // OBJ readers invert V; portable terrain corner UVs do not.
                mesh.text << "vt " << uv[0] << ' ' << 1 - uv[1] << '\n';
            }
        const auto face = [&](unsigned a, unsigned b, unsigned c) {
            mesh.text << "f";
            for (const auto index : {a, b, c})
                mesh.text << ' ' << mesh.vertices + index + 1 << '/' << mesh.vertices + index + 1;
            mesh.text << '\n';
        };
        for (unsigned u = 0; u < subdivisions; ++u)
            for (unsigned v = 0; v < subdivisions; ++v) {
                const auto a = u * stride + v, b = a + stride;
                face(a, b, b + 1);
                face(a, b + 1, a + 1);
            }
        mesh.vertices += stride * stride;
    }
    Json materials = Json::array(), mesh_rows = Json::array();
    for (const auto& [material, mesh] : meshes) {
        check_cancel(cancel);
        const auto name = "madtrix-sky-" + std::to_string(material);
        const auto image = texture(pak, texture_names[material], cancel);
        write_png(root / "Textures" / (name + ".png"), image);
        std::ofstream file(root / "Meshes" / (name + ".obj"), std::ios::binary);
        file << mesh.text.str();
        require(bool(file), "Cannot write Mad Trix sky mesh");
        mesh_rows.push_back({{"MeshPath", name + ".obj"}, {"MaterialID", materials.size()}});
        materials.push_back({{"TexturePath", name + ".png"}, {"AlphaMode", "blend"}, {"RepeatTexture", false}});
    }
    save(root / "Materials.json", {{"Materials", materials}});
    save(root / "Models.json",
         {{"Models",
           {{{"ModelName", "Mad Trix sky dome"}, {"ModelObjects", {{{"ParentID", -1}, {"MeshData", mesh_rows}}}}}}}});
    save(root / "Instances.json", {{"Instances", Json::array()}});
    return {{"Available", true},
            {"SourceMember", member},
            {"SkyPatches", quilt.count - 1},
            {"SkyTriangles", (quilt.count - 1) * subdivisions * subdivisions * 2},
            {"Textures", meshes.size()},
            {"LightingPolicy", "unlit source textures; vertex lighting deferred"}};
}

void start_path(const Pak& pak, const Terrain& terrain, const std::filesystem::path& output,
                const ImportCancel& cancel) {
    std::optional<Vec3> anchor;
    // [Trailmap: 550-start] XML attribute order varies; only scalar position
    // fields of authored starts are admitted. No XML entities or scripts run.
    static const std::regex attribute(R"re(([A-Za-z_0-9]+)="([^"]*)")re");
    for (unsigned i = 0; i < 4096; ++i) {
        check_cancel(cancel);
        std::ostringstream name;
        name << "xml_" << std::setfill('0') << std::setw(4) << i << ".xml";
        if (!pak.contains(name.str()))
            continue;
        const auto bytes = pak.file(name.str(), cancel);
        require(bytes.size() <= 1024 * 1024, "Mad Trix XML member exceeds limit");
        const std::string xml(bytes.begin(), bytes.end());
        if (xml.find("ObjClass_SkierStart") == std::string::npos)
            continue;
        std::map<std::string, std::string> attributes;
        for (std::sregex_iterator it(xml.begin(), xml.end(), attribute), end; it != end; ++it)
            require(attributes.emplace((*it)[1].str(), (*it)[2].str()).second, "Duplicate Mad Trix start attribute");
        if (attributes["objClass"] != "ObjClass_SkierStart")
            continue;
        const auto number = [&](const std::string& key) {
            const auto& value = attributes.at(key);
            std::size_t end = 0;
            const auto result = std::stod(value, &end);
            require(end == value.size() && std::isfinite(result) && std::abs(result) < 1e6,
                    "Invalid Mad Trix start coordinate");
            return result;
        };
        const Vec3 source{number("position_v0"), number("position_v2"), -number("position_v1")};
        anchor = source;
        break;
    }
    require(bool(anchor), "No authored Mad Trix start was found");
    const auto snow = [](int material) { return material == 1 || material == 5; };

    struct Candidate {
        Vec3 point, normal;
        double distance;
    };

    std::vector<Candidate> candidates;
    // Source starts can sit inside a scripted helicopter. Preserve a clear
    // snow start when available; otherwise use its position as a nearby anchor.
    if (const auto hit = terrain.intersect(*anchor + Vec3{0, .5, 0}, *anchor - Vec3{0, 12, 0});
        hit && hit->normal.y > .65 && snow(hit->surface))
        candidates.push_back({hit->point, hit->normal, 0});
    for (const auto& patch : terrain.patches()) {
        check_cancel(cancel);
        if (!snow(patch.surface))
            continue;
        const auto box = patch.bounds();
        const Vec3 closest{std::clamp(anchor->x, box.min.x, box.max.x), std::clamp(anchor->y, box.min.y, box.max.y),
                           std::clamp(anchor->z, box.min.z, box.max.z)};
        if (length(closest - *anchor) > 150)
            continue;
        for (const auto u : {.2, .5, .8})
            for (const auto v : {.2, .5, .8}) {
                const auto point = patch.evaluate(u, v), normal = patch.normal(u, v);
                const auto distance = length(point - *anchor);
                if (normal.y > .65 && distance < 150)
                    candidates.push_back({point, normal, distance});
            }
    }
    std::stable_sort(candidates.begin(), candidates.end(),
                     [](const auto& a, const auto& b) { return a.distance < b.distance; });
    const auto headroom = [&](Vec3 point) { return !terrain.intersect(point + Vec3{0, .2, 0}, point + Vec3{0, 3, 0}); };
    const auto runout = [&](Vec3 point, Vec3 heading) {
        auto previous = point;
        const auto side = normalized(cross(heading, Vec3{0, 1, 0}));
        if (!headroom(point))
            return false;
        for (unsigned step = 1; step <= 8; ++step) {
            Vec3 centre;
            for (const auto lane : {0., -1., 1.}) {
                auto ahead = point + heading * (step * 4.) + side * lane;
                ahead.y = previous.y;
                const auto hit = terrain.intersect(ahead + Vec3{0, 1, 0}, ahead - Vec3{0, 12, 0});
                if (!hit || hit->normal.y < .55 || !snow(hit->surface) || !headroom(hit->point))
                    return false;
                if (!lane)
                    centre = hit->point;
            }
            if (terrain.intersect(previous + Vec3{0, 1, 0}, centre + Vec3{0, 1, 0}))
                return false;
            previous = centre;
        }
        return point.y - previous.y > .3;
    };
    std::optional<std::pair<Vec3, Vec3>> start;
    for (const auto& candidate : candidates) {
        check_cancel(cancel);
        const auto downhill = normalized(project(Vec3{0, -1, 0}, candidate.normal), {0, 0, -1});
        const auto horizontal = normalized(project(downhill, {0, 1, 0}), {0, 0, -1});
        for (const auto angle : {0., .52, -.52, 1.05, -1.05, 1.57, -1.57, 3.14}) {
            const auto heading = rotate(horizontal, {0, 1, 0}, angle);
            if (runout(candidate.point, heading)) {
                start = std::pair{candidate.point, heading};
                break;
            }
        }
        if (start)
            break;
    }
    require(bool(start), "No clear supported Mad Trix starting runout was found");
    save(output / "AIP.json", {{"AIPaths",
                                {{{"Name", "OpenSlope Mad Trix start"},
                                  {"PathPos", raw(start->first)},
                                  {"PathPoints", {raw(start->second * 2), raw(start->second * 2)}},
                                  {"U3", 50},
                                  {"Respawnable", false},
                                  {"PathEvents", Json::array()}}}},
                               {"RaceLines", Json::array()},
                               {"StartPosList", {0}}});
}

void extract(const DiscInput& disc, const std::string& course, const std::filesystem::path& output,
             const ImportProgress& progress, const ImportCancel& cancel) {
    const auto notify = [&](const std::string& text) {
        check_cancel(cancel);
        if (progress)
            progress(text);
    };
    const auto entries = catalogue(disc, cancel);
    const auto selected = std::find_if(entries.begin(), entries.end(), [&](const auto& e) { return e.name == course; });
    require(selected != entries.end(), "Unknown Mad Trix course");
    notify("Reading Mad Trix package index");
    const Pak pak(disc, selected->extent, cancel);
    notify("Converting curved Mad Trix terrain");
    const auto geometry = pak.file("TerrainGroup/patch.bin", cancel);
    const auto names = texture_table(pak, Bytes{geometry}, cancel);
    const auto textures = patch_document(Bytes{geometry}, names, output, cancel);
    notify("Decoding Mad Trix terrain textures");
    std::filesystem::create_directory(output / "Textures");
    for (const auto& name : textures) {
        check_cancel(cancel);
        write_png(output / "Textures" / (name + ".png"), texture(pak, name, cancel));
    }
    notify("Converting Mad Trix sky dome");
    const auto sky = sky_document(pak, names, output, cancel);
    notify("Adapting authored Mad Trix grind strips");
    const auto rails = rail_document(pak, Bytes{geometry}, names, output, cancel);
    notify("Converting Mad Trix animated props");
    const auto props = write_madtrix_props(
        pak, course, output, [&](const auto& name) { return texture(pak, name, cancel, ""); }, cancel);
    notify("Converting Mad Trix ski sounds");
    write_madtrix_audio(pak, course, output, cancel);
    notify("Converting Mad Trix music");
    const auto music = write_madtrix_music(disc, output, cancel);
    notify("Validating Mad Trix terrain and authored start");
    const auto terrain = Terrain::load(output);
    start_path(pak, terrain, output, cancel);
    static_cast<void>(CoursePaths::load(output));
    const auto appearance = Appearance::load(terrain);
    require(appearance.missing.empty(), "Mad Trix terrain textures did not load");
    if (sky.at("Available").get<bool>())
        require(!World::load(output).sky.parts.empty(), "Mad Trix sky did not load");
    save(output / "Origin.json", {{"Schema", "openslope-origin/v1"},
                                  {"Origin", "retail"},
                                  {"Game", "jonny-moseley-mad-trix"},
                                  {"Course", course},
                                  {"SourcePackage", selected->package},
                                  {"RetailData", true},
                                  {"Reasons", {"retail-extract"}}});
    Json outputs = {"Patches.json",   "Textures",       "AIP.json", "Origin.json", "Models.json",
                    "Instances.json", "Materials.json", "Audio",    "Splines.json"};
    Json deferred = {"sky-vertex-lighting",
                     "separate-props",
                     "source-collision-flags",
                     "respawn-paths",
                     "partial-grind-masks",
                     "scripts",
                     "events",
                     "ambient-audio",
                     "audio-event-routing"};
    if (!music)
        deferred.push_back("music");
    if (sky.at("Available").get<bool>())
        outputs.push_back("Skybox");
    else
        deferred.push_back("sky");
    if (props.at("Instances").get<unsigned>() > 0) {
        outputs.push_back("Meshes");
        outputs.push_back("Effects.json");
    }
    deferred.push_back("original-sign-animation-timing");
    deferred.push_back("original-waterfall-animation-driver");
    save(output / "Import.json",
         {{"Schema", "openslope-native-import/v1"},
          {"Game", "jonny-moseley-mad-trix"},
          {"Course", course},
          {"TerrainLighting", "source signed bicubic RGB controls; neutral multiplier 1"},
          {"SourcePackage", selected->package},
          {"Complete", false},
          {"TerrainPatches", terrain.patches().size()},
          {"Textures", textures.size()},
          {"Rails", rails},
          {"Signs", props.at("Signs")},
          {"Waterfalls", props.at("Waterfalls")},
          {"Music", {{"Songs", music}, {"OriginalScheduling", "Deferred"}}},
          {"Outputs", outputs},
          {"Environment", sky},
          {"TerrainUVPolicy", "expanded signed bilinear coefficients; transposed with controls"},
          {"CollisionPolicy", "portable curved terrain"},
          {"SurfacePolicy", "OpenSlope material-name approximation"},
          {"SpawnPolicy", "authored start anchor; nearby clear snow runout"},
          {"Deferred", deferred}});
}
} // namespace

const GameImporter madtrix_importer{accepts, courses, extract};
} // namespace openslope::import_detail
