#pragma once
#include "world_properties.hpp"
#include <random>
#include <span>

namespace openslope {
struct ScrollLaw {
    int mode = 0;
    double u = 0, v = 0, active = 1, pause = 0, lifetime = 0;
};

class ScrollPlayback {
public:
    explicit ScrollPlayback(ScrollLaw law);
    void step(double seconds);
    void control(unsigned command, double value);

    std::array<double, 2> offset() const { return offset_; }

    bool expired() const { return expired_; }

    bool active() const { return active_; }

    int direction() const { return direction_; }

private:
    ScrollLaw law_;
    std::array<double, 2> offset_{};
    double pending_ = 0, time_ = 0, age_ = 0;
    int direction_ = 1;
    bool active_ = true, expired_ = false;
};

struct FlipLaw {
    int start = 0, direction = 0;
    double speed = 0, length = 0;
    bool dwell = false;
};

struct FlipMaterial {
    std::size_t material = 0;
    unsigned count = 0;
};

class TexturePlayback {
public:
    TexturePlayback(FlipLaw law, std::span<const FlipMaterial> materials, std::uint32_t seed);
    void step(double seconds);
    void control(unsigned command, double value);

    bool expired() const { return expired_; }

    const std::vector<PropMaterialFrame>& frames() const { return frames_; }

private:
    void select(double value);
    void advance();
    FlipLaw law_;
    std::vector<unsigned> counts_;
    std::vector<PropMaterialFrame> frames_;
    std::mt19937 random_;
    double pending_ = 0, age_ = 0, phase_ = 0, increment_ = 0;
    bool flash_ = false, enabled_ = true, expired_ = false;
};
} // namespace openslope
