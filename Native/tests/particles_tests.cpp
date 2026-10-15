#include "openslope/particles.hpp"
#include "openslope/world_logic.hpp"
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

void check(bool value, const char* what) {
    ++checks;
    if (!value)
        throw std::runtime_error(what);
}

void close(Vec3 a, Vec3 b, const char* what) { check(length(a - b) < 1e-6, what); }

void write(const std::filesystem::path& root, const char* name, const Json& doc) { std::ofstream(root / name) << doc; }

std::array<double, 51> fields() {
    std::array<double, 51> f{};
    f[0] = 20;
    f[2] = .4;
    f[3] = 1;
    f[4] = 20;
    f[5] = .5;
    for (unsigned i = 0; i < 4; ++i) {
        f[33 + i * 4] = .6;
        f[34 + i * 4] = .9;
        f[35 + i * 4] = .3;
        f[36 + i * 4] = .1;
    }
    return f;
}

Json node(int main, Json payload, Json refs = Json::object()) {
    return {{"mainType", main}, {"payload", payload}, {"references", refs}};
}

Json emitter(const std::array<double, 51>& f, bool collision = false) {
    Json values = Json::object();
    for (unsigned i = 0; i < 51; ++i)
        values["U" + std::to_string(i)] =
            collision && i >= 2 && i <= 48 ? Json(std::bit_cast<std::int32_t>(float(f[i]))) : Json(f[i]);
    return node(2, {{"type2", {{"SubType", collision ? 2 : 0}, {collision ? "type2Sub2" : "type2Sub0", values}}}});
}

void laws() {
    auto f = fields();
    f[9] = 125.5;
    f[10] = -20;
    f[11] = 35;
    f[20] = 300;
    f[32] = -980;
    auto law = ParticleLaw::decode(f);
    close(law.origin, {1.255, .35, .2}, "fractional local origin and handedness");
    close(law.velocity, {0, 3, 0}, "authored vertical launch in metres");
    close(law.gravity, {0, -9.8, 0}, "authored gravity in metres");
    check(std::abs(law.colours[0][0] - .9) < 1e-6 && std::abs(law.colours[0][3] - .6) < 1e-6, "ARGB becomes RGBA");
    law.gravity = {0, 2, 0};
    close(particle_offset(law, {4, 0, 0}, .5), {1.347, .3265, 0}, "shared polynomial position curve");
    close(particle_offset(law, {4, 0, 0}, 5), {4.58892, 7.70554, 0}, "curve clamps while gravity keeps advancing");
    for (int blend : {0, 1, 2, 3, 4, 5, 7, 9}) {
        f[50] = blend;
        check(ParticleLaw::decode(f).blend == (blend == 1   ? ParticleBlend::Alpha
                                               : blend == 4 ? ParticleBlend::Darken
                                                            : ParticleBlend::Additive),
              "authored blend remap");
    }
    f = fields();
    law = ParticleLaw::decode(f);
    WorldParticles particles;
    particles.spawn(3, law, identity_transform());
    check(particles.draw(1, {}).size() == 1, "first spark begins at time zero");
    particles.step(.21);
    const auto burst = particles.draw(1, {});
    check(burst.size() == 11, "positive window spreads the authored count");
    check(particles.draw(0, {}).size() == 1, "draw interpolates emitter time");
    const auto repeat = particles.draw(1, {});
    check(repeat.size() == burst.size(), "two eye draws do not advance emission");
    for (std::size_t i = 0; i < burst.size(); ++i)
        close(burst[i].position, repeat[i].position, "stable draw reconstruction");
    particles.step(1);
    check(particles.emitters() == 0 && particles.draw(1, {}).empty(), "one-shot completes instead of looping");
    law.window = -.4;
    particles.spawn(3, law, identity_transform());
    for (unsigned i = 0; i < 5; ++i)
        particles.step(1);
    check(particles.emitters() == 1 && particles.draw(1, {}).size() >= 24, "negative window remains a stream");
    particles.kill(7);
    check(particles.emitters() == 1, "stopping another owner has no effect");
    particles.kill(3);
    check(particles.emitters() == 0, "stop kills the addressed detached emitters");
    law.window = 0;
    law.count = 8192;
    law.trails = 32;
    law.trail_step = 0;
    particles.spawn(3, law, identity_transform());
    check(particles.draw(1, {}).size() == WorldParticles::maximum_sprites, "world sprite budget is bounded");
    particles.reset();
    check(particles.emitters() == 0, "restart clears effects");
    law = ParticleLaw::decode(fields());
    law.origin = {1, 0, 0};
    law.trails = 2;
    law.trail_step = .02;
    const auto matrix = placement({10, 20, 30}, {0, std::sin(pi / 4), 0, std::cos(pi / 4)}, {2, 2, 2});
    particles.spawn(1, law, matrix);
    close(particles.draw(1, {10, 20, 30})[0].position, transform_point(matrix, {1, 0, 0}),
          "point uses instance translation/rotation/scale");
    check(std::abs(particles.draw(1, {})[0].radius - .4) < 1e-6, "billboard size follows instance scale");
    particles.step(.21);
    check(particles.draw(1, {}).size() > 20, "authored trailing copies actually appear");
    double reference = 0;
    for (double hz : {30., 60., 120., 240.}) {
        particles.reset();
        law = ParticleLaw::decode(fields());
        law.window = 0;
        law.velocity = {4, 2, 1};
        law.life = 2;
        particles.spawn(1, law, identity_transform());
        for (unsigned i = 0; i < unsigned(hz); ++i)
            particles.step(1 / hz);
        const auto x = particles.draw(1, {})[0].position.x;
        if (reference)
            check(std::abs(x - reference) < 1e-6, "particle trajectories are frame-rate independent");
        reference = x;
    }
    f = fields();
    f[0] = 9000;
    bool rejected = false;
    try {
        ParticleLaw::decode(f);
    } catch (const std::runtime_error&) {
        rejected = true;
    }
    check(rejected, "oversized authored particle counts rejected");
    const auto names = particle_sprite_names();
    check(names.size() == 38 && names[0] == "part" && names[2] == "clod" && names[19] == "str2" && names[23] == "tral",
          "registration matches clean named indices");
    check(names[30] == names[31] && names[32] == "mip2", "duplicate registration is retained");
    particles.reset();
    law = ParticleLaw::decode(fields());
    law.count = 1;
    law.window = 0;
    law.life = 3;
    law.colours = {{{1, 0, 0, 1}, {0, 1, 0, .75f}, {0, 0, 1, .5f}, {0, 0, 0, 0}}};
    particles.spawn(0, law, identity_transform());
    particles.step(1);
    const auto colour = particles.draw(1, {})[0].colour;
    check(std::abs(colour[0]) < 1e-6 && std::abs(colour[1] - 1) < 1e-6 && std::abs(colour[3] - .75) < 1e-6,
          "colour ramp reaches the second RGBA stop");
    particles.step(.5);
    const auto middle_colour = particles.draw(1, {})[0].colour;
    check(std::abs(middle_colour[1] - .5) < 1e-6 && std::abs(middle_colour[2] - .5) < 1e-6 &&
              std::abs(middle_colour[3] - .625) < 1e-6,
          "colour and opacity interpolate together across all four stops");
}

void graphs(const std::filesystem::path& root) {
    auto f = fields();
    f[9] = 125.5;
    f[20] = 300;
    Json doc = {
        {"kind", "openslope-effects"},
        {"version", 1},
        {"graphs",
         Json::array({{{"id", "contact"},
                       {"nodes", Json::array({node(4, {{"WaitTime", .1}}),
                                              node(21, {{"FunctionRunIndex", 0}}, {{"function", "relay"}})})}},
                      {{"id", "burst"}, {"nodes", Json::array({emitter(f), node(8, {{"SoundPlay", 42}})})}}})},
        {"functions",
         Json::array({{{"id", "relay"},
                       {"nodes", Json::array({node(7, {{"Instance", {{"InstanceIndex", 1}, {"EffectIndex", 1}}}},
                                                   {{"instance", "target"}, {"effectGraph", "burst"}})})}}})},
        {"slots", Json::array({{{"id", "slot"}, {"originalIndex", 0}, {"circumstances", {{"collision", "contact"}}}}})},
        {"instances", Json::array({{{"id", "source"}, {"originalIndex", 0}, {"property", "source-property"}},
                                   {{"id", "target"}, {"originalIndex", 1}}})},
        {"objectProperties", Json::array({{{"id", "source-property"}, {"references", {{"effectSlot", "slot"}}}}})},
        {"splines", Json::array()}};
    write(root, "Effects.json", doc);
    Json instances = Json::array();
    for (unsigned i = 0; i < 2; ++i)
        instances.push_back({{"ModelID", -1},
                             {"EffectSlotIndex", i == 0 ? 0 : -1},
                             {"Location", {i == 0 ? 0 : 1000, 0, 0}},
                             {"Rotation", {0, 0, 0, 1}},
                             {"Scale", {1, 1, 1}},
                             {"Visable", true},
                             {"PlayerCollision", true}});
    write(root, "Instances.json", {{"Instances", instances}});
    auto logic = WorldLogic::load(root);
    logic.contact(0, 4, true, 1, {0, 0, -4}, ParticleContact{{2, 3, 4}, {1, 0, 0}});
    check(logic.emitters() == 0, "graph wait delays the burst");
    logic.tick(.11);
    auto sprites = logic.particles(1, {});
    check(logic.emitters() == 1 && !sprites.empty(), "function and instance hops install the emitter");
    close(sprites[0].position, {11.255, 0, 0}, "timer origin belongs to the called target");
    const auto actions = logic.take_actions();
    check(actions.size() == 1 && actions[0].kind == WorldActionKind::CourseSound && actions[0].value == 42,
          "sound remains alongside particles");
    close(actions[0].position, {10, 0, 0}, "sound belongs to the called target");
    check(logic.unsupported() == 0, "timer node is supported");
    logic.restart(RunMode::Race);
    check(logic.emitters() == 0, "run restart clears detached bursts");
    doc["graphs"][1]["nodes"][0] = emitter(f, true);
    write(root, "Effects.json", doc);
    logic = WorldLogic::load(root);
    logic.contact(0, 4, true, 1, {0, 0, -4}, ParticleContact{{2, 3, 4}, {1, 0, 0}});
    // A later contact must not replace the already scheduled thread's point and normal.
    logic.contact(0, 4, true, 1, {0, 0, -4}, ParticleContact{{20, 30, 40}, {0, 0, 1}});
    logic.tick(.11);
    sprites = logic.particles(1, {});
    close(sprites[0].position, {2, 3, 4}, "collision uses latched live contact instead of stored origin");
    logic.tick(.05);
    sprites = logic.particles(1, {});
    check(sprites[0].position.x > 2 && std::abs(sprites[0].position.y - 3) < 1e-6 &&
              std::abs(sprites[0].position.z - 4) < 1e-6,
          "collision redirects the authored speed along the contact normal");
    check(logic.unsupported() == 0, "raw f32 collision fields are supported");
    doc["graphs"][1]["nodes"] = Json::array(
        {emitter(f), node(4, {{"WaitTime", .1}}), node(0, {{"type0", {{"SubType", 5}, {"DeadNodeMode", 3}}}})});
    write(root, "Effects.json", doc);
    logic = WorldLogic::load(root);
    logic.contact(0, 4);
    logic.tick(.11);
    logic.tick(.2);
    check(logic.emitters() == 0, "lifetime mode 3 kills detached layers");
    doc["slots"][0]["circumstances"] = {{"persistent", "burst"}};
    f[2] = -1;
    doc["graphs"][1]["nodes"] = Json::array({emitter(f)});
    write(root, "Effects.json", doc);
    logic = WorldLogic::load(root);
    const std::array<Vec3, 1> nearby{{{0, 0, 0}}}, far{{{10000, 0, 0}}};
    logic.tick(.1, 0, nearby);
    check(logic.emitters() == 1, "region activates a persistent stream");
    logic.tick(.1, 0, far);
    logic.tick(.1, 0, far);
    check(logic.emitters() == 0, "region exit disposes an unlatched stream");
    logic.tick(.1, 0, nearby);
    check(logic.emitters() == 1, "region reentry constructs a fresh stream");
    doc["graphs"].push_back({{"id", "leave"}, {"nodes", Json::array()}});
    doc["slots"][0]["circumstances"]["slot3"] = "leave";
    write(root, "Effects.json", doc);
    logic = WorldLogic::load(root);
    logic.tick(.1, 0, nearby);
    logic.tick(.1, 0, far);
    logic.tick(.1, 0, far);
    check(logic.emitters() == 1, "region exit latch preserves its live emitter");
    logic.tick(.1, 0, nearby);
    check(logic.emitters() == 1, "latched stream does not duplicate on reentry");
    std::filesystem::create_directories(root / "Textures/Particles");
    std::ofstream(root / "Textures/Particles/part.png").put('x');
    check(particle_textures(root)[0] == "Particles/part.png",
          "shared authored particle folder works without ISO metadata");
    check(particle_textures(root, true)[19] == "Particles/str2.png" && particle_textures(root)[19].empty(),
          "external-folder planning includes optional named art before images are cached");
    write(root, "RidingEffects.json",
          {{"Schema", "openslope-riding-effects/v1"}, {"SpriteBank", {{"part", "spark.png"}, {"mip1", "tile.png"}}}});
    const auto named = particle_textures(root);
    check(named[0] == "spark.png" && named[30] == "tile.png" && named[31] == "tile.png",
          "older named banks use the full registration contract");
    write(root, "RidingEffects.json",
          {{"Schema", "openslope-riding-effects/v1"}, {"EmitterSprites", {"../private.png"}}});
    bool rejected = false;
    try {
        particle_textures(root);
    } catch (const std::runtime_error&) {
        rejected = true;
    }
    check(rejected, "sprite paths cannot escape the map");
}
} // namespace

int main(int argc, char** argv) {
    const auto root =
        std::filesystem::temp_directory_path() /
        ("openslope-particles-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    try {
        std::filesystem::create_directories(root);
        laws();
        graphs(root);
        if (argc == 4 && std::string_view(argv[2]) == "--trigger") {
            const auto instance = std::stoul(argv[3]);
            const auto placements = prop_placements(argv[1]);
            check(instance < placements.size(), "owned trigger exists");
            const auto& m = placements[instance];
            const Vec3 eye{m[12], m[13], m[14]};
            const std::array<Vec3, 1> observers{{eye}};
            auto logic = WorldLogic::load(argv[1]);
            logic.tick(1. / 60, 14, observers);
            logic.take_actions();
            logic.contact(instance, 14);
            std::size_t maximum = 0, sounds = 0;
            for (unsigned frame = 0; frame < 600; ++frame) {
                logic.tick(1. / 60, 14, observers);
                maximum = std::max(maximum, logic.particles(1, eye).size());
                for (const auto& a : logic.take_actions())
                    sounds += a.kind == WorldActionKind::CourseSound;
            }
            check(maximum > 100 && sounds > 0, "owned trigger has both visible sparks and report sound");
            std::cout << "Owned trigger " << instance << ": maximum " << maximum << " sprites; " << sounds
                      << " course sound events; eye [" << eye.x << ',' << eye.y << ',' << eye.z << "]\n";
            const auto world = CollisionWorld::load(argv[1]);
            if (const auto volume = world.volume(instance, eye + Vec3{0, 30, 0}, eye - Vec3{0, 30, 0}))
                std::cout << "Trigger bounds [" << volume->box.min.x << ',' << volume->box.min.y << ','
                          << volume->box.min.z << "] [" << volume->box.max.x << ',' << volume->box.max.y << ','
                          << volume->box.max.z << "]\n";
        }
        if (argc == 2)
            for (const auto& course : std::filesystem::directory_iterator(argv[1])) {
                if (!course.is_directory())
                    continue;
                auto logic = WorldLogic::load(course.path());
                check(logic.chains() > 0, "owned course emitter blocks load");
                std::cout << "Loaded " << course.path().filename().string() << " particle graphs\n";
            }
        std::filesystem::remove_all(root);
        std::cout << "PASS: " << checks << " particle curve, scheduling, registry, collision and lifecycle checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        std::filesystem::remove_all(root);
        return 1;
    }
}
