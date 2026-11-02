#include "terrain.hpp"
#include <algorithm>
#include <numeric>

namespace openslope::import_detail::gba {
namespace {
// Alternating paths can revisit an odd cycle in the triangle adjacency graph.
// Contract those cycles while searching, then expand through the stored parents.
struct Matching {
    std::vector<std::vector<unsigned>> links;
    std::vector<int> mate, parent;
    std::vector<unsigned> base, queue;
    std::vector<bool> reached, contracted;

    explicit Matching(unsigned count)
        : links(count), mate(count, -1), parent(count), base(count), reached(count), contracted(count) {}

    unsigned ancestor(unsigned a, unsigned b) const {
        std::vector<bool> path(links.size());
        for (;;) {
            a = base[a];
            path[a] = true;
            if (mate[a] < 0)
                break;
            a = unsigned(parent[unsigned(mate[a])]);
        }
        for (;;) {
            b = base[b];
            if (path[b])
                return b;
            b = unsigned(parent[unsigned(mate[b])]);
        }
    }

    void contract(unsigned v, unsigned common, unsigned child) {
        while (base[v] != common) {
            const auto other = unsigned(mate[v]);
            contracted[base[v]] = contracted[base[other]] = true;
            parent[v] = int(child);
            child = other;
            v = unsigned(parent[other]);
        }
    }

    int endpoint(unsigned root, const ImportCancel& cancel) {
        std::fill(reached.begin(), reached.end(), false);
        std::fill(parent.begin(), parent.end(), -1);
        std::iota(base.begin(), base.end(), 0u);
        queue = {root};
        reached[root] = true;
        for (unsigned head = 0; head < queue.size(); ++head) {
            check_cancel(cancel);
            const auto v = queue[head];
            for (auto u : links[v]) {
                if (base[v] == base[u] || mate[v] == int(u))
                    continue;
                if (u == root || (mate[u] >= 0 && parent[unsigned(mate[u])] >= 0)) {
                    const auto common = ancestor(v, u);
                    std::fill(contracted.begin(), contracted.end(), false);
                    contract(v, common, u);
                    contract(u, common, v);
                    for (unsigned i = 0; i < links.size(); ++i)
                        if (contracted[base[i]]) {
                            base[i] = common;
                            if (!reached[i]) {
                                reached[i] = true;
                                queue.push_back(i);
                            }
                        }
                } else if (parent[u] < 0) {
                    parent[u] = int(v);
                    if (mate[u] < 0)
                        return int(u);
                    u = unsigned(mate[u]);
                    reached[u] = true;
                    queue.push_back(u);
                }
            }
        }
        return -1;
    }

    void improve(const ImportCancel& cancel) {
        for (unsigned root = 0; root < links.size(); ++root)
            if (mate[root] < 0) {
                int end = endpoint(root, cancel);
                while (end >= 0) {
                    const auto v = unsigned(end);
                    const int previous = parent[v];
                    end = previous < 0 ? -1 : mate[unsigned(previous)];
                    mate[v] = previous;
                    if (previous >= 0)
                        mate[unsigned(previous)] = int(v);
                }
            }
    }
};
} // namespace

std::vector<int> terrain_matching(unsigned count, const std::vector<Edge>& candidates, const ImportCancel& cancel) {
    std::vector<std::vector<unsigned>> links(count);
    for (unsigned i = 0; i < candidates.size(); ++i)
        for (const auto v : candidates[i]) {
            require(v < count && candidates[i][0] != candidates[i][1], "Invalid GBA terrain pair");
            links[v].push_back(i);
        }
    std::vector<int> selected(count, -1), local(count, -1);
    // Work within connected compatible regions, so thousands of isolated seam
    // faces do not make each alternating-path search traverse the entire map.
    for (unsigned start = 0; start < count; ++start) {
        check_cancel(cancel);
        if (links[start].empty() || local[start] >= 0)
            continue;
        std::vector<unsigned> vertices{start};
        local[start] = 0;
        for (unsigned head = 0; head < vertices.size(); ++head)
            for (const auto edge : links[vertices[head]])
                for (const auto v : candidates[edge])
                    if (local[v] < 0) {
                        local[v] = int(vertices.size());
                        vertices.push_back(v);
                    }
        Matching matching(unsigned(vertices.size()));
        std::vector<unsigned> ordered;
        for (const auto v : vertices)
            ordered.insert(ordered.end(), links[v].begin(), links[v].end());
        std::sort(ordered.begin(), ordered.end());
        ordered.erase(std::unique(ordered.begin(), ordered.end()), ordered.end());
        // Keep the square-like greedy result as the seed, changing existing
        // pairs only when an alternating path can recover an additional quad.
        for (const auto edge : ordered) {
            const auto a = unsigned(local[candidates[edge][0]]), b = unsigned(local[candidates[edge][1]]);
            matching.links[a].push_back(b);
            matching.links[b].push_back(a);
            if (matching.mate[a] < 0 && matching.mate[b] < 0) {
                matching.mate[a] = int(b);
                matching.mate[b] = int(a);
            }
        }
        matching.improve(cancel);
        for (const auto edge : ordered) {
            const auto a = candidates[edge][0], b = candidates[edge][1];
            if (matching.mate[unsigned(local[a])] == local[b])
                selected[a] = selected[b] = int(edge);
        }
    }
    return selected;
}
} // namespace openslope::import_detail::gba
