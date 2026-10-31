#include "openslope/rails.hpp"
#include "assets.hpp"
#include <algorithm>
#include <map>
#include <set>

namespace openslope::import_detail::gba {
namespace {
using Key = std::array<long long, 3>;

Key key(Vec3 p) { return {std::llround(p.x * 1e6), std::llround(p.y * 1e6), std::llround(p.z * 1e6)}; }

using Edge = std::array<unsigned, 2>;

Edge edge(unsigned a, unsigned b) { return {std::min(a, b), std::max(a, b)}; }
} // namespace

Json write_rails(const Geometry& g, const std::filesystem::path& output, const ImportCancel& cancel) {
    std::map<Key, unsigned> welded;
    std::vector<Vec3> points;
    std::vector<unsigned> ids;
    const auto weld = [&](Vec3 p) {
        const auto [found, added] = welded.emplace(key(p), unsigned(points.size()));
        if (added)
            points.push_back(p);
        return found->second;
    };
    for (const auto& p : g.points)
        ids.push_back(weld(p));
    std::map<Edge, unsigned> owners;
    std::vector<std::array<unsigned, 3>> caps;
    unsigned excluded = 0;
    // [Trailmap: 610-grind-surfaces] Native special-surface eligibility; orientation excludes rotated posts.
    for (const auto& r : g.records)
        if ((r.tag & 127) == 4 && (r.last & 0x13) == 0x13) {
            const auto n = normalized(cross(g.points[r.vertices[1]] - g.points[r.vertices[0]],
                                            g.points[r.vertices[2]] - g.points[r.vertices[0]]),
                                      {});
            if (n.y <= .1) {
                ++excluded;
                continue;
            }
            const std::array<unsigned, 3> tri{ids[r.vertices[0]], ids[r.vertices[1]], ids[r.vertices[2]]};
            caps.push_back(tri);
            for (unsigned i = 0; i < 3; ++i)
                ++owners[edge(tri[i], tri[(i + 1) % 3])];
        }
    std::vector<Edge> spans;
    std::map<unsigned, std::vector<unsigned>> graph;
    const auto add = [&](Vec3 a, Vec3 b) {
        const auto x = weld(a), y = weld(b);
        if (x == y)
            return;
        const auto i = unsigned(spans.size());
        spans.push_back({x, y});
        graph[x].push_back(i);
        graph[y].push_back(i);
    };
    const auto mid = [&](Edge e) { return (points[e[0]] + points[e[1]]) * .5; };
    for (const auto& tri : caps) {
        check_cancel(cancel);
        std::vector<Edge> boundary, shared;
        for (unsigned i = 0; i < 3; ++i) {
            const auto e = edge(tri[i], tri[(i + 1) % 3]);
            (owners[e] > 1 ? shared : boundary).push_back(e);
        }
        const auto shortest = [&] {
            return *std::min_element(boundary.begin(), boundary.end(), [&](Edge a, Edge b) {
                return length(points[a[0]] - points[a[1]]) < length(points[b[0]] - points[b[1]]);
            });
        };
        if (shared.size() == 2)
            add(mid(shared[0]), mid(shared[1]));
        else if (shared.size() == 1)
            add(mid(shared[0]), mid(shortest()));
        else if (shared.size() == 3) {
            const auto p = (points[tri[0]] + points[tri[1]] + points[tri[2]]) / 3;
            for (const auto e : shared)
                add(mid(e), p);
        } else {
            const auto e = shortest();
            for (const auto v : tri)
                if (v != e[0] && v != e[1]) {
                    add(mid(e), points[v]);
                    break;
                }
        }
    }
    std::vector<unsigned> ends;
    for (const auto& [id, edges] : graph)
        if (edges.size() == 1)
            ends.push_back(id);
    std::set<unsigned> joined;
    unsigned seams = 0;
    for (const auto a : ends)
        if (!joined.contains(a)) {
            double best = .15000001;
            std::optional<unsigned> choice;
            for (const auto b : ends)
                if (a != b && !joined.contains(b)) {
                    const auto distance = length(points[a] - points[b]);
                    if (distance < best) {
                        best = distance;
                        choice = b;
                    }
                }
            if (choice) {
                add(points[a], points[*choice]);
                joined.insert(a);
                joined.insert(*choice);
                ++seams;
            }
        }
    Json rows = Json::array();
    std::vector<bool> used(spans.size());
    double total = 0;
    for (unsigned seed = 0; seed < spans.size(); ++seed) {
        if (used[seed])
            continue;
        check_cancel(cancel);
        // Begin at a boundary when possible, so branches remain separate editable chains.
        auto start = spans[seed][0];
        unsigned first = seed;
        for (unsigned i = seed; i < spans.size(); ++i)
            if (!used[i] && (graph[spans[i][0]].size() != 2 || graph[spans[i][1]].size() != 2)) {
                first = i;
                start = graph[spans[i][0]].size() != 2 ? spans[i][0] : spans[i][1];
                break;
            }
        std::vector<Vec3> chain{points[start]};
        auto at = start;
        while (true) {
            auto candidate = graph[at].end();
            if (chain.size() == 1)
                candidate = std::find(graph[at].begin(), graph[at].end(), first);
            if (candidate == graph[at].end())
                candidate = std::find_if(graph[at].begin(), graph[at].end(), [&](unsigned i) { return !used[i]; });
            if (candidate == graph[at].end())
                break;
            const auto i = *candidate;
            used[i] = true;
            at = spans[i][0] == at ? spans[i][1] : spans[i][0];
            chain.push_back(points[at]);
            if (graph[at].size() != 2)
                break;
        }
        std::vector<Vec3> simple;
        for (const auto p : chain) {
            simple.push_back(p);
            while (simple.size() > 2) {
                const auto n = simple.size();
                const auto a = simple[n - 3], b = simple[n - 2], c = simple[n - 1], ac = c - a;
                const auto den = dot(ac, ac);
                if (den < 1e-12)
                    break;
                const auto t = dot(b - a, ac) / den;
                if (t > 0 && t < 1 && length(b - a - ac * t) < 1e-7)
                    simple.erase(simple.end() - 2);
                else
                    break;
            }
        }
        double distance = 0;
        for (unsigned i = 1; i < simple.size(); ++i)
            distance += length(simple[i] - simple[i - 1]);
        if (distance < .15)
            continue;
        total += distance;
        Json segments = Json::array();
        if (simple.front().y < simple.back().y)
            std::reverse(simple.begin(), simple.end());
        for (unsigned i = 1; i < simple.size(); ++i) {
            const auto a = simple[i - 1], b = simple[i];
            segments.push_back({{"Points", {raw(a), raw(a + (b - a) / 3), raw(a + (b - a) * (2. / 3)), raw(b)}}});
        }
        rows.push_back({{"SplineName", "GBA rail " + std::to_string(rows.size() + 1)},
                        {"SplineStyle", 13},
                        {"U0", 1},
                        {"U1", 1},
                        {"Segments", segments}});
        seed = unsigned(-1); // A boundary-first walk may have consumed a later edge; revisit remaining earlier edges.
    }
    save(output / "Splines.json", {{"Splines", rows}});
    const auto rails = Rails::load(output);
    require(rails.splines() == rows.size(), "GBA rail validation failed");
    return {{"Splines", rows.size()},
            {"LengthMetres", total},
            {"CapTriangles", caps.size()},
            {"ExcludedVerticalFaces", excluded},
            {"SeamConnectors", seams},
            {"Policy", "Native special-surface gate; narrow-cap midpoint chains adapted to metal grind splines"}};
}
} // namespace openslope::import_detail::gba
