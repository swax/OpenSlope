#include "openslope/replay.hpp"
#include <fstream>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace openslope {
namespace {
Vec3 vector(const nlohmann::json& value) {
    if (!value.is_array() || value.size() != 3)
        throw std::runtime_error("Invalid replay placement vector");
    Vec3 v{value[0], value[1], value[2]};
    if (!finite(v) || length(v) > 1e6)
        throw std::runtime_error("Replay vector exceeds its limit");
    return v;
}
} // namespace

Replay Replay::load(const std::filesystem::path& path) {
    if (std::filesystem::file_size(path) > 1024 * 1024)
        throw std::runtime_error("Replay exceeds 1 MiB");
    std::ifstream file(path);
    const auto doc = nlohmann::json::parse(file);
    if (doc.at("Schema") != "openslope-replay/v1")
        throw std::runtime_error("Unsupported replay schema");
    Replay result;
    if (doc.contains("Placement")) {
        const auto& p = doc.at("Placement");
        result.placement = true;
        result.position = vector(p.at("Position"));
        result.forward = vector(p.at("Forward"));
        if (p.contains("Velocity"))
            result.velocity = vector(p.at("Velocity"));
        if (p.contains("Up"))
            result.up = vector(p.at("Up"));
        if (length(cross(result.forward, result.up)) < 1e-9)
            throw std::runtime_error("Invalid replay orientation");
    }
    const auto& rows = doc.at("Steps");
    if (!rows.is_array() || rows.empty() || rows.size() > 10000)
        throw std::runtime_error("Invalid replay step count");
    std::size_t total = 0;
    for (const auto& row : rows) {
        ReplayStep step;
        step.ticks = row.at("Ticks");
        total += step.ticks;
        if (!step.ticks || total > 216000)
            throw std::runtime_error("Replay duration exceeds one hour");
        step.input = {row.value("Steer", 0.),
                      row.value("Boost", false),
                      row.value("Reset", false),
                      row.value("Jump", false),
                      row.value("Posture", 0.),
                      row.value("RailExit", false),
                      row.value("Mount", false),
                      row.contains("WalkForward") ? vector(row.at("WalkForward")) : Vec3{},
                      row.contains("RoomOffset") ? vector(row.at("RoomOffset")) : Vec3{}};
        if (!std::isfinite(step.input.steer) || !std::isfinite(step.input.posture) || std::abs(step.input.steer) > 1 ||
            std::abs(step.input.posture) > 1)
            throw std::runtime_error("Invalid replay control range");
        step.input.run_restart = row.value("RunRestart", false);
        step.input.spawn_board = row.value("SpawnBoard", false);
        if (row.contains("Equipment")) {
            const auto& value = row.at("Equipment");
            auto& e = step.input.equipment;
            e.tracked = value.value("Tracked", true);
            e.relative = value.value("Relative", false);
            e.head = value.contains("Head") ? vector(value.at("Head")) : Vec3{0, 1.65, 0};
            e.facing = value.contains("Facing") ? vector(value.at("Facing")) : Vec3{0, 0, -1};
            for (unsigned i = 0; i < 2; ++i) {
                if (value.contains("Grip"))
                    e.grip[i] = value.at("Grip").at(i).get<bool>();
                if (value.contains("Trigger"))
                    e.trigger[i] = value.at("Trigger").at(i).get<bool>();
                if (value.contains("Hands")) {
                    const auto& h = value.at("Hands").at(i);
                    auto& hand = e.hands[i];
                    hand.valid = h.value("Valid", true);
                    hand.position = vector(h.at("Position"));
                    if (h.contains("Right"))
                        hand.right = vector(h.at("Right"));
                    if (h.contains("Up"))
                        hand.up = vector(h.at("Up"));
                    if (h.contains("Forward"))
                        hand.forward = vector(h.at("Forward"));
                    if (hand.valid)
                        static_cast<void>(equipment_distance({}, hand));
                }
                if (value.contains("Rays")) {
                    const auto& r = value.at("Rays").at(i);
                    e.rays[i] = {vector(r.at("Origin")), vector(r.at("Direction")), r.value("Valid", true)};
                }
            }
        }
        result.steps.push_back(step);
        if (row.contains("VR")) {
            const auto& vr = row.at("VR");
            step.input.vr = {true, vr.value("Head", false), vr.value("Stick", false),
                             vr.contains("Gaze") ? vector(vr.at("Gaze")) : Vec3{}, vr.value("Spin", 0.)};
            if (!std::isfinite(step.input.vr.spin) || std::abs(step.input.vr.spin) > 1)
                throw std::runtime_error("Invalid VR replay spin");
            result.steps.back() = step;
        }
    }
    return result;
}

void Replay::run(Player& player, const std::function<void()>& after_tick) const {
    if (placement) {
        const auto foot = player.on_foot();
        player.warp(position, forward, velocity, up);
        if (foot)
            player.start_on_foot();
    }
    for (const auto& step : steps)
        for (unsigned i = 0; i < step.ticks; ++i) {
            player.advance(player.contract().tick_seconds(), step.input);
            if (after_tick)
                after_tick();
        }
}
} // namespace openslope
