#include "openslope/fence.hpp"
#include "openslope/player.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <limits>
#include <nlohmann/json.hpp>
#include <set>

namespace {
using namespace openslope;
using Json = nlohmann::json;
constexpr double h = 1. / 60;
unsigned checks = 0;

void check(bool value, const char* message) {
    ++checks;
    if (!value)
        throw std::runtime_error(message);
}

void near(double a, double b, const char* message) { check(std::abs(a - b) < 1e-7, message); }

template <class F> void rejects(F f) {
    bool failed = false;
    try {
        f();
    } catch (const std::exception&) {
        failed = true;
    }
    check(failed, "Invalid fence input was accepted");
}

void write(const std::filesystem::path& root, const char* name, const Json& value) {
    std::ofstream(root / name) << value;
}

Json read(const std::filesystem::path& path) { return Json::parse(std::ifstream(path)); }

Json node(int main, Json payload, Json refs = Json::object()) {
    return {{"mainType", main}, {"payload", payload}, {"references", refs}};
}

Json fence() { return node(0, {{"type0", {{"SubType", 12}, {"Fence", {{"U0", 0}, {"FlexAmmount", .5}}}}}}); }

void clocks() {
    FencePlayback a(.5, {1, 12, 0}), b(.5, {1, 0, 0});
    near(length(a.offset()), 0, "Fence begins at rest without a discontinuity");
    a.step(1. / 18);
    near(a.offset().x, .1 * std::exp(-5. / 18), "Quarter cycle has the independent damped peak");
    near(a.offset().y, 0, "Vertical impact does not lift the fence");
    a.step(1. / 9);
    check(a.offset().x < 0, "Spring returns through the opposite side");
    b.step(.5);
    FencePlayback partition(.5, {1, 0, 0}), opposite(.5, {-1, 0, 0}), negative(-.5, {1, 0, 0});
    for (unsigned i = 0; i < 30; ++i) {
        partition.step(h);
        opposite.step(h);
        negative.step(h);
    }
    near(partition.offset().x, b.offset().x, "Clock partitions do not change the reaction");
    near(opposite.offset().x, -b.offset().x, "Opposite hit reverses the rattle");
    near(negative.offset().x, -b.offset().x, "Signed flex is retained");
    FencePlayback bounded(1e9, {1, 0, 0});
    bounded.step(1. / 18);
    check(length(bounded.offset()) <= .25, "Custom flex has a bounded presentation envelope");
    check(FencePlayback(0, {1, 0, 0}).settled() && FencePlayback(.5, {0, 1, 0}).settled(),
          "Zero flex and absent horizontal impacts are inert");
    for (unsigned i = 30; i < 96; ++i)
        partition.step(h);
    check(partition.settled(), "Ninety-six fixed ticks settle the reaction exactly");
    near(length(partition.offset()), 0, "Completed spring has exact resting geometry");
    partition.step(1);
    near(length(partition.offset()), 0, "Completed spring stays at rest");
    const auto nan = std::numeric_limits<double>::quiet_NaN();
    rejects([&] { FencePlayback bad(nan, {}); });
    rejects([&] { FencePlayback bad(1, {nan, 0, 0}); });
    rejects([&] { a.step(-1); });
    rejects([&] { a.step(nan); });
}

Json fixture(const std::filesystem::path& root) {
    std::filesystem::create_directories(root / "Meshes");
    std::ofstream(root / "Meshes/panel.obj") << "v -100 0 0\nv 100 0 0\nv 100 0 200\nv -100 0 200\n"
                                                "vn 0 -1 0\nf 1//1 2//1 3//1 4//1\n";
    Json points = Json::array();
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            points.push_back({(u / 3. - .5) * 20000, (v / 3. - .5) * 20000, 0});
    write(root, "Patches.json",
          {{"Patches", Json::array({{{"PatchName", "Fence test floor"},
                                     {"SurfaceType", 1},
                                     {"TrickOnlyPatch", false},
                                     {"Points", points},
                                     {"TexturePath", ""},
                                     {"LightmapID", -1},
                                     {"UVPoints", {{0, 0}, {0, 1}, {1, 0}, {1, 1}}},
                                     {"LightMapPoint", {0, 0, 0, 0}}}})}});
    const Json object = {{"ParentID", -1},
                         {"CollisionBounds", {{"Min", {-100, -5, 0}}, {"Max", {100, 5, 200}}}},
                         {"MeshData", Json::array({{{"MeshPath", "panel.obj"}, {"MaterialID", 0}}})}};
    write(root, "Models.json", {{"Models", Json::array({{{"ModelObjects", Json::array({object})}}})}});
    write(root, "Materials.json", {{"Materials", Json::array({{{"TexturePath", nullptr}}})}});
    Json rows = Json::array();
    for (unsigned i = 0; i < 7; ++i)
        rows.push_back({{"ModelID", 0},
                        {"Location", {i * 1000, 0, 0}},
                        {"Visable", i != 3},
                        {"PlayerCollision", i != 4},
                        {"CollsionMode", 2},
                        {"U0", 0},
                        {"EffectSlotIndex", 0}});
    rows[2]["Rotation"] = {0, 0, std::sqrt(.5), std::sqrt(.5)};
    rows[2]["Scale"] = {2, 3, .5};
    rows[5]["EffectSlotIndex"] = 1;
    rows[6]["EffectSlotIndex"] = 2;
    write(root, "Instances.json", {{"Instances", rows}});
    Json doc = {
        {"kind", "openslope-effects"},
        {"version", 1},
        {"functions", Json::array()},
        {"graphs",
         Json::array({{{"id", "hit"}, {"nodes", Json::array({node(8, {{"SoundPlay", 123}}), fence()})}},
                      {{"id", "end"}, {"nodes", Json::array({node(8, {{"SoundPlay", 456}})})}},
                      {{"id", "empty"}, {"nodes", Json::array()}},
                      {{"id", "controller"},
                       {"nodes", Json::array({node(7, {{"Instance", {{"Effect", 1}}}},
                                                   {{"instance", "instance:0"}, {"effectGraph", "pause"}})})}},
                      {{"id", "pause"},
                       {"nodes", Json::array({node(0, {{"type0", {{"SubType", 5}, {"DeadNodeMode", 1}}}})})}}})},
        {"slots",
         Json::array({{{"id", "ordinary"}, {"originalIndex", 0}, {"circumstances", {{"collision", "hit"}}}},
                      {{"id", "latched"},
                       {"originalIndex", 1},
                       {"circumstances", {{"collision", "hit"}, {"slot4", "end"}, {"slot3", "empty"}}}},
                      {{"id", "remote"}, {"originalIndex", 2}, {"circumstances", {{"collision", "controller"}}}}})}};
    write(root, "Effects.json", doc);
    return doc;
}

const PropMotion& motion(const WorldLogic& logic, std::size_t host) {
    const auto rows = logic.motions();
    const auto found = std::find_if(rows.begin(), rows.end(), [host](const auto& row) { return row.instance == host; });
    check(found != rows.end(), "Reaction has its private draw binding");
    return *found;
}

void runtime(const std::filesystem::path& root) {
    auto doc = fixture(root);
    auto logic = WorldLogic::load(root);
    const auto initial = std::vector<std::uint8_t>(logic.flags().begin(), logic.flags().end());
    logic.contact(0, 12, true, 1, {1, 0, 0});
    check(logic.take_actions().size() == 1, "Collision graph continues through its cue and fence node");
    check(logic.motions().size() == 1 && logic.bodies() == 0 && logic.unsupported() == 0,
          "Fence creates one reaction without rigid bodies or unsupported operations");
    logic.tick(h);
    auto previous = motion(logic, 0).current[0];
    check(previous[12] > 0 && motion(logic, 0).visual_only, "Fence moves visually in the impact direction");
    logic.contact(0, 12, true, 1, {-1, 0, 0});
    check(logic.take_actions().empty(), "Sustained contacts cannot restart or spam the reaction graph");
    check(std::equal(logic.flags().begin(), logic.flags().end(), initial.begin()),
          "Reaction preserves draw and collision flags");
    auto world = CollisionWorld::load(root);
    const std::array<ProbeSphere, 1> start{{{{0, 1, 2}, .05}}}, end{{{{0, 1, -2}, .05}}};
    const auto baseline = world.sweep(start, end);
    check(!baseline.empty() && baseline[0].instance == 0, "Authored pass-through fence proxy is available");
    world.motion(logic.motions(), h);
    const auto stayed = world.sweep(start, end);
    check(!stayed.empty(), "Visual rattle retains the authored proxy");
    near(length(stayed[0].point - baseline[0].point), 0, "Visual displacement cannot move the collision proxy");
    near(length(stayed[0].surface_velocity), 0, "Cosmetic spring cannot transfer velocity to the rider");
    auto physical = motion(logic, 0);
    physical.visual_only = false;
    physical.current[0][12] = 1;
    physical.previous = physical.current;
    world.motion(std::span(&physical, 1), h);
    const std::array<ProbeSphere, 1> edge_start{{{{1.5, 1, 2}, .05}}}, edge_end{{{{1.5, 1, -2}, .05}}};
    check(!world.sweep(edge_start, edge_end).empty(), "Physical motion still moves the authored proxy");
    world.motion(logic.motions(), h);
    check(world.sweep(edge_start, edge_end).empty(), "Visual replacement restores a previously moving proxy");
    auto duplicate = std::vector<PropMotion>{motion(logic, 0), motion(logic, 0)};
    rejects([&] { world.motion(duplicate, h); });
    auto invalid = motion(logic, 0);
    invalid.current[0][12] = std::numeric_limits<double>::quiet_NaN();
    rejects([&] { world.motion(std::span(&invalid, 1), h); });
    logic.contact(2, 12, true, 1, {1, 0, 0});
    logic.tick(h);
    const auto placement = prop_placements(root).at(2);
    const auto shift =
        transform_point(placement, transform_point(motion(logic, 2).current[0], {})) - transform_point(placement, {});
    check(shift.x > 0 && std::abs(shift.y) < 1e-7 && std::abs(shift.z) < 1e-7,
          "Rotated nonuniform placements retain the world impact axis");
    logic.contact(3, 12, true, 1, {1, 0, 0});
    check(!(logic.flags()[3] & WorldDraw), "A hidden collidable fence stays hidden");
    const auto count = logic.motions().size();
    logic.contact(4, 12, true, 1, {1, 0, 0});
    check(logic.motions().size() == count, "Disabled colliders cannot install reactions");
    logic.take_actions();
    logic.contact(6, 12);
    previous = motion(logic, 0).current[0];
    logic.tick(.5);
    check(motion(logic, 0).current[0] == previous, "Stop command freezes the current rattle");
    logic.restart(RunMode::Freeride);
    check(logic.motions().empty(), "Restart removes reactions and interpolation state");
    logic.contact(0, 12, true, 1, {1, 0, 0});
    for (unsigned i = 0; i < 96; ++i)
        logic.tick(h);
    check(logic.motions().empty(), "Ordinary spring self-removes after settling");
    logic.take_actions();
    logic.contact(0, 12, true, 1, {1, 0, 0});
    check(logic.take_actions().size() == 1, "Settled fence accepts a later new hit");
    logic.restart(RunMode::Freeride);
    logic.contact(5, 12, true, 1, {1, 0, 0});
    logic.take_actions();
    for (unsigned i = 0; i < 120; ++i)
        logic.tick(h);
    check(logic.take_actions().size() == 1, "Node-end chain runs once through the ordinary lifetime gate");
    check(motion(logic, 5).current[0] == identity_transform(), "End latch holds exact rest without extra motion");
    const std::array<Vec3, 1> near_observer{{{0, 0, 0}}}, far_observer{{{2000, 0, 0}}};
    logic.restart(RunMode::Freeride);
    logic.tick(0, 0, near_observer);
    logic.contact(0, 12, true, 1, {1, 0, 0});
    logic.tick(h, 0, far_observer);
    logic.tick(h, 0, far_observer);
    check(logic.motions().empty(), "Unlatched region unload tears down the reaction");
    logic.restart(RunMode::Freeride);
    logic.tick(0, 0, near_observer);
    logic.contact(5, 12, true, 1, {1, 0, 0});
    logic.tick(h, 0, far_observer);
    logic.tick(h, 0, far_observer);
    check(!logic.motions().empty(), "Populated region-exit latch keeps the reaction alive");
    for (const auto foot : {false, true}) {
        Player player(Terrain::load(root));
        player.warp({0, -.005, 2}, {0, 0, -1}, {0, 0, -14});
        if (foot)
            player.start_on_foot();
        RideInput input;
        input.walk_forward = {0, 0, -1};
        input.posture = foot ? 1 : 0;
        bool reacted = false;
        for (unsigned i = 0; i < 80; ++i) {
            player.tick(input);
            reacted |= !player.logic().motions().empty();
        }
        check(reacted, "Real mounted and walking contacts both reach the fence property");
        check(player.rider().motion != Motion::Wipeout && finite(player.rider().position),
              "Fence contact preserves control and a finite rider pose");
    }
}

void owned(const std::filesystem::path& maps) {
    unsigned total = 0, reactions = 0, excluded = 0;
    for (const auto course : {"GARI", "MEGAPLE", "MERQUER", "SNOW"}) {
        const auto root = maps / course;
        const auto doc = read(root / "Effects.json");
        const auto instances = read(root / "Instances.json").at("Instances");
        std::set<std::string> chains;
        for (const auto& row : doc.at("graphs"))
            for (const auto& n : row.at("nodes"))
                if (n.at("mainType") == 0 && n.at("payload").at("type0").value("SubType", -1) == 12)
                    chains.insert(row.at("id").get<std::string>());
        std::set<int> slots;
        for (const auto& slot : doc.at("slots")) {
            const auto collision = slot.at("circumstances").value("collision", Json());
            if (collision.is_string() && chains.contains(collision.get<std::string>()))
                slots.insert(slot.at("originalIndex").get<int>());
        }
        auto logic = WorldLogic::load(root);
        const auto placements = prop_placements(root);
        std::set<std::size_t> covered;
        for (const auto mode : {RunMode::Freeride, RunMode::Race, RunMode::Showoff}) {
            logic.restart(mode);
            const auto unsupported = logic.unsupported();
            std::vector<std::size_t> hosts;
            for (std::size_t i = 0; i < instances.size(); ++i)
                if (slots.contains(instances[i].value("EffectSlotIndex", -1))) {
                    const bool eligible = (logic.flags()[i] & WorldCollide) != 0;
                    const auto before = logic.motions().size();
                    logic.contact(i, 12, true, 1, {1, 0, 0});
                    if (eligible) {
                        hosts.push_back(i);
                        covered.insert(i);
                    } else {
                        check(logic.motions().size() == before, "Mode-excluded fences cannot react");
                        ++excluded;
                    }
                }
            check(!hosts.empty(), "Owned course has reachable collision fences");
            check(logic.unsupported() == unsupported, "Owned fence chains add no unsupported operations");
            logic.tick(h);
            for (const auto host : hosts) {
                const auto& moving = motion(logic, host);
                check(moving.visual_only && !moving.current.empty(), "Every owned fence creates a visual-only binding");
                const auto& placement = placements[host];
                const auto offset =
                    transform_point(placement, transform_point(moving.current[0], {})) - transform_point(placement, {});
                check(offset.x > .001 && offset.x < .1 && std::abs(offset.y) < 1e-6 && std::abs(offset.z) < 1e-6,
                      "Owned scaled/rest-frame panels rattle along the supplied world impact");
            }
            for (unsigned i = 1; i < 100; ++i)
                logic.tick(h);
            for (const auto& moving : logic.motions())
                check(std::find(hosts.begin(), hosts.end(), moving.instance) == hosts.end(),
                      "Owned springs retire their draw overrides");
            reactions += unsigned(hosts.size());
            std::cout << course << ' '
                      << (mode == RunMode::Freeride ? "freeride"
                          : mode == RunMode::Race   ? "race"
                                                    : "showoff")
                      << ": " << hosts.size() << " collision fence reactions settled\n";
        }
        total += unsigned(covered.size());
    }
    check(total == 1788, "Cover every imported fence including showoff-only Snowdream panels");
    std::cout << "Owned fences: " << total << " unique placements; " << reactions << " reactions; " << excluded
              << " mode exclusions\n";
}
} // namespace

int main(int argc, char** argv) {
    std::filesystem::path root;
    bool owns_root = false;
    try {
        clocks();
        root = std::filesystem::temp_directory_path() /
               ("openslope-fence-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        check(std::filesystem::equivalent(root.parent_path(), std::filesystem::temp_directory_path()) &&
                  !std::filesystem::exists(root),
              "Fence fixture owns a fresh directory immediately below the temporary root");
        check(std::filesystem::create_directory(root), "Create the private fence fixture directory");
        owns_root = true;
        runtime(root);
        std::filesystem::remove_all(root);
        owns_root = false;
        if (argc > 1)
            owned(argv[1]);
        std::cout << "PASS: " << checks << " fence clock, draw, contact, collision-isolation and lifecycle checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        if (owns_root)
            std::filesystem::remove_all(root);
        return 1;
    }
}
