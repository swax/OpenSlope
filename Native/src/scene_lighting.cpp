#include "openslope/scene_lighting.hpp"
#include <algorithm>
#include <limits>

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

SceneLighting::SceneLighting(std::vector<LightProbe> probes) : probes_(std::move(probes)) {
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
        return SceneLight::fallback();
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
    return result;
}
} // namespace openslope
