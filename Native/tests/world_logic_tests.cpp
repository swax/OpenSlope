#include "openslope/audio_scene.hpp"
#include <bit>
#include <chrono>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace {
using namespace openslope;
using Json = nlohmann::json;
unsigned checks = 0;
constexpr double h = 1. / 60;

void check(bool value, const char* message) {
    ++checks;
    if (!value)
        throw std::runtime_error(message);
}

void write(const std::filesystem::path& root, const char* name, const Json& value) {
    std::ofstream(root / name) << value;
}

Json node(int main, Json payload = Json::object(), Json refs = Json::object()) {
    return {{"id", "node"}, {"mainType", main}, {"payload", payload}, {"references", refs}};
}

Json property(int sub, Json fields) {
    fields["SubType"] = sub;
    return node(0, {{"type0", fields}});
}

Json graph(std::string id, Json nodes) { return {{"id", id}, {"nodes", nodes}}; }

Json document(Json nodes) {
    return {
        {"kind", "openslope-effects"},
        {"version", 1},
        {"graphs", Json::array({graph("pickup", nodes)})},
        {"functions", Json::array()},
        {"slots",
         Json::array({{{"id", "shared-slot"}, {"originalIndex", 0}, {"circumstances", {{"collision", "pickup"}}}}})},
        {"objectProperties", Json::array()},
        {"instances", Json::array()},
        {"splines", Json::array()}};
}

void fixture(const std::filesystem::path& root) {
    Json points = Json::array();
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            points.push_back({double(u) * 200000 / 3 - 100000, double(v) * 200000 / 3 - 100000, 0});
    write(root, "Patches.json",
          {{"Patches", Json::array({{{"PatchName", "World logic floor"},
                                     {"SurfaceType", 1},
                                     {"TrickOnlyPatch", false},
                                     {"Points", points},
                                     {"TexturePath", ""},
                                     {"LightmapID", -1},
                                     {"UVPoints", {{0, 0}, {0, 1}, {1, 0}, {1, 1}}},
                                     {"LightMapPoint", {0, 0, 0, 0}}}})}});
    const Json object = {{"ParentID", -1},
                         {"Position", {0, 0, 0}},
                         {"Rotation", {0, 0, 0, 1}},
                         {"Scale", {1, 1, 1}},
                         {"CollisionBounds", {{"Min", {-100, -100, 0}}, {"Max", {100, 100, 200}}}},
                         {"MeshData", Json::array()}};
    const Json model = {{"ModelName", "World fixture"}, {"ModelObjects", Json::array({object})}};
    write(root, "Models.json", {{"Models", Json::array({model})}});
    Json rows = Json::array();
    for (unsigned i = 0; i < 4; ++i)
        rows.push_back({{"ModelID", 0},
                        {"Location", {i * 2000, 0, 0}},
                        {"Rotation", {0, 0, 0, 1}},
                        {"Scale", {1, 1, 1}},
                        {"Visable", true},
                        {"PlayerCollision", true},
                        {"CollsionMode", 2},
                        {"U0", i == 3 ? 1 : 0},
                        {"PlayerBounce", true},
                        {"PlayerBounceAmmount", .5},
                        {"EffectSlotIndex", 0},
                        {"SurfaceType", -1},
                        {"LTGState", i == 0 ? 2 : 0}});
    write(root, "Instances.json", {{"Instances", rows}});
}

void pickup(const std::filesystem::path& root) {
    const auto doc = document(Json::array({node(14, {{"MultiplierScore", 3}}), property(5, {{"DeadNodeMode", 2}})}));
    write(root, "Effects.json", doc);
    auto logic = WorldLogic::load(root);
    check(logic.faceted_models().size() == 1 && logic.faceted_models()[0] == 0,
          "Multiplier metadata identifies faceted pickup models without names or hard-coded slots");
    check(logic.flags()[0] == 0, "LTG Showoff layer absent in Freeride");
    logic.restart(RunMode::Showoff);
    check(logic.flags()[0] == 3, "Showoff restores pickup draw and collision eligibility");
    logic.contact(0, 20);
    const auto actions = logic.take_actions();
    check(actions.size() == 2 && actions[0].kind == WorldActionKind::Multiplier && actions[0].value == 3 &&
              actions[1].kind == WorldActionKind::MainSound && actions[1].value == 117,
          "gem applies tier and separate MAIN chime");
    check(logic.flags()[0] == 0, "collection tombstones draw and collision together");
    logic.contact(0, 20);
    check(logic.take_actions().empty(), "collected gem cannot score again");
    for (unsigned i = 0; i < 60; ++i)
        logic.tick(1);
    check(logic.flags()[0] == 0, "clean pickup tombstone does not respawn on a timer");
    logic.restart(RunMode::Showoff);
    check(logic.flags()[0] == 3, "new run restores initial pickup state");
    logic.restart(RunMode::Race);
    logic.contact(0, 20);
    check(logic.take_actions().empty(), "Race cannot contact Showoff-only object");
    logic.contact(1, 20);
    const auto nongem = logic.take_actions();
    check(nongem.size() == 1 && nongem[0].kind == WorldActionKind::MainSound,
          "direct non-Showoff invocation chimes without applying multiplier");
    auto bindings = doc;
    bindings["slots"][0]["originalIndex"] = 17;
    bindings["slots"][0]["id"] = "slot-new";
    bindings["slots"].insert(bindings["slots"].begin(), Json{{"id", "unused"}, {"circumstances", Json::object()}});
    bindings["objectProperties"].push_back({{"id", "property-new"}, {"references", {{"effectSlot", "slot-new"}}}});
    bindings["instances"].push_back({{"id", "custom-gem"}, {"originalIndex", 999}, {"property", "property-new"}});
    write(root, "Effects.json", bindings);
    auto stable = WorldLogic::load(root);
    stable.restart(RunMode::Showoff);
    stable.contact(0, 20);
    check(stable.take_actions().size() == 2,
          "stable property/instance links resolve independent of original slot metadata");
}

void flow(const std::filesystem::path& root) {
    auto doc = document(Json::array({node(8, {{"SoundPlay", 7}}), node(4, {{"WaitTime", .05}}), node(13)}));
    write(root, "Effects.json", doc);
    auto wait = WorldLogic::load(root);
    wait.contact(1, 20);
    check(wait.take_actions().size() == 1, "chain runs sound before wait");
    wait.contact(1, 20);
    check(wait.take_actions().empty(), "live waiting contact chain does not refire");
    wait.tick(h);
    wait.tick(h);
    check(wait.take_actions().empty(), "wait does not end early");
    wait.tick(h);
    auto delayed = wait.take_actions();
    check(delayed.size() == 1 && delayed[0].kind == WorldActionKind::Reset && delayed[0].rider,
          "wait resumes with triggering rider ownership");
    wait.contact(1, 20);
    check(wait.take_actions().size() == 1, "completed wait re-arms even without contact exit");
    for (const auto duration : {.1, 0., -1.}) {
        write(root, "Effects.json",
              document(Json::array({property(2, {{"Debounce", duration}}), node(8, {{"SoundPlay", 8}})})));
        auto debounce = WorldLogic::load(root);
        debounce.contact(1, 20);
        check(debounce.take_actions().size() == 1, "debounce installation lets following action run");
        debounce.contact(1, 20);
        check(debounce.take_actions().empty(), "debounce suppresses repeated contact");
        for (unsigned i = 0; i < 6; ++i)
            debounce.tick(h);
        debounce.contact(1, 20);
        check(debounce.take_actions().size() == (duration > 0 ? 1u : 0u),
              "positive debounce expires; zero/negative persist without unload");
    }
    doc = document(Json::array(
        {node(21, Json::object(), {{"function", "child"}}), node(26, Json::object(), {{"function", "detached"}})}));
    doc["functions"] = {
        {{"id", "child"}, {"name", "Child"}, {"nodes", Json::array({node(13)})}},
        {{"id", "detached"}, {"name", "Detached"}, {"nodes", Json::array({node(13), node(8, {{"SoundPlay", 9}})})}}};
    write(root, "Effects.json", doc);
    auto calls = WorldLogic::load(root);
    calls.contact(1, 20);
    const auto inherited = calls.take_actions();
    check(inherited.size() == 2 && inherited[0].kind == WorldActionKind::Reset && inherited[0].rider &&
              inherited[1].kind == WorldActionKind::CourseSound && !inherited[1].rider,
          "function call inherits rider; detached child has no rider");
    doc["functions"][0]["nodes"].push_back(node(21, Json::object(), {{"function", "child"}}));
    write(root, "Effects.json", doc);
    auto cycle = WorldLogic::load(root);
    cycle.contact(1, 20);
    check(cycle.take_actions().size() == 2, "custom function cycles terminate without duplicating rider actions");
    doc = document(Json::array({node(5, {{"type5", {{"U0", 2}}}}), node(13)}));
    write(root, "Effects.json", doc);
    auto human = WorldLogic::load(root);
    human.contact(1, 20, false);
    check(human.take_actions().empty(), "human gate kills remaining chain for an AI owner");
    human.contact(1, 20, true);
    check(human.take_actions().size() == 1, "human contact passes the gate");
    for (const auto selector : {0u, 1u}) {
        doc["graphs"][0]["nodes"][0] = node(
            5, {{"type5",
                 {{"U0", 0}, {"U1", std::bit_cast<float>(selector)}, {"U2", std::bit_cast<std::uint32_t>(30.f)}}}});
        write(root, "Effects.json", doc);
        auto speed = WorldLogic::load(root);
        speed.contact(1, 20);
        check(speed.take_actions().size() == selector, "speed ceiling uses centimetres/sec and floor uses km/h");
    }
}

void show(const std::filesystem::path& root) {
    std::ifstream input(root / "Instances.json");
    Json rows;
    input >> rows;
    input.close();
    rows["Instances"][3]["Visable"] = false;
    write(root, "Instances.json", rows);
    auto doc = document(Json::array({node(7, {{"Instance", {{"Effect", 1}}}}, {{"instance", "instance:3"}})}));
    write(root, "Effects.json", doc);
    auto logic = WorldLogic::load(root);
    check(!(logic.flags()[3] & WorldDraw), "initially hidden target stays hidden before show");
    logic.contact(1, 20);
    check(logic.flags()[3] & WorldDraw, "portable show reveals an initially hidden target");
    rows["Instances"][3]["Visable"] = true;
    write(root, "Instances.json", rows);
}

void budget(const std::filesystem::path& root) {
    Json nodes = Json::array();
    for (unsigned i = 0; i < 5000; ++i)
        nodes.push_back(node(99));
    nodes.push_back(node(13));
    write(root, "Effects.json", document(nodes));
    auto logic = WorldLogic::load(root);
    logic.contact(1, 20);
    check(logic.unsupported() == 4096 && logic.take_actions().empty(),
          "one oversized graph stops at the fixed-tick work budget");
    logic.contact(2, 20);
    check(logic.unsupported() == 4096, "a second contact cannot reset the frame budget");
    logic.tick(h);
    logic.contact(1, 20);
    check(logic.unsupported() == 8192, "a new fixed tick restores the bounded work budget");
}

void modes(const std::filesystem::path& root) {
    auto doc = document(Json::array());
    doc["graphs"].push_back(graph("hide", Json::array({property(5, {{"DeadNodeMode", 2}})})));
    doc["functions"] = {
        {{"id", "first"},
         {"name", "RaceMode"},
         {"nodes", Json::array({node(7, Json::object(), {{"instance", "instance:3"}, {"effectGraph", "hide"}}),
                                node(25, {{"Spline", {{"Effect", 0}}}}, {{"spline", "rail"}})})}},
        {{"id", "second"},
         {"name", "RaceMode"},
         {"nodes", Json::array({node(7, Json::object(), {{"instance", "instance:2"}, {"effectGraph", "hide"}})})}}};
    doc["splines"] = {{{"id", "rail"}, {"originalIndex", 999}, {"data", Json::object()}}};
    for (unsigned i = 0; i < 4; ++i)
        doc["splines"].insert(doc["splines"].begin(),
                              Json{{"id", "other-" + std::to_string(i)}, {"data", Json::object()}});
    write(root, "Effects.json", doc);
    auto mode = WorldLogic::load(root);
    mode.restart(RunMode::Race);
    check(mode.flags()[3] == 0 && mode.flags()[2] == 3,
          "first named mode function wins and nested hide reaches its target");
    auto actions = mode.take_actions();
    check(actions.size() == 1 && actions[0].kind == WorldActionKind::RailToggle && actions[0].target == 4 &&
              actions[0].value == 0,
          "mode function targets stable rail identity");
    mode.restart(RunMode::Showoff);
    check(mode.flags()[3] == 3, "mode restart discards previous mode hides");
    auto duplicate = doc;
    duplicate["graphs"].push_back(duplicate["graphs"][0]);
    write(root, "Effects.json", duplicate);
    bool rejected = false;
    try {
        static_cast<void>(WorldLogic::load(root));
    } catch (const std::runtime_error&) {
        rejected = true;
    }
    check(rejected, "duplicate graph IDs are rejected");
}

void interaction_resets(const std::filesystem::path& root) {
    fixture(root);
    const Json kill = property(5, {{"DeadNodeMode", 2}}), stop = property(5, {{"DeadNodeMode", 3}}),
               latched = property(5, {{"DeadNodeMode", 4}});
    const Json call = node(7, Json::object(), {{"instance", "instance:3"}, {"effectGraph", "child"}});
    const Json flag = property(13, {{"type0Sub13", {{"U0", 0}, {"U1", 1}, {"U2", 1}}}});
    const std::array<Vec3, 1> eyes{{{0, 0, 0}}};
    const auto advance = [&](WorldLogic& logic, double seconds) {
        while (seconds > 1e-8) {
            const auto dt = std::min(.1, seconds);
            logic.tick(dt, 12, eyes);
            seconds -= dt;
        }
    };
    auto doc = document(Json::array({kill, node(4, {{"WaitTime", 1}}), call}));
    doc["graphs"].push_back(graph("child", Json::array({stop})));
    doc["graphs"].push_back(graph("persistent", Json::array({flag})));
    doc["slots"][0]["circumstances"]["persistent"] = "persistent";
    write(root, "Effects.json", doc);
    auto group = WorldLogic::load(root);
    group.tick(0, 12, eyes);
    group.contact(1, 12);
    check(group.flags()[1] == 0 && group.flags()[3] == 3, "group reset preserves the authored child delay");
    advance(group, 29.9);
    check(group.flags()[1] == 0 && group.flags()[3] == 0,
          "whole chain remains broken until the thirty-second boundary");
    group.tick(0, 12, eyes);
    check(group.flags()[1] == 0, "a zero-duration tick cannot consume the reset deadline");
    advance(group, .1);
    check(group.flags()[1] == 3 && group.flags()[3] == 3, "source and delayed target restore on one deadline");
    check(std::any_of(group.texture_frames().begin(), group.texture_frames().end(),
                      [](const auto& frame) { return frame.instance == 1 && frame.wave.has_value(); }),
          "nearby persistent appearance is reinstalled on reset");
    group.contact(1, 12);
    check(group.flags()[1] == 0, "restored collider can trigger a second break");

    auto overlap = WorldLogic::load(root);
    overlap.contact(1, 12);
    advance(overlap, 20);
    overlap.contact(2, 12);
    advance(overlap, 10.1);
    check(overlap.flags()[1] == 3 && overlap.flags()[2] == 0 && overlap.flags()[3] == 0,
          "newer shared-target interaction survives the first source's reset");
    advance(overlap, 20);
    check(overlap.flags()[2] == 3 && overlap.flags()[3] == 3, "shared target returns with the later source");

    auto delayed = doc;
    delayed["graphs"][0]["nodes"] = Json::array({kill, node(4, {{"WaitTime", 35}}), call});
    write(root, "Effects.json", delayed);
    auto expired = WorldLogic::load(root);
    expired.contact(1, 12);
    advance(expired, 36);
    check(expired.flags()[1] == 3 && expired.flags()[3] == 3,
          "old delayed work cannot break a restored target after reset");
    expired.contact(1, 12);
    check(expired.flags()[1] == 0, "reset releases the old collision-chain busy latch");
    expired.restart(RunMode::Freeride);
    advance(expired, 36);
    check(expired.flags()[1] == 3 && expired.flags()[3] == 3,
          "run restart clears deadlines and delayed interaction work");

    auto mode = document(Json::array({kill, call, node(25, {{"Spline", {{"Effect", 1}}}}, {{"spline", "rail"}})}));
    mode["graphs"].push_back(graph("child", Json::array({stop})));
    mode["graphs"].push_back(graph("hide", Json::array({kill})));
    mode["splines"] = {{{"id", "rail"}, {"originalIndex", 0}, {"data", Json::object()}}};
    mode["functions"] = {
        {{"id", "mode"},
         {"name", "RaceMode"},
         {"nodes", Json::array({node(7, Json::object(), {{"instance", "instance:3"}, {"effectGraph", "hide"}}),
                                node(25, {{"Spline", {{"Effect", 0}}}}, {{"spline", "rail"}})})}}};
    write(root, "Effects.json", mode);
    auto hidden = WorldLogic::load(root);
    hidden.restart(RunMode::Race);
    hidden.take_actions();
    hidden.contact(1, 12);
    advance(hidden, 30.1);
    check(hidden.flags()[1] == 3 && hidden.flags()[3] == 0, "interaction reset preserves nested mode-entry hides");
    const auto rails = hidden.take_actions();
    check(std::any_of(
              rails.begin(), rails.end(),
              [](const auto& action) { return action.kind == WorldActionKind::RailToggle && action.value == 1; }) &&
              rails.back().kind == WorldActionKind::RailToggle && rails.back().value == 0,
          "related rail restores its mode-specific value rather than a global default");
    hidden.restart(RunMode::Showoff);
    advance(hidden, 35);
    check(hidden.flags()[3] == 3, "new mode restores a formerly hidden instance");

    auto reward_group = document(Json::array({node(14, {{"MultiplierScore", 3}}), kill, call}));
    reward_group["graphs"].push_back(graph("child", Json::array({stop})));
    write(root, "Effects.json", reward_group);
    auto collected = WorldLogic::load(root);
    collected.restart(RunMode::Showoff);
    collected.contact(0, 12);
    check(collected.flags()[0] == 0 && collected.flags()[3] == 0,
          "collected source and non-rewarding related object both hide");
    advance(collected, 30.1);
    check(collected.flags()[0] == 0 && collected.flags()[3] == 3,
          "actual collection stays spent while related debris resets despite sharing a reward slot");
    collected.restart(RunMode::Showoff, true);
    check(collected.flags()[0] == 3 && collected.flags()[3] == 3,
          "run restart restores gems while retaining the separate collected-pad policy");
    collected.restart(RunMode::Showoff);
    check(collected.flags()[0] == 3, "new run restores collected rewards");

    auto permanent = document(Json::array({latched}));
    permanent["graphs"].push_back(graph("keep", Json::array()));
    permanent["slots"][0]["circumstances"]["slot3"] = "keep";
    write(root, "Effects.json", permanent);
    auto kept = WorldLogic::load(root);
    kept.contact(1, 12);
    advance(kept, 35);
    check(kept.flags()[1] == 0,
          "authored permanent kill retains its region-exit latch beyond the application deadline");
    const std::array<Vec3, 1> distant{{{10000, 0, 0}}};
    kept.tick(.1, 0, distant);
    kept.tick(.1, 0, distant);
    kept.tick(.1, 0, eyes);
    check(kept.flags()[1] == 0, "permanent recipe remains hidden across region exit and reentry");

    auto roller = document(Json::array({property(0, {{"type0Sub0", {{"U0", 5}, {"U3", 0}, {"U4", 0}, {"U5", 0}}}})}));
    write(root, "Effects.json", roller);
    auto moving = WorldLogic::load(root);
    moving.contact(1, 12);
    advance(moving, 29.9);
    check(moving.flags()[1] == (WorldDraw | WorldCollide | WorldDynamic),
          "movable prop remains live before the shared deadline");
    advance(moving, .1);
    check(moving.flags()[1] == 3, "movable prop restores authored collision and draw state at thirty seconds");

    auto stopped = document(Json::array({property(5, {{"DeadNodeMode", 1}})}));
    stopped["graphs"].push_back(graph("persistent", Json::array({flag})));
    stopped["slots"][0]["circumstances"]["persistent"] = "persistent";
    write(root, "Effects.json", stopped);
    auto paused = WorldLogic::load(root);
    paused.tick(0, 12, eyes);
    paused.contact(1, 12);
    advance(paused, 35);
    check(paused.flags()[1] == 3, "pause-only command is not classified as a breakable");
}

void production(const std::filesystem::path& root) {
    auto doc = document(Json::array({node(14, {{"MultiplierScore", 2}}), property(5, {{"DeadNodeMode", 2}})}));
    doc["graphs"].push_back(graph("reset", Json::array({node(13)})));
    doc["slots"].push_back({{"id", "reset-slot"}, {"originalIndex", 1}, {"circumstances", {{"collision", "reset"}}}});
    auto rows = Json::parse(std::ifstream(root / "Instances.json"));
    rows["Instances"][1]["EffectSlotIndex"] = 1;
    write(root, "Instances.json", rows);
    write(root, "Effects.json", doc);
    Player player(Terrain::load(root));
    player.configure_run(RunMode::Showoff);
    player.warp({-200, -.005, 0}, {1, 0, 0});
    for (unsigned i = 0; i < 181; ++i)
        player.tick({});
    player.warp({-3, -.005, 0}, {1, 0, 0}, {600, 0, 0});
    const auto before = player.rider();
    player.tick({});
    check(player.scoring().status().multiplier == 2 && player.logic().flags()[0] == 0,
          "real body sweep collects and tombstones gem in the same tick");
    const std::array<ProbeSphere, 1> from{{{{-3, .9, 0}, .85}}}, to{{{{3, .9, 0}, .85}}};
    check(player.world().sweep(from, to).empty(), "runtime tombstone is removed from collision broadphase");
    player.warp({-3, -.005, 0}, {1, 0, 0}, {600, 0, 0});
    player.tick({});
    check(player.logic().flags()[0] == 0 && player.scoring().status().multiplier == 1,
          "placement preserves tombstone while cancelling pending trick multiplier");
    player.restart_run();
    check(player.logic().flags()[0] == 3, "full run restart restores pickup collision and draw");
    player.configure_run(RunMode::Showoff);
    player.warp({-200, -.005, 0}, {1, 0, 0});
    for (unsigned i = 0; i < 181; ++i)
        player.tick({});
    player.warp({0, .2, 0}, {1, 0, 0}, {0, -20, 0});
    player.scoring().step(h, ScoreMotion::Air);
    for (unsigned i = 0; i < 80; ++i)
        player.scoring().step(h, ScoreMotion::Air, 4.5);
    player.tick({});
    check(player.scoring().status().banked == 3390 && player.scoring().status().multiplier == 1,
          "gem collected during touchdown multiplies the trick banked that frame");
    player.configure_run(RunMode::Freeride);
    player.warp({17, -.005, 0}, {1, 0, 0}, {600, 0, 0});
    player.tick({});
    check(player.reset_pending(), "authored volume uses shared reset even in Freeride");
    for (unsigned i = 0; i < 48; ++i)
        player.tick({});
    check(!player.reset_pending() && player.last_course_recovery(),
          "authored volume completes course placement under fade");
    write(root, "Slopesmith.json", {{"schema", 1}, {"kind", "slopesmith-export"}, {"showoffSeconds", .01}});
    Player expired(Terrain::load(root));
    expired.configure_run(RunMode::Showoff);
    expired.warp({-200, -.005, 0}, {1, 0, 0});
    for (unsigned i = 0; i < 181; ++i)
        expired.tick({});
    check(expired.course_run().status().phase == RunPhase::Expired, "World-contact regression starts after time up");
    expired.warp({-3, -.005, 0}, {1, 0, 0}, {600, 0, 0});
    expired.tick({});
    check(expired.logic().flags()[0] == 0 && expired.scoring().status().multiplier == 1 &&
              expired.scoring().status().total() == 0,
          "Expired rider still activates and tombstones a pickup while scoring remains frozen");
    expired.warp({17, -.005, 0}, {1, 0, 0}, {600, 0, 0});
    expired.tick({});
    check(expired.reset_pending(), "Authored reset contacts remain available after time up");
    std::filesystem::remove(root / "Slopesmith.json");
    const auto audio_root = root / "Audio";
    std::filesystem::create_directories(audio_root / "SFX/main");
    write(root, "Audio/SoundIndex.json",
          {{"Schema", "openslope-sound-index/v1"}, {"Banks", {{"0", "main"}}}, {"CollisionEvents", Json::object()}});
    PcmClip clip;
    clip.channels = 1;
    clip.rate = 48000;
    clip.samples.resize(4800, .25f);
    write_wave(audio_root / "SFX/main/116.wav", clip);
    AudioScene audio(root);
    player.configure_run(RunMode::Showoff);
    player.warp({-200, -.005, 0}, {1, 0, 0});
    for (unsigned i = 0; i < 181; ++i)
        player.tick({});
    player.warp({-3, -.005, 0}, {1, 0, 0}, {600, 0, 0});
    player.tick({});
    audio.tick(player, before);
    std::array<float, 1600> samples{};
    audio.mixer().render(samples);
    check(audio.stats().transients > 0 &&
              std::any_of(samples.begin(), samples.end(), [](float s) { return std::abs(s) > .01f; }),
          "pickup MAIN chime reaches actual PCM output");
}

void owned_resets(const std::filesystem::path& maps) {
    const auto root = maps / "MESA";
    const auto rows = Json::parse(std::ifstream(root / "Instances.json")).at("Instances");
    const auto instance = [&](const char* name) {
        for (std::size_t i = 0; i < rows.size(); ++i)
            if (rows[i].value("InstanceName", "") == name)
                return i;
        throw std::runtime_error("Owned falling-tree fixture is missing");
    };
    const auto trigger = instance("Mdl_Trigger_Fireworks_5001"), trunk = instance("Mdl_TreeTrunk_EvergreenB_Fall_0"),
               other = instance("Mdl_TreeTrunk_EvergreenB_Fall_1");
    const auto placements = prop_placements(root);
    const auto& m = placements[trigger];
    const std::array<Vec3, 1> eyes{{{m[12], m[13], m[14]}}};
    auto logic = WorldLogic::load(root);
    logic.tick(0, 14, eyes);
    logic.take_actions();
    const auto original_trigger = logic.flags()[trigger], original_trunk = logic.flags()[trunk];
    logic.contact(trigger, 14);
    unsigned enabled = 0, restored = 0;
    bool falling = false;
    for (unsigned frame = 1; frame <= 1801; ++frame) {
        logic.tick(h, 14, eyes);
        if (frame == 240)
            for (const auto& motion : logic.motions())
                if (motion.instance == trunk)
                    falling = !motion.current.empty() && motion.current[0] != identity_transform();
        for (const auto& action : logic.take_actions())
            if (action.kind == WorldActionKind::RailToggle && (action.target == 87 || action.target == 88)) {
                enabled += action.value == 1 && frame < 1800;
                restored += action.value == 0 && frame >= 1800;
            }
    }
    check(falling && enabled == 2, "actual MESA tree changes pose and both tree rails activate after their wait");
    check(logic.flags()[trigger] == original_trigger && logic.flags()[trunk] == original_trunk,
          "actual MESA trigger and tree restore authored presence after thirty seconds");
    check(std::none_of(logic.motions().begin(), logic.motions().end(),
                       [&](const auto& motion) { return motion.instance == trunk || motion.instance == other; }),
          "actual MESA falling-tree transforms are removed on group reset");
    check(restored == 2, "actual MESA tree rails return to their mode-specific disabled state together");
}

void courses(const std::filesystem::path& maps) {
    unsigned count = 0;
    for (const auto& entry : std::filesystem::directory_iterator(maps))
        if (entry.is_directory() && std::filesystem::exists(entry.path() / "Patches.json")) {
            auto logic = WorldLogic::load(entry.path());
            check(logic.chains() > 0, "owned course exposes authored graphs from existing files");
            unsigned showoff = 0, free = 0;
            for (auto flag : logic.flags())
                free += (flag & WorldDraw) != 0;
            logic.restart(RunMode::Showoff);
            for (auto flag : logic.flags())
                showoff += (flag & WorldDraw) != 0;
            check(showoff >= free, "Showoff enables authored dedicated layer");
            std::cout << entry.path().filename().string() << ": " << logic.chains() << " graphs/functions; " << free
                      << " Freeride / " << showoff << " Showoff drawable instances\n";
            ++count;
        }
    check(count == 11, "all eleven local course behavior tables load");
}
} // namespace

int main(int argc, char** argv) {
    try {
        const auto root =
            std::filesystem::temp_directory_path() /
            ("openslope-world-logic-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::create_directory(root);

        struct Cleanup {
            std::filesystem::path path;

            ~Cleanup() {
                std::error_code ec;
                std::filesystem::remove_all(path, ec);
            }
        } cleanup{root};

        fixture(root);
        pickup(root);
        flow(root);
        show(root);
        budget(root);
        modes(root);
        interaction_resets(root);
        production(root);
        if (argc == 2) {
            courses(argv[1]);
            owned_resets(argv[1]);
        }
        std::cout << "PASS: " << checks
                  << " world graph, mode, pickup/reset, tombstone, timer, sound and production checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
