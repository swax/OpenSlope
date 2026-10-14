#include "import_internal.hpp"
#include <nlohmann/json.hpp>
#include <fstream>

namespace openslope::import_detail {
namespace {
using Json=nlohmann::json;
std::string identity(const char* kind,std::size_t index){return std::string(kind)+":"+std::to_string(index);}
Json reference(const char* kind,std::int64_t index,std::size_t count){return index<0||std::uint64_t(index)>=count?Json(nullptr):Json(identity(kind,std::size_t(index)));}
Json fields(Bytes bytes,std::size_t offset,const std::string& layout){Json result=Json::object();for(std::size_t i=0;i<layout.size();++i)result["U"+std::to_string(i)]=layout[i]=='f'?Json(bytes.number(offset+i*4)):Json(static_cast<std::int32_t>(bytes.le(offset+i*4)));return result;}
Json node(Bytes bytes,std::size_t at,std::size_t size,std::size_t index,const std::string& prefix,const std::array<std::size_t,8>& counts){
    const auto main=bytes.le(at);const auto p=at+8;Json payload=Json::object(),refs=Json::object(),words=Json::array();for(std::size_t i=0;i<size;i+=4)words.push_back(bytes.le(at+i));
    const auto require=[&](std::size_t length){if(size<length)throw std::runtime_error("World logic node is shorter than its payload");};
    if(main==0){require(12);const auto sub=bytes.le(p);Json property={{"SubType",sub}};
        const std::map<unsigned,std::string> layouts{{0,"ffffff"},{13,"ifff"},{14,"ff"},{15,"fffff"},{17,"iii"},{18,"fffffff"},{20,"iffiiiffff"},{24,"iffffffffffffffffff"},{256,"ifffffii"},{257,"iiffffii"},{258,"ifffffiifffi"}};
        if(const auto found=layouts.find(sub);found!=layouts.end()){require(12+found->second.size()*4);property[sub==17?"CrowdEffect":"type0Sub"+std::to_string(sub)]=fields(bytes,p+4,found->second);}
        else if(sub==2){require(16);property["Debounce"]=bytes.number(p+4);}
        else if(sub==5){require(16);property["DeadNodeMode"]=bytes.le(p+4);}
        else if(sub==6){require(20);property["Counter"]={{"Count",bytes.le(p+4)},{"U1",bytes.number(p+8)}};}
        else if(sub==7){require(40);property["Boost"]={{"Mode",bytes.le(p+4)},{"U1",bytes.number(p+8)},{"U2",bytes.number(p+12)},{"BoostAmount",bytes.number(p+16)},{"BoostDir",{bytes.number(p+20),bytes.number(p+24),bytes.number(p+28)}}};}
        else if(sub==10){require(36);property["UVScroll"]=fields(bytes,p+4,"ifffff");}
        else if(sub==11){require(32);property["TextureFlip"]={{"U0",bytes.le(p+4)},{"Direction",bytes.le(p+8)},{"Speed",bytes.number(p+12)},{"Length",bytes.number(p+16)},{"U4",bytes.le(p+20)}};}
        else if(sub==12){require(20);property["Fence"]={{"U0",bytes.le(p+4)},{"FlexAmmount",bytes.number(p+8)}};}
        payload["type0"]=property;
    }else if(main==2){require(12);const auto sub=bytes.le(p);Json emitter={{"SubType",sub}};
        if(sub==0){require(216);emitter["type2Sub0"]=fields(bytes,p+4,"ii"+std::string(47,'f')+"ii");}
        else if(sub==1){require(56);emitter["SplineAnimation"]={{"SplineIndex",bytes.le(p+4)},{"U1",bytes.le(p+8)},{"U2",bytes.le(p+12)},{"InstanceCount",bytes.le(p+16)},{"AnimationSpeed",bytes.number(p+20)},{"U5",bytes.number(p+24)},{"U6",bytes.le(p+28)},{"U7",bytes.number(p+32)},{"R",bytes.number(p+36)},{"G",bytes.number(p+40)},{"B",bytes.number(p+44)}};refs["spline"]=reference("spline",bytes.le(p+4),counts[7]);}
        else if(sub==2){require(216);emitter["type2Sub2"]=fields(bytes,p+4,std::string(51,'i'));}payload["type2"]=emitter;
    }else if(main==3||main==9){require(16);payload["type"+std::to_string(main)]=fields(bytes,p,"if");}
    else if(main==4){require(12);payload["WaitTime"]=bytes.number(p);}
    else if(main==5){require(20);payload["type5"]=fields(bytes,p,"ifi");}
    else if(main==7){require(16);payload["Instance"]={{"InstanceIndex",bytes.le(p)},{"EffectIndex",bytes.le(p+4)}};refs["instance"]=reference("instance",bytes.le(p),counts[6]);refs["effectGraph"]=reference("graph",bytes.le(p+4),counts[3]);}
    else if(main==8){require(12);payload["SoundPlay"]=bytes.le(p);}
    else if(main==13||main==14||main==17||main==18){require(12);payload[main==14?"MultiplierScore":"type"+std::to_string(main)]=bytes.number(p);}
    else if(main==21||main==26){require(12);payload["FunctionRunIndex"]=bytes.le(p);refs["function"]=reference("function",bytes.le(p),counts[4]);}
    else if(main==24){require(12);payload["TeleportInstanceIndex"]=bytes.le(p);refs["instance"]=reference("instance",bytes.le(p),counts[6]);}
    else if(main==25){require(16);payload["Spline"]={{"SplineIndex",bytes.le(p)},{"Effect",bytes.le(p+4)}};refs["spline"]=reference("spline",bytes.le(p),counts[7]);}
    return {{"id",prefix+"/node:"+std::to_string(index)},{"originalIndex",index},{"mainType",main},{"payload",payload},{"references",refs},{"extensions",{{"nativeWords",words}}}};
}
}
std::string logic_document(std::span<const std::uint8_t> source,const std::string& course,const ImportCancel& cancel){
    // Clean 150/230: independent chain-relative tables, counted byte-size frames.
    Bytes bytes{source};bytes.range(0,76);if(bytes.le(4,2)!=0x1500)throw std::runtime_error("Invalid world logic tag");std::array<std::size_t,8> counts{},offsets{};
    for(unsigned i=0;i<8;++i){counts[i]=bytes.le(12+i*8);offsets[i]=bytes.le(16+i*8);const auto limit=i==6?100000u:8192u;if(counts[i]>limit)throw std::runtime_error("World logic table exceeds its limit");}
    const std::array<std::size_t,8> strides{28,12,12,8,24,24,4,8};for(unsigned i=0;i<8;++i)bytes.range(offsets[i],counts[i]*strides[i]);
    Json doc={{"$schema","openslope-effects-v1.schema.json"},{"kind","openslope-effects"},{"version",1},{"target",{{"game","tricky"},{"platform","ps2"},{"region","unknown"},{"level",course}}},{"header",{{"U1",bytes.le(0)},{"U2",bytes.le(4)},{"U3",bytes.number(8)}}}};
    for(const auto name:{"slots","graphs","functions","objectProperties","instances","physics","collisionModels","splines"})doc[name]=Json::array();
    const auto base=offsets[3]+counts[3]*8;std::size_t total=0;
    for(const auto table:{3u,4u})for(std::size_t i=0;i<counts[table];++i){check_cancel(cancel);const auto at=offsets[table]+i*strides[table];const auto count=bytes.le(at);if(count>10000||total+count>100000)throw std::runtime_error("World logic chain exceeds its limit");total+=count;const auto prefix=identity(table==3?"graph":"function",i);Json chain={{"id",prefix},{"originalIndex",i},{"nodes",Json::array()}};
        if(table==4){auto name=bytes.text(at+8,16);if(const auto end=name.find('\0');end!=std::string::npos)name.resize(end);chain["name"]=name;}
        std::size_t p=base+bytes.le(at+4);for(std::size_t n=0;n<count;++n){check_cancel(cancel);const auto size=bytes.le(p+4);if(size<8||size>65536||size%4)throw std::runtime_error("Invalid world logic node frame");bytes.range(p,size);chain["nodes"].push_back(node(bytes,p,size,n,prefix,counts));p+=size;}doc[table==3?"graphs":"functions"].push_back(chain);
    }
    const std::array<const char*,7> columns{"persistent","collision","slot3","slot4","trigger","slot6","slot7"};for(std::size_t i=0;i<counts[0];++i){Json circumstances;for(unsigned c=0;c<7;++c)circumstances[columns[c]]=reference("graph",static_cast<std::int32_t>(bytes.le(offsets[0]+i*28+c*4)),counts[3]);doc["slots"].push_back({{"id",identity("slot",i)},{"originalIndex",i},{"circumstances",circumstances}});}
    for(std::size_t i=0;i<counts[5];++i){const auto p=offsets[5]+i*24;Json data={{"U0",bytes.number(p)},{"PlayerBounceAmmount",bytes.number(p+4)},{"U2",bytes.le(p+8,2)},{"Flags",bytes.le(p+10,2)},{"SurfaceType",static_cast<std::int32_t>(bytes.le(p+12))},{"CollsionMode",bytes.signed16(p+16)},{"ShapeIndex",bytes.signed16(p+18)},{"EffectSlotIndex",bytes.signed16(p+20)},{"U7",bytes.signed16(p+22)}};Json refs={{"effectSlot",reference("slot",bytes.signed16(p+20),counts[0])},{"physics",bytes.signed16(p+16)==3?reference("physics",bytes.signed16(p+18),counts[1]):Json(nullptr)},{"collisionModel",bytes.signed16(p+16)==1?reference("collision",bytes.signed16(p+18),counts[2]):Json(nullptr)}};doc["objectProperties"].push_back({{"id",identity("property",i)},{"originalIndex",i},{"data",data},{"references",refs}});}
    for(std::size_t i=0;i<counts[6];++i)doc["instances"].push_back({{"id",identity("instance",i)},{"originalIndex",i},{"property",reference("property",bytes.le(offsets[6]+i*4),counts[5])}});
    for(const auto table:{1u,2u,7u})for(std::size_t i=0;i<counts[table];++i){Json data;if(table==7)data={{"U0",bytes.signed16(offsets[table]+i*8)},{"U1",bytes.signed16(offsets[table]+i*8+2)},{"Style",bytes.le(offsets[table]+i*8+4)}};else data={{"ByteSize",bytes.le(offsets[table]+i*12+4)},{"Count",bytes.le(offsets[table]+i*12+8)}};doc[table==1?"physics":table==2?"collisionModels":"splines"].push_back({{"id",identity(table==1?"physics":table==2?"collision":"spline",i)},{"originalIndex",i},{"data",data}});}
    auto text=doc.dump();if(text.size()>64*1024*1024)throw std::runtime_error("Effects document exceeds its limit");return text;
}
void write_logic(const std::vector<std::uint8_t>& bytes,const std::filesystem::path& output,const std::string& course,const ImportCancel& cancel){std::ofstream file(output/"Effects.json",std::ios::binary);file<<logic_document(bytes,course,cancel)<<'\n';if(!file)throw std::runtime_error("Cannot write Effects document");}
}
