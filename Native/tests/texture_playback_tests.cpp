#include "openslope/texture_playback.hpp"
#include "openslope/world_logic.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace {
using namespace openslope;
using Json = nlohmann::json;
unsigned checks = 0;

void check(bool ok, const char* message) {
    ++checks;
    if (!ok)
        throw std::runtime_error(message);
}

void near(double actual, double expected, const char* message) { check(std::abs(actual - expected) < 1e-8, message); }

void clocks() {
    ScrollPlayback linear({0, .01, -.02, 10, 0, 0});
    linear.step(.5);
    near(linear.offset()[0], .3, "native U advances per fixed tick");
    near(linear.offset()[1], -.6, "native V preserves its raw direction");
    linear.control(6, .25);
    linear.control(2, 0);
    linear.step(.5);
    near(linear.offset()[1], .25, "phase-only V remains where command six wrote it");
    ScrollPlayback continuous({0, .01, 0, 1, 0, 0});
    continuous.step(1);
    near(continuous.offset()[0], .6, "linear zero-pause cycles do not drop a texture tick");
    ScrollPlayback split({0, .01, 0, 10, 0, 0}), whole({0, .01, 0, 10, 0, 0});
    for (unsigned i = 0; i < 120; ++i)
        split.step(1. / 120);
    whole.step(1);
    near(split.offset()[0], whole.offset()[0], "render/update partitions share a fixed 60 Hz clock");
    ScrollPlayback ping({2, -.004, 0, .5, 1.5, 0});
    ping.step(29. / 60);
    near(ping.offset()[0], -.004 * 29, "constant ping-pong first leg");
    ping.step(1. / 60);
    check(!ping.active() && ping.direction() == -1, "boundary tick reverses and enters pause");
    const auto stopped = ping.offset();
    ping.step(1);
    check(ping.offset() == stopped, "pause preserves phase");
    ping.step(.5);
    check(ping.active(), "pause expires on authored tick");
    ping.step(1. / 60);
    check(ping.offset()[0] > stopped[0], "return leg reverses rate");
    ScrollPlayback eased({1, 1, 0, 1, 0, 0});
    eased.step(.5);
    near(eased.offset()[0], std::fmod(7.75, 1.), "eased mode reaches half-rate with triangular integration");
    eased.step(.5);
    check(eased.direction() == -1, "eased endpoint reverses");
    ScrollPlayback life({0, 0, 0, 1, 0, .5});
    life.step(.5);
    check(life.expired(), "positive scroll lifetime ends the node");
    ScrollPlayback other({9, .01, 0, 1, 0, 0});
    other.step(.1);
    near(other.offset()[0], .06, "unknown scroll modes retain linear law");
    const std::array<FlipMaterial, 2> banks{{{3, 2}, {7, 5}}};
    TexturePlayback flip({0, 0, 4, 0, false}, banks, 17);
    flip.step(.25);
    check(flip.frames()[0].frame == 1 && flip.frames()[1].frame == 1,
          "speed is frames per second, shared across independent banks");
    flip.control(2, 99);
    check(flip.frames()[0].frame == 1 && flip.frames()[1].frame == 4,
          "absolute select clamps each material separately");
    flip.control(3, 0);
    check(flip.frames()[0].frame == 0 && flip.frames()[1].frame == 0, "advance wraps each material's own frame count");
    flip.control(4, 0);
    flip.step(1);
    check(flip.frames()[0].frame == 0, "disabled flip clock holds state");
    flip.control(4, 1);
    flip.step(.25);
    check(flip.frames()[0].frame == 1, "enabled clock resumes");
    TexturePlayback reverse({0, 1, 4, 0, false}, banks, 1);
    reverse.step(.25);
    check(reverse.frames()[0].frame == 1 && reverse.frames()[1].frame == 4, "reverse wraps independently per bank");
    TexturePlayback dwell({-2, 1, 1, 0, true}, banks, 17);
    dwell.step(1);
    check(dwell.frames()[0].frame == 1, "dwell ignores random start/direction and has exact initial hold");
    dwell.step(.1);
    check(dwell.frames()[0].frame == 0, "flash is six fixed ticks");
    dwell.step(.5);
    check(dwell.frames()[0].frame == 0, "rerolled dwell lasts at least a second");
    TexturePlayback pulse({0, 0, 3.5, .5, false}, banks, 1);
    pulse.control(2, 1);
    pulse.step(.2);
    check(pulse.frames()[0].frame == 1, "pulse holds selected frame before first advance");
    pulse.step(.1);
    check(pulse.frames()[0].frame == 0, "pulse advances at authored fractional rate");
    pulse.step(.2);
    check(pulse.expired(), "finite pulse expires at exact lifetime");
    TexturePlayback random({-2, 0, 60, 0, false}, banks, 19);
    bool differs = false;
    for (unsigned i = 0; i < 80; ++i) {
        random.step(1. / 60);
        differs |= random.frames()[1].frame != unsigned((i + 1) % 5);
        check(random.frames()[0].frame < 2 && random.frames()[1].frame < 5, "random frame remains inside each bank");
    }
    check(differs, "random-every-advance is not a sequential cycle");
}

void write(const std::filesystem::path& root, const char* name, const Json& value) {
    std::ofstream(root / name) << value;
}

Json node(int main, Json payload = Json::object(), Json refs = Json::object()) {
    return {{"mainType", main}, {"payload", payload}, {"references", refs}};
}

Json property(unsigned sub, Json fields) {
    return node(0, {{"type0", {{"SubType", sub}, {sub == 10 ? "UVScroll" : "TextureFlip", fields}}}});
}

void runtime(const std::filesystem::path& root) {
    write(root, "Models.json",
          {{"Models",
            Json::array(
                {{{"ModelObjects",
                   Json::array({{{"MeshData", Json::array({{{"MaterialID", 0}, {"MeshPath", "unused.obj"}}})}}})}}})}});
    write(root, "Materials.json",
          {{"Materials",
            Json::array({{{"TexturePath", "base.png"}, {"TextureFlipbook", {"first.png", "second.png"}}}})}});
    Json instances = Json::array();
    for (unsigned i = 0; i < 3; ++i)
        instances.push_back({{"ModelID", 0},
                             {"Location", {i * 100, 0, 0}},
                             {"Visable", true},
                             {"PlayerCollision", true},
                             {"EffectSlotIndex", i == 0   ? 0
                                                 : i == 1 ? 1
                                                          : -1}});
    write(root, "Instances.json", {{"Instances", instances}});
    Json doc = {{"kind", "openslope-effects"},
                {"version", 1},
                {"graphs", Json::array()},
                {"functions", Json::array()},
                {"slots", Json::array()}};
    doc["graphs"].push_back(
        {{"id", "scroll"},
         {"nodes",
          Json::array({property(10, {{"U0", 0}, {"U1", .01}, {"U2", 0}, {"U3", 10}, {"U4", 0}, {"U5", 0}})})}});
    doc["graphs"].push_back(
        {{"id", "flip"},
         {"nodes", Json::array({property(11, {{"U0", 0}, {"Direction", 0}, {"Speed", 3.5}, {"Length", .5}, {"U4", 0}}),
                                node(3, {{"type3", {{"U0", 2}, {"U1", 1}}}})})}});
    doc["graphs"].push_back(
        {{"id", "stop"}, {"nodes", Json::array({node(0, {{"type0", {{"SubType", 5}, {"DeadNodeMode", 1}}}})})}});
    for (const auto graph : {"scroll", "flip"})
        doc["slots"].push_back({{"id", graph},
                                {"circumstances",
                                 {{"persistent", std::string(graph) == "scroll" ? Json(graph) : Json(nullptr)},
                                  {"collision", std::string(graph) == "flip" ? Json(graph) : Json("stop")}}}});
    write(root, "Effects.json", doc);
    auto logic = WorldLogic::load(root);
    const std::array<Vec3, 1> view{{{0, 0, 0}}};
    logic.tick(0, 0, view);
    check(logic.texture_frames().size() == 1, "only reached persistent graph installs a clock");
    logic.tick(.25);
    near(logic.texture_frames()[0].uv[0], .15, "world node drives fixed scroll ticks");
    logic.contact(1, 0);
    check(logic.texture_frames().size() == 2 && logic.texture_frames()[1].materials[0].frame == 1,
          "collision pulse and absolute select are visible in the same tick");
    logic.contact(0, 0);
    logic.tick(.25);
    near(logic.texture_frames()[0].uv[0], .15, "node-pause holds the private offset");
    logic.tick(.25);
    check(logic.texture_frames().size() == 1, "finite pulse teardown restores resting appearance");
    check(logic.flags()[1] & WorldDraw, "pulse expiration restores visible authored prop");
    logic.restart(RunMode::Freeride);
    check(logic.texture_frames().empty(), "restart removes all private frame and UV overrides");
    logic.tick(.1, 0, view);
    near(logic.texture_frames()[0].uv[0], .06, "region constructor after restart begins at zero phase");
}
} // namespace

int main() {
    try {
        clocks();
        const auto root = std::filesystem::temp_directory_path() /
                          ("openslope-texture-playback-" +
                           std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::create_directory(root);

        struct Cleanup {
            std::filesystem::path p;

            ~Cleanup() {
                std::error_code e;
                std::filesystem::remove_all(p, e);
            }
        } cleanup{root};

        runtime(root);
        std::cout << "PASS: " << checks << " fixed-clock, per-material, pulse/dwell, receiver and lifecycle checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
