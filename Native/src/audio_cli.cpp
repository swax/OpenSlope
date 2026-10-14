#include "openslope/audio_data.hpp"
#include "openslope/music.hpp"
#include <nlohmann/json.hpp>
#include <fstream>
#include <iostream>

int main(int argc,char** argv){
    try{
        if(argc==5&&std::string(argv[1])=="graph"){
            const auto graph_path=std::filesystem::path(argv[2]),stream_path=std::filesystem::path(argv[3]),output=std::filesystem::path(argv[4]);if(std::filesystem::exists(output))throw std::runtime_error("Graph output already exists");const auto read=[](const std::filesystem::path& path){const auto size=std::filesystem::file_size(path);if(size>128*1024*1024)throw std::runtime_error("Music input exceeds its limit");std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size));std::ifstream f(path,std::ios::binary);f.read(reinterpret_cast<char*>(bytes.data()),std::streamsize(size));if(!f)throw std::runtime_error("Cannot read music input");return bytes;};
            const auto graph=openslope::MusicGraph::decode(read(graph_path));const auto music=read(stream_path);std::filesystem::create_directories(output);for(const auto& sample:graph.samples){const auto decoded=openslope::decode_audio_stream(music,sample.offset);openslope::write_wave(output/sample.wav,decoded.clip);}graph.save(output/"graph.json",graph_path.stem().string());std::cout<<"Decoded "<<graph.nodes.size()<<" nodes, "<<graph.samples.size()<<" audio chunks and "<<graph.variables.size()<<" variable lists\n";return 0;
        }
        if(argc!=4)throw std::runtime_error("Usage: openslope_audio bank <bank> <new-directory> | stream <stream> <new-wave>");const auto input=std::filesystem::path(argv[2]),output=std::filesystem::path(argv[3]);const auto size=std::filesystem::file_size(input);if(size>128*1024*1024)throw std::runtime_error("Audio input exceeds 128 MiB");std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size));std::ifstream file(input,std::ios::binary);file.read(reinterpret_cast<char*>(bytes.data()),std::streamsize(size));if(!file)throw std::runtime_error("Cannot read audio input");if(std::filesystem::exists(output))throw std::runtime_error("Audio output already exists");
        const std::string operation=argv[1];if(operation=="stream"){const auto decoded=openslope::decode_audio_stream(bytes);openslope::write_wave(output,decoded.clip);std::cout<<"Decoded "<<decoded.clip.frames()<<" frames at "<<decoded.clip.rate<<" Hz\n";return 0;}
        if(operation!="bank")throw std::runtime_error("Unknown audio operation");const auto bank=openslope::decode_audio_bank(bytes);std::filesystem::create_directories(output);nlohmann::json rows=nlohmann::json::array();unsigned populated=0;
        for(std::size_t i=0;i<bank.slots.size();++i){if(!bank.slots[i]){rows.push_back(nullptr);continue;}const auto& clip=*bank.slots[i];auto number=std::to_string(i);while(number.size()<3)number.insert(number.begin(),'0');const auto name=number+".wav";openslope::write_wave(output/name,clip);rows.push_back({{"Clip",name},{"Rate",clip.rate},{"Channels",clip.channels},{"Frames",clip.frames()},{"LoopStart",clip.loop_start},{"LoopEnd",clip.loop_end},{"Priority",clip.priority}});
            if(clip.loop_end){auto loop=clip;loop.samples={clip.samples.begin()+clip.loop_start*clip.channels,clip.samples.begin()+clip.loop_end*clip.channels};loop.loop_start=loop.loop_end=0;openslope::write_wave(output/(number+".loop.wav"),loop);}++populated;
        }
        std::ofstream metadata(output/"bank.json");metadata<<nlohmann::json({{"Schema","openslope-audio-bank/v1"},{"Slots",rows}}).dump()<<'\n';if(!metadata)throw std::runtime_error("Cannot write audio bank metadata");std::cout<<"Decoded "<<populated<<" populated slots of "<<bank.slots.size()<<'\n';return 0;
    }catch(const std::exception& e){std::cerr<<"OpenSlope audio: "<<e.what()<<'\n';return 1;}
}
