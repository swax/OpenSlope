#pragma once
#include "course_run.hpp"
#include "model_animation.hpp"
#include <memory>
#include <span>

namespace openslope {
enum class WorldActionKind {Reset,Multiplier,CourseSound,MainSound,RailToggle};
struct WorldAction {WorldActionKind kind;double value=0;std::size_t target=0;Vec3 position;bool rider=false;};
// Runtime flags are separate from immutable authored properties and geometry.
enum WorldInstanceFlag : std::uint8_t {WorldDraw=1,WorldCollide=2};
class WorldLogic {
public:
    WorldLogic();~WorldLogic();WorldLogic(WorldLogic&&) noexcept;WorldLogic& operator=(WorldLogic&&) noexcept;
    static WorldLogic load(const std::filesystem::path& root);
    void restart(RunMode mode);
    void tick(double seconds,double speed=0,std::span<const Vec3> observers={});
    void contact(std::size_t instance,double speed,bool human=true);
    std::span<const std::uint8_t> flags() const;
    std::vector<WorldAction> take_actions();
    std::span<const PropMotion> motions() const;
    std::size_t active_regions() const;
    std::size_t chains() const;
    std::size_t unsupported() const;
private:
    struct Data;std::unique_ptr<Data> data_;
};
}
