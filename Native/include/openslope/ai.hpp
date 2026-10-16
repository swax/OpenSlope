#pragma once
#include "player.hpp"
#include <memory>
#include <span>

namespace openslope {
struct AiProjection {
    std::size_t path = 0, segment = 0;
    double station = 0, distance = 0, total = 0;
    Vec3 point{}, forward{0, 0, -1};
};

// Immutable course rulers are shared by every input source in a field.
class AiNetwork {
public:
    explicit AiNetwork(CoursePaths paths);

    const CoursePaths& paths() const { return paths_; }

    bool rideable(std::size_t path) const;
    AiProjection project(std::size_t path, Vec3 position, std::optional<std::size_t> segment = {}) const;
    Vec3 point(std::size_t path, double station) const;
    std::optional<AiProjection> choose(Vec3 position, double mood = 50, std::optional<std::size_t> exclude = {},
                                       bool respawnable = false) const;

private:
    struct Line {
        Bounds bounds;
        std::vector<double> arc;
    };

    CoursePaths paths_;
    std::vector<Line> lines_;
};

struct AiPeer {
    std::uint64_t id = 0;
    Vec3 position{}, velocity{};
};

struct AiContext {
    std::uint64_t id = 1;
    double meter = .25;
    unsigned place = 1;
    std::optional<AiPeer> reference;
    std::span<const AiPeer> peers;
};

struct AiStatus {
    std::optional<AiProjection> progress;
    Vec3 target{};
    double steer = 0, time_scale = 1, mood = 50;
    std::optional<std::uint64_t> rival;
    bool charging = false, avoiding = false;
    unsigned path_changes = 0;
};

// An AI only supplies ordinary controls; Player remains the sole integrator.
class AiInput {
public:
    explicit AiInput(std::shared_ptr<const AiNetwork> network, std::optional<std::size_t> start = {});
    RideInput step(const Rider& rider, const AiContext& context = {}, double seconds = 1. / 60);
    void placed(std::optional<std::size_t> path = {});

    const AiStatus& status() const { return status_; }

private:
    std::shared_ptr<const AiNetwork> network_;
    AiStatus status_;
    std::optional<std::size_t> path_, segment_;
    double reselect_ = 0, last_station_ = 0;
    std::uint64_t ticks_ = 0;
    bool charge_ = false;
};
} // namespace openslope
