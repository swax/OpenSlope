#include "openslope/avatar.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace {
using namespace openslope;
using Json = nlohmann::json;
unsigned checks = 0;

void check(bool value, const char* message) {
    ++checks;
    if (!value)
        throw std::runtime_error(message);
}

void near(double a, double b, const char* message) { check(std::abs(a - b) < 1e-7, message); }

CoursePath line(double x = 6, double slope = 0) {
    CoursePath p;
    p.points = {{x, 0, 0}, {x, slope * 200, 200}};
    p.distance_to_finish = 200;
    return p;
}

CoursePaths paths(CoursePath p) {
    CoursePaths result;
    result.ai.push_back(std::move(p));
    return result;
}

const RecoveryPose start{{0, 0, 0}, {0, 0, 1}, RecoverySource::Start};
const auto safe = [](Vec3) { return true; };

void complete(Player& player) {
    for (unsigned i = 0; i < 60 && player.reset_pending(); ++i)
        player.tick({});
    check(!player.reset_pending(), "course warp completes within its bounded hold");
}

void queries() {
    auto source = paths(line(6, -.5));
    CourseRecovery reset(source);
    reset.observe({10, -40, 80}, {0, 0, 1});
    const auto target = reset.choose({25, -500, 100}, start, safe);
    check(target && target->source == RecoverySource::AIPath, "tracked AI path anchors a fall below the world");
    near(target->position.x, 6, "placement returns to course rather than lateral rider offset");
    near(target->position.z, 100, "horizontal station retained");
    near(target->position.y, -50, "height interpolates from the horizontal station");
    near(target->station, 100, "AI events use horizontal units rather than 3D arc");
    near(dot(target->forward, {0, 0, 1}), 1, "heading is horizontal and down-course");
    auto disabled = line(25);
    disabled.respawnable = false;
    auto enabled = line(6);
    CoursePaths candidates;
    candidates.ai = {disabled, enabled};
    CourseRecovery flags(candidates);
    const auto admitted = flags.choose({25, 0, 100}, start, safe);
    check(admitted && admitted->path == 1, "respawn-disabled path cannot receive the rider");
    CoursePath folded;
    folded.points = {{2, 0, 6}, {2, 0, 10}, {2, 0, 6}, {2, 0, 110}};
    CoursePaths bend;
    bend.ai = {line(0), folded};
    CourseRecovery ahead(bend);
    const auto turn = ahead.choose({0, 0, 10}, start, safe);
    check(turn && turn->path == 1, "eight-metre lookahead criterion can beat the nearest projection");
    CoursePaths ending;
    ending.ai = {line()};
    ending.race = {line(10)};
    CourseRecovery tail(ending);
    const auto end = tail.choose({6, 0, 199}, start, safe);
    check(end && end->source == RecoverySource::RaceLine,
          "last two metres of AI path are excluded from respawn candidates");
    CoursePaths stacked;
    stacked.ai = {line(0), line(2)};
    CourseRecovery floor_gate(stacked);
    const auto supported = floor_gate.choose({0, 0, 100}, start, [](Vec3 p) { return p.x > 1; });
    check(supported && supported->path == 1, "unsupported first choice does not suppress a supported alternate");
    CoursePaths ties;
    ties.ai = {line(-1), line(1)};
    CourseRecovery current(ties);
    current.observe({1, 0, 50}, {0, 0, 1});
    check(current.choose({0, 0, 60}, start, safe)->path == 1, "retain the currently tracked line when it wins");
    CourseRecovery biased(source);
    biased.observe({6, -40, 80}, {0, 0, 1});
    const auto shifted = biased.choose({6, -40, 80}, start, safe, 16);
    check(shifted && shifted->source == RecoverySource::AIPath, "Forward bias retains a supported respawn path");
    near(shifted->station, 96, "Forward reset bias advances horizontal path metres on a slope");
    near(shifted->position.y, -48, "The biased anchor follows the path's height");
}

void windows() {
    for (const auto type : {103, 105, 100}) {
        auto p = line();
        p.events = {{type, 0, 20, 40}};
        CourseRecovery reset(paths(p));
        const auto target = reset.choose({6, 0, 30}, start, safe);
        check(target.has_value(), "reset window supplies placement");
        near(target->station, type == 103 ? 20 : 40, "pullback/push-forward/jump-window station nudge");
    }
    auto p = line();
    p.events = {{104, 0, 20, 40}};
    CourseRecovery block(paths(p));
    check(block.blocked({6, 0, 20}) && !block.blocked({6, 0, 40}), "no-reset windows are half-open");
    check(!block.choose({6, 0, 30}, start, safe), "no-reset refusal also works before first observation");
    check(block.choose({6, 0, 50}, start, safe).has_value(), "leaving no-reset window re-arms recovery");
    p.events = {{100, 0, 20, 40}, {105, 0, 25, 50}, {103, 0, 10, 35}};
    CourseRecovery priority(paths(p));
    near(priority.choose({6, 0, 30}, start, safe)->station, 10,
         "declared pullback-before-push-before-jump overlap policy");
    CourseRecovery biased_window(paths(p));
    biased_window.observe({6, 0, 5}, {0, 0, 1});
    near(biased_window.choose({6, 0, 5}, start, safe, 25)->station, 10,
         "Authored reset-window adjustment applies after the forward bias");
    p.events = {{105, 0, 150, 220}};
    CourseRecovery extrapolate(paths(p));
    near(extrapolate.choose({6, 0, 180}, start, safe)->position.z, 220,
         "station overrun extrapolates along final direction");
}

void fallback() {
    CoursePaths spine;
    spine.race = {line(6, -.2)};
    CourseRecovery race(spine);
    race.observe({0, -20, 100}, {0, 0, 1});
    const auto projected = race.choose({20, -500, 100}, start, safe);
    check(projected && projected->source == RecoverySource::RaceLine, "custom course spine works without AI paths");
    near(projected->position.z, 100, "fall query uses retained course height for spine choice");
    CoursePaths far;
    far.race = {line(4000)};
    CourseRecovery crumbs(far);
    for (unsigned i = 0; i <= 20; ++i)
        crumbs.observe({0, 0, double(i) * 5}, {0, 0, 1});
    const auto trail = crumbs.choose({20, -500, 100}, start, safe);
    check(trail && trail->source == RecoverySource::Trail, "distant course line falls back to recent rider trail");
    near(trail->position.z, 95, "trail recovery steps a short distance back");
    CourseRecovery empty;
    check(empty.choose({20, -500, 100}, start, safe)->source == RecoverySource::Start,
          "no course or trail falls back to run start");
    check(!empty.choose({20, -500, 100}, start, [](Vec3) { return false; }), "no safe target refuses placement");
    CourseRecovery loop(paths(line()));
    for (unsigned i = 0; i < 3; ++i) {
        const auto target = loop.choose({20, 0, 100}, start, safe);
        check(target && target->source == (i < 2 ? RecoverySource::AIPath : RecoverySource::Start),
              "third rapid recovery escapes an unsafe carry-back loop");
        loop.tick(.5);
    }
    for (unsigned i = 0; i < 8; ++i)
        loop.tick(1);
    check(loop.choose({20, 0, 100}, start, safe)->source == RecoverySource::AIPath,
          "trap guard re-arms after its window");
}

void write_map(const std::filesystem::path& root, int event = -1) {
    Json points = Json::array();
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            points.push_back({double(u) * 200000 / 3 - 100000, double(v) * 200000 / 3 - 100000, 0});
    std::ofstream(root / "Patches.json") << Json{
        {"Patches", Json::array({{{"PatchName", "Authored recovery floor"},
                                  {"SurfaceType", 1},
                                  {"TrickOnlyPatch", false},
                                  {"Points", points},
                                  {"TexturePath", ""},
                                  {"LightmapID", -1},
                                  {"UVPoints", {{0, 0}, {0, 1}, {1, 0}, {1, 1}}},
                                  {"LightMapPoint", {0, 0, 0, 0}}}})}};
    const auto events =
        event < 0 ? Json::array()
                  : Json::array({{{"EventType", event}, {"EventValue", 0}, {"EventStart", 8000}, {"EventEnd", 12000}}});
    std::ofstream(root / "AIP.json") << Json{{"StartPosList", Json::array()},
                                             {"AIPaths", Json::array({{{"PathPos", {600, 0, 0}},
                                                                       {"PathPoints", {{0, -20000, 0}}},
                                                                       {"Respawnable", true},
                                                                       {"PathEvents", events}}})},
                                             {"RaceLines", Json::array({{{"PathPos", {600, 0, 0}},
                                                                         {"PathPoints", {{0, -20000, 0}}},
                                                                         {"DistanceToFinish", 20000},
                                                                         {"PathEvents", Json::array()}}})}};
}

void wedges(const std::filesystem::path& root) {
    write_map(root);
    std::ofstream(root / "Models.json") << Json{
        {"Models",
         Json::array(
             {{{"ModelObjects", Json::array({{{"ParentID", -1},
                                              {"CollisionBounds", {{"Min", {-100, -100, 0}}, {"Max", {100, 100, 400}}}},
                                              {"MeshData", Json::array()}}})}}})}};
    const auto box = [](double x, int surface = -1) {
        return Json{{"ModelID", 0},
                    {"Location", {x, -10000, 0}},
                    {"Rotation", {0, 0, 0, 1}},
                    {"Scale", {1, 1, 1}},
                    {"Visable", true},
                    {"PlayerCollision", true},
                    {"PlayerBounce", true},
                    {"PlayerBounceAmmount", 0},
                    {"CollsionMode", 2},
                    {"U0", 1},
                    {"SurfaceType", surface}};
    };
    const auto instances = [&](Json rows) { std::ofstream(root / "Instances.json") << Json{{"Instances", rows}}; };
    instances(Json::array({box(-120), box(120)}));
    const auto race = [](Player& rider) {
        rider.configure_run(RunMode::Race);
        for (unsigned i = 0; i < 181; ++i)
            rider.tick({});
    };
    const auto trapped = [](Player& rider) { rider.warp({0, -.005, 100}, {0, 0, 1}); };
    Player rider(Terrain::load(root));
    race(rider);
    trapped(rider);
    for (unsigned i = 0; i < 4; ++i) {
        rider.tick({});
        check(!rider.reset_pending(), "a single contact cannot immediately reset the rider");
    }
    check(!rider.contacts().empty(), "the authored narrow gap really contacts the rider");
    rider.tick({});
    check(rider.reset_pending() && rider.rider().control == Control::ResetWarp,
          "five square-on prop shoves arm the shared course reset");
    const auto clock = rider.course_run().status().clock;
    complete(rider);
    check(rider.last_course_recovery() && rider.rider().position.x > 5,
          "prop recovery returns to the nearby safe course rather than the trap");
    check(rider.course_run().status().clock > clock, "prop recovery preserves the live race clock");

    Player interrupted(Terrain::load(root));
    race(interrupted);
    trapped(interrupted);
    for (unsigned i = 0; i < 4; ++i)
        interrupted.tick({});
    interrupted.warp({6, -.005, 100}, {0, 0, 1});
    for (unsigned i = 0; i < 60; ++i)
        interrupted.tick({.posture = -1});
    trapped(interrupted);
    for (unsigned i = 0; i < 4; ++i)
        interrupted.tick({});
    check(!interrupted.reset_pending(), "placement clears contact history before another brief shove");

    Player freeride(Terrain::load(root));
    trapped(freeride);
    for (unsigned i = 0; i < 120; ++i)
        freeride.tick({});
    check(!freeride.reset_pending() && !freeride.last_course_recovery(),
          "freeride keeps control in the same prop trap");

    Player walker(Terrain::load(root));
    race(walker);
    trapped(walker);
    walker.start_on_foot();
    bool foot_contact = false;
    for (unsigned i = 0; i < 120; ++i) {
        walker.tick({.posture = 1, .walk_forward = {0, 0, 1}});
        foot_contact = foot_contact || !walker.contacts().empty();
    }
    check(foot_contact && walker.on_foot() && !walker.reset_pending() && !walker.last_course_recovery(),
          "walking against the same props keeps control without board recovery");

    instances(Json::array({box(0, 1)}));
    Player supported(Terrain::load(root));
    race(supported);
    supported.warp({0, 4, 100}, {0, 0, 1});
    for (unsigned i = 0; i < 120; ++i)
        supported.tick({.posture = -1});
    check(supported.rider().ground_instance.has_value() && !supported.reset_pending() &&
              !supported.last_course_recovery(),
          "riding a prop top is support rather than wedging");

    instances(Json::array());
    Player stationary(Terrain::load(root));
    race(stationary);
    stationary.warp({6, -.005, 100}, {0, 0, 1});
    for (unsigned i = 0; i < 600; ++i)
        stationary.tick({.posture = -1});
    check(!stationary.reset_pending() && !stationary.last_course_recovery(),
          "terrain contact and lack of progress never arm prop recovery");
}

void production(const std::filesystem::path& root) {
    write_map(root);
    Player rider(Terrain::load(root));
    rider.configure_run(RunMode::Showoff);
    for (unsigned i = 0; i < 181; ++i)
        rider.tick({});
    rider.warp({25, -.005, 100}, {0, 0, 1}, {0, 0, 12});
    rider.tick({});
    const auto clock = rider.course_run().status().clock;
    const auto serial = rider.placement_serial();
    check(rider.recover_course(true), "production manual reset accepts authored course");
    check(rider.reset_pending() && rider.rider().control == Control::ResetWarp && rider.placement_serial() == serial,
          "Control 22 holds before camera placement");
    for (unsigned i = 0; i < 12; ++i)
        rider.tick({1, true, false, true, 1});
    near(rider.reset_fade(), .4, "first half-second fades toward black");
    near(rider.rider().position.x, 25, "riding input cannot move a held warp");
    near(rider.scoring().status().meter, .13, "holding boost during warp spends no extra energy");
    for (unsigned i = 0; i < 35; ++i)
        rider.tick({});
    near(rider.reset_fade(), 1, "screen stays opaque before placement");
    check(rider.placement_serial() == serial, "no early placement at tick 47");
    rider.tick({});
    check(!rider.reset_pending() && rider.placement_serial() > serial && !rider.on_foot() &&
              rider.rider().motion == Motion::Air,
          "0.8-second placement reanchors camera and preserves mounted state");
    near(rider.reset_fade(), 1, "placement occurs while completely faded");
    near(rider.rider().position.x, 6, "production placement lands on authored line");
    check(std::abs(rider.rider().position.z - 100) < 1, "production reset retains mid-course station");
    near(rider.rider().position.y, 1, "placement probes actual floor and adds one-metre drop");
    near(length(rider.rider().velocity), 30. / 3.6, "reset starts at exactly thirty kilometres per hour");
    near(rider.course_run().status().clock, clock - .8, "event clock continues through warp without restarting");
    near(rider.scoring().status().meter, .13, "accepted manual reset costs 0.12 energy");
    for (unsigned i = 0; i < 12; ++i)
        rider.tick({});
    near(rider.reset_fade(), 0, "new course view fades back in");
    check(rider.last_course_recovery() && rider.last_course_recovery()->source == RecoverySource::AIPath,
          "production reports chosen recovery source");
    write_map(root, 104);
    Player denied(Terrain::load(root));
    denied.configure_run(RunMode::Showoff);
    for (unsigned i = 0; i < 181; ++i)
        denied.tick({});
    denied.warp({25, -.005, 100}, {0, 0, 1}, {0, 0, 12});
    denied.tick({});
    const auto before = denied.placement_serial();
    check(!denied.recover_course(true) && denied.placement_serial() == before,
          "production no-reset window refuses placement");
    near(denied.scoring().status().meter, .25, "refused reset spends no energy");
    write_map(root);
    Player foot(Terrain::load(root));
    foot.warp({25, -.005, 100}, {0, 0, 1});
    foot.start_on_foot();
    check(foot.recover_course(true), "on-foot recovery accepts request");
    complete(foot);
    check(foot.on_foot() && foot.board_distance() < 1.6, "on-foot recovery keeps a nearby parked board");
    Player holding(Terrain::load(root));
    holding.warp({25, -.005, 100}, {0, 0, 1});
    RideInput held;
    held.reset = held.mount = held.jump = true;
    holding.tick(held);
    const auto held_serial = holding.placement_serial();
    for (unsigned i = 0; i < 48; ++i)
        holding.tick(held);
    check(holding.placement_serial() == held_serial + 1 && !holding.on_foot(),
          "held reset/mount cannot repeat or dismount at warp completion");
    const auto completed = holding.placement_serial();
    for (unsigned i = 0; i < 60; ++i)
        holding.tick(held);
    check(holding.placement_serial() == completed && holding.rider().launches == 0,
          "held jump/reset stay suppressed until release after warp");
    holding.recover_course(true);
    holding.restart_run();
    check(!holding.reset_pending() && holding.reset_fade() == 0, "full restart cancels pending fade/warp");
    std::ofstream(root / "Slopesmith.json")
        << Json{{"schema", 1}, {"kind", "slopesmith-export"}, {"showoffSeconds", .05}};
    Player expiring(Terrain::load(root));
    expiring.configure_run(RunMode::Showoff);
    expiring.tick({});
    check(expiring.course_run().status().phase == RunPhase::Running,
          "Expiry regression requests its reset during the live event");
    check(expiring.recover_course(true), "live event may request reset just before expiry");
    const auto expiry_serial = expiring.placement_serial();
    for (unsigned i = 0; i < 61; ++i)
        expiring.tick({});
    check(expiring.course_run().status().phase == RunPhase::Expired && !expiring.reset_pending() &&
              expiring.placement_serial() == expiry_serial + 1,
          "expiry allows an already accepted placement to finish");
    near(expiring.reset_fade(), 0, "accepted warp fades back in after clock expiry");
    const auto frozen = expiring.scoring().status().total();
    expiring.warp({25, 12, 100}, {0, 0, 1}, {0, 0, 12});
    const auto expired_position = expiring.rider().position;
    expiring.tick({.steer = 1, .boost = true});
    check(length(expiring.rider().position - expired_position) > .1 && expiring.board_boosting() &&
              expiring.scoring().status().total() == frozen,
          "Expired rider retains physical movement, steering and unlimited boost with a frozen result");
    check(expiring.recover_course(true), "continued riding can reset after event expiry");
    for (unsigned i = 0; i < 61; ++i)
        expiring.tick({});
    check(!expiring.reset_pending() && expiring.scoring().status().total() == frozen &&
              expiring.course_run().status().phase == RunPhase::Expired,
          "post-result reset completes without reopening or changing the score");
    std::filesystem::remove(root / "Slopesmith.json");
    Player finisher(Terrain::load(root));
    finisher.configure_run(RunMode::Race);
    for (unsigned i = 0; i < 181; ++i)
        finisher.tick({});
    const auto [finish_position, finish_forward] = *finisher.course_run().finish();
    finisher.warp(finish_position - finish_forward * .3, finish_forward, finish_forward * 12);
    finisher.tick({});
    finisher.tick({});
    check(finisher.course_run().status().phase == RunPhase::Finished,
          "Production rider crosses the actual finish plane");
    const auto final_clock = finisher.course_run().status().clock;
    const auto finished_position = finisher.rider().position;
    finisher.tick({.boost = true});
    check(length(finisher.rider().position - finished_position) > .1 && finisher.board_boosting(),
          "Finished race rider continues moving and boosting");
    near(finisher.course_run().status().clock, final_clock, "Continued race movement leaves the result clock frozen");
    const auto race_avatar = avatar_pose(finisher);
    check(race_avatar.score_text[0] == "BOOST UNLIMITED" && race_avatar.score_text[1].empty() &&
              length(race_avatar.joint(AvatarJoint::Head) - race_avatar.joint(AvatarJoint::Hips)) > .3,
          "Race HUD hides trick points while the full avatar remains posed");
    Json terrain;
    {
        std::ifstream input(root / "Patches.json");
        input >> terrain;
    }
    for (auto& point : terrain["Patches"][0]["Points"])
        point[2] = .2 * point[1].get<double>();
    std::ofstream(root / "Patches.json") << terrain;
    Json dataset;
    {
        std::ifstream input(root / "AIP.json");
        input >> dataset;
    }
    for (const auto key : {"AIPaths", "RaceLines"})
        dataset[key][0]["PathPoints"][0][2] = -4000;
    std::ofstream(root / "AIP.json") << dataset;
    Player slope(Terrain::load(root));
    slope.warp({25, -20, 100}, {0, 0, 1});
    check(slope.recover_course(true), "sloped course has a supported recovery target");
    complete(slope);
    const auto normal = normalized(Vec3{0, 1, .2});
    near(dot(slope.render_up(), normal), 1, "reset deck starts tilted to the real contact normal");
    near(dot(slope.render_forward(), normal), 0, "reset board bearing is tangent to the slope");
    near(slope.rider().position.y, -19, "drop height is measured above the actual sloped floor");
}

void local_courses(const std::filesystem::path& maps) {
    unsigned courses = 0, placements = 0;
    for (const auto& entry : std::filesystem::directory_iterator(maps)) {
        if (!entry.is_directory() || !std::filesystem::exists(entry.path() / "Patches.json"))
            continue;
        const auto paths = CoursePaths::load(entry.path());
        Player rider(Terrain::load(entry.path()));
        for (const auto mode : {RunMode::Freeride, RunMode::Showoff}) {
            rider.configure_run(mode);
            rider.start_on_foot();
            for (unsigned i = 0; i < 30; ++i)
                rider.tick({});
            check(rider.interact_board(), "Owned course mounts on its first attempt");
            unsigned fades = 0;
            bool fading = false;
            double travelled = 0;
            const auto start = rider.rider().position;
            for (unsigned i = 0; i < 600; ++i) {
                rider.tick({.posture = 1});
                fades += rider.reset_pending() && !fading;
                fading = rider.reset_pending();
                travelled = std::max(travelled, length(rider.rider().position - start));
            }
            check(fades <= 2 && travelled > 5, "Owned mounted start progresses without a repeated fade loop");
        }
        rider.configure_run(RunMode::Freeride);
        unsigned recovered = 0, supported = 0;
        for (const auto& path : paths.ai) {
            if (!path.respawnable || path.points.size() < 3)
                continue;
            const auto point = path.points[path.points.size() / 2];
            const auto& bounds = rider.terrain().bounds();
            const auto hit =
                rider.terrain().intersect({point.x, bounds.max.y + 2, point.z}, {point.x, bounds.min.y - 2, point.z});
            if (!hit || hit->surface == 0 || hit->surface == 6 || hit->surface == 10 || hit->surface == 17 ||
                hit->normal.y < .2)
                continue;
            ++supported;
            rider.restart_run();
            rider.warp(hit->point + Vec3{0, .005, 0}, {0, 0, -1});
            rider.tick({});
            rider.warp(hit->point + Vec3{8, 0, 0}, {0, 0, -1});
            if (!rider.recover_course(true))
                continue;
            complete(rider);
            const auto& pose = rider.last_course_recovery();
            if (!pose || pose->source == RecoverySource::Start)
                continue;
            check(length(project(rider.rider().position - point, {0, 1, 0})) < 160,
                  "owned-course recovery remains near sampled station");
            near(length(rider.rider().velocity), 30. / 3.6, "owned-course reset speed");
            ++recovered;
            ++placements;
            if (recovered == 6)
                break;
        }
        std::cout << entry.path().filename().string() << ": " << recovered << " recoveries from " << supported
                  << " supported candidates\n";
        check(recovered > 0, "each owned course supplies a supported mid-course recovery");
        ++courses;
    }
    check(courses == 11, "validate all eleven owned course imports");
    std::cout << "Owned course recovery: " << placements << " supported placements across " << courses << " courses\n";
}
} // namespace

int main(int argc, char** argv) {
    try {
        queries();
        windows();
        fallback();
        const auto root = std::filesystem::temp_directory_path() /
                          ("openslope-course-recovery-" +
                           std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::create_directory(root);

        struct Cleanup {
            std::filesystem::path path;

            ~Cleanup() {
                std::error_code ec;
                std::filesystem::remove_all(path, ec);
            }
        } cleanup{root};

        const auto wedge_root = root / "wedges";
        std::filesystem::create_directory(wedge_root);
        wedges(wedge_root);
        production(root);
        if (argc == 2)
            local_courses(argv[1]);
        std::cout << "PASS: " << checks
                  << " path recovery, windows, safe placement, trail/trap fallback and production checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
