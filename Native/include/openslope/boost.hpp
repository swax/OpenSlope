#pragma once
#include "terrain.hpp"
#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <span>

namespace openslope {
struct BoostLaw {
    int kind = 7, mode = 1;
    double seconds = 0, rate = 0, target = 0, height = 0, tolerance = 0;
    Vec3 direction{};
    std::array<Vec3, 3> stage_direction{};
    std::array<double, 3> stage_speed{};
    bool operator==(const BoostLaw& other) const;
};

struct BoostVolume {
    Bounds box;
    Vec3 axis{1, 0, 0};
};

struct BoostRider {
    std::uint64_t id = 0;
    Vec3 previous, position, velocity;
    bool active = true;
    unsigned stage = 0;
    bool snapped = false, driven = false;
    std::span<const ProbeSphere> previous_probes{}, probes{};
};

using LapEntry = std::function<std::optional<unsigned>(std::uint64_t)>;

class ScriptedBoost {
public:
    explicit ScriptedBoost(BoostLaw law);

    const BoostLaw& law() const { return law_; }

    void activate();
    void contact(std::uint64_t rider = 0);
    void apply(double seconds, std::span<BoostRider> riders, std::span<const std::optional<BoostVolume>> volumes,
               const LapEntry& lap_entry = {});

    bool expired() const { return expired_; }

    bool occupied() const { return occupied_; }

private:
    struct Latch {
        bool inside = false, allowed = true;
        Vec3 direction{};
        double target = 0;
    };

    BoostLaw law_;
    double remaining_ = 0;
    bool expired_ = false, occupied_ = false;
    std::map<std::uint64_t, Latch> riders_;
};

Vec3 boost_velocity(Vec3 velocity, Vec3 direction, double target, double rate, double seconds);
Vec3 air_boost_velocity(Vec3 velocity, Vec3 nose, double cap, double seconds);

struct PadBoost {
    double speed = 0, trick = 0;
    void tick(double seconds);
    void request(bool trick_pad, double seconds);
};
} // namespace openslope
