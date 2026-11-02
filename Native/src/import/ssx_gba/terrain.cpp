#include "terrain.hpp"
#include <algorithm>
#include <optional>
#include <tuple>

namespace openslope::import_detail::gba {
std::vector<Face> terrain_faces(const Geometry& g, const Textures& t) {
    std::vector<Face> result;
    for (unsigned i = 0; i < g.records.size(); ++i) {
        const auto& r = g.records[i];
        const auto kind = r.tag & 63, mat = r.tag >> 8;
        if (kind > 5)
            continue;
        require(mat < (kind < 4 ? t.flags.size() : t.palette.size()), "Invalid GBA primitive material");
        const bool keyed = kind < 4 && ((r.tag & 128) || (t.flags.at(mat) & 2));
        const auto emit = [&](std::array<unsigned, 3> ids, std::array<UV, 3> tex) {
            const auto n = cross(g.points[ids[1]] - g.points[ids[0]], g.points[ids[2]] - g.points[ids[0]]);
            if (length(n) > 1e-9)
                result.push_back({ids, tex, i, kind, mat, r.last, normalized(n), keyed});
        };
        if (kind == 0 || kind == 1 || kind == 5) {
            const auto a = r.vertices[0], b = r.vertices[1], c = r.vertices[2], d = r.last;
            const auto uv = [&](double u, double v) { return t.uv(mat, u, v, kind == 5); };
            emit({a, b, d}, {uv(0, 0), uv(31, 0), uv(0, 31)});
            emit({b, c, d}, {uv(31, 0), uv(31, 31), uv(0, 31)});
        } else if (kind == 4) {
            const auto uv = t.uv(mat, 0, 0, true);
            emit(r.vertices, {uv, uv, uv});
        } else if (kind == 2) {
            emit(r.vertices, {t.uv(mat, 31, 0), t.uv(mat, 0, 0), t.uv(mat, 0, 31)});
        } else {
            emit(r.vertices, {t.uv(mat, 0, 31), t.uv(mat, 31, 31), t.uv(mat, 31, 0)});
        }
    }
    return result;
}

namespace {
struct QuadPair {
    unsigned a, b;
    std::array<Vec3, 4> points;
    std::array<UV, 4> uv;
    double quality;
};

std::optional<QuadPair> quad_pair(const Geometry& g, const std::vector<Face>& all, const std::vector<unsigned>& welded,
                                  unsigned a, unsigned b) {
    const auto& f = all[a];
    const auto& other = all[b];
    if (f.material != other.material || f.flags != other.flags || (f.kind == 4) != (other.kind == 4) ||
        std::abs(dot(f.normal, other.normal)) < std::cos(20 * pi / 180) - 1e-12)
        return std::nullopt;
    std::vector<unsigned> shared, outer_a, outer_b;
    for (unsigned i = 0; i < 3; ++i) {
        const auto found = std::find_if(other.ids.begin(), other.ids.end(),
                                        [&](unsigned id) { return welded[id] == welded[f.ids[i]]; });
        if (found == other.ids.end()) {
            outer_a.push_back(i);
            continue;
        }
        const auto j = unsigned(found - other.ids.begin());
        if (f.uv[i] != other.uv[j])
            return std::nullopt;
        shared.push_back(i);
    }
    for (unsigned j = 0; j < 3; ++j)
        if (std::none_of(f.ids.begin(), f.ids.end(), [&](unsigned id) { return welded[id] == welded[other.ids[j]]; }))
            outer_b.push_back(j);
    if (shared.size() != 2 || outer_a.size() != 1 || outer_b.size() != 1)
        return std::nullopt;
    QuadPair result{a,
                    b,
                    {g.points[f.ids[outer_a[0]]], g.points[f.ids[shared[0]]], g.points[f.ids[shared[1]]],
                     g.points[other.ids[outer_b[0]]]},
                    {f.uv[outer_a[0]], f.uv[shared[0]], f.uv[shared[1]], other.uv[outer_b[0]]},
                    0};
    const auto& q = result.points;
    const auto normal = cross(q[1] - q[0], q[2] - q[0]);
    const std::array<unsigned, 4> ring{0, 1, 3, 2};
    double uv_sign = 0;
    for (unsigned i = 0; i < 4; ++i) {
        const auto x = ring[i], y = ring[(i + 1) % 4], z = ring[(i + 2) % 4];
        const auto e = q[y] - q[x], next = q[z] - q[y];
        if (dot(cross(e, next), normal) <= 1e-10)
            return std::nullopt;
        result.quality = std::max(result.quality, std::abs(dot(normalized(e), normalized(next))));
        if (f.kind != 4) {
            const auto& uv = result.uv;
            const double turn =
                (uv[y][0] - uv[x][0]) * (uv[z][1] - uv[y][1]) - (uv[y][1] - uv[x][1]) * (uv[z][0] - uv[y][0]);
            if (std::abs(turn) < 1e-12 || (i && turn * uv_sign <= 0))
                return std::nullopt;
            uv_sign = turn;
        }
    }
    return result;
}

// A cubic triangular height surface composed with the square-to-triangle map
// is bicubic. Recover its tensor controls exactly, keeping a single patch for
// an unmatched face rather than introducing three small quads and half-edges.
Curve interpolating_curve(const Curve& samples) {
    const auto a = samples[1] * 27 - samples[0] * 8 - samples[3];
    const auto b = samples[2] * 27 - samples[0] - samples[3] * 8;
    return {samples[0], (a * 2 - b) / 18, (b * 2 - a) / 18, samples[3]};
}

HeightQuad triangle_patch(const Face& face, const SmoothTriangle& triangle) {
    HeightQuad q;
    q.sources = {face.record};
    q.uv = {face.uv[0], face.uv[1], face.uv[2], face.uv[2]};
    q.fit = false;
    for (unsigned i = 0; i < 4; ++i)
        for (unsigned j = 0; j < 4; ++j) {
            const double u = i / 3., v = j / 3.;
            q.points[i * 4 + j] = triangle.point({(1 - u) * (1 - v), u * (1 - v), v});
        }
    for (unsigned j = 0; j < 4; ++j) {
        const auto curve = interpolating_curve({q.points[j], q.points[4 + j], q.points[8 + j], q.points[12 + j]});
        for (unsigned i = 0; i < 4; ++i)
            q.points[i * 4 + j] = curve[i];
    }
    for (unsigned i = 0; i < 4; ++i) {
        const auto curve =
            interpolating_curve({q.points[i * 4], q.points[i * 4 + 1], q.points[i * 4 + 2], q.points[i * 4 + 3]});
        for (unsigned j = 0; j < 4; ++j)
            q.points[i * 4 + j] = curve[j];
    }
    const auto c = triangle.points[2];
    const std::array<Curve, 4> boundaries{triangle.edges[0], triangle.edges[1], Curve{c, c, c, c}, triangle.edges[2]};
    for (unsigned e = 0; e < 4; ++e)
        for (unsigned j = 0; j < 4; ++j)
            q.points[quad_edges[e][j]] = boundaries[e][j];
    return q;
}

void controls(HeightQuad& q, const std::array<Vec3, 4>& corners, const std::array<Curve, 4>& curves) {
    for (unsigned i = 0; i < 4; ++i)
        for (unsigned j = 0; j < 4; ++j) {
            const double u = i / 3., v = j / 3.;
            q.points[i * 4 + j] = corners[0] * ((1 - u) * (1 - v)) + corners[1] * (u * (1 - v)) +
                                  corners[2] * ((1 - u) * v) + corners[3] * (u * v);
        }
    for (unsigned e = 0; e < 4; ++e) {
        q.edge_gradients[e] = {q.gradients[quad_ring[e]], q.gradients[quad_ring[(e + 1) % 4]]};
        for (unsigned j = 0; j < 4; ++j)
            q.points[quad_edges[e][j]] = curves[e][j];
    }
    for (unsigned i = 1; i < 3; ++i)
        for (unsigned j = 1; j < 3; ++j) {
            const double u = i / 3., v = j / 3.;
            q.points[i * 4 + j].y = q.points[i * 4].y * (1 - v) + q.points[i * 4 + 3].y * v + q.points[j].y * (1 - u) +
                                    q.points[12 + j].y * u - q.points[i * 4 + j].y;
        }
}

Json document(HeightQuad q) {
    const auto du = q.points[12] + q.points[15] - q.points[0] - q.points[3];
    const auto dv = q.points[3] + q.points[15] - q.points[0] - q.points[12];
    if (cross(du, dv).y < 0) {
        const auto points = q.points;
        for (unsigned i = 0; i < 4; ++i)
            for (unsigned j = 0; j < 4; ++j)
                q.points[i * 4 + j] = points[j * 4 + i];
        std::swap(q.uv[1], q.uv[2]);
    }
    Json points = Json::array();
    for (const auto p : q.points)
        points.push_back(raw(p));
    std::string name = "GBA surface " + std::to_string(q.sources[0]);
    Json result{{"PatchName", name},
                {"Points", points},
                {"UVPoints", q.uv},
                {"TexturePath", "gba-opaque.png"},
                {"SurfaceType", 1},
                {"LightmapID", -1},
                {"LightMapPoint", {0, 0, 0, 0}},
                {"TrickOnlyPatch", false},
                {"SourceRecord", q.sources[0]}};
    if (q.sources.size() == 2)
        result["SourceRecords"] = q.sources;
    return result;
}
} // namespace

TerrainPatches terrain_patches(const Geometry& g, const std::vector<Face>& all, const ImportCancel& cancel) {
    std::map<std::array<double, 3>, unsigned> positions;
    std::vector<unsigned> welded;
    for (const auto& p : g.points)
        welded.push_back(positions.try_emplace({p.x, p.y, p.z}, unsigned(positions.size())).first->second);
    EdgeFaces edges;
    for (unsigned i = 0; i < all.size(); ++i)
        if (terrain_face(all[i]))
            for (unsigned e = 0; e < 3; ++e)
                edges[edge_key(welded[all[i].ids[e]], welded[all[i].ids[(e + 1) % 3]])].push_back(i);
    std::vector<QuadPair> candidates;
    for (const auto& [edge, faces] : edges) {
        check_cancel(cancel);
        if (faces.size() == 2)
            if (const auto pair = quad_pair(g, all, welded, faces[0], faces[1]))
                candidates.push_back(*pair);
    }
    std::sort(candidates.begin(), candidates.end(), [](const auto& a, const auto& b) {
        return std::tie(a.quality, a.a, a.b) < std::tie(b.quality, b.a, b.b);
    });
    std::vector<Edge> pairs;
    for (const auto& pair : candidates)
        pairs.push_back({pair.a, pair.b});
    const auto selected = terrain_matching(unsigned(all.size()), pairs, cancel);
    auto frame = terrain_curves(g, all, welded, edges, cancel);
    TerrainPatches result;
    result.curved_edges = frame.curved;
    const auto emit = [&](HeightQuad q) {
        result.fitted += fit_height(q);
        result.patches.push_back(document(std::move(q)));
    };
    for (unsigned i = 0; i < all.size(); ++i) {
        check_cancel(cancel);
        const auto& f = all[i];
        if (!terrain_face(f))
            continue;
        result.records.insert(f.record);
        if (selected[i] >= 0) {
            const auto& pair = candidates[unsigned(selected[i])];
            if (i != pair.a)
                continue;
            HeightQuad q;
            q.sources = {f.record, all[pair.b].record};
            q.uv = pair.uv;
            q.fit = frame.triangles[i].fit && frame.triangles[pair.b].fit;
            std::array<unsigned, 4> ids{};
            for (unsigned k = 0; k < 4; ++k)
                for (const auto source : {i, pair.b})
                    for (unsigned v = 0; v < 3; ++v) {
                        const auto p = g.points[all[source].ids[v]], want = pair.points[k];
                        if (p.x == want.x && p.y == want.y && p.z == want.z) {
                            ids[k] = frame.ids[source][v];
                            q.gradients[k] = frame.triangles[source].gradients[v];
                        }
                    }
            std::array<Curve, 4> boundaries;
            for (unsigned e = 0; e < 4; ++e) {
                const auto a = ids[quad_ring[e]], b = ids[quad_ring[(e + 1) % 4]];
                auto curve = frame.curves.at(edge_key(a, b));
                if (a > b)
                    std::reverse(curve.begin(), curve.end());
                boundaries[e] = curve;
            }
            controls(q, pair.points, boundaries);
            for (unsigned e = 0; e < 4; ++e) {
                const auto a = ids[quad_ring[e]], b = ids[quad_ring[(e + 1) % 4]];
                if (frame.sharp.contains(edge_key(a, b)))
                    for (const auto source : {i, pair.b})
                        if (std::find(frame.ids[source].begin(), frame.ids[source].end(), a) !=
                                frame.ids[source].end() &&
                            std::find(frame.ids[source].begin(), frame.ids[source].end(), b) !=
                                frame.ids[source].end()) {
                            const auto gradient = frame.triangles[source].source_gradient;
                            q.edge_gradients[e] = {gradient, gradient};
                            q.sharp[e] = true;
                        }
            }
            unsigned sample = 0;
            for (const double u : {.25, .5, .75})
                for (const double v : {.25, .5, .75}) {
                    const unsigned source = u + v <= 1 ? i : pair.b;
                    const std::array<unsigned, 3> keys =
                        u + v <= 1 ? std::array{ids[0], ids[1], ids[2]} : std::array{ids[1], ids[2], ids[3]};
                    const Bary w = u + v <= 1 ? Bary{1 - u - v, u, v} : Bary{1 - v, 1 - u, u + v - 1};
                    Bary bary{};
                    for (unsigned k = 0; k < 3; ++k)
                        for (unsigned j = 0; j < 3; ++j)
                            if (frame.ids[source][k] == keys[j])
                                bary[k] = w[j];
                    q.targets[sample++] = frame.triangles[source].point(bary).y;
                }
            emit(std::move(q));
            ++(f.kind == 4 ? result.flat : result.paired);
            continue;
        }
        emit(triangle_patch(f, frame.triangles[i]));
        ++result.triangles;
    }
    return result;
}
} // namespace openslope::import_detail::gba
