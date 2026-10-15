#pragma once
#include "model_animation.hpp"
#include "rails.hpp"

namespace openslope {
struct RouteSample {
    Vec3 position, tangent;
    std::size_t segment = 0;
    double parameter = 0;
};

class PropRoute {
public:
    explicit PropRoute(std::vector<RailCurve> curves = {});

    double length() const { return length_; }

    RouteSample sample(double distance) const;

    const std::vector<RailCurve>& curves() const { return curves_; }

private:
    std::vector<RailCurve> curves_;
    std::vector<std::array<double, 65>> arc_;
    std::vector<double> starts_;
    double length_ = 0;
};

struct RouteLaw {
    int end_mode = 1, orientation = 0;
    unsigned copies = 1;
    double speed = 0, yaw = 0;
    bool line = false;
    std::array<float, 4> colour{};
};

class RoutePlayback {
public:
    RoutePlayback(RouteLaw law = {}, double length = 0);
    void step(double seconds);

    double distance() const { return distance_; }

    double direction() const { return direction_; }

    bool retired() const { return retired_; }

    bool finished() const { return finished_; }

    const RouteLaw& law() const { return law_; }

    std::vector<double> distances() const;

private:
    RouteLaw law_;
    double length_ = 0, distance_ = 0, speed_ = 0, direction_ = 1;
    bool finished_ = false, retired_ = false;
};

Transform route_pose(const RouteSample& sample, int orientation, double yaw, double direction);

struct RouteLine {
    std::array<Vec3, 11> points;
    std::array<float, 4> colour;
};

// Detached drawing poses do not rewrite the authored host or its collision pose.
struct PropRouteMotion {
    std::size_t instance = 0;
    std::vector<Transform> previous, current;
    std::vector<RouteLine> lines;
};
} // namespace openslope
