#pragma once
#include "props.hpp"
#include <cstdint>

namespace openslope {
struct MeshThrowLaw {
    double step = .05, duration = 2, multiplier = 1;
    Vec3 direction, speed, gravity{0, -9.81, 0};
};

// Independently authored presentation of the clean Trailmap 230/370 throw contract.
// Piece spread, tumble and gravity are application tuning, not recovered trajectories.
class MeshThrow {
public:
    MeshThrow(MeshThrowLaw law, std::span<const Vec3> centres, Vec3 contact_direction, std::uint32_t seed);
    void step(double seconds);
    std::vector<Transform> pose() const;

    bool expired() const { return age_ >= law_.duration; }

private:
    struct Piece {
        Vec3 centre, velocity, axis;
        double spin;
    };

    MeshThrowLaw law_;
    std::vector<Piece> pieces_;
    double age_ = 0;
};
} // namespace openslope
