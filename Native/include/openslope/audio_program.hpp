#pragma once
#include <map>
#include <string>
#include <vector>
#include <array>

namespace openslope {
struct RideAudioSignals {double slip{},dig{},lean{},board{},bend{};};
struct RideAudioLevel {double volume{},bend{};};
struct AudioInstruction {std::string op,signal;double first{},second{};};
using AudioProgram=std::vector<AudioInstruction>;
using AudioPrograms=std::map<std::string,std::map<std::string,AudioProgram>>;
AudioPrograms parse_audio_programs(const std::string& text);
RideAudioLevel evaluate_audio_program(const AudioProgram& program,RideAudioSignals signals);
double ambient_curve(unsigned curve,double distance);
}
