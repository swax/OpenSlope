#include "openslope/world_logic.hpp"
#include "openslope/props.hpp"
#include "import_internal.hpp"
#include <nlohmann/json.hpp>
#include <bit>
#include <deque>
#include <fstream>
#include <map>
#include <random>
#include <set>
#include <stdexcept>

namespace openslope {
namespace {
using Json=nlohmann::json;constexpr auto none=std::size_t(-1);
Json read(const std::filesystem::path& root,const char* name){const auto base=std::filesystem::weakly_canonical(root),path=std::filesystem::weakly_canonical(root/name),relative=path.lexically_relative(base);if(relative.empty()||relative.is_absolute()||*relative.begin()==".."||std::filesystem::file_size(path)>64*1024*1024)throw std::runtime_error("Invalid world logic asset");std::ifstream file(path);return Json::parse(file);}
std::string id(const char* prefix,std::size_t index){return std::string(prefix)+std::to_string(index);}
Json legacy(const Json& source){
    Json doc={{"graphs",Json::array()},{"functions",Json::array()},{"slots",Json::array()},{"instances",Json::array()},{"objectProperties",Json::array()},{"splines",Json::array()}};
    for(const auto& [key,target]:{std::pair{"EffectHeaders","graphs"},std::pair{"Functions","functions"}})if(source.contains(key))for(std::size_t i=0;i<source.at(key).size();++i){const auto& row=source.at(key)[i];Json nodes=Json::array();for(const auto& raw:row.at("Effects")){auto payload=raw;payload.erase("MainType");Json refs=Json::object();const auto main=raw.at("MainType").get<int>();
            if(main==7&&raw.contains("Instance")){refs["instance"]=id("instance:",raw.at("Instance").at("InstanceIndex"));refs["effectGraph"]=id("graph:",raw.at("Instance").at("EffectIndex"));}
            if(main==21||main==26)refs["function"]=id("function:",raw.at("FunctionRunIndex"));
            if(main==25)refs["spline"]=id("spline:",raw.at("Spline").at("SplineIndex"));
            nodes.push_back({{"mainType",main},{"payload",payload},{"references",refs}});
        }doc[target].push_back({{"id",id(std::string(target)=="graphs"?"graph:":"function:",i)},{"name",row.value(std::string(target)=="graphs"?"EffectName":"FunctionName","")},{"nodes",nodes}});}
    const std::array<const char*,7> columns{"PersistantEffectSlot","CollisionEffectSlot","Slot3","Slot4","EffectTriggerSlot","Slot6","Slot7"},names{"persistent","collision","slot3","slot4","trigger","slot6","slot7"};
    if(source.contains("EffectSlots"))for(std::size_t i=0;i<source.at("EffectSlots").size();++i){Json circumstances;for(unsigned c=0;c<7;++c){const auto index=source.at("EffectSlots")[i].value(columns[c],-1);circumstances[names[c]]=index<0?Json(nullptr):Json(id("graph:",std::size_t(index)));}doc["slots"].push_back({{"id",id("slot:",i)},{"originalIndex",i},{"circumstances",circumstances}});}return doc;
}
double number(const Json& value,const char* key,double fallback=0){const auto v=value.value(key,fallback);if(!std::isfinite(v)||std::abs(v)>1e9)throw std::runtime_error("Invalid world node number");return v;}
}
struct WorldLogic::Data {
    struct Node {int main=0;Json payload,refs;};
    struct Chain {std::string name;std::vector<Node> nodes;};
    struct Slot {std::array<std::size_t,7> chains{none,none,none,none,none,none,none};};
    struct Host {std::size_t slot=none;Vec3 position;bool showoff=false;};
    struct Property {int kind=-1,mode=0;double time=0;};
    struct Thread {std::size_t chain=none,instance=none,pc=0;double wait=0;bool rider=false,human=false,collision=false;std::vector<std::pair<std::size_t,std::size_t>> ancestry;};
    std::vector<Chain> chains;std::vector<Slot> slots;std::vector<Host> hosts;std::vector<Property> properties;
    std::vector<std::uint8_t> initial,flags;std::vector<bool> busy;
    std::map<std::string,std::size_t> graphs,functions,slot_ids,instance_ids,spline_ids,entries;
    std::deque<Thread> ready,waiting;std::vector<WorldAction> actions;std::size_t unknown=0;unsigned budget=4096;RunMode mode=RunMode::Freeride;std::mt19937 random{0x4f534c50};
    std::size_t ref(const Json& refs,const char* key,const std::map<std::string,std::size_t>& table) const {if(!refs.contains(key)||refs.at(key).is_null())return none;const auto found=table.find(refs.at(key).get<std::string>());return found==table.end()?none:found->second;}
    void enqueue(std::size_t chain,std::size_t instance,bool rider,bool human,bool collision=false,std::vector<std::pair<std::size_t,std::size_t>> ancestry={}){
        if(chain>=chains.size()||ready.size()+waiting.size()>=1024||ancestry.size()>=32||std::find(ancestry.begin(),ancestry.end(),std::pair{chain,instance})!=ancestry.end())return;
        ancestry.push_back({chain,instance});ready.push_back({chain,instance,0,0,rider,human,collision,std::move(ancestry)});if(collision)busy.at(instance)=true;
    }
    void restore(std::size_t host){flags[host]=hosts[host].showoff&&mode!=RunMode::Showoff?0:initial[host];}
    void action(WorldActionKind kind,const Thread& thread,double value=0,std::size_t target=0){if(actions.size()>=4096)return;actions.push_back({kind,value,target,thread.instance<hosts.size()?hosts[thread.instance].position:Vec3{},thread.rider});}
    bool gate(const Node& node,const Thread& thread,double speed){
        const auto& p=node.payload.at("type5");const auto test=p.value("U0",0);if(test==2)return thread.rider&&thread.human;if(test==3)return thread.instance>=properties.size()||properties[thread.instance].kind<0;
        // The interchange preserves these two words at their authored bit types.
        const auto selector=std::bit_cast<std::uint32_t>(float(number(p,"U1")));const auto threshold=std::bit_cast<float>(p.value("U2",std::uint32_t(0)));if(!std::isfinite(threshold))throw std::runtime_error("Invalid world gate threshold");
        if(test==0){if(!thread.rider)return true;return selector==0?speed*100<=threshold:selector==1?speed*3.6>=threshold:true;}
        if(test==1){const auto roll=std::generate_canonical<double,32>(random);return selector==0?roll<threshold:selector==1?roll>=threshold:true;}return true;
    }
    void drain(double speed){
        while(!ready.empty()&&budget){auto thread=std::move(ready.front());ready.pop_front();const auto& chain=chains.at(thread.chain);bool hold=false;
            while(thread.pc<chain.nodes.size()&&budget){--budget;const auto& node=chain.nodes[thread.pc++];const auto& p=node.payload;const auto host=thread.instance;
                if(node.main==4){thread.wait=std::max(0.,number(p,"WaitTime"));if(thread.wait>0){hold=true;break;}}
                else if(node.main==5){if(!gate(node,thread,speed))break;}
                else if(node.main==21||node.main==26)enqueue(ref(node.refs,"function",functions),host,node.main==21&&thread.rider,thread.human,false,thread.ancestry);
                else if(node.main==7){const auto target=ref(node.refs,"instance",instance_ids),graph=ref(node.refs,"effectGraph",graphs);if(target>=hosts.size()||(hosts[target].showoff&&mode!=RunMode::Showoff))continue;
                    if(graph<chains.size())enqueue(graph,target,thread.rider,thread.human,false,thread.ancestry);
                    else if(p.contains("Instance")&&p.at("Instance").contains("Effect")){if(p.at("Instance").at("Effect").get<int>()==0){flags[target]=0;properties[target]={5,2,0};}else{restore(target);flags[target]|=WorldDraw;properties[target]={};}}
                }else if(node.main==0&&host<hosts.size()){
                    const auto& property=p.at("type0");const auto sub=property.at("SubType").get<int>();
                    if(sub==2)properties[host]={2,0,number(property,"Debounce")};
                    else if(sub==5){const auto operation=property.value("DeadNodeMode",0);properties[host]=operation>=2?Property{5,operation,0}:Property{};if(operation>=2)flags[host]=0;else if(operation==0)restore(host);}
                    else ++unknown;
                }else if(node.main==13){if(thread.rider)action(WorldActionKind::Reset,thread);}
                else if(node.main==14&&thread.rider){const auto tier=number(p,"MultiplierScore");if(tier==2||tier==3||tier==5){if(mode==RunMode::Showoff)action(WorldActionKind::Multiplier,thread,tier);if(thread.human)action(WorldActionKind::MainSound,thread,tier==2?116:tier==3?117:118);}}
                else if(node.main==8)action(WorldActionKind::CourseSound,thread,number(p,"SoundPlay"));
                else if(node.main==25){const auto rail=ref(node.refs,"spline",spline_ids);if(rail!=none)action(WorldActionKind::RailToggle,thread,number(p.at("Spline"),"Effect"),rail);}
                else ++unknown;
            }
            if(hold)waiting.push_back(std::move(thread));else if(thread.collision)busy[thread.instance]=false;
        }
        // A malformed graph cannot monopolize a fixed tick or leave contact latched.
        for(const auto& thread:ready)if(thread.collision)busy[thread.instance]=false;ready.clear();
    }
};
WorldLogic::WorldLogic():data_(std::make_unique<Data>()){}WorldLogic::~WorldLogic()=default;WorldLogic::WorldLogic(WorldLogic&&) noexcept=default;WorldLogic& WorldLogic::operator=(WorldLogic&&) noexcept=default;
WorldLogic WorldLogic::load(const std::filesystem::path& root){
    WorldLogic result;if(root.empty()||!std::filesystem::exists(root/"Instances.json"))return result;auto& d=*result.data_;const auto rows=read(root,"Instances.json").at("Instances");if(!rows.is_array()||rows.size()>100000)throw std::runtime_error("Invalid world instance count");
    Json doc;if(std::filesystem::exists(root/"Effects.json")){doc=read(root,"Effects.json");if(doc.value("kind","")!="openslope-effects"||doc.value("version",0)!=1)throw std::runtime_error("Unsupported Effects document");}else if(std::filesystem::exists(root/"SSFLogic.json"))doc=legacy(read(root,"SSFLogic.json"));else {
        doc=legacy(Json::object());const auto source=root/"Source";if(std::filesystem::is_directory(source)){std::optional<std::filesystem::path> behavior;for(const auto& entry:std::filesystem::directory_iterator(source))if(entry.is_regular_file()&&(entry.path().extension()==".SSF"||entry.path().extension()==".ssf")){if(behavior)throw std::runtime_error("Ambiguous source behavior files");behavior=entry.path();}if(behavior){const auto base=std::filesystem::weakly_canonical(root),resolved=std::filesystem::weakly_canonical(*behavior),relative=resolved.lexically_relative(base);if(relative.empty()||relative.is_absolute()||*relative.begin()==".."||std::filesystem::file_size(resolved)>64*1024*1024)throw std::runtime_error("Invalid source behavior file");std::ifstream file(resolved,std::ios::binary);const std::vector<std::uint8_t> bytes{std::istreambuf_iterator<char>(file),std::istreambuf_iterator<char>()};doc=Json::parse(import_detail::logic_document(bytes,root.filename().string()));}}
    }
    std::size_t node_count=0;for(const auto& name:{"graphs","functions"}){const auto& array=doc.at(name);if(!array.is_array()||array.size()>4096)throw std::runtime_error("Invalid world graph count");auto& lookup=std::string(name)=="graphs"?d.graphs:d.functions;for(const auto& row:array){if(!lookup.emplace(row.at("id").get<std::string>(),d.chains.size()).second)throw std::runtime_error("Duplicate world graph identity");Data::Chain chain;chain.name=row.value("name","");if(std::string(name)=="functions")d.entries.try_emplace(chain.name,d.chains.size());for(const auto& node:row.at("nodes")){if(++node_count>100000)throw std::runtime_error("Too many world graph nodes");chain.nodes.push_back({node.at("mainType"),node.at("payload"),node.value("references",Json::object())});}d.chains.push_back(std::move(chain));}}
    const std::array<const char*,7> columns{"persistent","collision","slot3","slot4","trigger","slot6","slot7"};std::map<std::size_t,std::size_t> original_slots;
    if(!doc.at("slots").is_array()||doc.at("slots").size()>4096)throw std::runtime_error("Invalid world slot count");for(const auto& row:doc.at("slots")){const auto index=d.slots.size();if(!d.slot_ids.emplace(row.at("id").get<std::string>(),index).second)throw std::runtime_error("Duplicate world slot identity");original_slots[index]=index;Data::Slot slot;for(unsigned c=0;c<7;++c)slot.chains[c]=d.ref(row.at("circumstances"),columns[c],d.graphs);d.slots.push_back(slot);}
    for(std::size_t i=0;i<rows.size();++i)d.instance_ids[id("instance:",i)]=i;
    const auto bindings_rows=doc.value("instances",Json::array());for(std::size_t i=0;i<bindings_rows.size()&&i<rows.size();++i)d.instance_ids[bindings_rows[i].at("id").get<std::string>()]=i;
    std::map<std::string,std::size_t> properties;for(const auto& row:doc.value("objectProperties",Json::array()))properties[row.at("id").get<std::string>()]=d.ref(row.at("references"),"effectSlot",d.slot_ids);
    std::map<std::size_t,std::size_t> bindings;for(const auto& row:doc.value("instances",Json::array())){const auto index=d.ref(Json{{"instance",row.at("id")}},"instance",d.instance_ids),prop=d.ref(row,"property",properties);if(index<rows.size())bindings[index]=prop;}
    for(const auto& row:doc.value("splines",Json::array()))d.spline_ids[row.at("id").get<std::string>()]=d.spline_ids.size();
    if(std::filesystem::exists(root/"Splines.json")){const auto splines=read(root,"Splines.json").at("Splines");for(std::size_t i=0;i<splines.size();++i)d.spline_ids.try_emplace(id("spline:",i),i);}
    std::vector<std::string> models;if(std::filesystem::exists(root/"Models.json")){const auto model_rows=read(root,"Models.json").at("Models");for(const auto& row:model_rows)models.push_back(row.value("ModelName",""));}const auto placements=prop_placements(root);
    for(std::size_t i=0;i<rows.size();++i){const auto& row=rows[i];const auto old=row.value("EffectSlotIndex",-1);auto slot=old>=0&&original_slots.contains(std::size_t(old))?original_slots.at(std::size_t(old)):none;if(bindings.contains(i))slot=bindings.at(i);const auto model=row.value("ModelID",std::size_t(-1));const bool showoff=row.value("LTGState",0)==2||(model<models.size()&&models[model].starts_with("Gem_"));d.hosts.push_back({slot,{placements[i][12],placements[i][13],placements[i][14]},showoff});d.initial.push_back(std::uint8_t((row.value("Visable",true)?WorldDraw:0)|(row.value("PlayerCollision",false)?WorldCollide:0)));}
    d.flags=d.initial;d.busy.resize(rows.size());d.properties.resize(rows.size());result.restart(RunMode::Freeride);return result;
}
void WorldLogic::restart(RunMode mode){auto& d=*data_;d.mode=mode;d.actions.clear();d.ready.clear();d.waiting.clear();d.random.seed(0x4f534c50);d.unknown=0;d.budget=4096;std::fill(d.busy.begin(),d.busy.end(),false);std::fill(d.properties.begin(),d.properties.end(),Data::Property{});for(std::size_t i=0;i<d.hosts.size();++i)d.restore(i);const auto name=mode==RunMode::Showoff?"ShowoffMode":mode==RunMode::Race?"RaceMode":"FreerideMode";if(const auto entry=d.entries.find(name);entry!=d.entries.end())d.enqueue(entry->second,none,false,false);d.drain(0);}
void WorldLogic::tick(double seconds,double speed){if(!std::isfinite(seconds)||seconds<0||seconds>1||!std::isfinite(speed)||speed<0)throw std::invalid_argument("Invalid world tick");auto& d=*data_;d.budget=4096;for(std::size_t i=0;i<d.properties.size();++i){auto& p=d.properties[i];if(p.kind==2&&p.time>0){p.time-=seconds;if(p.time<=1e-9){p={};d.restore(i);}}}auto threads=std::move(d.waiting);d.waiting.clear();for(auto& thread:threads){thread.wait-=seconds;if(thread.wait<=1e-9)d.ready.push_back(std::move(thread));else d.waiting.push_back(std::move(thread));}d.drain(speed);}
void WorldLogic::contact(std::size_t instance,double speed,bool human){auto& d=*data_;if(!std::isfinite(speed)||speed<0)throw std::invalid_argument("Invalid world contact speed");if(instance>=d.hosts.size()||!(d.flags[instance]&WorldCollide)||d.busy[instance]||d.properties[instance].kind==2)return;const auto slot=d.hosts[instance].slot;if(slot<d.slots.size())d.enqueue(d.slots[slot].chains[1],instance,true,human,true);d.drain(speed);}
std::span<const std::uint8_t> WorldLogic::flags() const {return data_->flags;}
std::vector<WorldAction> WorldLogic::take_actions(){auto actions=std::move(data_->actions);data_->actions.clear();return actions;}
std::size_t WorldLogic::chains() const {return data_->chains.size();}std::size_t WorldLogic::unsupported() const {return data_->unknown;}
}
