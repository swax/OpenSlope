#include "openslope/texture_playback.hpp"
#include <algorithm>
#include <stdexcept>

namespace openslope {
namespace {
void duration(double value) {
    if (!std::isfinite(value) || value < 0 || value > 1e6)
        throw std::invalid_argument("Invalid texture duration");
}

void scalar(double value) {
    if (!std::isfinite(value) || std::abs(value) > 1e6)
        throw std::invalid_argument("Invalid texture rate or phase");
}

void tick_time(double seconds) {
    if (!std::isfinite(seconds) || seconds < 0 || seconds > 1)
        throw std::invalid_argument("Invalid texture tick");
}

double wrap(double value) { return std::fmod(value, 1.); }
} // namespace

ScrollPlayback::ScrollPlayback(ScrollLaw law) : law_(law) {
    scalar(law.u);
    scalar(law.v);
    duration(law.active);
    duration(law.pause);
    duration(law.lifetime);
}

void ScrollPlayback::control(unsigned command, double value) {
    scalar(value);
    if (command == 1)
        law_.u = value;
    else if (command == 2)
        law_.v = value;
    else if (command == 3)
        law_.active = std::max(0., value);
    else if (command == 4)
        law_.pause = std::max(0., value);
    else if (command == 5 || command == 6)
        offset_[command - 5] = wrap(value);
}

void ScrollPlayback::step(double seconds) {
    tick_time(seconds);
    if (expired_)
        return;
    pending_ += seconds;
    while (pending_ >= 1. / 60 - 1e-9) {
        pending_ = std::max(0., pending_ - 1. / 60);
        age_ += 1. / 60;
        if (law_.lifetime > 0 && age_ >= law_.lifetime - 1e-9) {
            expired_ = true;
            break;
        }
        time_ += 1. / 60;
        if (!active_) {
            if (time_ >= law_.pause - 1e-9) {
                active_ = true;
                time_ = 0;
            }
            continue;
        }
        if (law_.active > 0 && time_ >= law_.active - 1e-9) {
            time_ = 0;
            active_ = law_.pause <= 0;
            if (law_.mode == 1 || law_.mode == 2) {
                direction_ = -direction_;
                continue;
            }
            if (!active_)
                continue;
        }
        const auto envelope =
            law_.mode == 1 ? (law_.active > 0 ? std::max(0., .5 - std::abs(.5 - time_ / law_.active)) : 0.) : 1.;
        offset_[0] = wrap(offset_[0] + law_.u * direction_ * envelope);
        offset_[1] = wrap(offset_[1] + law_.v * direction_ * envelope);
    }
}

TexturePlayback::TexturePlayback(FlipLaw law, std::span<const FlipMaterial> materials, std::uint32_t seed)
    : law_(law), random_(seed) {
    scalar(law.speed);
    duration(law.length);
    if (law.speed < 0 || materials.size() > 65535)
        throw std::invalid_argument("Invalid texture flip law");
    for (const auto& material : materials) {
        if (material.count > 4096)
            throw std::invalid_argument("Texture bank exceeds limit");
        if (!material.count)
            continue;
        counts_.push_back(material.count);
        frames_.push_back({material.material, 0});
    }
    increment_ = law.speed / 60;
    if (!law.dwell)
        for (std::size_t i = 0; i < frames_.size(); ++i)
            frames_[i].frame = law.start < 0 ? std::uniform_int_distribution<unsigned>(0, counts_[i] - 1)(random_)
                                             : std::min(unsigned(law.start), counts_[i] - 1);
}

void TexturePlayback::select(double value) {
    for (std::size_t i = 0; i < frames_.size(); ++i)
        frames_[i].frame = unsigned(std::clamp(std::trunc(value), 0., double(counts_[i] - 1)));
}

void TexturePlayback::advance() {
    for (std::size_t i = 0; i < frames_.size(); ++i) {
        auto& frame = frames_[i].frame;
        const auto count = counts_[i];
        frame = !law_.dwell && law_.start == -2
                    ? std::uniform_int_distribution<unsigned>(0, count - 1)(random_)
                    : (frame + ((!law_.dwell && law_.direction != 0) ? count - 1 : 1)) % count;
    }
}

void TexturePlayback::control(unsigned command, double value) {
    scalar(value);
    if (command == 1) {
        law_.speed = std::max(0., value);
        increment_ = law_.dwell && flash_ ? 1. / 6 : law_.speed / 60;
    } else if (command == 2)
        select(value);
    else if (command == 3)
        advance();
    else if (command == 4)
        enabled_ = value != 0;
}

void TexturePlayback::step(double seconds) {
    tick_time(seconds);
    if (expired_)
        return;
    pending_ += seconds;
    while (pending_ >= 1. / 60 - 1e-9) {
        pending_ = std::max(0., pending_ - 1. / 60);
        age_ += 1. / 60;
        if (law_.length > 0 && age_ >= law_.length - 1e-9) {
            expired_ = true;
            break;
        }
        if (!enabled_)
            continue;
        phase_ += increment_;
        if (phase_ >= 1 - 1e-9) {
            phase_ -= 1;
            advance();
            if (law_.dwell) {
                flash_ = !flash_;
                increment_ =
                    flash_ ? 1. / 6 : law_.speed / 60 * (.25 + .75 * std::generate_canonical<double, 32>(random_));
            }
        }
    }
}
} // namespace openslope
