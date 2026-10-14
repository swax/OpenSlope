#pragma once
#include "props.hpp"
#include <memory>

namespace openslope {
struct ProbeSphere {Vec3 centre;double radius{};};
struct ShapeContact {Vec3 point,normal;double t{},depth{};};
struct WorldContact:ShapeContact {std::size_t instance{};int surface=-1,effect=-1;double bounce{},mass{};bool response=false;};
std::optional<ShapeContact> swept_box(const Bounds& box,const Transform& world,ProbeSphere start,ProbeSphere end);
std::optional<ShapeContact> swept_triangle(Vec3 a,Vec3 b,Vec3 c,ProbeSphere start,ProbeSphere end);
std::vector<std::uint8_t> occupancy_masks(std::span<const std::uint8_t> encoded,unsigned encoding,unsigned depth);
struct CollisionResponse {Vec3 position_delta,velocity;double impulse{};bool hard=false;};
CollisionResponse collision_response(const WorldContact& contact,Vec3 velocity,Vec3 board_up);

class CollisionWorld {
public:
    CollisionWorld();~CollisionWorld();CollisionWorld(CollisionWorld&&) noexcept;CollisionWorld& operator=(CollisionWorld&&) noexcept;
    static CollisionWorld load(const std::filesystem::path& root);
    std::vector<WorldContact> sweep(std::span<const ProbeSphere> start,std::span<const ProbeSphere> end) const;
    std::optional<WorldContact> ray(Vec3 start,Vec3 end,bool rideable_only=false) const;
    std::size_t objects() const;
    std::size_t triangles() const;
    std::size_t bodies() const;
private:
    struct Data;std::unique_ptr<Data> data_;
};
std::vector<std::string> collision_files(const std::filesystem::path& root);
}
