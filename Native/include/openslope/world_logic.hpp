#pragma once
#include "course_run.hpp"
#include "spline_motion.hpp"
#include "world_properties.hpp"
#include "crowd.hpp"
#include <memory>
#include <span>

namespace openslope {
enum class WorldActionKind {Reset,Multiplier,CourseSound,MainSound,RailToggle};
struct WorldAction {WorldActionKind kind;double value=0;std::size_t target=0;Vec3 position;bool rider=false;};
// Runtime flags are separate from immutable authored properties and geometry.
enum WorldInstanceFlag : std::uint8_t {WorldDraw=1,WorldCollide=2,WorldFragile=4};
class WorldLogic {
public:
    WorldLogic();~WorldLogic();WorldLogic(WorldLogic&&) noexcept;WorldLogic& operator=(WorldLogic&&) noexcept;
    static WorldLogic load(const std::filesystem::path& root);
    void restart(RunMode mode);
    void tick(double seconds,double speed=0,std::span<const Vec3> observers={},std::span<const CrowdActivity> riders={},bool force_crowd=false);
    void contact(std::size_t instance,double speed,bool human=true,double force=1);
    std::span<const std::uint8_t> flags() const;
    std::vector<WorldAction> take_actions();
    std::span<const PropMotion> motions() const;
    std::span<const PropRouteMotion> route_motions() const;
    std::span<const PropTextureFrame> texture_frames() const;
    bool has_fragile_surfaces() const;
    std::size_t active_regions() const;
    std::size_t chains() const;
    std::size_t unsupported() const;
private:
    struct Data;std::unique_ptr<Data> data_;
};
}
