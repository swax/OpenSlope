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
    struct Host {std::size_t slot=none;Vec3 position;bool showoff=false;std::size_t model=none;bool mode_hidden=false;};
    struct Property {int kind=-1,mode=0;double time=0;std::optional<PropPlayback> animation{};double debounce=0;bool end_requested=false;};
    struct Thread {std::size_t chain=none,instance=none,pc=0;double wait=0;bool rider=false,human=false,collision=false,setup=false;std::vector<std::pair<std::size_t,std::size_t>> ancestry;};
    std::vector<Chain> chains;std::vector<Slot> slots;std::vector<Host> hosts;std::vector<Property> properties;
    std::vector<std::uint8_t> initial,flags;std::vector<bool> busy;
    PropClips clips;std::vector<PropMotion> motions;std::vector<std::size_t> motion_ids;std::vector<double> cooldowns;
    struct Region {std::vector<std::size_t> hosts;bool active=false;unsigned absent=0;};std::map<std::array<int,3>,Region> regions;
    std::map<std::string,std::size_t> graphs,functions,slot_ids,instance_ids,spline_ids,entries;
    std::deque<Thread> ready,waiting;std::vector<WorldAction> actions;std::size_t unknown=0;unsigned budget=4096;RunMode mode=RunMode::Freeride;std::mt19937 random{0x4f534c50};
    std::size_t ref(const Json& refs,const char* key,const std::map<std::string,std::size_t>& table) const {if(!refs.contains(key)||refs.at(key).is_null())return none;const auto found=table.find(refs.at(key).get<std::string>());return found==table.end()?none:found->second;}
    void enqueue(std::size_t chain,std::size_t instance,bool rider,bool human,bool collision=false,std::vector<std::pair<std::size_t,std::size_t>> ancestry={},bool setup=false){
        if(chain>=chains.size()||ready.size()+waiting.size()>=1024||ancestry.size()>=32||std::find(ancestry.begin(),ancestry.end(),std::pair{chain,instance})!=ancestry.end())return;
        ancestry.push_back({chain,instance});ready.push_back({chain,instance,0,0,rider,human,collision,setup,std::move(ancestry)});if(collision)busy.at(instance)=true;
    }
    void restore(std::size_t host){flags[host]=hosts[host].showoff&&mode!=RunMode::Showoff?0:initial[host];}
    void erase_motion(std::size_t host){const auto index=motion_ids[host];if(index==none)return;if(index+1<motions.size()){motions[index]=std::move(motions.back());motion_ids[motions[index].instance]=index;}motions.pop_back();motion_ids[host]=none;}
    void update_motion(std::size_t host,bool snap=false){if(!properties[host].animation)return;const auto& player=*properties[host].animation;auto current=clips.delta(hosts[host].model,player.frame(),player.basis());const auto index=motion_ids[host];if(index==none){motion_ids[host]=motions.size();motions.push_back({host,current,std::move(current)});}else{motions[index].current=std::move(current);if(snap)motions[index].previous=motions[index].current;}}
    void destroy(std::size_t host,bool restore_flags=true){erase_motion(host);properties[host]={};if(restore_flags)restore(host);}
    void finish(std::size_t host){auto& property=properties[host];if(property.end_requested)return;property.end_requested=true;const auto slot=hosts[host].slot;const auto end=slot<slots.size()?slots[slot].chains[3]:none;if(end!=none)enqueue(end,host,false,false);else destroy(host);}
    void animate(std::size_t host,const Json& payload,int kind){
        if(hosts[host].mode_hidden||clips.frames(hosts[host].model)<=0)return;const auto& fields=payload.at("type0Sub"+std::to_string(kind));PropPlayLaw law;law.kind=kind;law.loop=fields.value("U0",0);law.start=fields.value("U1",-1.);if(kind==257&&std::abs(law.start)>1e6)law.start=std::bit_cast<float>(fields.at("U1").get<std::int32_t>());else law.start=number(fields,"U1",-1);law.end=number(fields,"U2",-1);law.rate=number(fields,"U3",30);law.random_rate=number(fields,"U4");law.debounce=number(fields,"U5");law.random_start=fields.value("U6",0)!=0;law.reverse=fields.value("U7",3)==4;
        if(kind==258){law.combo_start=number(fields,"U8",-1);law.combo_last=number(fields,"U9",-1);law.combo_rate=number(fields,"U10",30);law.combo_end=fields.value("U11",0);}
        erase_motion(host);auto& property=properties[host];property={};property.kind=kind;property.debounce=std::max(0.,law.debounce);property.animation.emplace(law,clips.frames(hosts[host].model),std::generate_canonical<double,32>(random));if(!property.animation->valid()){destroy(host);return;}restore(host);flags[host]|=WorldDraw;update_motion(host,true);
    }
    void control(std::size_t host,const Json& fields){if(host>=properties.size()||!properties[host].animation)return;const auto command=fields.value("U0",0);const auto value=number(fields,"U1");auto& player=*properties[host].animation;if(command==1)player.hold(std::max(0.,value));else if(command==2&&properties[host].kind==257)player.grant(std::max(0.,value));else if(command==3&&properties[host].kind==258)player.trigger_combo();else if(command==4)player.seek(std::clamp(value,0.,clips.frames(hosts[host].model)));update_motion(host,command==4);}
    void observe_regions(std::span<const Vec3> observers){
        if(observers.empty())return;for(const auto position:observers)if(!finite(position))throw std::invalid_argument("Invalid world observer");
        for(auto& [key,region]:regions){bool nearby=false;const Vec3 minimum{key[0]*100.,key[1]*100.,key[2]*100.},maximum=minimum+Vec3{100,100,100};for(const auto position:observers){const auto closest=Vec3{std::clamp(position.x,minimum.x,maximum.x),std::clamp(position.y,minimum.y,maximum.y),std::clamp(position.z,minimum.z,maximum.z)};if(length(closest-position)<=300){nearby=true;break;}}
            if(nearby){region.absent=0;if(region.active)continue;region.active=true;for(const auto host:region.hosts){const auto& property=properties[host];if((hosts[host].showoff&&mode!=RunMode::Showoff)||hosts[host].mode_hidden||(property.kind==5&&property.mode>=2&&property.mode<=3))continue;const auto slot=hosts[host].slot;if((property.kind==2&&property.time<0)||(property.kind>=0&&slot<slots.size()&&slots[slot].chains[2]!=none))continue;if(slot<slots.size())enqueue(slots[slot].chains[0],host,false,false);}}
            else if(region.active&&++region.absent>=2){region.active=false;for(const auto host:region.hosts){const auto& property=properties[host];if((property.kind==2&&property.time<0)||(property.kind==5&&property.mode>=2&&property.mode<=3))continue;const auto slot=hosts[host].slot;const auto latch=slot<slots.size()?slots[slot].chains[2]:none;if(latch!=none)enqueue(latch,host,false,false);else destroy(host);}}
        }
    }
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
                else if(node.main==21||node.main==26)enqueue(ref(node.refs,"function",functions),host,node.main==21&&thread.rider,thread.human,false,thread.ancestry,thread.setup);
                else if(node.main==7){const auto target=ref(node.refs,"instance",instance_ids),graph=ref(node.refs,"effectGraph",graphs);if(target>=hosts.size()||(hosts[target].showoff&&mode!=RunMode::Showoff)||(hosts[target].mode_hidden&&!thread.setup))continue;
                    if(graph<chains.size())enqueue(graph,target,thread.rider,thread.human,false,thread.ancestry,thread.setup);
                    else if(p.contains("Instance")&&p.at("Instance").contains("Effect")){if(p.at("Instance").at("Effect").get<int>()==0){destroy(target);flags[target]=0;properties[target].kind=5;properties[target].mode=2;if(thread.setup)hosts[target].mode_hidden=true;}else{destroy(target);flags[target]|=WorldDraw;}}
                }else if((node.main==3||node.main==9)&&host<hosts.size())control(host,p.at(node.main==3?"type3":"type9"));
                else if(node.main==0&&host<hosts.size()){
                    const auto& property=p.at("type0");const auto sub=property.at("SubType").get<int>();
                    if(sub==2){destroy(host);properties[host].kind=2;properties[host].time=number(property,"Debounce");}
                    else if(sub==256||sub==257||sub==258)animate(host,property,sub);
                    else if(sub==5){const auto operation=property.value("DeadNodeMode",0);if(operation==1){if(properties[host].animation)properties[host].animation->paused(true);}else{destroy(host,operation==0);if(operation>=2){properties[host].kind=5;properties[host].mode=operation;flags[host]=0;if(thread.setup)hosts[host].mode_hidden=true;}}}
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
    for(std::size_t i=0;i<rows.size();++i){const auto& row=rows[i];const auto old=row.value("EffectSlotIndex",-1);auto slot=old>=0&&original_slots.contains(std::size_t(old))?original_slots.at(std::size_t(old)):none;if(bindings.contains(i))slot=bindings.at(i);const auto model=row.value("ModelID",std::size_t(-1));const bool showoff=row.value("LTGState",0)==2||(model<models.size()&&models[model].starts_with("Gem_"));d.hosts.push_back({slot,{placements[i][12],placements[i][13],placements[i][14]},showoff,model});d.initial.push_back(std::uint8_t((row.value("Visable",true)?WorldDraw:0)|(row.value("PlayerCollision",false)?WorldCollide:0)));}
    d.clips=PropClips::load(root);d.flags=d.initial;d.busy.resize(rows.size());d.properties.resize(rows.size());d.motion_ids.resize(rows.size(),none);d.cooldowns.resize(rows.size());for(std::size_t i=0;i<d.hosts.size();++i){const auto position=d.hosts[i].position;if(std::abs(position.x)>1e9||std::abs(position.y)>1e9||std::abs(position.z)>1e9)throw std::runtime_error("World region coordinates exceed their range");const std::array<int,3> key{int(std::floor(position.x/100)),int(std::floor(position.y/100)),int(std::floor(position.z/100))};d.regions[key].hosts.push_back(i);}result.restart(RunMode::Freeride);return result;
}
void WorldLogic::restart(RunMode mode){auto& d=*data_;d.mode=mode;d.actions.clear();d.ready.clear();d.waiting.clear();d.motions.clear();std::fill(d.motion_ids.begin(),d.motion_ids.end(),none);std::fill(d.cooldowns.begin(),d.cooldowns.end(),0);for(auto& [key,region]:d.regions){static_cast<void>(key);region.active=false;region.absent=0;}d.random.seed(0x4f534c50);d.unknown=0;d.budget=4096;std::fill(d.busy.begin(),d.busy.end(),false);std::fill(d.properties.begin(),d.properties.end(),Data::Property{});for(std::size_t i=0;i<d.hosts.size();++i){d.hosts[i].mode_hidden=false;d.restore(i);}const auto name=mode==RunMode::Showoff?"ShowoffMode":mode==RunMode::Race?"RaceMode":"FreerideMode";if(const auto entry=d.entries.find(name);entry!=d.entries.end())d.enqueue(entry->second,none,false,false,false,{},true);d.drain(0);}
void WorldLogic::tick(double seconds,double speed,std::span<const Vec3> observers){
    if(!std::isfinite(seconds)||seconds<0||seconds>1||!std::isfinite(speed)||speed<0)throw std::invalid_argument("Invalid world tick");auto& d=*data_;d.budget=4096;for(auto& motion:d.motions)motion.previous=motion.current;d.observe_regions(observers);d.drain(speed);
    for(std::size_t i=0;i<d.properties.size();++i){d.cooldowns[i]=std::max(0.,d.cooldowns[i]-seconds);auto& p=d.properties[i];if(p.animation){p.animation->step(seconds);d.update_motion(i);if(p.animation->take_end())d.finish(i);}else if(p.kind==2&&p.time>0){p.time=std::max(0.,p.time-seconds);if(p.time<=1e-9)d.finish(i);}}
    auto threads=std::move(d.waiting);d.waiting.clear();for(auto& thread:threads){thread.wait-=seconds;if(thread.wait<=1e-9)d.ready.push_back(std::move(thread));else d.waiting.push_back(std::move(thread));}d.drain(speed);
}
void WorldLogic::contact(std::size_t instance,double speed,bool human){auto& d=*data_;if(!std::isfinite(speed)||speed<0)throw std::invalid_argument("Invalid world contact speed");if(instance>=d.hosts.size()||!(d.flags[instance]&WorldCollide)||d.busy[instance]||d.properties[instance].kind==2||d.cooldowns[instance]>1e-9)return;const auto slot=d.hosts[instance].slot;if(slot<d.slots.size()){d.cooldowns[instance]=d.properties[instance].debounce;d.enqueue(d.slots[slot].chains[1],instance,true,human,true);d.drain(speed);d.cooldowns[instance]=std::max(d.cooldowns[instance],d.properties[instance].debounce);}}
std::span<const std::uint8_t> WorldLogic::flags() const {return data_->flags;}
std::vector<WorldAction> WorldLogic::take_actions(){auto actions=std::move(data_->actions);data_->actions.clear();return actions;}
std::span<const PropMotion> WorldLogic::motions() const {return data_->motions;}
std::size_t WorldLogic::active_regions() const {return std::size_t(std::count_if(data_->regions.begin(),data_->regions.end(),[](const auto& entry){return entry.second.active;}));}
std::size_t WorldLogic::chains() const {return data_->chains.size();}std::size_t WorldLogic::unsupported() const {return data_->unknown;}
}
