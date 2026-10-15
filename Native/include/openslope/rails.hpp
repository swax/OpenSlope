#pragma once
#include "math.hpp"
#include <filesystem>
#include <optional>
#include <vector>

namespace openslope {
struct RailCurve {
    std::array<Vec3, 4> power{}; // Highest degree first, world metres.
    Vec3 point(double t) const;
    Vec3 tangent(double t) const;
};

struct RailSpline {
    int surface = 13;
    bool enabled = true;
    std::vector<RailCurve> curves;
};

std::vector<RailSpline> spline_paths(const std::filesystem::path& root);

struct RailHit {
    std::size_t spline{}, segment{};
    double parameter{}, distance{};
    Vec3 point, tangent, up, right, offset;
};

// Cubic geometry and authored candidacy are separate from the visible prop.
class Rails {
public:
    explicit Rails(std::vector<RailSpline> splines = {});
    static Rails load(const std::filesystem::path& root);
    std::optional<RailHit> nearest(Vec3 position) const;
    bool accepts(const RailHit& hit, bool entry, double blend) const;
    void enable(std::size_t spline, bool value);
    void reset();
    int surface(std::size_t spline) const;

    std::size_t splines() const { return splines_.size(); }

    std::size_t segments() const { return curves_.size(); }

private:
    struct Curve {
        RailCurve curve;
        Bounds bounds;
        std::size_t spline{}, segment{};
    };

    struct Node {
        Bounds bounds;
        std::size_t begin{}, end{};
        int left = -1, right = -1;
    };

    std::vector<RailSpline> splines_;
    std::vector<bool> initial_;
    std::vector<Curve> curves_;
    std::vector<std::size_t> order_;
    std::vector<Node> nodes_;
    int split(std::size_t begin, std::size_t end);
    void query(int node, Vec3 position, std::optional<RailHit>& closest) const;
};
} // namespace openslope
