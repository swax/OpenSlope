#include "openslope/replay.hpp"
#include <nlohmann/json.hpp>
#include <fstream>
#include <stdexcept>

namespace openslope {
namespace {
Vec3 vector(const nlohmann::json& value){if(!value.is_array()||value.size()!=3)throw std::runtime_error("Invalid replay placement vector");Vec3 v{value[0],value[1],value[2]};if(!finite(v)||length(v)>1e6)throw std::runtime_error("Replay vector exceeds its limit");return v;}
}
Replay Replay::load(const std::filesystem::path& path){
    if(std::filesystem::file_size(path)>1024*1024)throw std::runtime_error("Replay exceeds 1 MiB");std::ifstream file(path);const auto doc=nlohmann::json::parse(file);
    if(doc.at("Schema")!="openslope-replay/v1")throw std::runtime_error("Unsupported replay schema");Replay result;
    if(doc.contains("Placement")){const auto& p=doc.at("Placement");result.placement=true;result.position=vector(p.at("Position"));result.forward=vector(p.at("Forward"));if(p.contains("Velocity"))result.velocity=vector(p.at("Velocity"));if(p.contains("Up"))result.up=vector(p.at("Up"));if(length(cross(result.forward,result.up))<1e-9)throw std::runtime_error("Invalid replay orientation");}
    const auto& rows=doc.at("Steps");if(!rows.is_array()||rows.empty()||rows.size()>10000)throw std::runtime_error("Invalid replay step count");std::size_t total=0;
    for(const auto& row:rows){ReplayStep step;step.ticks=row.at("Ticks");total+=step.ticks;if(!step.ticks||total>216000)throw std::runtime_error("Replay duration exceeds one hour");
        step.input={row.value("Steer",0.),row.value("Boost",false),row.value("Reset",false),row.value("Jump",false),row.value("Posture",0.)};if(!std::isfinite(step.input.steer)||!std::isfinite(step.input.posture)||std::abs(step.input.steer)>1||std::abs(step.input.posture)>1)throw std::runtime_error("Invalid replay control range");result.steps.push_back(step);
    }return result;
}
void Replay::run(Player& player,const std::function<void()>& after_tick) const {
    if(placement)player.warp(position,forward,velocity,up);
    for(const auto& step:steps)for(unsigned i=0;i<step.ticks;++i){player.advance(player.contract().tick_seconds(),step.input);if(after_tick)after_tick();}
}
}
