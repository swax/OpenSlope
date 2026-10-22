#pragma once
#include "terrain.hpp"
#include <array>
#include <span>

namespace openslope {
// [Trailmap: 160-instance, 160-instance-frame, 400-lighting] A spatial
// approximation for dynamic bodies, using the course's authored lighting.
struct SceneLight {
    struct Key {
        Vec3 direction, colour;
    };

    Vec3 ambient{};
    std::array<Key, 12> keys{};
    Vec3 evaluate(Vec3 normal) const;
    static SceneLight fallback();
};

struct LightProbe {
    Vec3 position, ambient;
    std::array<SceneLight::Key, 3> keys{};
};

class SceneLighting {
public:
    SceneLighting() = default;
    explicit SceneLighting(std::vector<LightProbe> probes);
    static SceneLighting load(const std::filesystem::path& root);
    SceneLight sample(Vec3 position) const;

    std::size_t size() const { return probes_.size(); }

private:
    std::vector<LightProbe> probes_;
    void build(std::size_t begin, std::size_t end, unsigned axis);
};
} // namespace openslope
