#include "openslope/player.hpp"
#include "openslope/paths.hpp"
#include "openslope/replay.hpp"
#include <nlohmann/json.hpp>
#include <chrono>
#include <fstream>
#include <iostream>
#include <stdexcept>

namespace {
using namespace openslope;using Json=nlohmann::json;unsigned checks=0;
void require(bool value,const char* message){++checks;if(!value)throw std::runtime_error(message);}
void near(double a,double b,double tolerance,const char* message){require(std::abs(a-b)<=tolerance,message);}
template<class F> void rejects(F f,const char* message){bool rejected=false;try{f();}catch(const std::exception&){rejected=true;}require(rejected,message);}
Patch floor(double width=2000){Patch p;p.surface=1;p.lightmap=-1;for(unsigned u=0;u<4;++u)for(unsigned v=0;v<4;++v)p.points[u*4+v]={-width/2+width*u/3,0,width/2-width*v/3};return p;}
void seat(Player& p,Vec3 velocity={0,0,-12}){p.warp({0,-.005,0},{0,0,-1},velocity);}
void helpers(){
    RideContract c;const auto impulse=c.jump_impulse({0,1,0},{0,0,-1},12,0);
    near(length(impulse),6.308786,1e-9,"Tap launch has the measured minimum magnitude");near(impulse.y,6.308786/std::sqrt(1.04),1e-9,"Flat launch uses the normal/tangent fallback");require(impulse.z<0,"Launch adds forward carry rather than removing it");
    require(length(c.jump_impulse({0,1,0},{0,0,-1},12,1))>length(impulse),"Full high-stat charge rises above the tap floor");near(length(c.jump_impulse({0,1,0},{0,0,-1},12,1,127)),length(impulse),1e-9,"Mid-stat charge stays below the launch floor");
    near(c.landing_retention(15*pi/180,25*pi/180),1,1e-12,"Clean touchdown has no orientation tax");near(c.landing_retention(50*pi/180,80*pi/180),.85*.75,1e-12,"Independent landing bands reach their clamps");near(c.landing_retention(32.5*pi/180,52.5*pi/180),.925*.875,1e-12,"Landing penalties interpolate within both bands");
    near(c.cruise_alignment({0,0,-12},{0,0,-1},{0,1,0}),1,1e-12,"Cruise drives square forward travel");near(c.cruise_alignment({0,0,-12},{0,0,1},{0,1,0}),1,1e-12,"Square switch travel has the same cruise authority");near(c.cruise_alignment({12,0,0},{0,0,-1},{0,1,0}),0,1e-12,"Sideways skidding receives no cruise drive");
    const auto lean=c.lean(.5,.5,20,1,1.0/60);near(lean,.5,1e-12,"Inner analog steer values are not rescaled");require(c.lean(0,1,20,3,1.0/60)<c.lean(0,1,20,1,1.0/60),"Powder slows lean response");
}
void controls(){
    Player charged(Terrain({floor()}));seat(charged);for(unsigned i=0;i<24;++i)charged.tick({0,false,false,true});near(charged.rider().charge,1,1e-9,"Charge reaches full at the desktop application rate");
    require(charged.rider().control==Control::Charge,"Jump control is separate from motion");for(unsigned i=0;i<4;++i)charged.tick({});require(charged.rider().launches==0,"Full release waits for its countdown");const auto before=charged.rider().velocity;charged.tick({});
    require(charged.rider().launches==1&&!charged.rider().grounded,"Fifth release tick launches into air");require(charged.rider().velocity.y>6&&charged.rider().velocity.z<before.z,"Launch preserves velocity and adds its impulse");
    for(unsigned i=0;i<300&&!charged.rider().grounded;++i)charged.tick({});require(charged.rider().grounded&&charged.rider().landings==1,"Charged jump lands and resumes riding");
    Player air(Terrain({floor()}));air.warp({0,60,0},{0,0,-1},{0,0,-12});air.tick({0,false,false,true});air.tick({});require(air.rider().launches==0&&air.rider().charge==0,"A fresh press in air cannot bank a jump");
    Player edge(Terrain({floor(1)}));edge.warp({0,-.005,-.49},{0,0,-1},{0,0,-20});for(unsigned i=0;i<24;++i)edge.tick({0,false,false,true});require(!edge.rider().grounded&&edge.rider().control==Control::Charge,"Charge survives leaving a finite lip");for(unsigned i=0;i<5;++i)edge.tick({});require(edge.rider().launches==1,"Committed release launches without a ground check");
    Player late(Terrain({floor(1)}));late.warp({0,-.005,-.49},{0,0,-1},{0,0,-20});late.tick({});late.tick({0,false,false,true});require(!late.rider().grounded&&late.rider().control==Control::Charge,"Last-ground-frame press survives the next probe's crest discovery");
    Player pending(Terrain({floor()}));seat(pending);pending.advance(0,{0,false,false,true});pending.advance(0,{});pending.advance(1.0/60,{});require(pending.rider().launches==1,"Press/release edges survive frames with no simulation tick");
    Player blurred(Terrain({floor()}));seat(blurred);blurred.tick({0,false,false,true});blurred.release_inputs();blurred.tick({});require(blurred.rider().launches==0&&blurred.rider().charge==0,"Focus loss cancels an uncommitted charge");
    Player brake(Terrain({floor()}));seat(brake);for(unsigned i=0;i<30;++i)brake.tick({0,false,false,false,-1});require(length(project(brake.rider().velocity,{0,1,0}))<5,"Brake scrubs speed and suppresses cruise");near(brake.rider().flip_degrees,0,0,"Ground brake does not flip the deck");
    Player tuck(Terrain({floor()}));seat(tuck);for(unsigned i=0;i<20;++i)tuck.tick({0,false,false,false,1});require(tuck.rider().crouch>.9,"Ground tuck drives the pose field");near(tuck.rider().flip_degrees,0,0,"Ground tuck does not flip the deck");
    Player spinning(Terrain({floor()}));spinning.warp({0,60,0},{0,0,-1},{0,0,-12});for(unsigned i=0;i<40;++i)spinning.tick({1});near(spinning.rider().spin_degrees,180,1e-9,"Air steer spins at the shared desktop rate");near(dot(spinning.rider().forward,{0,0,1}),1,1e-9,"Half spin reverses the deck nose");near(dot(spinning.camera_forward(),{0,0,-1}),1,1e-9,"Trick rotation does not spin the camera frame");
    Player flipping(Terrain({floor()}));flipping.warp({0,60,0},{0,0,-1},{0,0,-12});for(unsigned i=0;i<40;++i)flipping.tick({0,false,false,false,1});near(flipping.rider().flip_degrees,180,1e-9,"Air tuck flips at the spin rate");require(flipping.render_up().y<-.99,"Half flip renders the deck upside down");for(unsigned i=0;i<40;++i)flipping.tick({0,false,false,false,-1});near(flipping.rider().flip_degrees,0,1e-9,"Reverse flip input returns to the base");
    Player impact(Terrain({floor()}));impact.warp({0,.2,0},{0,0,-1},{0,-20,-15});impact.tick({});require(impact.rider().grounded&&impact.rider().landings==1,"Swept air collision catches a floor crossed within a tick");require(impact.rider().velocity.y< -19,"Clean touchdown keeps incoming normal velocity");near(impact.rider().contact_error,0,0,"Clean touchdown seeds response error at zero");near(impact.rider().landing_scale,1,1e-9,"Square landing preserves speed before absorber response");
    Player switched(Terrain({floor()}));switched.warp({0,.2,0},{0,0,1},{0,-20,-15});switched.tick({});require(switched.rider().lead==-1,"Backward landing latches switch stance");for(unsigned i=0;i<180;++i)switched.tick({});require(switched.rider().lead==-1&&dot(switched.rider().forward,{0,0,1})>.99,"Switch remains stable through grounded riding");require(switched.rider().velocity.z< -10,"Switch cruise continues down-course");
    Player reset(Terrain({floor()}));reset.advance(1.0/60,{0,false,true});reset.advance(1.0/60,{0,false,true});reset.advance(1.0/60,{0,false,true});require(reset.rider().position.y<1,"Held reset does not teleport every frame");
    rejects([&]{reset.tick({std::numeric_limits<double>::quiet_NaN()});},"Reject non-finite control input");
}
void paths(){
    const auto root=std::filesystem::temp_directory_path()/("openslope-play-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count())+".v1");std::filesystem::create_directory(root);
    struct Cleanup{std::filesystem::path path;~Cleanup(){std::error_code e;std::filesystem::remove_all(path,e);}}cleanup{root};
    const Json first={{"PathPos",{100,200,300}},{"PathPoints",{{100,0,50},{0,200,-50}}},{"U3",50},{"Respawnable",true},{"PathEvents",Json::array()}};
    auto second=first;second["PathPos"]={1000,200,300};Json doc={{"StartPosList",{0,0,0,1,1,1}},{"AIPaths",{first,second}},{"RaceLines",Json::array()}};
    const auto write=[&]{std::ofstream file(root/"AIP.json");file<<doc;};write();const auto paths=CoursePaths::load(root);require(paths.ai[0].points.size()==3,"Runtime path includes the seed vertex");near(length(paths.ai[0].points[0]-Vec3{1,3,-2}),0,1e-12,"Path seed uses the proper axis rotation and centimetres");near(length(paths.ai[0].points.back()-Vec3{2,3,-4}),0,1e-12,"Runtime accumulates displacement steps");const auto spawn=paths.start_pose();require(spawn.has_value(),"Authored start slots supply a spawn");near(spawn->first.x,10,1e-12,"Choose the middle authored start slot");require(spawn->second.z<0,"Path baseline supplies down-course heading");
    doc["StartPosList"][0]=9;write();rejects([&]{static_cast<void>(CoursePaths::load(root));},"Reject an invalid start-row path index");
    CoursePath vertical;vertical.points={{0,0,0},{0,2,0},{0,2,-20}};const auto pose=vertical.pose(0,15);require(pose.second.z<-.98,"Heading baseline spans a short vertical staging jog");
    Json sequence={{"Schema","openslope-replay/v1"},{"Placement",{{"Position",{0,-.005,0}},{"Forward",{0,0,-1}},{"Velocity",{0,0,-12}}}},{"Steps",Json::array({{{"Ticks",24},{"Jump",true}},{{"Ticks",6}},{{"Ticks",300}}})}};
    const auto write_replay=[&]{std::ofstream file(root/"replay.json");file<<sequence;};write_replay();Player replayed(Terrain({floor()}));unsigned frames=0;Replay::load(root/"replay.json").run(replayed,[&]{++frames;});require(frames==330,"Replay runs one callback per fixed input sample");require(replayed.rider().launches==1&&replayed.rider().landings==1&&replayed.rider().grounded,"Authored replay covers a complete charged jump and touchdown");
    sequence["Steps"][0]["Ticks"]=216001;write_replay();rejects([&]{static_cast<void>(Replay::load(root/"replay.json"));},"Reject unbounded replay durations");
}
}
int main(){try{helpers();controls();paths();
    RidingEffects effects;Rider a,b;a.grounded=b.grounded=true;a.motion=b.motion=Motion::Ground;b.velocity={0,0,-18};b.position={0,0,-1};
    effects.tick(a,b,1./60);require(effects.sprites().empty(),"Standard straight riding does not create a carve plume");b.lean=.5;effects.tick(a,b,1./60);require(effects.carve_emitted()==1&&!effects.sprites().empty(),"Ground carve emits by traveled distance");
    const auto birth=effects.sprites()[0].position;b.grounded=false;b.motion=Motion::Air;b.position={100,0,0};effects.tick(a,b,1./60);require(effects.carve_emitted()==1&&std::abs(effects.sprites()[0].position.x-birth.x)<1e-9,"Air stops carve emission and retains old world origins");
    effects.reset();b.grounded=true;b.motion=Motion::Ground;b.surface=3;b.lean=0;effects.tick(a,b,1./60);require(effects.powder_count()>0,"Powder cloud does not require lean");const auto size=effects.sprites().size();effects.tick(a,b,0);require(effects.sprites().size()==size,"Paused effect time does not advance");
    effects.reset();a.grounded=false;a.motion=Motion::Air;a.velocity={0,-14,-3};a.landings=0;b.surface=1;b.landings=1;b.position={};effects.tick(a,b,1./60);require(effects.landing_emitted()>=2&&effects.landing_emitted()<=8,"Touchdown produces an immediate bounded cloud burst");
    b.grounded=false;b.motion=Motion::Air;for(unsigned i=0;i<130;++i)effects.tick(b,b,1./60);require(effects.sprites().empty(),"Old puffs expire in two seconds");effects.reset();require(effects.sprites().empty()&&effects.landing_emitted()==0,"Reset clears particles and activity");
    std::cout<<"PASS: "<<checks<<" desktop control, flight, landing, effects and path checks\n";return 0;}catch(const std::exception& e){std::cerr<<"FAIL: "<<e.what()<<'\n';return 1;}}
