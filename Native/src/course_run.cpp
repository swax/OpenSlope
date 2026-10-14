#include "openslope/course_run.hpp"
#include <nlohmann/json.hpp>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <cctype>

namespace openslope {
namespace {
using Json=nlohmann::json;
Json metadata(const std::filesystem::path& path){
    if(std::filesystem::file_size(path)>1024*1024)throw std::runtime_error("Run settings exceed 1 MiB");
    const auto relative=std::filesystem::weakly_canonical(path).lexically_relative(std::filesystem::weakly_canonical(path.parent_path()));
    if(relative.empty()||relative.is_absolute()||*relative.begin()=="..")throw std::runtime_error("Run settings resolve outside the course");
    std::ifstream input(path);return Json::parse(input);
}
double horizontal(Vec3 delta){return std::hypot(delta.x,delta.z);}
std::pair<Vec3,Vec3> horizontal_pose(const CoursePath& path,double station){
    Vec3 heading{0,0,-1};
    for(std::size_t i=1;i<path.points.size();++i){const auto delta=path.points[i]-path.points[i-1];const auto span=horizontal(delta);if(span<1e-9)continue;
        heading=normalized(project(delta,{0,1,0}));if(station<=span)return {path.points[i-1]+delta*(std::max(0.,station)/span),heading};station-=span;}
    return {path.points.back(),heading};
}
double box_distance(const Bounds& bounds,Vec3 p){const Vec3 q{std::clamp(p.x,bounds.min.x,bounds.max.x),std::clamp(p.y,bounds.min.y,bounds.max.y),std::clamp(p.z,bounds.min.z,bounds.max.z)};return dot(p-q,p-q);}
}
RunMode run_mode(std::string_view name){if(name=="freeride")return RunMode::Freeride;if(name=="race")return RunMode::Race;if(name=="showoff")return RunMode::Showoff;throw std::invalid_argument("Mode must be freeride, race or showoff");}
const char* run_name(RunMode mode){switch(mode){case RunMode::Race:return "RACE";case RunMode::Showoff:return "SHOWOFF";default:return "FREERIDE";}}
const char* run_name(RunPhase phase){switch(phase){case RunPhase::Ready:return "READY";case RunPhase::Countdown:return "COUNTDOWN";case RunPhase::Running:return "RUNNING";case RunPhase::Finished:return "FINISHED";default:return "TIME UP";}}
std::string run_clock(double seconds){
    if(!std::isfinite(seconds))throw std::invalid_argument("Clock must be finite");const auto centis=std::uint64_t(std::floor(std::clamp(seconds,0.,1e9)*100+1e-8));std::ostringstream text;
    text<<centis/6000<<':'<<std::setfill('0')<<std::setw(2)<<(centis/100)%60<<'.'<<std::setw(2)<<centis%100;return text.str();
}
RunSettings RunSettings::load(const std::filesystem::path& root,RunMode mode){
    RunSettings result;result.mode=mode;if(root.empty())return result;auto course=root.filename().string();
    if(std::filesystem::exists(root/"Origin.json")){const auto origin=metadata(root/"Origin.json");if(origin.value("Schema",std::string{})=="openslope-origin/v1")course=origin.value("Course",course);}
    for(auto& c:course)c=char(std::toupper(static_cast<unsigned char>(c)));
    // [Trailmap: 390-showoff-clock, 390-lap-counter] Slot defaults, never inferred from mountain shape.
    if(course=="MEGAPLE")result.laps=4;
    if(course=="ALASKA")result.showoff_seconds=135;
    else if(course=="TRICK"||course=="UNTRACK")result.showoff_seconds=0;
    else if(course=="SNOW"||course=="ELYSIUM"||course=="MESA"||course=="MERQUER"||course=="ALOHA"||course=="PIPE"||course=="MEGAPLE"||course=="BIGAIR")result.showoff_seconds=90;
    if(std::filesystem::exists(root/"Slopesmith.json")){const auto custom=metadata(root/"Slopesmith.json");if(custom.value("schema",0)==1&&custom.value("kind",std::string{})=="slopesmith-export"){
        if(custom.contains("laps")){const auto value=custom.at("laps").get<double>();if(!std::isfinite(value)||value<1||value>20||std::floor(value)!=value)throw std::runtime_error("Invalid authored lap count");result.laps=unsigned(value);}
        if(custom.contains("showoffSeconds")){const auto value=custom.at("showoffSeconds").get<double>();if(!std::isfinite(value)||value<0||value>300)throw std::runtime_error("Invalid authored showoff clock");result.showoff_seconds=value;}
    }}return result;
}
CourseRun CourseRun::load(const std::filesystem::path& root,RunMode mode){
    auto finish=CoursePaths::load(root),paths=finish;
    if(!root.empty()&&mode==RunMode::Showoff&&std::filesystem::exists(root/"SOP.json"))paths=CoursePaths::load(root/"SOP.json");
    return CourseRun(std::move(paths),std::move(finish),RunSettings::load(root,mode));
}
CourseRun::CourseRun(CoursePaths paths,CoursePaths finish_paths,RunSettings settings):paths_(std::move(paths)),settings_(settings){
    if(settings.laps<1||settings.laps>20||!std::isfinite(settings.showoff_seconds)||settings.showoff_seconds<0||settings.showoff_seconds>300||!std::isfinite(settings.countdown_seconds)||settings.countdown_seconds<0||settings.countdown_seconds>10)throw std::invalid_argument("Invalid run settings");
    for(const auto& path:paths_.race){Route route;double arc=0;for(std::size_t i=0;i<path.points.size();++i){if(!finite(path.points[i]))throw std::invalid_argument("Invalid race line");if(i)arc+=horizontal(path.points[i]-path.points[i-1]);route.arc.push_back(arc);route.bounds.add(path.points[i]);}
        if(!std::isfinite(path.distance_to_finish)||path.distance_to_finish<0)throw std::invalid_argument("Invalid race DTF");total_=std::max(total_,path.distance_to_finish);for(const auto& event:path.events)lap_events_|=event.type==12;routes_.push_back(std::move(route));}
    // [Trailmap: 250-dtf-zero, 390-finish-loc] Minimum stored DTF, horizontal station, AIP preferred.
    const CoursePath* last=nullptr;for(const auto& path:finish_paths.race)if(path.points.size()>1&&(!last||path.distance_to_finish<last->distance_to_finish))last=&path;
    if(last){double span=0;for(std::size_t i=1;i<last->points.size();++i)span+=horizontal(last->points[i]-last->points[i-1]);if(span>1e-6&&last->distance_to_finish<=span+1e-6)finish_=horizontal_pose(*last,last->distance_to_finish);}
    restart();
}
void CourseRun::restart(){
    status_={};status_.mode=settings_.mode;status_.phase=settings_.mode==RunMode::Freeride?RunPhase::Running:RunPhase::Ready;status_.passes=settings_.laps;status_.remaining=settings_.laps>1?settings_.laps:0;status_.clock=settings_.mode==RunMode::Showoff?settings_.showoff_seconds:0;
    previous_dtf_.reset();previous_position_.reset();
}
bool CourseRun::begin_tick(double seconds,bool mounted){
    if(!std::isfinite(seconds)||seconds<0||seconds>1)throw std::invalid_argument("Invalid run tick");status_.checkpoint_notice=std::max(0.,status_.checkpoint_notice-seconds);
    if(status_.phase==RunPhase::Ready&&mounted){status_.phase=RunPhase::Countdown;status_.countdown=settings_.countdown_seconds;}
    if(status_.phase==RunPhase::Countdown){status_.countdown=std::max(0.,status_.countdown-seconds);if(status_.countdown<=1e-9)status_.phase=RunPhase::Running;return !mounted;}
    if(status_.phase==RunPhase::Running){status_.elapsed+=seconds;if(settings_.mode==RunMode::Showoff)status_.clock=settings_.showoff_seconds>0?std::max(0.,status_.clock-seconds):0;else status_.clock+=seconds;}
    return !mounted||status_.phase==RunPhase::Running;
}
std::optional<CourseProgress> CourseRun::locate(Vec3 position) const {
    if(!finite(position))throw std::invalid_argument("Invalid course query");std::vector<std::pair<double,std::size_t>> candidates;for(std::size_t i=0;i<routes_.size();++i)if(paths_.race[i].points.size()>1)candidates.emplace_back(box_distance(routes_[i].bounds,position),i);
    std::sort(candidates.begin(),candidates.end());if(candidates.size()>3)candidates.resize(3);std::optional<CourseProgress> best;double distance=std::numeric_limits<double>::infinity();
    for(const auto& [unused,index]:candidates){static_cast<void>(unused);const auto& path=paths_.race[index];for(std::size_t i=1;i<path.points.size();++i){const auto a=path.points[i-1],delta=path.points[i]-a;const auto flat=dot(project(delta,{0,1,0}),delta);if(flat<1e-12)continue;
        const auto t=std::clamp(dot(project(position-a,{0,1,0}),delta)/flat,0.,1.);const auto point=a+delta*t;const auto d=dot(point-position,point-position);if(d>=distance)continue;distance=d;const auto station=routes_[index].arc[i-1]+horizontal(delta)*t,dtf=path.distance_to_finish-station;
        best=CourseProgress{index,station,dtf,std::sqrt(d),total_>0?std::clamp(1-dtf/total_,0.,1.):0,point,normalized(project(delta,{0,1,0}))};}}
    return best;
}
void CourseRun::end_tick(Vec3 position,std::uint64_t placement_serial){
    status_.progress=locate(position);const auto dtf=status_.progress?std::optional(status_.progress->distance_to_finish):std::nullopt;
    const bool continuous=previous_position_&&serial_==placement_serial;
    if(status_.phase==RunPhase::Running&&settings_.mode!=RunMode::Freeride&&continuous){
        bool crossing=false;if(finish_){const auto [point,forward]=*finish_;const auto a=dot(*previous_position_-point,forward),b=dot(position-point,forward);if(a<0&&b>=0){const auto hit=*previous_position_+(position-*previous_position_)*(-a/(b-a));const auto lateral=project(hit-point,forward);crossing=horizontal(lateral)<=150&&std::abs(hit.y-point.y)<=30;}}
        // Finish is offered before a coincident lap event. Checkpoint payload never changes a race clock.
        if(crossing){if(!status_.remaining)status_.phase=RunPhase::Finished;else if(!lap_events_){--status_.remaining;status_.lap=std::min(status_.passes,status_.passes-status_.remaining+1);if(!status_.remaining)status_.phase=RunPhase::Finished;}}
        if(status_.phase==RunPhase::Running&&dtf&&previous_dtf_&&*dtf<*previous_dtf_-1e-6){const auto& path=paths_.race[status_.progress->route];std::vector<const PathEvent*> crossed;
            for(const auto& event:path.events){const auto remaining=path.distance_to_finish-event.start;if((event.type==11||event.type==12)&&remaining<*previous_dtf_-1e-6&&remaining>=*dtf-1e-6)crossed.push_back(&event);}
            std::stable_sort(crossed.begin(),crossed.end(),[](const auto* a,const auto* b){return a->start<b->start;});double checkpoint=-1e30;
            for(const auto* event:crossed){if(event->type==12){if(status_.remaining){--status_.remaining;status_.lap=std::min(status_.passes,status_.passes-status_.remaining+1);}}else if(std::abs(event->start-checkpoint)>1e-4){checkpoint=event->start;++status_.checkpoints;status_.checkpoint_notice=2;status_.checkpoint_bonus=settings_.mode==RunMode::Showoff&&event->value<=600?event->value:0;status_.clock+=status_.checkpoint_bonus;}}
        }
    }
    if(status_.phase==RunPhase::Running&&settings_.mode==RunMode::Showoff&&settings_.showoff_seconds>0&&status_.clock<=1e-9){status_.clock=0;status_.phase=RunPhase::Expired;}
    previous_position_=position;previous_dtf_=dtf;serial_=placement_serial;
}
}
