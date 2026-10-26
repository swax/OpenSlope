#include "formats.hpp"
#include "import/containers/disc.hpp"
#include "openslope/appearance.hpp"
#include "openslope/collision.hpp"
#include "openslope/paths.hpp"
#include "openslope/props.hpp"
#include "openslope/scene_lighting.hpp"
#include "openslope/terrain.hpp"
#include "openslope/world.hpp"
#include <algorithm>
#include <array>
#include <cctype>
#include <deque>
#include <fstream>
#include <iomanip>
#include <nlohmann/json.hpp>
#include <set>
#include <sstream>

namespace openslope::import_detail {
namespace {
using Json = nlohmann::json;

struct Course {
    std::string_view stem, variant;
};

constexpr std::array catalogue{
    Course{"Crs00_00", "Normal"},  Course{"Crs00_03", "Diamond"}, Course{"Crs01_00", "Normal"},
    Course{"Crs01_01", "Hard"},    Course{"Crs01_02", "Expert"},  Course{"Crs01_03", "Diamond"},
    Course{"Crs02_00", "Normal"},  Course{"Crs02_01", "Hard"},    Course{"Crs02_02", "Expert"},
    Course{"Crs02_03", "Diamond"}, Course{"Crs03_00", "Normal"},  Course{"Crs03_01", "Hard"},
    Course{"Crs03_02", "Expert"},  Course{"Crs03_03", "Diamond"}, Course{"Crs04_00", "Normal"},
    Course{"Crs04_01", "Hard"},    Course{"Crs04_02", "Expert"},  Course{"Crs04_03", "Diamond"},
    Course{"Crs05_00", "Normal"},  Course{"Crs05_01", "Hard"},    Course{"Crs05_02", "Expert"},
    Course{"Crs05_03", "Diamond"}, Course{"Crs06_00", "Normal"},  Course{"Crs06_02", "Expert"},
    Course{"Crs06_03", "Diamond"},
};

std::string member_stem(const Course& course) {
    std::string result(course.stem);
    for (auto& c : result)
        c = char(std::toupper(static_cast<unsigned char>(c)));
    return result;
}

std::string slot(const Course& course) { return "AVALANCHE_" + member_stem(course); }

std::string world_directory(const Course& course) {
    return "1080Data/LevelData_LVL/Course/" + std::string(course.stem.substr(0, 5)) + "/" +
           std::string(course.variant) + "/World/1P";
}

std::string package_name(const Course& course) { return std::string(course.stem) + "_1P.LVL"; }

void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}

double number(Bytes b, std::size_t offset) {
    const auto value = std::bit_cast<float>(b.be(offset));
    require(std::isfinite(value) && std::abs(value) < 1e9, "Invalid Avalanche coordinate");
    return value;
}

Vec3 vector(Bytes b, std::size_t p) { return {number(b, p), number(b, p + 4), number(b, p + 8)}; }

// Avalanche's authored world has the opposite handedness to OpenSlope.
// Reflect X as well as seating Y-up centimetres in the portable Z-up frame.
// Mesh winding and the terrain tensor must follow this same conversion.
Json raw(Vec3 v) { return {-v.x, -v.z, v.y}; }

void obj_point(std::ostream& out, Vec3 v) {
    out << "v " << (v.x == 0 ? 0 : -v.x) << ' ' << (v.z == 0 ? 0 : -v.z) << ' ' << v.y << '\n';
}

void save(const std::filesystem::path& path, const Json& value) {
    std::ofstream out(path);
    out << value.dump() << '\n';
    require(bool(out), "Cannot write Avalanche map document");
}

using Members = std::map<std::string, std::vector<std::uint8_t>>;

Members level(const DiscInput& disc, const std::string& path, const ImportCancel& cancel) {
    const auto bytes = gamecube_file(disc, path);
    Bytes b{bytes};
    const auto count = b.be(0);
    require(count > 0 && count <= 4096, "Invalid Avalanche LVL member count");
    b.range(4, std::size_t(count + 1) * 4);
    require(b.be(4) >= 4 + (count + 1) * 4 && b.be(4 + count * 4) == bytes.size(), "Invalid Avalanche LVL bounds");
    const auto directory = b.be(count * 4), directory_end = b.be((count + 1) * 4);
    require(directory <= directory_end && directory_end <= bytes.size(), "Invalid Avalanche LVL directory");
    Bytes table{std::span(bytes).subspan(directory, directory_end - directory)};
    table.range(0, std::size_t(count + 1) * 36);
    require(table.text(0, 13) == "CONTENTS_FLAG" && table.be(32) == 2 && table.be(68) == 32,
            "Unsupported Avalanche LVL manifest");
    Members result;
    for (unsigned i = 0; i + 1 < count; ++i) {
        check_cancel(cancel);
        const auto start = b.be(4 + i * 4), end = b.be(8 + i * 4), size = table.be((i + 2) * 36 + 32);
        require(start % 32 == 0 && start <= end && end <= directory &&
                    (std::uint64_t(size) + 31) / 32 * 32 == end - start,
                "Invalid Avalanche LVL member extent");
        auto name = table.text((i + 2) * 36, 32);
        name.resize(name.find('\0') == std::string::npos ? name.size() : name.find('\0'));
        while (!name.empty() && name.back() == ' ')
            name.pop_back();
        require(valid_map_name(name), "Unsafe Avalanche LVL member name");
        b.range(start, size);
        require(
            result.emplace(name, std::vector<std::uint8_t>(bytes.begin() + start, bytes.begin() + start + size)).second,
            "Duplicate Avalanche LVL member");
    }
    return result;
}

// The view borrows the package bytes, independently of the lookup name's lifetime.
std::span<const std::uint8_t> member(const Members& files, const std::string& name) {
    const auto found = files.find(name);
    if (found == files.end())
        throw std::runtime_error("Missing Avalanche member: " + name);
    return found->second;
}

std::array<std::uint8_t, 4> rgb565(unsigned value) {
    const auto r = (value >> 11) & 31, g = (value >> 5) & 63, b = value & 31;
    return {std::uint8_t((r << 3) | (r >> 2)), std::uint8_t((g << 2) | (g >> 4)), std::uint8_t((b << 3) | (b >> 2)),
            255};
}

Image texture(Bytes b, unsigned index, const std::string& prefix) {
    constexpr std::uint32_t tpl_magic = 0x0020af30;
    require(b.be(0) == tpl_magic && b.be(4) <= 4096 && index < b.be(4), "Invalid Avalanche TPL image table");
    const auto descriptor = b.be(b.be(8) + index * 8);
    b.range(descriptor, 36);
    const auto height = b.be(descriptor, 2), width = b.be(descriptor + 2, 2), format = b.be(descriptor + 4);
    require(width && height && width <= 4096 && height <= 4096 && std::uint64_t(width) * height <= 16777216,
            "Oversized Avalanche texture");
    const bool cmpr = format == 14;
    require(format <= 6 || cmpr, "Unsupported Avalanche TPL texture format");
    const unsigned bw = format <= 2 || cmpr ? 8 : 4, bh = format == 0 || cmpr ? 8 : 4;
    const unsigned block_size = format == 6 ? 64 : 32;
    auto at = std::size_t(b.be(descriptor + 8));
    b.range(at, std::size_t((width + bw - 1) / bw) * ((height + bh - 1) / bh) * block_size);
    Image image{prefix + std::to_string(index), width, height,
                std::vector<std::uint8_t>(std::size_t(width) * height * 4)};
    for (unsigned yb = 0; yb < height; yb += bh)
        for (unsigned xb = 0; xb < width; xb += bw, at += block_size)
            for (unsigned y = 0; y < bh; ++y)
                for (unsigned x = 0; x < bw; ++x) {
                    const auto p = y * bw + x;
                    std::array<std::uint8_t, 4> rgba{};
                    if (cmpr) {
                        const auto sub = at + ((y / 4) * 2 + x / 4) * 8;
                        const auto a = b.be(sub, 2), c = b.be(sub + 2, 2),
                                   choice = (b.be(sub + 4 + y % 4, 1) >> (6 - (x % 4) * 2)) & 3;
                        const auto first = rgb565(a), second = rgb565(c);
                        if (choice < 2)
                            rgba = choice ? second : first;
                        else if (a > c) {
                            for (unsigned channel = 0; channel < 3; ++channel)
                                rgba[channel] = std::uint8_t(
                                    ((choice == 2 ? 2 : 1) * first[channel] + (choice == 2 ? 1 : 2) * second[channel]) /
                                    3);
                            rgba[3] = 255;
                        } else if (choice == 2) {
                            for (unsigned channel = 0; channel < 3; ++channel)
                                rgba[channel] = std::uint8_t((unsigned(first[channel]) + second[channel]) / 2);
                            rgba[3] = 255;
                        }
                    } else if (format == 0 || format == 1 || format == 2) {
                        const auto value = b.be(at + (format == 0 ? p / 2 : p), 1);
                        const auto intensity = format == 0   ? ((value >> (p % 2 ? 0 : 4)) & 15) * 17
                                               : format == 1 ? value
                                                             : (value & 15) * 17;
                        rgba = {std::uint8_t(intensity), std::uint8_t(intensity), std::uint8_t(intensity),
                                std::uint8_t(format == 2 ? (value >> 4) * 17 : 255)};
                    } else if (format == 6) {
                        rgba = {std::uint8_t(b.be(at + p * 2 + 1, 1)), std::uint8_t(b.be(at + 32 + p * 2, 1)),
                                std::uint8_t(b.be(at + 33 + p * 2, 1)), std::uint8_t(b.be(at + p * 2, 1))};
                    } else {
                        const auto value = b.be(at + p * 2, 2);
                        if (format == 3)
                            rgba = {std::uint8_t(value), std::uint8_t(value), std::uint8_t(value),
                                    std::uint8_t(value >> 8)};
                        else if (format == 4)
                            rgba = rgb565(value);
                        else if (value & 0x8000) {
                            const auto r = (value >> 10) & 31, g = (value >> 5) & 31, blue = value & 31;
                            rgba = {std::uint8_t((r << 3) | (r >> 2)), std::uint8_t((g << 3) | (g >> 2)),
                                    std::uint8_t((blue << 3) | (blue >> 2)), 255};
                        } else
                            rgba = {std::uint8_t(((value >> 8) & 15) * 17), std::uint8_t(((value >> 4) & 15) * 17),
                                    std::uint8_t((value & 15) * 17), std::uint8_t(((value >> 12) & 7) * 255 / 7)};
                    }
                    if (xb + x < width && yb + y < height)
                        std::copy(rgba.begin(), rgba.end(),
                                  image.rgba.begin() + std::ptrdiff_t(((yb + y) * width + xb + x) * 4));
                }
    return image;
}

struct Geometry {
    Bytes b;
    unsigned positions{}, position_count{};
    bool float_positions{};

    explicit Geometry(Bytes bytes) : b(bytes), positions(b.be(0x30)), position_count(b.be(0x90)) {
        require(b.be(4) == 0x2011 && b.be(0x18) == b.data.size(), "Unsupported Avalanche GEO header");
        require(position_count && position_count <= 1000000, "Invalid Avalanche GEO position count");
        const auto encoding = b.be(0) & 65535;
        require(encoding == 2 || encoding == 3, "Unsupported Avalanche position encoding");
        float_positions = encoding == 3;
        b.range(positions, std::size_t(position_count) * (float_positions ? 12 : 6));
        b.range(0xe4, 48);
    }

    Vec3 position(unsigned index, bool local = false) const {
        require(index < position_count, "Avalanche control index out of range");
        const auto at = positions + std::size_t(index) * (float_positions ? 12 : 6);
        const auto v = float_positions ? vector(b, at)
                                       : Vec3{double(static_cast<std::int16_t>(b.be(at, 2))),
                                              double(static_cast<std::int16_t>(b.be(at + 2, 2))),
                                              double(static_cast<std::int16_t>(b.be(at + 4, 2)))};
        return local ? v : transform(v, 0xe4);
    }

    Vec3 transform(Vec3 v, std::size_t matrix) const {
        return {number(b, matrix) * v.x + number(b, matrix + 4) * v.y + number(b, matrix + 8) * v.z +
                    number(b, matrix + 12),
                number(b, matrix + 16) * v.x + number(b, matrix + 20) * v.y + number(b, matrix + 24) * v.z +
                    number(b, matrix + 28),
                number(b, matrix + 32) * v.x + number(b, matrix + 36) * v.y + number(b, matrix + 40) * v.z +
                    number(b, matrix + 44)};
    }
};

struct UVTransform {
    std::array<double, 6> matrix{1, 0, 0, 0, 1, 0};
    bool applied{}, animated{}, deferred{};

    std::array<double, 2> map(double u, double v) const {
        return {matrix[0] * u + matrix[1] * v + matrix[2], matrix[3] * u + matrix[4] * v + matrix[5]};
    }
};

struct Material {
    unsigned image{};
    int surface = 1;
    std::string name;
    std::string alpha = "cutout";
    unsigned uv_set{};
    bool repeat_texture{};
    std::array<UVTransform, 8> uv_transforms{};
};

struct CollisionReport {
    std::size_t triangles{}, trunk_proxies{}, deferred_primitives{}, snow_triangles{};
};

CollisionReport collision(Bytes b, const std::filesystem::path& output, const ImportCancel& cancel) {
    b.range(0, 56);
    const auto faces = b.be(32), vertices = b.be(36), nf = b.be(40), nv = b.be(44);
    require(nf <= 1000000 && nv <= 1000000 && faces <= vertices &&
                std::uint64_t(faces) + std::uint64_t(nf) * 32 == vertices,
            "Invalid Avalanche collision mesh header");
    b.range(vertices, std::size_t(nv) * 12);
    b.range(faces, std::size_t(nf) * 32);
    std::filesystem::create_directory(output / "Collision");
    std::ofstream obj(output / "Collision/avalanche-world.obj");
    unsigned snow_count = 0;
    for (unsigned i = 0; i < nf; ++i)
        snow_count += b.be(faces + i * 32 + 13, 1) == 'a';
    std::ofstream snow;
    if (snow_count)
        snow.open(output / "Collision/avalanche-snow.obj");
    obj << std::setprecision(10);
    snow << std::setprecision(10);
    for (unsigned i = 0; i < nv; ++i) {
        check_cancel(cancel);
        const auto v = vector(b, vertices + std::size_t(i) * 12);
        obj_point(obj, v);
        if (snow_count)
            obj_point(snow, v);
    }
    for (unsigned i = 0; i < nf; ++i) {
        const auto p = faces + i * 32;
        const auto a = b.be(p), c = b.be(p + 4), d = b.be(p + 8);
        require(a < nv && c < nv && d < nv, "Avalanche collision triangle index out of bounds");
        // Literal 'a' collision tags agree with CF_a snow materials. OpenSlope
        // admits their upward faces as board support; walls remain solid.
        auto& target = b.be(p + 13, 1) == 'a' ? snow : obj;
        target << "f " << a + 1 << ' ' << d + 1 << ' ' << c + 1 << '\n';
    }
    CollisionReport report{nf, 0, 0, snow_count};
    const auto primitives = b.be(0x50), primitive_count = b.be(0x54);
    require(primitive_count <= 100000, "Avalanche primitive count exceeds limit");
    b.range(primitives, std::size_t(primitive_count) * 48);
    unsigned next_vertex = nv;
    for (unsigned i = 0; i < primitive_count; ++i) {
        check_cancel(cancel);
        const auto at = primitives + i * 48, kind = b.be(at) >> 28;
        if (kind != 0) {
            ++report.deferred_primitives;
            continue;
        }
        // OpenSlope policy: bounded twelve-sided solid trunk proxies.
        // This approximates the endpoint/radius records, not retail contact response.
        const auto a = vector(b, at + 8), z = vector(b, at + 20);
        const auto radius = number(b, at + 32);
        require(radius > 0 && radius < 10000 && length(z - a) > .01, "Invalid Avalanche trunk primitive");
        const auto axis = normalized(z - a),
                   side = normalized(cross(axis, std::abs(axis.y) < .9 ? Vec3{0, 1, 0} : Vec3{1, 0, 0})),
                   other = cross(axis, side);
        for (const auto centre : {a, z})
            for (unsigned k = 0; k < 12; ++k) {
                const auto theta = 2 * pi * k / 12;
                const auto point = centre + (side * std::cos(theta) + other * std::sin(theta)) * radius;
                obj_point(obj, point);
            }
        for (unsigned k = 0; k < 12; ++k) {
            const auto p = next_vertex + k + 1, q = next_vertex + (k + 1) % 12 + 1;
            obj << "f " << p << ' ' << q + 12 << ' ' << q << '\n';
            obj << "f " << p << ' ' << p + 12 << ' ' << q + 12 << '\n';
            report.triangles += 2;
        }
        for (unsigned k = 1; k + 1 < 12; ++k) {
            obj << "f " << next_vertex + 1 << ' ' << next_vertex + k + 1 << ' ' << next_vertex + k + 2 << '\n';
            obj << "f " << next_vertex + 13 << ' ' << next_vertex + k + 14 << ' ' << next_vertex + k + 13 << '\n';
            report.triangles += 2;
        }
        next_vertex += 24;
        ++report.trunk_proxies;
    }
    require(bool(obj), "Cannot write Avalanche collision mesh");
    save(output / "Models.json", {{"Models",
                                   {{{"ModelName", "Avalanche collision"},
                                     {"AnimTime", 0},
                                     {"ModelObjects", {{{"ParentID", -1}, {"MeshData", Json::array()}}}}}}}});
    save(output / "Materials.json", {{"Materials", Json::array()}});
    save(output / "Instances.json", {{"Instances",
                                      {{{"InstanceName", "Avalanche world collision"},
                                        {"ModelID", 0},
                                        {"Location", {0, 0, 0}},
                                        {"Rotation", {0, 0, 0, 1}},
                                        {"Scale", {1, 1, 1}},
                                        {"Visable", false},
                                        {"PlayerCollision", true},
                                        {"CollsionMode", 1},
                                        {"CollsionModelPaths", {"avalanche-world.obj"}},
                                        {"SurfaceType", -1},
                                        {"U0", 1},
                                        {"PlayerBounce", true},
                                        {"PlayerBounceAmmount", 0}}}}});
    if (snow_count) {
        require(bool(snow), "Cannot write Avalanche snow collision mesh");
        snow.close();
        std::ifstream input(output / "Instances.json");
        auto document = Json::parse(input);
        input.close();
        auto row = document["Instances"][0];
        row["InstanceName"] = "Avalanche rideable snow polygons";
        row["CollsionModelPaths"] = {"avalanche-snow.obj"};
        row["SurfaceType"] = 1;
        document["Instances"].push_back(row);
        save(output / "Instances.json", document);
    }
    return report;
}

UVTransform material_uv(Bytes b, std::size_t stage, unsigned uv_set) {
    UVTransform result;
    const auto packed = b.be(stage), selector = (packed >> 9) & 63;
    const auto matrix = static_cast<std::int16_t>(b.be(stage + 8, 2));
    if (selector == 60 || matrix < 0)
        return result;
    // Position/normal projections and custom matrices need the source camera.
    // This portable slice only freezes a texture-coordinate SRT at its first key.
    if ((packed & 15) != 1 || ((packed >> 4) & 31) != 4 + uv_set) {
        result.deferred = true;
        return result;
    }
    const auto count = b.be(0x54), base = b.be(0x1c);
    require(count <= 32768 && unsigned(matrix) < count, "Avalanche texture matrix index out of bounds");
    b.range(base, std::size_t(count) * 56);
    const auto row = base + unsigned(matrix) * 56;
    if (static_cast<std::int16_t>(b.be(row + 50, 2)) >= 0 || static_cast<std::int16_t>(b.be(row + 52, 2)) >= 0) {
        result.deferred = true;
        return result;
    }
    const auto animation = static_cast<std::int16_t>(b.be(row + 54, 2));
    if (animation < 0)
        return result;
    const auto animations = b.be(0x48), animation_base = b.be(0x10);
    require(animations <= 32768 && unsigned(animation) < animations, "Avalanche UV animation index out of bounds");
    b.range(animation_base, std::size_t(animations) * 244);
    const auto track = animation_base + unsigned(animation) * 244;
    const auto flags = b.be(track + 50, 1), keys = b.be(track + 51, 1);
    require(keys && keys <= 48 && !(flags & ~0xc0u) && b.be(track + 52, 2) == 0, "Invalid Avalanche UV animation keys");
    const auto transforms = b.be(0x40), transform_base = b.be(8);
    require(transforms && transforms <= 32768, "Invalid Avalanche UV transform count");
    b.range(transform_base, std::size_t(transforms) * 20);
    for (unsigned i = 0; i < keys; ++i) {
        require(b.be(track + 54 + i * 4, 2) < transforms, "Avalanche UV transform index out of bounds");
        if (i)
            require(b.be(track + 52 + i * 4, 2) > b.be(track + 48 + i * 4, 2), "Unordered Avalanche UV animation keys");
    }
    const auto srt = transform_base + b.be(track + 54, 2) * 20;
    const auto sx = number(b, srt) * (flags & 0x40 ? 2 : 1), sy = number(b, srt + 4) * (flags & 0x80 ? 2 : 1),
               tx = number(b, srt + 8), ty = number(b, srt + 12), angle = number(b, srt + 16);
    const auto cosine = std::cos(angle), sine = std::sin(angle);
    // Independent affine form of the source SRT: subtract centre/translation,
    // rotate, scale, restore centre, then invert T for the GX image convention.
    result.matrix = {sx * cosine, -sx * sine, 0, -sy * sine, -sy * cosine, 0};
    auto& m = result.matrix;
    m[2] = (flags & 0x40 ? 1. : .5) - m[0] * (.5 + tx) - m[1] * (.5 + ty);
    m[5] = (flags & 0x80 ? 0. : .5) - m[3] * (.5 + tx) - m[4] * (.5 + ty);
    result.applied = true;
    result.animated = keys > 1;
    return result;
}

std::vector<Material> materials(Bytes b, unsigned texture_count, std::set<unsigned>& used) {
    const auto count = b.be(0x38), at = b.be(0);
    require(count && count <= 4096 && b.be(0x3c) == texture_count, "Invalid Avalanche material counts");
    b.range(at, std::size_t(count) * 164);
    std::vector<Material> result;
    for (unsigned i = 0; i < count; ++i) {
        const auto image = b.be(at + i * 164 + 148, 2);
        require(image < texture_count || image == 65535, "Avalanche material texture index out of bounds");
        result.push_back({image, 1, "material-" + std::to_string(i)});
        const auto stages = b.be(at + i * 164 + 1, 1);
        require(stages <= 8, "Invalid Avalanche texture generator count");
        for (unsigned stage = 0; stage < stages; ++stage)
            result.back().uv_transforms[stage] = material_uv(b, at + i * 164 + 20 + stage * 16, stage);
        if (image != 65535)
            used.insert(image);
    }
    return result;
}

std::size_t scenery(const Geometry& g, const std::vector<Material>& mats, const std::filesystem::path& output,
                    const ImportCancel& cancel, bool backdrop = false) {
    const auto count = g.b.be(0x80), base = g.b.be(0x20), uv = g.b.be(0x3c), nuv = g.b.be(0x9c);
    require(count <= 4096 && nuv <= 1000000, "Avalanche scenery counts exceed limits");
    g.b.range(base, std::size_t(count) * 40);
    g.b.range(uv, std::size_t(nuv) * 4);

    struct Part {
        std::ostringstream text;
        unsigned vertices{};
    };

    struct Asset {
        unsigned object{};
        std::string name;
        std::map<unsigned, Part> parts;
        std::size_t triangles{};
    };

    struct Placement {
        unsigned asset{}, object{};
        std::optional<unsigned> node;
        Vec3 origin;
    };

    std::deque<Asset> assets;
    std::vector<Placement> placements;
    std::map<std::vector<unsigned>, unsigned> shared;
    std::vector<std::string> object_names(count);
    const auto names = std::size_t(g.b.be(0x28)) + std::size_t(g.b.be(0x88)) * 144 + 20 + mats.size() * 24;
    if (!backdrop && names + 20 <= g.b.data.size() && g.b.text(names, 13) == "ObjNameListV2") {
        require(g.b.be(names + 16) == count, "Invalid Avalanche object name count");
        g.b.range(names + 20, std::size_t(count) * 24);
        for (unsigned i = 0; i < count; ++i) {
            auto name = g.b.text(names + 20 + i * 24, 20);
            name.resize(name.find('\0') == std::string::npos ? name.size() : name.find('\0'));
            object_names[i] = std::move(name);
        }
    }
    std::map<unsigned, unsigned> colour_materials;
    std::vector<unsigned> colour_textures;
    const auto colours = g.b.be(0x38), colour_count = g.b.be(0x98);
    require(colour_count <= 65535, "Avalanche colour count exceeds limit");
    g.b.range(colours, std::size_t(colour_count) * 4);
    std::vector<Image> gradients;
    std::map<unsigned, RgbaImage> sky_images;
    unsigned gradient_tiles = 0;
    std::size_t triangles = 0;
    const auto emit = [&](unsigned object, std::optional<std::size_t> matrix, std::optional<unsigned> node = {}) {
        check_cancel(cancel);
        require(object < count, "Avalanche scenery instance index out of range");
        const auto row = base + object * 40, flags = g.b.be(row + 36), descriptors = g.b.be(row + 28);
        const auto n = flags >> 16, position_base = g.b.be(row + 26, 2);
        require(n <= 256, "Avalanche scenery material count exceeds limit");
        g.b.range(descriptors, std::size_t(n) * 12);
        Vec3 origin{};
        std::vector<unsigned> key{object};
        if (matrix) {
            origin = {number(g.b, *matrix + 12), number(g.b, *matrix + 28), number(g.b, *matrix + 44)};
            // Bake the exact linear basis, including source shear/reflections.
            // Translation remains an ordinary editable portable placement. Equal
            // template/basis pairs share geometry without a lossy TRS decomposition.
            for (unsigned r = 0; r < 3; ++r)
                for (unsigned c = 0; c < 3; ++c)
                    key.push_back(g.b.be(*matrix + r * 16 + c * 4));
        } else if (!backdrop)
            origin = (vector(g.b, row) + vector(g.b, row + 12)) * .5;
        if (backdrop) {
            key = {0};
            origin = {};
        }
        auto [found, added] = shared.emplace(key, unsigned(assets.size()));
        const auto asset = found->second;
        placements.push_back({asset, object, node, origin});
        if (!added && !backdrop) {
            triangles += assets[asset].triangles;
            require(triangles <= 1000000, "Avalanche scenery triangle count exceeds limit");
            return;
        }
        if (added)
            assets.push_back({object,
                              backdrop                       ? "Avalanche background"
                              : object_names[object].empty() ? "Avalanche object " + std::to_string(object)
                                                             : object_names[object],
                              {},
                              0});
        auto& asset_row = assets[asset];
        struct Corner {
            Vec3 position;
            double u{}, v{};
            unsigned colour{};
        };
        for (unsigned group = 0; group < n; ++group) {
            const auto d = descriptors + group * 12, material = g.b.be(d, 2), blocks = g.b.be(d + 2, 2),
                       format = g.b.be(d + 4);
            const bool textured = (format & 0x20) != 0;
            require(material < mats.size() || (material == 65535 && !textured),
                    "Avalanche scenery material out of range");
            require(format == 0x9 || format == 0x29 || format == 0x69 || format == 0xe9 || format == 0x1e9 ||
                        format == 0x3e9 || format == 0x2b || format == 0x6b || format == 0xb || format == 0xeb,
                    "Unsupported Avalanche scenery vertex layout");
            auto cursor = std::size_t(g.b.be(d + 8));
            const auto end = cursor + std::size_t(blocks) * 32;
            g.b.range(cursor, end - cursor);
            const auto normal_bytes = (format & 2) ? 2u : 0u;
            const auto stride = 4u + normal_bytes + (textured ? 2u : 0u) + 2u * unsigned(std::popcount(format >> 6));
            const auto triangle = [&](const Corner& a, const Corner& b, const Corner& c) {
                if (length(cross(b.position - a.position, c.position - a.position)) < 1e-8)
                    return;
                require(++triangles <= 1000000, "Avalanche scenery triangle count exceeds limit");
                ++asset_row.triangles;
                auto target_material = material;
                std::array<std::array<double, 2>, 3> triangle_uv{{{a.u, a.v}, {b.u, b.v}, {c.u, c.v}}};
                bool modulated = false;
                if (backdrop && textured) {
                    require(a.colour < colour_count && b.colour < colour_count && c.colour < colour_count,
                            "Avalanche sky colour index out of range");
                    for (const auto colour : {a.colour, b.colour, c.colour})
                        modulated |= g.b.be(colours + colour * 4) != 0xffffffff;
                }
                if (!textured || modulated) {
                    require(a.colour < colour_count && b.colour < colour_count && c.colour < colour_count,
                            "Avalanche scenery colour index out of range");
                    if (modulated || a.colour != b.colour || a.colour != c.colour) {
                        // Bake sky vertex tint/coverage into portable textures. This preserves
                        // gradient domes and fading cloud edges without a new mesh contract.
                        constexpr unsigned tile_size = 32, tiles_per_row = 16, tiles_per_page = 256;
                        require(gradient_tiles < 64 * tiles_per_page, "Avalanche colour atlas budget exceeded");
                        const auto page = gradient_tiles / tiles_per_page, tile = gradient_tiles++ % tiles_per_page;
                        if (page == gradients.size())
                            gradients.push_back({"ava-gradient-" + std::to_string(page), 512, 512,
                                                 std::vector<std::uint8_t>(512 * 512 * 4)});
                        const auto x = (tile % tiles_per_row) * tile_size, y = (tile / tiles_per_row) * tile_size;
                        const RgbaImage* source = nullptr;
                        if (modulated) {
                            const auto image = mats[material].image;
                            require(image != 65535, "Tinted Avalanche sky requires a primary image");
                            if (!sky_images.contains(image))
                                sky_images.emplace(
                                    image, read_png(output / "Textures" / ("ava-" + std::to_string(image) + ".png")));
                            source = &sky_images.at(image);
                        }
                        for (unsigned v = 0; v < tile_size; ++v)
                            for (unsigned u = 0; u < tile_size; ++u) {
                                const auto bu = double(u) / (tile_size - 1), bv = double(v) / (tile_size - 1);
                                std::size_t texel = 0;
                                if (source) {
                                    const auto wrap = [](double uv, unsigned extent) {
                                        return std::min(extent - 1, unsigned((uv - std::floor(uv)) * extent));
                                    };
                                    const auto tx = wrap(a.u + (b.u - a.u) * bu + (c.u - a.u) * bv, source->width);
                                    const auto ty = wrap(a.v + (b.v - a.v) * bu + (c.v - a.v) * bv, source->height);
                                    texel = (ty * source->width + tx) * 4;
                                }
                                for (unsigned channel = 0; channel < 4; ++channel) {
                                    const auto ca = g.b.be(colours + a.colour * 4 + channel, 1),
                                               cb = g.b.be(colours + b.colour * 4 + channel, 1),
                                               cc = g.b.be(colours + c.colour * 4 + channel, 1);
                                    auto value = std::clamp(
                                        double(ca) + (double(cb) - ca) * bu + (double(cc) - ca) * bv, 0., 255.);
                                    if (source)
                                        value *= source->pixels[texel + channel] / 255.;
                                    gradients[page].rgba[((y + v) * 512 + x + u) * 4 + channel] =
                                        std::uint8_t(std::clamp(std::round(value), 0., 255.));
                                }
                            }
                        triangle_uv = {{{(x + .5) / 512, (y + .5) / 512},
                                        {(x + tile_size - .5) / 512, (y + .5) / 512},
                                        {(x + .5) / 512, (y + tile_size - .5) / 512}}};
                        // Reserved IDs stay outside source materials and the bounded colour palette.
                        target_material = 65536 + page;
                    } else {
                        auto [found, added] =
                            colour_materials.emplace(a.colour, unsigned(mats.size() + colour_textures.size()));
                        if (added)
                            colour_textures.push_back(a.colour);
                        target_material = found->second;
                    }
                }
                auto& part = asset_row.parts[target_material];
                part.text << std::setprecision(10);
                unsigned corner_index = 0;
                for (const auto& vertex : {a, b, c}) {
                    const auto& p = vertex.position;
                    obj_point(part.text, p - origin);
                    const auto uv = triangle_uv[corner_index++];
                    part.text << "vt " << uv[0] << ' ' << 1 - uv[1] << '\n';
                }
                part.text << "f";
                for (const auto k : {1u, 3u, 2u})
                    part.text << ' ' << part.vertices + k << '/' << part.vertices + k;
                part.text << '\n';
                part.vertices += 3;
            };
            while (cursor < end) {
                const auto command = g.b.be(cursor, 1);
                if (!command) {
                    require(std::all_of(g.b.data.begin() + std::ptrdiff_t(cursor),
                                        g.b.data.begin() + std::ptrdiff_t(end), [](auto value) { return value == 0; }),
                            "Invalid Avalanche display-list padding");
                    break;
                }
                require(end - cursor >= 3, "Truncated Avalanche draw command");
                const auto primitive = command & 0xf8, vertices = g.b.be(cursor + 1, 2);
                cursor += 3;
                require(vertices >= 3 && std::uint64_t(vertices) * stride <= end - cursor,
                        "Truncated Avalanche draw vertices");
                std::vector<Corner> corners;
                corners.reserve(vertices);
                for (unsigned k = 0; k < vertices; ++k) {
                    const auto at = cursor + k * stride;
                    const auto position_index = g.b.be(at, 2) + position_base;
                    auto point = g.position(position_index, (flags & 255) == 1);
                    if (matrix)
                        point = g.transform(point, *matrix);
                    Corner corner{point, .5, .5, g.b.be(at + 2 + normal_bytes, 2)};
                    if (textured) {
                        require(mats[material].uv_set <= unsigned(std::popcount(format >> 6)),
                                "Avalanche material UV stream is absent");
                        const auto ti = g.b.be(at + 4 + normal_bytes + mats[material].uv_set * 2, 2);
                        require(ti < nuv, "Avalanche scenery UV index out of range");
                        corner.u = double(static_cast<std::int16_t>(g.b.be(uv + ti * 4, 2))) / 1024;
                        corner.v = double(static_cast<std::int16_t>(g.b.be(uv + ti * 4 + 2, 2))) / 1024;
                        const auto mapped = mats[material].uv_transforms[mats[material].uv_set].map(corner.u, corner.v);
                        corner.u = mapped[0];
                        corner.v = mapped[1];
                    }
                    corners.push_back(corner);
                }
                cursor += std::size_t(vertices) * stride;
                if (primitive == 0x98)
                    for (unsigned k = 2; k < vertices; ++k)
                        triangle(corners[k - 2], corners[k % 2 ? k : k - 1], corners[k % 2 ? k - 1 : k]);
                else if (primitive == 0xa0)
                    for (unsigned k = 2; k < vertices; ++k)
                        triangle(corners[0], corners[k - 1], corners[k]);
                else if (primitive == 0x90) {
                    require(vertices % 3 == 0, "Incomplete Avalanche triangle list");
                    for (unsigned k = 0; k < vertices; k += 3)
                        triangle(corners[k], corners[k + 1], corners[k + 2]);
                } else if (primitive == 0x80) {
                    require(vertices % 4 == 0, "Incomplete Avalanche quad list");
                    for (unsigned k = 0; k < vertices; k += 4) {
                        triangle(corners[k], corners[k + 1], corners[k + 2]);
                        triangle(corners[k], corners[k + 2], corners[k + 3]);
                    }
                } else
                    throw std::runtime_error("Unsupported Avalanche draw primitive");
            }
        }
    };
    for (unsigned i = 0; i < count; ++i)
        if ((g.b.be(base + i * 40 + 36) & 255) != 1)
            emit(i, {});
    const auto nodes = g.b.be(0xcc), nodes_at = g.b.be(0x6c);
    require(nodes <= 100000, "Avalanche scenery placement count exceeds limit");
    g.b.range(nodes_at, std::size_t(nodes) * 80);
    for (unsigned i = 0; i < nodes; ++i) {
        const auto node = nodes_at + i * 80, object = g.b.be(node + 64, 2);
        if (object != 65535)
            emit(object, node, i);
    }
    if (!triangles)
        return 0;
    std::filesystem::create_directory(output / "Meshes");
    Json material_rows = Json::array();
    for (const auto& m : mats)
        material_rows.push_back(
            {{"TexturePath", m.image == 65535 ? Json(nullptr) : Json("ava-" + std::to_string(m.image) + ".png")},
             {"AlphaMode", m.alpha},
             {"RepeatTexture", backdrop && m.repeat_texture}});
    for (const auto index : colour_textures) {
        require(index < colour_count, "Avalanche scenery colour index out of range");
        const auto name = "ava-colour-" + std::to_string(index);
        g.b.range(colours + index * 4, 4);
        Image image{name, 1, 1, {}};
        for (unsigned channel = 0; channel < 4; ++channel)
            image.rgba.push_back(std::uint8_t(g.b.be(colours + index * 4 + channel, 1)));
        write_png(output / "Textures" / (name + ".png"), image);
        const auto alpha = g.b.be(colours + index * 4 + 3, 1);
        material_rows.push_back(
            {{"TexturePath", name + ".png"}, {"AlphaMode", alpha > 0 && alpha < 255 ? "blend" : "cutout"}});
    }
    std::map<unsigned, unsigned> gradient_materials;
    for (unsigned page = 0; page < gradients.size(); ++page) {
        const auto& image = gradients[page];
        write_png(output / "Textures" / (image.name + ".png"), image);
        gradient_materials.emplace(65536 + page, unsigned(material_rows.size()));
        material_rows.push_back({{"TexturePath", image.name + ".png"}, {"AlphaMode", "blend"}});
    }
    std::ifstream model_file(output / "Models.json"), instance_file(output / "Instances.json");
    auto models = Json::parse(model_file), instances = Json::parse(instance_file);
    std::map<unsigned, unsigned> model_ids;
    for (unsigned asset = 0; asset < assets.size(); ++asset) {
        const auto& source = assets[asset];
        Json meshes = Json::array();
        std::vector<unsigned> order;
        for (const auto& [material, part] : source.parts)
            if (!backdrop || material >= mats.size())
                order.push_back(material);
        if (backdrop)
            for (const auto& [material, part] : source.parts)
                if (material < mats.size())
                    order.push_back(material);
        for (const auto material : order) {
            const auto& part = source.parts.at(material);
            if (!part.vertices)
                continue;
            const auto name = backdrop
                                  ? "ava-scene-" + std::to_string(material) + ".obj"
                                  : "ava-object-" + std::to_string(asset) + "-" + std::to_string(material) + ".obj";
            std::ofstream file(output / "Meshes" / name);
            file << part.text.str();
            require(bool(file), "Cannot write Avalanche scenery mesh");
            meshes.push_back(
                {{"MeshPath", name}, {"MaterialID", material >= 65536 ? gradient_materials.at(material) : material}});
        }
        if (meshes.empty())
            continue;
        model_ids.emplace(asset, unsigned(models.at("Models").size()));
        models["Models"].push_back({{"ModelName", source.name},
                                    {"SourceObjectIndex", source.object},
                                    {"AnimTime", 0},
                                    {"ModelObjects", {{{"ParentID", -1}, {"MeshData", meshes}}}}});
    }
    if (backdrop)
        placements.resize(1);
    for (const auto& placement : placements) {
        if (!model_ids.contains(placement.asset))
            continue;
        auto instance =
            Json{{"InstanceName", assets[placement.asset].name +
                                      (placement.node ? " placement " + std::to_string(*placement.node) : "")},
                 {"ModelID", model_ids.at(placement.asset)},
                 {"SourceObjectIndex", placement.object},
                 {"Visable", true},
                 {"Location", raw(placement.origin)},
                 {"Rotation", {0, 0, 0, 1}},
                 {"Scale", {1, 1, 1}},
                 {"CollsionMode", 0},
                 {"PlayerCollision", false},
                 {"AmbentLightColour", {256, 256, 256}}};
        if (placement.node)
            instance["SourcePlacementIndex"] = *placement.node;
        instances["Instances"].push_back(std::move(instance));
    }
    model_file.close();
    instance_file.close();
    save(output / "Models.json", models);
    save(output / "Instances.json", instances);
    save(output / "Materials.json", {{"Materials", material_rows}});
    return triangles;
}

SceneLight light_rig(Bytes bytes) {
    const auto count = bytes.be(0);
    require(count > 0 && count <= 8 && bytes.data.size() == 32 + count * 160, "Invalid Avalanche light rig extent");
    SceneLight result;
    const auto rgb = [&](std::size_t at) {
        require(bytes.be(at + 3, 1) == 255, "Unsupported Avalanche light colour packing");
        return Vec3{bytes.be(at, 1) / 255., bytes.be(at + 1, 1) / 255., bytes.be(at + 2, 1) / 255.};
    };
    for (unsigned i = 0; i < count; ++i) {
        const auto at = 32 + i * 160;
        require(bytes.be(at) == 0x00010003, "Unsupported Avalanche light record");
        const auto direction = -vector(bytes, at + 40);
        require(std::abs(length(direction) - 1) < .01, "Invalid Avalanche light direction");
        if (i == 0)
            result.ambient = rgb(at + 20);
        result.keys[i] = {normalized(direction), rgb(at + 16)};
    }
    auto energy = result.ambient;
    for (const auto& key : result.keys)
        energy += key.colour;
    const auto scale = std::max({1., energy.x, energy.y, energy.z});
    result.ambient = result.ambient / scale;
    for (auto& key : result.keys)
        key.colour = key.colour / scale;
    return result;
}

void bake_lighting(const SceneLight& rig, const std::filesystem::path& output, const ImportCancel& cancel) {
    const auto terrain = Terrain::load(output);
    std::ifstream input(output / "Patches.json");
    auto document = Json::parse(input);
    input.close();
    std::filesystem::create_directory(output / "Lightmaps");
    for (std::size_t first = 0; first < terrain.patches().size(); first += 256) {
        Image page{"", 128, 128, std::vector<std::uint8_t>(128 * 128 * 4)};
        for (std::size_t i = first; i < std::min(first + 256, terrain.patches().size()); ++i) {
            check_cancel(cancel);
            const auto x = unsigned(i % 16) * 8, y = unsigned((i % 256) / 16) * 8;
            for (unsigned v = 0; v < 8; ++v)
                for (unsigned u = 0; u < 8; ++u) {
                    const auto normal = terrain.patches()[i].normal(v / 7., u / 7.);
                    const auto light = rig.evaluate({-normal.x, normal.y, normal.z});
                    const auto grey = .2126 * light.x + .7152 * light.y + .0722 * light.z;
                    page.rgba[((y + v) * 128 + x + u) * 4 + 3] =
                        std::uint8_t(std::clamp(std::round(grey * 255), 0., 255.));
                }
            document["Patches"][i]["LightmapID"] = first / 256;
            document["Patches"][i]["LightMapPoint"] = {x / 128., y / 128., 8 / 128., 8 / 128.};
        }
        std::ostringstream name;
        name << std::setfill('0') << std::setw(4) << first / 256 << ".png";
        write_png(output / "Lightmaps" / name.str(), page);
    }
    save(output / "Patches.json", document);
    std::ifstream placements(output / "Instances.json");
    auto instances = Json::parse(placements);
    placements.close();
    Json lights = Json::array({{{"LightName", "Avalanche ambient"},
                                {"Type", 3},
                                {"Colour", {rig.ambient.x, rig.ambient.y, rig.ambient.z}},
                                {"Direction", {0, 0, 0}},
                                {"Position", {0, 0, 0}}}});
    for (auto& row : instances["Instances"]) {
        if (!row.value("Visable", true))
            continue;
        row["AmbentLightColour"] = {rig.ambient.x * 256, rig.ambient.y * 256, rig.ambient.z * 256};
        for (unsigned i = 0; i < 3; ++i) {
            const auto& key = rig.keys[i];
            row["LightColour" + std::to_string(i + 1)] = {key.colour.x * 256, key.colour.y * 256, key.colour.z * 256};
            row["LightVector" + std::to_string(i + 1)] = raw(key.direction);
        }
    }
    for (unsigned i = 0; i < 3; ++i) {
        const auto& key = rig.keys[i];
        if (length(key.colour) > 0)
            lights.push_back({{"LightName", "Avalanche directional " + std::to_string(i)},
                              {"Type", 0},
                              {"Colour", {key.colour.x, key.colour.y, key.colour.z}},
                              {"Direction", raw(-key.direction)},
                              {"Position", {0, 0, 0}}});
    }
    save(output / "Instances.json", instances);
    save(output / "Lights.json", {{"Lights", lights}});
}

Json environment(const DiscInput& disc, const Course& course, const std::filesystem::path& output,
                 const ImportCancel& cancel) {
    auto directory = world_directory(course);
    directory.resize(directory.size() - std::string("/World/1P").size());
    const auto entries = gamecube_directory(disc, directory);
    const auto filename = std::string(course.stem) + ".LVL";
    if (std::none_of(entries.begin(), entries.end(),
                     [&](const auto& entry) { return !entry.directory && entry.name == filename; }))
        return {{"Available", false}};
    const auto package = directory + "/" + filename;
    const auto files = level(disc, package, cancel);
    const auto suffix = std::string(course.stem.substr(3));
    const auto prefix = "BG" + suffix;
    const auto sky = output / "Skybox";
    std::filesystem::create_directories(sky / "Textures");
    save(sky / "Models.json", {{"Models", Json::array()}});
    save(sky / "Instances.json", {{"Instances", Json::array()}});
    std::set<unsigned> used;
    const auto art = member(files, prefix + ".TPL");
    const Bytes mtl{member(files, prefix + ".MTL")};
    auto mats = materials(mtl, Bytes{art}.be(4), used);
    std::set<unsigned> cloud_masks;
    // Some backdrops use an opaque white stage before their cloud image.
    // Select that image and its corresponding UV stream for the portable layer.
    for (unsigned i = 0; i < mats.size(); ++i) {
        auto& mat = mats[i];
        if (mat.image == 65535)
            continue;
        const auto image = texture(Bytes{art}, mat.image, "ava-");
        const auto at = mtl.be(0) + i * 164, stages = mtl.be(at, 1);
        if (stages >= 2 && stages <= 8 &&
            std::all_of(image.rgba.begin(), image.rgba.end(), [](auto value) { return value == 255; })) {
            const auto secondary = mtl.be(at + 150, 2);
            if (secondary < Bytes{art}.be(4)) {
                mat.image = secondary;
                mat.uv_set = 1;
                used.insert(secondary);
                const auto header = Bytes{art}.be(Bytes{art}.be(8) + secondary * 8);
                if (Bytes{art}.be(header + 4) <= 1)
                    cloud_masks.insert(secondary);
            }
        }
    }
    for (const auto index : used) {
        check_cancel(cancel);
        auto image = texture(Bytes{art}, index, "ava-");
        // A white stage followed by an intensity-only image supplies cloud
        // coverage. Adapt it to alpha-over rather than painting its black field.
        if (cloud_masks.contains(index))
            for (std::size_t p = 0; p < image.rgba.size(); p += 4) {
                image.rgba[p + 3] = image.rgba[p];
                image.rgba[p] = image.rgba[p + 1] = image.rgba[p + 2] = 255;
            }
        const auto header = Bytes{art}.be(Bytes{art}.be(8) + index * 8);
        const auto wrap_s = Bytes{art}.be(header + 12), wrap_t = Bytes{art}.be(header + 16);
        require(wrap_s <= 1 && wrap_s == wrap_t, "Unsupported Avalanche background texture wrap");
        bool translucent = false;
        for (std::size_t i = 3; i < image.rgba.size(); i += 4)
            translucent |= image.rgba[i] != 0 && image.rgba[i] != 255;
        for (auto& mat : mats)
            if (mat.image == index) {
                mat.alpha = translucent ? "blend" : "cutout";
                mat.repeat_texture = wrap_s == 1;
            }
        write_png(sky / "Textures" / (image.name + ".png"), image);
    }
    const auto sky_triangles = scenery(Geometry{Bytes{member(files, prefix + ".GEO")}}, mats, sky, cancel, true);
    require(sky_triangles > 0, "Avalanche background has no drawable geometry");
    const auto player = "PLAYERLIGHT_" + suffix + ".LIG";
    const auto rig = light_rig(Bytes{member(files, player)});
    bake_lighting(rig, output, cancel);
    Json particles = Json::array();
    const auto particle_file = files.find("PTCL" + suffix + ".TPL");
    if (particle_file != files.end()) {
        const Bytes particle_art{particle_file->second};
        const auto count = particle_art.be(4);
        require(count <= 4096, "Avalanche particle texture count exceeds limit");
        std::filesystem::create_directories(output / "Textures/Particles");
        for (unsigned i = 0; i < count; ++i) {
            const auto image = texture(particle_art, i, "ava-course-");
            write_png(output / "Textures/Particles" / (image.name + ".png"), image);
            particles.push_back({{"TexturePath", "Particles/" + image.name + ".png"},
                                 {"Width", image.width},
                                 {"Height", image.height}});
        }
    }
    bool spray = false;
    const auto misc = gamecube_directory(disc, "1080Data/Misc");
    if (std::any_of(misc.begin(), misc.end(),
                    [](const auto& entry) { return entry.name == "spray.tpl" && !entry.directory; })) {
        const auto bytes = gamecube_file(disc, "1080Data/Misc/spray.tpl");
        auto image = texture(Bytes{bytes}, 0, "ava-spray-");
        std::filesystem::create_directories(output / "Textures/Particles");
        write_png(output / "Textures/Particles/ava-spray-source.png", image);
        // The source art is used additively. Convert its black border to coverage
        // for the portable alpha-over sheet, preserving the original beside it.
        for (std::size_t p = 0; p < image.rgba.size(); p += 4) {
            image.rgba[p + 3] = std::uint8_t(unsigned(image.rgba[p + 3]) *
                                             std::max({image.rgba[p], image.rgba[p + 1], image.rgba[p + 2]}) / 255);
            image.rgba[p] = image.rgba[p + 1] = image.rgba[p + 2] = 255;
        }
        write_png(output / "Textures/Particles/ava-spray.png", image);
        save(output / "RidingEffects.json", {{"Schema", "openslope-riding-effects/v1"},
                                             {"Sheet", "Particles/ava-spray.png"},
                                             {"Puff", "Particles/ava-spray.png"}});
        spray = true;
    }
    save(output / "World.json", {{"Schema", "openslope-world/v1"},
                                 {"Course", slot(course)},
                                 {"Fog", {{"Enabled", false}}},
                                 {"Glare", {{"Enabled", false}}}});
    Json report{{"Available", true},
                {"SourcePackage", package},
                {"SkyTriangles", sky_triangles},
                {"LightRig", player},
                {"LightingPolicy", "energy-normalized global rig; grey normal bake; coloured prop/rider keys"},
                {"ParticleTextures", particles},
                {"RidingSpraySheet", spray},
                {"Deferred",
                 {"source-shadow-map", "source-fog", "particle-emitter-programs", "animated-hazards",
                  "secondary-texture-layers"}}};
    save(output / "AvalancheEnvironment.json", report);
    static_cast<void>(World::load(output));
    return report;
}
} // namespace

std::vector<DiscCourse> avalanche_courses(const DiscInput& disc, const ImportCancel& cancel) {
    check_cancel(cancel);
    const auto header = disc.read(0, 6);
    require(Bytes{header}.text(0, 6) == "GTEE01", "This GameCube game or Avalanche region is not supported yet");
    std::vector<DiscCourse> result;
    for (const auto& course : catalogue) {
        check_cancel(cancel);
        const auto files = gamecube_directory(disc, world_directory(course));
        const auto found = std::find_if(files.begin(), files.end(), [&](const auto& file) {
            return !file.directory && file.name == package_name(course);
        });
        if (found != files.end())
            result.push_back({slot(course), found->bytes});
    }
    require(!result.empty(), "No supported Avalanche course packages found");
    return result;
}

void write_avalanche_course(const DiscInput& disc, const std::string& course, const std::filesystem::path& output,
                            const ImportProgress& progress, const ImportCancel& cancel) {
    const auto selected =
        std::find_if(catalogue.begin(), catalogue.end(), [&](const auto& row) { return slot(row) == course; });
    require(selected != catalogue.end(), "Unsupported Avalanche course");
    const auto available = avalanche_courses(disc, cancel);
    require(std::any_of(available.begin(), available.end(), [&](const auto& row) { return row.name == course; }),
            "Avalanche course package is missing");
    const auto notify = [&](const std::string& text) {
        check_cancel(cancel);
        if (progress)
            progress(text);
    };
    notify("Reading Avalanche " + std::string(selected->stem) + " " + std::string(selected->variant));
    const auto package = world_directory(*selected) + "/" + package_name(*selected);
    const auto files = level(disc, package, cancel);
    const auto stem = member_stem(*selected);
    const auto geometry = member(files, stem + ".GEO");
    const auto art = member(files, stem + ".TPL");
    const auto material_data = member(files, stem + ".MTL");
    Geometry g{Bytes{geometry}};
    const auto count = g.b.be(0x88), at = g.b.be(0x28);
    require(count && count <= 100000, "Invalid Avalanche terrain count");
    g.b.range(at, std::size_t(count) * 144);
    const auto uv_at = g.b.be(0x3c), uv_count = g.b.be(0x9c);
    require(uv_count && uv_count <= 1000000, "Invalid Avalanche terrain UV count");
    g.b.range(uv_at, std::size_t(uv_count) * 4);
    std::set<unsigned> used;
    auto mats = materials(Bytes{material_data}, Bytes{art}.be(4), used);
    // The GEO's bounded name directory supplies semantic material labels.
    const auto names = std::size_t(at) + std::size_t(count) * 144;
    g.b.range(names, 20 + mats.size() * 24);
    require(g.b.text(names, 13) == "MatNameListV2" && g.b.be(names + 16) == mats.size(),
            "Invalid Avalanche material name directory");
    for (std::size_t i = 0; i < mats.size(); ++i) {
        auto name = g.b.text(names + 20 + i * 24, 15);
        name.resize(name.find('\0') == std::string::npos ? name.size() : name.find('\0'));
        mats[i].name = name;
        // OpenSlope surface policy, not a recovered Avalanche physics mapping.
        if (name.find("Powder") != std::string::npos)
            mats[i].surface = 2;
        if (name.find("Rock") != std::string::npos)
            mats[i].surface = 9;
    }
    notify("Decoding Avalanche textures");
    std::filesystem::create_directory(output / "Textures");
    for (const auto index : used) {
        check_cancel(cancel);
        const auto image = texture(Bytes{art}, index, "ava-");
        write_png(output / "Textures" / (image.name + ".png"), image);
    }
    Json patches = Json::array();
    notify("Converting curved Avalanche terrain");
    for (unsigned i = 0; i < count; ++i) {
        check_cancel(cancel);
        const auto p = at + i * 144, mat = g.b.be(p + 132, 2);
        require(mat < mats.size(), "Avalanche patch material out of bounds");
        Json points = Json::array();
        // Reflecting X seats the source tensor in the portable quilt's skyward
        // winding. Keep each UV attached to its source control point.
        for (unsigned j = 0; j < 16; ++j)
            points.push_back(raw(g.position(g.b.be(p + 28 + j * 4))));
        // Source UV indices occupy the same 4x4 tensor as the control points.
        // Portable UVPoints bind to (0,0),(1,0),(0,1),(1,1), i.e. portable
        // controls 0,12,3,15, which now match those same source indices.
        // Keep signed coordinates: rotations, mirrors, crops and repeats are authored data.
        Json uv = Json::array();
        for (const auto corner : {0u, 12u, 3u, 15u}) {
            const auto index = g.b.be(p + 100 + corner * 2, 2);
            require(index < uv_count, "Avalanche terrain UV index out of range");
            const auto mapped = mats[mat].uv_transforms[0].map(
                double(static_cast<std::int16_t>(g.b.be(uv_at + index * 4, 2))) / 1024,
                double(static_cast<std::int16_t>(g.b.be(uv_at + index * 4 + 2, 2))) / 1024);
            uv.push_back(mapped);
        }
        const auto& m = mats[mat];
        patches.push_back({{"PatchName", "Avalanche terrain " + std::to_string(i)},
                           {"Points", points},
                           {"SurfaceType", m.surface},
                           {"TexturePath", m.image == 65535 ? "" : "ava-" + std::to_string(m.image) + ".png"},
                           {"UVPoints", uv},
                           {"LightmapID", -1},
                           {"LightMapPoint", {0, 0, 0, 0}},
                           {"TrickOnlyPatch", false}});
    }
    save(output / "Patches.json", {{"Patches", patches}});
    notify("Converting Avalanche collision mesh");
    const auto collision_count = collision(Bytes{member(files, stem + ".COL")}, output, cancel);
    notify("Converting static Avalanche scenery");
    const auto scenery_count = scenery(g, mats, output, cancel);
    notify("Separating Avalanche props and authoring collision");
    std::vector<std::string> material_names;
    for (const auto& mat : mats)
        material_names.push_back(mat.name);
    const auto prop_extraction =
        refine_avalanche_props(output, Bytes{member(files, stem + ".COL")}, material_names, cancel);
    notify("Converting Avalanche background, lighting and particle art");
    const auto atmosphere = environment(disc, *selected, output, cancel);
    save(output / "Origin.json", {{"Schema", "openslope-origin/v1"},
                                  {"Origin", "retail"},
                                  {"Course", course},
                                  {"SourcePackage", package},
                                  {"RetailData", true},
                                  {"Reasons", {"retail-extract"}}});
    // A geometry-derived OpenSlope start is explicit. No retail camera/start table is inferred.
    const auto terrain = Terrain::load(output);
    auto [start, direction] = terrain.spawn();
    double best = -1e100;
    for (const auto& patch : terrain.patches()) {
        if (patch.surface != 1)
            continue;
        for (double u : {.15, .5, .85})
            for (double v : {.15, .5, .85}) {
                const auto point = patch.evaluate(u, v), normal = patch.normal(u, v);
                if (normal.y < .7 || point.y <= best)
                    continue;
                const auto heading = normalized(project(Vec3{0, -1, 0}, normal), {0, 0, -1});
                const auto ahead = point + heading * 4;
                const auto support = terrain.intersect(ahead + Vec3{0, 5, 0}, ahead - Vec3{0, 10, 0});
                if (!support || support->normal.y < .5)
                    continue;
                start = point;
                direction = heading;
                best = point.y;
            }
    }
    if (selected->stem != "Crs00_00") {
        struct Candidate {
            Vec3 point, normal;
            unsigned priority;
        };

        std::vector<Candidate> candidates;
        for (std::size_t index = 0; index < terrain.patches().size(); ++index) {
            const auto& patch = terrain.patches()[index];
            const auto material = g.b.be(at + index * 144 + 132, 2);
            const auto& name = mats[material].name;
            const auto snow = name.find("Snow") != std::string::npos || name.find("snow") != std::string::npos ||
                              name.find("CF_a") != std::string::npos || name.find("CF_b") != std::string::npos ||
                              name.find("Cf_a") != std::string::npos || name.find("Cf_b") != std::string::npos;
            if (patch.surface != 1 || !snow)
                continue;
            for (double u : {.15, .5, .85})
                for (double v : {.15, .5, .85})
                    if (const auto normal = patch.normal(u, v); normal.y >= .85 && normal.y < .9995) {
                        const auto groomed =
                            name.find("CF_a") != std::string::npos || name.find("Cf_a") != std::string::npos;
                        candidates.push_back({patch.evaluate(u, v), normal, groomed ? 0u : 1u});
                    }
        }
        std::stable_sort(candidates.begin(), candidates.end(), [](const auto& a, const auto& b) {
            return a.priority != b.priority ? a.priority < b.priority : a.point.y > b.point.y;
        });
        const auto world = CollisionWorld::load(output);
        bool supported = false;
        for (const auto& candidate : candidates) {
            check_cancel(cancel);
            const auto floor = terrain.intersect({candidate.point.x, terrain.bounds().max.y + 2, candidate.point.z},
                                                 candidate.point - Vec3{0, 2, 0});
            if (!floor || length(floor->point - candidate.point) > .02 || floor->normal.y < .85)
                continue;
            const auto heading = normalized(project(Vec3{0, -1, 0}, candidate.normal), {0, 0, -1});
            const auto side = normalized(cross(heading, {0, 1, 0}));
            constexpr std::array lateral{0., -1.5, 1.5};
            std::array<Vec3, 3> previous;
            for (unsigned lane = 0; lane < lateral.size(); ++lane)
                previous[lane] = candidate.point + side * lateral[lane] + Vec3{0, 1, 0};
            bool clear = true;
            for (unsigned distance = 4; distance <= 128 && clear; distance += 4) {
                for (unsigned lane = 0; lane < lateral.size(); ++lane) {
                    const auto ahead = candidate.point + heading * double(distance) + side * lateral[lane];
                    const auto hit =
                        terrain.intersect({ahead.x, terrain.bounds().max.y + 2, ahead.z}, ahead - Vec3{0, 12, 0});
                    if (!hit || std::abs(hit->point.y - ahead.y) > 12 || hit->normal.y < .65 ||
                        (hit->surface != 1 && hit->surface != 2)) {
                        clear = false;
                        break;
                    }
                    const auto centre = hit->point + Vec3{0, 1, 0};
                    const std::array<ProbeSphere, 1> from{{{previous[lane], .45}}}, to{{{centre, .45}}};
                    if (!world.sweep(from, to).empty()) {
                        clear = false;
                        break;
                    }
                    previous[lane] = centre;
                }
            }
            if (clear) {
                start = candidate.point;
                direction = heading;
                supported = true;
                break;
            }
        }
        require(supported, "No clear supported Avalanche starting runout found");
    }
    const auto to_raw = [](Vec3 p) { return Json{p.x * 100, -p.z * 100, p.y * 100}; };
    save(output / "AIP.json", {{"AIPaths",
                                {{{"Name", "OpenSlope Avalanche start"},
                                  {"PathPos", to_raw(start)},
                                  {"PathPoints", {to_raw(direction * 2), to_raw(direction * 2)}},
                                  {"U3", 50},
                                  {"Respawnable", false},
                                  {"PathEvents", Json::array()}}}},
                               {"RaceLines", Json::array()},
                               {"StartPosList", {0}}});
    save(output / "Import.json",
         {{"Schema", "openslope-native-import/v1"},
          {"Game", "1080-avalanche"},
          {"Course", course},
          {"SourcePackage", package},
          {"Complete", false},
          {"Outputs",
           {"Patches.json", "Textures", "AIP.json", "Origin.json", "Collision", "Models.json", "Materials.json",
            "Instances.json"}},
          {"TerrainPatches", count},
          {"CoordinatePolicy", "reflect source X; Y-up to portable Z-up; reverse polygon winding"},
          {"SceneryPolicy", "separate source objects/placements; exact linear bases baked; translations editable"},
          {"TerrainUVPolicy", "source signed corner UVs and first-key material SRT bound to source control tensor"},
          {"MaterialUVPolicy", "source UV SRT frozen at first key; camera projections and custom matrices deferred"},
          {"MaterialUVTransforms",
           std::count_if(mats.begin(), mats.end(), [](const auto& m) { return m.uv_transforms[0].applied; })},
          {"AnimatedMaterialUVsFrozen",
           std::count_if(mats.begin(), mats.end(), [](const auto& m) { return m.uv_transforms[0].animated; })},
          {"DeferredMaterialUVs",
           std::count_if(mats.begin(), mats.end(), [](const auto& m) { return m.uv_transforms[0].deferred; })},
          {"CollisionTriangles", collision_count.triangles},
          {"RideableSnowTriangles", collision_count.snow_triangles},
          {"TrunkProxies", collision_count.trunk_proxies},
          {"DeferredCollisionPrimitives", collision_count.deferred_primitives},
          {"TrunkProxyPolicy", "OpenSlope twelve-sided endpoint-radius cylinders"},
          {"SceneryTriangles", scenery_count},
          {"PropExtraction", prop_extraction},
          {"Environment", atmosphere},
          {"SpawnPolicy", selected->stem == "Crs00_00" ? "supported-groomed-terrain" : "supported-snow-corridor-128m"},
          {"Deferred",
           {"animated-and-camera-material-uv-transforms", "multilayer-materials", "collision-primitives",
            "source-starts", "hazards", "events", "audio"}}});
    notify("Validating Avalanche terrain and start");
    static_cast<void>(Terrain::load(output));
    static_cast<void>(CoursePaths::load(output));
    static_cast<void>(Props::load(output));
    static_cast<void>(CollisionWorld::load(output));
}
} // namespace openslope::import_detail
