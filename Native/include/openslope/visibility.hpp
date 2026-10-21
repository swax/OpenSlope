#pragma once
#include "math.hpp"
#include <span>
#include <vector>

namespace openslope {
inline constexpr double terrain_draw_distance = 600;

// A camera-centred sphere. Crossing bounds stay admitted, including large
// patches whose centre is distant but whose nearest edge is still in range.
class ViewRange {
public:
    ViewRange(Vec3 eye, double distance);
    int classify(const Bounds& bounds) const;

private:
    Vec3 eye_;
    double distance_;
};

// Column-major world-to-clip matrix, Vulkan depth interval [0,w].
class Frustum {
public:
    explicit Frustum(std::span<const float, 16> matrix);
    int classify(const Bounds& bounds) const; // -1 outside, 0 crossing, 1 inside
private:
    std::array<std::array<double, 4>, 6> planes_{};
};

class VisibilityTree {
public:
    void build(std::span<const Bounds> boxes);
    // Returned IDs retain source order, independently for each eye/camera.
    void query(const Frustum& frustum, std::vector<std::size_t>& visible, std::size_t& tested,
               const ViewRange* range = nullptr) const;
    void query(const ViewRange& range, std::vector<std::size_t>& visible, std::size_t& tested) const;

private:
    struct Node {
        Bounds bounds;
        std::size_t begin{}, end{};
        int left = -1, right = -1;
    };

    std::vector<Node> nodes_;
    std::vector<std::size_t> order_;
    std::vector<Bounds> boxes_;
    int split(std::size_t begin, std::size_t end);
    void visit(int node, const Frustum* frustum, const ViewRange* range, bool inside, std::vector<std::size_t>& visible,
               std::size_t& tested) const;
};
} // namespace openslope
