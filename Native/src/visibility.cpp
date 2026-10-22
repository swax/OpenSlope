#include "openslope/visibility.hpp"
#include <numeric>
#include <stdexcept>

namespace openslope {
ViewRange::ViewRange(Vec3 eye, double distance) : eye_(eye), distance_(distance) {
    if (!finite(eye) || !std::isfinite(distance) || distance <= 0)
        throw std::invalid_argument("Invalid visibility range");
}

int ViewRange::classify(const Bounds& bounds) const {
    const Vec3 nearest{std::clamp(eye_.x, bounds.min.x, bounds.max.x), std::clamp(eye_.y, bounds.min.y, bounds.max.y),
                       std::clamp(eye_.z, bounds.min.z, bounds.max.z)};
    const auto centre = bounds.center(), extent = (bounds.max - bounds.min) * .5;
    const auto delta = centre - eye_;
    const Vec3 farthest{std::abs(delta.x) + extent.x, std::abs(delta.y) + extent.y, std::abs(delta.z) + extent.z};
    const auto epsilon = 32 * std::numeric_limits<float>::epsilon() *
                         (std::abs(eye_.x) + std::abs(eye_.y) + std::abs(eye_.z) + std::abs(centre.x) +
                          std::abs(centre.y) + std::abs(centre.z) + extent.x + extent.y + extent.z + distance_ + 1);
    const auto outer = distance_ + epsilon, inner = std::max(0., distance_ - epsilon);
    if (dot(nearest - eye_, nearest - eye_) > outer * outer)
        return -1;
    return dot(farthest, farthest) < inner * inner ? 1 : 0;
}

Frustum::Frustum(std::span<const float, 16> matrix) {
    for (const auto value : matrix)
        if (!std::isfinite(value))
            throw std::runtime_error("Invalid visibility matrix");
    for (unsigned c = 0; c < 4; ++c) {
        const auto w = double(matrix[c * 4 + 3]);
        planes_[0][c] = w + matrix[c * 4];
        planes_[1][c] = w - matrix[c * 4];
        planes_[2][c] = w + matrix[c * 4 + 1];
        planes_[3][c] = w - matrix[c * 4 + 1];
        planes_[4][c] = matrix[c * 4 + 2];
        planes_[5][c] = w - matrix[c * 4 + 2];
    }
}

int Frustum::classify(const Bounds& bounds) const {
    const auto center = bounds.center(), extent = (bounds.max - bounds.min) * .5;
    bool inside = true;
    for (const auto& p : planes_) {
        const auto x = p[0] * center.x, y = p[1] * center.y, z = p[2] * center.z;
        const auto radius = std::abs(p[0]) * extent.x + std::abs(p[1]) * extent.y + std::abs(p[2]) * extent.z;
        const auto distance = x + y + z + p[3];
        // Include float vertex/transform rounding at clip boundaries. False
        // positives cost work; false negatives would remove visible geometry.
        const auto epsilon = 32 * std::numeric_limits<float>::epsilon() *
                             (std::abs(x) + std::abs(y) + std::abs(z) + std::abs(p[3]) + radius + 1);
        if (distance + radius < -epsilon)
            return -1;
        if (distance - radius < epsilon)
            inside = false;
    }
    return inside ? 1 : 0;
}

void VisibilityTree::build(std::span<const Bounds> boxes) {
    if (boxes.size() > 100000)
        throw std::runtime_error("Visibility hierarchy exceeds its patch limit");
    for (const auto& b : boxes)
        if (!finite(b.min) || !finite(b.max) || b.min.x > b.max.x || b.min.y > b.max.y || b.min.z > b.max.z)
            throw std::runtime_error("Invalid visibility bounds");
    boxes_ = {boxes.begin(), boxes.end()};
    order_.resize(boxes.size());
    std::iota(order_.begin(), order_.end(), 0);
    nodes_.clear();
    if (!boxes.empty())
        split(0, boxes.size());
}

int VisibilityTree::split(std::size_t begin, std::size_t end) {
    const auto id = int(nodes_.size());
    nodes_.push_back({});
    Bounds bounds;
    for (auto i = begin; i < end; ++i) {
        bounds.add(boxes_[order_[i]].min);
        bounds.add(boxes_[order_[i]].max);
    }
    nodes_[id] = {bounds, begin, end};
    if (end - begin > 8) {
        const auto extent = bounds.max - bounds.min;
        const auto axis = extent.x > extent.y && extent.x > extent.z ? 0 : extent.y > extent.z ? 1 : 2;
        const auto middle = begin + (end - begin) / 2;
        const auto key = [&](std::size_t i) {
            const auto p = boxes_[i].center();
            return axis == 0 ? p.x : axis == 1 ? p.y : p.z;
        };
        std::nth_element(order_.begin() + begin, order_.begin() + middle, order_.begin() + end,
                         [&](auto a, auto b) { return key(a) < key(b); });
        const auto left = split(begin, middle), right = split(middle, end);
        nodes_[id].left = left;
        nodes_[id].right = right;
    }
    return id;
}

void VisibilityTree::visit(int node, const Frustum* frustum, const ViewRange* range, bool inside,
                           std::vector<std::size_t>& visible, std::size_t& tested) const {
    const auto& n = nodes_[node];
    if (!inside) {
        ++tested;
        auto result = frustum ? frustum->classify(n.bounds) : 1;
        if (range && result >= 0)
            result = std::min(result, range->classify(n.bounds));
        if (result < 0)
            return;
        inside = result > 0;
    }
    if (inside) {
        visible.insert(visible.end(), order_.begin() + n.begin, order_.begin() + n.end);
        return;
    }
    if (n.left >= 0) {
        visit(n.left, frustum, range, false, visible, tested);
        visit(n.right, frustum, range, false, visible, tested);
    } else
        for (auto i = n.begin; i < n.end; ++i) {
            ++tested;
            if ((!frustum || frustum->classify(boxes_[order_[i]]) >= 0) &&
                (!range || range->classify(boxes_[order_[i]]) >= 0))
                visible.push_back(order_[i]);
        }
}

void VisibilityTree::query(const Frustum& frustum, std::vector<std::size_t>& visible, std::size_t& tested,
                           const ViewRange* range) const {
    visible.clear();
    tested = 0;
    if (!nodes_.empty())
        visit(0, &frustum, range, false, visible, tested);
    std::sort(visible.begin(), visible.end());
}

void VisibilityTree::query(const ViewRange& range, std::vector<std::size_t>& visible, std::size_t& tested) const {
    visible.clear();
    tested = 0;
    if (!nodes_.empty())
        visit(0, nullptr, &range, false, visible, tested);
    std::sort(visible.begin(), visible.end());
}
} // namespace openslope
