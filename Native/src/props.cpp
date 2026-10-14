#include "openslope/props.hpp"
#include "openslope/import.hpp"
#include <nlohmann/json.hpp>
#include <fstream>
#include <map>
#include <set>
#include <sstream>
#include <tuple>
#include <functional>
#include <bit>

namespace openslope {
namespace {
using Json=nlohmann::json;
Vec3 vector3(const Json& value){if(!value.is_array()||value.size()<3)throw std::runtime_error("Invalid prop vector");Vec3 v{value[0],value[1],value[2]};if(!finite(v))throw std::runtime_error("Non-finite prop vector");return v;}
Vec3 axes(Vec3 v){return {v.x,v.z,-v.y};}
std::string safe(const std::string& name){if(!valid_map_name(name))throw std::runtime_error("Unsafe prop asset filename");return name;}
std::filesystem::path asset(const std::filesystem::path& root,const std::string& relative){
    const auto base=std::filesystem::weakly_canonical(root),path=std::filesystem::weakly_canonical(base/relative),within=path.lexically_relative(base);
    if(within.empty()||within.is_absolute()||*within.begin()=="..")throw std::runtime_error("Prop asset resolves outside its course");return path;
}
Json json_file(const std::filesystem::path& path){if(std::filesystem::file_size(path)>64*1024*1024)throw std::runtime_error("Prop JSON exceeds 64 MiB");std::ifstream stream(path);return Json::parse(stream);}
struct Tables {Json models,instances,materials;};
std::string texture_name(const Json& material){const auto& name=material.at("TexturePath");return name.is_null()?std::string{}:name.get<std::string>();}
Tables tables(const std::filesystem::path& root,bool model_only=false){
    if(root.empty())return {};
    unsigned present=0;for(const auto name:{"Models.json","Instances.json","Materials.json"})if(!model_only||std::string_view(name)!="Instances.json")present+=std::filesystem::is_regular_file(root/name)?1:0;
    if(!present)return {};if(present!=(model_only?2u:3u))throw std::runtime_error("Incomplete model/placement/material tables");
    Tables t{json_file(asset(root,"Models.json")).at("Models"),model_only?Json::array():json_file(asset(root,"Instances.json")).at("Instances"),json_file(asset(root,"Materials.json")).at("Materials")};
    if(!t.models.is_array()||t.models.size()>4000||!t.instances.is_array()||t.instances.size()>100000||!t.materials.is_array()||t.materials.size()>65535)throw std::runtime_error("Invalid prop table counts");return t;
}
Transform row_pose(const Json& row){
    if(row.contains("TransformMatrix")){const auto matrix=row.at("TransformMatrix").get<Transform>();for(auto x:matrix)if(!std::isfinite(x))throw std::runtime_error("Invalid prop transform");if(std::abs(matrix[3])+std::abs(matrix[7])+std::abs(matrix[11])+std::abs(matrix[15]-1)>1e-5)throw std::runtime_error("Prop transform must be affine");return matrix;}
    const auto location=row.contains("Location")?"Location":"Position";
    const auto p=row.contains(location)&&!row.at(location).is_null()?vector3(row.at(location)):Vec3{};
    const auto s=row.contains("Scale")&&!row.at("Scale").is_null()?vector3(row.at("Scale")):Vec3{1,1,1};
    const auto q=row.contains("Rotation")&&!row.at("Rotation").is_null()?row.at("Rotation").get<std::array<double,4>>():std::array<double,4>{0,0,0,1};return placement(p,q,s);
}
Transform object_pose(const Json& row){
    if(!row.value("IncludeAnimation",false)||!row.contains("Animation")||row.at("Animation").is_null())return row_pose(row);
    // [Trailmap: 120-anim-base, 120-euler-order] Static snapshot at clip time zero.
    const auto& a=row.at("Animation");std::array<double,6> values{a.value("U1",0.),a.value("U2",0.),a.value("U3",0.),0,0,0};
    const auto mask=a.value("AnimationAction",0u);if(mask>63||a.at("AnimationEntries").size()!=std::size_t(std::popcount(mask)))throw std::runtime_error("Invalid static animation channels");unsigned entry=0;
    for(unsigned channel=0;channel<6;++channel)if(mask&(1u<<channel)){
        const auto& segments=a.at("AnimationEntries").at(entry++).at("AnimationMaths");if(segments.empty())continue;
        const auto& s=segments.front();const auto start=s.at("Value5").get<double>(),end=s.at("Value6").get<double>();if(!std::isfinite(start)||!std::isfinite(end)||start>end)throw std::runtime_error("Invalid static animation time window");const auto time=std::clamp(0.0,start,end);
        values[channel]=((s.at("Value1").get<double>()*time+s.at("Value2").get<double>())*time+s.at("Value3").get<double>())*time+s.at("Value4").get<double>();
    }
    const auto x=values[3]*pi/360,y=values[4]*pi/360,z=values[5]*pi/360;
    const auto sx=std::sin(x),cx=std::cos(x),sy=std::sin(y),cy=std::cos(y),sz=std::sin(z),cz=std::cos(z);
    return placement({values[0],values[1],values[2]},{sx*cy*cz-cx*sy*sz,cx*sy*cz+sx*cy*sz,cx*cy*sz-sx*sy*cz,cx*cy*cz+sx*sy*sz},{1,1,1});
}
Vec3 normal_transform(const Transform& m,Vec3 n){
    const Vec3 a{m[0],m[1],m[2]},b{m[4],m[5],m[6]},c{m[8],m[9],m[10]};const auto determinant=dot(a,cross(b,c));
    if(std::abs(determinant)<1e-12)throw std::runtime_error("Singular model rest transform");
    // Preserve the packed normal at identity; inverse transpose for rest scale.
    return (cross(b,c)*n.x+cross(c,a)*n.y+cross(a,b)*n.z)/determinant;
}
int index(const std::string& field,std::size_t size){if(field.empty())return -1;std::size_t used=0;const int value=std::stoi(field,&used);const auto i=value>0?value-1:static_cast<int>(size)+value;if(used!=field.size()||!value||i<0||std::size_t(i)>=size)throw std::runtime_error("OBJ index outside its array");return i;}
void mesh_file(Props& props,const std::filesystem::path& path,const Transform& rest,PropPart& part,Bounds& bounds){
    if(std::filesystem::file_size(path)>64*1024*1024)throw std::runtime_error("OBJ exceeds 64 MiB");std::ifstream file(path);std::string line;
    std::vector<Vec3> points,normals;std::vector<std::array<double,2>> uv;std::map<std::tuple<int,int,int>,std::uint32_t> vertices;
    part.first=static_cast<std::uint32_t>(props.geometry.indices.size());
    while(std::getline(file,line)){
        if(line.size()>1024*1024)throw std::runtime_error("OBJ line exceeds limit");std::istringstream input(line);std::string kind;input>>kind;
        if(kind=="v"||kind=="vn"){Vec3 v;if(!(input>>v.x>>v.y>>v.z)||!finite(v)||length(v)>1e9)throw std::runtime_error("Invalid OBJ vector");(kind=="v"?points:normals).push_back(v);}
        else if(kind=="vt"){std::array<double,2> v;if(!(input>>v[0]>>v[1])||!std::isfinite(v[0])||!std::isfinite(v[1])||std::abs(v[0])+std::abs(v[1])>1e6)throw std::runtime_error("Invalid OBJ UV");uv.push_back(v);}
        else if(kind=="f"){
            std::vector<std::tuple<int,int,int>> face;std::string token;
            while(input>>token){if(token.starts_with('#'))break;const auto a=token.find('/'),b=a==std::string::npos?std::string::npos:token.find('/',a+1);const auto p=index(token.substr(0,a),points.size()),t=a==std::string::npos?-1:index(token.substr(a+1,b==std::string::npos?b:b-a-1),uv.size()),n=b==std::string::npos?-1:index(token.substr(b+1),normals.size());face.emplace_back(p,t,n);if(face.size()>64)throw std::runtime_error("OBJ polygon exceeds 64 corners");}
            if(face.size()<3)throw std::runtime_error("OBJ face has fewer than three corners");
            for(std::size_t triangle=1;triangle+1<face.size();++triangle){
                const auto normal=normalized(cross(points[std::get<0>(face[triangle])]-points[std::get<0>(face[0])],points[std::get<0>(face[triangle+1])]-points[std::get<0>(face[0])]));
                for(const auto& corner:{face[0],face[triangle],face[triangle+1]}){
                    const auto [p,t,n]=corner;auto found=n<0?vertices.end():vertices.find(corner);
                    std::uint32_t vertex;
                    if(found==vertices.end()){
                        const auto position=axes(transform_point(rest,points[std::size_t(p)]))/100;const auto shaded=normal_transform(rest,n<0?normal:normals[std::size_t(n)]);const auto tex=t<0?std::array<double,2>{0,0}:uv[std::size_t(t)];
                        vertex=static_cast<std::uint32_t>(props.geometry.vertices.size());props.geometry.vertices.push_back({float(position.x),float(position.y),float(position.z),1,1,1,float(tex[0]),float(1-tex[1]),0,0,0,0,0,0,float(shaded.x),float(shaded.y),float(shaded.z)});bounds.add(position);if(n>=0)vertices.emplace(corner,vertex);
                    }else vertex=found->second;
                    props.geometry.indices.push_back(vertex);
                    if(props.geometry.vertices.size()*sizeof(Vertex)+props.geometry.indices.size()*4>256*1024*1024)throw std::runtime_error("Prop geometry exceeds 256 MiB");
                }
            }
        }
        if(points.size()+normals.size()+uv.size()>8000000)throw std::runtime_error("OBJ arrays exceed their limit");
    }
    part.count=static_cast<std::uint32_t>(props.geometry.indices.size())-part.first;
}
}
Transform identity_transform(){Transform m{};m[0]=m[5]=m[10]=m[15]=1;return m;}
Transform multiply(const Transform& a,const Transform& b){Transform m{};for(unsigned c=0;c<4;++c)for(unsigned r=0;r<4;++r)for(unsigned k=0;k<4;++k)m[c*4+r]+=a[k*4+r]*b[c*4+k];return m;}
Vec3 transform_point(const Transform& m,Vec3 p){return {m[0]*p.x+m[4]*p.y+m[8]*p.z+m[12],m[1]*p.x+m[5]*p.y+m[9]*p.z+m[13],m[2]*p.x+m[6]*p.y+m[10]*p.z+m[14]};}
Transform placement(Vec3 p,std::array<double,4> q,Vec3 s){
    if(!finite(p)||!finite(s))throw std::runtime_error("Invalid prop placement");double length2=0;for(auto v:q){if(!std::isfinite(v))throw std::runtime_error("Invalid prop quaternion");length2+=v*v;}if(length2<1e-20)throw std::runtime_error("Zero prop quaternion");for(auto& v:q)v/=std::sqrt(length2);
    const auto x=q[0],y=q[1],z=q[2],w=q[3];auto m=identity_transform();m[0]=(1-2*(y*y+z*z))*s.x;m[1]=2*(x*y+w*z)*s.x;m[2]=2*(x*z-w*y)*s.x;m[4]=2*(x*y-w*z)*s.y;m[5]=(1-2*(x*x+z*z))*s.y;m[6]=2*(y*z+w*x)*s.y;m[8]=2*(x*z+w*y)*s.z;m[9]=2*(y*z-w*x)*s.z;m[10]=(1-2*(x*x+y*y))*s.z;m[12]=p.x;m[13]=p.y;m[14]=p.z;return m;
}
Transform map_transform(Transform raw){auto b=identity_transform();b[5]=b[10]=0;b[6]=-1;b[9]=1;auto inverse=b;inverse[6]=1;inverse[9]=-1;raw[12]/=100;raw[13]/=100;raw[14]/=100;return multiply(multiply(b,raw),inverse);}
Transform inverse_transform(const Transform& m){
    const Vec3 a{m[0],m[1],m[2]},b{m[4],m[5],m[6]},c{m[8],m[9],m[10]};const auto det=dot(a,cross(b,c));if(std::abs(det)<1e-12)throw std::runtime_error("Singular collision placement");
    const auto x=cross(b,c)/det,y=cross(c,a)/det,z=cross(a,b)/det;auto result=identity_transform();result[0]=x.x;result[4]=x.y;result[8]=x.z;result[1]=y.x;result[5]=y.y;result[9]=y.z;result[2]=z.x;result[6]=z.y;result[10]=z.z;
    const auto p=transform_point(result,{m[12],m[13],m[14]});result[12]=-p.x;result[13]=-p.y;result[14]=-p.z;return result;
}
Vec3 transform_normal(const Transform& m,Vec3 n){return normal_transform(m,n);}
std::vector<Transform> prop_placements(const std::filesystem::path& root){std::vector<Transform> result;if(root.empty()||!std::filesystem::exists(root/"Instances.json"))return result;const auto doc=json_file(asset(root,"Instances.json"));for(const auto& row:doc.at("Instances"))result.push_back(map_transform(row_pose(row)));return result;}
std::vector<std::vector<PropObjectLayout>> prop_layout(const std::filesystem::path& root,std::span<const std::size_t> box_models){
    std::vector<std::vector<PropObjectLayout>> result;if(root.empty()||!std::filesystem::exists(root/"Models.json"))return result;const auto doc=json_file(asset(root,"Models.json"));const auto& models=doc.at("Models");if(!models.is_array()||models.size()>4000)throw std::runtime_error("Invalid collision model count");
    for(std::size_t id=0;id<models.size();++id){const auto& model=models[id];const bool needs_bounds=std::find(box_models.begin(),box_models.end(),id)!=box_models.end();const auto& rows=model.at("ModelObjects");if(!rows.is_array()||rows.size()>256)throw std::runtime_error("Invalid collision object count");std::vector<PropObjectLayout> objects(rows.size());std::vector<unsigned> state(rows.size());
        std::function<Transform(std::size_t)> resolve=[&](std::size_t i){if(state[i]==1)throw std::runtime_error("Cyclic collision hierarchy");if(state[i]==2)return objects[i].rest;state[i]=1;auto m=object_pose(rows[i]);const auto parent=rows[i].value("ParentID",-1);if(parent< -1||parent>=int(rows.size()))throw std::runtime_error("Invalid collision parent");if(parent>=0)m=multiply(resolve(std::size_t(parent)),m);state[i]=2;return objects[i].rest=m;};
        for(std::size_t i=0;i<rows.size();++i){resolve(i);auto& object=objects[i];object.has_geometry=!rows[i].at("MeshData").empty();if(!needs_bounds||(!object.has_geometry&&!rows[i].contains("CollisionBounds")))continue;
            Bounds raw;if(rows[i].contains("CollisionBounds")){raw.min=vector3(rows[i].at("CollisionBounds").at("Min"));raw.max=vector3(rows[i].at("CollisionBounds").at("Max"));if(raw.min.x>raw.max.x||raw.min.y>raw.max.y||raw.min.z>raw.max.z)throw std::runtime_error("Invalid authored collision bounds");}
            else for(const auto& part:rows[i].at("MeshData")){const auto path=asset(root,"Meshes/"+safe(part.at("MeshPath")));if(std::filesystem::file_size(path)>64*1024*1024)throw std::runtime_error("Collision box source exceeds 64 MiB");std::ifstream file(path);std::string line;while(std::getline(file,line)){if(line.size()>1024*1024)throw std::runtime_error("Collision box line too long");std::istringstream input(line);std::string type;input>>type;if(type=="v"){Vec3 p;if(!(input>>p.x>>p.y>>p.z)||!finite(p))throw std::runtime_error("Invalid collision box vertex");raw.add(p);}}}
            if(!finite(raw.min)||!finite(raw.max))throw std::runtime_error("Collision object has no local bounds");object.has_box=true;for(unsigned corner=0;corner<8;++corner)object.box.add(axes({corner&1?raw.max.x:raw.min.x,corner&2?raw.max.y:raw.min.y,corner&4?raw.max.z:raw.min.z})/100);
        }result.push_back(std::move(objects));
    }return result;
}
std::vector<std::string> prop_files(const std::filesystem::path& root,bool model_only){
    const auto t=tables(root,model_only);if(t.models.is_null())return {};std::set<std::string> names;
    for(const auto& model:t.models)for(const auto& object:model.at("ModelObjects"))for(const auto& part:object.at("MeshData")){names.insert("Meshes/"+safe(part.at("MeshPath")));const auto id=part.at("MaterialID").get<std::size_t>();const auto name=texture_name(t.materials.at(id));if(!name.empty())names.insert("Textures/"+safe(name));}
    return {names.begin(),names.end()};
}
Props Props::load(const std::filesystem::path& root,bool model_only){
    Props result;const auto t=tables(root,model_only);if(t.models.is_null())return result;result.models.resize(t.models.size());result.geometry.map_root=root;
    for(std::size_t model=0;model<t.models.size();++model){
        const auto& objects=t.models[model].at("ModelObjects");if(!objects.is_array()||objects.size()>256)throw std::runtime_error("Invalid model object count");std::vector<Transform> rest(objects.size());std::vector<unsigned> state(objects.size());
        std::function<Transform(std::size_t)> resolve=[&](std::size_t i){if(state[i]==1)throw std::runtime_error("Model hierarchy contains a cycle");if(state[i]==2)return rest[i];state[i]=1;auto m=object_pose(objects[i]);const auto parent=objects[i].value("ParentID",-1);if(parent< -1)throw std::runtime_error("Invalid model parent");if(parent>=0){if(std::size_t(parent)>=objects.size())throw std::runtime_error("Invalid model parent");m=multiply(resolve(std::size_t(parent)),m);}state[i]=2;return rest[i]=m;};
        for(std::size_t i=0;i<objects.size();++i)resolve(i);
        for(std::size_t i=0;i<objects.size();++i)for(const auto& data:objects[i].at("MeshData")){
            const auto material=data.at("MaterialID").get<std::size_t>();const auto& mat=t.materials.at(material);PropPart part;part.texture=texture_name(mat);if(!part.texture.empty())safe(part.texture);part.flags=mat.value("UnknownInt18",0u);
            mesh_file(result,asset(root,"Meshes/"+safe(data.at("MeshPath"))),resolve(i),part,result.models[model].bounds);if(!part.count)continue;
            result.models[model].parts.push_back(result.parts.size());result.parts.push_back(std::move(part));
        }
    }
    auto basis=identity_transform();basis[5]=basis[10]=0;basis[6]=-1;basis[9]=1;auto inverse=basis;inverse[6]=1;inverse[9]=-1;
    for(const auto& row:t.instances){
        PropInstance instance;instance.model=row.at("ModelID").get<std::size_t>();if(instance.model>=result.models.size())throw std::runtime_error("Prop instance references a missing model");instance.visible=row.value("Visable",true);
        auto raw=row_pose(row);raw[12]/=100;raw[13]/=100;raw[14]/=100;const auto world=multiply(multiply(basis,raw),inverse);for(unsigned i=0;i<16;++i)instance.pose.matrix[i]=float(world[i]);
        const auto ambient=row.contains("AmbentLightColour")?vector3(row.at("AmbentLightColour")):Vec3{256,256,256};instance.pose.ambient={float(ambient.x/256),float(ambient.y/256),float(ambient.z/256),0};
        for(unsigned key=0;key<3;++key){const auto colour="LightColour"+std::to_string(key+1),direction="LightVector"+std::to_string(key+1);if(row.contains(colour)){const auto c=vector3(row.at(colour)),d=vector3(row.at(direction));instance.pose.colour[key]={float(c.x/256),float(c.y/256),float(c.z/256),0};instance.pose.direction[key]={float(d.x),float(d.y),float(d.z),0};}}
        const auto& box=result.models[instance.model].bounds;if(!result.models[instance.model].parts.empty())for(unsigned corner=0;corner<8;++corner)instance.bounds.add(transform_point(world,{corner&1?box.max.x:box.min.x,corner&2?box.max.y:box.min.y,corner&4?box.max.z:box.min.z}));
        result.instances.push_back(instance);
    }
    return result;
}
bool prop_visible(const Bounds& b,std::span<const float,16> camera,Vec3 eye,double range){
    const auto delta=Vec3{std::clamp(eye.x,b.min.x,b.max.x),std::clamp(eye.y,b.min.y,b.max.y),std::clamp(eye.z,b.min.z,b.max.z)}-eye;if(dot(delta,delta)>range*range)return false;
    std::array<unsigned,6> outside{};
    for(unsigned corner=0;corner<8;++corner){const Vec3 p{corner&1?b.max.x:b.min.x,corner&2?b.max.y:b.min.y,corner&4?b.max.z:b.min.z};std::array<double,4> clip{};for(unsigned r=0;r<4;++r)clip[r]=camera[r]*p.x+camera[4+r]*p.y+camera[8+r]*p.z+camera[12+r];const auto x=clip[0],y=clip[1],z=clip[2],w=clip[3];outside[0]+=x< -w;outside[1]+=x>w;outside[2]+=y< -w;outside[3]+=y>w;outside[4]+=z<0;outside[5]+=z>w;}
    return std::none_of(outside.begin(),outside.end(),[](auto count){return count==8;});
}
std::array<double,3> prop_light(Vec3 normal,const PropPose& pose){
    std::array<double,3> result{pose.ambient[0],pose.ambient[1],pose.ambient[2]};for(unsigned key=0;key<3;++key){const auto& d=pose.direction[key];const auto amount=std::max(0.0,dot(normal,{d[0],d[1],d[2]}));for(unsigned c=0;c<3;++c)result[c]+=amount*pose.colour[key][c];}for(auto& c:result)c=std::clamp(c,0.0,255./128);return result;
}
}
