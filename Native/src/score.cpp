#include "openslope/score.hpp"
#include <algorithm>
#include <cmath>
#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace openslope {
namespace {
constexpr double points_per_style = 6786.9;

std::int64_t style_points(double style, unsigned multiplier) {
    return std::int64_t(std::floor(style * multiplier * points_per_style / 10 + .5)) * 10;
}

void duration(double seconds) {
    if (!std::isfinite(seconds) || seconds < 0 || seconds > 3600)
        throw std::invalid_argument("Invalid scoring duration");
}
} // namespace

void TrickScore::reset() {
    status_ = {};
    motion_ = ScoreMotion::Ground;
    open_ = rail_ = grab_held_ = false;
}

void TrickScore::start() {
    reset();
    status_.active = true;
}

void TrickScore::clear_combo(bool consume_multiplier) {
    status_.preview = 0;
    status_.style = status_.airtime = status_.grind_time = 0;
    status_.spin_degrees = status_.flip_degrees = status_.grab_time = 0;
    status_.grab_hand.reset();
    open_ = rail_ = grab_held_ = false;
    motion_ = ScoreMotion::Ground;
    if (consume_multiplier)
        status_.multiplier = 1;
}

void TrickScore::preview() {
    const auto air = status_.airtime + 1e-9 >= 4 ? std::int64_t(std::floor((status_.airtime - 3) * 1000 + .5)) : 0;
    const auto tier = std::min(5., std::floor((status_.grab_time + 1e-9) / .5));
    const auto grab = tier >= 2 ? std::int64_t(tier - 1) * 4000 : 0;
    status_.preview = style_points(status_.style, status_.multiplier) + air + grab;
}

void TrickScore::step(double seconds, ScoreMotion motion, double spin, double flip) {
    accumulate(seconds, motion, spin, flip, {});
}

void TrickScore::step_off_board(double seconds, std::optional<unsigned> hand) {
    if (hand && *hand > 1)
        throw std::invalid_argument("Invalid scoring hand");
    accumulate(seconds, ScoreMotion::Air, 0, 0, hand);
}

void TrickScore::accumulate(double seconds, ScoreMotion motion, double spin, double flip,
                            std::optional<unsigned> hand) {
    duration(seconds);
    if (!std::isfinite(spin) || !std::isfinite(flip) || std::abs(spin) > 3600 || std::abs(flip) > 3600)
        throw std::invalid_argument("Invalid scoring rotation");
    if (seconds == 0)
        return;
    status_.result_age += seconds;
    if (!status_.active)
        return;
    if (motion == ScoreMotion::Ground) {
        if (open_)
            land();
        motion_ = motion;
        return;
    }
    open_ = true;
    status_.spin_degrees += std::abs(spin);
    status_.flip_degrees += std::abs(flip);
    status_.style += (std::abs(spin) + std::abs(flip)) / 1440;
    if (motion == ScoreMotion::Rail) {
        rail_ = true;
        status_.grind_time += seconds;
        status_.style += .15 * seconds;
    } else {
        if (motion_ == ScoreMotion::Air)
            status_.airtime += seconds;
    }
    if (hand) {
        if (!grab_held_)
            status_.style += .0425;
        status_.style += .045 * seconds;
        status_.grab_time += seconds;
        status_.grab_hand = hand;
    }
    grab_held_ = hand.has_value();
    motion_ = motion;
    preview();
}

void TrickScore::land() {
    if (!status_.active || !open_)
        return;
    // Ignore tiny terrain skips; preserve a collected multiplier for a real trick.
    if (!rail_ && status_.airtime < .15) {
        clear_combo(false);
        return;
    }
    preview();
    status_.banked += status_.preview;
    // The shared play profile fills from rounded, unmultiplied style points only.
    status_.meter = std::clamp(status_.meter + double(style_points(status_.style, 1)) / 10000, 0., 1.);
    const bool scored = status_.preview > 0;
    if (scored) {
        status_.result = status_.preview;
        status_.bailed = false;
        status_.loss = ScoreLoss::None;
        status_.result_age = 0;
        ++status_.resolution;
    }
    clear_combo(scored);
}

void TrickScore::lose(ScoreLoss reason, double penalty) {
    if (!std::isfinite(penalty) || penalty < 0 || penalty > 1)
        throw std::invalid_argument("Invalid score penalty");
    if (!status_.active)
        return;
    if (open_) {
        preview();
        if (status_.preview > 0) {
            status_.result = status_.preview;
            status_.bailed = true;
            status_.loss = reason;
            status_.result_age = 0;
            ++status_.resolution;
        }
    }
    status_.meter = std::clamp(status_.meter - penalty, 0., 1.);
    clear_combo(true);
}

void TrickScore::spend(double seconds, bool held) {
    duration(seconds);
    if (status_.active && held)
        status_.meter = std::max(0., status_.meter - .045 * seconds);
}

void TrickScore::multiplier(unsigned tier) {
    if (tier != 2 && tier != 3 && tier != 5)
        throw std::invalid_argument("Invalid score multiplier");
    if (status_.active) {
        status_.multiplier = std::max(status_.multiplier, tier);
        preview();
    }
}

unsigned TrickScore::meter_segments() const {
    return unsigned(std::floor(std::clamp(status_.meter, 0., 1.) * 15 + 1e-9));
}

std::int64_t TrickScore::finish() {
    if (status_.active) {
        preview();
        status_.banked += status_.preview;
        if (status_.preview > 0) {
            status_.result = status_.preview;
            status_.bailed = false;
            status_.loss = ScoreLoss::None;
            status_.result_age = 0;
            ++status_.resolution;
        }
        clear_combo(true);
        status_.active = false;
        status_.finished = true;
    }
    return status_.total();
}

TrickDisplay trick_display(const TrickScore& score) {
    const auto& s = score.status();
    if (s.preview > 0) {
        std::ostringstream detail;
        detail << std::fixed << std::setprecision(1);
        if (s.grab_hand)
            detail << (*s.grab_hand == 0 ? "LEFT" : "RIGHT") << " GRAB " << s.grab_time << "S";
        else if (s.grind_time > 0)
            detail << "GRIND " << s.grind_time << "S";
        else
            detail << std::setprecision(0) << s.spin_degrees + s.flip_degrees << "/360 X .25 X 6786.9 X "
                   << s.multiplier;
        return {TrickDisplayState::Live, s.preview, detail.str()};
    }
    if (s.resolution && s.result_age < 3) {
        const auto detail = s.loss == ScoreLoss::Crash           ? "CRASH"
                            : s.loss == ScoreLoss::Reset         ? "RESET"
                            : s.loss == ScoreLoss::BoardReleased ? "OFF BOARD"
                                                                 : "BANKED";
        return {s.bailed ? TrickDisplayState::Lost : TrickDisplayState::Banked, s.result, detail};
    }
    return {};
}

std::string score_readout(const TrickScore& score) {
    const auto& s = score.status();
    std::string text = "SCORE " + std::to_string(s.banked);
    if (s.preview)
        text += " +" + std::to_string(s.preview);
    else if (s.resolution && s.result_age < 3)
        text += s.bailed ? " LOST " + std::to_string(s.result) : " BANKED " + std::to_string(s.result);
    if (s.multiplier > 1)
        text += " X" + std::to_string(s.multiplier);
    return text;
}
} // namespace openslope
