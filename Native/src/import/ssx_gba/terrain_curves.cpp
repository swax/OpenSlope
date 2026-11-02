#include "terrain.hpp"
#include <algorithm>

namespace openslope::import_detail::gba {
namespace {
struct Fans {
    std::vector<unsigned> parents;

    explicit Fans(unsigned size) : parents(size) {
        for (unsigned i = 0; i < size; ++i)
            parents[i] = i;
    }

    unsigned root(unsigned i) {
        while (parents[i] != i) {
            parents[i] = parents[parents[i]];
            i = parents[i];
        }
        return i;
    }

    void join(unsigned a, unsigned b) { parents[root(a)] = root(b); }
};

unsigned corner(const std::array<unsigned, 3>& ids, unsigned vertex) {
    const auto at = std::find(ids.begin(), ids.end(), vertex);
    require(at != ids.end(), "Missing GBA terrain edge corner");
    return unsigned(at - ids.begin());
}
} // namespace

Vec3 SmoothTriangle::point(Bary b) const {
    const auto u = b[0], v = b[1], w = b[2];
    auto p = points[0] * (u * u * u) + points[1] * (v * v * v) + points[2] * (w * w * w) +
             edges[0][1] * (3 * u * u * v) + edges[0][2] * (3 * u * v * v) + edges[1][1] * (3 * v * v * w) +
             edges[1][2] * (3 * v * w * w) + edges[2][1] * (3 * w * w * u) + edges[2][2] * (3 * w * u * u) +
             centre * (6 * u * v * w);
    // Fit heights over the original footprint; course widths and prop alignment stay exact.
    p.x = points[0].x * u + points[1].x * v + points[2].x * w;
    p.z = points[0].z * u + points[1].z * v + points[2].z * w;
    return p;
}

TerrainCurves terrain_curves(const Geometry& g, const std::vector<Face>& all, const std::vector<unsigned>& welded,
                             const EdgeFaces& edges, const ImportCancel& cancel) {
    TerrainCurves result;
    result.ids.resize(all.size());
    result.triangles.resize(all.size());
    std::vector<Vec3> normals(all.size());
    Fans fans(unsigned(all.size() * 3));
    for (unsigned i = 0; i < all.size(); ++i) {
        const auto& f = all[i];
        normals[i] = f.normal.y < 0 ? -f.normal : f.normal;
        for (unsigned k = 0; k < 3; ++k)
            result.ids[i][k] = welded[f.ids[k]];
    }
    std::map<Edge, bool> soft;
    std::set<unsigned> protected_vertices;
    for (const auto& [edge, faces] : edges) {
        check_cancel(cancel);
        const bool smooth = faces.size() == 2 && normals[faces[0]].y >= .35 && normals[faces[1]].y >= .35 &&
                            dot(normals[faces[0]], normals[faces[1]]) >= std::cos(20 * pi / 180) - 1e-12;
        soft[edge] = smooth;
        if (faces.size() > 1 && !smooth) {
            result.sharp.insert(edge);
            protected_vertices.insert(edge.begin(), edge.end());
        }
        if (smooth)
            for (const auto vertex : edge)
                fans.join(faces[0] * 3 + corner(result.ids[faces[0]], vertex),
                          faces[1] * 3 + corner(result.ids[faces[1]], vertex));
    }
    std::vector<Vec3> sums(all.size() * 3);
    for (unsigned i = 0; i < all.size(); ++i)
        if (terrain_face(all[i])) {
            const auto& ids = all[i].ids;
            const double area = length(cross(g.points[ids[1]] - g.points[ids[0]], g.points[ids[2]] - g.points[ids[0]]));
            for (unsigned k = 0; k < 3; ++k)
                sums[fans.root(i * 3 + k)] += normals[i] * area;
        }
    for (unsigned i = 0; i < all.size(); ++i)
        if (terrain_face(all[i])) {
            auto& t = result.triangles[i];
            t.fit = normals[i].y >= .35;
            t.source_gradient = t.fit ? Vec3{-normals[i].x / normals[i].y, 0, -normals[i].z / normals[i].y} : Vec3{};
            for (unsigned k = 0; k < 3; ++k) {
                t.points[k] = g.points[all[i].ids[k]];
                const auto n = normalized(sums[fans.root(i * 3 + k)], normals[i]);
                t.gradients[k] = t.fit ? Vec3{-n.x / n.y, 0, -n.z / n.y} : Vec3{};
            }
        }
    for (const auto& [edge, faces] : edges) {
        const auto owner = faces.front();
        const auto& t = result.triangles[owner];
        const auto a = corner(result.ids[owner], edge[0]), b = corner(result.ids[owner], edge[1]);
        const auto start = t.points[a], end = t.points[b], delta = end - start;
        const bool linear = !t.fit || (faces.size() != 1 && !soft.at(edge));
        Curve curve{start, start + delta / 3, start + delta * (2. / 3), end};
        if (!linear) {
            if (!protected_vertices.contains(edge[0]))
                curve[1].y = start.y + (t.gradients[a].x * delta.x + t.gradients[a].z * delta.z) / 3;
            if (!protected_vertices.contains(edge[1]))
                curve[2].y = end.y - (t.gradients[b].x * delta.x + t.gradients[b].z * delta.z) / 3;
            if (std::abs(curve[1].y - start.y - delta.y / 3) > 1e-8 ||
                std::abs(curve[2].y - end.y + delta.y / 3) > 1e-8)
                ++result.curved;
        }
        result.curves.emplace(edge, curve);
    }
    for (unsigned i = 0; i < all.size(); ++i)
        if (terrain_face(all[i])) {
            auto& t = result.triangles[i];
            Vec3 edge_average{};
            for (unsigned e = 0; e < 3; ++e) {
                const auto a = result.ids[i][e], b = result.ids[i][(e + 1) % 3];
                auto c = result.curves.at(edge_key(a, b));
                if (a > b)
                    std::reverse(c.begin(), c.end());
                t.edges[e] = c;
                edge_average += c[1] + c[2];
            }
            edge_average = edge_average / 6;
            const auto centroid = (t.points[0] + t.points[1] + t.points[2]) / 3;
            t.centre = centroid;
            t.centre.y = edge_average.y + (edge_average.y - centroid.y) * .5;
            for (unsigned e = 0; e < 3; ++e)
                if (result.sharp.contains(edge_key(result.ids[i][e], result.ids[i][(e + 1) % 3])))
                    t.centre.y = centroid.y;
        }
    return result;
}
} // namespace openslope::import_detail::gba
