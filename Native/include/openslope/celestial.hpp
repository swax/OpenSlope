#pragma once
#include "terrain.hpp"

namespace openslope {
struct Glare {
    bool enabled = false;
    std::array<float, 3> core{1, 184.f / 255, 92.f / 255}, rim{112.f / 255, 72.f / 255, 38.f / 255};
    double fan_intensity = .37, sprite_intensity = .45;
    double azimuth = 32, elevation = 8, distance = 24000, radius = 7200;
    Vec3 direction() const;
};

struct CelestialView {
    std::array<float, 16> clip{};
    Vec3 anchor{};
    double visibility = 1, far_distance = 10000;
    bool stereo = false;
};

struct CelestialMesh {
    std::vector<Vertex> fan, corona;
};

// Vertices retain homogeneous W so the stereo disc interpolates correctly.
CelestialMesh celestial_mesh(const Glare& glare, const CelestialView& view);

class GlareVisibility {
public:
    void reset();
    double step(const Terrain& terrain, const Glare& glare, Vec3 eye, double seconds);

private:
    double value_ = 0, target_ = 0, until_sample_ = 0;
    bool initialized_ = false;
};
} // namespace openslope
