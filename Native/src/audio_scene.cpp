#include "openslope/audio_scene.hpp"
#include "openslope/audio_program.hpp"
#include "openslope/music.hpp"
#include "openslope/import.hpp"
#include <nlohmann/json.hpp>
#include <fstream>
#include <mutex>
#include <map>
#include <iostream>
#include <set>

namespace openslope {
namespace {
using Json=nlohmann::json;
Json read(const std::filesystem::path& path){if(std::filesystem::file_size(path)>64*1024*1024)throw std::runtime_error("Audio JSON exceeds its limit");std::ifstream file(path);return Json::parse(file);}
std::filesystem::path asset(const std::filesystem::path& root,const std::string& name){const auto base=std::filesystem::weakly_canonical(root),path=std::filesystem::weakly_canonical(base/name),relative=path.lexically_relative(base);if(relative.empty()||relative.is_absolute()||*relative.begin()=="..")throw std::runtime_error("Audio asset escapes its course");return path;}
std::string slot_name(unsigned slot){auto number=std::to_string(slot);while(number.size()<3)number.insert(number.begin(),'0');return number;}
Vec3 axes(Vec3 p){return {p.x,p.z,-p.y};}
const std::array<std::string,10> families{"PACK","POWDER","LOOSE","ICE","METAL","WOOD","RAIL","ROCK","GLASS","CHUTE"};
std::size_t loop_match(const std::vector<float>& full,const std::vector<float>& pattern){
    if(pattern.empty()||pattern.size()>full.size())throw std::runtime_error("Invalid loop-region WAV");std::vector<std::size_t> prefix(pattern.size());for(std::size_t i=1,j=0;i<pattern.size();++i){while(j&&pattern[i]!=pattern[j])j=prefix[j-1];if(pattern[i]==pattern[j])++j;prefix[i]=j;}
    for(std::size_t i=0,j=0;i<full.size();++i){while(j&&full[i]!=pattern[j])j=prefix[j-1];if(full[i]==pattern[j])++j;if(j==pattern.size())return i+1-j;}throw std::runtime_error("Loop WAV is not a region of its full clip");
}
}
struct AudioScene::Data {
    std::filesystem::path root;AudioMixer mixer;AudioListener listener;mutable std::mutex mutex;AudioStats stats;
    struct Cached {std::shared_ptr<PcmClip> clip;std::uint64_t touched{};};std::map<std::string,Cached> clips;std::uint64_t age=0;std::set<std::string> failed;
    std::map<unsigned,std::string> banks;std::map<int,std::string> events;AudioPrograms programs;std::vector<unsigned> surface_groups;
    struct Sound {int event=-1;Vec3 position;bool enabled=false;double debounce=0;};std::vector<Sound> sounds;
    struct Emitter {std::size_t instance{};unsigned type{},event{},radial{},angular{};Vec3 offset,extents,axis{0,1,0};double radius{},cone{};std::uint64_t voice{};bool inside=false;};std::vector<Emitter> emitters;
    std::array<std::uint64_t,3> board{};int family=-1;double fade=0;std::uint64_t wind{};double predicted_flight=0;
    std::vector<std::string> playlist;std::size_t song=0;MusicGraph graph;std::filesystem::path music_folder;MusicCursor cursor,pending_cursor;std::uint64_t music_voice{},music_generation{};double music_gain=.5;unsigned level=80;std::optional<unsigned> pending_event;bool music_ready=false,pending_ready=false;std::uint64_t serial=0;
    explicit Data(std::filesystem::path folder):root(std::move(folder)){
        if(root.empty())return;
        if(std::filesystem::exists(root/"Audio/SoundIndex.json")){const auto index=read(asset(root,"Audio/SoundIndex.json"));if(index.value("Schema","")=="openslope-sound-index/v1"){
            for(const auto& [key,value]:index.at("Banks").items()){const auto bank=value.get<std::string>();if(!valid_map_name(bank))throw std::runtime_error("Unsafe sound bank name");banks[unsigned(std::stoul(key))]=bank;}
            for(const auto& [key,value]:index.at("CollisionEvents").items())events[std::stoi(key)]=value.at("Clip");
        }}
        auto board_path=root/"Audio/BoardSoundIndex.json";if(!std::filesystem::exists(board_path))board_path=root.parent_path()/"Shared/Audio/BoardSoundIndex.json";
        if(std::filesystem::exists(board_path)){const auto index=read(board_path);if(index.value("Schema","")=="openslope-board-sound-index/v1"){surface_groups=index.at("SurfaceGroups").get<std::vector<unsigned>>();if(surface_groups.size()>256||std::any_of(surface_groups.begin(),surface_groups.end(),[](auto x){return x>9;}))throw std::runtime_error("Invalid board surface groups");}}
        if(std::filesystem::exists(root/"Audio/SNOW.INF")){std::ifstream file(asset(root,"Audio/SNOW.INF"));const std::string text{std::istreambuf_iterator<char>(file),std::istreambuf_iterator<char>()};programs=parse_audio_programs(text);}
        if(std::filesystem::exists(root/"Instances.json")){const auto rows=read(asset(root,"Instances.json")).at("Instances");if(!rows.is_array()||rows.size()>100000)throw std::runtime_error("Invalid audio instance count");sounds.resize(rows.size());
            const auto placements=prop_placements(root);for(std::size_t i=0;i<rows.size();++i){const auto& row=rows[i];sounds[i].position={placements[i][12],placements[i][13],placements[i][14]};if(!row.value("IncludeSound",false)||!row.contains("Sounds")||row.at("Sounds").is_null())continue;const auto& sound=row.at("Sounds");sounds[i].event=sound.value("CollisonSound",-1);
                if(sound.contains("ExternalSounds"))for(const auto& source:sound.at("ExternalSounds")){Emitter e;e.instance=i;e.type=source.at("U0");e.event=source.at("SoundIndex");e.offset=axes({source.at("U2"),source.at("U3"),source.at("U4")})/100.;e.radius=source.at("U5").get<double>()/100.;if(!finite(e.offset)||!std::isfinite(e.radius)||e.radius<=0||e.type>3)throw std::runtime_error("Invalid placed audio emitter");
                    if(e.type==0)e.radial=source.at("U6");if(e.type==1){e.extents={e.radius,source.at("U6").get<double>()/100,source.at("U7").get<double>()/100};e.axis=normalized(axes({source.at("U8"),source.at("U9"),source.at("U10")}));e.radial=source.at("U11");}if(e.type==2){e.axis=normalized(axes({source.at("U6"),source.at("U7"),source.at("U8")}));e.radial=source.at("U9");e.cone=source.at("U10");e.angular=source.at("U11");}if(e.radial>5||e.angular>5)throw std::runtime_error("Unsupported ambient curve");emitters.push_back(e);if(emitters.size()>100000)throw std::runtime_error("Too many ambient emitters");
                }
            }
        }
        if(std::filesystem::exists(root/"Audio/ExternalIndex.json")){const auto index=read(asset(root,"Audio/ExternalIndex.json"));if(index.value("Schema","")=="openslope-external-sounds/v1")for(const auto& [key,row]:index.at("Events").items())events[std::stoi(key)]=row.at("Clip");}
        if(std::filesystem::exists(root/"Audio/Music/playlist.json")){const auto list=read(asset(root,"Audio/Music/playlist.json"));if(list.is_array())playlist=list.get<std::vector<std::string>>();if(playlist.size()>64)throw std::runtime_error("Music playlist exceeds its limit");for(const auto& name:playlist)if(!valid_map_name(name))throw std::runtime_error("Unsafe music song name");}
        start_music();
    }
    std::shared_ptr<PcmClip> clip(const std::string& name,bool looping=false){
        const auto key=name+(looping?"#loop":"");if(failed.contains(key))return {};if(auto found=clips.find(key);found!=clips.end()){found->second.touched=++age;return found->second.clip;}
        const auto path=asset(root,name);if(!std::filesystem::exists(path))return {};
        try{auto value=std::make_shared<PcmClip>(PcmClip::load(path));if(looping){auto loop_path=path;loop_path.replace_filename(path.stem().string()+".loop.wav");if(!std::filesystem::exists(loop_path))return {};const auto region=PcmClip::load(loop_path);if(region.channels!=value->channels||region.rate!=value->rate)throw std::runtime_error("Loop WAV format differs");const auto begin=loop_match(value->samples,region.samples);if(begin%value->channels||region.samples.size()%value->channels)throw std::runtime_error("Invalid loop channel alignment");value->loop_start=begin/value->channels;value->loop_end=value->loop_start+region.frames();}
            const auto bytes=value->samples.size()*sizeof(float);while(stats.decoded_bytes+bytes>128*1024*1024){auto victim=clips.end();for(auto i=clips.begin();i!=clips.end();++i)if(i->second.clip.use_count()==1&&(victim==clips.end()||i->second.touched<victim->second.touched))victim=i;if(victim==clips.end())throw std::runtime_error("Live audio exceeds its cache budget");stats.decoded_bytes-=victim->second.clip->samples.size()*sizeof(float);clips.erase(victim);}stats.decoded_bytes+=bytes;clips[key]={value,++age};return value;
        }catch(const std::exception& e){failed.insert(key);std::cerr<<"Audio asset unavailable: "<<name<<" ("<<e.what()<<")\n";return {};}
    }
    std::shared_ptr<PcmClip> slot(unsigned group,unsigned number,bool loop=false){const auto bank=banks.find(group);return bank==banks.end()?nullptr:clip("Audio/SFX/"+bank->second+"/"+slot_name(number)+".wav",loop);}
    void one_shot(std::shared_ptr<PcmClip> value,Vec3 position,double gain,bool spatial){if(!value||gain<=0)return;VoiceParams params;params.gain=std::clamp(gain,0.,1.);params.spatial=spatial;params.position=position;mixer.play(std::move(value),params);}
    void start_music(){
        music_ready=false;pending_ready=false;music_voice=0;cursor={};pending_event.reset();if(playlist.empty())return;const auto name=playlist[song%playlist.size()];try{music_folder=asset(root,"Audio/Music/"+name);graph=MusicGraph::load(music_folder/"graph.json");const auto sample=music_advance(graph,cursor,level);if(sample<0)return;const auto json=read(music_folder/"graph.json");music_gain=json.value("Volume",.5);if(!std::isfinite(music_gain)||music_gain<0||music_gain>1)throw std::runtime_error("Invalid music volume");auto value=clip("Audio/Music/"+name+"/"+graph.samples[std::size_t(sample)].wav);if(!value)return;value->priority=101;music_voice=mixer.play(value,{music_gain*cursor.action_volume});music_ready=music_voice!=0;music_generation=0;stats.music_node=cursor.node;music_service();}
        catch(const std::exception& e){std::cerr<<"Music unavailable: "<<e.what()<<'\n';}
    }
    void music_service_unchecked(){
        if(!music_ready)return;const auto status=mixer.status(music_voice);if(!status){music_ready=false;stats.music_node=-1;return;}if(status->generation!=music_generation){if(pending_ready){cursor=pending_cursor;pending_ready=false;pending_event.reset();}music_generation=status->generation;stats.music_node=cursor.node;}
        if(pending_ready)return;pending_cursor=cursor;const auto sample=music_advance(graph,pending_cursor,level,pending_event);if(sample<0){mixer.queue(music_voice,{});pending_ready=true;return;}const auto name=playlist[song%playlist.size()];auto value=clip("Audio/Music/"+name+"/"+graph.samples[std::size_t(sample)].wav);if(!value){mixer.queue(music_voice,{});pending_ready=true;return;}value->priority=101;mixer.queue(music_voice,value,{music_gain*pending_cursor.action_volume});pending_ready=true;
    }
    void music_service(){try{music_service_unchecked();}catch(const std::exception& e){music_ready=false;mixer.queue(music_voice,{});std::cerr<<"Music scheduler stopped: "<<e.what()<<'\n';}}
    void reset(){mixer.clear();board={};wind=0;family=-1;fade=0;for(auto& s:sounds){s.enabled=false;s.debounce=0;}for(auto& e:emitters){e.voice=0;e.inside=false;}++song;start_music();}
};
AudioScene::AudioScene(const std::filesystem::path& root):data_(std::make_unique<Data>(root)){}AudioScene::~AudioScene()=default;
AudioMixer& AudioScene::mixer(){return data_->mixer;}
void AudioScene::listener(AudioListener value){std::lock_guard lock(data_->mutex);data_->listener=value;data_->mixer.listener(value);}
void AudioScene::service(){std::lock_guard lock(data_->mutex);data_->music_service();}
void AudioScene::music_level(unsigned level){if(level>127)throw std::runtime_error("Music path level exceeds 127");std::lock_guard lock(data_->mutex);data_->level=level;data_->pending_ready=false;data_->music_service();}
void AudioScene::music_event(unsigned event){std::lock_guard lock(data_->mutex);data_->pending_event=event;data_->pending_ready=false;data_->music_service();}
void AudioScene::restart(){std::lock_guard lock(data_->mutex);data_->reset();}
AudioStats AudioScene::stats() const {std::lock_guard lock(data_->mutex);return data_->stats;}
void AudioScene::play_course(unsigned number,Vec3 position,double gain){std::lock_guard lock(data_->mutex);data_->one_shot(data_->slot(2,number),position,gain,true);}
void AudioScene::tick(const Player& player,const Rider& before){
    std::lock_guard lock(data_->mutex);auto& d=*data_;const auto& rider=player.rider();const auto dt=player.contract().tick_seconds();
    if(d.serial&&d.serial!=player.audio_reset_serial())d.reset();d.serial=player.audio_reset_serial();
    for(const auto& action:player.world_actions())if(action.kind==WorldActionKind::CourseSound||action.kind==WorldActionKind::MainSound){if(action.value<0||action.value>65535)continue;const auto main=action.kind==WorldActionKind::MainSound;d.one_shot(d.slot(main?0:2,unsigned(action.value)),action.position,1,!main);++d.stats.transients;}
    for(auto& s:d.sounds)s.debounce=std::max(0.,s.debounce-dt);
    for(const auto& e:player.contacts())if(e.phase!=ContactPhase::End&&e.contact.instance<d.sounds.size()){auto& s=d.sounds[e.contact.instance];s.enabled=true;const auto speed=std::max(0.,-dot(before.velocity,e.contact.normal));const auto event=d.events.find(s.event);if(s.debounce<=0&&speed>.05&&event!=d.events.end()&&length(s.position-d.listener.position)<100){d.one_shot(d.clip(event->second),s.position,std::min(1.,speed/20),true);s.debounce=.8;++d.stats.contacts;}}
    for(auto& e:d.emitters){const auto& s=d.sounds[e.instance];const bool hit_gate=e.event==16||e.event==28||e.event==57;const auto source=s.position+e.offset,delta=d.listener.position-source;const auto distance=length(delta);double normalized_distance=distance/e.radius,gain=0;
        if(e.type==1){if(e.extents.y<=0||e.extents.z<=0)continue;const auto z=normalized(e.axis),x=normalized(cross({0,1,0},z),{1,0,0}),y=normalized(cross(z,x));normalized_distance=length({dot(delta,x)/e.extents.x,dot(delta,y)/e.extents.y,dot(delta,z)/e.extents.z});}
        if((!hit_gate||s.enabled)&&normalized_distance<1){gain=e.type==3?1:ambient_curve(e.radial,normalized_distance);if(e.type==2){const auto cosine=dot(normalized(delta),e.axis);gain=cosine>e.cone&&e.cone<1?gain*ambient_curve(e.angular,std::acos(std::clamp(cosine,-1.,1.))/std::acos(std::clamp(e.cone,-1.,1.))):0;}}
        const auto event=d.events.find(int(e.event));if(gain>0&&event!=d.events.end()){VoiceParams params;params.gain=gain;params.loop=e.type!=3;params.spatial=true;params.position=source;params.distance_falloff=false;
            if(e.type==3){if(!e.inside)if(auto value=d.clip(event->second))d.mixer.play(value,params);}else if(!d.mixer.update(e.voice,params)){if(auto value=d.clip(event->second,true)){e.voice=d.mixer.play(value,params);++d.stats.ambient;}}e.inside=true;
        }else{if(e.voice)d.mixer.stop(e.voice);e.voice=0;e.inside=false;}
    }
    const auto group=rider.surface>=0&&std::size_t(rider.surface)<d.surface_groups.size()?d.surface_groups[std::size_t(rider.surface)]:0;
    const bool ground=rider.motion==Motion::Ground;if(int(group)!=d.family){for(auto id:d.board)d.mixer.stop(id);d.board={};d.family=int(group);}
    if(before.motion==Motion::Ground&&rider.motion==Motion::Air){d.one_shot(d.slot(1,group*8+2),{},.7,false);++d.stats.transients;d.predicted_flight=0;auto position=rider.position,velocity=rider.velocity;for(unsigned i=0;i<480;++i){const auto next=position+velocity*dt;const auto terrain=player.terrain().intersect(position,next);const auto prop=player.world().ray(position,next,true);if(terrain||prop){d.predicted_flight=(i+1)*dt;break;}position=next;velocity+=Vec3{-velocity.x*player.contract().value("gravity","airHorizontalDrag"),-player.contract().value("gravity",velocity.y>0?"airRising":"airFalling"),-velocity.z*player.contract().value("gravity","airHorizontalDrag") }*dt;}}
    if(before.motion!=Motion::Ground&&ground){d.one_shot(d.slot(1,group*8+1),{},.7,false);++d.stats.transients;}
    d.fade=ground?std::min(1.,d.fade+.2):0;
    const auto f=normalized(project(rider.forward,rider.normal)),right=normalized(cross(rider.normal,f));const auto speed=length(project(rider.velocity,rider.normal)),slip=std::abs(dot(rider.velocity,right))*100;
    const RideAudioSignals signals{slip,speed*30,std::abs(rider.lean)*100,speed*100,slip};
    const auto programs=d.programs.find(families[group]);const std::array<std::string,3> modes{"GLIDE","CARVE","AIGLIDE"};const std::array<unsigned,3> offsets{4,3,0};
    for(unsigned i=0;i<3;++i){double gain=0,pitch=1;if(ground&&programs!=d.programs.end()){const auto program=programs->second.find(modes[i]);if(program!=programs->second.end()){const auto value=evaluate_audio_program(program->second,signals);gain=value.volume/127*d.fade*.5*(i==2?.25:1);pitch=1+.5*value.bend/127;}}
        VoiceParams params;params.gain=gain;params.pitch=pitch;params.loop=true;if(gain<=0){if(d.board[i])d.mixer.update(d.board[i],params);}else if(!d.mixer.update(d.board[i],params)){if(auto value=d.slot(1,group*8+offsets[i],true))d.board[i]=d.mixer.play(value,params);}}
    const bool wind=rider.motion==Motion::Air&&d.predicted_flight>1.5;if(wind){VoiceParams params;params.gain=.25;params.loop=true;if(!d.mixer.update(d.wind,params))if(auto value=d.slot(0,32,true))d.wind=d.mixer.play(value,params);}else if(d.wind){d.mixer.stop(d.wind);d.wind=0;}
    d.music_service();
}
}
