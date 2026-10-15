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
        production(root);
        if (argc == 2)
            courses(argv[1]);
        std::cout << "PASS: " << checks
                  << " world graph, mode, pickup/reset, tombstone, timer, sound and production checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
