#include "import_internal.hpp"
#include <nlohmann/json.hpp>
#include <fstream>
#include <iomanip>

namespace openslope::import_detail {
namespace {
using Json=nlohmann::json;
std::string base64(std::span<const std::uint8_t> bytes){const char* alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";std::string out;out.reserve((bytes.size()+2)/3*4);for(std::size_t i=0;i<bytes.size();i+=3){const auto left=bytes.size()-i;const auto word=(unsigned(bytes[i])<<16)|(left>1?unsigned(bytes[i+1])<<8:0)|(left>2?bytes[i+2]:0);out+=alphabet[(word>>18)&63];out+=alphabet[(word>>12)&63];out+=left>1?alphabet[(word>>6)&63]:'=';out+=left>2?alphabet[word&63]:'=';}return out;}
Json read(const std::filesystem::path& path){std::ifstream file(path);return Json::parse(file);}
void write(const std::filesystem::path& path,const Json& doc){const auto text=doc.dump();if(text.size()>64*1024*1024)throw std::runtime_error("Collision metadata exceeds 64 MiB");std::ofstream file(path,std::ios::binary);file<<text<<'\n';if(!file)throw std::runtime_error("Cannot write collision metadata");}
std::size_t proxy(Bytes b,std::size_t p,const std::filesystem::path& path){
    const auto faces=b.le(p),vertices=b.le(p+4),padding=b.le(p+8);if(faces>1000000||vertices>1000000||padding>16)throw std::runtime_error("Collision proxy exceeds its limits");
    const auto indices=p+12,points=indices+std::size_t(faces)*12+padding,normals=points+std::size_t(vertices)*16,end=normals+std::size_t(faces)*16;b.range(p,end-p);
    std::ofstream file(path,std::ios::binary);file<<std::setprecision(9)<<"# OpenSlope authored collision proxy; raw centimetres\n";
    for(unsigned i=0;i<vertices;++i)file<<"v "<<b.number(points+i*16)<<' '<<b.number(points+i*16+4)<<' '<<b.number(points+i*16+8)<<'\n';
    for(unsigned i=0;i<faces;++i)file<<"vn "<<b.number(normals+i*16)<<' '<<b.number(normals+i*16+4)<<' '<<b.number(normals+i*16+8)<<'\n';
    for(unsigned i=0;i<faces;++i){file<<'f';for(unsigned j=0;j<3;++j){const auto index=b.le(indices+i*12+j*4);if(index>=vertices)throw std::runtime_error("Collision triangle index outside its vertex array");file<<' '<<index+1<<"//"<<i+1;}file<<'\n';}
    if(!file||file.tellp()>64*1024*1024)throw std::runtime_error("Cannot write bounded collision proxy");return end;
}
Json body(Bytes b,std::size_t& p){
    const auto padding=b.le(p),bytes=b.le(p+4),encoding=b.le(p+8);const auto depth=std::size_t(b.le(p+12))+1;if(padding>4||encoding>1||depth>7||bytes>1024*1024)throw std::runtime_error("Invalid physics body payload");b.range(p,112+depth*12+bytes+padding);
    Json row={{"U1",bytes},{"U2",encoding},{"U3",depth-1},{"uPhysicsStruct0",Json::array()}};for(unsigned i=0;i<24;++i)row["UFloat"+std::to_string(i)]=b.number(p+16+i*4);
    for(std::size_t i=0;i<depth;++i){const auto level=p+112+i*12;row["uPhysicsStruct0"].push_back({{"U0",b.number(level)},{"U1",b.number(level+4)},{"U2",b.le(level+8)}});}
    const auto data=p+112+depth*12;row["UByteData"]=base64(b.data.subspan(data,bytes));p=data+bytes+padding;return row;
}
}
void write_collision(const std::vector<std::uint8_t>& source,const std::filesystem::path& output,const ImportCancel& cancel){
    // [Trailmap: 230-pools, 230-proxy, 230-body, 230-props, 230-joins]
    // Pool entry byte-size is layout metadata; payload count determines traversal.
    Bytes b{source};b.range(0,76);if(b.le(4,2)!=0x1500)throw std::runtime_error("Invalid collision behavior tag");
    const auto proxy_count=b.le(28),body_count=b.le(20);if(proxy_count>4000||body_count>4000)throw std::runtime_error("Collision pool count exceeds its limit");b.range(b.le(32),std::size_t(proxy_count)*12);b.range(b.le(24),std::size_t(body_count)*12);
    std::filesystem::create_directory(output/"Collision");std::vector<std::vector<std::string>> names;std::size_t id=0;
    for(unsigned i=0;i<proxy_count;++i){check_cancel(cancel);const auto entry=b.le(32)+i*12,count=b.le(entry+8);std::size_t p=b.le(entry);if(count>256)throw std::runtime_error("Too many collision subobjects");std::vector<std::string> files;for(unsigned j=0;j<count;++j){check_cancel(cancel);const auto name=std::to_string(id++)+".obj";p=proxy(b,p,output/"Collision"/name);files.push_back(name);}names.push_back(std::move(files));}
    Json bodies=Json::array();for(unsigned i=0;i<body_count;++i){check_cancel(cancel);const auto entry=b.le(24)+i*12,count=b.le(entry+8);std::size_t p=b.le(entry);if(count>256)throw std::runtime_error("Too many physics subobjects");Json rows=Json::array();for(unsigned j=0;j<count;++j){check_cancel(cancel);rows.push_back(body(b,p));}bodies.push_back({{"PhysicsName","Physics Header "+std::to_string(i)},{"PhysicsDatas",rows}});}
    auto doc=read(output/"Instances.json");auto& instances=doc.at("Instances");if(instances.size()!=b.le(60))throw std::runtime_error("Collision instance join count differs");b.range(b.le(64),instances.size()*4);b.range(b.le(56),std::size_t(b.le(52))*24);
    for(std::size_t i=0;i<instances.size();++i){check_cancel(cancel);const auto property=b.le(b.le(64)+i*4);if(property>=b.le(52))throw std::runtime_error("Collision property index outside its table");const auto p=b.le(56)+property*24,flags=b.le(p+10,2);const auto mode=b.signed16(p+16),shape=b.signed16(p+18);if(mode<0||mode>3||shape< -1)throw std::runtime_error("Invalid collision mode or shape");auto& row=instances[i];row["U0"]=b.number(p);row["PlayerBounceAmmount"]=b.number(p+4);row["PlayerCollision"]=(flags&(1u<<5))!=0;row["PlayerBounce"]=(flags&(1u<<7))!=0;row["SurfaceType"]=static_cast<std::int32_t>(b.le(p+12));row["CollsionMode"]=mode;row["EffectSlotIndex"]=b.signed16(p+20);row["PhysicsIndex"]=mode==3?shape:-1;row["CollsionModelPaths"]=nullptr;
        if(mode==1&&shape>=0){if(std::size_t(shape)>=names.size())throw std::runtime_error("Missing collision proxy pool");row["CollsionModelPaths"]=names[std::size_t(shape)];}if(mode==3&&shape>=0&&std::size_t(shape)>=bodies.size())throw std::runtime_error("Missing physics body pool");
    }
    write(output/"Instances.json",doc);write(output/"Physics.json",{{"Schema","openslope-physics/v1"},{"PhysicsHeaders",bodies}});
}
}
