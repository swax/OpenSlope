#include "openslope/lighting.hpp"
#include <algorithm>

namespace openslope {
LightingUniform enhanced_lighting(const World& world, Vec3 eye) {
    LightingUniform result;
    const auto luminance = world.sky_colour[0] * .2126f + world.sky_colour[1] * .7152f + world.sky_colour[2] * .0722f;
    // Continuous sky-derived daylight also works for maps without a sun sprite.
    const auto day = std::clamp((luminance - .08f) / .28f, 0.f, 1.f);
    auto direction = world.glare.direction();
    direction.y = std::max(direction.y, .25);
    direction = normalized(direction);
    result.sun_direction = {float(direction.x), float(direction.y), float(direction.z), 0};
    result.sun_colour = {.65f * day, .56f * day, .43f * day, 0};
    result.ambient = {.62f - day * .05f, .67f - day * .04f, .81f - day * .07f, 0};
    result.settings = {1, day, 0, 0};
    std::vector<const LampGlint*> nearby;
    for (const auto& lamp : world.glints)
        if (lamp.brightness > 0 && length(lamp.position - eye) < 160)
            nearby.push_back(&lamp);
    std::stable_sort(nearby.begin(), nearby.end(), [&](const auto* a, const auto* b) {
        return length(a->position - eye) < length(b->position - eye);
    });
    const auto count = std::min(nearby.size(), result.lamps.size());
    result.settings[2] = float(count);
    for (std::size_t i = 0; i < count; ++i) {
        const auto& lamp = *nearby[i];
        auto& output = result.lamps[i];
        const auto radius = std::clamp(8.f + float(lamp.size) * .35f, 10.f, 32.f);
        output.position_radius = {float(lamp.position.x), float(lamp.position.y), float(lamp.position.z), radius};
        output.colour = {float(lamp.hue.x * lamp.brightness), float(lamp.hue.y * lamp.brightness),
                         float(lamp.hue.z * lamp.brightness), 0};
    }
    return result;
}
} // namespace openslope
