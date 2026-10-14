#include "openslope/player.hpp"
#include <nlohmann/json.hpp>
#include <fstream>
#include <chrono>
#include <iostream>
#include <stdexcept>

namespace {
using namespace openslope;using Json=nlohmann::json;unsigned checks=0;
void check(bool value,const char* what){++checks;if(!value)throw std::runtime_error(what);}
void near(double a,double b,const char* what){check(std::abs(a-b)<1e-7,what);}
CoursePaths route(double height=0){CoursePath line;line.points={{0,height,0},{0,height-100,100}};line.distance_to_finish=80;CoursePaths paths;paths.race.push_back(line);return paths;}
CoursePaths flat(){auto paths=route();paths.race[0].points={{0,0,0},{0,0,100}};return paths;}
CourseRun run(CoursePaths paths,RunMode mode=RunMode::Race,double budget=120,unsigned laps=1){RunSettings settings;settings.mode=mode;settings.countdown_seconds=0;settings.showoff_seconds=budget;settings.laps=laps;return CourseRun(paths,paths,settings);}
void start(CourseRun& r,Vec3 p={0,0,0}){r.begin_tick(0,true);r.end_tick(p,1);}
void step(CourseRun& r,Vec3 p,double dt=1./60,std::uint64_t serial=1){r.begin_tick(dt,true);r.end_tick(p,serial);}
}
int main(){try{
    auto steep=run(route());const auto projected=steep.locate({0,-50,50});near(projected->station,50,"horizontal arc rather than 3D length");near(projected->distance_to_finish,30,"stored DTF subtraction");near(steep.finish()->first.z,80,"finish uses DTF station, not path tail");near(steep.finish()->first.y,-80,"finish interpolates slope height");
    auto stacked=flat();auto upper=stacked.race[0];for(auto& point:upper.points)point.y=100;stacked.race.push_back(upper);check(run(stacked).locate({0,99,40})->route==1,"3D route choice separates stacked runs");
    RunSettings intro;intro.mode=RunMode::Race;CourseRun countdown(flat(),flat(),intro);for(unsigned i=0;i<100;++i){check(countdown.begin_tick(1./60,false),"on-foot ready may walk");countdown.end_tick({0,0,0},1);}check(countdown.status().phase==RunPhase::Ready,"standing does not start clock");
    for(unsigned i=0;i<180;++i){check(!countdown.begin_tick(1./60,true),"countdown holds riding");countdown.end_tick({0,0,0},1);}check(countdown.status().phase==RunPhase::Running,"countdown releases at three seconds");near(countdown.status().clock,0,"countdown excluded from result clock");step(countdown,{0,0,1});near(countdown.status().clock,1./60,"race clock ticks once after go");
    auto paths=flat();paths.race[0].distance_to_finish=100;paths.race[0].events={{11,150,50,50}};auto alternate=paths.race[0];for(auto& point:alternate.points)point.x=20;alternate.events[0].value=120;paths.race.push_back(alternate);
    auto showoff=run(paths,RunMode::Showoff,135);start(showoff,{18,0,40});step(showoff,{18,0,60},1);check(showoff.status().checkpoints==1,"one active route award");near(showoff.status().clock,254,"alternate route grants 120 seconds once");step(showoff,{1,0,40},1);check(showoff.status().checkpoints==1,"reverse crossing grants nothing");step(showoff,{1,0,60},1);check(showoff.status().checkpoints==2,"forward recross re-arms");near(showoff.status().clock,402,"main route recross grants its own 150");
    auto racing=run(paths);start(racing,{1,0,40});step(racing,{1,0,60},1);check(racing.status().checkpoints==1,"race checkpoint advances progress");near(racing.status().clock,1,"race ignores even nonzero checkpoint payload");
    auto warp=run(paths,RunMode::Showoff);start(warp,{0,0,40});step(warp,{0,0,70},1,2);check(warp.status().checkpoints==0,"placement skips crossed checkpoint");step(warp,{0,0,40},1,2);step(warp,{0,0,60},1,2);check(warp.status().checkpoints==1,"continuous travel re-arms after warp");
    auto finished=run(flat());start(finished,{0,0,79});step(finished,{0,0,81},.5);check(finished.status().phase==RunPhase::Finished,"forward bounded crossing finishes");step(finished,{0,0,90},1);near(finished.status().clock,.5,"result clock freezes");finished.restart();check(finished.status().phase==RunPhase::Ready&&finished.status().clock==0,"restart clears result");
    auto past=run(flat());start(past,{0,0,90});step(past,{0,0,95});check(past.status().phase==RunPhase::Running,"spawn past finish is not a crossing");step(past,{0,0,70});step(past,{0,0,90});check(past.status().phase==RunPhase::Finished,"returning behind finish re-arms");
    auto high=run(flat());start(high,{0,0,79});step(high,{0,480,81});check(high.status().phase==RunPhase::Running,"overhead crossing rejected");auto wide=run(flat());start(wide,{500,0,79});step(wide,{500,0,81});check(wide.status().phase==RunPhase::Running,"crossing wide of course rejected");
    auto timeout=run(flat(),RunMode::Showoff,1);start(timeout);step(timeout,{0,0,1},1);check(timeout.status().phase==RunPhase::Expired&&timeout.status().clock==0,"showoff expires at zero");step(timeout,{0,0,2},1);near(timeout.status().elapsed,1,"expired elapsed freezes");
    auto last_tick=paths;last_tick.race.resize(1);auto rescue=run(last_tick,RunMode::Showoff,1);start(rescue,{0,0,40});step(rescue,{0,0,60},1);check(rescue.status().phase==RunPhase::Running&&rescue.status().clock==150,"crossing on last tick extends before expiry");
    auto untimed=run(flat(),RunMode::Showoff,0);start(untimed);for(unsigned i=0;i<10;++i)step(untimed,{0,0,1},1);check(untimed.status().phase==RunPhase::Running&&untimed.status().clock==0,"zero-clock slot does not expire instantly");
    auto free=run(paths,RunMode::Freeride);start(free,{0,0,40});step(free,{0,0,60});step(free,{0,0,110});check(free.status().checkpoints==0&&free.status().phase==RunPhase::Running,"freeride has no event result");
    auto lap_paths=flat();lap_paths.race[0].events={{12,4,70,70}};auto laps=run(lap_paths,RunMode::Race,120,4);start(laps,{0,0,60});for(unsigned i=0;i<4;++i){step(laps,{0,0,75});check(laps.status().remaining==3-i,"lap event decrements remaining passes");if(i<3){step(laps,{0,0,85});check(laps.status().phase==RunPhase::Running,"finish gated while laps remain");step(laps,{0,0,60});}}
    check(laps.status().phase==RunPhase::Running,"last lap event does not finish run");step(laps,{0,0,85});check(laps.status().phase==RunPhase::Finished,"plane below last lap event finishes");
    auto coincident=flat();coincident.race[0].events={{12,1,80,80}};auto ordered=run(coincident,RunMode::Race,120,2);start(ordered,{0,0,70});step(ordered,{0,0,90});step(ordered,{0,0,70});step(ordered,{0,0,90});check(ordered.status().remaining==0&&ordered.status().phase==RunPhase::Running,"finish precedes coincident last lap decrement");
    auto custom_laps=run(flat(),RunMode::Race,120,3);start(custom_laps,{0,0,70});for(unsigned i=0;i<3;++i){step(custom_laps,{0,0,90});if(i<2)step(custom_laps,{0,0,70});}check(custom_laps.status().phase==RunPhase::Finished,"custom laps without separate lap station finish on last pass");
    check(run_clock(83.456)=="1:23.45"&&run_clock(-1)=="0:00.00","centiseconds truncate and clamp");check(run_mode("showoff")==RunMode::Showoff,"explicit mode parsing");bool rejected=false;try{run_mode("bad");}catch(const std::invalid_argument&){rejected=true;}check(rejected,"invalid mode rejected");
    const auto root=std::filesystem::temp_directory_path()/("openslope-run-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));std::filesystem::create_directory(root);struct Cleanup{std::filesystem::path path;~Cleanup(){std::error_code ec;std::filesystem::remove_all(path,ec);}}cleanup{root};
    std::ofstream(root/"Origin.json")<<Json{{"Schema","openslope-origin/v1"},{"Course","ALASKA"}};near(RunSettings::load(root,RunMode::Showoff).showoff_seconds,135,"cached course origin preserves slot clock");
    for(const auto showoff:{false,true}){Json document{{"StartPosList",Json::array()},{"AIPaths",Json::array()},{"RaceLines",Json::array({{{"DistanceToFinish",8000},{"PathPos",{showoff?2000:0,0,0}},{"PathPoints",{{0,-10000,0}}},{"PathEvents",Json::array({{{"EventType",11},{"EventValue",showoff?110:0},{"EventStart",5000},{"EventEnd",5000}}})}}})}};std::ofstream(root/(showoff?"SOP.json":"AIP.json"))<<document;}
    const auto dataset=CourseRun::load(root,RunMode::Showoff);near(dataset.locate({20,0,25})->point.x,20,"showoff uses its SOP dataset");near(dataset.finish()->first.x,0,"AIP retains finish authority when SOP differs");
    std::ofstream(root/"Slopesmith.json")<<Json{{"schema",1},{"kind","slopesmith-export"},{"laps",3},{"showoffSeconds",180}};const auto settings=RunSettings::load(root,RunMode::Showoff);check(settings.laps==3&&settings.showoff_seconds==180,"Slopesmith authored overrides survive portable map loading");
    std::ofstream(root/"Slopesmith.json")<<Json{{"schema",1},{"kind","slopesmith-export"},{"laps",999}};rejected=false;try{RunSettings::load(root,RunMode::Race);}catch(const std::runtime_error&){rejected=true;}check(rejected,"malformed authored count is bounded");
    std::cout<<"PASS: "<<checks<<" course metric, clock, checkpoint, finish, lap, restart and portable settings checks\n";return 0;
}catch(const std::exception& error){std::cerr<<"FAIL: "<<error.what()<<'\n';return 1;}}
