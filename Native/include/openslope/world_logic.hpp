#pragma once
#include "boost.hpp"
#include "collision.hpp"
#include "course_run.hpp"
#include "crowd.hpp"
#include "particles.hpp"
#include "spline_motion.hpp"
#include "world_properties.hpp"
#include <memory>
#include <span>

namespace openslope {
enum class WorldActionKind {
    Reset,
    Multiplier,
    CourseSound,
    MainSound,
    RailToggle,
    SpeedBoost,
    TrickBoost,
    Teleport,
    BoostSound
};
class CollisionWorld;

struct WorldAction {
    WorldActionKind kind;
    double value = 0;
    std::size_t target = 0;
    Vec3 position;
    bool rider = false;
};

// Runtime flags are separate from immutable authored properties and geometry.
enum WorldInstanceFlag : std::uint8_t { WorldDraw = 1, WorldCollide = 2, WorldFragile = 4, WorldDynamic = 8 };

class WorldLogic {
public:
    WorldLogic();
    ~WorldLogic();
    WorldLogic(WorldLogic&&) noexcept;
    WorldLogic& operator=(WorldLogic&&) noexcept;
    static WorldLogic load(const std::filesystem::path& root);
    void restart(RunMode mode, bool preserve_collected_pads = false);
    void tick(double seconds, double speed = 0, std::span<const Vec3> observers = {},
              std::span<const CrowdActivity> riders = {}, bool force_crowd = false);
    void apply_forces(double seconds, const CollisionWorld& world, std::span<BoostRider> riders,
                      const LapEntry& lap_entry = {});
    std::size_t forces() const;
    std::span<const std::size_t> faceted_models() const;
    std::span<const std::size_t> reset_volumes() const;
    std::optional<std::pair<Vec3, Vec3>> teleport_destination(std::size_t instance, unsigned rider_slot = 0) const;
    void contact(std::size_t instance, double speed, bool human = true, double force = 1, Vec3 direction = {},
                 std::optional<ParticleContact> particle_contact = {});
    std::vector<ParticleSprite> particles(double alpha, Vec3 eye) const;
    std::size_t emitters() const;
    void prepare_bodies(const CollisionWorld& world);
    void step_bodies(double seconds, const Terrain& terrain, const CollisionWorld& world);
    std::optional<CollisionResponse> shove(const WorldContact& contact, Vec3 velocity, Vec3 up);
    std::size_t bodies() const;
    std::size_t sleeping_bodies() const;
    std::span<const std::uint8_t> flags() const;
    std::vector<WorldAction> take_actions();
    std::span<const PropMotion> motions() const;
    std::span<const PropRouteMotion> route_motions() const;
    std::span<const PropTextureFrame> texture_frames() const;
    std::span<const std::size_t> flag_models() const;
    bool has_fragile_surfaces() const;
    std::size_t active_regions() const;
    std::size_t chains() const;
    std::size_t unsupported() const;

private:
    struct Data;
    std::unique_ptr<Data> data_;
};
} // namespace openslope
