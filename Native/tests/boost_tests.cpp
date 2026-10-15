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
constexpr double dt = 1. / 60;

void check(bool ok, const char* why) {
    ++checks;
    if (!ok)
        throw std::runtime_error(why);
}

void near(double a, double b, const char* why) { check(std::abs(a - b) < 1e-6, why); }

void equal(Vec3 a, Vec3 b, const char* why) { near(length(a - b), 0, why); }

void write(const std::filesystem::path& root, const char* name, const Json& value) {
    std::ofstream(root / name) << value;
}

Json node(int main, Json fields = Json::object()) {
    return {{"mainType", main}, {"payload", fields}, {"references", Json::object()}};
}

Json prop(int kind, Json fields) {
    return node(0, {{"type0", {{"SubType", kind}, {"type0Sub" + std::to_string(kind), fields}}}});
}

Json directional(double rate = 4, double target = 20, Json axis = {1, 0, 0}, int mode = 1, double seconds = 0) {
    return node(
        0,
        {{"type0",
          {{"SubType", 7},
           {"Boost", {{"Mode", mode}, {"U1", seconds}, {"U2", rate}, {"BoostAmount", target}, {"BoostDir", axis}}}}}});
}

Json document(Json nodes) {
    return {{"kind", "openslope-effects"},
            {"version", 1},
            {"graphs", Json::array({{{"id", "contact"}, {"nodes", nodes}}})},
            {"slots", Json::array({{{"id", "slot"}, {"circumstances", {{"collision", "contact"}}}}})},
            {"functions", Json::array()},
            {"instances", Json::array()},
            {"objectProperties", Json::array()},
            {"splines", Json::array()}};
}

std::optional<BoostVolume> box = BoostVolume{Bounds{{-10, 0, -10}, {10, 100, 10}}, {1, 0, 0}};

void apply(ScriptedBoost& boost, BoostRider& rider, bool inside = true, const LapEntry& entry = {}) {
    const std::array<std::optional<BoostVolume>, 1> volumes{inside ? box : std::nullopt};
    boost.apply(dt, std::span(&rider, 1), volumes, entry);
}

void pads() {
    PadBoost pad;
    pad.request(false, 5);
    pad.request(false, 3);
    pad.request(true, 10);
    near(pad.speed, 5, "shorter pad cannot shorten a live window");
    near(pad.trick, 10, "pad kinds keep separate durations");
    for (unsigned i = 0; i < 60; ++i)
        pad.tick(dt);
    near(pad.speed, 4, "speed duration decays once per fixed tick");
    near(pad.trick, 9, "trick duration decays at the same real-time rate");
    pad.request(false, 15);
    near(pad.speed, 15, "a longer request extends without stacking");
    for (unsigned i = 0; i < 1000; ++i)
        pad.tick(dt);
    near(pad.speed + pad.trick, 0, "expired pad timers clamp to zero");
}

void directional_laws() {
    BoostLaw law;
    law.rate = 4;
    law.target = 20;
    law.direction = {2, 0, 0};
    ScriptedBoost boost(law);
    BoostRider rider{0, {0, 4, 0}, {0, 4, 0}, {0, 3, 7}};
    apply(boost, rider);
    equal(rider.velocity, {20 * 4 * dt, 3, 7}, "first-order add-only push normalizes its world axis");
    for (unsigned i = 0; i < 600; ++i)
        apply(boost, rider);
    near(rider.velocity.x, 20, "directional speed converges to target while occupied");
    check(!boost.expired(), "zero active window lives for the whole contact");
    rider.velocity = {40, 3, 7};
    apply(boost, rider);
    equal(rider.velocity, {40, 3, 7}, "a boost never brakes an overspeed rider");
    apply(boost, rider, false);
    check(boost.expired(), "zero-window directional node retires after departure");
    law.seconds = 1;
    ScriptedBoost window(law);
    rider.velocity = {};
    apply(window, rider);
    rider.velocity = {1, 2, 3};
    for (unsigned i = 0; i < 20; ++i)
        apply(window, rider, false);
    equal(rider.velocity, {1, 2, 3}, "an armed window never pushes a departed rider");
    check(!window.expired(), "positive window stays armed between contacts");
    for (unsigned i = 0; i < 41; ++i)
        apply(window, rider, false);
    check(window.expired(), "unoccupied window eventually retires");
    law.mode = 0;
    ScriptedBoost cooldown(law);
    cooldown.activate();
    rider.velocity = {};
    for (unsigned i = 0; i < 30; ++i)
        apply(cooldown, rider);
    equal(rider.velocity, {}, "mode zero suppresses force during its cooldown");
    for (unsigned i = 0; i < 60; ++i)
        apply(cooldown, rider);
    check(rider.velocity.x > 15, "cooldown releases into a correctly latched direction");
    apply(cooldown, rider, false);
    check(!cooldown.expired(), "mode zero never self-retires");
    for (const auto mode : {2, 7}) {
        law.mode = mode;
        ScriptedBoost inert(law);
        rider.velocity = {};
        apply(inert, rider);
        equal(rider.velocity, {}, "unsupported mode is inert");
        check(inert.expired(), "mode two and above retire on first service");
    }
    law.mode = 1;
    law.seconds = 0;
    ScriptedBoost many(law);
    std::array<BoostRider, 2> riders{{{42, {}, {}, {1, 2, 3}}, {81, {}, {}, {30, 4, 5}}}};
    const std::array<std::optional<BoostVolume>, 2> volumes{box, box};
    many.apply(dt, riders, volumes);
    near(riders[0].velocity.x, 1 + 19 * 4 * dt, "all selected riders receive their own deficit");
    equal(riders[1].velocity, {30, 4, 5}, "one rider cannot alter a second rider's speed");
}

void elevators() {
    BoostLaw law;
    law.kind = 18;
    law.rate = 4;
    law.target = 25;
    law.direction = {0, 1, 0};
    law.height = 40;
    ScriptedBoost lift(law);
    BoostRider rider{0, {0, 3, 0}, {0, 3, 0}, {7, 0, 9}};
    apply(lift, rider);
    equal(rider.velocity, {0, 25 * 4 * dt, 0}, "elevator cancels horizontal motion after applying lift");
    check(!lift.expired(), "active lift stays alive");
    rider.position.y = 40;
    const auto old = rider.velocity;
    apply(lift, rider);
    equal(rider.velocity, old, "target altitude is not lifted again");
    check(lift.expired(), "lift retires when no rider remains below its target");
    law.tolerance = 1000;
    ScriptedBoost snap(law);
    rider.position.y = 3;
    rider.velocity = {7, 12, 9};
    apply(snap, rider);
    near(rider.position.y, 40, "large positive tolerance places rider at exact altitude");
    equal(rider.velocity, {0, 12, 0}, "snap preserves climb velocity and cancels horizontal motion");
    check(rider.snapped && snap.expired(), "placement marks interpolation discontinuity and ends lift");
    law.tolerance = 0;
    ScriptedBoost exact(law);
    rider.position.y = 39.99;
    rider.velocity = {};
    rider.snapped = false;
    apply(exact, rider);
    near(rider.position.y, 39.99, "zero tolerance never snaps even very near target");
    check(!rider.snapped && !exact.expired(), "zero tolerance remains an ordinary lift");
}

void lap_and_tube() {
    BoostLaw law;
    law.kind = 15;
    law.rate = 5;
    law.target = 25;
    law.direction = {0, 1, 0};
    unsigned calls = 0, left = 3;
    const LapEntry counter = [&](std::uint64_t) {
        ++calls;
        return left;
    };
    for (unsigned stage = 0; stage < 3; ++stage) {
        ScriptedBoost lift(law);
        BoostRider rider{0, {}, {stage == 1 ? -5. : 5., stage ? 20. : 4., 0}, {8, 0, 9}};
        apply(lift, rider, true, counter);
        check(rider.stage == stage, "lap volume classifies floor and local-axis sides");
        equal(rider.velocity, {0, 25 * 5 * dt, 0}, "first-party tube ride starts its authored vertical lag");
        const auto entries = calls;
        left = 0;
        rider.position = {-rider.position.x, 50, 0};
        apply(lift, rider, true, counter);
        check(calls == entries && rider.stage == stage && rider.velocity.y > 25 * 5 * dt,
              "lap count and stage are latched for this entry");
        left = 3;
    }
    ScriptedBoost final(law);
    left = 0;
    BoostRider rider{0, {}, {0, 4, 0}, {8, 2, 9}};
    apply(final, rider, true, counter);
    equal(rider.velocity, {8, 2, 9}, "zero remaining laps permits untouched ride-through");
    check(final.expired(), "final pass installs no persistent lift");
    law.kind = 24;
    law.mode = 1;
    law.stage_direction = {Vec3{2, 0, 0}, Vec3{0, 3, 0}, Vec3{0, 0, 4}};
    law.stage_speed = {27, 35, 35};
    law.rate = 2;
    for (unsigned stage = 0; stage < 3; ++stage) {
        ScriptedBoost tube(law);
        rider = {0, {}, {0, 4, 0}, {}, true, stage};
        apply(tube, rider);
        auto expected = law.stage_direction[stage];
        expected = normalized(expected) * law.stage_speed[stage] * 2 * dt;
        equal(rider.velocity, expected, "tube chooses its entry stage axis and speed");
        rider.stage = (stage + 1) % 3;
        rider.velocity = {};
        apply(tube, rider);
        equal(rider.velocity, expected, "tube cannot change stage launch midway through contact");
    }
    CoursePaths paths;
    CoursePath line;
    line.points = {{0, 0, 0}, {0, 0, 100}};
    line.distance_to_finish = 80;
    paths.race.push_back(line);
    RunSettings settings;
    settings.mode = RunMode::Race;
    settings.laps = 4;
    settings.countdown_seconds = 0;
    CourseRun run(paths, paths, settings);
    run.begin_tick(0, true);
    run.end_tick({0, 0, 70}, 1);
    for (unsigned i = 0; i < 4; ++i) {
        if (i)
            for (unsigned t = 0; t < 200; ++t)
                run.begin_tick(dt, true);
        check(run.enter_lap_volume(), "one tube entry counts one completed pass");
        check(run.status().remaining == 3 - i && run.status().phase == RunPhase::Running,
              "four passes yield three lift passes then a final ride-through");
        check(!run.enter_lap_volume(), "same passage cannot count twice");
        run.end_tick({0, 0, 90}, 1);
        if (i < 3) {
            check(run.status().phase == RunPhase::Running && run.status().remaining == 3 - i,
                  "nearby finish plane cannot double-count a tube passage");
            run.end_tick({0, 0, 70}, 1);
        }
    }
    check(run.status().phase == RunPhase::Finished, "finish plane ends the fourth ride-through");
    CourseRun plane(paths, paths, settings);
    plane.begin_tick(0, true);
    plane.end_tick({0, 0, 70}, 1);
    plane.end_tick({0, 0, 90}, 1);
    check(!plane.enter_lap_volume() && plane.status().remaining == 3,
          "plane before tube also shares the one lap count");
    paths.race[0].events = {{12, 4, 70, 70}};
    CourseRun tube_first(paths, paths, settings);
    tube_first.begin_tick(0, true);
    tube_first.end_tick({0, 0, 60}, 1);
    tube_first.enter_lap_volume();
    tube_first.end_tick({0, 0, 75}, 1);
    check(tube_first.status().remaining == 3, "path lap station cannot double-count the preceding tube entry");
    CourseRun path_first(paths, paths, settings);
    path_first.begin_tick(0, true);
    path_first.end_tick({0, 0, 60}, 1);
    path_first.end_tick({0, 0, 75}, 1);
    check(!path_first.enter_lap_volume() && path_first.status().remaining == 3,
          "tube cannot double-count a preceding path lap event");
}

Json fixture(const std::filesystem::path& root) {
    std::filesystem::create_directories(root / "Collision");
    Json points = Json::array();
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            points.push_back({u * 200000. / 3 - 100000, v * 200000. / 3 - 100000, 0});
    write(root, "Patches.json",
          {{"Patches", Json::array({{{"PatchName", "Boost test floor"},
                                     {"SurfaceType", 1},
                                     {"TrickOnlyPatch", false},
                                     {"Points", points},
                                     {"TexturePath", ""},
                                     {"LightmapID", -1},
                                     {"UVPoints", {{0, 0}, {0, 1}, {1, 0}, {1, 1}}},
                                     {"LightMapPoint", {0, 0, 0, 0}}}})}});
    Json models = Json::array();
    for (unsigned i = 0; i < 2; ++i)
        models.push_back(
            {{"ModelObjects",
              Json::array({{{"ParentID", -1},
                            {"CollisionBounds",
                             {{"Min", {-1000, i ? -100 : -1000, 0}}, {"Max", {1000, i ? 100 : 1000, 10000}}}},
                            {"MeshData", Json::array()}}})}});
    write(root, "Models.json", {{"Models", models}});
    std::ofstream(root / "Collision/cube.obj")
        << "v -1000 -1000 0\nv 1000 -1000 0\nv 1000 1000 0\nv -1000 1000 0\nv -1000 -1000 10000\nv 1000 -1000 10000\nv "
           "1000 1000 10000\nv -1000 1000 10000\nf 1 2 3 4\nf 5 8 7 6\nf 1 5 6 2\nf 2 6 7 3\nf 3 7 8 4\nf 4 8 5 1\n";
    std::ofstream(root / "Collision/plate.obj")
        << "v 0 -1000 0\nv 0 1000 0\nv 0 1000 10000\nv 0 -1000 10000\nf 1 2 3 4\n";
    Json rows = Json::array();
    for (unsigned i = 0; i < 5; ++i)
        rows.push_back({{"ModelID", i == 3 ? 1 : 0},
                        {"Location", {i * 3000, 0, 0}},
                        {"Rotation", {0, 0, i == 3 ? std::sin(pi / 8) : 0, i == 3 ? std::cos(pi / 8) : 1}},
                        {"Scale", {1, 1, 1}},
                        {"Visable", false},
                        {"PlayerCollision", true},
                        {"PlayerBounce", false},
                        {"U0", 0},
                        {"CollsionMode", i == 1 || i == 2 ? 1
                                         : i == 4         ? 3
                                                          : 2},
                        {"EffectSlotIndex", 0},
                        {"SurfaceType", -1}});
    rows[1]["CollsionModelPaths"] = {"cube.obj"};
    rows[2]["CollsionModelPaths"] = {"plate.obj"};
    rows[4]["PhysicsIndex"] = 0;
    write(root, "Instances.json", {{"Instances", rows}});
    write(root, "Physics.json",
          {{"PhysicsHeaders",
            Json::array({{{"PhysicsDatas",
                           Json::array({{{"UFloat0", 0},
                                         {"UFloat1", 0},
                                         {"UFloat2", 0},
                                         {"U2", 0},
                                         {"uPhysicsStruct0", Json::array({{{"U0", 200}, {"U1", 0}, {"U2", 1}}})},
                                         {"UByteData", "AA=="}}})}}})}});
    return rows;
}

void geometry(const std::filesystem::path& root) {
    fixture(root);
    auto world = CollisionWorld::load(root);
    check(world.volume(0, {0, 40, 0}, {0, 40, 0}).has_value(),
          "invisible contact-only box admits a stationary interior rider");
    check(!world.volume(0, {20, 40, 0}, {20, 40, 0}), "box rejects an outside rider");
    check(world.volume(1, {30, 40, 0}, {30, 40, 0}).has_value(),
          "closed triangle proxy admits stationary interior, not only surface crossings");
    check(!world.volume(1, {41, 40, 0}, {41, 40, 0}), "triangle interior test rejects outside proxy");
    check(world.volume(2, {59, 40, 0}, {61, 40, 0}).has_value(), "swept segment detects a thin authored trigger");
    check(!world.volume(2, {59, 40, 20}, {61, 40, 20}), "swept segment cannot substitute an infinite trigger plane");
    check(world.volume(3, {97, 40, -7}, {97, 40, -7}).has_value(), "rotated box keeps native transform");
    check(!world.volume(3, {97, 40, 7}, {97, 40, 7}), "rotated broadphase corner is not occupied");
    check(world.volume(4, {120, 0, 0}, {120, 0, 0}).has_value(), "occupancy solid admits its center");
    check(!world.volume(4, {122, 2, 0}, {122, 2, 0}), "occupancy box corner is not a solid sphere");
    std::array<std::uint8_t, 5> flags{1, 3, 3, 3, 3};
    world.instance_flags(flags);
    check(!world.volume(0, {0, 4, 0}, {0, 4, 0}),
          "runtime collision tombstone disables volume despite visible geometry");
}

void graph_pads(const std::filesystem::path& root) {
    fixture(root);
    auto doc = document(Json::array({node(17, {{"type17", 5}}), node(18, {{"type18", 10}}),
                                     node(0, {{"type0", {{"SubType", 5}, {"DeadNodeMode", 2}}}})}));
    write(root, "Effects.json", doc);
    auto logic = WorldLogic::load(root);
    logic.contact(0, 20);
    const auto actions = logic.take_actions();
    check(actions.size() == 4 && actions[0].kind == WorldActionKind::SpeedBoost && actions[0].value == 5 &&
              actions[1].value == 115 && actions[2].kind == WorldActionKind::TrickBoost && actions[2].value == 10 &&
              actions[3].value == 114,
          "owner receives independent duration requests with fixed human chimes");
    check(logic.flags()[0] == 0, "pad's authored dead node removes contact and draw");
    logic.restart(RunMode::Race, true);
    check(logic.flags()[0] == 0, "race retry reapplies collected pad tombstone");
    logic.restart(RunMode::Race);
    check(logic.flags()[0] & WorldCollide, "fresh course restores pads");
    logic.contact(0, 20, false);
    check(logic.take_actions().size() == 2, "nonhuman owner receives durations without human feedback");
    doc["functions"] = {
        {{"id", "setup"}, {"name", "FreerideMode"}, {"nodes", Json::array({node(17, {{"type17", 5}})})}}};
    write(root, "Effects.json", doc);
    logic = WorldLogic::load(root);
    check(logic.take_actions().empty(), "ownerless mode function cannot apply a pad to human by accident");
    write(root, "Effects.json", document(Json::array()));
    Player baseline(Terrain::load(root));
    baseline.warp({0, -.005, 0}, {1, 0, 0});
    baseline.tick({});
    write(root, "Effects.json", doc);
    Player player(Terrain::load(root));
    player.warp({0, -.005, 0}, {1, 0, 0});
    player.tick({});
    near(player.rider().pads.speed, 5, "body contact reaches pad in the actual player tick");
    near(player.rider().pads.trick, 10, "same player receives trick duration exactly once");
    equal(player.rider().velocity, baseline.rider().velocity,
          "pad collection adds no direct velocity impulse to stationary rider");
    player.tick({});
    near(player.rider().pads.speed, 5 - dt, "newly collected pad decays starting on following tick");
    player.restart_run();
    check(player.logic().flags()[0] == 0, "player race retry preserves source pad tombstone");
    player.configure_run(RunMode::Freeride);
    check(player.logic().flags()[0] & WorldCollide, "reentering course starts a fresh pad set");
}

void graph_forces(const std::filesystem::path& root) {
    fixture(root);
    auto doc = document(Json::array({directional(4, 20, {0, 0, 1})}));
    write(root, "Effects.json", doc);
    auto world = CollisionWorld::load(root);
    auto logic = WorldLogic::load(root);
    logic.contact(0, 0);
    BoostRider rider{0, {0, 4, 0}, {0, 4, 0}, {}};
    logic.apply_forces(dt, world, std::span(&rider, 1));
    equal(rider.velocity, {0, 20 * 4 * dt, 0}, "graph world-axis translation reaches force service");
    for (unsigned i = 0; i < 10; ++i) {
        logic.contact(0, 0);
        logic.apply_forces(dt, world, std::span(&rider, 1));
    }
    check(logic.forces() == 1, "continuous collision keeps one driver alive");
    rider.previous = rider.position = {20, 4, 0};
    logic.apply_forces(dt, world, std::span(&rider, 1));
    check(logic.forces() == 0, "source zero-window driver is destroyed after exit");
    doc = document(Json::array(
        {prop(18, {{"U0", 4}, {"U1", 25}, {"U2", 0}, {"U3", 0}, {"U4", 1}, {"U5", 4000}, {"U6", 100000}})}));
    write(root, "Effects.json", doc);
    logic = WorldLogic::load(root);
    rider = {0, {0, 4, 0}, {0, 4, 0}, {1, 12, 2}};
    logic.contact(0, 0);
    logic.apply_forces(dt, world, std::span(&rider, 1));
    near(rider.position.y, 40, "graph altitude and tolerance convert centimetres exactly once");
    rider.previous = rider.position = {0, 4, 0};
    rider.snapped = false;
    logic.contact(0, 0);
    logic.apply_forces(dt, world, std::span(&rider, 1));
    near(rider.position.y, 4, "falling inside completed elevator cannot trampoline repeatedly");
    rider.previous = rider.position = {20, 4, 0};
    logic.apply_forces(dt, world, std::span(&rider, 1));
    rider.previous = rider.position = {0, 4, 0};
    logic.contact(0, 0);
    logic.apply_forces(dt, world, std::span(&rider, 1));
    near(rider.position.y, 40, "leave and reentry rearm a completed lift");
    Player transported(Terrain::load(root));
    transported.warp({0, 4, 0}, {1, 0, 0});
    AudioScene audio(root);
    audio.tick(transported, transported.rider());
    auto music = std::make_shared<PcmClip>();
    music->samples.resize(48000, .1f);
    music->priority = 101;
    const auto voice = audio.mixer().play(music);
    const auto serial = transported.audio_reset_serial(), placement = transported.placement_serial();
    const auto before = transported.rider();
    transported.tick({});
    audio.tick(transported, before);
    check(transported.placement_serial() > placement && transported.audio_reset_serial() == serial,
          "lift resets spatial interpolation without requesting an audio restart");
    check(audio.mixer().status(voice).has_value(),
          "world lift preserves the existing music voice instead of clearing the mixer");
    write(root, "Effects.json", document(Json::array({directional(3, 100, {0, 0, 1})})));
    Player vent(Terrain::load(root));
    vent.warp({0, .01, 0}, {1, 0, 0});
    for (unsigned i = 0; i < 30; ++i)
        vent.tick({});
    check(!vent.rider().grounded && vent.rider().velocity.y > 40,
          "real vent leaves ground and exceeds ordinary air speed cap");
    check(vent.rider().pads.speed == 0 && vent.rider().pads.trick == 0,
          "scripted force cannot impersonate pad windows");
    Player walker(Terrain::load(root));
    walker.warp({0, .01, 0}, {1, 0, 0});
    walker.start_on_foot();
    for (unsigned i = 0; i < 5; ++i)
        walker.tick({});
    check(walker.on_foot() && !walker.rider().grounded && walker.rider().velocity.y > 10,
          "on-foot player shares authored lift and releases walking support");
    write(
        root, "Splines.json",
        {{"Splines",
          Json::array(
              {{{"U0", -123},
                {"U1", 1},
                {"SplineStyle", 13},
                {"Segments",
                 Json::array(
                     {{{"Points",
                        {{-500, 0, 100}, {-166.6666666667, 0, 100}, {166.6666666667, 0, 100}, {500, 0, 100}}}}})}}})}});
    Player rail(Terrain::load(root));
    rail.warp({0, 1, 0}, {1, 0, 0}, {10, 0, 0});
    rail.tick({});
    check(rail.rider().grinds == 1 && rail.rider().motion == Motion::Air && rail.rider().velocity.y > 4,
          "vertical force can detach rider from a captured rail");
    rail.tick({});
    check(rail.rider().motion == Motion::Air && rail.rider().grinds == 1,
          "lifted rider cannot immediately recapture the same rail");
    std::filesystem::remove(root / "Splines.json");
}

void compatibility(const std::filesystem::path& root) {
    fixture(root);
    Json fields;
    for (unsigned i = 0; i < 18; ++i)
        fields["U" + std::to_string(i)] = 0;
    fields["U0"] = 1;
    fields["U2"] = 2;
    fields["U13"] = 1;
    auto tube = prop(24, fields);
    std::vector<std::uint32_t> words(22);
    words[0] = 0;
    words[1] = 88;
    words[2] = 24;
    words[21] = std::bit_cast<std::uint32_t>(35.f);
    tube["extensions"] = {{"nativeWords", words}};
    write(root, "Effects.json", document(Json::array({tube})));
    auto logic = WorldLogic::load(root);
    auto world = CollisionWorld::load(root);
    BoostRider rider{0, {0, 4, 0}, {0, 4, 0}, {}, true, 2};
    logic.contact(0, 0);
    logic.apply_forces(dt, world, std::span(&rider, 1));
    equal(rider.velocity, {35 * 2 * dt, 0, 0},
          "older native payload recovers final tube speed from retained source words");
    check(!Json::parse(std::ifstream(root / "Effects.json"))["graphs"][0]["nodes"][0]["payload"]["type0"]["type0Sub24"]
               .contains("U18"),
          "compatibility repair leaves user's map untouched");
}

void player_air(const std::filesystem::path& root) {
    fixture(root);
    write(root, "Effects.json", document(Json::array()));
    Player board(Terrain::load(root));
    board.warp({0, 200, 0}, {1, 0, 0}, {-10, 0, 0});
    RideInput input;
    input.boost = true;
    board.tick(input);
    check(board.rider().boost_end == -1 && board.rider().velocity.x < -10,
          "symmetric deck chooses leading tail for boost at engage");
    check(board.world_actions().size() == 1 && board.world_actions()[0].value == 120,
          "held strong boost engages its one-shot once");
    board.tick(input);
    check(board.world_actions().empty() && board.rider().boost_end == -1,
          "held boost keeps its end and does not replay engage audio");
    input.boost = false;
    board.tick(input);
    input.boost = true;
    board.tick(input);
    check(board.world_actions().size() == 1, "release and press starts a fresh engage");
    PlayTuning skis;
    skis.symmetric_deck = false;
    Player nose(Terrain::load(root), skis);
    nose.warp({0, 200, 0}, {1, 0, 0}, {-10, 0, 0});
    nose.tick(input);
    check(nose.rider().boost_end == 1 && nose.rider().velocity.x > -10,
          "directional gear always boosts along visible nose");
}

void owned(const std::filesystem::path& maps, const std::filesystem::path& reference) {
    unsigned actors = 0, pads_count = 0;
    for (const auto& course : std::filesystem::directory_iterator(maps))
        if (std::filesystem::is_regular_file(course.path() / "Instances.json")) {
            const auto name = course.path().filename();
            const auto source = Json::parse(std::ifstream(reference / name / "SSFLogic.json"));
            const auto rows = Json::parse(std::ifstream(course.path() / "Instances.json"))["Instances"];
            const auto props = Props::load(course.path());
            auto world = CollisionWorld::load(course.path());
            auto logic = WorldLogic::load(course.path());
            for (std::size_t i = 0; i < rows.size(); ++i) {
                const auto slot = rows[i].value("EffectSlotIndex", -1);
                if (slot < 0 || std::size_t(slot) >= source["EffectSlots"].size())
                    continue;
                const auto chain = source["EffectSlots"][slot].value("CollisionEffectSlot", -1);
                if (chain < 0)
                    continue;
                for (const auto& node : source["EffectHeaders"][chain]["Effects"]) {
                    const auto main = node.at("MainType").get<int>();
                    if (main == 17 || main == 18) {
                        logic.restart(RunMode::Race);
                        logic.tick(0);
                        logic.contact(i, 20);
                        const auto actions = logic.take_actions();
                        check(
                            std::any_of(actions.begin(), actions.end(),
                                        [&](const auto& a) {
                                            return a.kind == (main == 17 ? WorldActionKind::SpeedBoost
                                                                         : WorldActionKind::TrickBoost) &&
                                                   a.value == node.at(main == 17 ? "type17" : "type18").get<double>();
                                        }),
                            ("owned pad dispatch retains authored duration: " + name.string() + "/" + std::to_string(i))
                                .c_str());
                        ++pads_count;
                    }
                    if (main != 0)
                        continue;
                    const auto sub = node.at("type0").at("SubType").get<int>();
                    if (sub != 7 && sub != 15 && sub != 18 && sub != 24)
                        continue;
                    const auto p = props.instances.at(i).bounds.center();
                    const auto volume = world.volume(i, p, p);
                    if (!volume)
                        throw std::runtime_error("Owned boost collision seed missing: " + name.string() + "/" +
                                                 std::to_string(i));
                    logic.restart(RunMode::Freeride);
                    logic.contact(i, 20);
                    check(logic.forces() == 1, "owned collision graph installs a force node");
                    BoostRider rider{0, p, p, {}};
                    logic.apply_forces(dt, world, std::span(&rider, 1));
                    if (sub == 7) {
                        const auto& f = node["type0"]["Boost"];
                        const auto& a = f["BoostDir"];
                        const auto axis = normalized(Vec3{a[0], a[2], -a[1].get<double>()});
                        equal(rider.velocity, axis * (f["BoostAmount"].get<double>() * f["U2"].get<double>() * dt),
                              "owned driver matches independent decoded world axis, rate and target");
                    } else if (sub == 24)
                        near(length(rider.velocity), 27 * 2 * dt,
                             "owned stage-zero tube uses its exact authored speed");
                    else if (sub == 18) {
                        const auto& f = node["type0"]["type0Sub18"];
                        const auto target = f["U5"].get<double>() / 100;
                        if (p.y < target) {
                            if (f["U6"].get<double>() > 0)
                                near(rider.position.y, target, "owned huge-tolerance shaft places at target altitude");
                            else
                                check(rider.velocity.y > 0, "owned ordinary air shaft climbs");
                        }
                    }
                    ++actors;
                }
            }
        }
    check(actors == 67 && pads_count > 0, "full owned corpus covers every placed driver and real pad");
    std::cout << "Owned boosts: " << actors << " drivers, " << pads_count << " pads across eleven courses\n";
}

void air_profile() {
    equal(air_boost_velocity({10, 0, 0}, {0, 1, 0}, 33.47, dt), {10, 8 * dt, 0},
          "held air thrust follows visible deck pitch");
    const auto bent = air_boost_velocity({33.47, 0, 0}, {0, 0, 1}, 33.47, dt);
    near(length(bent), 33.47, "at-cap directional bend preserves carried speed");
    near(std::atan2(bent.z, bent.x), 40 * pi / 180 * dt, "at-cap first-party bend uses bounded angular rate");
    equal(air_boost_velocity({33.47, 0, 0}, {1, 0, 0}, 33.47, dt), {33.47, 0, 0},
          "forward thrust cannot accelerate at the cap");
    near(air_boost_velocity({33.47, 0, 0}, {-1, 0, 0}, 33.47, dt).x, 33.47 - 8 * dt,
         "opposing deck force can brake an at-cap flight");
}
} // namespace

int main(int argc, char** argv) {
    try {
        pads();
        directional_laws();
        elevators();
        lap_and_tube();
        air_profile();
        const auto root =
            std::filesystem::temp_directory_path() /
            ("openslope-boost-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::create_directories(root);

        struct Cleanup {
            std::filesystem::path root;

            ~Cleanup() {
                std::error_code ec;
                std::filesystem::remove_all(root, ec);
            }
        } cleanup{root};

        geometry(root);
        graph_pads(root);
        graph_forces(root);
        compatibility(root);
        player_air(root);
        if (argc >= 3)
            owned(argv[1], argv[2]);
        std::cout << "PASS: " << checks
                  << " boost duration, volume, lifetime, tube/lap, graph, air and player checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
