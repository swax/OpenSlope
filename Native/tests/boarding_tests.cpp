#include "openslope/avatar.hpp"
#include <nlohmann/json.hpp>
#include <chrono>
#include <fstream>
#include <iostream>
#include <stdexcept>

namespace {
using namespace openslope;using Json=nlohmann::json;unsigned checks=0;
void check(bool ok,const char* what){++checks;if(!ok)throw std::runtime_error(what);}
void near(Vec3 a,Vec3 b,const char* what){check(length(a-b)<1e-7,what);}
Terrain floor(){Patch p;for(unsigned u=0;u<4;++u)for(unsigned v=0;v<4;++v)p.points[u*4+v]={double(u)*100/3-50,0,double(v)*100/3-50};return Terrain({p});}
void write(const std::filesystem::path& path,const Json& value){std::ofstream(path)<<value;}
void geometry(const std::filesystem::path& root,Vec3 low,Vec3 high,int mass=1){
    Json points=Json::array();for(unsigned u=0;u<4;++u)for(unsigned v=0;v<4;++v)points.push_back({(double(u)*100/3-50)*100,(double(v)*100/3-50)*100,0});
    write(root/"Patches.json",{{"Patches",Json::array({{{"PatchName","Walking floor"},{"Points",points},{"SurfaceType",1},{"TrickOnlyPatch",false},{"TexturePath",""},{"LightmapID",-1},{"UVPoints",{{0,0},{0,1},{1,0},{1,1}}},{"LightMapPoint",{0,0,0,0}}}})}});
    const auto raw=[](Vec3 p){return Json::array({p.x*100,-p.z*100,p.y*100});};const auto lo=raw(low),hi=raw(high);const Json bounds{{"Min",{std::min(lo[0].get<double>(),hi[0].get<double>()),std::min(lo[1].get<double>(),hi[1].get<double>()),std::min(lo[2].get<double>(),hi[2].get<double>())}},{"Max",{std::max(lo[0].get<double>(),hi[0].get<double>()),std::max(lo[1].get<double>(),hi[1].get<double>()),std::max(lo[2].get<double>(),hi[2].get<double>())}}};
    write(root/"Models.json",{{"Models",Json::array({{{"ModelObjects",Json::array({{{"ParentID",-1},{"CollisionBounds",bounds},{"MeshData",Json::array()}}})}}})}});write(root/"Materials.json",{{"Materials",Json::array()}});
    write(root/"Instances.json",{{"Instances",Json::array({{{"ModelID",0},{"CollsionMode",2},{"PlayerCollision",true},{"PlayerBounce",true},{"U0",mass},{"SurfaceType",-1}}})}});
}
}
int main(){try{
    Player p(floor());p.warp({0,0,0},{0,0,-1});p.start_on_foot();check(p.on_foot()&&p.rider().grounded,"start grounded on foot");check(p.rider().motion==Motion::OnFoot&&p.rider().control==Control::OnFoot,"application walk state");check(p.board_distance()>.6&&p.board_distance()<.8,"board parked beside player");const auto board=p.render_board_position(),feet=p.rider().position;for(unsigned i=0;i<1800;++i)p.advance(1./60,{});near(p.render_board_position(),board,"parked board stays put");near(p.rider().position,feet,"idle walker does not slide or cruise");check(p.effects().wake().empty()&&p.effects().sprites().empty(),"walking has no board spray");
    const auto pose=avatar_pose(p);check(pose.on_foot,"walking avatar context");near(pose.up,{0,1,0},"walker remains upright");check(length(pose.joint(AvatarJoint::Hips)-feet)<1.1,"body belongs to walker, not board");
    RideInput mount;mount.mount=true;p.advance(1./120,mount);p.advance(1./120,{});check(!p.on_foot(),"short press survives fixed-step boundary");for(unsigned i=0;i<4;++i)p.advance(1./60,{});p.advance(1./60,mount);check(p.on_foot(),"fresh press dismounts");for(unsigned i=0;i<20;++i)p.advance(1./60,mount);check(p.on_foot(),"held mount button does not oscillate");
    p.reset();check(p.on_foot()&&p.board_distance()<1.6,"reset restores on-foot spawn and nearby board");check(!p.interact_board({4,0,0}),"physical room displacement affects proximity");check(p.interact_board({.7,0,0})&&!p.on_foot(),"nearby physical feet can mount");
    p.warp({0,0,0},{0,0,-1});p.start_on_foot();RideInput walk;walk.posture=1;const auto start=p.rider().position;for(unsigned i=0;i<120;++i)p.advance(1./60,walk);check(p.rider().position.z<start.z-4,"stick walks forward");near(p.render_board_position(),board,"walking does not drag parked board");check(!p.interact_board(),"distant mount rejected");
    p.reset();RideInput jump;jump.jump=true;p.advance(1./60,jump);check(!p.rider().grounded&&p.rider().velocity.y>4,"walking jump");for(unsigned i=0;i<90;++i)p.advance(1./60,jump);check(p.rider().grounded&&p.rider().launches==1,"held jump cannot repeat on landing");
    Player air(floor());air.warp({0,8,0},{0,0,-1},{0,0,-12});check(air.interact_board(),"airborne dismount");near(air.rider().velocity,{0,0,-12},"dismount keeps launch momentum");check(air.rider().position.y>7.9,"no snap to ground in mid-air");for(unsigned i=0;i<4;++i)air.advance(1./60,{});check(air.render_board_position().z<-.3&&air.render_board_position().y<air.render_position().y,"loose board keeps its own falling arc");for(unsigned i=0;i<600;++i)air.advance(1./60,{});check(!air.board_coasting()&&std::abs(air.render_board_position().y)<.01,"board lands and friction parks it");
    std::optional<Vec3> baseline;for(const auto fps:{60u,72u,90u,120u,144u}){Player rate(floor());rate.warp({0,0,0},{0,0,-1});rate.start_on_foot();for(unsigned i=0;i<fps*2;++i)rate.advance(1./fps,walk);if(baseline)near(rate.rider().position,*baseline,"walking independent of render rate");else baseline=rate.rider().position;}
    const auto root=std::filesystem::temp_directory_path()/("openslope-boarding-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));std::filesystem::create_directory(root);struct Cleanup{std::filesystem::path path;~Cleanup(){std::error_code ec;std::filesystem::remove_all(path,ec);}}cleanup{root};
    geometry(root,{-3,0,-3},{3,3,-2});Player wall(Terrain::load(root));wall.warp({0,0,0},{0,0,-1});wall.start_on_foot();for(unsigned i=0;i<180;++i)wall.advance(1./60,walk);check(wall.rider().position.z>-1.75,"walker stops at solid wall");check(wall.rider().crashes==0,"walking collision has no board crash");
    geometry(root,{-3,0,-3},{3,3,-2},0);Player trigger(Terrain::load(root));trigger.warp({0,0,0},{0,0,-1});trigger.start_on_foot();for(unsigned i=0;i<120;++i)trigger.advance(1./60,walk);check(trigger.rider().position.z<-4,"triggers do not block walking");
    geometry(root,{-4,1,-4},{4,2,4});Player roof(Terrain::load(root));roof.warp({0,4,0},{0,0,-1});roof.start_on_foot();check(std::abs(roof.rider().position.y-2)<.001,"non-rideable solid roof supports walking");for(unsigned i=0;i<60;++i)roof.advance(1./60,{});check(roof.rider().grounded&&std::abs(roof.rider().position.y-2)<.001,"walker remains on roof");
    std::cout<<"PASS: "<<checks<<" walking, board proximity, mount edges, dismount momentum, coast and collision checks\n";return 0;
}catch(const std::exception& e){std::cerr<<"FAIL: "<<e.what()<<'\n';return 1;}}
