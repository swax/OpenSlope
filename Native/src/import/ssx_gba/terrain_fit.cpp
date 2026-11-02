#include "terrain.hpp"
#include <algorithm>
#include <limits>

namespace openslope::import_detail::gba {
namespace {
std::array<double, 4> basis(double t) {
    const auto s = 1 - t;
    return {s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t};
}

constexpr std::array<unsigned, 4> inner{5, 6, 9, 10};

struct Fit {
    std::array<std::array<double, 5>, 4> system{};

    void add(const std::array<double, 4>& a, double b, double weight) {
        for (unsigned i = 0; i < 4; ++i) {
            for (unsigned j = 0; j < 4; ++j)
                system[i][j] += weight * a[i] * a[j];
            system[i][4] += weight * a[i] * b;
        }
    }

    std::array<double, 4> solve() {
        for (unsigned k = 0; k < 4; ++k) {
            unsigned pivot = k;
            for (unsigned i = k + 1; i < 4; ++i)
                if (std::abs(system[i][k]) > std::abs(system[pivot][k]))
                    pivot = i;
            std::swap(system[k], system[pivot]);
            require(std::abs(system[k][k]) > 1e-15, "Singular GBA terrain fit");
            const double scale = system[k][k];
            for (unsigned j = k; j < 5; ++j)
                system[k][j] /= scale;
            for (unsigned i = 0; i < 4; ++i)
                if (i != k) {
                    const double a = system[i][k];
                    for (unsigned j = k; j < 5; ++j)
                        system[i][j] -= a * system[k][j];
                }
        }
        return {system[0][4], system[1][4], system[2][4], system[3][4]};
    }
};
} // namespace

Vec3 curve_point(const Curve& c, double t) {
    const auto b = basis(t);
    return c[0] * b[0] + c[1] * b[1] + c[2] * b[2] + c[3] * b[3];
}

Vec3 curve_tangent(const Curve& c, double t) {
    const auto s = 1 - t;
    return ((c[1] - c[0]) * (s * s) + (c[2] - c[1]) * (2 * s * t) + (c[3] - c[2]) * (t * t)) * 3;
}

bool fit_height(HeightQuad& q) {
    if (!q.fit)
        return false;
    const auto original = q.points;
    Fit fit;
    // Fit the four interior heights to the curved source triangles. X/Z and every
    // boundary control remain fixed, so fitting cannot open a crack or move a course outline sideways.
    unsigned sample = 0;
    for (const double u : {.25, .5, .75})
        for (const double v : {.25, .5, .75}) {
            const auto bu = basis(u), bv = basis(v);
            std::array<double, 4> row{};
            double fixed = 0;
            for (unsigned i = 0; i < 16; ++i) {
                const auto found = std::find(inner.begin(), inner.end(), i);
                const double w = bu[i / 4] * bv[i % 4];
                if (found == inner.end())
                    fixed += q.points[i].y * w;
                else
                    row[unsigned(found - inner.begin())] = w;
            }
            fit.add(row, q.targets[sample++] - fixed, 1);
        }
    double shortest = std::numeric_limits<double>::infinity();
    for (unsigned e = 0; e < 4; ++e) {
        const auto& edge = quad_edges[e];
        Curve curve{}, inside{};
        for (unsigned j = 0; j < 4; ++j) {
            curve[j] = q.points[edge[j]];
            const unsigned index = e == 0 ? edge[j] + 1 : e == 1 ? edge[j] - 4 : e == 2 ? edge[j] - 1 : edge[j] + 4;
            inside[j] = q.points[index];
        }
        auto span = curve[3] - curve[0];
        span.y = 0;
        shortest = std::min(shortest, length(span));
        for (const double t : {.25, .5, .75}) {
            const auto bc = basis(t);
            auto tangent = curve_tangent(curve, t);
            auto gradient = q.edge_gradients[e][0] * (1 - t) + q.edge_gradients[e][1] * t;
            const double horizontal = tangent.x * tangent.x + tangent.z * tangent.z;
            if (horizontal < 1e-12)
                continue;
            // A common gradient field, corrected for the common edge's own tangent,
            // gives both sides the same target tangent plane, including full/half-edge joins.
            const double correction = (tangent.y - gradient.x * tangent.x - gradient.z * tangent.z) / horizontal;
            gradient.x += correction * tangent.x;
            gradient.z += correction * tangent.z;
            const auto boundary = curve_point(curve, t), in = curve_point(inside, t);
            double target = boundary.y + gradient.x * (in.x - boundary.x) + gradient.z * (in.z - boundary.z);
            std::array<double, 4> row{};
            for (unsigned j = 0; j < 4; ++j) {
                const unsigned index = e == 0 ? edge[j] + 1 : e == 1 ? edge[j] - 4 : e == 2 ? edge[j] - 1 : edge[j] + 4;
                const auto found = std::find(inner.begin(), inner.end(), index);
                if (found == inner.end())
                    target -= bc[j] * q.points[index].y;
                else
                    row[unsigned(found - inner.begin())] += bc[j];
            }
            fit.add(row, target, q.sharp[e] ? 64 : 16);
        }
    }
    for (unsigned i = 0; i < 4; ++i) {
        std::array<double, 4> row{};
        row[i] = 1;
        fit.add(row, q.points[inner[i]].y, .01);
    }
    const auto heights = fit.solve();
    double change = 0;
    for (unsigned i = 0; i < 4; ++i) {
        require(std::isfinite(heights[i]), "Non-finite GBA terrain control");
        change = std::max(change, std::abs(heights[i] - original[inner[i]].y));
    }
    // Limit local overshoot on narrow pieces without changing shared boundaries.
    const double blend = change > 1e-10 ? std::min(1., shortest * .15 / change) : 1;
    for (unsigned i = 0; i < 4; ++i)
        q.points[inner[i]].y += (heights[i] - q.points[inner[i]].y) * blend;
    return change * blend > 1e-8;
}
} // namespace openslope::import_detail::gba
