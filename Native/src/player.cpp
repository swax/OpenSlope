#include "openslope/player.hpp"
#include <stdexcept>

namespace openslope {
namespace {
Vec3 ease_up(Vec3 current,Vec3 target,double rate,double dt){
    current=normalized(current);target=normalized(target);const auto angle=std::acos(std::clamp(dot(current,target),-1.0,1.0));if(angle<1e-9)return target;
    auto axis=cross(current,target);if(length(axis)<1e-9)axis=cross(current,{1,0,0});if(length(axis)<1e-9)axis=cross(current,{0,0,1});
    return normalized(rotate(current,normalized(axis),std::min(angle,rate*dt)));
}
}
Player::Player(Terrain terrain,PlayTuning tuning):terrain_(std::move(terrain)),clock_(contract_.tick_seconds(),contract_.max_catchup_ticks()),tuning_(tuning){
    if(!std::isfinite(tuning.charge_rate)||tuning.charge_rate<=0||!std::isfinite(tuning.brake_acceleration)||tuning.brake_acceleration<0||!std::isfinite(tuning.flip_recovery_rate)||tuning.flip_recovery_rate<=0||tuning.jump_stat>255)throw std::runtime_error("Invalid desktop riding tuning");
    const auto spawn=terrain_.spawn();spawn_position_=spawn.first;spawn_forward_=spawn.second;reset();
}
void Player::release_inputs(){
    jump_held_=false;jump_edges_.clear();reset_held_=false;
    if(rider_.control==Control::Charge){rider_.charge=0;rider_.control=rider_.grounded?Control::Cruise:Control::Air;}
}
void Player::warp(Vec3 position,Vec3 forward,Vec3 velocity,Vec3 up){
    if(!finite(position)||!finite(forward)||!finite(velocity)||!finite(up)||length(forward)<1e-9||length(cross(forward,up))<1e-9)throw std::runtime_error("Invalid rider placement");
    rider_={};rider_.position=rider_.previous_position=position;rider_.velocity=velocity;rider_.forward=normalized(forward);rider_.board_up=normalized(project(up,rider_.forward));
    if(const auto hit=terrain_.intersect(position+Vec3{0,2,0},position-Vec3{0,1,0})){
        rider_.normal=hit->normal;rider_.surface=hit->surface;rider_.contact_error=dot(position-hit->point,hit->normal);
        rider_.grounded=rider_.contact_error<=contract_.surface(hit->surface).threshold&&dot(velocity,hit->normal)<=contract_.value("contact","separationSpeed");
    }
    rider_.smoothed_up=rider_.normal;const auto& s=contract_.surface(rider_.surface);rider_.bog=s.bog;rider_.budget=s.budget;rider_.lift=s.lift;
    rider_.speed_cap=contract_.value("speed","defaultCap");rider_.motion=rider_.grounded?Motion::Ground:Motion::Air;rider_.control=rider_.grounded?Control::Cruise:Control::Air;
    flight_heading_=normalized(project(velocity,{0,1,0}),normalized(project(forward,{0,1,0}),{0,0,-1}));jump_cooldown_=air_grace_=0;clock_.reset();release_inputs();
}
void Player::reset(){
    // Desktop drop-in: seed the surface fields, then land from one metre up.
    // Authored start-row selection is separate from this application policy.
    auto position=spawn_position_;if(const auto hit=terrain_.intersect(position+Vec3{0,2,0},position-Vec3{0,10,0}))position=hit->point;
    warp(position+Vec3{0,1,0},spawn_forward_);
}
void Player::sample_input(const RideInput& input){
    if(!std::isfinite(input.steer)||!std::isfinite(input.posture))throw std::invalid_argument("Rider input must be finite");
    if(input.jump!=jump_held_){if(jump_edges_.size()>=16)throw std::runtime_error("Too many unconsumed jump edges");jump_edges_.push_back(input.jump);jump_held_=input.jump;}
}
std::optional<TerrainHit> Player::probe(Vec3 position) const {
    const auto lateral=normalized(cross(rider_.normal,rider_.forward*double(rider_.lead)),{1,0,0});const auto base=position+lateral*rider_.slide;
    return terrain_.intersect(base+rider_.normal*contract_.value("contact","probeAbove"),base-rider_.normal*contract_.value("contact","probeBelow"));
}
void Player::enter_air(){
    if(rider_.motion==Motion::Ground){rider_.air_time=0;flight_heading_=normalized(project(rider_.forward*double(rider_.lead),{0,1,0}),flight_heading_);}
    rider_.grounded=false;rider_.motion=Motion::Air;if(rider_.control==Control::Cruise)rider_.control=Control::Air;
}
void Player::land(const TerrainHit& hit){
    const auto deck_up=render_up(),nose=normalized(project(rider_.forward,hit.normal),rider_.forward),travel=project(rider_.velocity,hit.normal);
    const auto tilt=std::acos(std::clamp(dot(deck_up,hit.normal),-1.0,1.0));
    const auto yaw=length(travel)>1e-6?std::acos(std::clamp(std::abs(dot(normalized(travel),nose)),0.0,1.0)):0;
    rider_.landing_scale=contract_.landing_retention(tilt,yaw);rider_.velocity*=rider_.landing_scale;
    if(length(travel)>.5)rider_.lead=dot(travel,nose)<0?-1:1;
    // [Trailmap: 340-landing-seed] A swept hit seats at contact with zero
    // response error and preserves incoming normal velocity for ground response.
    rider_.position=hit.point;rider_.normal=hit.normal;rider_.surface=hit.surface;rider_.contact_error=0;rider_.forward=nose;
    rider_.grounded=true;rider_.motion=Motion::Ground;++rider_.landings;
    if(rider_.control==Control::Air||rider_.control==Control::Launched)rider_.control=Control::Cruise;
}
void Player::tick(const RideInput& input){
    sample_input(input);const auto dt=contract_.tick_seconds();rider_.previous_position=rider_.position;jump_cooldown_=std::max(0.0,jump_cooldown_-dt);air_grace_=std::max(0.0,air_grace_-dt);
    // Interpret edges against the last validated motion state. A press made
    // on the last ground frame must not be lost to this tick's crest discovery.
    while(!jump_edges_.empty()){
        const auto down=jump_edges_.front();jump_edges_.pop_front();
        if(down&&rider_.grounded&&rider_.control==Control::Cruise&&jump_cooldown_<=0){rider_.control=Control::Charge;rider_.charge=0;}
        else if(!down&&rider_.control==Control::Charge){rider_.release_snapshot=rider_.release_remaining=rider_.charge;rider_.control=Control::Release;}
    }
    const auto hit=probe(rider_.position);bool just_landed=false;
    if(hit){
        if(hit->surface==0){reset();return;}
        const auto lateral=normalized(cross(rider_.normal,rider_.forward*double(rider_.lead)));const auto error=dot(rider_.position+lateral*rider_.slide-hit->point,hit->normal);
        rider_.normal=hit->normal;rider_.surface=hit->surface;
        if(rider_.grounded){
            rider_.contact_error=error;
            // [Trailmap: 320-redirect] Redirect before separation and launch.
            // A small tangent floor prevents the standstill redirect feeding
            // vertical absorber oscillation into unpowered horizontal travel.
            if(length(project(rider_.velocity,hit->normal))>.3)rider_.velocity=contract_.redirect(rider_.velocity,hit->normal,hit->surface);
            if(error>contract_.surface(hit->surface).threshold)enter_air();
        }else if(air_grace_<=0&&error<=0&&dot(rider_.velocity,hit->normal)<0){land(*hit);just_landed=true;}
    }else if(rider_.grounded)enter_air();
    rider_.smoothed_up=normalized(rider_.smoothed_up+rider_.normal*.5);
    // [Trailmap: 300-decoupled, 340-charge] Only charge entry needs ground;
    // an existing charge/release survives a crest or a missed contact probe.
    bool launch=false;
    if(rider_.control==Control::Charge)rider_.charge=approach(rider_.charge,1,tuning_.charge_rate*dt);
    else if(rider_.control==Control::Release){rider_.release_remaining=approach(rider_.release_remaining,0,13.33*dt);rider_.charge=rider_.release_remaining;launch=rider_.release_remaining<=1e-9;}
    const auto& s=contract_.surface(rider_.surface);const auto posture=std::clamp(input.posture,-1.0,1.0);
    rider_.lean=contract_.lean(rider_.lean,std::clamp(input.steer,-1.0,1.0),length(rider_.velocity),rider_.surface,dt);
    Vec3 acceleration;const bool ground=rider_.grounded;
    if(ground){
        const auto slew=contract_.value("contact","surfaceFieldSlew")*dt;rider_.bog=approach(rider_.bog,s.bog,slew);rider_.budget=approach(rider_.budget,s.budget,slew);rider_.lift=approach(rider_.lift,s.lift,slew);
        rider_.slide=approach(rider_.slide,-contract_.value("steering","carveSlideScale")*rider_.lean*std::min(1.0,length(rider_.velocity)*contract_.value("steering","carveSlideSpeedGate")),contract_.value("steering","carveSlideSlew")*dt);
        if(!just_landed&&rider_.budget+rider_.contact_error<0){const auto push=std::min(contract_.value("contact","pushoutCap"),-rider_.budget-rider_.contact_error);rider_.position+=rider_.normal*push;rider_.velocity+=rider_.normal*push;rider_.contact_error+=push;}
        const auto normal_response=contract_.contact_response(s,rider_.contact_error,dot(rider_.velocity,rider_.normal),rider_.bog,rider_.budget);
        const auto load=s.A/contract_.response("units","centimetresPerMetre"),capped=std::min(normal_response,contract_.response("bank","loadCapMultiplier")*load),theta=s.tilt_degrees*pi/180*rider_.lean;
        const auto forward=normalized(project(rider_.forward,rider_.normal),rider_.forward)*double(rider_.lead),lateral=normalized(cross(rider_.normal,forward));
        acceleration=rider_.normal*(normal_response+capped-capped/std::cos(theta))+lateral*(capped*std::tan(theta))+Vec3{0,-load,0};
        const auto u=dot(rider_.velocity,forward),w=dot(rider_.velocity,lateral);const bool boosting=input.boost&&posture>=0;const auto boost=boosting?1.0:0.0;
        acceleration+=forward*contract_.forward_resistance(s,u,rider_.contact_error,rider_.budget,rider_.charge,boost);acceleration+=lateral*contract_.lateral_resistance(s.drag,u,w,rider_.lean,boost);
        if(posture<0){const auto tangent=project(rider_.velocity,rider_.normal);const auto speed=length(tangent);if(speed>1e-9)acceleration-=tangent/speed*std::min(tuning_.brake_acceleration*(-posture),speed/dt);}
        else{
            const auto deficit=std::clamp(s.target-length(rider_.velocity),0.0,contract_.value("speed","cruiseDeficitMax"));const auto align=contract_.cruise_alignment(rider_.velocity,rider_.forward,rider_.normal);
            const auto drive=align*deficit*s.multiplier*contract_.value("speed","riderDrive");const auto window=contract_.value("speed","boostLeanWindow");const auto thrust=boosting?contract_.value("speed","boostAcceleration")*std::clamp(1-std::abs(rider_.lean)/window,0.0,1.0):0;
            acceleration+=forward*(drive+thrust);
        }
        const auto angle=std::acos(std::clamp(dot(rider_.board_up,rider_.normal),-1.0,1.0));const auto rate=std::min(contract_.value("pose","groundRateCapDeg")*pi/180,contract_.value("pose","groundCubicGain")*angle*angle*angle);
        rider_.board_up=ease_up(rider_.board_up,rider_.normal,rate,dt);rider_.flip_degrees=approach(rider_.flip_degrees,std::round(rider_.flip_degrees/360)*360,tuning_.flip_recovery_rate*dt);
    }else{
        acceleration={-rider_.velocity.x*contract_.value("gravity","airHorizontalDrag"),-contract_.value("gravity",rider_.velocity.y>0?"airRising":"airFalling"),-rider_.velocity.z*contract_.value("gravity","airHorizontalDrag")};
        const auto rate=contract_.value("steering","airTurnRateDeg")*(input.boost?1.6:1),spin=std::clamp(input.steer,-1.0,1.0)*rate*dt;
        rider_.forward=normalized(rotate(rider_.forward,{0,1,0},spin*pi/180));rider_.spin_degrees+=spin;rider_.flip_degrees+=posture*rate*dt;rider_.air_time+=dt;
        rider_.board_up=ease_up(rider_.board_up,{0,1,0},contract_.value("pose","airLevelRateDeg")*pi/180,dt);
        if(rider_.velocity.y<0){if(const auto upcoming=terrain_.intersect(rider_.position,rider_.position+rider_.velocity*contract_.value("pose","orientationGrace"));upcoming&&dot(render_up(),upcoming->normal)>.9)rider_.board_up=ease_up(rider_.board_up,upcoming->normal,contract_.value("pose","groundRateCapDeg")*pi/180,dt);}
        // Desktop air boost is view-heading thrust, outside the retail physics
        // contract. Mouse/view aiming will supply that heading in a later slice.
        if(input.boost)acceleration+=flight_heading_*8;
    }
    if(launch){const auto tangent=normalized(project(rider_.velocity,rider_.normal),rider_.forward*double(rider_.lead));rider_.velocity+=contract_.jump_impulse(rider_.normal,tangent,length(rider_.velocity),std::max(0.0,rider_.release_snapshot-rider_.release_remaining),tuning_.jump_stat);enter_air();rider_.control=Control::Launched;rider_.charge=0;++rider_.launches;jump_cooldown_=.35;air_grace_=contract_.value("pose","orientationGrace");}
    rider_.speed_cap=(!rider_.grounded||input.boost)?contract_.value("speed","boostCap"):approach(rider_.speed_cap,contract_.value("speed","defaultCap"),contract_.value("speed","capDecay")*dt);
    const auto before=rider_.position;rider_.position+=rider_.velocity*dt;rider_.velocity+=acceleration*dt;const auto speed=length(rider_.velocity);if(speed>rider_.speed_cap)rider_.velocity*=rider_.speed_cap/speed;
    if(!ground&&!launch&&air_grace_<=0){if(const auto swept=terrain_.intersect(before,rider_.position);swept&&dot(rider_.velocity,swept->normal)<0){if(swept->surface==0){reset();return;}land(*swept);}}
    if(ground&&!launch){
        const auto forward=normalized(project(rider_.forward,rider_.normal),rider_.forward)*double(rider_.lead);const auto speed_now=length(rider_.velocity);const auto downhill=normalized(project(Vec3{0,-1,0},rider_.normal),forward);
        const auto slip=speed_now>1e-6?dot(cross(rider_.velocity,forward),rider_.normal)/speed_now:0;
        const auto yaw=contract_.heading_yaw(rider_.lean,contract_.heading_lead(rider_.lean,rider_.charge),slip,speed_now,dot(rider_.velocity,forward),dot(rider_.velocity,downhill),dt);
        rider_.forward=normalized(rotate(forward,rider_.normal,yaw))*double(rider_.lead);
    }
    const auto crouch=rider_.control==Control::Charge?rider_.charge:!rider_.grounded?.3:posture>0?1.0:posture<0?.55:0.0;rider_.crouch=approach(rider_.crouch,crouch,(crouch>rider_.crouch?6:18)*dt);
    if(!finite(rider_.position)||!finite(rider_.velocity)||rider_.position.y<terrain_.bounds().min.y-30)reset();
}
void Player::advance(double seconds,const RideInput& input){
    sample_input(input);if(input.reset&&!reset_held_){reset();reset_held_=true;return;}reset_held_=input.reset;
    const auto ticks=clock_.advance(seconds);for(unsigned i=0;i<ticks;++i)tick(input);
}
Vec3 Player::render_position() const {
    const auto lateral=normalized(cross(rider_.normal,rider_.forward*double(rider_.lead)));
    return rider_.previous_position*(1-clock_.alpha())+rider_.position*clock_.alpha()+rider_.smoothed_up*rider_.lift+lateral*rider_.slide;
}
Vec3 Player::render_forward() const {
    const auto forward=normalized(project(rider_.forward,rider_.board_up),rider_.forward),right=normalized(cross(forward,rider_.board_up));return rotate(forward,right,-rider_.flip_degrees*pi/180);
}
Vec3 Player::render_up() const {
    const auto forward=normalized(project(rider_.forward,rider_.board_up),rider_.forward),right=normalized(cross(forward,rider_.board_up));auto up=rotate(rider_.board_up,right,-rider_.flip_degrees*pi/180);
    if(rider_.grounded)up=rotate(up,render_forward(),-contract_.value("steering","bankMaxDeg")*pi/180*rider_.lean*rider_.lead);return normalized(up);
}
Vec3 Player::camera_forward() const {return rider_.grounded?normalized(project(rider_.forward*double(rider_.lead),{0,1,0}),flight_heading_):flight_heading_;}
}
