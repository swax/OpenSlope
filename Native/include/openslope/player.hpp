#pragma once
#include "ride.hpp"
#include "terrain.hpp"
#include "collision.hpp"
#include <deque>
#include <map>
#include <functional>

namespace openslope {
struct RideInput { double steer{}; bool boost{},reset{},jump{}; double posture{}; }; // Left steer; positive posture is tuck/forward flip.
enum class Motion {Air=1,Ground=2,Wipeout=5};
enum class Control {Cruise=3,Release=10,Air=13,Charge=14,Launched=16,Wipeout=19};
struct PlayTuning {
    // Desktop application defaults where the clean specification is open.
    double charge_rate=2.5,brake_acceleration=18,flip_recovery_rate=720;
    unsigned jump_stat=255;
    double body_radius=.85;
};
struct Rider {
    Vec3 position,previous_position,velocity,forward{0,0,-1},normal{0,1,0},smoothed_up{0,1,0},board_up{0,1,0};
    double lean{},slide{},bog{},budget{},lift{},speed_cap{},contact_error{};
    double charge{},release_remaining{},release_snapshot{},flip_degrees{},spin_degrees{},air_time{},crouch{},landing_scale=1;
    int lead=1;unsigned launches{},landings{};Motion motion=Motion::Air;Control control=Control::Air;
    int surface=1;
    bool grounded=false;
    unsigned world_contacts{},bounces{},hard_impacts{};
    std::optional<std::size_t> ground_instance;
};
enum class ContactPhase {Begin,Stay,End};
struct ContactEvent {WorldContact contact;ContactPhase phase=ContactPhase::Begin;CollisionResponse response;};

// Portable riding shared by desktop and OpenXR. The parity matrix records
// remaining rail, race, presentation and authored world-logic work.
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
    const CollisionWorld& world() const {return world_;}
    const std::vector<ContactEvent>& contacts() const {return contact_events_;}
    Vec3 camera_position(Vec3 desired) const;
    void observe_ticks(std::function<void(const Player&,const Rider&)> observer){tick_observer_=std::move(observer);}
    std::uint64_t placement_serial() const {return placement_serial_;}
private:
    Terrain terrain_;
    CollisionWorld world_;
    RideContract contract_;
    FixedClock clock_;
    Rider rider_;
    PlayTuning tuning_;
    Vec3 spawn_position_,spawn_forward_;
    Vec3 flight_heading_{0,0,-1};
    bool jump_held_=false,reset_held_=false;
    double jump_cooldown_=0,air_grace_=0;
    std::deque<bool> jump_edges_;
    struct GroundContact {Vec3 point,normal;double t;int surface;std::optional<std::size_t> instance;};
    std::map<std::size_t,WorldContact> previous_contacts_;
    std::vector<ContactEvent> contact_events_;
    std::function<void(const Player&,const Rider&)> tick_observer_;
    std::uint64_t placement_serial_=0;
    std::optional<GroundContact> trace_ground(Vec3 start,Vec3 end) const;
    std::optional<GroundContact> probe(Vec3 position) const;
    std::vector<ProbeSphere> volume(const Rider& pose,bool airborne) const;
    bool move_world(const Rider& before,Vec3 destination,bool landing_allowed);
    void sample_input(const RideInput& input);
    void land(const GroundContact& hit);
    void enter_air();
};
}
