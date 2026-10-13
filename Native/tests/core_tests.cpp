#include "openslope/player.hpp"
#include <nlohmann/json.hpp>
#include <chrono>
#include <fstream>
#include <iostream>
#include <stdexcept>

namespace {
using namespace openslope;
unsigned checks=0;
void require(bool condition,const char* message) { ++checks;if(!condition) throw std::runtime_error(message); }
void near(double actual,double expected,double tolerance,const char* message) {
    ++checks;
    if(!(std::abs(actual-expected)<=tolerance))throw std::runtime_error(std::string(message)+": actual "+std::to_string(actual)+", expected "+std::to_string(expected));
}
Patch plane(double y=0,int surface=1) {
    Patch patch;patch.surface=surface;
    for(unsigned u=0;u<4;++u) for(unsigned v=0;v<4;++v) patch.points[u*4+v]={v*10.0/3,y,-double(u)*10.0/3};
    return patch;
}
void terrain_tests() {
    auto p=plane();
    near(length(p.evaluate(.25,.75)-Vec3{7.5,0,-2.5}),0,1e-12,"Bezier control-point ordering");
    near(length(p.normal(.3,.7)-Vec3{0,1,0}),0,1e-12,"Skyward analytic normal");
    auto terrain=Terrain({p});
    auto hit=terrain.intersect({7.5,2,-2.5},{7.5,-1,-2.5});
    require(hit.has_value()&&hit->refined,"Planar intersection");
    near(hit->u,.25,1e-12,"Planar u");near(hit->v,.75,1e-12,"Planar v");
    require(!terrain.intersect({20,2,-2},{20,-1,-2}),"Miss outside patch");
    require(!terrain.intersect({2,1,-2},{2,1,-2}),"Zero-length ray");
    for(unsigned u=0;u<4;++u) for(unsigned v=0;v<4;++v) p.points[u*4+v].y=(u==1||u==2?2.0:0)+(v==1||v==2?1.0:0);
    terrain=Terrain({p});
    const auto expected=p.evaluate(.37,.61);
    hit=terrain.intersect(expected+Vec3{0,2,0},expected-Vec3{0,2,0});
    require(hit.has_value()&&hit->refined,"Curved patch must refine");
    near(length(hit->point-expected),0,1e-7,"Curved hit must lie on the probe and surface");
    near(length(hit->normal-p.normal(.37,.61)),0,1e-7,"Curved normal must be analytic");
    std::vector<Patch> layers;
    for(int i=0;i<20;++i) layers.push_back(plane(i*.1));
    layers.push_back(plane(3,17));
    terrain=Terrain(std::move(layers));hit=terrain.intersect({5,4,-5},{5,-1,-5});
    require(hit.has_value(),"BVH must find hit");near(hit->point.y,1.9,1e-12,"Nearest hit excludes no-collision decoration");
    const auto mesh=Terrain({plane()}).mesh(2);
    require(mesh.vertices.size()==9&&mesh.indices.size()==24,"Mesh subdivision shape");
}
void map_tests() {
    const auto path=std::filesystem::temp_directory_path()/("openslope-native-test-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count())+".json");
    struct Cleanup { std::filesystem::path path;~Cleanup(){std::error_code ec;std::filesystem::remove(path,ec);} } cleanup{path};
    nlohmann::json row={{"PatchName","synthetic"},{"SurfaceType",1},{"TrickOnlyPatch",false},{"TexturePath",""},{"LightmapID",0},{"LightMapPoint",{0,0,1,1}},{"UVPoints",{{0,0},{1,0},{0,1},{1,1}}}};
    row["Points"]=nlohmann::json::array();
    for(unsigned u=0;u<4;++u) for(unsigned v=0;v<4;++v) row["Points"].push_back({-double(v)*100.0,u*100.0,1000.0});
    const auto write=[&]{std::ofstream file(path);file<<nlohmann::json{{"Patches",{row}}};};
    write();const auto terrain=Terrain::load(path);
    near(length(terrain.patches()[0].evaluate(1,1)-Vec3{3,10,-3}),0,1e-12,"Raw centimetres and axis mapping");
    row["Points"].erase(0);write();
    bool rejected=false;try{static_cast<void>(Terrain::load(path));}catch(const std::exception&){rejected=true;}
    require(rejected,"Reject incomplete control grid");
}
void response_tests(const char* fixture) {
    RideContract contract;
    std::ifstream stream(fixture);require(bool(stream),"Open scalar fixture");
    const auto document=nlohmann::json::parse(stream);
    require(document.at("schema")=="carving-response-cases/v1","Scalar fixture version");
    for(const auto& item:document.at("cases")) {
        const auto& input=item.at("surface");
        Surface surface;surface.type=input.at("type");surface.resistance_a=input.at("resistanceA");surface.resistance_b=input.at("resistanceB");surface.resistance_c=input.at("resistanceC");
        const auto& tuning=item.at("tuning");
        ResponseTuning t{tuning.at("linearStat"),tuning.at("quadraticStat"),tuning.at("skidStat"),tuning.at("lateralStat"),tuning.at("mode"),tuning.at("edge"),tuning.at("preferredEdge"),tuning.at("loadRatio"),tuning.at("skid")};
        const auto expected_forward=item.at("forwardAcceleration").get<double>(),expected_lateral=item.at("lateralAcceleration").get<double>();
        near(contract.forward_resistance(surface,item.at("u"),item.at("error"),item.at("budget"),item.at("charge"),item.at("boost"),t),expected_forward,2e-6*std::max(1.0,std::abs(expected_forward)),"Independent forward-resistance fixture");
        near(contract.lateral_resistance(input.at("drag"),item.at("u"),item.at("w"),item.at("lean"),item.at("boost"),t),expected_lateral,2e-6*std::max(1.0,std::abs(expected_lateral)),"Independent lateral-resistance fixture");
    }
    const auto& snow=contract.surface(1);
    near(contract.contact_response(snow,-snow.bog,0,snow.bog,snow.budget),snow.A/100,1e-12,"Bog-floor response units");
    near(contract.contact_response(snow,-snow.budget-1,0,snow.bog,snow.budget),3*snow.A/100,1e-12,"Deep-zone response cap");
    near(contract.contact_response(snow,.01,-1,snow.bog,snow.budget),-snow.A/30*.01+snow.P,1e-12,"Spec above-surface damping applies while approaching");
    const Vec3 v{10,-3,0};
    near(length(contract.redirect(v,{0,1,0},1)),length(v),1e-12,"Redirect preserves speed");
    near(length(contract.redirect(v,{0,1,0},3)-v),0,1e-12,"Powder skips redirect");
    near(contract.heading_yaw(1,.6,0,0,0,0,1.0/60),0,0,"Yaw has no authority at rest");
    near(contract.heading_yaw(1,.6,0,30,30,30,1.0/60),contract.response("yaw","capRadPerTick"),1e-12,"Yaw cap is per tick");
    require(contract.surface(-1).type==15&&contract.surface(25).type==15,"Unknown surface fallback");
    std::cout<<"Validated "<<document.at("cases").size()<<" independent carving cases\n";
}
void clock_tests() {
    for(const auto hz:{72,90,120,144}) {
        FixedClock clock;unsigned ticks=0;
        for(int i=0;i<hz*10;++i) ticks+=clock.advance(1.0/hz);
        require(ticks==600,"Simulation frequency independent of presentation rate");
        require(clock.alpha()>=0&&clock.alpha()<1,"Interpolation alpha bounded");
    }
    FixedClock clock;require(clock.advance(100)==6,"Suspend catch-up bounded");
    bool rejected=false;try{clock.advance(-1);}catch(const std::invalid_argument&){rejected=true;}
    require(rejected,"Reject negative frame duration");
    Player reference(Terrain::demo());for(int i=0;i<600;++i) reference.tick({});
    for(const auto hz:{72,90,120}) {
        Player candidate(Terrain::demo());
        for(int i=0;i<hz*10;++i) candidate.advance(1.0/hz,{});
        near(length(candidate.rider().position-reference.rider().position),0,1e-8,"Player fixed-tick frame-rate independence");
        require(finite(candidate.rider().position)&&finite(candidate.rider().velocity),"Finite prototype ride");
    }
}
}
int main(int argc,char** argv) {
    try {
        require(argc==2,"Supply the independent scalar fixtures");
        terrain_tests();map_tests();response_tests(argv[1]);clock_tests();
        std::cout<<"PASS: "<<checks<<" native conformance checks\n";return 0;
    }catch(const std::exception& e){std::cerr<<"FAIL: "<<e.what()<<'\n';return 1;}
}
