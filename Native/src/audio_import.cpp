#include "import_internal.hpp"
#include "openslope/audio_data.hpp"
#include "openslope/music.hpp"
#include "external_sounds.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cctype>
#include <fstream>
#include <set>
#include <sstream>

namespace openslope::import_detail {
namespace {
using Json=nlohmann::json;
using Sections=std::map<std::string,std::vector<std::pair<std::string,std::string>>>;
std::string upper(std::string value){for(auto& c:value)c=static_cast<char>(std::toupper(static_cast<unsigned char>(c)));return value;}
std::string trim(std::string value){const auto start=value.find_first_not_of(" \t\r\n");if(start==std::string::npos)return {};return value.substr(start,value.find_last_not_of(" \t\r\n")-start+1);}
void json_file(const std::filesystem::path& path,const Json& value){std::ofstream file(path,std::ios::binary);file<<value.dump()<<'\n';if(!file)throw std::runtime_error("Cannot write audio contract");}
Json json_read(const std::filesystem::path& path){std::ifstream file(path,std::ios::binary);if(!file)throw std::runtime_error("Cannot read audio attachment contract");return Json::parse(file);}
Sections config(std::span<const std::uint8_t> bytes){
    if(bytes.size()>1024*1024)throw std::runtime_error("Audio configuration exceeds its limit");
    std::istringstream input(std::string(reinterpret_cast<const char*>(bytes.data()),bytes.size()));std::string line,section;Sections result;
    while(std::getline(input,line)){
        bool quoted=false;for(std::size_t i=0;i<line.size();++i){if(line[i]=='"')quoted=!quoted;if(!quoted&&(line[i]=='#'||line[i]==';')){line.resize(i);break;}}
        line=trim(line);if(line.empty())continue;
        if(line.front()=='['){if(line.back()!=']')throw std::runtime_error("Invalid audio configuration section");section=upper(trim(line.substr(1,line.size()-2)));if(section.empty()||result.contains(section))throw std::runtime_error("Duplicate audio configuration section");result[section]={};continue;}
        if(section.empty())throw std::runtime_error("Audio configuration lacks a section");
        const auto equal=line.find('=');auto key=upper(trim(line.substr(0,equal))),value=equal==std::string::npos?std::string{}:trim(line.substr(equal+1));
        if(!value.empty()&&value.front()=='"'){if(value.size()<2||value.back()!='"')throw std::runtime_error("Unterminated audio configuration string");value=value.substr(1,value.size()-2);}
        if(key.empty()||result[section].size()>=4096)throw std::runtime_error("Invalid audio configuration key/count");result[section].push_back({key,value});
    }return result;
}
std::string section_for(const Sections& sections,const std::string& prefix,bool optional=false){
    const auto key=upper(prefix);if(sections.contains(key))return key;std::string found;
    for(const auto& [name,entries]:sections){static_cast<void>(entries);if(name.starts_with(key)){if(!found.empty())throw std::runtime_error("Ambiguous audio configuration name: "+prefix);found=name;}}
    if(found.empty()&&!optional)throw std::runtime_error("Audio configuration name is missing: "+prefix);return found;
}
std::vector<std::string> values(const Sections& sections,const std::string& section,const std::string& key){std::vector<std::string> result;for(const auto& [name,value]:sections.at(section))if(name==key)result.push_back(value);return result;}
std::string one(const Sections& sections,const std::string& section,const std::string& key,const std::string& fallback={}){const auto entries=values(sections,section,key);if(entries.size()>1)throw std::runtime_error("Duplicate audio configuration value: "+key);return entries.empty()?fallback:entries.front();}
double number(const Sections& sections,const std::string& section,const std::string& key,double fallback){const auto text=one(sections,section,key);if(text.empty())return fallback;std::size_t used=0;const auto value=std::stod(text,&used);if(used!=text.size()||!std::isfinite(value))throw std::runtime_error("Invalid audio configuration number");return value;}
std::string filename(std::string name){std::replace(name.begin(),name.end(),'\\','/');const auto slash=name.find_last_of('/');if(slash!=std::string::npos)name=name.substr(slash+1);if(!valid_map_name(name))throw std::runtime_error("Unsafe configured audio filename");return name;}
struct Library {
    const DiscInput& disc;std::string path;std::vector<DiscEntry> entries;
    Library(const DiscInput& source,std::string archive):disc(source),path(std::move(archive)),entries(disc_archive_directory(disc,path)){}
    std::string member(const std::string& leaf) const {
        const auto wanted=upper(filename(leaf));std::string match;
        for(const auto& entry:entries)if(upper(filename(entry.name))==wanted){if(!match.empty())throw std::runtime_error("Ambiguous audio archive filename");match=entry.name;}
        if(match.empty())throw std::runtime_error("Referenced audio archive member is missing: "+leaf);return match;
    }
    std::vector<std::uint8_t> read(const std::string& leaf) const {return disc_archive_file(disc,path,member(leaf));}
};
std::set<int> attach(const std::vector<std::uint8_t>& raw,const std::vector<std::uint8_t>& linker,const std::filesystem::path& output,const ImportCancel& cancelled){
    // [Trailmap: 200-map-manifest, 260-adl] Join the serialized manifest hash;
    // ADL record offsets are absolute and emitter strides depend on their type.
    Bytes b{raw};b.range(0,12);if(b.le(0,1)||b.number(4)!=1)throw std::runtime_error("Unsupported audio attachment header");const auto count=b.le(8);if(count>100000)throw std::runtime_error("Too many audio attachment rows");b.range(12,std::size_t(count)*8);
    std::map<std::uint32_t,Json> sounds;std::set<int> external;std::size_t total=0;
    for(unsigned i=0;i<count;++i){check_cancel(cancelled);const auto hash=b.le(12+i*8);std::size_t p=b.le(16+i*8);if(p<12+std::size_t(count)*8)throw std::runtime_error("Audio attachment overlaps its table");b.range(p,8);Json record={{"CollisonSound",static_cast<std::int32_t>(b.le(p))},{"ExternalSounds",Json::array()}};const auto emitters=b.le(p+4);p+=8;if(emitters>100000-total)throw std::runtime_error("Too many external sound emitters");total+=emitters;
        for(unsigned j=0;j<emitters;++j){const auto type=b.le(p);const auto event=static_cast<std::int32_t>(b.le(p+4));if(type>3)throw std::runtime_error("Unsupported external sound type");const std::size_t size=type==0?28:type==3?24:48;b.range(p,size);Json row={{"U0",type},{"SoundIndex",event}};for(unsigned k=2;k<size/4;++k)row["U"+std::to_string(k)]=b.number(p+k*4);record["ExternalSounds"].push_back(row);external.insert(event);p+=size;}
        if(auto existing=sounds.find(hash);existing!=sounds.end()&&existing->second!=record)throw std::runtime_error("Conflicting audio attachment hash");sounds[hash]=record;
    }
    if(!std::filesystem::exists(output/"Instances.json")){if(count)throw std::runtime_error("Audio attachments have no instance contract");return external;}
    auto document=json_read(output/"Instances.json");auto& rows=document.at("Instances");std::istringstream input(std::string(reinterpret_cast<const char*>(linker.data()),linker.size()));std::string line;bool active=false;std::size_t index=0;
    while(std::getline(input,line)){
        if(!active){if(line.find("INSTANCES BEGIN")!=std::string::npos)active=true;continue;}if(line.find("INSTANCES END")!=std::string::npos)break;if(trim(line).empty()||line.front()=='#')continue;
        if(line.size()<112||index>=rows.size())throw std::runtime_error("Invalid audio instance manifest row");std::istringstream tail(line.substr(82));unsigned uid=0,reference=0;std::string token;if(!(tail>>uid>>reference>>token)||uid!=index)throw std::runtime_error("Invalid audio instance manifest identifiers");static_cast<void>(reference);
        std::size_t used=0;const auto hash=std::stoull(token,&used,16);if(used!=token.size()||hash>UINT32_MAX||trim(line.substr(0,82))!=rows[index].at("InstanceName").get<std::string>())throw std::runtime_error("Invalid audio instance manifest hash/name");
        auto& row=rows[index++];row["Hash"]=hash;const auto found=sounds.find(static_cast<std::uint32_t>(hash));row["IncludeSound"]=found!=sounds.end();row["Sounds"]=found==sounds.end()?Json(nullptr):found->second;
    }
    if(index!=rows.size())throw std::runtime_error("Audio manifest count disagrees with instances");json_file(output/"Instances.json",document);return external;
}
struct Writer {
    const DiscInput& disc;std::filesystem::path root;ImportProgress progress;ImportCancel cancelled;std::uint64_t bytes=0;std::set<std::string> banks;Json warnings=Json::array();
    void check(){check_cancel(cancelled);}
    void notify(const std::string& text){check();if(progress)progress(text);}
    void reserve(std::uint64_t amount){if(amount>512*1024*1024-bytes)throw std::runtime_error("Course Audio exceeds its 512 MiB budget");bytes+=amount;}
    void wave(const std::filesystem::path& path,const PcmClip& clip){check();const auto size=44+clip.samples.size()*2;if(size>64*1024*1024)throw std::runtime_error("Audio WAV exceeds its 64 MiB limit");reserve(size);write_wave(path,clip);}
    std::string bank(const Library& library,const std::string& configured,const std::filesystem::path& folder){
        const auto leaf=filename(library.member(configured)),name=trim(std::filesystem::path(leaf).stem().string());if(!valid_map_name(name))throw std::runtime_error("Unsafe audio bank folder");const auto key=upper((folder/name).generic_string());if(banks.contains(key))return name;
        notify("Decoding sound bank "+name);const auto decoded=decode_audio_bank(library.read(configured));
        for(const auto& slot:decoded.slots)if(slot){reserve(44+slot->samples.size()*2);if(slot->loop_end)reserve(44+(slot->loop_end-slot->loop_start)*slot->channels*2);if(slot->samples.size()*2+44>64*1024*1024)throw std::runtime_error("Bank WAV exceeds its file limit");}
        std::filesystem::create_directories(folder);write_audio_bank(folder/name,decoded,[&]{check();});reserve(std::filesystem::file_size(folder/name/"bank.json"));banks.insert(key);return name;
    }
};
}
bool write_course_audio(const DiscInput& disc,const std::string& course,const std::map<std::string,std::vector<std::uint8_t>>& files,const std::filesystem::path& output,const ImportProgress& progress,const ImportCancel& cancelled){
    std::set<int> external;
    if(const auto adl=files.find(course+".ADL");adl!=files.end())external=attach(adl->second,files.at(course+".MAP"),output,cancelled);
    const auto data=disc_directory(disc,"DATA");if(std::none_of(data.begin(),data.end(),[](const auto& entry){return entry.directory&&upper(entry.name)=="CONFIG";}))return false;
    const auto config_entries=disc_directory(disc,"DATA/CONFIG");const auto present=[&](const std::string& name){return std::any_of(config_entries.begin(),config_entries.end(),[&](const auto& e){return !e.directory&&upper(e.name)==name;});};
    if(!present("BANKS.INF"))return false;Writer w{disc,output/"Audio",progress,cancelled,0,{},Json::array()};std::filesystem::create_directory(w.root);
    std::map<std::string,Sections> configs;
    for(const auto name:{"BANKS.INF","SNOW.INF","MUSIC.INF","MUSICMAP.INF","INTROMUS.INF"})if(present(name)){w.check();auto raw=disc_file(disc,std::string("DATA/CONFIG/")+name);w.reserve(raw.size());std::ofstream saved(w.root/name,std::ios::binary);saved.write(reinterpret_cast<const char*>(raw.data()),static_cast<std::streamsize>(raw.size()));if(!saved)throw std::runtime_error("Cannot preserve audio configuration");if(std::string(name)!="SNOW.INF")configs[name]=config(raw);}
    const auto& assigned=configs.at("BANKS.INF");const auto section=section_for(assigned,course);Library effects(disc,"DATA/AUDIO/AUDIO.BIG");Json index={{"Schema","openslope-sound-index/v1"},{"Level",course},{"Banks",Json::object()},{"CollisionEvents",Json::object()},{"ResolverState","Deferred"}};
    // [Trailmap: 260-banksinf] SWAP is a registry, never an ambient playlist.
    const std::array<std::string,6> groups={"MAIN","BOARD","BANK","CROWD","AUX","TRICKY"};
    for(unsigned group=0;group<groups.size();++group){const auto file=one(assigned,section,groups[group]);if(!file.empty())index["Banks"][std::to_string(group)]=w.bank(effects,file,w.root/"SFX");}
    const auto routes=Json::parse(external_sound_contract).at("fixedBanks");Json environment={{"Schema","openslope-external-sounds/v1"},{"Events",Json::object()},{"Unresolved",Json::array()}};
    for(const auto event:external){w.check();const auto key=std::to_string(event);if(routes.contains(key)){
            auto bank=routes.at(key).get<std::string>();std::string file;for(const auto& entry:effects.entries)if(upper(trim(std::filesystem::path(filename(entry.name)).stem().string()))==upper(bank)){if(!file.empty())throw std::runtime_error("Ambiguous environmental audio bank");file=entry.name;}
            if(file.empty()){w.warnings.push_back("Missing referenced environment bank: "+bank);environment["Unresolved"].push_back(event);continue;}
            bank=w.bank(effects,file,w.root/"SFX");environment["Events"][key]={{"Clip","Audio/SFX/"+bank+"/000.wav"}};
        }else if(event>=97&&event<=99&&index["Banks"].contains("3")){const auto bank=index["Banks"]["3"].get<std::string>();auto slot=std::to_string(event-97);while(slot.size()<3)slot.insert(slot.begin(),'0');environment["Events"][key]={{"Clip","Audio/SFX/"+bank+"/"+slot+".wav"}};
        }else environment["Unresolved"].push_back(event);
    }
    json_file(w.root/"SoundIndex.json",index);json_file(w.root/"ExternalIndex.json",environment);
    if(configs.contains("MUSICMAP.INF")){
        if(!configs.contains("MUSIC.INF"))throw std::runtime_error("Course music list has no song configuration");const auto& selectors=configs.at("MUSICMAP.INF");const auto& songs=configs.at("MUSIC.INF");const auto selection=section_for(selectors,course);const auto names=values(selectors,selection,"SONG");if(names.size()>64)throw std::runtime_error("Course music playlist exceeds its limit");Library music(disc,"DATA/AUDIO/MUSIC.BIG");std::filesystem::create_directories(w.root/"Music");Json playlist=Json::array();std::set<std::string> converted;
        const auto convert=[&](const std::string& alias){
            const auto song=section_for(songs,alias),path=filename(one(songs,song,"PATHDATA")),stream=filename(one(songs,song,"MUSDATA"));const auto name=std::filesystem::path(path).stem().string();if(converted.contains(upper(name)))return name;w.notify("Decoding music "+name);const auto graph=MusicGraph::decode(music.read(path));const auto audio=music.read(stream);const auto folder=w.root/"Music"/name;if(!std::filesystem::create_directory(folder))throw std::runtime_error("Duplicate music directory");
            for(const auto& sample:graph.samples){w.check();const auto decoded=decode_audio_stream(audio,sample.offset);w.wave(folder/sample.wav,decoded.clip);}
            const auto bpm=number(songs,song,"BPM",120),volume=number(songs,song,"PATHLEVEL",100)/100;if(bpm<=0||bpm>1000||volume<0||volume>1)throw std::runtime_error("Invalid music tempo/volume");graph.save(folder/"graph.json",song,bpm,volume);w.reserve(std::filesystem::file_size(folder/"graph.json"));Json settings=Json::object();for(const auto& [key,value]:songs.at(song))settings[key]=value;
            const auto loop=one(songs,song,"LOOPDATA");if(!loop.empty())settings["LoopBank"]=w.bank(music,loop,folder/"loops");json_file(folder/"config.json",settings);converted.insert(upper(name));return name;
        };
        for(const auto& name:names)playlist.push_back(convert(name));json_file(w.root/"Music/playlist.json",playlist);
        if(selectors.contains("TRICK")){const auto special=values(selectors,"TRICK","SONG");if(special.size()>1)throw std::runtime_error("Ambiguous special music song");if(!special.empty())json_file(w.root/"Music/special-song.json",{{"Song",convert(special.front())}});}
    }
    if(configs.contains("INTROMUS.INF")){
        const auto& intros=configs.at("INTROMUS.INF");const auto selected=section_for(intros,course,true);if(!selected.empty()){
            const auto archive=one(intros,selected,"SONG");if(!archive.empty()){Library intro(disc,"DATA/AUDIO/"+filename(archive));std::filesystem::create_directory(w.root/"Intro");Json stems=Json::array();for(const auto& entry:intro.entries){w.notify("Decoding intro "+entry.name);const auto name=filename(entry.name);const auto decoded=decode_audio_stream(intro.read(entry.name));w.wave(w.root/"Intro"/(name+".wav"),decoded.clip);stems.push_back({{"Source",entry.name},{"Clip",name+".wav"},{"Rate",decoded.clip.rate},{"Frames",decoded.clip.frames()}});}json_file(w.root/"Intro/stems.json",stems);}
        }
    }
    // Resolver rows must come from the user's executable. No retail rows or
    // guessed course-slot fallbacks are distributed in this importer.
    json_file(w.root/"Import.json",{{"Schema","openslope-native-audio-import/v1"},{"BanksConfigSection",section},{"AccountedBytes",w.bytes},{"Warnings",w.warnings},{"UnresolvedExternalEvents",environment["Unresolved"]},{"Deferred",{"executable-event-resolver","executable-board-surface-index","dynamic-character-chants","speech-codec","intro-and-async-runtime"}}});
    w.notify("Validating extracted Audio budget");std::uint64_t actual=0;std::size_t entries=0;for(const auto& file:std::filesystem::recursive_directory_iterator(w.root)){w.check();if(++entries>20000)throw std::runtime_error("Too many Audio cache entries");if(file.is_regular_file()){const auto size=std::filesystem::file_size(file.path());if(size>64*1024*1024||size>512*1024*1024-actual)throw std::runtime_error("Extracted Audio exceeds its cache budget");actual+=size;}}
    return true;
}
}
