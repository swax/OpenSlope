#include "openslope/riding_effects.hpp"
#include "openslope/player.hpp"
#include "openslope/import.hpp"
#include <nlohmann/json.hpp>
#include <fstream>
#include <stdexcept>

namespace openslope {
std::string riding_sprite(const std::filesystem::path& root){
    if(root.empty()||!std::filesystem::exists(root/"RidingEffects.json"))return {};
    if(std::filesystem::file_size(root/"RidingEffects.json")>65536)throw std::runtime_error("Riding effect profile exceeds its limit");
    std::ifstream file(root/"RidingEffects.json");const auto profile=nlohmann::json::parse(file);
    if(profile.value("Schema","")!="openslope-riding-effects/v1")throw std::runtime_error("Unsupported riding effect profile");
    if(!profile.value("Enabled",true))return {};const auto name=profile.at("Puff").get<std::string>();if(!valid_map_name(name))throw std::runtime_error("Unsafe riding sprite filename");return name;
}
void RidingEffects::reset(){puffs_.clear();sprites_.clear();random_=0x73421u;distance_=landing_activity_=followup_=0;carve_emitted_=landing_emitted_=powder_count_=0;}
double RidingEffects::random(){random_^=random_<<13;random_^=random_>>17;random_^=random_<<5;return double(random_)/4294967296.;}
void RidingEffects::puff(Vec3 origin,Vec3 normal,double alpha,bool landing){
    if(puffs_.size()==512)puffs_.erase(puffs_.begin());puffs_.push_back({origin,normal,0,alpha,random()*2*pi,landing});if(landing)++landing_emitted_;else ++carve_emitted_;
}
void RidingEffects::tick(const Rider& before,const Rider& after,double dt){
    if(!std::isfinite(dt)||dt<0||dt>.1||!finite(before.position)||!finite(before.velocity)||!finite(after.position)||!finite(after.velocity)||!finite(after.normal)||!finite(after.forward)||!std::isfinite(after.lean))throw std::runtime_error("Invalid riding effect tick");if(dt==0)return;
    for(auto& p:puffs_)p.age+=dt;std::erase_if(puffs_,[](const auto& p){return p.age>=2;});sprites_.clear();powder_count_=0;
    const bool ground=after.grounded&&after.motion==Motion::Ground,powder=after.surface==3||after.surface==4;const auto speed=length(after.velocity),lean=std::min(1.,std::abs(after.lean));const auto normal=normalized(after.normal),side=normalized(cross(normal,after.forward),{1,0,0});
    // [Trailmap: 380-spray-systems] Fixed world origins; only rendering curves
    // grow/lift the carve puff. Emission is distance-based, not render-based.
    if(ground&&(lean>.2||powder)){
        distance_+=std::min(10.,length(after.position-before.position));unsigned emitted=0;
        while(distance_>=.7&&emitted++<16){distance_-=.7;puff(after.position,normal,.06*(powder?std::max(.2,lean):lean),false);}
    }else distance_=0;
    // [Trailmap: 380-landing] Immediate touchdown burst and a decaying tail.
    // Exact hidden accumulator/skid bindings remain application tuning.
    if(ground&&after.landings>before.landings){const auto count=unsigned(std::clamp(2+length(before.velocity)/3.,2.,8.));for(unsigned i=0;i<count;++i)puff(after.position+side*((random()-.5)*.8)+after.forward*((random()-.5)*.8),normal,.04,true);landing_activity_=std::min(1.5,length(before.velocity)/10);followup_=0;}
    if(ground&&speed>10&&std::abs(dot(after.velocity,side))>4)landing_activity_=std::max(landing_activity_,std::min(1.5,std::abs(dot(after.velocity,side))/10));
    if(ground&&landing_activity_>0){followup_+=dt*24*landing_activity_;if(followup_>=1){followup_-=1;puff(after.position,normal,.02,true);}landing_activity_=std::max(0.,landing_activity_-dt);}else{landing_activity_=followup_=0;}
    for(const auto& p:puffs_){const auto life=p.age/2;const auto width=p.landing?std::max(0.,2.4+(5-2.4)*(p.age-.2)/1.8):1.6+3.2*p.age;const auto height=p.landing?.972222222+.638888889*p.age:.25*p.age;const auto fade=p.landing?std::min(1.,p.age/.2)*(1-life)*(1-life):1-life;
        sprites_.push_back({p.origin+p.normal*height,float(width*.5),float(p.alpha*fade),float(p.rotation)});
    }
    // [Trailmap: 380-spray-systems] This small cloud is deliberately re-placed
    // near the board each fixed tick, independently of carve lean.
    if(ground&&powder){powder_count_=unsigned(std::min(32.,speed*1.6));for(unsigned i=0;i<powder_count_;++i)sprites_.push_back({after.position+side*((random()-.5)*1.2)+after.forward*((random()-.5)*1.8)+normal*(.05+random()*.3),float(.15+random()*.07),.06f,float(random()*2*pi)});}
}
}
