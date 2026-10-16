#include "openslope/fence.hpp"
#include <stdexcept>

namespace openslope {
FencePlayback::FencePlayback(double flex, Vec3 impact) {
    if (!std::isfinite(flex) || std::abs(flex) > 1e9 || !finite(impact))
        throw std::invalid_argument("Invalid fence reaction");
    direction_ = normalized(project(impact, {0, 1, 0}), {});
    // Application tuning: 0.5 authored flex gives a 10 cm envelope, bounded
    // to 25 cm. A 4.5 Hz rattle decays at 5/s and returns exactly to rest.
    amplitude_ = std::clamp(flex * .2, -.25, .25);
    if (!amplitude_ || length(direction_) == 0)
        age_ = lifetime;
}

void FencePlayback::step(double seconds) {
    if (!std::isfinite(seconds) || seconds < 0 || seconds > 1)
        throw std::invalid_argument("Invalid fence step");
    age_ = std::min(lifetime, age_ + seconds);
    if (age_ >= lifetime - 1e-9)
        age_ = lifetime;
}

Vec3 FencePlayback::offset() const {
    if (settled())
        return {};
    return direction_ * (amplitude_ * std::exp(-5 * age_) * std::sin(2 * pi * 4.5 * age_));
}
} // namespace openslope
