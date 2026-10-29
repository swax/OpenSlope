#include "lighting.hpp"
#include "openslope/scene_lighting.hpp"
#include <algorithm>
#include <fstream>
#include <iomanip>
#include <nlohmann/json.hpp>
#include <sstream>

namespace openslope::import_detail {
namespace {
using Json = nlohmann::json;

void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}

double number(Bytes b, std::size_t at) {
    const auto value = std::bit_cast<float>(b.be(at));
    require(std::isfinite(value) && std::abs(value) < 1e9, "Invalid Avalanche lighting coordinate");
    return value;
}

Vec3 vector(Bytes b, std::size_t at) { return {number(b, at), number(b, at + 4), number(b, at + 8)}; }

Json raw(Vec3 v) { return {-v.x, -v.z, v.y}; }

void save(const std::filesystem::path& path, const Json& value) {
    std::ofstream file(path, std::ios::binary);
    file << value.dump() << '\n';
    require(bool(file), "Cannot write Avalanche lighting");
}

Vec3 colour(Bytes bytes, std::size_t at) {
    return {bytes.be(at, 1) / 255., bytes.be(at + 1, 1) / 255., bytes.be(at + 2, 1) / 255.};
}

SceneLight light_rig(Bytes bytes) {
    const auto count = bytes.be(0);
    require(count > 0 && count <= 3 && bytes.data.size() == 32 + count * 160, "Invalid Avalanche light rig extent");
    SceneLight result;
    for (unsigned i = 0; i < count; ++i) {
        const auto at = 32 + i * 160;
        const auto type = bytes.be(at);
        require(type == 0x00010003 || type == 0x00010000, "Unsupported Avalanche directional light record");
        const auto direction = -vector(bytes, at + 40);
        require(std::abs(length(direction) - 1) < .01, "Invalid Avalanche light direction");
        require(bytes.be(at + 19, 1) == 255 && bytes.be(at + 23, 1) == 255,
                "Unsupported Avalanche light colour packing");
        if (i == 0)
            result.ambient = colour(bytes, at + 20);
        result.keys[i] = {normalized(direction), colour(bytes, at + 16)};
    }
    // [Trailmap: 607-rigs] Preserve source gains. Raster colour saturation
    // bounds their sum; normalization by total key energy darkens every normal.
    return result;
}

class ShadowField {
    std::array<int, 4096> grid_{};

    struct Tile {
        double x, z, width, depth;
        Image image;
    };

    std::vector<Tile> tiles_;

public:
    explicit ShadowField(Bytes b, const ImportCancel& cancel) {
        if (b.data.empty())
            return;
        // [Trailmap: 607-shadow] Independent storage/lookup recovery: a 32x128
        // signed-index grid, projection rectangles, and an embedded TPL bank.
        const auto grid = b.be(0), rectangles = b.be(4), images = b.be(8);
        require(grid >= 12 && rectangles >= grid + 8192 && images >= rectangles && images <= b.data.size(),
                "Invalid Avalanche shadow sections");
        b.range(grid, 8192);
        const Bytes tpl{b.data.subspan(images)};
        const auto count = tpl.be(4);
        require(tpl.be(0) == 0x0020af30 && count > 0 && count <= 4096 &&
                    std::uint64_t(rectangles) + count * 16 <= images,
                "Invalid Avalanche shadow catalogue");
        std::size_t decoded = 0;
        for (unsigned i = 0; i < count; ++i) {
            check_cancel(cancel);
            const auto at = rectangles + i * 16;
            Tile tile{number(b, at), number(b, at + 4), number(b, at + 8), number(b, at + 12),
                      avalanche_texture(tpl, i)};
            require(tile.width > 0 && tile.depth > 0, "Invalid Avalanche shadow rectangle");
            decoded += tile.image.rgba.size();
            require(decoded <= 64 * 1024 * 1024, "Avalanche shadow images exceed their decoded budget");
            tiles_.push_back(std::move(tile));
        }
        for (unsigned i = 0; i < grid_.size(); ++i) {
            const auto index = b.be(grid + i * 2, 2);
            require(index == 65535 || index < count, "Avalanche shadow grid index out of bounds");
            grid_[i] = index == 65535 ? -1 : int(index);
        }
    }

    std::size_t size() const { return tiles_.size(); }

    Vec3 sample(Vec3 native_position) const {
        if (tiles_.empty())
            return {1, 1, 1};
        const auto x = -native_position.x * 100, z = native_position.z * 100;
        const auto column = std::clamp(int((x + 320000) / 20000), 0, 31),
                   row = std::clamp(int((z + 1280000) / 20000), 0, 127);
        const auto index = grid_[row * 32 + column];
        if (index < 0)
            return {1, 1, 1};
        const auto& tile = tiles_[unsigned(index)];
        const auto& image = tile.image;
        const auto u = std::clamp((x - tile.x) / tile.width * image.width - .5, 0., double(image.width - 1)),
                   v = std::clamp((z - tile.z) / tile.depth * image.height - .5, 0., double(image.height - 1));
        const auto first_x = unsigned(u), first_y = unsigned(v), last_x = std::min(first_x + 1, image.width - 1),
                   last_y = std::min(first_y + 1, image.height - 1);
        const auto at = [&](unsigned px, unsigned py) {
            const auto p = (py * image.width + px) * 4;
            return Vec3{image.rgba[p] / 255., image.rgba[p + 1] / 255., image.rgba[p + 2] / 255.};
        };
        const auto fx = u - first_x, fy = v - first_y;
        return (at(first_x, first_y) * (1 - fx) + at(last_x, first_y) * fx) * (1 - fy) +
               (at(first_x, last_y) * (1 - fx) + at(last_x, last_y) * fx) * fy;
    }
};

void rig_row(Json& row, const SceneLight& rig) {
    row["AmbentLightColour"] = {rig.ambient.x * 256, rig.ambient.y * 256, rig.ambient.z * 256};
    for (unsigned i = 0; i < 3; ++i) {
        const auto& key = rig.keys[i];
        row["LightColour" + std::to_string(i + 1)] = {key.colour.x * 256, key.colour.y * 256, key.colour.z * 256};
        row["LightVector" + std::to_string(i + 1)] = raw(key.direction);
    }
}
} // namespace

Json write_avalanche_lighting(Bytes geometry, Bytes player, Bytes scenery, Bytes shadow,
                              const std::filesystem::path& output, const ImportCancel& cancel) {
    const auto rider = light_rig(player), objects = scenery.data.empty() ? rider : light_rig(scenery);
    const ShadowField field(shadow, cancel);
    const auto terrain = Terrain::load(output);
    const auto records = geometry.be(0x28), count = geometry.be(0x88), palette = geometry.be(0x38),
               colours = geometry.be(0x98);
    require(count == terrain.patches().size() && colours <= 65535, "Avalanche lighting terrain counts disagree");
    geometry.range(records, std::size_t(count) * 144);
    geometry.range(palette, std::size_t(colours) * 4);
    std::ifstream input(output / "Patches.json");
    auto document = Json::parse(input);
    input.close();
    std::filesystem::create_directory(output / "Lightmaps");
    constexpr unsigned tile_size = 16, columns = 128 / tile_size, per_page = columns * columns;
    unsigned tinted = 0;
    for (std::size_t first = 0; first < count; first += per_page) {
        Image page{"", 128, 128, std::vector<std::uint8_t>(128 * 128 * 4)};
        for (std::size_t i = first; i < std::min(first + per_page, std::size_t(count)); ++i) {
            check_cancel(cancel);
            std::array<Vec3, 4> corners;
            bool nonwhite = false;
            for (unsigned corner = 0; corner < 4; ++corner) {
                const auto index = geometry.be(records + i * 144 + 92 + corner * 2, 2);
                require(!colours || index < colours, "Avalanche terrain colour index out of bounds");
                corners[corner] = colours ? colour(geometry, palette + index * 4) : Vec3{1, 1, 1};
                nonwhite |= length(corners[corner] - Vec3{1, 1, 1}) > 1e-6;
            }
            tinted += nonwhite;
            const auto x = unsigned(i % columns) * tile_size, y = unsigned((i % per_page) / columns) * tile_size;
            for (unsigned v = 0; v < tile_size; ++v)
                for (unsigned u = 0; u < tile_size; ++u) {
                    const auto pu = double(v) / (tile_size - 1), pv = double(u) / (tile_size - 1);
                    const auto tint = (corners[0] * (1 - pv) + corners[1] * pv) * (1 - pu) +
                                      (corners[2] * (1 - pv) + corners[3] * pv) * pu;
                    auto lighting = field.sample(terrain.patches()[i].evaluate(pu, pv));
                    if (!field.size()) {
                        const auto normal = terrain.patches()[i].normal(pu, pv);
                        lighting = objects.evaluate({-normal.x, normal.y, normal.z});
                    }
                    const auto offset = ((y + v) * 128 + x + u) * 4;
                    for (unsigned channel = 0; channel < 3; ++channel) {
                        const auto a = channel == 0 ? tint.x : channel == 1 ? tint.y : tint.z;
                        const auto b = channel == 0 ? lighting.x : channel == 1 ? lighting.y : lighting.z;
                        page.rgba[offset + channel] = std::uint8_t(std::clamp(std::lround(a * b * 255), 0l, 255l));
                    }
                    page.rgba[offset + 3] = 255;
                }
            auto& patch = document["Patches"][i];
            patch["LightmapID"] = first / per_page;
            patch["LightMapPoint"] = {x / 128., y / 128., tile_size / 128., tile_size / 128.};
            patch["LightmapEncoding"] = "rgb-multiply";
        }
        std::ostringstream name;
        name << std::setfill('0') << std::setw(4) << first / per_page << ".png";
        write_png(output / "Lightmaps" / name.str(), page);
    }
    save(output / "Patches.json", document);
    std::ifstream placements(output / "Instances.json");
    auto instances = Json::parse(placements);
    placements.close();
    for (auto& row : instances["Instances"])
        if (row.value("Visable", true)) {
            rig_row(row, objects);
            Json player_row;
            rig_row(player_row, rider);
            row["RiderLighting"] = std::move(player_row);
        }
    save(output / "Instances.json", instances);
    Json lights = Json::array({{{"LightName", "Avalanche scenery ambient"},
                                {"Type", 3},
                                {"Colour", {objects.ambient.x, objects.ambient.y, objects.ambient.z}},
                                {"Direction", {0, 0, 0}},
                                {"Position", {0, 0, 0}}}});
    for (unsigned i = 0; i < 3; ++i) {
        const auto& key = objects.keys[i];
        if (length(key.colour) > 0)
            lights.push_back({{"LightName", "Avalanche scenery directional " + std::to_string(i)},
                              {"Type", 0},
                              {"Colour", {key.colour.x, key.colour.y, key.colour.z}},
                              {"Direction", raw(-key.direction)},
                              {"Position", {0, 0, 0}}});
    }
    save(output / "Lights.json", {{"Lights", lights}});
    Json report{{"Schema", "openslope-avalanche-lighting/v1"},
                {"TerrainEncoding", "rgb-multiply"},
                {"ShadowTextures", field.size()},
                {"TerrainTintedPatches", tinted},
                {"SamplesPerPatch", tile_size * tile_size},
                {"TimePolicy", "static source layout; no recovered clock or animated sun"},
                {"TerrainPolicy", field.size() ? "source corner RGB multiplied by projected source shadow RGB"
                                               : "source corner RGB with directional fallback"},
                {"RigPolicy", "separate source scenery and rider rigs; saturate after directional evaluation"},
                {"RiderShadePolicy", "OpenSlope RGB-ground projection; retail actor equation unresolved"},
                {"Deferred",
                 {"secondary-object-rig-selection", "moving-lights", "dynamic-shadow-casters", "source-fog",
                  "scenery-vertex-colours", "material-lighting-gates", "retail-actor-shadow-equation"}}};
    save(output / "AvalancheLighting.json", report);
    return report;
}
} // namespace openslope::import_detail
