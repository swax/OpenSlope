#pragma once
#include "player.hpp"
#include "scene_lighting.hpp"
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

// Bundled first-party rigid skin, posed independently of collision/physics state.
class Avatar {
public:
    Avatar();
    std::span<const Vertex> mesh(const AvatarPose& pose, bool first_person = false, bool labels = true, Vec3 eye = {},
                                 Vec3 controller_offset = {}, const SceneLighting* lighting = nullptr);

    std::size_t source_vertices() const { return vertices_.size(); }

    std::size_t source_triangles() const { return corners_.size() / 3; }

private:
    struct Bone {
        std::string name;
        Vec3 head, tail;
        unsigned parent{};
        std::array<Vec3, 3> axes{};
    };

    struct SkinVertex {
        Vec3 position, normal;
        unsigned bone{};
    };

    struct Corner {
        unsigned vertex{};
        std::array<float, 3> colour{};
    };

    std::vector<Bone> bones_;
    std::vector<SkinVertex> vertices_;
    std::vector<Corner> corners_;
    std::vector<Vertex> mesh_;
};
} // namespace openslope
