#include "openslope/collision.hpp"
#include <nlohmann/json.hpp>
#include <fstream>
#include <iostream>

namespace {
using namespace openslope;using Json=nlohmann::json;unsigned checks=0;
void require(bool value,const char* message){++checks;if(!value)throw std::runtime_error(message);}
void near(double a,double b,const char* message){require(std::abs(a-b)<1e-6,message);}
template<class F> void rejects(F operation,const char* message){bool rejected=false;try{operation();}catch(const std::exception&){rejected=true;}require(rejected,message);}
void write(const std::filesystem::path& path,const Json& doc){std::ofstream file(path);file<<doc;}
std::vector<WorldContact> sweep(const CollisionWorld& world,Vec3 a,Vec3 b,double radius=.25){const std::array<ProbeSphere,1> start{{{a,radius}}},end{{{b,radius}}};return world.sweep(start,end);}
Json body(double radius,const Json& levels,const char* masks){return {{"UFloat0",0},{"UFloat1",0},{"UFloat2",0},{"U2",0},{"uPhysicsStruct0",levels},{"UByteData",masks},{"UFloat3",radius*100}};}
}
int main(int argc,char** argv){
    try{
        require(argc>=2,"Supply a temporary fixture directory");const auto root=std::filesystem::path(argv[1])/"collision";std::filesystem::create_directories(root/"Collision");
        const Bounds box{{-1,-1,-1},{1,1,1}};const auto identity=identity_transform();
        const auto hit=swept_box(box,identity,{{-5,0,0},.5},{{5,0,0},.5});require(hit.has_value(),"Fast body sweep reaches a box face");near(hit->t,.35,"Box entry time");near(hit->normal.x,-1,"Box outward normal");near(hit->point.x,-1,"Box point lies on the face");
        require(!swept_box(box,identity,{{1.2,1.2,0},.5},{{1.2,1.2,0},.5}),"Square box edges do not admit a rounded corner");
        const auto inside=swept_box(box,identity,{{0,0,0},.5},{{0,0,0},.5});require(inside.has_value(),"Box interior contact");near(inside->depth,1.5,"Interior uses distance to nearest face plus radius");
        auto rotated=identity;rotated[0]=rotated[10]=0;rotated[2]=-1;rotated[8]=1;rotated[12]=7;
        const auto obb=swept_box(Bounds{{-2,-1,-.5},{2,1,.5}},rotated,{{3,0,0},.25},{{9,0,0},.25});require(obb.has_value(),"Query a rotated local box");near(obb->point.x,6.5,"Local bounds rotate before contact");
        const Vec3 a{-2,0,-2},b{2,0,-2},c{0,0,2};const auto face=swept_triangle(a,b,c,{{0,5,0},.25},{{0,-5,0},.25});require(face.has_value(),"Thin triangle swept contact");near(face->t,.475,"Triangle front face entry");
        const auto back=swept_triangle(c,b,a,{{0,-5,0},.25},{{0,5,0},.25});require(back.has_value(),"Double-sided proxy with reversed winding");near(back->t,.475,"Triangle back face entry");
        require(!swept_triangle(a,b,c,{{10,5,0},.25},{{10,-5,0},.25}),"Plane intersection outside triangle is not a face hit");
        const auto edge=swept_triangle(a,b,c,{{0,2,-2.2},.25},{{0,-2,-2.2},.25});require(edge.has_value(),"Triangle edge cylinder contact");near(edge->t,.4625,"Edge contact is earlier than the plane");
        const std::array<std::uint8_t,9> raw{129,0,0,0,0,0,0,0,0};require(occupancy_masks(raw,0,2)==std::vector<std::uint8_t>(raw.begin(),raw.end()),"Raw masks retain occupancy holes");
        const std::array<std::uint8_t,6> rle{255,129,7,0,0,0};require(occupancy_masks(rle,1,2)==std::vector<std::uint8_t>(raw.begin(),raw.end()),"Signed literal and count-plus-one repeated masks");
        rejects([&]{static_cast<void>(occupancy_masks(std::span(raw).first(8),0,2));},"Reject incomplete raw tree");
        const std::array<std::uint8_t,2> broken{255,129};rejects([&]{static_cast<void>(occupancy_masks(broken,1,2));},"Reject truncated compressed tree");
        auto affine=identity;affine[0]=2;affine[4]=.7;affine[5]=3;affine[10]=.5;affine[12]=4;const Vec3 original{2,3,4};near(length(transform_point(inverse_transform(affine),transform_point(affine,original))-original),0,"Invert scale, translation and shear");

        Json object={{"ParentID",-1},{"MeshData",Json::array({{{"MeshPath","unused.obj"},{"MaterialID",0}}})},{"CollisionBounds",{{"Min",{-100,-100,-100}},{"Max",{100,100,100}}}}};
        Json models={{"Models",Json::array({{{"ModelObjects",Json::array({object})}}})}};write(root/"Models.json",models);
        Json rows=Json::array();for(int i=0;i<7;++i)rows.push_back({{"ModelID",0},{"Location",{i*1000,0,0}},{"CollsionMode",i==1?1:i==2||i==3?3:2},{"PlayerCollision",i!=6},{"PlayerBounce",i!=5},{"U0",i==4?0:1},{"PlayerBounceAmmount",.5},{"SurfaceType",i==0?1:-1},{"EffectSlotIndex",7},{"Visable",false}});
        rows[1]["CollsionModelPaths"]={"plane.obj"};rows[2]["PhysicsIndex"]=0;rows[2]["Scale"]={2,1,.5};rows[3]["PhysicsIndex"]=1;
        write(root/"Instances.json",{{"Instances",rows}});std::ofstream(root/"Collision/plane.obj")<<"v -200 -200 0\nv 200 -200 0\nv 0 200 0\nvn 0 0 1\nf 1//1 2//1 3//1\n";
        Json physics={{"Schema","openslope-physics/v1"},{"PhysicsHeaders",Json::array({
            {{"PhysicsDatas",Json::array({body(1,Json::array({{{"U0",100},{"U1",0},{"U2",1}}}),"AA==")})}},
            {{"PhysicsDatas",Json::array({body(4,Json::array({{{"U0",400},{"U1",0},{"U2",1}},{{"U0",25},{"U1",100},{"U2",8}}}),"gQAAAAAAAAAA")})}}})}};write(root/"Physics.json",physics);
        auto world=CollisionWorld::load(root);require(world.objects()==6&&world.triangles()==1&&world.bodies()==2,"Load only collision-enabled placements with shared geometry");
        const auto contacts=sweep(world,{-5,0,0},{5,0,0});require(contacts.size()==1&&contacts[0].instance==0,"Hidden instance still collides");require(contacts[0].response&&contacts[0].effect==7,"Contact carries independent response and effect fields");
        const auto ray=world.ray({0,0,0},{3,0,0},true);require(ray.has_value(),"Inside-box ray exits the solid");near(ray->t,1./3,"Inside-box ray returns actual segment time");near(ray->point.x,1,"Inside-box ray point is on its segment");
        require(!world.ray({10,3,0},{10,-3,0},true),"Nonrideable proxy excluded from ground rays");require(world.ray({10,3,0},{10,-3,0}).has_value(),"Nonrideable proxy available to solid rays");
        const auto scaled=sweep(world,{25,0,0},{20,0,0});require(scaled.size()==1&&scaled[0].instance==2,"Query an affine occupancy sphere");near(scaled[0].t,.55,"Nonuniform body extent is retained");near(scaled[0].point.x,22,"Ellipsoid contact surface");
        const auto body_exit=world.ray({20,0,0},{23,0,0});require(body_exit.has_value(),"Inside ellipsoid ray exits the surface");near(body_exit->t,2./3,"Exact ellipsoid ray parameter");near(body_exit->point.x,22,"Ellipsoid ray point lies on its segment");
        require(sweep(world,{30,0,-5},{30,0,5}).empty(),"Hollow occupancy gap stays empty");require(!sweep(world,{31,1,-5},{31,1,2}).empty(),"Occupied octant remains solid");
        const auto pass=sweep(world,{35,0,0},{45,0,0});require(pass.size()==1&&!pass[0].response,"Zero mass suppresses response but retains contact");require(!world.ray({35,0,0},{45,0,0}),"Pass-through box does not become a solid ray surface");
        const auto flag=sweep(world,{45,0,0},{55,0,0});require(flag.size()==1&&!flag[0].response,"Bounce flag suppresses response independently");require(sweep(world,{55,0,0},{65,0,0}).empty(),"Player collision flag suppresses contact");
        const std::array<ProbeSphere,2> volume{{{{0,10,0},.25},{{0,0,0},.25}}};require(world.sweep(volume,volume).empty(),"Box mode tests only the body sphere");
        WorldContact response;response.normal={1,0,0};response.response=true;response.bounce=.5;response.depth=2;
        const auto bounce=collision_response(response,{-10,2,0},{0,1,0});near(bounce.impulse,15,"Authored restitution impulse");near(bounce.velocity.x,5,"Bounce normal speed");near(bounce.velocity.y,2,"Bounce retains tangent speed");near(bounce.position_delta.x,.2,"Ten percent penetration correction");require(!bounce.hard,"Ordinary hit is below hard impact threshold");
        require(collision_response(response,{-50,0,0},{0,1,0}).hard,"Hard impact threshold uses board orientation");response.response=false;near(collision_response(response,{-10,2,0},{0,1,0}).velocity.x,-10,"Contact-only response leaves velocity unchanged");
        auto bad=rows;bad[1]["CollsionModelPaths"]={"../outside.obj"};write(root/"Instances.json",{{"Instances",bad}});rejects([&]{static_cast<void>(collision_files(root));},"Reject proxy traversal before asset copying");
        bad=rows;bad[1]["CollsionModelPaths"]={"plane.obj","plane.obj","plane.obj"};write(root/"Instances.json",{{"Instances",bad}});rejects([&]{static_cast<void>(CollisionWorld::load(root));},"Reject ambiguous subobject mapping");write(root/"Instances.json",{{"Instances",rows}});
        require(collision_files(root)==std::vector<std::string>({"Collision/plane.obj"}),"Referenced proxy asset list is unique");
        require(CollisionWorld::load(root/"missing").objects()==0,"Terrain-only map has an empty collision world");
        for(int i=2;i<argc;++i){const auto map=CollisionWorld::load(argv[i]);std::cout<<"Loaded "<<std::filesystem::path(argv[i]).filename().string()<<": "<<map.objects()<<" objects, "<<map.triangles()<<" shared triangles, "<<map.bodies()<<" shared bodies\n";}
        std::cout<<"PASS: "<<checks<<" collision geometry, response, occupancy and map checks\n";return 0;
    }catch(const std::exception& e){std::cerr<<"FAIL: "<<e.what()<<'\n';return 1;}
}
