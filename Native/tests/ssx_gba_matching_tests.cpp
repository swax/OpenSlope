#include "../src/import/ssx_gba/terrain.hpp"
#include <algorithm>
#include <bit>
#include <iostream>
#include <random>

using namespace openslope::import_detail::gba;

namespace {
unsigned exhaustive(unsigned available, const std::vector<unsigned>& neighbours) {
    if (!available)
        return 0;
    const unsigned first = std::countr_zero(available), rest = available & ~(1u << first);
    unsigned best = exhaustive(rest, neighbours), choices = neighbours[first] & rest;
    while (choices) {
        const unsigned other = std::countr_zero(choices);
        choices &= choices - 1;
        best = std::max(best, 1 + exhaustive(rest & ~(1u << other), neighbours));
    }
    return best;
}

void verify(unsigned size, const std::vector<Edge>& edges) {
    const auto result = terrain_matching(size, edges, {});
    std::vector<unsigned> neighbours(size);
    for (const auto& edge : edges) {
        neighbours[edge[0]] |= 1u << edge[1];
        neighbours[edge[1]] |= 1u << edge[0];
    }
    unsigned count = 0;
    for (unsigned i = 0; i < size; ++i)
        if (result[i] >= 0) {
            const auto& edge = edges.at(unsigned(result[i]));
            require((edge[0] == i || edge[1] == i) && result[edge[0]] == result[edge[1]],
                    "Matching repeats or loses a source face");
            ++count;
        }
    require(count / 2 == exhaustive((1u << size) - 1, neighbours), "Matching misses a possible quad");
    require(result == terrain_matching(size, edges, {}), "Matching must be deterministic");
}
} // namespace

int main() {
    try {
        verify(4, {{1, 2}, {0, 1}, {2, 3}}); // Recover two pairs from a square-like middle seed.
        verify(6, {{0, 1}, {1, 2}, {2, 0}, {0, 3}, {1, 4}, {2, 5}}); // Odd cycle with exposed tips.
        std::mt19937 random(0x4754524b);
        for (unsigned test = 0; test < 500; ++test) {
            const unsigned size = 2 + random() % 9;
            std::vector<Edge> edges;
            for (unsigned a = 0; a < size; ++a)
                for (unsigned b = a + 1; b < size; ++b)
                    if (random() % 4 == 0)
                        edges.push_back({a, b});
            std::shuffle(edges.begin(), edges.end(), random);
            verify(size, edges);
        }
        const auto sparse = terrain_matching(10000, {{0, 1}, {9998, 9999}}, {});
        require(sparse[0] == 0 && sparse[9998] == 1 && sparse[5000] == -1, "Disconnected faces stay independent");
        bool cancelled = false;
        try {
            terrain_matching(10, {}, [] { return true; });
        } catch (const std::exception&) {
            cancelled = true;
        }
        require(cancelled, "Terrain matching must honour cancellation");
        std::cout << "GBA maximum quad matching, odd cycles, source accounting and cancellation PASS\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
