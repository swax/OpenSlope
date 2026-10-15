#include "openslope/flag.hpp"
#include "openslope/world_logic.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <limits>
#include <nlohmann/json.hpp>

namespace {
using namespace openslope;
using Json = nlohmann::json;
unsigned checks = 0;

void check(bool v, const char* message) {
    ++checks;
    if (!v)
        throw std::runtime_error(message);
}

void near(double a, double b, const char* message) { check(std::abs(a - b) < 1e-6, message); }

template <class F> void rejects(F f) {
    bool failed = false;
    try {
        f();
    } catch (const std::exception&) {
        failed = true;
    }
    check(failed, "Invalid wave input was accepted");
}

void write(const std::filesystem::path& root, const char* name, const Json& value) {
    std::ofstream(root / name) << value;
}

Json node(int main, Json payload = Json::object(), Json refs = Json::object()) {
    return {{"mainType", main}, {"payload", payload}, {"references", refs}};
}

Json flag(double life = 0) {
    return node(0, {{"type0", {{"SubType", 13}, {"type0Sub13", {{"U0", 0}, {"U1", 1.5}, {"U2", 25}, {"U3", life}}}}}});
}

void clock_tests() {
    FlagWave wave{false, 40, 0};
    near(flag_displacement(0, wave), 0, "First pole stays fixed");
    near(flag_displacement(.25, wave), 10, "Quarter station grows one quarter amplitude");
    near(flag_displacement(.5, wave), 0, "Half station crosses zero");
    near(flag_displacement(.75, wave), -30, "Three quarter station has opposite sign");
    wave.phase = .25;
    near(flag_displacement(1, wave), -40, "Free end reaches authored peak");
    wave.opposite = true;
    near(flag_displacement(1, wave), 0, "Opposite pole stays fixed");
    near(flag_displacement(0, wave), -40, "Opposite free end reaches peak");
    FlagPlayback a({false, 1.5, 25, 0}, .2), b({false, 1.5, 25, 0}, .2);
    a.step(.5);
    for (unsigned i = 0; i < 30; ++i)
        b.step(1. / 60);
    near(a.wave().phase, .95, "Speed is cycles per second");
    near(a.wave().phase, b.wave().phase, "Fixed-tick partitions agree");
    a.step(1);
    near(a.wave().phase, .45, "Phase wraps without unbounded angle");
    check(!a.expired(), "Zero lifetime persists");
    FlagPlayback reverse({false, -1, 0, 0}, .1);
    reverse.step(.2);
    near(reverse.wave().phase, .9, "Negative speed reverses phase");
    FlagPlayback finite({true, 2, 25, .25}, .2);
    finite.step(.5);
    check(finite.expired(), "Finite flag reaches end");
    near(finite.wave().phase, .7, "Lifetime stops at exact boundary");
    finite.step(1);
    near(finite.wave().phase, .7, "Expired wave holds final phase");
    const auto nan = std::numeric_limits<double>::quiet_NaN();
    rejects([&] { FlagPlayback bad({false, nan, 0, 0}, 0); });
    rejects([&] { FlagPlayback bad({}, 1); });
    rejects([&] { a.step(-1); });
    rejects([&] { a.step(nan); });
    rejects([&] { flag_displacement(1.1, wave); });
    PropPose pose;
    pose.matrix = {0, 0, -2, 0, 0, 3, 0, 0, 4, 0, 0, 0, 5, 6, 7, 1};
    pose.uv = {.2f, .3f, 0, 0};
    const auto moved = flag_pose(pose, {true, 40, .25});
    near(moved.uv[2], .2, "Centimetres and X scale normalized");
    near(moved.uv[3], 2.25, "Pole selection and phase packed independently");
    near(moved.uv[0], pose.uv[0], "U scroll preserved");
    near(moved.uv[1], pose.uv[1], "V scroll preserved");
    const auto shift =
        transform_point(Transform{0, 0, -2, 0, 0, 3, 0, 0, 4, 0, 0, 0, 5, 6, 7, 1}, {moved.uv[2], 0, 0}) -
        Vec3{5, 6, 7};
    near(length(shift), .4, "Rotated scaled flag keeps world amplitude");
    Bounds box;
    box.add({0, 0, 0});
    box.add({0, 1, 2});
    const auto bounds = flag_bounds(box, moved);
    check(bounds.min.z < 6.61 && bounds.max.z > 7.39, "Culling includes both wave extremes");
    pose.matrix[2] = 0;
    rejects([&] { flag_pose(pose, wave); });
}

void runtime(const std::filesystem::path& root) {
    std::filesystem::create_directories(root / "Meshes");
    std::ofstream(root / "Meshes/flag.obj") << "v 0 100 200\nv 0 100 0\nv 0 -100 200\nv 0 -50 0\nvt 0 0\nvt 0 1\nvt 1 "
                                               "0\nvt 1 1\nvn -1 0 0\nf 1/1/1 2/2/1 3/3/1\nf 3/3/1 2/2/1 4/4/1\n";
    write(root, "Models.json",
          {{"Models",
            Json::array(
                {{{"ModelObjects",
                   Json::array({{{"MeshData", Json::array({{{"MeshPath", "flag.obj"}, {"MaterialID", 0}}})}}})}}})}});
    write(root, "Materials.json", {{"Materials", Json::array({{{"TexturePath", nullptr}}})}});
    Json instances = Json::array();
    for (unsigned i = 0; i < 4; ++i)
        instances.push_back({{"ModelID", 0},
                             {"Location", {i * 100, 0, 0}},
                             {"EffectSlotIndex", i == 3 ? -1 : int(i)},
                             {"Visable", i != 2},
                             {"PlayerCollision", true}});
    write(root, "Instances.json", {{"Instances", instances}});
    Json doc = {{"kind", "openslope-effects"},
                {"version", 1},
                {"graphs", Json::array()},
                {"functions", Json::array()},
                {"slots", Json::array()}};
    const auto graph = [&](const char* id, Json nodes) { doc["graphs"].push_back({{"id", id}, {"nodes", nodes}}); };
    graph("wave", Json::array({flag()}));
    graph("finite", Json::array({flag(.25)}));
    graph("end",
          Json::array({node(8, {{"SoundPlay", 123}}), node(0, {{"type0", {{"SubType", 5}, {"DeadNodeMode", 1}}}})}));
    graph("pause", Json::array({node(0, {{"type0", {{"SubType", 5}, {"DeadNodeMode", 1}}}})}));
    graph("delete", Json::array({node(0, {{"type0", {{"SubType", 5}, {"DeadNodeMode", 0}}}})}));
    doc["slots"] = Json::array(
        {{{"id", "a"}, {"circumstances", {{"persistent", "wave"}, {"collision", "pause"}}}},
         {{"id", "b"}, {"circumstances", {{"persistent", "finite"}, {"slot4", "end"}, {"collision", "delete"}}}},
         {{"id", "c"}, {"circumstances", {{"persistent", "wave"}}}}});
    write(root, "Effects.json", doc);
    auto logic = WorldLogic::load(root);
    check(logic.flag_models().size() == 1 && logic.flag_models()[0] == 0,
          "Reachable graph identifies model before upload");
    const auto base = Props::load(root);
    const auto prepared = Props::load(root, false, logic.flag_models());
    check(base.geometry.vertices.size() == 4 && base.geometry.indices.size() == 6,
          "Original geometry unchanged without flag preparation");
    check(prepared.geometry.vertices.size() == 22 && prepared.geometry.indices.size() == 54,
          "Eight sections added once for shared model");
    check(prepared.parts[0].first == 0 && prepared.parts[0].count == 6 && prepared.parts[0].wave_count == 48,
          "Original draw and wave draw are separate");
    for (unsigned k = 0; k <= 8; ++k)
        for (unsigned side = 0; side < 2; ++side) {
            const auto& v = prepared.geometry.vertices[4 + 2 * k + side];
            near(v.ls, double(k) / 8, "Every station recorded");
            near(v.lt, 1, "Only wave vertices carry marker");
            near(v.s, double(k) / 8, "UV follows sampled edges");
            near(v.t, 1 - double(side), "Cross-edge UV retains OBJ inversion");
            near(v.y, side ? 0 : 2, "Tapered flag retains vertical endpoints");
        }
    const std::array<Vec3, 1> view{{{0, 0, 0}}};
    logic.tick(0, 0, view);
    check(logic.unsupported() == 0 && logic.texture_frames().size() == 3,
          "Reached flag graphs install without unsupported nodes");
    check(logic.flags()[2] & WorldDraw, "Flag constructor enables draw on hidden host");
    const auto phase = logic.texture_frames()[0].wave->phase, second = logic.texture_frames()[1].wave->phase;
    check(std::abs(phase - second) > .001, "Flags have private random starting phases");
    logic.tick(.1);
    near(logic.texture_frames()[0].wave->phase, std::fmod(phase + .15, 1.), "World fixed tick advances flag");
    logic.contact(0, 0);
    const auto paused = logic.texture_frames()[0].wave->phase;
    logic.tick(.2);
    near(logic.texture_frames()[0].wave->phase, paused, "Pause freezes flag clock");
    auto actions = logic.take_actions();
    check(actions.size() == 1 && actions[0].kind == WorldActionKind::CourseSound && actions[0].value == 123,
          "Positive lifetime invokes slot-four end chain once");
    const auto ending = logic.texture_frames()[1].wave->phase;
    logic.tick(.2);
    near(logic.texture_frames()[1].wave->phase, ending, "End chain may hold final wave");
    check(logic.take_actions().empty(), "End chain is not fired twice");
    logic.contact(1, 0);
    check(logic.texture_frames().size() == 2, "Tear down removes wave override");
    logic.tick(0, 0, std::array<Vec3, 1>{{{2000, 0, 0}}});
    logic.tick(0, 0, std::array<Vec3, 1>{{{2000, 0, 0}}});
    check(logic.texture_frames().empty(), "Region unload clears persistent waves");
    logic.tick(0, 0, view);
    check(logic.texture_frames().size() == 3, "Region re-entry constructs waves again");
    logic.restart(RunMode::Freeride);
    check(logic.texture_frames().empty(), "Restart clears wave state");
    logic.tick(0, 0, view);
    near(logic.texture_frames()[0].wave->phase, phase, "Restart is deterministic for replay");
    // A function may install a flag on a different host than the entry slot owner.
    std::ifstream model_file(root / "Models.json");
    auto models = Json::parse(model_file);
    models["Models"].push_back(models["Models"][0]);
    write(root, "Models.json", models);
    instances[3]["ModelID"] = 1;
    write(root, "Instances.json", {{"Instances", instances}});
    doc["graphs"][0]["nodes"] = Json::array({node(26, Json::object(), {{"function", "helper"}})});
    doc["functions"] = Json::array(
        {{{"id", "helper"},
          {"name", "helper"},
          {"nodes", Json::array({node(7, Json::object(), {{"instance", "instance:3"}, {"effectGraph", "target"}})})}}});
    graph("target", Json::array({flag()}));
    write(root, "Effects.json", doc);
    auto indirect = WorldLogic::load(root);
    check(indirect.flag_models().size() == 2 && indirect.flag_models()[1] == 1,
          "Function and targeted graph traversals prepare target model");
    indirect.tick(0, 0, view);
    check(std::any_of(indirect.texture_frames().begin(), indirect.texture_frames().end(),
                      [](const auto& state) { return state.instance == 3 && state.wave.has_value(); }),
          "Targeted flag belongs to target instance");
}

void owned(const std::filesystem::path& maps) {
    unsigned total = 0;
    for (const auto& [name, count] : std::array<std::pair<const char*, unsigned>, 4>{
             {{"ELYSIUM", 22}, {"MEGAPLE", 12}, {"MESA", 38}, {"SNOW", 47}}}) {
        const auto root = maps / name;
        auto logic = WorldLogic::load(root);
        check(logic.flag_models().size() == count, "Owned course flag model count");
        auto props = Props::load(root, false, logic.flag_models());
        unsigned parts = 0;
        std::vector<Vec3> observers;
        for (const auto model : logic.flag_models())
            for (const auto part : props.models[model].parts) {
                check(props.parts[part].wave_count == 48, "Owned flag is prepared into eight sections");
                ++parts;
            }
        for (const auto& instance : props.instances)
            if (std::find(logic.flag_models().begin(), logic.flag_models().end(), instance.model) !=
                logic.flag_models().end())
                observers.push_back({instance.pose.matrix[12], instance.pose.matrix[13], instance.pose.matrix[14]});
        logic.tick(0, 0, observers);
        const auto active = std::count_if(logic.texture_frames().begin(), logic.texture_frames().end(),
                                          [](const auto& frame) { return frame.wave.has_value(); });
        check(active == count, "Owned flag constructors all reached");
        logic.tick(1. / 60);
        total += parts;
        std::cout << name << ": " << parts << " prepared and active flag strips\n";
    }
    check(total == 119, "All 119 authored flag placements covered");
}
} // namespace

int main(int argc, char** argv) {
    std::filesystem::path root;
    try {
        clock_tests();
        root = std::filesystem::temp_directory_path() /
               ("openslope-flag-tests-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        runtime(root);
        std::filesystem::remove_all(root);
        if (argc > 1)
            owned(argv[1]);
        std::cout << "PASS: " << checks << " flag clock, geometry, scaling and lifecycle checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << "\n";
        if (!root.empty())
            std::filesystem::remove_all(root);
        return 1;
    }
}
