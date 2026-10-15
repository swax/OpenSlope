#include "openslope/player.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace {
using namespace openslope;
using Json = nlohmann::json;
unsigned checks = 0;

void require(bool value, const char* message) {
    ++checks;
    if (!value)
        throw std::runtime_error(message);
}

void near(double a, double b, double epsilon, const char* message) { require(std::abs(a - b) <= epsilon, message); }

template <class F> void rejects(F operation, const char* message) {
    bool bad = false;
    try {
        operation();
    } catch (const std::exception&) {
        bad = true;
    }
    require(bad, message);
}

Vec3 raw(Vec3 p) { return {p.x * 100, -p.z * 100, p.y * 100}; }

Json vector(Vec3 p) {
    const auto q = raw(p);
    return {q.x, q.y, q.z};
}

void write(const std::filesystem::path& file, const Json& doc) { std::ofstream(file) << doc; }

Json curve(Vec3 start, Vec3 end) {
    const auto d = end - start;
    return {{"Points", Json::array({vector(start), vector(start + d / 3), vector(start + d * 2 / 3), vector(end)})}};
}

void map(const std::filesystem::path& root, const Json& segments, int surface = 13, int candidacy = 1) {
    Json points = Json::array();
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            points.push_back({-100000 + 200000. * u / 3, -100000 + 200000. * v / 3, 0});
    write(root / "Patches.json", {{"Patches", Json::array({{{"PatchName", "Authored rail floor"},
                                                            {"Points", points},
                                                            {"SurfaceType", 5},
                                                            {"TrickOnlyPatch", false},
                                                            {"UVPoints", {{0, 0}, {1, 0}, {0, 1}, {1, 1}}},
                                                            {"TexturePath", ""},
                                                            {"LightmapID", -1},
                                                            {"LightMapPoint", {0, 0, 0, 0}}}})}});
    write(root / "Splines.json",
          {{"Splines",
            Json::array({{{"U0", -123}, {"U1", candidacy}, {"SplineStyle", surface}, {"Segments", segments}}})}});
}

void queries() {
    RailCurve curved{{Vec3{4, 0, 0}, Vec3{0, 3, 0}, Vec3{0, 0, -10}, Vec3{0, 2, 0}}};
    const auto t = .43;
    const auto position = curved.point(t);
    Rails rails({{13, true, {curved}}});
    const auto hit = rails.nearest(position);
    require(hit.has_value(), "Analytic cubic query finds the curved rail");
    near(hit->parameter, t, .0005, "Five-chord bracket and true-curve refinement recover parameter");
    near(length(hit->point - position), 0, .005, "Closest point is on the cubic rather than the bracket chord");
    near(dot(hit->tangent, normalized(curved.tangent(hit->parameter))), 1, 1e-12,
         "Travel uses exact derivative tangent");
    near(dot(hit->up, hit->tangent), 0, 1e-12, "Rail frame is orthogonal on a slope");
    auto window = *hit;
    window.offset = {0, .7, 0};
    require(rails.accepts(window, false, 1) && !rails.accepts(window, true, 1),
            "Entry window is ten percent stricter than attachment");
    window.offset = {0, 0, .5};
    require(rails.accepts(window, false, 1) && !rails.accepts(window, false, 0),
            "Grace widens the vertical contact window");
    window.offset = {1.5, 0, 0};
    require(!rails.accepts(window, false, 1), "Snap windows are strict at the boundary");
    rails.enable(0, false);
    require(!rails.nearest(position), "Candidacy toggle removes a curve independently of visible geometry");
    rails.reset();
    require(rails.nearest(position).has_value(), "Reset restores authored candidacy");
    require(!rails.nearest({100, 100, 100}), "Distant query is rejected by spatial bounds");
    rejects([&] { rails.enable(5, true); }, "Reject invalid spline toggle index");
    std::vector<RailSpline> many;
    for (unsigned i = 0; i < 500; ++i)
        many.push_back({13, true, {{{Vec3{}, Vec3{}, Vec3{0, 0, -10}, Vec3{double(i) * 10, 2, 0}}}}});
    Rails indexed(std::move(many));
    const auto found = indexed.nearest({3450, 2, -4});
    require(found && found->spline == 345, "Spatial gathering preserves the correct source spline index");
}

void gameplay(const std::filesystem::path& root) {
    map(root, Json::array({curve({0, 1.5, 0}, {0, 1.5, -500})}));
    Player flat(Terrain::load(root));
    flat.warp({0, 1.55, -5}, {0, 0, -1}, {0, 0, -12});
    flat.tick({});
    require(flat.rider().motion == Motion::Rail && flat.rider().control == Control::OnRail && flat.rider().grinds == 1,
            "Air entry attaches to the authored rail state pair");
    require(flat.rider().surface == 13 && !flat.rider().grounded, "Rail material replaces the ice beneath the spline");
    for (unsigned i = 0; i < 180; ++i) {
        flat.tick({1});
        near(length(flat.rider().velocity), 12, 1e-9, "Horizontal grind has zero friction");
        require(flat.rider().motion == Motion::Rail, "Holding spin is not a balance failure");
        near(dot(flat.camera_forward(), {0, 0, -1}), 1, 1e-9, "Rail trick yaw stays out of the camera frame");
    }
    near(flat.rider().rail_spin, 80, 1e-9, "Deck spin clamps at eighty degrees");
    require(flat.effects().wake().empty() && flat.effects().sheet().empty(),
            "Rail does not emit grounded snow grooves/spray");
    Player straight(Terrain::load(root)), responsive(Terrain::load(root));
    for (auto* player : {&straight, &responsive}) {
        player->warp({0, 1.55, -5}, {0, 0, -1}, {0, 0, -12});
        player->tick({});
    }
    const auto steer = [&](double direction, unsigned ticks) {
        for (unsigned i = 0; i < ticks; ++i) {
            responsive.tick({direction});
            straight.tick({});
        }
        near(length(responsive.rider().position - straight.rider().position), 0, 1e-9,
             "Visible rail yaw never steers the rider off the analytic curve");
        near(length(responsive.rider().velocity - straight.rider().velocity), 0, 1e-9,
             "Rail yaw leaves carried travel speed unchanged");
        near(dot(responsive.camera_forward(), straight.camera_forward()), 1, 1e-9,
             "Desktop rail camera retains travel heading through a boardslide");
    };
    steer(1, 6);
    near(responsive.rider().rail_spin, 24, 1e-9, "Desktop deck responds at 240 degrees per second immediately");
    steer(1, 14);
    near(responsive.rider().rail_spin, 80, 1e-9, "Desktop reaches full boardslide in one third of a second");
    steer(-1, 20);
    near(responsive.rider().rail_spin, 0, 1e-9,
         "Opposite held input reverses the visible deck without a slow rate slew");
    steer(-1, 20);
    near(responsive.rider().rail_spin, -80, 1e-9, "Opposite boardslide respects the negative pose cap");
    steer(.2, 20);
    near(responsive.rider().rail_spin, 0, 1e-9, "Released or dead-zone input returns the deck to rail travel");
    flat.tick({0, false, false, false, 0, true});
    require(flat.rider().motion == Motion::Air && flat.rider().control == Control::Launched &&
                flat.rider().rail_exits == 1,
            "Explicit exit leaves with carried velocity and launched-air control");
    require(flat.rider().velocity.z < -11, "Rail exit retains travel momentum");
    Player jump(Terrain::load(root));
    jump.warp({0, 1.55, -5}, {0, 0, -1}, {0, 0, -12});
    jump.tick({});
    for (unsigned i = 0; i < 24; ++i)
        jump.tick({0, false, false, true});
    require(jump.rider().control == Control::Charge && jump.rider().charge > .99 && jump.rider().motion == Motion::Rail,
            "Rail accepts the shared charged jump control");
    for (unsigned i = 0; i < 5; ++i)
        jump.tick({});
    require(jump.rider().launches == 1 && jump.rider().motion == Motion::Air &&
                jump.rider().control == Control::Launched,
            "Shared release impulse exits a rail");
    require(jump.rider().velocity.y > 6 && jump.rider().velocity.z < -12,
            "Rail ollie carries speed and the shared normal/tangent launch");
    jump.tick({});
    require(jump.rider().motion == Motion::Air, "Launch cooldown prevents immediate rail reattachment");
    Player focus(Terrain::load(root));
    focus.warp({0, 1.55, -5}, {0, 0, -1}, {0, 0, -12});
    focus.tick({});
    focus.tick({0, false, false, true});
    focus.release_inputs();
    require(focus.rider().control == Control::OnRail && focus.rider().charge == 0,
            "Focus loss cancels charge into the current rail control");
    focus.tick({0, false, false, true});
    require(focus.rider().control == Control::Charge, "Charge can be started again after focus resumes");
    Player toggle(Terrain::load(root));
    toggle.warp({0, 1.55, -5}, {0, 0, -1}, {0, 0, -12});
    toggle.tick({});
    toggle.rails().enable(0, false);
    toggle.tick({});
    require(toggle.rider().motion == Motion::Air && toggle.rider().control == Control::Launched,
            "Disabled rail loses contact on the next fixed tick");
    map(root, Json::array({curve({0, 1.5, 0}, {0, 1.5, -5}), curve({0, 1.5, -5}, {5, 1.5, -10})}));
    Player chain(Terrain::load(root));
    chain.warp({0, 1.55, -4}, {0, 0, -1}, {0, 0, -8});
    for (unsigned i = 0; i < 18; ++i)
        chain.tick({});
    require(chain.rider().motion == Motion::Rail && chain.rider().rail_transfers > 0 && chain.rider().rail_segment == 1,
            "Adjacent segments chain through the analytic query");
    for (unsigned i = 0; i < 150 && chain.rider().motion == Motion::Rail; ++i)
        chain.tick({});
    require(chain.rider().motion == Motion::Air && chain.rider().rail_exits > 0,
            "Spline end leaves the curve with carried velocity");
    for (const auto grade : {-1., 1.}) {
        map(root, Json::array({curve({0, 10, 0}, {0, 10 + grade * 100, -500})}), 5);
        Player slope(Terrain::load(root));
        const auto tangent = normalized(Vec3{0, grade * 100, -500});
        slope.warp({0, 10 + grade * 2, -10}, tangent, tangent * 12);
        for (unsigned i = 0; i < 60; ++i)
            slope.tick({});
        near(length(slope.rider().velocity), 12 + dot(Vec3{0, -9.8, 0}, tangent), .001,
             "Dedicated rail slope gravity changes speed without friction");
        require(slope.rider().surface == 5, "Positive rail styles retain their material row");
    }
    map(root, Json::array({curve({0, 1.5, 0}, {0, 1.5, -500})}));
    Player boost(Terrain::load(root));
    boost.warp({0, 1.5, -5}, {0, 0, 1}, {0, 0, 12});
    for (unsigned i = 0; i < 10; ++i)
        boost.tick({0, true});
    near(boost.rider().velocity.z, 12 + 24.508 / 6, 1e-9, "Boost thrust is signed along backward travel");
    std::optional<Vec3> baseline;
    for (const auto fps : {60u, 72u, 90u, 120u, 144u}) {
        Player player(Terrain::load(root));
        player.warp({0, 1.55, -5}, {0, 0, -1}, {0, 0, -12});
        for (unsigned i = 0; i < fps * 2; ++i)
            player.advance(1. / fps, {});
        require(player.rider().motion == Motion::Rail, "Presentation rates retain rail contact");
        if (baseline)
            near(length(player.rider().position - *baseline), 0, 1e-9,
                 "Grind trajectory is independent of presentation rate");
        else
            baseline = player.rider().position;
    }
}

void contact_masks(const std::filesystem::path& root) {
    map(root, Json::array({curve({0, 1.5, 0}, {0, 1.5, -500})}));
    auto bounds = Json{{"Min", {-50, 0, 140}}, {"Max", {50, 50000, 210}}};
    const auto models = [&] {
        write(root / "Models.json",
              {{"Models", Json::array({{{"ModelObjects", Json::array({{{"ParentID", -1},
                                                                       {"CollisionBounds", bounds},
                                                                       {"MeshData", Json::array()}}})}}})}});
    };
    models();
    write(root / "Materials.json", {{"Materials", Json::array()}});
    write(root / "Instances.json", {{"Instances", Json::array({{{"ModelID", 0},
                                                                {"CollsionMode", 2},
                                                                {"PlayerCollision", true},
                                                                {"PlayerBounce", true},
                                                                {"PlayerBounceAmmount", .5},
                                                                {"U0", 1},
                                                                {"SurfaceType", -1}}})}});
    Player tube(Terrain::load(root));
    tube.warp({0, 1.55, -5}, {0, 0, -1}, {0, 0, -12});
    for (unsigned i = 0; i < 60; ++i)
        tube.tick({});
    require(tube.rider().motion == Motion::Rail && tube.rider().world_contacts == 0,
            "Torso/head bounds keep the solid tube from vetoing rail attachment");
    bounds["Min"][2] = 250;
    bounds["Max"][2] = 350;
    models();
    Player overhead(Terrain::load(root));
    overhead.warp({0, 1.55, -5}, {0, 0, -1}, {0, 0, -12});
    overhead.tick({});
    require(overhead.rider().world_contacts > 0, "Rail's upper-body probe still admits an overhead solid");
}

void profiles(const std::filesystem::path& root) {
    map(root, Json::array({curve({0, 1.5, 0}, {0, 1.5, -500})}), 13, 0);
    require(!Rails::load(root).nearest({0, 1.5, -5}), "Authored candidacy zero is not default-enabled");
    map(root, Json::array({curve({0, 1.5, 0}, {0, 1.5, -500})}), 13, -2);
    require(!Rails::load(root).nearest({0, 1.5, -5}), "Negative even candidacy leaves bit zero clear");
    auto segment = curve({0, 1.5, 0}, {0, 1.5, -500});
    segment["PowerCoefficients"] = Json::array({vector({}), vector({}), vector({0, 0, -500}), vector({10, 1.5, 0})});
    map(root, Json::array({segment}));
    const auto edited = Rails::load(root).nearest({0, 1.5, -5});
    require(edited && std::abs(edited->point.x) < 1e-9, "Edited portable controls replace stale retained coefficients");
    segment["Points"] = Json::array({{0, 0, 0}});
    map(root, Json::array({segment}));
    rejects([&] { Rails::load(root); }, "Reject malformed rail geometry");
}
} // namespace

int main() {
    try {
        queries();
        const auto root =
            std::filesystem::temp_directory_path() /
            ("openslope-rails-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::create_directory(root);

        struct Cleanup {
            std::filesystem::path path;

            ~Cleanup() {
                std::error_code ec;
                std::filesystem::remove_all(path, ec);
            }
        } cleanup{root};

        gameplay(root);
        contact_masks(root);
        profiles(root);
        std::cout << "PASS: " << checks << " cubic query, candidacy, grind, spin, jump, slope, probe and exit checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
