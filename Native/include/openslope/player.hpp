#pragma once
#include "ride.hpp"
#include "terrain.hpp"
#include <deque>

namespace openslope {
struct RideInput { double steer{}; bool boost{},reset{},jump{}; double posture{}; }; // Left steer; positive posture is tuck/forward flip.
enum class Motion {Air=1,Ground=2};
enum class Control {Cruise=3,Release=10,Air=13,Charge=14,Launched=16};
struct PlayTuning {
    // Desktop application defaults where the clean specification is open.
    double charge_rate=2.5,brake_acceleration=18,flip_recovery_rate=720;
    unsigned jump_stat=255;
};
struct Rider {
    Vec3 position,previous_position,velocity,forward{0,0,-1},normal{0,1,0},smoothed_up{0,1,0},board_up{0,1,0};
    double lean{},slide{},bog{},budget{},lift{},speed_cap{},contact_error{};
    double charge{},release_remaining{},release_snapshot{},flip_degrees{},spin_degrees{},air_time{},crouch{},landing_scale=1;
    int lead=1;unsigned launches{},landings{};Motion motion=Motion::Air;Control control=Control::Air;
    int surface=1;
    bool grounded=false;
};

// Portable desktop riding. Rails, world interaction and race logic are separate
// milestones; the parity matrix records the remaining scope.
class Player {
public:
    explicit Player(Terrain terrain,PlayTuning tuning={});
    void reset();
    void tick(const RideInput& input);
    void advance(double seconds,const RideInput& input);
    Vec3 render_position() const;
    Vec3 render_forward() const;
    Vec3 render_up() const;
    Vec3 camera_forward() const;
    void warp(Vec3 position,Vec3 forward,Vec3 velocity={},Vec3 up={0,1,0});
    void release_inputs();
    const Rider& rider() const { return rider_; }
    const Terrain& terrain() const { return terrain_; }
    const RideContract& contract() const { return contract_; }
private:
    Terrain terrain_;
    RideContract contract_;
    FixedClock clock_;
    Rider rider_;
    PlayTuning tuning_;
    Vec3 spawn_position_,spawn_forward_;
    Vec3 flight_heading_{0,0,-1};
    bool jump_held_=false,reset_held_=false;
    double jump_cooldown_=0,air_grace_=0;
    std::deque<bool> jump_edges_;
    std::optional<TerrainHit> probe(Vec3 position) const;
    void sample_input(const RideInput& input);
    void land(const TerrainHit& hit);
    void enter_air();
};
}
