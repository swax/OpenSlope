#include "openslope/ai.hpp"
#include <iostream>
#include <stdexcept>

namespace {
using namespace openslope;
unsigned checks = 0;

void check(bool value, const char* message) {
    ++checks;
    if (!value)
        throw std::runtime_error(message);
}

void near(double a, double b, double tolerance, const char* message) { check(std::abs(a - b) <= tolerance, message); }

CoursePath line(double from, double to, double x = 0, unsigned rating = 50) {
    CoursePath result;
    result.rating = rating;
    for (double z = from; z <= to; z += 4)
        result.points.push_back({x, -std::tan(12 * pi / 180) * z, z});
    return result;
}

Terrain slope() {
    Patch patch;
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v) {
            const auto z = -50 + 1200. * v / 3;
            patch.points[u * 4 + v] = {-100 + 200. * u / 3, -std::tan(12 * pi / 180) * z, z};
        }
    return Terrain({patch});
}

void rulers() {
    CoursePaths paths;
    auto steep = line(0, 100);
    for (auto& p : steep.points)
        p.y = p.z * 5;
    paths.ai.push_back(steep);
    AiNetwork network(paths);
    const auto p = network.project(0, {0, -200, 50});
    near(p.station, 50, 1e-8, "Projection advances below a suspended path");
    near(p.distance, 0, 1e-8, "Vertical separation never becomes tracking error");
    near(p.total, 100, 1e-8, "Path ruler measures ground distance through a steep climb");
    near(network.point(0, p.station + 8).z, 58, 1e-8, "Pursuit reaches eight ground metres ahead");
    near(network.point(0, p.station + 8).y, 290, 1e-8, "Ground arc preserves the path's authored height");
    const auto back = network.project(0, {0, 0, 1}, 8);
    check(back.segment >= 8 && back.station >= 32, "A cached tracker cannot rewind behind its segment");
    const auto bounded = network.project(0, {0, 0, 99}, 0);
    check(bounded.station <= 36, "Forward tracking has a bounded thirty-metre segment scan");
    CoursePaths long_steps;
    long_steps.ai.push_back(CoursePath{{{0, 0, 0}, {0, -20, 100}, {0, -40, 200}}});
    AiNetwork long_route(long_steps);
    const auto next_step = long_route.project(0, {0, -20.2, 101}, 0);
    check(next_step.segment == 1 && std::abs(next_step.station - 101) < 1e-8,
          "A long current segment cannot strand the tracker before the following segment");
    CoursePaths hairpin;
    hairpin.ai.push_back(CoursePath{{{0, 0, 0}, {0, 0, 10}, {0, 0, 0}, {10, 0, 20}}});
    AiNetwork turned(hairpin);
    const auto advanced = turned.project(0, {.2, 0, 10.4}, 0);
    check(advanced.segment == 2, "The first forward interior foot takes priority over an earlier clamped endpoint");

    paths.ai = {line(0, 40), line(32, 300, -6, 0), line(32, 300, 6, 100)};
    AiNetwork fork(paths);
    const auto position = line(36, 40).points[0];
    check(fork.choose(position, 100, 0)->path == 2, "Mood selects the matching rated continuation");
    check(fork.choose(position, 0, 0)->path == 1, "Changing mood changes the chosen line");
    paths.ai[2].respawnable = false;
    AiNetwork reset(paths);
    check(reset.choose(position, 100, 0)->path == 2, "Ordinary tracking may choose an unsafe-to-respawn line");
    check(reset.choose(position, 100, 0, true)->path == 1, "Recovery admits only respawnable lines");
    paths.ai.push_back(CoursePath{});
    AiNetwork empty_route(paths);
    check(!empty_route.rideable(3) && empty_route.choose(position).has_value(),
          "An unused empty route cannot prevent the rest of a network from riding");
    CoursePaths folded;
    folded.ai.push_back(CoursePath{{{0, 0, 0}, {0, 0, 100}, {0, 50, 100}, {0, 50, 0}}});
    AiNetwork stacked(folded);
    const auto upper = stacked.choose({0, 50, 50});
    check(upper && upper->segment == 2 && upper->station > 100,
          "The three-dimensional chooser selects the upper section of a folded route");
}

void inputs() {
    CoursePaths paths;
    paths.ai = {line(0, 400)};
    const auto network = std::make_shared<AiNetwork>(paths);
    Rider rider;
    rider.position = paths.ai[0].points[2];
    rider.forward = {0, -std::tan(12 * pi / 180), 1};
    rider.board_up = normalized(Vec3{0, 1, std::tan(12 * pi / 180)});
    rider.velocity = normalized(rider.forward) * 15;
    rider.grounded = true;
    rider.control = Control::Cruise;
    AiInput straight(network, 0);
    near(straight.step(rider).steer, 0, 1e-12, "A straight fall line needs no steering input");
    rider.position.x = -2;
    AiInput displaced(network, 0);
    check(displaced.step(rider).steer > 0, "Pursuit requests the actual positive-stick turn toward the line");
    for (int sign : {-1, 1}) {
        rider.position.x = 0;
        AiInput paced(network, 0);
        AiContext context;
        context.reference = AiPeer{0, rider.position + Vec3{0, 0, sign * 60.}};
        for (unsigned i = 0; i < 120; ++i)
            paced.step(rider, context);
        near(paced.status().time_scale, sign > 0 ? 1.5 : .7, 1e-8,
             "Along-course catch-up converges to the correct time-scale limit");
        context.reference->position = rider.position + Vec3{100, 0, 0};
        for (unsigned i = 0; i < 120; ++i)
            paced.step(rider, context);
        near(paced.status().time_scale, 1, 1e-8, "Lateral spacing does not create rubber-band speed");
    }
    AiInput passing(network, 0);
    std::array<AiPeer, 1> peers{{{2, rider.position + Vec3{0, 0, 3}, {0, 0, 2}}}};
    AiContext traffic;
    traffic.peers = peers;
    for (unsigned i = 0; i < 12; ++i)
        passing.step(rider, traffic);
    check(passing.status().avoiding && std::abs(passing.status().steer) > .2,
          "A faster rider carves around a rival's clearance disc");
    rider.velocity = {0, 0, 1};
    passing.step(rider, traffic);
    check(!passing.status().avoiding, "A slower rider cannot invent a passing lane");

    Rider knocked = rider;
    knocked.position = paths.ai[0].points[16];
    AiInput retained(network, 0);
    retained.step(knocked);
    const auto segment = retained.status().progress->segment;
    knocked.position = {10, -std::tan(12 * pi / 180) * 36, 36};
    retained.step(knocked);
    check(retained.status().progress->segment >= segment && retained.status().path_changes == 0,
          "choosing the same path after a shove cannot rewind the forward tracker");
    CoursePaths parallel;
    parallel.ai = {line(0, 400), line(0, 400, 1)};
    AiInput facing_back(std::make_shared<AiNetwork>(parallel), 0);
    knocked.position = {1, -std::tan(12 * pi / 180) * 64, 64};
    knocked.forward = -normalized(rider.forward);
    facing_back.step(knocked);
    check(facing_back.status().progress->path == 0,
          "facing away from a nearby target does not replace an otherwise valid path");

    paths.ai[0].events.push_back({100, 80 * 4, 80, 88});
    const auto marked = std::make_shared<AiNetwork>(paths);
    rider.position = {0, -std::tan(12 * pi / 180) * 78, 78};
    rider.forward = normalized(Vec3{0, -std::tan(12 * pi / 180), 1});
    AiInput aligned(marked, 0);
    check(!aligned.step(rider).jump, "Jump lookahead prepares the approach without charging before entry");
    rider.position = {0, -std::tan(12 * pi / 180) * 80, 80};
    check(aligned.step(rider).jump, "An aligned board starts charging when the jump event begins");
    rider.position.x = 2;
    rider.forward = normalized(project(Vec3{-2, 0, 8}, rider.board_up));
    AiInput wide(marked, 0);
    check(!wide.step(rider).jump && wide.status().steer == 0,
          "A straight approach still cannot jump more than the permitted distance off its line");
    rider.position.x = 0;
    rider.forward = rotate(normalized(Vec3{0, -std::tan(12 * pi / 180), 1}), rider.board_up, .2);
    AiInput turning(marked, 0);
    check(!turning.step(rider).jump && std::abs(turning.status().steer) > .536,
          "A rider in a strong carve cannot start an authored ollie");
    rider.position.z = 82;
    rider.position.y = -std::tan(12 * pi / 180) * 82;
    rider.forward = normalized(Vec3{0, -std::tan(12 * pi / 180), 1});
    AiInput late(marked, 0);
    check(late.step(rider).jump, "A rider placed inside a jump range sees it as already entered");
}

void jump_events() {
    CoursePaths paths;
    paths.ai = {CoursePath{{{0, 0, 0}, {0, 0, 256}}}};
    paths.ai[0].events = {{100, 72 * 4, 80, 104}, {100, 36 * 4, 78, 100}};
    Rider rider;
    rider.forward = {0, 0, 1};
    rider.grounded = true;
    rider.motion = Motion::Ground;
    rider.control = Control::Cruise;
    rider.velocity = {0, 0, 15};
    AiInput driver(std::make_shared<AiNetwork>(paths), 0);
    const auto at = [&](double station) {
        rider.position.z = station;
        return driver.step(rider);
    };
    const auto approach = at(77.5);
    check(!approach.jump && approach.boost && !at(79.75).jump,
          "The first source jump prepares its speed without charging before its start");
    check(at(80).jump && at(90).jump && at(103.49).jump, "Jump input charges from entry through the range");
    check(!at(103.5).jump, "The partial-range flag clears at the final half-metre lookahead boundary");
    rider.control = Control::Release;
    check(!at(103.75).jump, "The rider's release state cannot re-arm a phantom jump hold");
    rider.control = Control::Cruise;
    paths.ai[0].events.push_back({100, 36 * 4, 103.75, 110});
    AiInput joined(std::make_shared<AiNetwork>(paths), 0);
    rider.position.z = 80;
    check(joined.step(rider).jump, "Overlapping windows start with the first source target");
    for (double station : {100., 103.5, 104.5, 105.}) {
        rider.position.z = station;
        const auto input = joined.step(rider);
        check(input.jump && input.boost && input.posture >= 0,
              "Overlapping jump windows share the partial flag and preserve the charged target");
    }
    rider.position.z = 109.5;
    check(!joined.step(rider).jump, "The last overlapping range releases near its end");
}

void cruise_events() {
    CoursePaths paths;
    paths.ai = {CoursePath{{{0, 0, 0}, {0, 0, 300}}}};
    paths.ai[0].events = {{102, 0, 0, 300}, {101, 71, 100, 120}};
    Rider rider;
    rider.forward = {0, 0, 1};
    rider.grounded = true;
    rider.motion = Motion::Ground;
    rider.control = Control::Cruise;
    AiContext context;
    context.meter = 1;
    const auto sample = [&](double station, double kmh, double aggression = 1) {
        rider.position = {0, 0, station};
        rider.velocity = {0, 0, kmh / 3.6};
        context.aggression = aggression;
        AiInput driver(std::make_shared<AiNetwork>(paths), 0);
        return driver.step(rider, context);
    };
    check(sample(93.999, 100).boost, "No target outside the six-metre window retains default cruise controls");
    const auto ahead = sample(94, 100);
    check(ahead.posture == 0 && !ahead.boost, "An overspeed approach neither brakes early nor uses default boost");
    check(sample(100, 100).posture == -1, "The authored start boundary enables braking");
    check(sample(94, 20).posture > 0 && !sample(94, 20).boost, "An underspeed approach requests throttle alone");
    check(sample(100, 20).posture > 0 && sample(100, 20).boost, "Underspeed inside requests throttle and boost");
    check(sample(110, 72).posture == 0 && !sample(110, 72).boost, "Cruise payload uses all seventy-one km/h");
    check(sample(110, 66).posture == 0 && sample(110, 76).posture == 0,
          "The speed deadband includes its five-km/h edges");
    check(sample(110, 50, .8).posture == 0 && sample(110, 50).posture > 0,
          "Non-nominal aggression scales only the lower speed threshold");

    context.aggression = 1;
    AiInput crossed(std::make_shared<AiNetwork>(paths), 0);
    rider.position = {0, 0, 119};
    rider.velocity = {0, 0, 30};
    crossed.step(rider, context);
    rider.position.z = 121;
    check(crossed.step(rider, context).posture == -1,
          "The crossing frame retains a range through its previous station");
    rider.position.z = 122;
    const auto cleared = crossed.step(rider, context);
    check(cleared.posture > 0 && cleared.boost, "A passed range releases the target and restores default cruise");
    near(length(rider.velocity), 30, 1e-12, "AI speed events supply controls without clamping velocity");

    paths.ai[0].events = {{101, 0, 100, 120}};
    check(sample(110, 6).posture == -1 && !sample(110, 0).boost, "Zero is a valid authored target");
    paths.ai[0].events = {{101, 35, 105, 125}, {101, 100, 100, 120}};
    const auto ordered = sample(100, 72);
    check(ordered.posture == 0 && !ordered.boost, "Source order wins over station order for overlapping targets");

    paths.ai[0].events = {{101, 0, 90, 150}, {100, (95 << 2) | 3, 100, 100}};
    const auto jump = sample(100, 50);
    check(jump.jump && jump.boost && jump.posture >= 0, "Jump approach controls take priority over cruise targets");
    paths.ai[0].events = {{101, 0, 0, 300}};
    for (const auto motion : {Motion::Air, Motion::Rail}) {
        rider.motion = motion;
        rider.grounded = false;
        const auto controls = sample(100, 72);
        check(controls.posture >= 0, "Cruise events cannot apply grounded braking in air or on rails");
    }
    rider.motion = Motion::Ground;
    rider.grounded = true;
    paths.ai[0].points.back().z = 100;
    paths.ai.push_back(CoursePath{{{0, 0, 90}, {0, 0, 400}}});
    rider.position = {0, 0, 98};
    AiInput handoff(std::make_shared<AiNetwork>(paths), 0);
    const auto next = handoff.step(rider, context);
    check(handoff.status().progress->path == 1 && next.posture > 0 && next.boost,
          "A path handoff cannot carry the old path's speed target");
}

void cruise_ride() {
    const auto simulate = [](bool controlled) {
        CoursePaths paths;
        paths.ai = {line(4, 800)};
        if (controlled)
            paths.ai[0].events = {{101, 36, 60, 140}};
        AiInput driver(std::make_shared<AiNetwork>(paths), 0);
        Player player(slope());
        player.warp(paths.ai[0].points.front() + Vec3{0, 1, 0}, {0, 0, 1});
        double sum = 0;
        unsigned count = 0;
        bool braked = false, early_brake = false;
        for (unsigned frame = 0; frame < 1320; ++frame) {
            const auto input = driver.step(player.rider());
            const auto station = driver.status().progress->station;
            if (station < 60)
                early_brake = early_brake || input.posture < 0;
            else
                braked = braked || input.posture < 0;
            player.tick(input);
            if (station >= 75 && station <= 125) {
                sum += length(player.rider().velocity);
                ++count;
            }
        }
        check(count > 0 && player.rider().position.z > 150, "The production rider crosses and leaves the speed region");
        check(!controlled || (braked && !early_brake), "The production rider brakes inside the authored range only");
        return sum / count;
    };
    const auto bare = simulate(false), paced = simulate(true);
    std::cout << "Cruise region mean speed " << paced << " vs bare " << bare << " m/s\n";
    check(paced < bare - 2, "Authored cruise braking lowers actual production rider speed");
}

void ride(bool curved, bool chain) {
    CoursePaths paths;
    auto route = line(4, 800);
    if (curved)
        for (auto& p : route.points)
            p.x = 22 * std::sin(3 * pi * p.z / 600);
    paths.ai = {route};
    if (chain) {
        paths.ai[0] = line(4, 60);
        paths.ai.push_back(line(48, 800));
    }
    auto network = std::make_shared<AiNetwork>(paths);
    AiInput driver(network, 0);
    Player player(slope());
    const auto start = paths.ai[0].points.front();
    player.warp(start + Vec3{0, 1, 0}, {0, 0, 1});
    double error = 0, peak = 0, sum = 0;
    std::size_t previous_segment = 0, previous_path = 0;
    for (unsigned i = 0; i < 900; ++i) {
        const auto input = driver.step(player.rider());
        player.tick(input);
        const auto& state = driver.status();
        check(finite(player.rider().position) && finite(player.rider().velocity),
              "AI controls retain finite rider physics");
        if (state.progress) {
            if (state.progress->path == previous_path)
                check(state.progress->segment >= previous_segment, "A ridden path never re-latches behind the board");
            previous_path = state.progress->path;
            previous_segment = state.progress->segment;
            if (i > 60) {
                error = std::max(error, state.progress->distance);
                sum += state.progress->distance;
            }
        }
        peak = std::max(peak, std::abs(input.steer));
    }
    std::cout << "Ride curved " << curved << " chain " << chain << " z " << player.rider().position.z << " error "
              << error << " mean " << sum / 839 << " peak " << peak << '\n';
    check(player.rider().position.z > 150, "The same Player physics carries an AI well beyond the gate");
    check(error < (curved ? 8 : 1), "Pursuit tracks the authored route through real carving");
    check(curved ? peak > .2 : peak == 0, "Steering remains active for bends and dead for a straight route");
    if (chain)
        check(driver.status().progress->path == 1, "A gate stub hands its rider into the continuing network");
}

void marker_and_air_path() {
    for (const auto kind : {0, 1, 2}) {
        const bool marked = kind != 0;
        CoursePaths paths;
        paths.ai = {line(4, 800)};
        if (marked)
            paths.ai[0].events.push_back({100, 80 * 4, 80, kind == 2 ? 104. : 80.});
        auto network = std::make_shared<AiNetwork>(paths);
        AiInput driver(network, 0);
        Player player(slope());
        player.warp(paths.ai[0].points.front() + Vec3{0, 1, 0}, {0, 0, 1});
        double air = 0;
        bool charge = false;
        bool held = false, early_air = false, interrupted = false;
        double first_charge = 1e9, first_release = 1e9;
        unsigned releases = 0, held_samples = 0;
        for (unsigned i = 0; i < 720; ++i) {
            const auto input = driver.step(player.rider());
            const auto station = driver.status().progress->station;
            if (!held && input.jump)
                first_charge = std::min(first_charge, station);
            if (held && !input.jump) {
                first_release = std::min(first_release, station);
                ++releases;
            }
            if (station >= 81 && station < 103) {
                ++held_samples;
                interrupted = interrupted || !input.jump;
            }
            held = input.jump;
            player.tick(input);
            if (station >= 60 && station < 103.4 && !player.rider().grounded && player.rider().air_time > .05)
                early_air = true;
            charge = charge || driver.status().charging;
            if (i > 60 && !player.rider().grounded)
                air = std::max(air, player.rider().air_time);
        }
        std::cout << "Marker " << marked << " air " << air << " charges " << charge << " launches "
                  << player.rider().launches << '\n';
        check(marked ? player.rider().launches > 0 && air > .3 && charge : air < .15 && !charge,
              "Only an authored jump marker makes the AI press and release an ollie on a smooth slope");
        if (kind == 2) {
            std::cout << "Jump range charge " << first_charge << " release " << first_release << " held samples "
                      << held_samples << " interrupted " << interrupted << " early air " << early_air << '\n';
            check(first_charge >= 80 && first_charge < 81 && held_samples > 20 && !interrupted && !early_air,
                  "A continuous rider starts charging at entry and stays on snow through the range");
            check(first_release >= 103.5 && first_release < 104.5 && releases == 1 && player.rider().launches == 1,
                  "A continuous rider makes one charged launch near the event end");
        }
    }
    CoursePaths paths;
    paths.ai = {line(4, 800), line(4, 800)};
    for (auto& p : paths.ai[0].points)
        p.y += std::max(0., 80 * (1 - std::abs(p.z - 156) / 16));
    auto network = std::make_shared<AiNetwork>(paths);
    AiInput driver(network, 0);
    Player player(slope());
    player.warp(paths.ai[0].points.front() + Vec3{0, 1, 0}, {0, 0, 1});
    bool ground_route = false;
    for (unsigned i = 0; i < 1320; ++i) {
        player.tick(driver.step(player.rider()));
        ground_route = ground_route || driver.status().progress->path == 1;
    }
    std::cout << "Suspended path z " << player.rider().position.z << " rerouted " << ground_route << '\n';
    check(player.rider().position.z > 300 && ground_route,
          "A rider below an unreachable airborne line chooses a ground route and keeps riding");
}

void owned(const std::filesystem::path& maps) {
    unsigned courses = 0, cases = 0, ticks = 0;
    for (const auto& entry : std::filesystem::directory_iterator(maps)) {
        if (!entry.is_directory() || !std::filesystem::is_regular_file(entry.path() / "AIP.json"))
            continue;
        auto paths = CoursePaths::load(entry.path());
        auto network = std::make_shared<AiNetwork>(paths);
        Player rider(Terrain::load(entry.path()));
        rider.run_active(true);
        for (const auto start_index : {std::size_t(0), paths.starts.size() / 2}) {
            check(!paths.starts.empty(), "An owned course supplies start routes");
            const auto start = paths.starts[start_index];
            check(network->rideable(start), "An owned AI gate points to a rideable route");
            rider.restart_run();
            const auto position = network->point(start, 0), target = network->point(start, 8);
            rider.warp(position + Vec3{0, 1, 0}, normalized(target - position));
            AiInput driver(network, start);
            const auto initial = rider.course_run().locate(position);
            double advance = 0;
            unsigned placements = 0;
            for (unsigned frame = 0; frame < 1200; ++frame) {
                const auto serial = rider.placement_serial();
                rider.tick(driver.step(rider.rider()));
                ++ticks;
                check(finite(rider.rider().position) && finite(rider.rider().velocity),
                      "Owned autonomous riding retains finite shared physics");
                if (serial != rider.placement_serial()) {
                    ++placements;
                    driver.placed();
                }
                if (initial)
                    if (const auto progress = rider.course_run().locate(rider.rider().position))
                        advance = std::max(advance, initial->distance_to_finish - progress->distance_to_finish);
            }
            std::cout << entry.path().filename().string() << " gate " << start_index << " advance " << advance
                      << " m; handoffs " << driver.status().path_changes << "; placements " << placements << '\n';
            check(advance > 20, "An owned AI rider makes meaningful down-course progress from its gate");
            ++cases;
        }
        ++courses;
    }
    check(courses > 0, "Owned AI validation discovers course path networks");
    std::cout << "Owned AI: " << courses << " courses; " << cases << " approaches; " << ticks << " physics ticks\n";
}
} // namespace

int main(int argc, char** argv) {
    try {
        rulers();
        inputs();
        jump_events();
        cruise_events();
        cruise_ride();
        ride(false, false);
        ride(true, false);
        ride(false, true);
        marker_and_air_path();
        if (argc == 2)
            owned(argv[1]);
        std::cout << "PASS: " << checks << " AI path, control and production rider checks\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL: " << error.what() << '\n';
        return 1;
    }
}
