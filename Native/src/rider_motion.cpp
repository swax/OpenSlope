#include "openslope/rider_motion.hpp"
#include <stdexcept>

namespace openslope {
namespace {
Vec3 limited(Vec3 v, double maximum) {
    const auto d = length(v);
    return d > maximum ? v * (maximum / d) : v;
}
} // namespace

void RiderMotion::reset() { *this = RiderMotion{}; }

double RiderMotion::random_unit() {
    // A local, repeatable stream; rendering never consumes gameplay randomness.
    random_ = random_ * 1664525u + 1013904223u;
    return (double(random_) + .5) / 4294967296.;
}

void RiderMotion::step(const RiderMotionInput& input, double dt) {
    if (!std::isfinite(dt) || dt <= 0 || dt > .1 || !finite(input.position) || !finite(input.velocity) ||
        !finite(input.up) || !std::isfinite(input.lean) || !std::isfinite(input.crouch) ||
        !std::isfinite(input.speed) || !std::isfinite(input.launch_charge))
        throw std::invalid_argument("Invalid rider presentation sample");
    if (!ready_ || input.placement != last_.placement || input.on_foot != last_.on_foot) {
        reset();
        ready_ = true;
        last_ = input;
        current_.lean = std::clamp(input.lean, -1., 1.);
        current_.crouch = std::clamp(input.crouch, 0., 1.);
        previous_ = current_;
        return;
    }
    previous_ = current_;
    const auto ease = [dt](double tau) { return -std::expm1(-dt / tau); };
    const auto acceleration = limited((input.velocity - last_.velocity) / dt, 300.);
    current_.acceleration += (acceleration - current_.acceleration) * ease(.25);
    current_.hands += (limited(-current_.acceleration * .0045, .096) - current_.hands) * ease(.20);
    current_.lean += (std::clamp(input.lean, -1., 1.) - current_.lean) * (1 - std::exp2(-dt / .14));
    current_.crouch += (std::clamp(input.crouch, 0., 1.) - current_.crouch) * ease(.065);
    current_.walking +=
        ((input.on_foot && input.grounded ? std::min(1., input.speed / 2) : 0.) - current_.walking) * ease(.10);
    if (!input.grounded)
        current_.hip_lag = 0;
    else {
        const auto displacement = last_.grounded ? dot(input.position - last_.position, normalized(input.up)) : 0.;
        // An exponential absorber, with a finite landing impulse and no horizontal lag.
        current_.hip_lag = std::clamp((current_.hip_lag - displacement) * std::exp(-dt / .20), -.12, .12);
        if (!last_.grounded || input.landings != last_.landings) {
            const auto closing = std::max(0., -dot(last_.velocity - input.velocity, normalized(input.up)));
            current_.hip_lag = std::max(-.12, current_.hip_lag - closing * .015);
        }
    }
    if (input.launches != last_.launches) {
        pop_age_ = 0;
        pop_charge_ = std::clamp(input.launch_charge, 0., 1.);
    } else
        pop_age_ += dt;
    current_.pop = pop_charge_ * std::max(0., 1 - pop_age_ / .28);
    if (input.calm) {
        if (glance_hold_ > 0)
            glance_hold_ -= dt;
        else {
            glance_target_ = 0;
            glance_wait_ -= dt;
            if (glance_wait_ <= 0) {
                glance_target_ = (random_unit() < .5 ? -1 : 1) * (15 + random_unit() * 50) * pi / 180;
                glance_hold_ = .35 + random_unit() * 1.05;
                glance_wait_ = std::min(20., -6 * std::log(random_unit()));
            }
        }
    } else {
        glance_target_ = 0;
        glance_hold_ = 0;
    }
    current_.glance += (glance_target_ - current_.glance) * ease(input.calm ? .25 : .125);
    last_ = input;
}

RiderMotionSample RiderMotion::sample(double alpha) const {
    const auto t = std::clamp(alpha, 0., 1.);
    return {previous_.acceleration + (current_.acceleration - previous_.acceleration) * t,
            previous_.hands + (current_.hands - previous_.hands) * t,
            previous_.lean + (current_.lean - previous_.lean) * t,
            previous_.crouch + (current_.crouch - previous_.crouch) * t,
            previous_.hip_lag + (current_.hip_lag - previous_.hip_lag) * t,
            previous_.pop + (current_.pop - previous_.pop) * t,
            previous_.glance + (current_.glance - previous_.glance) * t,
            previous_.walking + (current_.walking - previous_.walking) * t};
}
} // namespace openslope
