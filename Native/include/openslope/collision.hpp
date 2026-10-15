#pragma once
#include "props.hpp"
#include <memory>

namespace openslope {
struct PropMotion;

struct PropBodyShape {
    Transform placement = identity_transform();
    Vec3 centre;
    std::array<double, 9> inverse_inertia{};
    std::vector<ProbeSphere> probes;
};

struct ShapeContact {
    Vec3 point, normal;
    double t{}, depth{};
};

struct WorldContact : ShapeContact {
    std::size_t instance{};
    int surface = -1, effect = -1;
    double bounce{}, mass{};
    bool response = false;
    std::size_t object = 0;
    Vec3 surface_velocity;
};

std::optional<ShapeContact> swept_box(const Bounds& box, const Transform& world, ProbeSphere start, ProbeSphere end);
std::optional<ShapeContact> swept_triangle(Vec3 a, Vec3 b, Vec3 c, ProbeSphere start, ProbeSphere end);
std::vector<std::uint8_t> occupancy_masks(std::span<const std::uint8_t> encoded, unsigned encoding, unsigned depth);

struct WorldVolume {
    Bounds box;
    Vec3 axis{1, 0, 0};
};

struct CollisionResponse {
    Vec3 position_delta, velocity;
    double impulse{};
    bool hard = false;
};

CollisionResponse collision_response(const WorldContact& contact, Vec3 velocity, Vec3 board_up);

class CollisionWorld {
public:
    CollisionWorld();
    ~CollisionWorld();
    CollisionWorld(CollisionWorld&&) noexcept;
    CollisionWorld& operator=(CollisionWorld&&) noexcept;
    static CollisionWorld load(const std::filesystem::path& root);
    std::vector<WorldContact> sweep(std::span<const ProbeSphere> start, std::span<const ProbeSphere> end,
                                    double trigger_margin = 0) const;
    std::vector<WorldContact> sweep_body(std::span<const ProbeSphere> start, std::span<const ProbeSphere> end,
                                         std::size_t exclude) const;
    std::optional<PropBodyShape> body_shape(std::size_t instance) const;
    std::optional<WorldContact> ray(Vec3 start, Vec3 end, bool rideable_only = false) const;
    std::optional<WorldVolume> volume(std::size_t instance, Vec3 start, Vec3 end, double radius = 0) const;
    std::size_t objects() const;
    std::size_t triangles() const;
    std::size_t bodies() const;
    void instance_flags(std::span<const std::uint8_t> flags);
    void motion(std::span<const PropMotion> poses, double seconds);
    Vec3 carry(std::size_t object, Vec3 point) const;

private:
    struct Data;
    std::unique_ptr<Data> data_;
};

std::vector<std::string> collision_files(const std::filesystem::path& root);
} // namespace openslope
