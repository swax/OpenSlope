#include "openslope/avatar.hpp"
#include <iostream>
#include <limits>
#include <stdexcept>

namespace {
using namespace openslope;
unsigned checks = 0;
constexpr double h = 1. / 60;

void check(bool value, const char* message) {
    ++checks;
    if (!value)
        throw std::runtime_error(message);
}

void near(double a, double b, const char* message) { check(std::abs(a - b) < 1e-8, message); }

void air(TrickScore& s, unsigned ticks, double spin = 0, double flip = 0) {
    s.step(h, ScoreMotion::Air);
    for (unsigned i = 0; i < ticks; ++i)
        s.step(h, ScoreMotion::Air, spin, flip);
}

Terrain floor() {
    Patch p;
    p.surface = 1;
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            p.points[u * 4 + v] = {double(u) * 2000 / 3 - 1000, 0, double(v) * 2000 / 3 - 1000};
    return Terrain({p});
}

void begin(Player& p) {
    p.configure_run(RunMode::Showoff);
    for (unsigned i = 0; i < 181; ++i)
        p.tick({});
    check(p.scoring().status().active, "GO starts the scorer after countdown");
}

void arithmetic() {
    TrickScore score;
    near(score.boost_amount(), 1, "freeride has unlimited held boost");
    score.start();
    near(score.status().meter, .25, "quarter bar at event start");
    check(score.meter_segments() == 3, "fifteen whole meter segments");
    air(score, 80, 4.5);
    check(score.status().preview == 1700 && score.status().banked == 0, "360 preview is 1700 and remains unbanked");
    score.land();
    check(score.status().banked == 1700 && score.status().resolution == 1, "clean land banks once");
    near(score.status().meter, .42, "base style fills 0.17");
    score.land();
    check(score.status().banked == 1700, "repeated ground contacts cannot re-bank");
    score.start();
    air(score, 80, 0, 4.5);
    score.land();
    check(score.status().banked == 1700, "full flip scores identically to full spin");
    score.start();
    score.multiplier(3);
    air(score, 20);
    score.land();
    check(score.status().banked == 0 && score.status().multiplier == 3,
          "unscored flight preserves collected multiplier for a real trick");
    air(score, 80, 4.5);
    score.land();
    check(score.status().banked == 5090 && score.status().multiplier == 1,
          "next scored trick consumes the preserved tier");
    score.start();
    score.multiplier(3);
    score.multiplier(2);
    air(score, 1, 4.5);
    score.land();
    check(score.status().banked == 0 && score.status().multiplier == 3, "tiny bump preserves strongest multiplier");
    air(score, 80, 4.5);
    score.land();
    check(score.status().banked == 5090 && score.status().multiplier == 1,
          "x3 scales style before rounding and is consumed");
    near(score.status().meter, .42, "multiplier cannot multiply boost fill");
    score.start();
    air(score, 241);
    check(score.status().preview == 1017, "four-second threshold opens flat big-air points");
    score.land();
    check(score.status().banked == 1017, "big air banks without a spin");
    near(score.status().meter, .25, "flat big-air points add no boost");
    score.start();
    for (unsigned i = 0; i < 60; ++i)
        score.step(h, ScoreMotion::Rail);
    check(score.status().preview == 1020 && score.status().banked == 0, "one-second rail accrues 0.15 live style");
    score.step(h, ScoreMotion::Ground);
    check(score.status().banked == 1020, "rail onto snow banks once");
    score.start();
    air(score, 80, 4.5);
    score.land();
    score.multiplier(5);
    air(score, 40, 4.5);
    check(score.status().preview == 4240, "next combo has a separate multiplied preview");
    score.lose(ScoreLoss::Crash, .1);
    check(score.status().banked == 1700 && score.status().preview == 0 && score.status().result == 4240 &&
              score.status().bailed,
          "crash loses only pending points");
    near(score.status().meter, .32, "crash removes 0.1");
    score.start();
    score.spend(1, false);
    near(score.status().meter, .25, "release preserves meter");
    score.spend(1, true);
    near(score.status().meter, .205, "held boost drains 0.045 per second");
    score.spend(100, true);
    near(score.boost_amount(), 0, "empty event meter gates boost");
    score.finish();
    near(score.boost_amount(), 1, "ending event restores unrestricted boost");
    score.start();
    air(score, 40, 4.5);
    check(score.finish() == 850, "finish includes live preview");
    score.step(1, ScoreMotion::Ground);
    score.lose(ScoreLoss::Reset, .12);
    score.spend(1, true);
    score.multiplier(5);
    check(score.status().total() == 850 && score.status().finished, "finished result freezes across later input");
    score.start();
    air(score, 80, 4.5);
    score.land();
    air(score, 20);
    score.lose(ScoreLoss::Reset, .12);
    check(score.status().result == 1700 && score.status().resolution == 1 && !score.status().bailed &&
              score.status().loss == ScoreLoss::None,
          "zero-style reset preserves the last banked result");
    near(score.status().meter, .3, "zero-style reset still spends its meter penalty");
    air(score, 20);
    score.land();
    check(score.status().result == 1700 && score.status().resolution == 1,
          "zero-style landing does not replace the result with BANKED zero");
    score.finish();
    check(score.status().result == 1700 && !score.status().bailed && score.status().resolution == 1,
          "finish without live points preserves the last result");
    score.start();
    air(score, 40, 4.5);
    score.lose(ScoreLoss::Crash, .1);
    air(score, 20);
    score.land();
    score.finish();
    check(score.status().result == 850 && score.status().bailed && score.status().loss == ScoreLoss::Crash &&
              score.status().resolution == 1,
          "zero-point landing and finish retain a real lost trick");
    score.start();
    air(score, 20, 4.5);
    score.lose(ScoreLoss::Crash);
    air(score, 40, 4.5);
    score.finish();
    check(score.status().result == 850 && !score.status().bailed && score.status().loss == ScoreLoss::None &&
              score.status().resolution == 2,
          "finishing a live trick replaces the previous lost result");
    score.start();
    air(score, 80, 4.5, 4.5);
    score.land();
    check(score.status().banked == 3390, "spin and flip terms add before rounding");
    score.start();
    check(score.status().total() == 0 && !score.status().finished && score.status().resolution == 0,
          "new run clears score/result");
    near(score.status().meter, .25, "new run restores energy");
    bool bad = false;
    try {
        score.step(h, ScoreMotion::Air, std::numeric_limits<double>::quiet_NaN());
    } catch (const std::invalid_argument&) {
        bad = true;
    }
    check(bad, "reject nonfinite rotation");
    bad = false;
    try {
        score.spend(-1, true);
    } catch (const std::invalid_argument&) {
        bad = true;
    }
    check(bad, "reject negative duration");
    bad = false;
    try {
        score.multiplier(4);
    } catch (const std::invalid_argument&) {
        bad = true;
    }
    check(bad, "reject unsupported multiplier");
}

void production() {
    Player player(floor(), {.knockdowns = true});
    player.configure_run(RunMode::Showoff);
    for (unsigned i = 0; i < 170; ++i)
        player.tick({});
    check(!player.scoring().status().active, "countdown cannot earn score");
    for (unsigned i = 0; i < 11; ++i)
        player.tick({});
    player.warp({0, 20, 0}, {0, 0, -1}, {0, 0, -12});
    for (unsigned i = 0; i < 80; ++i)
        player.tick({0, false, false, false, 1});
    near(player.rider().flip_degrees, 360, "production air control completes a flip");
    check(player.scoring().status().preview == 1700, "real player ticks feed scorer");
    for (unsigned i = 0; i < 150 && !player.rider().grounded; ++i)
        player.tick({});
    check(player.rider().grounded && !player.recovering() && player.scoring().status().banked == 1700,
          "real analytic touchdown banks a clean full flip");
    near(player.scoring().status().meter, .42, "production landing fills meter once");
    const auto pose = avatar_pose(player);
    check(pose.score_text[0] == "SCORE 1700" && pose.score_text[1] == "BANKED 1700" &&
              pose.score_text[2] == "BOOST 6/15" && pose.score_result == 1,
          "VR score and meter derive from shared result");
    player.advance(0, {0, false, true});
    check(player.scoring().status().banked == 1700, "manual reset keeps banked points");
    near(player.scoring().status().meter, .3, "manual reset costs 0.12");
    player.advance(0, {0, false, true});
    near(player.scoring().status().meter, .3, "held reset does not repeatedly spend");
    player.advance(0, {});
    player.warp({0, 20, 0}, {0, 0, -1}, {0, 0, -12});
    for (unsigned i = 0; i < 20; ++i)
        player.tick({0, false, false, false, 1});
    for (unsigned i = 0; i < 150 && !player.recovering(); ++i)
        player.tick({});
    check(player.recovering() && player.scoring().status().banked == 1700 && player.scoring().status().bailed,
          "sloppy production touchdown wipes preview only");
    near(player.scoring().status().meter, .2, "landing crash costs 0.1");
    player.restart_run();
    check(player.scoring().status().total() == 0 && !player.scoring().status().active,
          "run restart clears score and waits for GO");
    Player empty(floor()), released(floor());
    begin(empty);
    begin(released);
    empty.scoring().spend(100, true);
    released.scoring().spend(100, true);
    empty.warp({0, -.005, 0}, {0, 0, -1}, {0, 0, -12});
    released.warp({0, -.005, 0}, {0, 0, -1}, {0, 0, -12});
    empty.tick({0, true});
    released.tick({});
    near(length(empty.rider().velocity - released.rider().velocity), 0, "empty held boost has no physics effect");
    Player free(floor());
    free.warp({0, -.005, 0}, {0, 0, -1}, {0, 0, -12});
    free.tick({0, true});
    check(length(free.rider().velocity) > length(empty.rider().velocity), "freeride held boost remains available");
    Player walker(floor());
    begin(walker);
    walker.start_on_foot();
    for (unsigned i = 0; i < 60; ++i)
        walker.tick({0, true, false, false, 1});
    near(walker.scoring().status().meter, .25, "on-foot run input spends no board boost");
    check(walker.scoring().status().total() == 0, "walking cannot score riding tricks");
    Player tier(floor());
    begin(tier);
    tier.warp({0, -.005, 0}, {0, 0, -1}, {0, 0, -12});
    tier.tick({0, true});
    near(tier.rider().speed_cap, tier.contract().value("speed", "defaultCap"), "low meter retains default cap");
    air(tier.scoring(), 80, 4.5);
    tier.scoring().land();
    tier.tick({0, true});
    near(tier.rider().speed_cap, 30.6768, "middle meter selects weak raised cap");
    air(tier.scoring(), 240, 4.5);
    tier.scoring().land();
    tier.tick({0, true});
    near(tier.rider().speed_cap, 33.472, "high meter selects strong raised cap");
}

void held_grabs() {
    for (const auto hand : {0u, 1u}) {
        TrickScore score;
        score.start();
        score.step(h, ScoreMotion::Air);
        score.step_off_board(1, hand);
        check(score.status().preview == 4590 && score.status().grab_hand == hand,
              "One held second combines 590 style points and the flat 4000-point tier");
        const auto display = trick_display(score);
        check(display.state == TrickDisplayState::Live && display.points == 4590 &&
                  display.detail == (hand ? "RIGHT GRAB 1.0S" : "LEFT GRAB 1.0S"),
              "Live grab itemizes the holding hand and accumulated duration");
        score.step(h, ScoreMotion::Air);
        score.land();
        check(score.status().banked == 4590 && !score.status().grab_hand,
              "Remount and clean landing bank the grab once and clear its label");
        near(score.status().meter, .309, "Only the 590 base-style points fill boost");
        check(trick_display(score).state == TrickDisplayState::Banked, "Grab landing holds a green result");
        score.step(3, ScoreMotion::Ground);
        check(trick_display(score).state == TrickDisplayState::None, "Landed feedback expires after three seconds");
    }
    for (const auto [seconds, points] : std::array<std::pair<double, std::int64_t>, 6>{
             {{.5, 440}, {1, 4590}, {1.5, 8750}, {2, 12900}, {2.5, 17050}, {3, 17200}}}) {
        TrickScore score;
        score.start();
        score.step(h, ScoreMotion::Air);
        for (unsigned i = 0; i < unsigned(std::round(seconds / h)); ++i)
            score.step_off_board(h, 0);
        check(score.status().preview == points, "Fixed ticks cross each half-second grab tier and cap the flat bonus");
    }
    TrickScore score;
    score.start();
    score.step(h, ScoreMotion::Air);
    score.multiplier(5);
    score.step_off_board(1, 0);
    check(score.status().preview == 6970, "Gem scales grab style but never the flat ladder");
    score.land();
    near(score.status().meter, .309, "Gem leaves grab boost fill unchanged");
    score.start();
    score.step(h, ScoreMotion::Air);
    score.step_off_board(.4, 0);
    score.step_off_board(.6, 1);
    near(score.status().style, .0875, "Passing between hands does not recognize the same held trick twice");
    score.step_off_board(.5, {});
    near(score.status().grab_time, 1, "A throw pauses the hold timer");
    score.step_off_board(.1, 0);
    near(score.status().style, .1345, "A fresh catch earns one recognition bump and resumes held style");
    near(score.status().grab_time, 1.1, "Recatch resumes the existing hold ladder");
    score.lose(ScoreLoss::BoardReleased);
    check(score.status().banked == 0 && score.status().bailed && !score.status().grab_hand,
          "Landing without the board loses pending grab points");
    score.start();
    score.step(h, ScoreMotion::Air);
    score.step_off_board(1, 0);
    score.step_off_board(3, {});
    check(score.status().preview == 5590, "Big-air bonus remains separate from the held-board ladder");
    score.finish();
    score.step_off_board(3, 1);
    check(score.status().banked == 5590 && trick_display(score).state == TrickDisplayState::None,
          "Finished grab result freezes while transient feedback still ages out");
    score.start();
    score.step(1, ScoreMotion::Rail, 360);
    check(score.status().preview == 2710, "Rail turns and linear grind style combine before rounding");
    check(trick_display(score).detail == "GRIND 1.0S", "Live grind itemizes its held time");
    score.start();
    air(score, 80, 4.5);
    check(trick_display(score).detail == "360/360 X .25 X 6786.9 X 1", "Air trick exposes the four-factor equation");
    bool rejected = false;
    try {
        score.step_off_board(h, 2);
    } catch (const std::invalid_argument&) {
        rejected = true;
    }
    check(rejected, "Invalid grab hand cannot enter scoring state");
}

void production_grabs() {
    for (const auto tracked : {false, true}) {
        Player player(floor());
        begin(player);
        player.warp({0, 20, 0}, {0, 0, -1}, {0, 0, -8});
        for (unsigned i = 0; i < 20; ++i)
            player.tick({.steer = 1});
        const auto style = player.scoring().status().style;
        const auto serial = player.placement_serial(), run_serial = player.run_serial();
        RideInput grab;
        grab.equipment.tracked = tracked;
        grab.equipment.relative = true;
        grab.equipment.head = {0, 1.65, 0};
        for (auto& hand : grab.equipment.hands)
            hand = {{0, 1.1, 0}, {1, 0, 0}, {0, 1, 0}, {0, 0, -1}, true};
        grab.equipment.grip[1] = true;
        for (unsigned i = 0; i < 60; ++i)
            player.tick(grab);
        check(player.on_foot() && player.carrying_board() && player.scoring().status().active,
              "Desktop/VR airborne grip keeps the scored run active");
        check(player.placement_serial() == serial && player.run_serial() == run_serial,
              "Air grab preserves continuous course progress and run identity");
        near(player.scoring().status().style, style + .0875,
             "Production grab preserves rotation style and accrues hold style");
        near(player.scoring().status().grab_time, 1, "Production grip records exactly sixty held ticks");
        const auto preview = player.scoring().status().preview;
        const auto avatar = avatar_pose(player);
        check(avatar.score_text[1] == "TRICK +" + std::to_string(preview) && avatar.score_text[3] == "RIGHT GRAB 1.0S",
              "Controller HUD follows the live carried-board score");
        grab.equipment.trigger[1] = true;
        player.tick(grab);
        check(!player.on_foot() && !player.carrying_board() && player.scoring().status().preview == preview,
              "Air re-equip preserves pending rotation and grab points");
        for (unsigned i = 0; i < 180 && !player.rider().grounded; ++i)
            player.tick({});
        check(player.rider().grounded && player.scoring().status().banked == preview,
              "Production landing banks the remounted grab without a placement loss");
    }
    Player unfinished(floor());
    begin(unfinished);
    unfinished.warp({0, 20, 0}, {0, 0, -1}, {0, 0, -12});
    for (unsigned i = 0; i < 20; ++i)
        unfinished.tick({.posture = 1});
    for (unsigned i = 0; i < 180 && !unfinished.rider().grounded; ++i)
        unfinished.tick({});
    check(unfinished.rider().grounded && !unfinished.recovering() && unfinished.rider().motion != Motion::Wipeout &&
              unfinished.scoring().status().banked == 0 && unfinished.scoring().status().bailed,
          "Default unfinished landing loses the combo without forcing a knockdown");
    near(unfinished.scoring().status().meter, .15,
         "Scoring loss retains the crash meter cost without a physical wipeout");
}
} // namespace

int main() {
    try {
        arithmetic();
        held_grabs();
        production();
        production_grabs();
        Player dismount(floor());
        begin(dismount);
        dismount.scoring().spend(100, true);
        check(dismount.interact_board() && dismount.on_foot(), "Leave a running scored event");
        check(!dismount.scoring().status().active && dismount.scoring().status().total() == 0 &&
                  dismount.course_run().status().mode == RunMode::Freeride,
              "Dismount clears event scoring and returns to free riding");
        check(dismount.interact_board(), "Remount the parked board");
        for (unsigned i = 0; i < 120; ++i)
            dismount.tick({.boost = true});
        near(dismount.scoring().boost_amount(), 1, "Remount retains unlimited boost instead of restarting scoring");
        dismount.restart_run();
        check(dismount.course_run().status().mode == RunMode::Showoff &&
                  dismount.course_run().status().phase == RunPhase::Ready,
              "Explicit Restart restores the selected event after free riding");
        std::cout << "PASS: " << checks
                  << " trick, bank, crash/reset, meter, run lifecycle and production player checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
