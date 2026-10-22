#pragma once
#include "appearance.hpp"
#include "player.hpp"
#include "scene_lighting.hpp"
#include <memory>
#include <span>
#include <string_view>

namespace openslope {
enum class AvatarJoint : unsigned {
    Hips,
    Spine,
    Chest,
    Neck,
    Head,
    LeftShoulder,
    LeftElbow,
    LeftWrist,
    RightShoulder,
    RightElbow,
    RightWrist,
    LeftHip,
    LeftKnee,
    LeftAnkle,
    LeftToe,
    RightHip,
    RightKnee,
    RightAnkle,
    RightToe,
    Count
};
inline constexpr unsigned avatar_joint_count = unsigned(AvatarJoint::Count);

struct ControllerPose {
    Vec3 position{}, right{1, 0, 0}, up{0, 1, 0}, forward{0, 0, -1};
    bool valid = false, touch = true;
    std::array<double, 3> fingers{};
};

// Model axes differ from the unmodified OpenXR grip frame.
ControllerPose controller_draw_pose(const ControllerPose& grip);

struct AvatarTracking {
    Vec3 head{}, forward{0, 0, -1}, up{0, 1, 0};
    std::array<Vec3, avatar_joint_count> joints{};
    std::array<bool, avatar_joint_count> valid{};
    std::array<ControllerPose, 2> controllers{};
    bool body_active = false, full_body = false;
    float confidence = 0;
    bool seated = false;
    // Restore the physical floor for tracked feet after normalizing eye height.
    double floor_offset = 0;
};

struct AvatarPose {
    std::array<Vec3, avatar_joint_count> joints{};
    std::array<ControllerPose, 2> controllers{};
    Vec3 forward{0, 0, -1}, up{0, 1, 0};
    Vec3 head_forward{0, 0, -1}, head_up{0, 1, 0};
    bool tracked_body = false, tracked_legs = false, on_foot = false, controller_models = true;
    std::array<std::string, 3> run_text{};
    std::array<std::string, 4> score_text{};
    int score_result = 0;

    Vec3 joint(AvatarJoint j) const { return joints[unsigned(j)]; }

    Vec3 eye() const { return joint(AvatarJoint::Head) + head_up * .105 + head_forward * .11; }
};

struct AvatarLook {
    Vec3 forward{0, 0, -1}, up{0, 1, 0};
};

AvatarPose avatar_pose(const Player& player, const AvatarTracking* tracking = nullptr,
                       const AvatarLook* look = nullptr);

struct AvatarOption {
    std::string id, label;
    std::filesystem::path file;
};

std::span<const AvatarOption> builtin_avatars();

// Slopesmith character-contract skins, posed independently of collision/physics state.
class Avatar {
public:
    Avatar();
    explicit Avatar(std::span<const unsigned char> glb);
    static Avatar builtin(std::string_view id);

    std::shared_ptr<const RgbaImage> texture() const { return texture_; }

    std::span<const Vertex> mesh(const AvatarPose& pose, bool first_person = false, bool labels = true, Vec3 eye = {},
                                 Vec3 controller_offset = {}, const SceneLighting* lighting = nullptr,
                                 bool runtime_lighting = false);

    std::size_t source_vertices() const { return vertices_.size(); }

    std::size_t source_triangles() const { return corners_.size() / 3; }

    std::span<const Vertex> shadow_mesh() const { return shadow_; }

private:
    struct Bone {
        std::string name;
        Vec3 head, tail;
        unsigned parent{};
        std::array<Vec3, 3> axes{};
    };

    struct SkinVertex {
        Vec3 position, normal;
        std::array<unsigned, 4> bones{};
        std::array<double, 4> weights{};
    };

    struct Corner {
        unsigned vertex{};
        std::array<float, 3> colour{};
        std::array<float, 4> uv{};
        std::array<float, 3> emissive{};
        bool textured = false;
    };

    std::vector<Bone> bones_;
    std::vector<SkinVertex> vertices_;
    std::vector<Corner> corners_;
    std::vector<Vertex> mesh_, shadow_;
    std::shared_ptr<const RgbaImage> texture_;
};
} // namespace openslope
