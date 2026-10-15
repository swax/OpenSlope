#pragma once
#include "boost_trail.hpp"
#include "ride.hpp"
#include "terrain.hpp"
#include "collision.hpp"
#include "riding_effects.hpp"
#include "animation.hpp"
#include "rails.hpp"
#include "course_run.hpp"
#include "score.hpp"
#include "vr_controls.hpp"
#include "course_recovery.hpp"
#include "world_logic.hpp"
#include <deque>
#include <map>
#include <set>
#include <stdexcept>
#include <functional>

namespace openslope {
struct RideInput { double steer{}; bool boost{},reset{},jump{}; double posture{}; bool rail_exit=false,mount=false;Vec3 walk_forward{},room_offset{};bool run_restart=false;VrInput vr{};bool spawn_board=false; }; // Left steer; positive posture is tuck/forward flip.
enum class Motion {Air=1,Ground=2,Rail=3,Wipeout=5,RecoverContact=6,OnFoot=100};
enum class Control {Cruise=3,Release=10,Air=13,Charge=14,OnRail=15,Launched=16,Wipeout=19,RecoverWait=20,ResetWarp=22,OnFoot=100};
enum class CrashCause {None,PropImpact,Landing,Unrideable};
struct PlayTuning {
    // Desktop application defaults where the clean specification is open.
    double charge_rate=2.5,brake_acceleration=18,flip_recovery_rate=720;
    unsigned jump_stat=255;bool symmetric_deck=true;unsigned rider_slot=0;
    double body_radius=.85;
    double hard_landing_speed=28,unrideable_speed=5;
    double tumble_ground_drag=8,tumble_air_drag=1.2,settle_angular_speed=.9,settle_normal_speed=1.5,settle_hold=.2;
};
struct Rider {
    Vec3 position,previous_position,velocity,forward{0,0,-1},normal{0,1,0},smoothed_up{0,1,0},board_up{0,1,0};
    double lean{},slide{},bog{},budget{},lift{},speed_cap{},contact_error{};
    double charge{},release_remaining{},release_snapshot{},flip_degrees{},spin_degrees{},air_time{},crouch{},landing_scale=1;
    double view_yaw=0;PadBoost pads{};unsigned tube_stage=0;int boost_end=1;
    int lead=1;unsigned launches{},landings{};Motion motion=Motion::Air;Control control=Control::Air;
    int surface=1;
    bool grounded=false;
    unsigned world_contacts{},bounces{},hard_impacts{};
    unsigned crashes{},recoveries{};CrashCause crash_cause=CrashCause::None;
    double crash_age{},crash_contact_age{},recovery_standing{},recovery_height{};
    std::optional<std::size_t> rail_spline;
    std::size_t rail_segment{};double rail_parameter{},rail_age{},rail_spin{},rail_spin_rate{};
    int rail_direction=1,rail_trick=-1;unsigned grinds{},rail_transfers{},rail_exits{};
    std::optional<std::size_t> ground_instance,ground_object;Vec3 ground_velocity;
};
enum class ContactPhase {Begin,Stay,End};
struct ContactEvent {WorldContact contact;ContactPhase phase=ContactPhase::Begin;CollisionResponse response;};

// Portable riding shared by desktop and OpenXR. The parity matrix records
// remaining rail, race, presentation and authored world-logic work.
class Player {
public:
    explicit Player(Terrain terrain,PlayTuning tuning={});
    void reset(bool manual=false);
    bool recover_course(bool manual=false);
    bool reset_pending() const {return recovery_target_.has_value();}
    float reset_fade() const {return float(recovery_target_?std::clamp(reset_age_/.5,0.,1.):std::clamp(reset_fade_in_/.2,0.,1.));}
    const std::optional<RecoveryPose>& last_course_recovery() const {return last_recovery_;}
    void tick(const RideInput& input);
    void advance(double seconds,const RideInput& input);
    Vec3 render_position() const;
    Vec3 render_board_position() const;
    Vec3 render_forward() const;
    Vec3 render_up() const;
    Vec3 camera_forward() const;
    void warp(Vec3 position,Vec3 forward,Vec3 velocity={},Vec3 up={0,1,0});
    void release_inputs();
    const Rider& rider() const { return rider_; }
    const Terrain& terrain() const { return terrain_; }
    const RideContract& contract() const { return contract_; }
    const RidingEffects& effects() const {return effects_;}
    const CollisionWorld& world() const {return world_;}
    const std::vector<ContactEvent>& contacts() const {return contact_events_;}
    double frame_alpha() const {return clock_.alpha();}
    void world_view(Vec3 position){if(!finite(position))throw std::invalid_argument("Invalid world view");world_view_=position;}
    const WorldLogic& logic() const {return logic_;}
    const std::vector<WorldAction>& world_actions() const {return world_actions_;}
    Vec3 camera_position(Vec3 desired) const;
    void observe_ticks(std::function<void(const Player&,const Rider&)> observer){tick_observer_=std::move(observer);}
    std::uint64_t placement_serial() const {return placement_serial_;}
    std::uint64_t audio_reset_serial() const {return placement_serial_-transport_placements_;}
    std::uint64_t teleports() const {return teleports_;}
    const BoostTrail& boost_trail() const {return boost_trail_;}
    BoostTrailMesh boost_trail_mesh() const {return boost_trail_.draw({render_board_position(),render_forward(),render_up()});}
    bool recovering() const {return rider_.control==Control::Wipeout||rider_.control==Control::RecoverWait;}
    void run_active(bool active){run_active_=active;}
    bool run_active() const {return run_active_||(run_.status().mode!=RunMode::Freeride&&run_.status().phase==RunPhase::Running);}
    void configure_run(RunMode mode);
    void restart_run();
    const CourseRun& course_run() const {return run_;}
    TrickScore& scoring(){return score_;}
    const TrickScore& scoring() const {return score_;}
    void start_on_foot();
    bool on_foot() const {return on_foot_;}
    bool interact_board(Vec3 room_offset={});
    bool recall_board(Vec3 facing={});
    double board_distance(Vec3 room_offset={}) const;
    double walk_phase() const {return walk_phase_;}
    bool board_coasting() const {return on_foot_&&length(loose_board_.velocity)>.02;}
    Rails& rails(){return rails_;}
    const Rails& rails() const {return rails_;}
private:
    Terrain terrain_;
    CollisionWorld world_;
    Rails rails_;
    CourseRun run_;
    WorldLogic logic_;
    std::optional<Vec3> world_view_;
    std::vector<WorldAction> world_actions_;
    void apply_world_actions();
    std::optional<std::pair<Vec3,Vec3>> teleport_pending_;
    void teleport(Vec3 position,Vec3 forward);
    std::set<std::size_t> logic_contacts_;
    void dispatch_world_contact(const WorldContact& contact,double speed,std::optional<Vec3> support_normal={});
    struct GroundContact;
    bool dispatch_fragile_ground(const GroundContact& contact);
    bool request_course_recovery(bool manual,bool authored);
    CourseRecovery course_recovery_;
    std::optional<RecoveryPose> last_recovery_;
    struct RecoveryPlacement {RecoveryPose target;Vec3 point,normal;bool foot=false;};
    std::optional<RecoveryPlacement> recovery_target_;
    double reset_age_=0,reset_fade_in_=0;
    Vec3 reset_camera_forward_{0,0,-1};
    void finish_course_recovery();
    TrickScore score_;
    bool score_started_=false;
    double held_boost_=0;bool boost_engaged_=false;
    RideContract contract_;
    FixedClock clock_;
    Rider rider_;
    RidingEffects effects_;
    BoostTrail boost_trail_;std::uint64_t game_frame_=0;
    PoseAnimation get_up_;
    PlayTuning tuning_;
    Vec3 spawn_position_,spawn_forward_;
    Vec3 flight_heading_{0,0,-1};
    Vec3 recovery_forward_{0,0,-1},recovery_camera_{0,0,-1},tumble_velocity_{},get_up_forward_{0,0,-1},get_up_up_{0,1,0};
    double settled_=0;
    bool run_active_=false;
    bool jump_held_=false,reset_held_=false;
    bool restart_held_=false,restart_pending_=false,spawn_held_=false,spawn_pending_=false;
    double jump_cooldown_=0,air_grace_=0,rail_cooldown_=0;
    std::deque<bool> jump_edges_;
    struct GroundContact {Vec3 point,normal;double t;int surface;std::optional<std::size_t> instance{},object{};Vec3 velocity{};};
    struct LooseBoard {Vec3 position,previous,velocity,forward{0,0,-1},up{0,1,0};bool grounded=true;int lead=1;double age=0;std::optional<std::size_t> ground_object{};Vec3 ground_velocity{};} loose_board_;
    bool on_foot_=false,start_on_foot_=false,mount_held_=false,mount_pending_=false;
    double walk_phase_=0;
    void place_foot(Vec3 position,Vec3 forward,Vec3 velocity={});
    void tick_foot(const RideInput& input,const Rider& before);
    void tick_loose_board();
    std::optional<GroundContact> walk_ground(Vec3 start,Vec3 end) const;
    Vec3 walk_move(Vec3 start,Vec3 destination,Vec3& velocity,double radius=.28,double height=1.65) const;
    std::map<std::size_t,WorldContact> previous_contacts_;
    std::vector<ContactEvent> contact_events_;
    std::function<void(const Player&,const Rider&)> tick_observer_;
    std::uint64_t placement_serial_=0,transport_placements_=0,teleports_=0;
    std::optional<GroundContact> trace_ground(Vec3 start,Vec3 end) const;
    std::optional<GroundContact> probe(Vec3 position) const;
    std::vector<ProbeSphere> volume(const Rider& pose,bool airborne,bool rail=false) const;
    bool move_world(const Rider& before,Vec3 destination,bool landing_allowed);
    void sample_input(const RideInput& input);
    void land(const GroundContact& hit);
    void enter_air();
    void crash(CrashCause cause,Vec3 normal);
    void begin_recovery();
    bool update_recovery();
    bool update_jump();
    void leave_rail(double cooldown=0);
    void ride_rail(const RailHit& hit,const RideInput& input,const Rider& before);
    void notify_tick(const Rider& before);
};
}
