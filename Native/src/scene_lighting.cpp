#include "openslope/scene_lighting.hpp"
#include "openslope/appearance.hpp"
#include <algorithm>
#include <iomanip>
#include <limits>
#include <sstream>
#include <stdexcept>

namespace openslope {
namespace {
double axis_of(Vec3 v, unsigned axis) { return axis == 0 ? v.x : axis == 1 ? v.y : v.z; }
} // namespace

Vec3 SceneLight::evaluate(Vec3 normal) const {
    normal = normalized(normal);
    auto result = ambient;
    for (const auto& key : keys)
        result += key.colour * std::max(0., dot(normal, key.direction));
    return {std::clamp(result.x, 0., 1.), std::clamp(result.y, 0., 1.), std::clamp(result.z, 0., 1.)};
}

SceneLight SceneLight::fallback() {
    SceneLight result;
    result.ambient = {.6, .6, .6};
    result.keys[0] = {normalized(Vec3{-.3, .8, -.5}), {.4, .4, .4}};
    return result;
}

SceneLighting::SceneLighting(std::vector<LightProbe> probes, std::function<Vec3(Vec3)> attenuation)
    : probes_(std::move(probes)), attenuation_(std::move(attenuation)) {
    build(0, probes_.size(), 0);
}

void SceneLighting::build(std::size_t begin, std::size_t end, unsigned axis) {
    if (begin == end)
        return;
    const auto mid = (begin + end) / 2;
    std::nth_element(
        probes_.begin() + begin, probes_.begin() + mid, probes_.begin() + end,
        [axis](const auto& a, const auto& b) { return axis_of(a.position, axis) < axis_of(b.position, axis); });
    build(begin, mid, (axis + 1) % 3);
    build(mid + 1, end, (axis + 1) % 3);
}

SceneLight SceneLighting::sample(Vec3 position) const {
    if (probes_.empty() || !finite(position))
        return attenuate(SceneLight::fallback(), position);
    // Four nearest in full 3D: a tunnel floor must not sample its roof by XZ.
    std::array<std::pair<double, const LightProbe*>, 4> nearest;
    for (auto& item : nearest)
        item = {std::numeric_limits<double>::infinity(), nullptr};
    const auto visit = [&](auto&& self, std::size_t begin, std::size_t end, unsigned axis) -> void {
        if (begin == end)
            return;
        const auto mid = (begin + end) / 2;
        const auto& probe = probes_[mid];
        const auto delta = position - probe.position;
        const auto distance = dot(delta, delta);
        if (distance < nearest.back().first) {
            nearest.back() = {distance, &probe};
            std::sort(nearest.begin(), nearest.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
        }
        const auto split = axis_of(delta, axis);
        if (split < 0) {
            self(self, begin, mid, (axis + 1) % 3);
            if (split * split <= nearest.back().first)
                self(self, mid + 1, end, (axis + 1) % 3);
        } else {
            self(self, mid + 1, end, (axis + 1) % 3);
            if (split * split <= nearest.back().first)
                self(self, begin, mid, (axis + 1) % 3);
        }
    };
    visit(visit, 0, probes_.size(), 0);
    double total = 0;
    for (const auto& [distance, probe] : nearest)
        if (probe)
            total += 1 / (1 + distance);
    SceneLight result;
    unsigned key_index = 0;
    for (const auto& [distance, probe] : nearest) {
        if (!probe)
            continue;
        const auto weight = 1 / ((1 + distance) * total);
        result.ambient += probe->ambient * weight;
        for (const auto& key : probe->keys)
            result.keys[key_index++] = {key.direction, key.colour * weight};
    }
    return attenuate(result, position);
}

SceneLight SceneLighting::attenuate(SceneLight light, Vec3 position) const {
    if (!attenuation_ || !finite(position))
        return light;
    const auto factor = attenuation_(position);
    light.ambient = {light.ambient.x * factor.x, light.ambient.y * factor.y, light.ambient.z * factor.z};
    for (auto& key : light.keys)
        key.colour = {key.colour.x * factor.x, key.colour.y * factor.y, key.colour.z * factor.z};
    return light;
}

std::function<Vec3(Vec3)> SceneLighting::terrain_attenuation(const Terrain& terrain, bool vertex_fallback) {
    if (std::none_of(terrain.patches().begin(), terrain.patches().end(), [vertex_fallback](const auto& patch) {
            return patch.active && (patch.lightmap_multiply || (vertex_fallback && patch.light_colors));
        }))
        return {};

    struct GroundLight {
        Terrain terrain;
        std::map<int, RgbaImage> images;
    };

    auto ground = std::make_shared<GroundLight>(GroundLight{terrain, {}});
    std::size_t decoded = 0;
    for (const auto& patch : terrain.patches()) {
        if (!patch.active || !patch.lightmap_multiply || patch.lightmap < 0 || ground->images.contains(patch.lightmap))
            continue;
        std::ostringstream page;
        page << std::setfill('0') << std::setw(4) << patch.lightmap << ".png";
        const auto path = terrain.map_root() / "Lightmaps" / page.str();
        if (!std::filesystem::is_regular_file(path))
            continue;
        auto image = read_png(path);
        if (image.width != 128 || image.height != 128)
            throw std::runtime_error("RGB terrain lightmap must be 128 by 128 pixels");
        decoded += image.pixels.size();
        if (decoded > 64 * 1024 * 1024)
            throw std::runtime_error("RGB actor lighting exceeds its 64 MiB image budget");
        ground->images.emplace(patch.lightmap, std::move(image));
    }
    if (ground->images.empty() && !vertex_fallback)
        return {};
    // RGB pages and baked vertex colours contain separable colour/shade factors.
    // Project onto the first surface below the body, keeping a cave floor distinct from its roof.
    // Vertex colours fill in for missing actor probes; existing probes remain authoritative.
    // Legacy residual lightmaps already have local instance probes and do not
    // enter this path. This projection is an OpenSlope approximation.
    return [ground, vertex_fallback](Vec3 position) -> Vec3 {
        const auto hit = ground->terrain.intersect(position + Vec3{0, .25, 0},
                                                   {position.x, ground->terrain.bounds().min.y - 1, position.z});
        if (!hit)
            return {1, 1, 1};
        const auto& patch = ground->terrain.patches()[hit->patch];
        if (vertex_fallback && patch.light_colors) {
            const auto rgb = patch.light_color(hit->u, hit->v);
            return {rgb[0], rgb[1], rgb[2]};
        }
        const auto image = ground->images.find(patch.lightmap);
        if (!patch.lightmap_multiply || image == ground->images.end())
            return {1, 1, 1};
        const auto& rect = patch.lightmap_rect;
        if (rect[2] <= 0 || rect[3] <= 0)
            return {1, 1, 1};
        const auto x = std::round(rect[0] * 128) + hit->v * std::max(0., std::round(rect[2] * 128) - 1),
                   y = std::round(rect[1] * 128) + hit->u * std::max(0., std::round(rect[3] * 128) - 1);
        const auto px = std::floor(x), py = std::floor(y), fx = x - px, fy = y - py;
        const auto at = [&](double a, double b) {
            const auto offset = (std::size_t(std::clamp(b, 0., 127.)) * 128 + std::size_t(std::clamp(a, 0., 127.))) * 4;
            const auto& pixels = image->second.pixels;
            return Vec3{pixels[offset] / 255., pixels[offset + 1] / 255., pixels[offset + 2] / 255.};
        };
        return (at(px, py) * (1 - fx) + at(px + 1, py) * fx) * (1 - fy) +
               (at(px, py + 1) * (1 - fx) + at(px + 1, py + 1) * fx) * fy;
    };
}
} // namespace openslope
