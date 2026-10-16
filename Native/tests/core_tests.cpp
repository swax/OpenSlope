#include "../src/render_math.hpp"
#include "openslope/appearance.hpp"
#include "openslope/import.hpp"
#include "openslope/player.hpp"
#include "openslope/props.hpp"
#include "openslope/visibility.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <random>
#include <stdexcept>

namespace {
using namespace openslope;
unsigned checks = 0;

void require(bool condition, const char* message) {
    ++checks;
    if (!condition)
        throw std::runtime_error(message);
}

void near(double actual, double expected, double tolerance, const char* message) {
    ++checks;
    if (!(std::abs(actual - expected) <= tolerance))
        throw std::runtime_error(std::string(message) + ": actual " + std::to_string(actual) + ", expected " +
                                 std::to_string(expected));
}

Patch plane(double y = 0, int surface = 1) {
    Patch patch;
    patch.surface = surface;
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            patch.points[u * 4 + v] = {v * 10.0 / 3, y, -double(u) * 10.0 / 3};
    return patch;
}

void terrain_tests() {
    auto p = plane();
    near(length(p.evaluate(.25, .75) - Vec3{7.5, 0, -2.5}), 0, 1e-12, "Bezier control-point ordering");
    near(length(p.normal(.3, .7) - Vec3{0, 1, 0}), 0, 1e-12, "Skyward analytic normal");
    auto terrain = Terrain({p});
    auto hit = terrain.intersect({7.5, 2, -2.5}, {7.5, -1, -2.5});
    require(hit.has_value() && hit->refined, "Planar intersection");
    near(hit->u, .25, 1e-12, "Planar u");
    near(hit->v, .75, 1e-12, "Planar v");
    require(!terrain.intersect({20, 2, -2}, {20, -1, -2}), "Miss outside patch");
    require(!terrain.intersect({2, 1, -2}, {2, 1, -2}), "Zero-length ray");
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            p.points[u * 4 + v].y = (u == 1 || u == 2 ? 2.0 : 0) + (v == 1 || v == 2 ? 1.0 : 0);
    terrain = Terrain({p});
    const auto expected = p.evaluate(.37, .61);
    hit = terrain.intersect(expected + Vec3{0, 2, 0}, expected - Vec3{0, 2, 0});
    require(hit.has_value() && hit->refined, "Curved patch must refine");
    near(length(hit->point - expected), 0, 1e-7, "Curved hit must lie on the probe and surface");
    near(length(hit->normal - p.normal(.37, .61)), 0, 1e-7, "Curved normal must be analytic");
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            p.points[u * 4 + v] = {v * 100. / 3, -(u == 1 || u == 2 ? 20. : 0) - (v == 1 || v == 2 ? 10. : 0),
                                   -double(u) * 100. / 3};
    terrain = Terrain({p});
    const auto bowl_point = p.evaluate(.37, .61);
    require(!terrain.intersect(bowl_point + Vec3{0, .12, 0}, bowl_point + Vec3{0, .04, 0}),
            "a coarse chord above a curved surface is not a landing");
    for (double sign : {-1., 1.}) {
        hit = terrain.intersect(bowl_point + Vec3{0, .002 * sign, 0}, bowl_point - Vec3{0, .002 * sign, 0});
        require(hit && hit->refined, "short rays find the surface even when its mesh seed is outside the ray");
        near(length(hit->point - bowl_point), 0, 1e-7, "short curved intersection satisfies the real surface");
    }
    hit = terrain.intersect(bowl_point + Vec3{0, .002, 0}, bowl_point);
    require(hit && hit->refined, "analytic contact at the ray endpoint remains valid");
    for (const auto uv : std::array<std::array<double, 2>, 5>{{{0, 0}, {0, .37}, {1, 1}, {.5, 1}, {.37, .61}}}) {
        const auto point = p.evaluate(uv[0], uv[1]), normal = p.normal(uv[0], uv[1]);
        hit = terrain.intersect(point + normal * .002, point - normal * .002);
        require(hit && hit->refined, "short contact probes include curved patch boundaries");
        near(length(hit->point - point), 0, 1e-7, "boundary contact remains on the analytic patch");
    }
    Player curved_rider(Terrain({p}));
    const auto up = p.normal(.37, .61), down = normalized(project(Vec3{0, 0, -1}, up));
    curved_rider.warp(bowl_point + Vec3{0, .1, 0}, down, down, up);
    for (unsigned i = 0; i < 120; ++i)
        curved_rider.tick({.posture = 1});
    require(length(curved_rider.rider().position - bowl_point) > 2,
            "a rider clears the chord and continues across the curved surface");
    require(curved_rider.rider().landings < 10, "curved terrain does not repeatedly re-land a stationary rider");
    const auto airborne_start = bowl_point + Vec3{0, .3, 0};
    Patch wall;
    wall.surface = 18;
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v) {
            const auto y = airborne_start.y - 2 + 4. * u / 3;
            wall.points[u * 4 + v] = {airborne_start.x + .001 * (airborne_start.y + .5 - y), y,
                                      airborne_start.z - 20 + 40. * v / 3};
        }
    Player airborne(Terrain({p, wall}));
    airborne.warp(airborne_start, {1, 0, 0}, {6, 0, 0}, {0, 1, 0});
    require(!airborne.rider().grounded && airborne.rider().normal.x > .99 && airborne.rider().board_up.y > .99,
            "the departing rider retains a wall probe normal while its body stays upright");
    for (unsigned i = 0; i < 120; ++i)
        airborne.tick({});
    require(airborne.rider().landings > 0,
            "the upright airborne guard lets the rider fall onto the floor after leaving a wall");
    Patch bank, nearby_wall;
    bank.surface = 3;
    nearby_wall.surface = 18;
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v) {
            const auto x = -20 + 40. * u / 3, z = -20 + 40. * v / 3, y = -10 + 20. * u / 3;
            bank.points[u * 4 + v] = {x, -x - .1 * z, z};
            nearby_wall.points[u * 4 + v] = {1 + .001 * y, y, z};
        }
    const auto bank_up = normalized(Vec3{1, 1, .1});
    const auto along_bank = normalized(project(Vec3{0, 0, -1}, bank_up));
    const Terrain junction_terrain({bank, nearby_wall});
    const auto two_sided = junction_terrain.intersect(bank_up * 2, -bank_up);
    const auto support = junction_terrain.intersect(bank_up * 2, -bank_up, true);
    require(two_sided && two_sided->surface == 18 && support && support->surface == 3,
            "the ground ray skips a reverse-facing wall and still finds its floor");
    Player junction(Terrain({bank, nearby_wall}));
    junction.warp({}, along_bank, along_bank * 6, bank_up);
    const auto junction_serial = junction.placement_serial();
    for (unsigned i = 0; i < 120; ++i)
        junction.tick({.posture = 1});
    require(length(junction.rider().position) > 2 && junction.rider().landings < 20,
            "a landing at the start of a frame retains motion beside a steep probe overlap");
    require(junction.placement_serial() == junction_serial,
            "the terrain junction clears through ordinary motion without a reset");
    auto ledge = plane(), lower = plane(-5);
    for (auto& point : ledge.points) {
        point.x = point.x * .04 - .2;
        point.z = point.z * 4 + 20;
    }
    for (auto& point : lower.points) {
        point.x = point.x * 20 - 100;
        point.z = point.z * 20 + 100;
    }
    for (const int lead : {-1, 1})
        for (const double slide : {-.45, .45}) {
            Player edge(Terrain({ledge, lower}));
            edge.warp({}, {0, 0, 1}, {0, -1, 6});
            auto& pose = const_cast<Rider&>(edge.rider());
            pose.lead = lead;
            pose.slide = slide;
            const auto serial = edge.placement_serial();
            for (unsigned i = 0; i < 120; ++i)
                edge.tick({.posture = 1});
            require(pose.position.y < -4 && pose.landings < 5,
                    "a carved deck beyond a ledge falls rather than repeatedly landing its unshifted root");
            require(serial == edge.placement_serial(), "carve-edge motion needs no hidden placement");
        }
    std::vector<Patch> layers;
    for (int i = 0; i < 20; ++i)
        layers.push_back(plane(i * .1));
    layers.push_back(plane(3, 17));
    terrain = Terrain(std::move(layers));
    hit = terrain.intersect({5, 4, -5}, {5, -1, -5});
    require(hit.has_value(), "BVH must find hit");
    near(hit->point.y, 1.9, 1e-12, "Nearest hit excludes no-collision decoration");
    const auto mesh = Terrain({plane()}).mesh(2);
    require(mesh.vertices.size() == 9 && mesh.indices.size() == 24, "Mesh subdivision shape");
    p = plane();
    p.texture = "authored.png";
    p.uv = {{{-1, 2}, {-1, -2}, {3, 2}, {3, -2}}};
    p.lightmap = 7;
    p.lightmap_rect = {.25, .5, .125, .25};
    for (const auto& corner :
         std::array<std::array<double, 4>, 4>{{{0, 0, -1, 2}, {1, 0, -1, -2}, {0, 1, 3, 2}, {1, 1, 3, -2}}}) {
        const auto uv = p.texture_uv(corner[0], corner[1]);
        near(uv[0], corner[2], 0, "Diffuse corner pairing supports repeat/mirror");
        near(uv[1], corner[3], 0, "Diffuse corner V pairing");
    }
    const auto lm = p.lightmap_uv(.2, .7);
    near(lm[0], .3375, 1e-12, "Lightmap U uses patch v");
    near(lm[1], .55, 1e-12, "Lightmap V uses patch u");
    auto other = p;
    other.texture = "other.png";
    const auto grouped = Terrain({p, other, p}).mesh(2);
    require(grouped.batches.size() == 2 && grouped.batches[0].count == 48 && grouped.batches[1].count == 24,
            "Shared material patches form contiguous draws");
    require(grouped.terrain_ranges.size() == 3 && grouped.terrain_ranges[0].first == 0 &&
                grouped.terrain_ranges[1].first == 24 && grouped.terrain_ranges[2].batch == 1,
            "Patch visibility spans retain material/index order");
    near(grouped.vertices[0].s, -1, 0, "Mesh carries diffuse UV");
    near(grouped.vertices[0].lx, .25, 0, "Mesh carries lightmap tile bounds");
    require(referenced_images(Terrain({p, p})) ==
                std::vector<std::string>({"Lightmaps/0007.png", "Textures/authored.png"}),
            "Unique portable image paths");
    const auto colour =
        terrain_light({200. / 255, 180. / 255, 160. / 255}, {20. / 255, 40. / 255, 60. / 255, 128. / 255});
    near(colour[0], 180. * 128 / (255. * 255), 1e-12, "RGB residual subtracts before alpha intensity");
    near(terrain_light({.1, .2, .3}, {.2, .1, .4, .5})[0], 0, 0, "Negative lighting saturates");
    for (const bool invalid_uv : {false, true}) {
        auto bad = p;
        if (invalid_uv)
            bad.uv[0][0] = std::numeric_limits<double>::infinity();
        else
            bad.lightmap_rect = {.9, .2, .2, .1};
        bool rejected = false;
        try {
            static_cast<void>(Terrain({bad}));
        } catch (const std::exception&) {
            rejected = true;
        }
        require(rejected, "Reject invalid GPU material coordinates");
    }
}

void visibility_tests() {
    const auto identity = Matrix::identity();
    const Frustum clip(identity.values);
    require(clip.classify({{-.2, -.2, .2}, {.2, .2, .8}}) == 1, "Interior AABB is fully inside");
    for (const auto p : std::array<Vec3, 6>{{{-2, 0, .5}, {2, 0, .5}, {0, -2, .5}, {0, 2, .5}, {0, 0, -1}, {0, 0, 2}}})
        require(clip.classify({p - Vec3{.01, .01, .01}, p + Vec3{.01, .01, .01}}) == -1,
                "Reject each of six Vulkan clip planes");
    require(clip.classify({{-100, -100, -100}, {100, 100, 100}}) == 0, "Keep bounds enclosing the entire view");
    require(clip.classify({{-.1, -.1, 0}, {.1, .1, 0}}) == 0, "Retain exact near-plane boundary");
    const auto left = projection(-1, 1, -1, 1) * view({-.2, 0, 0}, {0, 0, -1}),
               right = projection(-1, 1, -1, 1) * view({.2, 0, 0}, {0, 0, -1});
    const Bounds stereo{{1.05, -.01, -1.01}, {1.15, .01, -.99}};
    require(Frustum(left.values).classify(stereo) < 0 && Frustum(right.values).classify(stereo) >= 0,
            "Each stereo eye independently retains its edge geometry");
    VisibilityTree tree;
    std::vector<Bounds> boxes;
    for (unsigned i = 0; i < 1024; ++i)
        boxes.push_back({{10. + i, -.1, .2}, {10.1 + i, .1, .8}});
    tree.build(boxes);
    std::vector<std::size_t> ids;
    std::size_t tested = 0;
    tree.query(clip, ids, tested);
    require(ids.empty() && tested == 1, "Reject a distant subtree without per-patch work");
    std::mt19937 random(419);
    std::uniform_real_distribution<double> position(-20, 20), extent(.01, 3);
    boxes.clear();
    for (unsigned i = 0; i < 1024; ++i) {
        const Vec3 p{position(random), position(random), position(random)},
            e{extent(random), extent(random), extent(random)};
        boxes.push_back({p - e, p + e});
    }
    tree.build(boxes);
    for (unsigned frame = 0; frame < 20; ++frame) {
        const Vec3 eye{position(random), position(random), position(random)};
        const auto camera = projection(-.9, .9, -.7, .7) *
                            view(eye, normalized(Vec3{position(random), position(random), position(random)}));
        std::vector<std::size_t> expected;
        for (std::size_t i = 0; i < boxes.size(); ++i)
            if (prop_visible(boxes[i], camera.values, eye, 1e10))
                expected.push_back(i);
        tree.query(Frustum(camera.values), ids, tested);
        require(ids == expected, "Hierarchy agrees with independent eight-corner clip oracle and preserves order");
    }
    bool rejected = false;
    try {
        tree.build(std::array<Bounds, 1>{Bounds{}});
    } catch (const std::exception&) {
        rejected = true;
    }
    require(rejected, "Reject empty/non-finite visibility bounds");
}

void map_tests() {
    const auto path = std::filesystem::temp_directory_path() /
                      ("openslope-native-test-" +
                       std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ".json");

    struct Cleanup {
        std::filesystem::path path;

        ~Cleanup() {
            std::error_code ec;
            std::filesystem::remove(path, ec);
        }
    } cleanup{path};

    nlohmann::json row = {{"PatchName", "synthetic"},
                          {"SurfaceType", 1},
                          {"TrickOnlyPatch", false},
                          {"TexturePath", ""},
                          {"LightmapID", 0},
                          {"LightMapPoint", {0, 0, 1, 1}},
                          {"UVPoints", {{0, 0}, {1, 0}, {0, 1}, {1, 1}}}};
    row["Points"] = nlohmann::json::array();
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            row["Points"].push_back({-double(v) * 100.0, u * 100.0, 1000.0});
    const auto write = [&] {
        std::ofstream file(path);
        file << nlohmann::json{{"Patches", {row}}};
    };
    write();
    const auto terrain = Terrain::load(path);
    near(length(terrain.patches()[0].evaluate(1, 1) - Vec3{-3, 10, -3}), 0, 1e-12,
         "Raw centimetres rotate to Y-up without reflecting X");
    auto route = nlohmann::json::array();
    for (const auto offset : std::array<Vec3, 3>{{{0, 0, 0}, {0, 1000, 0}, {1000, 1000, 0}}}) {
        auto piece = row;
        for (auto& point : piece["Points"]) {
            point[0] = point[0].get<double>() + offset.x;
            point[1] = point[1].get<double>() + offset.y;
        }
        route.push_back(std::move(piece));
    }
    {
        std::ofstream file(path);
        file << nlohmann::json{{"Patches", route}};
    }
    const auto corner = Terrain::load(path);
    const auto a = corner.patches()[0].evaluate(0, 0), b = corner.patches()[1].evaluate(0, 0),
               c = corner.patches()[2].evaluate(0, 0);
    require(dot(c - b, cross(b - a, {0, 1, 0})) > 0, "An authored right turn stays right after map loading");
    row["Points"].erase(0);
    write();
    bool rejected = false;
    try {
        static_cast<void>(Terrain::load(path));
    } catch (const std::exception&) {
        rejected = true;
    }
    require(rejected, "Reject incomplete control grid");
}

void response_tests(const char* fixture) {
    RideContract contract;
    std::ifstream stream(fixture);
    require(bool(stream), "Open scalar fixture");
    const auto document = nlohmann::json::parse(stream);
    require(document.at("schema") == "carving-response-cases/v1", "Scalar fixture version");
    for (const auto& item : document.at("cases")) {
        const auto& input = item.at("surface");
        Surface surface;
        surface.type = input.at("type");
        surface.resistance_a = input.at("resistanceA");
        surface.resistance_b = input.at("resistanceB");
        surface.resistance_c = input.at("resistanceC");
        const auto& tuning = item.at("tuning");
        ResponseTuning t{tuning.at("linearStat"),    tuning.at("quadraticStat"), tuning.at("skidStat"),
                         tuning.at("lateralStat"),   tuning.at("mode"),          tuning.at("edge"),
                         tuning.at("preferredEdge"), tuning.at("loadRatio"),     tuning.at("skid")};
        const auto expected_forward = item.at("forwardAcceleration").get<double>(),
                   expected_lateral = item.at("lateralAcceleration").get<double>();
        near(contract.forward_resistance(surface, item.at("u"), item.at("error"), item.at("budget"), item.at("charge"),
                                         item.at("boost"), t),
             expected_forward, 2e-6 * std::max(1.0, std::abs(expected_forward)),
             "Independent forward-resistance fixture");
        near(contract.lateral_resistance(input.at("drag"), item.at("u"), item.at("w"), item.at("lean"),
                                         item.at("boost"), t),
             expected_lateral, 2e-6 * std::max(1.0, std::abs(expected_lateral)),
             "Independent lateral-resistance fixture");
    }
    const auto& snow = contract.surface(1);
    near(contract.contact_response(snow, -snow.bog, 0, snow.bog, snow.budget), snow.A / 100, 1e-12,
         "Bog-floor response units");
    near(contract.contact_response(snow, -snow.budget - 1, 0, snow.bog, snow.budget), 3 * snow.A / 100, 1e-12,
         "Deep-zone response cap");
    near(contract.contact_response(snow, .01, -1, snow.bog, snow.budget), -snow.A / 30 * .01 + snow.P, 1e-12,
         "Spec above-surface damping applies while approaching");
    const Vec3 v{10, -3, 0};
    near(length(contract.redirect(v, {0, 1, 0}, 1)), length(v), 1e-12, "Redirect preserves speed");
    near(length(contract.redirect(v, {0, 1, 0}, 3) - v), 0, 1e-12, "Powder skips redirect");
    near(contract.heading_yaw(1, .6, 0, 0, 0, 0, 1.0 / 60), 0, 0, "Yaw has no authority at rest");
    near(contract.heading_yaw(1, .6, 0, 30, 30, 30, 1.0 / 60), contract.response("yaw", "capRadPerTick"), 1e-12,
         "Yaw cap is per tick");
    require(contract.surface(-1).type == 15 && contract.surface(25).type == 15, "Unknown surface fallback");
    std::cout << "Validated " << document.at("cases").size() << " independent carving cases\n";
}

void clock_tests() {
    for (const auto hz : {72, 90, 120, 144}) {
        FixedClock clock;
        unsigned ticks = 0;
        for (int i = 0; i < hz * 10; ++i)
            ticks += clock.advance(1.0 / hz);
        require(ticks == 600, "Simulation frequency independent of presentation rate");
        require(clock.alpha() >= 0 && clock.alpha() < 1, "Interpolation alpha bounded");
    }
    FixedClock clock;
    require(clock.advance(100) == 6, "Suspend catch-up bounded");
    bool rejected = false;
    try {
        clock.advance(-1);
    } catch (const std::invalid_argument&) {
        rejected = true;
    }
    require(rejected, "Reject negative frame duration");
    Player reference(Terrain::demo());
    for (int i = 0; i < 600; ++i)
        reference.tick({});
    for (const auto hz : {72, 90, 120}) {
        Player candidate(Terrain::demo());
        for (int i = 0; i < hz * 10; ++i)
            candidate.advance(1.0 / hz, {});
        near(length(candidate.rider().position - reference.rider().position), 0, 1e-8,
             "Player fixed-tick frame-rate independence");
        require(finite(candidate.rider().position) && finite(candidate.rider().velocity), "Finite prototype ride");
    }
}

void import_tests() {
    const auto decode = [](std::size_t size, std::initializer_list<std::uint8_t> commands) {
        std::vector<std::uint8_t> input = {0x10, 0xfb, 0, 0, static_cast<std::uint8_t>(size)};
        input.insert(input.end(), commands);
        return decode_refpack(input);
    };
    require(decode(4, {1, 0, 'a', 0xfc}) == std::vector<std::uint8_t>(4, 'a'),
            "RefPack two-byte command and overlapping match");
    require(decode(6, {0x81, 0x40, 0, 'b', 0xfc}) == std::vector<std::uint8_t>(6, 'b'), "RefPack three-byte command");
    require(decode(8, {0xc1, 0, 0, 2, 'c', 0xfc}) == std::vector<std::uint8_t>(8, 'c'), "RefPack four-byte command");
    require(decode(5, {0xe0, 'a', 'b', 'c', 'd', 0xfd, 'e'}) == std::vector<std::uint8_t>({'a', 'b', 'c', 'd', 'e'}),
            "RefPack literal run and stop literals");
    require(decode_refpack(std::vector<std::uint8_t>({0x90, 0xfb, 0, 0, 0, 1, 0xfd, 'x'})) ==
                std::vector<std::uint8_t>({'x'}),
            "RefPack long-size header");
    for (const auto& stream : std::vector<std::vector<std::uint8_t>>{{0x10, 0xfb, 0, 0, 4, 0xfc},
                                                                     {0x10, 0xfb, 0, 0, 4, 0, 0, 0xfc},
                                                                     {0x10, 0xfb, 0, 0, 1, 0xe0, 'a', 'b', 'c', 'd'},
                                                                     {0x10, 0xfb, 0, 0, 4, 0xe0, 'a', 'b', 'c', 'd'},
                                                                     {0x11, 0xfb, 0, 0, 1, 0xfc}}) {
        bool rejected = false;
        try {
            static_cast<void>(decode_refpack(stream));
        } catch (const std::exception&) {
            rejected = true;
        }
        require(rejected, "Reject corrupt RefPack without out-of-bounds access");
    }
    for (const auto& name : {"../map", "map/sub", ".staging", "bad\\map", "bad:map", "bad*map", "map."})
        require(!valid_map_name(name), "Reject unsafe map name");
    require(valid_map_name("Custom course 01"), "Allow authored map names with spaces");
    DiscInput input{4, [](std::uint64_t, std::span<std::uint8_t> bytes) { std::fill(bytes.begin(), bytes.end(), 7); }};
    require(input.read(1, 3) == std::vector<std::uint8_t>(3, 7), "Bounded random-access document input");
    bool rejected = false;
    try {
        static_cast<void>(input.read(3, 2));
    } catch (const std::exception&) {
        rejected = true;
    }
    require(rejected, "Reject disc extent outside document");
    const auto root =
        std::filesystem::temp_directory_path() /
        ("openslope-import-unit-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    require(std::filesystem::create_directory(root), "Create isolated import fixture");

    struct Cleanup {
        std::filesystem::path path;

        ~Cleanup() {
            std::error_code ec;
            std::filesystem::remove_all(path, ec);
        }
    } cleanup{root};

    const auto stage = root / "cancelled";
    rejected = false;
    try {
        extract_course(input, "TEST", stage, {}, [] { return true; });
    } catch (const std::exception&) {
        rejected = true;
    }
    require(rejected && !std::filesystem::exists(stage),
            "Cancelled extraction removes only newly created staging folder");
    const auto custom = root / "Custom course";
    std::filesystem::create_directory(custom);
    std::ofstream(custom / "Patches.json") << "custom";
    std::filesystem::create_directory(root / ".staging");
    std::ofstream(root / ".staging" / "Patches.json") << "partial";
    require(available_maps(root) == std::vector<std::string>({"Custom course"}),
            "List populated custom maps without ISO and exclude staging");
    rejected = false;
    try {
        extract_course(input, "TEST", custom);
    } catch (const std::exception&) {
        rejected = true;
    }
    require(rejected && std::filesystem::exists(custom / "Patches.json"), "Never overwrite existing authored map");
}
} // namespace

int main(int argc, char** argv) {
    try {
        require(argc == 2, "Supply the independent scalar fixtures");
        terrain_tests();
        visibility_tests();
        map_tests();
        response_tests(argv[1]);
        clock_tests();
        import_tests();
        std::cout << "PASS: " << checks << " native conformance checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
