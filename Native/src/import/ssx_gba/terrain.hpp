#pragma once
#include "assets.hpp"
#include <map>
#include <set>

namespace openslope::import_detail::gba {
using UV = std::array<double, 2>;
using Curve = std::array<Vec3, 4>;
using Bary = std::array<double, 3>;
using Edge = std::array<unsigned, 2>;
using EdgeFaces = std::map<Edge, std::vector<unsigned>>;

struct Face {
    std::array<unsigned, 3> ids;
    std::array<UV, 3> uv;
    unsigned record, kind, material, flags;
    Vec3 normal;
    bool keyed;
};

struct TerrainPatches {
    Json patches = Json::array();
    std::set<unsigned> records;
    unsigned paired{}, flat{}, triangles{}, curved_edges{}, fitted{};
};

struct HeightQuad {
    std::array<Vec3, 16> points{};
    std::array<Vec3, 4> gradients{};
    std::array<std::array<Vec3, 2>, 4> edge_gradients{};
    std::array<bool, 4> sharp{};
    std::array<UV, 4> uv{};
    std::array<double, 9> targets{};
    std::vector<unsigned> sources;
    bool fit = true;
};

struct SmoothTriangle {
    std::array<Vec3, 3> points, gradients;
    std::array<Curve, 3> edges;
    Vec3 centre;
    Vec3 source_gradient;
    bool fit{};
    Vec3 point(Bary b) const;
};

struct TerrainCurves {
    std::vector<std::array<unsigned, 3>> ids;
    std::vector<SmoothTriangle> triangles;
    std::map<Edge, Curve> curves;
    std::set<Edge> sharp;
    unsigned curved{};
};

inline Edge edge_key(unsigned a, unsigned b) { return {std::min(a, b), std::max(a, b)}; }

inline bool terrain_face(const Face& f) { return f.kind >= 2 && f.kind <= 4 && !f.keyed; }

TerrainCurves terrain_curves(const Geometry& g, const std::vector<Face>& all, const std::vector<unsigned>& welded,
                             const EdgeFaces& edges, const ImportCancel& cancel);
std::vector<int> terrain_matching(unsigned count, const std::vector<Edge>& candidates, const ImportCancel& cancel);

inline constexpr std::array<std::array<unsigned, 4>, 4> quad_edges{
    {{{0, 4, 8, 12}}, {{12, 13, 14, 15}}, {{15, 11, 7, 3}}, {{3, 2, 1, 0}}}};
inline constexpr std::array<unsigned, 4> quad_ring{0, 1, 3, 2};
Vec3 curve_point(const Curve& c, double t);
Vec3 curve_tangent(const Curve& c, double t);
bool fit_height(HeightQuad& quad);
std::vector<Face> terrain_faces(const Geometry& g, const Textures& t);
TerrainPatches terrain_patches(const Geometry& g, const std::vector<Face>& all, const ImportCancel& cancel);
} // namespace openslope::import_detail::gba
