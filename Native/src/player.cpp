#include "openslope/player.hpp"

namespace openslope {
Player::Player(Terrain terrain):terrain_(std::move(terrain)),clock_(contract_.tick_seconds(),contract_.max_catchup_ticks()) {
    const auto spawn=terrain_.spawn();spawn_position_=spawn.first;spawn_forward_=spawn.second;reset();
}
void Player::reset() {
    rider_={};rider_.position=spawn_position_;rider_.forward=spawn_forward_;rider_.velocity=spawn_forward_*3;
    const auto hit=terrain_.intersect(spawn_position_+Vec3{0,2,0},spawn_position_-Vec3{0,1,0});
    if(hit) { rider_.normal=hit->normal;rider_.smoothed_up=hit->normal;rider_.surface=hit->surface;rider_.grounded=true; }
    const auto& s=contract_.surface(rider_.surface);
    rider_.bog=s.bog;rider_.budget=s.budget;rider_.lift=s.lift;
    rider_.position-=rider_.normal*(s.bog*std::clamp(rider_.normal.y,0.0,1.0));
    rider_.previous_position=rider_.position;rider_.speed_cap=contract_.value("speed","defaultCap");clock_.reset();
}
std::optional<TerrainHit> Player::probe(Vec3 position) const {
    const auto lateral=normalized(cross(rider_.normal,rider_.forward),{1,0,0});
    const auto base=position+lateral*rider_.slide;
    return terrain_.intersect(base+rider_.normal*contract_.value("contact","probeAbove"),base-rider_.normal*contract_.value("contact","probeBelow"));
}
void Player::tick(const RideInput& input) {
    const auto dt=contract_.tick_seconds();rider_.previous_position=rider_.position;
    const auto hit=probe(rider_.position);
    if(hit) {
        if(hit->surface==0) {reset();return;}
        const auto lateral=normalized(cross(rider_.normal,rider_.forward));
        rider_.contact_error=dot(rider_.position+lateral*rider_.slide-hit->point,hit->normal);
        rider_.normal=hit->normal;rider_.surface=hit->surface;
        rider_.smoothed_up=normalized(rider_.smoothed_up+rider_.normal*.5);
        if(!rider_.grounded&&rider_.contact_error<=0&&dot(rider_.velocity,rider_.normal)<0) {
            const auto speed=length(rider_.velocity);
            rider_.velocity=normalized(project(rider_.velocity,rider_.normal),rider_.forward)*speed;
            rider_.grounded=true;
        }
    } else rider_.grounded=false;
    const auto& s=contract_.surface(rider_.surface);
    const auto forward=normalized(project(rider_.forward,rider_.normal),rider_.forward);
    const auto lateral=normalized(cross(rider_.normal,forward));
    // Input smoothing is a prototype choice, not a claim of full state-machine parity.
    rider_.lean=approach(rider_.lean,std::clamp(input.steer,-1.0,1.0),4*dt);
    rider_.speed_cap=input.boost?contract_.value("speed","boostCap"):
        approach(rider_.speed_cap,contract_.value("speed","defaultCap"),contract_.value("speed","capDecay")*dt);
    Vec3 acceleration;
    if(rider_.grounded&&hit) {
        const auto slew=contract_.value("contact","surfaceFieldSlew")*dt;
        rider_.bog=approach(rider_.bog,s.bog,slew);rider_.budget=approach(rider_.budget,s.budget,slew);rider_.lift=approach(rider_.lift,s.lift,slew);
        rider_.slide=approach(rider_.slide,-contract_.value("steering","carveSlideScale")*rider_.lean*std::min(1.0,length(rider_.velocity)*contract_.value("steering","carveSlideSpeedGate")),contract_.value("steering","carveSlideSlew")*dt);
        if(rider_.budget+rider_.contact_error<0) {
            const auto push=std::min(contract_.value("contact","pushoutCap"),-rider_.budget-rider_.contact_error);
            rider_.position+=rider_.normal*push;rider_.velocity+=rider_.normal*push;rider_.contact_error+=push;
        }
        const auto normal_response=contract_.contact_response(s,rider_.contact_error,dot(rider_.velocity,rider_.normal),rider_.bog,rider_.budget);
        const auto load=s.A/contract_.response("units","centimetresPerMetre");
        const auto capped=std::min(normal_response,2*load),theta=s.tilt_degrees*pi/180*rider_.lean;
        acceleration=rider_.normal*(normal_response+capped-capped/std::cos(theta))+lateral*(capped*std::tan(theta))+Vec3{0,-load,0};
        const auto u=dot(rider_.velocity,forward),w=dot(rider_.velocity,lateral);
        const auto boost=input.boost?1.0:0.0;
        acceleration+=forward*contract_.forward_resistance(s,u,rider_.contact_error,rider_.budget,0,boost);
        acceleration+=lateral*contract_.lateral_resistance(s.drag,u,w,rider_.lean,boost);
        const auto drive=std::clamp(s.target-u,0.0,contract_.value("speed","cruiseDeficitMax"))*s.multiplier*contract_.value("speed","riderDrive");
        acceleration+=forward*(drive+(input.boost?contract_.value("speed","boostAcceleration"):0));
    } else {
        acceleration={-rider_.velocity.x*contract_.value("gravity","airHorizontalDrag"),-contract_.value("gravity",rider_.velocity.y>0?"airRising":"airFalling"),-rider_.velocity.z*contract_.value("gravity","airHorizontalDrag")};
        rider_.forward=rotate(rider_.forward,{0,1,0},rider_.lean*contract_.value("steering","airTurnRateDeg")*pi/180*dt);
    }
    // [Trailmap: 320-spring-accel] Explicit position, then velocity integration.
    rider_.position+=rider_.velocity*dt;rider_.velocity+=acceleration*dt;
    const auto speed=length(rider_.velocity);
    if(speed>rider_.speed_cap) rider_.velocity*=rider_.speed_cap/speed;
    if(rider_.grounded) {
        const auto fresh=probe(rider_.position);
        if(fresh) {
            rider_.normal=fresh->normal;rider_.surface=fresh->surface;
            rider_.velocity=contract_.redirect(rider_.velocity,fresh->normal,fresh->surface);
            rider_.contact_error=dot(rider_.position+lateral*rider_.slide-fresh->point,fresh->normal);
            const auto tangent=normalized(project(rider_.forward,rider_.normal),forward);
            const auto current_speed=length(rider_.velocity);
            const auto downhill=normalized(project(Vec3{0,-1,0},rider_.normal),tangent);
            const auto slip=current_speed>1e-6?dot(cross(rider_.velocity,tangent),rider_.normal)/current_speed:0;
            const auto yaw=contract_.heading_yaw(rider_.lean,contract_.heading_lead(rider_.lean,0),slip,current_speed,dot(rider_.velocity,tangent),dot(rider_.velocity,downhill),dt);
            rider_.forward=normalized(rotate(tangent,rider_.normal,yaw),forward);
            rider_.grounded=rider_.contact_error<=contract_.surface(fresh->surface).threshold;
        } else rider_.grounded=false;
    }
    // Prototype recovery for finite terrain, pending the course reset-volume port.
    if(!finite(rider_.position)||!finite(rider_.velocity)||rider_.position.y<terrain_.bounds().min.y-30) reset();
}
void Player::advance(double seconds,const RideInput& input) {
    if(input.reset) {reset();return;}
    const auto ticks=clock_.advance(seconds);for(unsigned i=0;i<ticks;++i) tick(input);
}
Vec3 Player::render_position() const {
    const auto lateral=normalized(cross(rider_.normal,rider_.forward));
    return rider_.previous_position*(1-clock_.alpha())+rider_.position*clock_.alpha()+rider_.smoothed_up*rider_.lift+lateral*rider_.slide;
}
}
