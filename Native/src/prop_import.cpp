#include "import_internal.hpp"
#include "openslope/props.hpp"
#include <nlohmann/json.hpp>
#include <fstream>
#include <iomanip>
#include <sstream>

namespace openslope::import_detail {
namespace {
using Json=nlohmann::json;
std::vector<std::string> names(Bytes linker,const std::string& section,std::size_t count,bool anonymous){
    if(anonymous){std::vector<std::string> result;for(std::size_t i=0;i<count;++i)result.push_back(section+" "+std::to_string(i));return result;}
    if(!count)return {};std::istringstream input(linker.text(0,linker.data.size()));std::string line;bool active=false;std::vector<std::string> result;
    while(std::getline(input,line)){
        if(!active){if(line.find(section+" BEGIN")!=std::string::npos)active=true;continue;}
        if(line.find(section+" END")!=std::string::npos)break;
        if(line.empty()||line.front()=='\r'||line.front()=='#')continue;
        if(line.size()<82)throw std::runtime_error("Invalid object linker row");auto name=line.substr(0,82);while(!name.empty()&&name.back()==' ')name.pop_back();result.push_back(name);
        if(result.size()==count)break;
    }
    if(result.size()!=count)throw std::runtime_error("Object linker count disagrees with PBD");return result;
}
void write_json(const std::filesystem::path& path,const Json& value){std::ofstream file(path,std::ios::binary);file<<value.dump()<<'\n';if(!file)throw std::runtime_error("Cannot write object contract");}
Transform matrix(Bytes b,std::size_t p){Transform m{};for(unsigned i=0;i<16;++i)m[i]=b.number(p+i*4);return m;}
Json pose(const Transform& m){
    Vec3 scale{length({m[0],m[1],m[2]}),length({m[4],m[5],m[6]}),length({m[8],m[9],m[10]})};if(scale.x<1e-12||scale.y<1e-12||scale.z<1e-12)throw std::runtime_error("Singular object placement");
    if(dot(Vec3{m[0],m[1],m[2]},cross({m[4],m[5],m[6]},{m[8],m[9],m[10]}))<0)scale.x=-scale.x;
    const double a=m[0]/scale.x,b=m[4]/scale.y,c=m[8]/scale.z,d=m[1]/scale.x,e=m[5]/scale.y,f=m[9]/scale.z,g=m[2]/scale.x,h=m[6]/scale.y,i=m[10]/scale.z;
    std::array<double,4> q{};const auto trace=a+e+i;
    if(trace>0){const auto s=std::sqrt(trace+1)*2;q={(h-f)/s,(c-g)/s,(d-b)/s,s/4};}
    else if(a>e&&a>i){const auto s=std::sqrt(1+a-e-i)*2;q={s/4,(b+d)/s,(c+g)/s,(h-f)/s};}
    else if(e>i){const auto s=std::sqrt(1+e-a-i)*2;q={(b+d)/s,s/4,(f+h)/s,(c-g)/s};}
    else {const auto s=std::sqrt(1+i-a-e)*2;q={(c+g)/s,(f+h)/s,s/4,(d-b)/s};}
    return {{"Location",{m[12],m[13],m[14]}},{"Rotation",q},{"Scale",{scale.x,scale.y,scale.z}},{"TransformMatrix",m}};
}
std::size_t align16(std::size_t p){return (p+15)&~std::size_t(15);}
std::size_t unpack(Bytes data,std::size_t start,unsigned kind,unsigned count){
    // VIF words are IMM16, NUM8, CMD8. Masked UNPACK adds command bit 4.
    // Locate the bounded tag sequence, checking the declared array count.
    for(std::size_t p=start;p+4<=data.data.size()&&p<start+96;p+=4){const auto command=data.le(p+3,1)&0x6f;const auto number=data.le(p+2,1);if(command==kind&&(number?number:256)==count)return p+4;}
    throw std::runtime_error("Unsupported or invalid mesh array transfer");
}
void mesh(Bytes data,Vec3 extent,const std::filesystem::path& path,const ImportCancel& cancel){
    struct Point {Vec3 p,n;std::array<double,2> uv;};std::vector<Point> points;std::vector<std::array<std::size_t,3>> triangles;std::size_t cursor=0;
    while(cursor+64<=data.data.size()&&data.le(cursor+31,1)==0x6c){
        check_cancel(cancel);const auto strips=data.le(cursor+48),vertices=data.le(cursor+56);if(!strips||strips>256||!vertices||vertices>256)throw std::runtime_error("Invalid mesh chunk counts");
        const auto strip=unpack(data,cursor+64,0x66,strips);data.range(strip,std::size_t(strips)*2);
        const auto uv=unpack(data,align16(strip+std::size_t(strips)*2),0x65,vertices);data.range(uv,std::size_t(vertices)*4);
        const auto normals=unpack(data,align16(uv+std::size_t(vertices)*4),0x69,vertices);data.range(normals,std::size_t(vertices)*6);
        const auto positions=unpack(data,align16(normals+std::size_t(vertices)*6),0x69,vertices);data.range(positions,std::size_t(vertices)*6);const auto base=points.size();
        for(std::size_t v=0;v<vertices;++v)points.push_back({{data.signed16(positions+v*6)*extent.x/32768,data.signed16(positions+v*6+2)*extent.y/32768,data.signed16(positions+v*6+4)*extent.z/32768},{data.signed16(normals+v*6)/32768.,data.signed16(normals+v*6+2)/32768.,data.signed16(normals+v*6+4)/32768.},{data.signed16(uv+v*4)/4096.,1-data.signed16(uv+v*4+2)/4096.}});
        std::size_t begin=0;
        for(std::size_t s=0;s<strips;++s){const auto encoded=data.le(strip+s*2,1);if(data.le(strip+s*2+1,1)||encoded%3||encoded/3<3||begin+encoded/3>vertices)throw std::runtime_error("Invalid triangle strip");const auto count=encoded/3;for(std::size_t t=2;t<count;++t){const auto a=base+begin+t-2,b=base+begin+t-1,c=base+begin+t;triangles.push_back(t%2?std::array<std::size_t,3>{b,a,c}:std::array<std::size_t,3>{a,b,c});}begin+=count;}
        if(begin!=vertices)throw std::runtime_error("Strip table disagrees with vertex count");cursor=align16(positions+std::size_t(vertices)*6)+16;
        if(points.size()>4000000||triangles.size()>8000000)throw std::runtime_error("Imported object mesh exceeds its limits");
    }
    if(points.empty())throw std::runtime_error("Object mesh has no supported transfer chunks");std::ofstream file(path,std::ios::binary);file<<std::setprecision(9)<<"# OpenSlope portable mesh; raw centimetres, OBJ UV convention\n";
    for(const auto& p:points)file<<"v "<<p.p.x<<' '<<p.p.y<<' '<<p.p.z<<'\n';
    for(const auto& p:points)file<<"vt "<<p.uv[0]<<' '<<p.uv[1]<<'\n';
    for(const auto& p:points)file<<"vn "<<p.n.x<<' '<<p.n.y<<' '<<p.n.z<<'\n';
    for(const auto& triangle:triangles){file<<'f';for(auto i:triangle)file<<' '<<i+1<<'/'<<i+1<<'/'<<i+1;file<<'\n';}if(!file)throw std::runtime_error("Cannot write portable mesh");
}
Json animation(Bytes b,std::size_t p){
    b.range(p,36);Json a;for(unsigned i=0;i<6;++i)a["U"+std::to_string(i+1)]=b.number(p+i*4);const auto mask=b.le(p+24),count=b.le(p+28);if(mask>63||count>6||std::popcount(mask)!=int(count))throw std::runtime_error("Invalid model animation channels");a["AnimationAction"]=mask;a["AnimationEntries"]=Json::array();const auto table=p+b.le(p+32);b.range(table,count*4);
    // Channel pointer table is animation-relative; the segment-array offset
    // in each count/offset record is relative to that channel record.
    for(unsigned c=0;c<count;++c){const auto entry=p+b.le(table+c*4);const auto n=b.le(entry);const auto segments=entry+b.le(entry+4);if(n>100000)throw std::runtime_error("Invalid model animation segment count");b.range(segments,std::size_t(n)*24);Json rows=Json::array();for(unsigned s=0;s<n;++s){Json row;for(unsigned v=0;v<6;++v)row["Value"+std::to_string(v+1)]=b.number(segments+s*24+v*4);if(row["Value5"].get<double>()>row["Value6"].get<double>())throw std::runtime_error("Invalid animation time window");rows.push_back(row);}a["AnimationEntries"].push_back({{"AnimationMaths",rows}});}
    return a;
}
}
void write_props(const std::vector<std::uint8_t>& pbd,const std::vector<std::uint8_t>& linker,const std::vector<Image>& textures,const std::vector<std::uint8_t>* behavior,const std::filesystem::path& output,const ImportCancel& cancel,bool anonymous){
    // [Trailmap: 120-tables, 220-instance, 220-model-header, 220-chunk-layout,
    // 220-strips, 220-material-block, 230-joins, 230-props] Independent readers.
    Bytes b{pbd};const auto material_count=b.le(20),block_count=b.le(24),model_count=b.le(44),instance_count=b.le(12);
    if(material_count>65535||block_count>4000||model_count>4000||instance_count>100000)throw std::runtime_error("Invalid object import counts");Json materials=Json::array(),models=Json::array(),instances=Json::array();std::vector<std::vector<std::uint32_t>> blocks;auto block=b.le(84);
    for(unsigned i=0;i<block_count;++i){const auto count=b.le(block);block+=4;if(count>65535)throw std::runtime_error("Invalid material block length");b.range(block,std::size_t(count)*4);std::vector<std::uint32_t> row;for(unsigned j=0;j<count;++j){const auto id=b.le(block+j*4);if(id>=material_count)throw std::runtime_error("Material block references a missing material");row.push_back(id);}blocks.push_back(row);block+=count*4;}
    b.range(b.le(80),std::size_t(material_count)*72);
    for(unsigned i=0;i<material_count;++i){const auto p=b.le(80)+i*72;const auto texture=b.signed16(p);if(texture< -1||(texture>=0&&std::size_t(texture)>=textures.size()))throw std::runtime_error("Object material references a missing texture");materials.push_back({{"MaterialName","Material "+std::to_string(i)},{"TexturePath",texture<0?Json(nullptr):Json(textures[std::size_t(texture)].name+".png")},{"UnknownInt18",b.le(p+64)}});}
    const auto model_names=names(Bytes{linker},"MODELS",model_count,anonymous),instance_names=names(Bytes{linker},"INSTANCES",instance_count,anonymous);std::filesystem::create_directory(output/"Meshes");std::vector<std::uint32_t> model_blocks;std::size_t mesh_id=0;b.range(b.le(104),std::size_t(model_count)*4);
    for(unsigned i=0;i<model_count;++i){check_cancel(cancel);const auto start=std::size_t(b.le(108))+b.le(b.le(104)+i*4);const auto length=b.le(start),object_count=b.le(start+4);b.range(start,length);if(length<56||object_count>256)throw std::runtime_error("Invalid model record");Bytes model{b.data.subspan(start,length)};const auto material_block=model.le(12);if(material_block>=blocks.size())throw std::runtime_error("Model references a missing material block");model_blocks.push_back(material_block);Vec3 extent{model.number(24),model.number(28),model.number(32)};if(!extent.x)extent.x=1;if(!extent.y)extent.y=1;if(!extent.z)extent.z=1;Json objects=Json::array();const auto object_table=model.le(8);model.range(object_table,std::size_t(object_count)*24);
        for(unsigned j=0;j<object_count;++j){const auto o=object_table+j*24;Json object={{"ObjectName","Model Object "+std::to_string(j)},{"ParentID",static_cast<std::int32_t>(model.le(o))},{"MeshData",Json::array()},{"IncludeMatrix",false},{"IncludeAnimation",false},{"Position",nullptr},{"Rotation",nullptr},{"Scale",nullptr},{"Animation",nullptr}};
            const auto matrix_offset=static_cast<std::int32_t>(model.le(o+20));if(matrix_offset>=0){const auto value=pose(matrix(model,o+std::size_t(matrix_offset)));object["Position"]=value.at("Location");object["Rotation"]=value.at("Rotation");object["Scale"]=value.at("Scale");object["TransformMatrix"]=value.at("TransformMatrix");object["IncludeMatrix"]=true;}
            const auto anim=model.le(o+16);if(anim){object["Animation"]=animation(model,o+anim);object["IncludeAnimation"]=true;}
            const auto mesh_offset=static_cast<std::int32_t>(model.le(o+4));if(mesh_offset>0){const auto header=o+std::size_t(mesh_offset);const auto size=model.le(header),count=model.le(header+32);model.range(header,size);if(count>65535||size<44+count*4)throw std::runtime_error("Invalid object mesh header");object["Flags"]=model.le(header+28);object["CollisionBounds"]={{"Min",{model.number(header+4),model.number(header+8),model.number(header+12)}},{"Max",{model.number(header+16),model.number(header+20),model.number(header+24)}}};
                for(unsigned k=0;k<count;++k){const auto field=header+44+k*4,entry=field+model.le(field);model.range(entry,28);if(model.le(entry)!=28)throw std::runtime_error("Invalid mesh entry length");const auto slot=model.le(entry+4);if(slot>=blocks[material_block].size())throw std::runtime_error("Mesh material slot outside its block");const auto begin=std::size_t(b.le(132))+model.le(entry+12);const auto bytes=model.le(entry+8);b.range(begin,bytes);const auto name=std::to_string(mesh_id++)+".obj";mesh(Bytes{b.data.subspan(begin,bytes)},extent,output/"Meshes"/name,cancel);object["MeshData"].push_back({{"MeshPath",name},{"MaterialID",blocks[material_block][slot]}});}
            }
            objects.push_back(object);
        }
        models.push_back({{"ModelName",model_names[i]},{"AnimTime",model.number(20)},{"ModelObjects",objects}});
    }
    Bytes ssf{behavior?std::span<const std::uint8_t>(*behavior):std::span<const std::uint8_t>{}};if(behavior){ssf.range(0,76);if(ssf.le(4,2)!=0x1500||ssf.le(60)!=instance_count)throw std::runtime_error("Behavior file does not match object instances");ssf.range(ssf.le(64),std::size_t(instance_count)*4);ssf.range(ssf.le(56),std::size_t(ssf.le(52))*24);}
    b.range(b.le(72),std::size_t(instance_count)*256);
    for(unsigned i=0;i<instance_count;++i){check_cancel(cancel);const auto p=b.le(72)+i*256;auto row=pose(matrix(b,p));row["InstanceName"]=instance_names[i];row["ModelID"]=b.le(p+192);if(row["ModelID"].get<unsigned>()>=model_count)throw std::runtime_error("Instance references a missing model");if(b.le(p+240)!=model_blocks[row["ModelID"].get<unsigned>()])throw std::runtime_error("Per-instance material variants are not yet supported");row["Visable"]=true;
        if(behavior){const auto property=ssf.le(ssf.le(64)+i*4);if(property>=ssf.le(52))throw std::runtime_error("Invalid object properties join");row["Visable"]=(ssf.le(ssf.le(56)+property*24+10,2)&1)!=0;}
        for(unsigned key=0;key<4;++key){Json direction=Json::array(),colour=Json::array();for(unsigned axis=0;axis<4;++axis){direction.push_back(b.number(p+64+axis*16+key*4));colour.push_back(b.number(p+128+key*16+axis*4));}row[key<3?"LightVector"+std::to_string(key+1):"AmbentLightVector"]=direction;row[key<3?"LightColour"+std::to_string(key+1):"AmbentLightColour"]=colour;}
        instances.push_back(row);
    }
    write_json(output/"Models.json",{{"Models",models}});write_json(output/"Instances.json",{{"Instances",instances}});write_json(output/"Materials.json",{{"Materials",materials}});
}
}
