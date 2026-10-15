#pragma once
#include "math.hpp"
#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

namespace openslope {
// [Trailmap: 002-axes, 110-patch-model, 110-analytic-normal]
struct Patch {
    std::array<Vec3, 16> points;
    std::array<std::array<double, 2>, 4> uv{};
    std::array<double, 4> lightmap_rect{};
    std::string name, texture;
    int surface = 1, lightmap = 0;
    bool trick_only = false;
    Vec3 evaluate(double u, double v) const;
    std::array<Vec3, 2> tangents(double u, double v) const;
    Vec3 normal(double u, double v) const;
    std::array<double, 2> texture_uv(double u, double v) const;
    std::array<double, 2> lightmap_uv(double u, double v) const;
    Bounds bounds() const;
};

struct Vertex {
    float x, y, z, r, g, b;
    float s = 0, t = 0, ls = 0, lt = 0, lx = 0, ly = 0, lw = 0, lh = 0;
    float nx = 0, ny = 0, nz = 0;
};

struct MeshBatch {
    std::uint32_t first{}, count{};
    std::string texture;
    int lightmap = -1;
};

struct TerrainRange {
    std::uint32_t first{}, count{}, batch{};
    Bounds bounds;
};

struct Mesh {
    std::vector<Vertex> vertices;
    std::vector<std::uint32_t> indices;
    std::vector<MeshBatch> batches;
    std::filesystem::path map_root;
    std::vector<TerrainRange> terrain_ranges;
};

struct TerrainHit {
    Vec3 point, normal;
    double t, u, v;
    std::size_t patch;
    int surface;
    bool refined;
    double depth = 0;
};

class Terrain {
public:
    explicit Terrain(std::vector<Patch> patches);
    static Terrain load(const std::filesystem::path& map);
    static Terrain demo();

    const std::vector<Patch>& patches() const { return patches_; }

    const Bounds& bounds() const { return bounds_; }

    const std::filesystem::path& map_root() const { return map_root_; }

    Mesh mesh(unsigned subdivisions = 8) const;
    std::optional<TerrainHit> intersect(Vec3 start, Vec3 end) const;
    std::optional<TerrainHit> sweep(Vec3 start, Vec3 end, double radius) const;
    std::pair<Vec3, Vec3> spawn() const;
    Vec3 clear_eye(Vec3 eye, Vec3 safe, double radius = .45) const;

private:
    struct Node {
        Bounds bounds;
        std::size_t begin{}, end{};
        int left = -1, right = -1;
    };

    struct SampledPatch {
        std::array<Vec3, 81> points;
    };

    std::vector<Patch> patches_;
    std::vector<SampledPatch> samples_;
    std::vector<std::size_t> order_;
    std::vector<Node> nodes_;
    Bounds bounds_;
    std::filesystem::path map_root_;
    int build_node(std::size_t begin, std::size_t end);
    void intersect_node(int node, Vec3 start, Vec3 direction, std::optional<TerrainHit>& hit) const;
};
} // namespace openslope
