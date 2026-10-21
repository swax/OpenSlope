#pragma once
#include "terrain.hpp"

namespace openslope {
struct PointLight {
    Vec3 position, colour;
    double radius = 16, intensity = 1;
};

struct LampGlint {
    Vec3 position, hue;
    unsigned size = 0;
    double brightness = 1;
};

struct LampView {
    std::array<float, 16> bloom_clip{};
    Vec3 anchor{};
};

LampView stereo_lamp_view(const std::array<float, 16>& left, const std::array<float, 16>& right, Vec3 left_eye,
                          Vec3 right_eye);

std::vector<LampGlint> load_lamp_glints(const std::filesystem::path& root,
                                        std::vector<PointLight>* illumination = nullptr);
std::vector<Vertex> lamp_glint_mesh(std::span<const LampGlint> lights, const std::array<float, 16>& clip, Vec3 eye,
                                    unsigned width, unsigned height, double range = 600,
                                    const LampView* shared = nullptr);

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
