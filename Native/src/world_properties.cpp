#include "openslope/world_properties.hpp"
#include <algorithm>
#include <stdexcept>

namespace openslope {
PropChecklist::PropChecklist(std::uint32_t count) : remaining_(count) {
    if (count > 1000000)
        throw std::invalid_argument("Counter exceeds application limit");
}

void PropChecklist::control(unsigned command, double value) {
    if (!std::isfinite(value) || std::abs(value) > 1000000)
        throw std::invalid_argument("Invalid counter input");
    if (remaining_ == 0 || fired_)
        return;
    if (command == 1 || command == 2) {
        if (value < 0 || value != std::floor(value))
            return;
        const auto input = unsigned(value);
        if (marked_.contains(input) || (command == 2 && (input == 0 || !marked_.contains(input - 1))))
            return;
        marked_.insert(input);
    } else if (command != 3)
        return;
    if (--remaining_ == 0)
        pending_ = true;
}

bool PropChecklist::take_trigger() {
    if (!pending_ || fired_)
        return false;
    pending_ = false;
    fired_ = true;
    return true;
}

FragileProp::FragileProp(double strength, double lifetime) : strength_(strength), lifetime_(lifetime) {
    if (!std::isfinite(strength) || strength < 0 || strength > 1e9 || !std::isfinite(lifetime) ||
        std::abs(lifetime) > 1e6)
        throw std::invalid_argument("Invalid fragile property law");
}

void FragileProp::step(double seconds) {
    if (!std::isfinite(seconds) || seconds < 0 || seconds > 1)
        throw std::invalid_argument("Invalid fragile tick");
    age_ += seconds;
    cooldown_ = std::max(0., cooldown_ - seconds);
    expired_ = lifetime_ > 0 && age_ >= lifetime_ - 1e-9;
}

bool FragileProp::hit(double force) {
    if (!std::isfinite(force) || force < 0 || force > 1e9)
        throw std::invalid_argument("Invalid fragile contact force");
    if (expired_ || fired_ || pending_ || cooldown_ > 1e-9 || force == 0)
        return false;
    strength_ -= force;
    cooldown_ = .5;
    if (strength_ <= 0)
        pending_ = true;
    return true;
}

bool FragileProp::take_trigger() {
    if (!pending_ || fired_)
        return false;
    pending_ = false;
    fired_ = true;
    return true;
}

double fragile_contact_cost(double speed, Vec3 normal, bool supported) {
    if (!std::isfinite(speed) || speed < 0 || !finite(normal))
        throw std::invalid_argument("Invalid fragile contact");
    return speed >= 8 || (!supported && std::abs(normal.y) < .55 && speed > 1e-6) ? 87 : 1;
}
} // namespace openslope
