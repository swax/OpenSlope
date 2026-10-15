#include "openslope/player.hpp"
#include "openslope/rigid_prop.hpp"
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace {
using namespace openslope;
unsigned checks = 0;

void check(bool condition, const char* reason) {
    ++checks;
    if (!condition)
        throw std::runtime_error(reason);
}

void near(double a, double b, const char* reason) { check(std::abs(a - b) < 1e-6, reason); }

PropBodyShape sphere() {
    PropBodyShape shape;
    shape.centre = {0, .6, 0};
    shape.probes = {{{0, .6, 0}, .6}};
    shape.inverse_inertia = {1.4, 0, 0, 0, 1.4, 0, 0, 0, 1.4};
    return shape;
}

PropBodyQuery ground(const Terrain& terrain) {
    return [&](std::span<const ProbeSphere> from, std::span<const ProbeSphere> to) {
        std::vector<PropBodyContact> result;
        for (const auto& hit : terrain.body_contacts(from, to))
            result.push_back({{hit.point, hit.normal, hit.t, hit.depth}, {}});
        return result;
    };
}

void laws(const Terrain& terrain) {
    RigidProp a(sphere(), 5, {}), b(sphere(), 10, {}), explicit_a(sphere(), 5, {1, 0, 0}),
        explicit_b(sphere(), 10, {1, 0, 0});
    near(a.velocity().y, 2 * b.velocity().y, "zero-vector launch speed scales inversely with payload mass");
    near(explicit_a.velocity().x, explicit_b.velocity().x, "authored launch speed is independent of payload mass");
    RigidProp light(sphere(), .001, {});
    check(length(light.velocity()) <= 300, "very light authored bodies respect the same launch speed bound as impacts");
    auto hit = WorldContact{};
    hit.point = a.centre() + Vec3{0, .4, 0};
    hit.normal = {-1, 0, 0};
    hit.response = true;
    hit.bounce = 99;
    hit.mass = 1e30;
    const auto before = a.velocity(), rider = Vec3{12, 0, 0};
    const auto response = a.shove(hit, rider, {0, 1, 0});
    check(a.velocity().x > 0 && response.velocity.x < 12, "a rider transfers momentum into an active prop");
    near(5 * a.velocity().x + 75 * response.velocity.x, 75 * 12,
         "normal impulse conserves rider-plus-body linear momentum");
    near(a.velocity().y, before.y, "the normal shove adds no fixed upward kick");
    check(length(a.angular_velocity()) > .1, "off-centre impact creates angular velocity through inverse inertia");
    RigidProp c(sphere(), 5, {});
    hit.mass = 0;
    hit.bounce = 0;
    const auto control = c.shove(hit, rider, {0, 1, 0});
    near(control.velocity.x, response.velocity.x,
         "live-body shove ignores authored response mass and bounce magnitude");
    auto shape = sphere();
    shape.centre = {.2, .6, 0};
    shape.placement = placement({2, 1, 3}, {0, std::sin(.3), 0, std::cos(.3)}, {1, 1, 1});
    RigidProp pivot(shape, 5, {});
    hit.point = pivot.centre() + Vec3{0, .5, 0};
    pivot.shove(hit, rider, {0, 1, 0});
    const auto no_world = [](auto, auto) -> std::vector<PropBodyContact> { return {}; };
    pivot.step(1. / 60, no_world);
    const auto posed = transform_point(pivot.pose(), shape.centre);
    near(length(posed - pivot.centre()), 0, "model transform rotates around the decoded mass centre");
    for (unsigned i = 0; i < 900 && !a.sleeping(); ++i)
        a.step(1. / 60, ground(terrain));
    check(a.sleeping(), "the thrown body collides with terrain and settles to sleep");
    check(a.centre().y >= .599 && a.centre().y < .62, "leaf shape remains above the actual ground after settling");
    const auto resting = a.pose();
    for (unsigned i = 0; i < 60; ++i)
        a.step(1. / 60, ground(terrain));
    check(a.pose() == resting, "sleeping body keeps its moved pose without jitter or respawn");
    hit.point = a.centre();
    hit.normal = {-1, 0, 0};
    a.shove(hit, {5, 0, 0}, {0, 1, 0});
    check(!a.sleeping() && a.velocity().x > 0, "a second rider impact wakes the settled body");
    const auto separating = a.shove(hit, {-5, 0, 0}, {0, 1, 0});
    near(separating.impulse, 0, "separating contacts do not apply an attractive impulse");
    auto compound = sphere();
    compound.centre = {0, .3, 0};
    compound.probes.clear();
    for (int x = -4; x <= 4; ++x)
        for (int z = -4; z <= 4; ++z)
            compound.probes.push_back({{x * .15, .3, z * .15}, .3});
    RigidProp broad(compound, 5, {});
    hit.point = broad.centre() + Vec3{0, .2, 0};
    hit.normal = {-1, 0, 0};
    broad.shove(hit, {12, 0, 0}, {0, 1, 0});
    for (unsigned i = 0; i < 120; ++i)
        broad.step(1. / 60, ground(terrain));
    check(broad.centre().x > .3, "simultaneous native leaf contacts do not freeze a wide compound body at t=0");
}

void integration(const std::filesystem::path& root) {
    auto world = CollisionWorld::load(root);
    auto logic = WorldLogic::load(root);
    const auto terrain = Terrain::load(root);
    const auto shape = world.body_shape(0);
    check(shape && shape->probes.size() == 1, "native occupancy payload supplies actual leaf geometry");
    near(shape->centre.y, .6, "decoded mass centre changes from centimetres/Z-up to metres/Y-up");
    near(shape->inverse_inertia[0], 750. / 540,
         "stored inverse inertia receives the recovered coefficient and SI conversion");
    nlohmann::json models;
    std::ifstream(root / "Models.json") >> models;
    auto shifted = models;
    shifted["Models"][0]["ModelObjects"][0]["Position"] = {0, 0, 100};
    std::ofstream(root / "Models.json") << shifted;
    const auto offset = CollisionWorld::load(root).body_shape(0);
    near(offset->centre.y, .6, "model-space mass centre is not shifted again by a mesh object's rest matrix");
    near(offset->probes[0].centre.y, 1.6, "collision leaf still follows the collision-bearing object's rest matrix");
    std::ofstream(root / "Models.json") << models;
    logic.contact(0, 12);
    logic.prepare_bodies(world);
    world.instance_flags(logic.flags());
    check(logic.bodies() == 1 && logic.unsupported() == 0, "authored collision graph installs a live Roller body");
    const std::array<Vec3, 1> observer{{{0, 1, 0}}};
    WorldContact hit;
    hit.instance = 0;
    hit.point = {0, .8, 0};
    hit.normal = {-1, 0, 0};
    hit.response = true;
    check(logic.shove(hit, {12, 0, 0}, {0, 1, 0}).has_value(), "activated body admits the rider impulse");
    for (unsigned i = 0; i < 600; ++i) {
        logic.tick(1. / 60, 0, observer);
        logic.step_bodies(1. / 60, terrain, world);
        world.motion(logic.motions(), 1. / 60);
    }
    check(logic.motions().size() == 1 && logic.motions()[0].instance == 0, "unhit shared-model sibling remains static");
    check(std::abs(logic.motions()[0].current[0][12]) > .3, "live transform moves the struck instance");
    check(logic.sleeping_bodies() == 1, "graph-owned rigid body remains installed in its settled pose");
    const auto local = logic.motions()[0].current[0];
    const auto centre = transform_point(local, {0, .6, 0});
    const auto moved = world.ray(centre + Vec3{-2, 0, 0}, centre + Vec3{2, 0, 0});
    check(moved && moved->instance == 0,
          "native collision proxy moves to the same settled location as the render pose");
    const auto original = world.ray({-1, .6, 0}, {1, .6, 0});
    check(!original || original->instance != 0, "the original collider location is cleared");
    logic.restart(RunMode::Freeride);
    world.instance_flags(logic.flags());
    world.motion(logic.motions(), 1. / 60);
    check(logic.bodies() == 0 && logic.motions().empty() && world.ray({-1, .6, 0}, {1, .6, 0}).has_value(),
          "run restart restores authored render and collision presence");
    for (const auto foot : {false, true}) {
        Player player(Terrain::load(root));
        player.warp({-3, -.005, 0}, {1, 0, 0}, {12, 0, 0});
        if (foot)
            player.start_on_foot();
        RideInput input;
        input.walk_forward = {1, 0, 0};
        input.posture = foot ? 1 : 0;
        for (unsigned i = 0; i < 45; ++i)
            player.tick(input);
        check(player.logic().bodies() == 1 && player.logic().motions().size() == 1,
              "real mounted/on-foot player activates exactly the struck bag");
        check(std::abs(player.logic().motions()[0].current[0][12]) > .05,
              "real player contact knocks the native prop away");
    }
}

void scripted(const std::filesystem::path& root) {
    using Json = nlohmann::json;
    Json instances, effects;
    std::ifstream(root / "Instances.json") >> instances;
    std::ifstream(root / "Effects.json") >> effects;
    auto massless = instances;
    massless["Instances"][0]["U0"] = 0;
    massless["Instances"][0]["PlayerBounce"] = false;
    std::ofstream(root / "Instances.json") << massless;
    Player rider(Terrain::load(root));
    rider.warp({-3, -.005, 0}, {1, 0, 0}, {12, 0, 0});
    for (unsigned i = 0; i < 45; ++i)
        rider.tick({});
    check(rider.logic().bodies() == 1 && (rider.logic().flags()[0] & WorldDynamic),
          "Roller activation admits the live path even when original response mass and bounce are disabled");
    check(std::abs(rider.logic().motions()[0].current[0][12]) > .3,
          "original contact-only host becomes a movable collider");
    auto target = instances;
    target["Instances"][1]["Visable"] = false;
    std::ofstream(root / "Instances.json") << target;
    auto pop = effects["graphs"][0]["nodes"][0];
    pop["payload"]["type0"]["type0Sub0"]["U0"] = .5;
    effects["graphs"][0]["nodes"] =
        Json::array({{{"mainType", 7},
                      {"payload", Json::object()},
                      {"references", {{"instance", "instance:1"}, {"effectGraph", "pop"}}}}});
    effects["graphs"].push_back({{"id", "pop"}, {"nodes", Json::array({pop})}});
    std::ofstream(root / "Effects.json") << effects;
    auto world = CollisionWorld::load(root);
    auto logic = WorldLogic::load(root);
    const auto terrain = Terrain::load(root);
    logic.contact(0, 12);
    logic.prepare_bodies(world);
    world.instance_flags(logic.flags());
    check(logic.bodies() == 1 && logic.motions()[0].instance == 1,
          "targeted script pops the lid without turning its base into a body");
    check(logic.flags()[1] == (WorldDraw | WorldCollide | WorldDynamic),
          "scripted hidden target is revealed and collidable");
    for (unsigned i = 0; i < 5; ++i) {
        logic.tick(1. / 60);
        logic.step_bodies(1. / 60, terrain, world);
        world.motion(logic.motions(), 1. / 60);
    }
    check(logic.motions()[0].current[0][13] > .5, "authored lightweight lid launches along its own transform");
}

void owned(const std::filesystem::path& maps) {
    auto world = CollisionWorld::load(maps / "GARI");
    const auto shape = world.body_shape(149);
    check(shape && shape->probes.size() > 1, "actual GARI crash bag keeps native compound shape");
    const auto original = transform_point(shape->placement, shape->centre);
    for (const auto foot : {false, true}) {
        Player player(Terrain::load(maps / "GARI"));
        player.warp({-1.173812, .301736, 51.077597}, {1, 0, 0}, {14, 0, 0});
        if (foot)
            player.start_on_foot();
        RideInput input;
        input.walk_forward = {1, 0, 0};
        input.posture = foot ? 1 : 0;
        for (unsigned i = 0; i < 65; ++i)
            player.tick(input);
        const auto motions = player.logic().motions();
        const auto motion =
            std::find_if(motions.begin(), motions.end(), [](const auto& p) { return p.instance == 149; });
        check(motion != motions.end(), "actual riding/walking contact creates the GARI bag's live motion binding");
        const auto centre = transform_point(multiply(shape->placement, motion->current[0]), shape->centre);
        check(length(project(centre - original, {0, 1, 0})) > .5,
              "actual rider knocks native bag horizontally away from its source");
        std::cout << "Owned GARI " << (foot ? "walk" : "ride") << ": " << shape->probes.size()
                  << " leaves; centre moved " << length(centre - original) << " m\n";
    }
}
} // namespace

int main(int argc, char** argv) {
    try {
        if (argc < 2)
            throw std::runtime_error("Supply authored native body fixture");
        const auto terrain = Terrain::load(argv[1]);
        laws(terrain);
        integration(argv[1]);
        scripted(argv[1]);
        if (argc > 2)
            owned(argv[2]);
        std::cout << "PASS: " << checks << " live body impulse, mass-centre, shape, sleep, rider and restart checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
