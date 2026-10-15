#include "openslope/boost.hpp"
#include <set>
#include <stdexcept>
namespace openslope {
namespace {
bool same(Vec3 a,Vec3 b){return a.x==b.x&&a.y==b.y&&a.z==b.z;}
void boost_tick(double seconds){if(!std::isfinite(seconds)||seconds<0||seconds>1)throw std::invalid_argument("Invalid boost tick");}
void value(double v){if(!std::isfinite(v)||std::abs(v)>1e6)throw std::invalid_argument("Invalid boost law");}
}
bool BoostLaw::operator==(const BoostLaw& b) const {if(kind!=b.kind||mode!=b.mode||seconds!=b.seconds||rate!=b.rate||target!=b.target||height!=b.height||tolerance!=b.tolerance||!same(direction,b.direction)||stage_speed!=b.stage_speed)return false;for(unsigned i=0;i<3;++i)if(!same(stage_direction[i],b.stage_direction[i]))return false;return true;}
Vec3 boost_velocity(Vec3 velocity,Vec3 direction,double target,double rate,double seconds){boost_tick(seconds);if(!finite(velocity)||!finite(direction)||!std::isfinite(target)||!std::isfinite(rate)||rate<0)throw std::invalid_argument("Invalid boost velocity");const auto axis=normalized(direction,{});return velocity+axis*(std::max(0.,target-dot(velocity,axis))*rate*seconds);}
Vec3 air_boost_velocity(Vec3 velocity,Vec3 nose,double cap,double seconds){
    boost_tick(seconds);if(!finite(velocity)||!finite(nose)||!std::isfinite(cap)||cap<=0)throw std::invalid_argument("Invalid air boost");nose=normalized(nose,{});const auto speed=length(velocity);if(speed<1e-9)return velocity+nose*(8*seconds);
    const auto along=velocity/speed;const auto alignment=dot(along,nose),blend=std::clamp((speed-(cap-2))/2,0.,1.);auto result=velocity+nose*(8*seconds*(1-blend));
    if(blend>0){if(alignment<0)result+=along*(alignment*8*seconds*blend);const auto lateral=project(nose,along);if(length(lateral)>1e-9){const auto angle=std::min(std::acos(std::clamp(alignment,-1.,1.)),40*pi/180*seconds*blend);result=rotate(result,normalized(cross(along,nose)),angle);}}return result;
}
void PadBoost::tick(double seconds){boost_tick(seconds);speed=std::max(0.,speed-seconds);trick=std::max(0.,trick-seconds);}
void PadBoost::request(bool trick_pad,double seconds){value(seconds);auto& timer=trick_pad?trick:speed;timer=std::max(timer,std::max(0.,seconds));}
ScriptedBoost::ScriptedBoost(BoostLaw law):law_(law){
    if(law.kind!=7&&law.kind!=15&&law.kind!=18&&law.kind!=24)throw std::invalid_argument("Invalid scripted boost kind");for(const auto v:{law.seconds,law.rate,law.target,law.height,law.tolerance})value(v);if(law.seconds<0||law.rate<0||law.target<0||law.tolerance<0||!finite(law.direction))throw std::invalid_argument("Invalid scripted boost fields");for(unsigned i=0;i<3;++i){value(law.stage_speed[i]);if(law.stage_speed[i]<0||!finite(law.stage_direction[i]))throw std::invalid_argument("Invalid tube stage");}remaining_=law.mode==1?law.seconds:0;
}
void ScriptedBoost::activate(){if(law_.mode<2)remaining_=law_.seconds;expired_=false;}
void ScriptedBoost::contact(std::uint64_t rider){if(!riders_[rider].inside)activate();}
void ScriptedBoost::apply(double seconds,std::span<BoostRider> riders,std::span<const std::optional<BoostVolume>> volumes,const LapEntry& lap_entry){
    boost_tick(seconds);if(riders.size()!=volumes.size()||riders.size()>16)throw std::invalid_argument("Invalid boost rider set");if(expired_||seconds==0)return;remaining_=std::max(0.,remaining_-seconds);occupied_=false;bool serviced=false;std::set<std::uint64_t> present;
    for(std::size_t i=0;i<riders.size();++i){auto& rider=riders[i];if(!present.insert(rider.id).second||!finite(rider.position)||!finite(rider.velocity)||rider.stage>2)throw std::invalid_argument("Invalid boost rider");auto& latch=riders_[rider.id];const bool inside=rider.active&&volumes[i].has_value();if(!inside){latch={};continue;}occupied_=true;const auto& volume=*volumes[i];
        if(!latch.inside){latch.inside=true;latch.allowed=true;if(law_.kind==15){const auto left=lap_entry?lap_entry(rider.id):std::nullopt;latch.allowed=!left||*left>0;rider.stage=rider.position.y<volume.box.min.y+10?0:dot(rider.position-volume.box.center(),volume.axis)<0?1:2;}latch.direction=law_.kind==24?normalized(law_.stage_direction[rider.stage],{}):normalized(law_.direction,{});latch.target=law_.kind==24?law_.stage_speed[rider.stage]:law_.target;}
        if((law_.kind==7||law_.kind==24)&&(law_.mode>=2||(law_.mode==0&&remaining_>1e-9)))continue;
        if(!latch.allowed)continue;if(law_.kind==18&&rider.position.y>=law_.height)continue;
        const auto before=rider.velocity;
        if(law_.kind==18){if(law_.tolerance>0&&law_.height-rider.position.y<law_.tolerance){rider.position.y=law_.height;rider.snapped=true;}else{rider.velocity=boost_velocity(rider.velocity,latch.direction,latch.target,law_.rate,seconds);serviced=true;}rider.velocity.x=rider.velocity.z=0;}
        else{if(law_.kind==15)rider.velocity.x=rider.velocity.z=0;rider.velocity=boost_velocity(rider.velocity,latch.direction,latch.target,law_.rate,seconds);serviced=true;}
        rider.driven|=length(rider.velocity-before)>1e-12||rider.snapped;
    }
    for(auto it=riders_.begin();it!=riders_.end();)if(!present.contains(it->first))it=riders_.erase(it);else ++it;
    if(law_.kind==18||law_.kind==15)expired_=!serviced;else expired_=law_.mode>=2||(law_.mode==1&&remaining_<=1e-9&&!occupied_);
}
}
