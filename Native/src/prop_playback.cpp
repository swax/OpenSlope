#include "openslope/model_animation.hpp"
#include <algorithm>
#include <stdexcept>

namespace openslope {
namespace {
void duration(double value) {
    if (!std::isfinite(value) || value < 0 || value > 3600)
        throw std::invalid_argument("Invalid prop playback duration");
}
} // namespace

PropPlayback::PropPlayback(PropPlayLaw law, double clip_frames, double random_unit) : law_(law), clip_(clip_frames) {
    if (!std::isfinite(clip_) || clip_ < 0 || clip_ > 1e6 || !std::isfinite(random_unit) || random_unit < 0 ||
        random_unit > 1)
        throw std::invalid_argument("Invalid prop animation clip");
    for (const auto value :
         {law.start, law.end, law.rate, law.random_rate, law.debounce, law.combo_start, law.combo_last, law.combo_rate})
        if (!std::isfinite(value) || std::abs(value) > 1e6)
            throw std::invalid_argument("Invalid prop playback law");
    first_ = law.start < 0 ? 0 : std::clamp(law.start, 0., clip_);
    last_ = law.end < 0 ? clip_ : std::clamp(law.end, first_, clip_);
    rate_ = law.rate;
    if (law.random_rate > 0)
        rate_ += random_unit * (law.random_rate - rate_);
    rate_ = std::abs(rate_);
    phase_ = law.random_start ? random_unit * (last_ - first_) : 0;
    frame_ = law.reverse ? last_ - phase_ : first_ + phase_;
    combo_first_ = law.combo_start < 0 ? last_ : std::clamp(law.combo_start, 0., clip_);
    combo_last_ = law.combo_last < 0 ? clip_ : std::clamp(law.combo_last, combo_first_, clip_);
}

void PropPlayback::grant(double value) {
    duration(value);
    budget_ = std::min(3600., budget_ + value / 30);
}

void PropPlayback::hold(double value) {
    duration(value);
    hold_ = value;
}

void PropPlayback::seek(double frame) {
    if (!std::isfinite(frame) || frame < 0 || frame > clip_)
        throw std::invalid_argument("Invalid prop animation seek");
    frame_ = std::clamp(frame, first_, last_);
    phase_ = law_.reverse ? last_ - frame_ : frame_ - first_;
    ended_ = end_notice_ = false;
}

bool PropPlayback::trigger_combo() {
    if (law_.kind != 258 || combo_active_ || latched_ || combo_last_ <= combo_first_)
        return false;
    snapshot_ = frame_;
    combo_frame_ = combo_first_;
    combo_active_ = true;
    return true;
}

void PropPlayback::step(double seconds) {
    duration(seconds);
    if (paused_ || latched_ || seconds == 0)
        return;
    const auto waiting = std::min(hold_, seconds);
    hold_ -= waiting;
    seconds -= waiting;
    if (seconds <= 0)
        return;
    if (combo_active_) {
        combo_frame_ = std::min(combo_last_, combo_frame_ + seconds * std::abs(law_.combo_rate));
        if (combo_frame_ >= combo_last_ - 1e-9) {
            combo_active_ = false;
            if (law_.combo_end < 0) {
                combo_holding_ = true;
                latched_ = true;
            } else if (law_.combo_end > 0)
                latched_ = true;
        }
        return;
    }
    if (ended_ || last_ <= first_ || rate_ <= 0)
        return;
    auto advance = seconds * rate_;
    if (law_.kind == 257) {
        advance = std::min(advance, budget_ * 30);
        budget_ = std::max(0., budget_ - advance / 30);
    }
    if (advance <= 0)
        return;
    phase_ += advance;
    const auto length = last_ - first_;
    if (law_.loop == 1) {
        phase_ = std::fmod(phase_, length);
        frame_ = first_ + phase_;
    } else if (law_.loop == 2) {
        phase_ = std::fmod(phase_, 2 * length);
        frame_ = first_ + (phase_ <= length ? phase_ : 2 * length - phase_);
    } else {
        if (phase_ >= length - 1e-9) {
            phase_ = length;
            ended_ = true;
            end_notice_ = law_.kind != 257;
        }
        frame_ = first_ + phase_;
    }
    if (law_.reverse)
        frame_ = first_ + last_ - frame_;
}
} // namespace openslope
