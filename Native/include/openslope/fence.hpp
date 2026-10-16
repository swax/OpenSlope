#pragma once
#include "terrain.hpp"

namespace openslope {
// [Trailmap: 230 subtype 12] Collision reaction with a finite settling lifetime.
// The whole-target rattle is the first-party play profile, not recovered cloth.
class FencePlayback {
public:
    FencePlayback(double flex, Vec3 impact);
    void step(double seconds);
    Vec3 offset() const;

    bool settled() const { return age_ >= lifetime; }

    static constexpr double lifetime = 1.6;

private:
    Vec3 direction_;
    double amplitude_ = 0, age_ = 0;
};
} // namespace openslope
