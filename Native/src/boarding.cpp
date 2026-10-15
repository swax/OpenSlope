#include "openslope/player.hpp"
#include <stdexcept>

namespace openslope {
std::optional<Player::GroundContact> Player::walk_ground(Vec3 start,Vec3 end) const {
    std::optional<GroundContact> result;
    if(const auto hit=terrain_.intersect(start,end);hit&&hit->normal.y>.55)result=GroundContact{hit->point,hit->normal,hit->t,hit->surface,{}};
    if(const auto hit=world_.ray(start,end);hit&&hit->normal.y>.55&&(!result||hit->t<result->t))result=GroundContact{hit->point,hit->normal,hit->t,hit->surface,hit->instance,hit->object,hit->surface_velocity};return result;
}
Vec3 Player::walk_move(Vec3 start,Vec3 destination,Vec3& velocity,double radius,double height) const {
    // Application walker: separate sphere casts also test head/feet against boxes.
    // Positive-mass props block; triggers do not. There is no board bounce here.
    const auto offsets=std::array<double,4>{radius,.65*height,.85*height,height-.16};
    for(unsigned pass=0;pass<6;++pass){std::optional<WorldContact> closest;
        for(unsigned i=0;i<offsets.size();++i){const auto r=i==3?.16:radius;const std::array<ProbeSphere,1> a{{{start+Vec3{0,offsets[i],0},r}}},b{{{destination+Vec3{0,offsets[i],0},r}}};
            for(const auto& hit:world_.sweep(a,b)){if(!hit.response||hit.normal.y>.55||(hit.depth<=1e-7&&dot(destination-start,hit.normal)>=-1e-9))continue;if(!closest||hit.t<closest->t)closest=hit;}}
        if(!closest)break;const auto delta=destination-start;start+=delta*std::max(0.,closest->t-.001);start+=closest->normal*(std::max(0.,closest->depth)+.001);const auto inward=std::min(0.,dot(velocity,closest->normal));velocity-=closest->normal*inward;destination=start+project(delta*(1-closest->t),closest->normal);
    }return destination;
}
void Player::place_foot(Vec3 position,Vec3 forward,Vec3 velocity){
    score_.lose(ScoreLoss::BoardReleased);rider_.view_yaw=0;
    on_foot_=true;++placement_serial_;effects_.reset();get_up_.stop();settled_=0;rider_.position=rider_.previous_position=position;rider_.velocity=velocity;
    rider_.forward=flight_heading_=normalized(project(forward,{0,1,0}),{0,0,-1});rider_.board_up=rider_.smoothed_up={0,1,0};rider_.normal={0,1,0};
    rider_.motion=Motion::OnFoot;rider_.control=Control::OnFoot;rider_.grounded=false;rider_.ground_instance.reset();rider_.ground_object.reset();rider_.ground_velocity={};rider_.lean=rider_.slide=rider_.lift=rider_.crouch=0;rider_.flip_degrees=rider_.spin_degrees=rider_.charge=rider_.release_remaining=rider_.release_snapshot=0;rider_.rail_spline.reset();rider_.rail_spin=rider_.rail_spin_rate=0;rider_.crash_cause=CrashCause::None;rider_.recovery_height=0;
    if(const auto hit=walk_ground(position+Vec3{0,.08,0},position-Vec3{0,.08,0});hit&&velocity.y<=0){rider_.position.y=rider_.previous_position.y=hit->point.y;rider_.normal=hit->normal;rider_.surface=hit->surface;rider_.ground_instance=hit->instance;rider_.ground_object=hit->object;rider_.ground_velocity=hit->velocity;rider_.grounded=true;}
    previous_contacts_.clear();contact_events_.clear();walk_phase_=0;clock_.reset();release_inputs();
}
void Player::start_on_foot(){
    start_on_foot_=true;const auto heading=camera_forward();auto position=rider_.position;
    if(const auto hit=walk_ground(position+Vec3{0,2,0},position-Vec3{0,10,0}))position=hit->point;
    loose_board_={position,position,{},normalized(project(heading,{0,1,0}),{0,0,-1}),{0,1,0},true,1,0};
    if(const auto hit=walk_ground(position+Vec3{0,.1,0},position-Vec3{0,.1,0})){loose_board_.ground_object=hit->object;loose_board_.ground_velocity=hit->velocity;loose_board_.up=hit->normal;loose_board_.forward=normalized(project(heading,hit->normal),loose_board_.forward);}
    const auto right=normalized(cross(heading,{0,1,0}));auto feet=position;
    for(const auto offset:std::array<Vec3,4>{-right*.7,right*.7,-heading*.7,heading*.7}){const auto candidate=position+offset;const auto floor=walk_ground(candidate+Vec3{0,.4,0},candidate-Vec3{0,1,0});if(!floor)continue;auto target=floor->point;Vec3 velocity{};const auto resolved=walk_move(target,target,velocity);if(length(resolved-target)<.01){feet=target;break;}}
    place_foot(feet,heading);
}
double Player::board_distance(Vec3 room_offset) const {return on_foot_?length(rider_.position+project(room_offset,{0,1,0})-loose_board_.position):0;}
bool Player::interact_board(Vec3 room_offset){
    if(!finite(room_offset)||length(room_offset)>10)throw std::invalid_argument("Invalid room offset");if(recovering()||reset_pending())return false;
    if(on_foot_){if(board_distance(room_offset)>1.6)return false;const auto board=loose_board_;warp(board.position,board.forward,board.velocity+(board.grounded?board.ground_velocity:Vec3{}),board.up);rider_.lead=board.lead;return true;}
    const auto position=render_board_position(),forward=render_forward(),up=render_up(),heading=camera_forward();const auto velocity=rider_.velocity;const bool grounded=rider_.grounded;const auto lead=rider_.lead;
    loose_board_={position,position,grounded?velocity-rider_.ground_velocity:velocity,forward,up,grounded,lead,0,rider_.ground_object,rider_.ground_velocity};auto feet=position;
    if(grounded){const auto right=normalized(cross(heading,{0,1,0}));const auto candidate=feet-right*.7;if(const auto floor=walk_ground(candidate+Vec3{0,.4,0},candidate-Vec3{0,1,0})){Vec3 test=velocity;const auto resolved=walk_move(floor->point,floor->point,test);if(length(resolved-floor->point)<.01)feet=floor->point;}}
    place_foot(feet,heading,velocity);return true;
}
void Player::tick_foot(const RideInput& input,const Rider& before){
    const auto dt=contract_.tick_seconds();tick_loose_board();bool jump=false;while(!jump_edges_.empty()){jump|=jump_edges_.front();jump_edges_.pop_front();}
    const auto heading=normalized(project(input.walk_forward,{0,1,0}),flight_heading_),right=normalized(cross(heading,{0,1,0}));auto wish=heading*std::clamp(input.posture,-1.,1.)-right*std::clamp(input.steer,-1.,1.);if(length(wish)>1)wish=normalized(wish);const auto target=wish*(input.boost?4.5:2.5);
    const auto carried=rider_.grounded?rider_.position-before.position:Vec3{};
    if(rider_.grounded){const auto support=carried/dt;const auto relative=rider_.velocity-rider_.ground_velocity;rider_.velocity={approach(relative.x,target.x,18*dt)+support.x,support.y,approach(relative.z,target.z,18*dt)+support.z};rider_.ground_velocity=support;}else{rider_.velocity.x+=(target.x-rider_.velocity.x)*std::min(1.,dt*1.2);rider_.velocity.z+=(target.z-rider_.velocity.z)*std::min(1.,dt*1.2);}
    if(jump&&rider_.grounded){rider_.velocity.y+=4.5;rider_.grounded=false;++rider_.launches;}
    auto destination=rider_.position+rider_.velocity*dt-carried;auto floor=walk_ground(destination+Vec3{0,rider_.grounded?.35:0,0},destination-Vec3{0,rider_.grounded?.5:.05,0});
    bool seated=floor&&rider_.velocity.y<=floor->velocity.y&&(rider_.grounded||floor->point.y>=destination.y);if(seated&&!dispatch_fragile_ground(*floor)){floor=walk_ground(destination+Vec3{0,rider_.grounded?.35:0,0},destination-Vec3{0,rider_.grounded?.5:.05,0});seated=floor&&rider_.velocity.y<=floor->velocity.y&&(rider_.grounded||floor->point.y>=destination.y);}if(seated)destination.y=floor->point.y;
    destination=walk_move(before.position,destination,rider_.velocity);
    if(seated){const auto support=walk_ground(destination+Vec3{0,.1,0},destination-Vec3{0,.1,0});seated=bool(support);if(support){destination.y=support->point.y;rider_.normal=support->normal;rider_.surface=support->surface;rider_.ground_instance=support->instance;rider_.ground_object=support->object;rider_.ground_velocity=support->velocity;rider_.velocity.y=support->velocity.y;}}
    if(!seated){if(const auto hit=walk_ground(rider_.position,destination);hit&&rider_.velocity.y<=hit->velocity.y&&dispatch_fragile_ground(*hit)){destination=hit->point;rider_.normal=hit->normal;rider_.surface=hit->surface;rider_.ground_instance=hit->instance;rider_.ground_object=hit->object;rider_.ground_velocity=hit->velocity;rider_.velocity.y=hit->velocity.y;seated=true;}else{rider_.velocity.y-=9.8*dt;rider_.ground_instance.reset();rider_.ground_object.reset();rider_.ground_velocity={};}}
    rider_.position=destination;rider_.grounded=seated;if(!seated)rider_.pads.trick=0;rider_.motion=Motion::OnFoot;rider_.control=Control::OnFoot;rider_.board_up=rider_.smoothed_up={0,1,0};
    if(length(wish)>.05)rider_.forward=normalized(wish);walk_phase_+=length(project(rider_.velocity,{0,1,0}))*dt*5;
    contact_events_.clear();previous_contacts_.clear();if(!finite(rider_.position)||!finite(rider_.velocity)||rider_.position.y<terrain_.bounds().min.y-40)reset();
}
void Player::tick_loose_board(){
    const auto dt=contract_.tick_seconds();auto& b=loose_board_;b.previous=b.position;b.age+=dt;if(b.grounded&&b.ground_object)b.position+=world_.carry(*b.ground_object,b.position);const auto was_grounded=b.grounded;
    auto destination=b.position+b.velocity*dt;const auto floor=walk_ground(destination+Vec3{0,b.grounded?.25:0,0},destination-Vec3{0,b.grounded?.5:.03,0});
    if(floor&&b.velocity.y<=0&&(b.grounded||floor->point.y>=destination.y)){destination.y=floor->point.y;if(!was_grounded)b.velocity-=floor->velocity;b.ground_object=floor->object;b.ground_velocity=floor->velocity;b.up=floor->normal;b.forward=normalized(project(b.forward,b.up),b.forward);b.velocity=project(b.velocity,b.up);const auto speed=length(b.velocity);b.velocity=speed>.001?b.velocity*(std::max(0.,speed-3.5*dt)/speed):Vec3{};b.grounded=true;}
    else if(const auto hit=walk_ground(b.position,destination);hit&&b.velocity.y<=0){destination=hit->point;if(!was_grounded)b.velocity-=hit->velocity;b.ground_object=hit->object;b.ground_velocity=hit->velocity;b.up=hit->normal;b.forward=normalized(project(b.forward,b.up),b.forward);b.velocity=project(b.velocity,b.up);b.grounded=true;}
    else{if(was_grounded)b.velocity+=b.ground_velocity;b.ground_object.reset();b.ground_velocity={};b.grounded=false;b.velocity.y-=18*dt;b.velocity.x*=1-.25*dt;b.velocity.z*=1-.25*dt;}
    b.position=walk_move(b.previous,destination,b.velocity,.10,.25);if(b.grounded&&length(b.velocity)<.02){b.velocity={};b.age=0;}if(!finite(b.position)||!finite(b.velocity)||b.position.y<terrain_.bounds().min.y-40){if(const auto safe_floor=walk_ground(rider_.position+Vec3{0,2,0},rider_.position-Vec3{0,10,0})){b.position=b.previous=safe_floor->point;b.up=safe_floor->normal;}else b.position=b.previous=rider_.position;b.velocity={};b.age=0;}
}
}
