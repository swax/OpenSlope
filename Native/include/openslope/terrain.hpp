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
    std::array<Vec3,16> points;
    std::array<std::array<double,2>,4> uv{};
    std::array<double,4> lightmap_rect{};
    std::string name, texture;
    int surface=1, lightmap=0;
    bool trick_only=false;
    Vec3 evaluate(double u,double v) const;
    std::array<Vec3,2> tangents(double u,double v) const;
    Vec3 normal(double u,double v) const;
    Bounds bounds() const;
};
struct Vertex { float x,y,z,r,g,b; };
struct Mesh { std::vector<Vertex> vertices; std::vector<std::uint32_t> indices; };
struct TerrainHit { Vec3 point,normal; double t,u,v; std::size_t patch; int surface; bool refined; };

class Terrain {
public:
    explicit Terrain(std::vector<Patch> patches);
    static Terrain load(const std::filesystem::path& map);
    static Terrain demo();
    const std::vector<Patch>& patches() const { return patches_; }
    const Bounds& bounds() const { return bounds_; }
    Mesh mesh(unsigned subdivisions=8) const;
    std::optional<TerrainHit> intersect(Vec3 start,Vec3 end) const;
    std::pair<Vec3,Vec3> spawn() const;
private:
    struct Node { Bounds bounds; std::size_t begin{},end{}; int left=-1,right=-1; };
    struct SampledPatch { std::array<Vec3,81> points; };
    std::vector<Patch> patches_;
    std::vector<SampledPatch> samples_;
    std::vector<std::size_t> order_;
    std::vector<Node> nodes_;
    Bounds bounds_;
    int build_node(std::size_t begin,std::size_t end);
    void intersect_node(int node,Vec3 start,Vec3 direction,std::optional<TerrainHit>& hit) const;
};
}
