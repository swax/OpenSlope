#include "openslope/terrain.hpp"
#include "openslope/collision.hpp"
#include "openslope/paths.hpp"
#include <fstream>
#include <map>
#include <mutex>
#include <nlohmann/json.hpp>
#include <numeric>
#include <stdexcept>

namespace openslope {
namespace {
std::array<double, 4> basis(double t) {
    const auto s = 1 - t;
    return {s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t};
}

std::array<double, 4> derivative(double t) {
    const auto s = 1 - t;
    return {-3 * s * s, 3 * s * s - 6 * s * t, 6 * s * t - 3 * t * t, 3 * t * t};
}

Vec3 evaluate_basis(const Patch& p, const std::array<double, 4>& u, const std::array<double, 4>& v) {
    Vec3 result;
    for (std::size_t r = 0; r < 4; ++r)
        for (std::size_t c = 0; c < 4; ++c)
            result += p.points[r * 4 + c] * (u[r] * v[c]);
    return result;
}

struct TriangleHit {
    double t, a, b;
};

std::optional<TriangleHit> triangle_seed(Vec3 origin, Vec3 direction, Vec3 a, Vec3 b, Vec3 c) {
    const auto ab = b - a, ac = c - a, p = cross(direction, ac);
    const auto det = dot(ab, p);
    if (std::abs(det) < 1e-12)
        return {};
    const auto s = origin - a;
    const auto u = dot(s, p) / det;
    if (u < -1e-8 || u > 1 + 1e-8)
        return {};
    const auto q = cross(s, ab);
    const auto v = dot(direction, q) / det;
    if (v < -1e-8 || u + v > 1 + 1e-8)
        return {};
    const auto t = dot(ac, q) / det;
    if (!std::isfinite(t))
        return {};
    return TriangleHit{t, u, v};
}

std::optional<TerrainHit> refine(const Patch& p, std::size_t index, Vec3 start, Vec3 direction, double u, double v,
                                 double t) {
    // [Trailmap: 110-analytic-normal, 320-probe] Solve the patch/ray equation,
    // including ray t; evaluating only the coarse u/v seed is not a contact.
    // The mesh seeds the unbounded line. A short ray may cross the curved patch
    // without reaching its chord, or cross the chord without reaching the patch.
    for (unsigned i = 0; i < 8; ++i) {
        const auto residual = p.evaluate(u, v) - (start + direction * t);
        if (length(residual) < 1e-8)
            break;
        const auto tangents = p.tangents(u, v);
        const auto a = tangents[0], b = tangents[1], c = -direction;
        const auto det = dot(a, cross(b, c));
        if (!std::isfinite(det) || std::abs(det) < 1e-12)
            return {};
        u -= dot(residual, cross(b, c)) / det;
        v -= dot(a, cross(residual, c)) / det;
        t -= dot(a, cross(b, residual)) / det;
        if (!finite(Vec3{u, v, t}))
            return {};
    }
    if (u < -1e-8 || u > 1 + 1e-8 || v < -1e-8 || v > 1 + 1e-8 || t < -1e-8 || t > 1 + 1e-8)
        return {};
    u = std::clamp(u, 0.0, 1.0);
    v = std::clamp(v, 0.0, 1.0);
    t = std::clamp(t, 0.0, 1.0);
    if (length(p.evaluate(u, v) - (start + direction * t)) > 1e-5)
        return {};
    return TerrainHit{start + direction * t, p.normal(u, v), t, u, v, index, p.surface, true};
}

// [Trailmap: 110-patch-model, 320-patch-ray] Collision must follow the curved
// patch, just as the support probe does. Split its control hull only where
// the swept body overlaps it; a fixed coarse chord can miss or invent snow.
using ControlNet = std::array<Vec3, 16>;

std::array<ControlNet, 2> split_control_net(const ControlNet& points, bool rows) {
    std::array<ControlNet, 2> halves;
    for (unsigned i = 0; i < 4; ++i) {
        const auto index = [&](unsigned j) { return rows ? j * 4 + i : i * 4 + j; };
        const auto a = points[index(0)], b = points[index(1)], c = points[index(2)], d = points[index(3)];
        const auto ab = (a + b) * .5, bc = (b + c) * .5, cd = (c + d) * .5;
        const auto abc = (ab + bc) * .5, bcd = (bc + cd) * .5, middle = (abc + bcd) * .5;
        const std::array<Vec3, 4> first{a, ab, abc, middle}, second{middle, bcd, cd, d};
        for (unsigned j = 0; j < 4; ++j) {
            halves[0][index(j)] = first[j];
            halves[1][index(j)] = second[j];
        }
    }
    return halves;
}

bool overlaps(const Bounds& box, const Bounds& swept) {
    return box.min.x <= swept.max.x && box.max.x >= swept.min.x && box.min.y <= swept.max.y &&
           box.max.y >= swept.min.y && box.min.z <= swept.max.z && box.max.z >= swept.min.z;
}

struct CollisionCell {
    ControlNet points;
    Bounds box;
    std::array<std::uint32_t, 4> children{};
    unsigned depth;
    bool leaf;

    CollisionCell(const ControlNet& control, unsigned level) : points(control), depth(level) {
        for (const auto point : points)
            box.add(point);
        const auto a = points[0], b = points[12], c = points[15], d = points[3];
        // Bezier weights are nonnegative and sum to one. Control-net distance
        // from the bilinear net bounds their surface difference; the corner
        // twist bounds the bilinear surface's distance from the two triangles.
        double deviation = 0;
        for (unsigned u = 0; u < 4; ++u)
            for (unsigned v = 0; v < 4; ++v) {
                const auto x = u / 3., y = v / 3.;
                const auto bilinear = a * ((1 - x) * (1 - y)) + b * (x * (1 - y)) + c * (x * y) + d * ((1 - x) * y);
                deviation = std::max(deviation, length(points[u * 4 + v] - bilinear));
            }
        deviation += length(a - b + c - d) * .25;
        // Bound recursion for unusually large custom control nets. Normal
        // course cells stop within one millimetre of their curved patch.
        leaf = deviation <= .001 || depth == 10;
    }
};

template <class Visitor>
void visit_collision_cells(const ControlNet& points, const Bounds& swept, unsigned depth, Visitor& visitor) {
    const CollisionCell cell(points, depth);
    if (!overlaps(cell.box, swept))
        return;
    if (cell.leaf) {
        visitor(points[0], points[12], points[15], points[3], cell.box);
        return;
    }
    const auto halves = split_control_net(points, true);
    for (const auto& half : halves) {
        const auto quarters = split_control_net(half, false);
        for (const auto& quarter : quarters)
            visit_collision_cells(quarter, swept, depth + 1, visitor);
    }
}

} // namespace

struct Terrain::CollisionCache {
    struct Tree {
        std::vector<CollisionCell> cells;
        std::uint64_t last_use = 0;
    };

    // Bound live cells and grow capacity geometrically (under 30 MiB of cell
    // storage on supported targets). Evict inactive patches; accuracy never depends on
    // whether a cell is cached. Copies of immutable terrain can share it.
    static constexpr std::size_t limit = 32768;
    std::vector<Tree> trees;
    std::size_t count = 0;
    std::uint64_t serial = 0;
    std::mutex mutex;

    explicit CollisionCache(std::size_t patches) : trees(patches) {}

    bool make_room(std::size_t active, std::size_t amount) {
        while (count + amount > limit) {
            std::optional<std::size_t> oldest;
            for (std::size_t i = 0; i < trees.size(); ++i)
                if (i != active && !trees[i].cells.empty() && (!oldest || trees[i].last_use < trees[*oldest].last_use))
                    oldest = i;
            if (!oldest)
                return false;
            count -= trees[*oldest].cells.size();
            std::vector<CollisionCell>{}.swap(trees[*oldest].cells);
        }
        return true;
    }

    template <class Visitor, class Relevant>
    void visit(std::size_t patch, const ControlNet& points, const Bounds& swept, Visitor& visitor,
               const Relevant& relevant) {
        auto& tree = trees[patch];
        tree.last_use = ++serial;
        if (tree.cells.empty()) {
            make_room(patch, 1);
            tree.cells.reserve(1);
            tree.cells.emplace_back(points, 0);
            ++count;
        }
        const auto walk = [&](auto&& self, std::uint32_t index) -> void {
            const auto& cell = tree.cells[index];
            if (!overlaps(cell.box, swept) || !relevant(cell.box))
                return;
            if (cell.leaf) {
                visitor(cell.points[0], cell.points[12], cell.points[15], cell.points[3], cell.box);
                return;
            }
            auto children = cell.children;
            if (!children[0]) {
                if (!make_room(patch, 4)) {
                    visit_collision_cells(cell.points, swept, cell.depth, visitor);
                    return;
                }
                const auto halves = split_control_net(cell.points, true);
                const auto depth = cell.depth + 1;
                auto capacity = tree.cells.capacity();
                while (capacity < tree.cells.size() + 4)
                    capacity = std::min(limit, capacity * 2);
                tree.cells.reserve(capacity);
                unsigned child = 0;
                for (const auto& half : halves)
                    for (const auto& quarter : split_control_net(half, false)) {
                        children[child++] = static_cast<std::uint32_t>(tree.cells.size());
                        tree.cells.emplace_back(quarter, depth);
                        ++count;
                    }
                tree.cells[index].children = children;
            }
            for (const auto child : children)
                self(self, child);
        };
        walk(walk, 0);
    }
};

Vec3 Patch::evaluate(double u, double v) const { return evaluate_basis(*this, basis(u), basis(v)); }

std::array<Vec3, 2> Patch::tangents(double u, double v) const {
    return {evaluate_basis(*this, derivative(u), basis(v)), evaluate_basis(*this, basis(u), derivative(v))};
}

Vec3 Patch::normal(double u, double v) const {
    const auto t = tangents(u, v);
    auto n = normalized(cross(t[0], t[1]));
    if (n.y < 0)
        n = -n; // Initial terrain player uses the skyward terrain side.
    return n;
}

Bounds Patch::bounds() const {
    Bounds b;
    for (auto p : points)
        b.add(p);
    return b;
}

std::array<double, 2> Patch::texture_uv(double u, double v) const {
    // [Trailmap: 110-uv-rotation] Corner order (0,0),(1,0),(0,1),(1,1).
    std::array<double, 2> result{};
    const std::array<double, 4> weights{(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v};
    for (unsigned i = 0; i < 4; ++i)
        for (unsigned axis = 0; axis < 2; ++axis)
            result[axis] += uv[i][axis] * weights[i];
    return result;
}

std::array<double, 2> Patch::lightmap_uv(double u, double v) const {
    // [Trailmap: 160-transpose] Page tile uses the opposite parametric axes.
    return {lightmap_rect[0] + v * lightmap_rect[2], lightmap_rect[1] + u * lightmap_rect[3]};
}

Terrain::Terrain(std::vector<Patch> patches) : patches_(std::move(patches)) {
    if (patches_.empty() || patches_.size() > 100000)
        throw std::runtime_error("A course must contain 1..100000 patches");
    samples_.resize(patches_.size());
    order_.resize(patches_.size());
    std::iota(order_.begin(), order_.end(), 0);
    for (std::size_t p = 0; p < patches_.size(); ++p) {
        for (const auto& uv : patches_[p].uv)
            for (const auto value : uv)
                if (!std::isfinite(value) || std::abs(value) > 1000000)
                    throw std::runtime_error("Invalid terrain texture coordinate");
        const auto& tile = patches_[p].lightmap_rect;
        for (const auto value : tile)
            if (!std::isfinite(value))
                throw std::runtime_error("Invalid lightmap tile coordinate");
        if (tile[0] < 0 || tile[1] < 0 || tile[2] < 0 || tile[3] < 0 || tile[0] + tile[2] > 1.000001 ||
            tile[1] + tile[3] > 1.000001)
            throw std::runtime_error("Lightmap tile lies outside its page");
        if (patches_[p].lightmap < -1 || patches_[p].lightmap > 65535)
            throw std::runtime_error("Invalid lightmap page index");
        for (auto v : patches_[p].points) {
            if (!finite(v))
                throw std::runtime_error("Non-finite terrain control point");
            bounds_.add(v);
        }
        for (unsigned u = 0; u <= 8; ++u)
            for (unsigned v = 0; v <= 8; ++v)
                samples_[p].points[u * 9 + v] = patches_[p].evaluate(u / 8.0, v / 8.0);
    }
    collision_cache_ = std::make_shared<CollisionCache>(patches_.size());
    build_node(0, patches_.size());
}

Terrain Terrain::load(const std::filesystem::path& map) {
    const auto path = std::filesystem::is_directory(map) ? map / "Patches.json" : map;
    if (std::filesystem::file_size(path) > 128 * 1024 * 1024)
        throw std::runtime_error("Patches.json exceeds the prototype's 128 MiB limit");
    std::ifstream stream(path);
    if (!stream)
        throw std::runtime_error("Cannot open terrain: " + path.string());
    const auto doc = nlohmann::json::parse(stream);
    const auto& rows = doc.at("Patches");
    if (!rows.is_array() || rows.empty() || rows.size() > 100000)
        throw std::runtime_error("Invalid terrain patch count");
    std::vector<Patch> patches;
    patches.reserve(rows.size());
    for (const auto& row : rows) {
        Patch p;
        p.name = row.at("PatchName").get<std::string>();
        p.surface = row.at("SurfaceType").get<int>();
        p.texture = row.at("TexturePath").get<std::string>();
        p.lightmap = row.at("LightmapID").get<int>();
        p.trick_only = row.at("TrickOnlyPatch").get<bool>();
        const auto& points = row.at("Points");
        if (!points.is_array() || points.size() != 16)
            throw std::runtime_error("Each patch requires 16 control points");
        for (std::size_t i = 0; i < 16; ++i) {
            if (!points[i].is_array() || points[i].size() != 3)
                throw std::runtime_error("Each control point requires three coordinates");
            // [Trailmap: 002-units, 002-axes] Z-up centimetres to Y-up metres.
            // A proper -90 degree X rotation preserves the course's turns.
            // The spec's additional X reflection is disputed; see spec-alignment.md.
            p.points[i] = {points[i][0].get<double>() / 100, points[i][2].get<double>() / 100,
                           -points[i][1].get<double>() / 100};
        }
        p.uv = row.at("UVPoints").get<decltype(p.uv)>();
        p.lightmap_rect = row.at("LightMapPoint").get<decltype(p.lightmap_rect)>();
        patches.push_back(std::move(p));
    }
    Terrain terrain(std::move(patches));
    terrain.map_root_ =
        path.parent_path().empty() ? std::filesystem::current_path() : std::filesystem::absolute(path.parent_path());
    return terrain;
}

Terrain Terrain::demo() {
    std::vector<Patch> patches;
    for (unsigned segment = 0; segment < 12; ++segment) {
        Patch p;
        p.name = "Original prototype slope " + std::to_string(segment);
        for (unsigned u = 0; u < 4; ++u)
            for (unsigned v = 0; v < 4; ++v) {
                const auto distance = (segment + u / 3.0) * 40;
                const auto x = (v / 3.0 - 0.5) * 60;
                p.points[u * 4 + v] = {x, 80 - distance * 0.13 + 0.002 * x * x, -distance};
            }
        patches.push_back(std::move(p));
    }
    return Terrain(std::move(patches));
}

int Terrain::build_node(std::size_t begin, std::size_t end) {
    const auto index = static_cast<int>(nodes_.size());
    nodes_.push_back({});
    Bounds b;
    for (auto i = begin; i < end; ++i) {
        const auto pb = patches_[order_[i]].bounds();
        b.add(pb.min);
        b.add(pb.max);
    }
    nodes_[index] = {b, begin, end, -1, -1};
    if (end - begin > 8) {
        const auto span = b.max - b.min;
        const int axis = span.x > span.y && span.x > span.z ? 0 : span.y > span.z ? 1 : 2;
        const auto center = [&](std::size_t p) {
            const auto c = patches_[p].bounds().center();
            return axis == 0 ? c.x : axis == 1 ? c.y : c.z;
        };
        const auto mid = begin + (end - begin) / 2;
        std::nth_element(order_.begin() + begin, order_.begin() + mid, order_.begin() + end,
                         [&](auto a, auto c) { return center(a) < center(c); });
        const auto left = build_node(begin, mid), right = build_node(mid, end);
        nodes_[index].left = left;
        nodes_[index].right = right;
    }
    return index;
}

void Terrain::intersect_node(int node, Vec3 start, Vec3 direction, bool front_faces_only,
                             std::optional<TerrainHit>& hit) const {
    const auto& n = nodes_[node];
    if (!n.bounds.intersects(start, direction))
        return;
    if (n.left >= 0) {
        intersect_node(n.left, start, direction, front_faces_only, hit);
        intersect_node(n.right, start, direction, front_faces_only, hit);
        return;
    }
    for (auto i = n.begin; i < n.end; ++i) {
        const auto index = order_[i];
        const auto& p = patches_[index];
        if (p.surface == 17 || !p.bounds().intersects(start, direction))
            continue;
        const auto& sample = samples_[index].points;
        for (unsigned u = 0; u < 8; ++u)
            for (unsigned v = 0; v < 8; ++v) {
                const auto a = sample[u * 9 + v], b = sample[(u + 1) * 9 + v], c = sample[(u + 1) * 9 + v + 1],
                           d = sample[u * 9 + v + 1];
                const auto accept = [&](const std::optional<TriangleHit>& coarse, bool second) {
                    if (!coarse)
                        return;
                    const auto du = second ? coarse->a : coarse->a + coarse->b;
                    const auto dv = second ? coarse->a + coarse->b : coarse->b;
                    auto candidate = refine(p, index, start, direction, (u + du) / 8, (v + dv) / 8, coarse->t);
                    if (candidate && (!front_faces_only || dot(direction, candidate->normal) < 0) &&
                        (!hit || candidate->t < hit->t))
                        hit = *candidate;
                };
                accept(triangle_seed(start, direction, a, b, c), false);
                accept(triangle_seed(start, direction, a, c, d), true);
            }
    }
}

std::optional<TerrainHit> Terrain::intersect(Vec3 start, Vec3 end, bool front_faces_only) const {
    if (!finite(start) || !finite(end) || length(end - start) < 1e-12)
        return {};
    std::optional<TerrainHit> hit;
    intersect_node(0, start, end - start, front_faces_only, hit);
    return hit;
}

Vec3 Terrain::clear_eye(Vec3 eye, Vec3 safe, double radius) const {
    if (!finite(eye) || !finite(safe) || !std::isfinite(radius) || radius <= 0)
        throw std::invalid_argument("Invalid camera sphere");
    for (unsigned pass = 0; pass < 4; ++pass) {
        std::optional<ShapeContact> deepest;
        const auto visit = [&](auto&& self, int index) -> void {
            const auto& node = nodes_[index];
            double distance = 0;
            const std::array<double, 3> p{eye.x, eye.y, eye.z},
                lo{node.bounds.min.x, node.bounds.min.y, node.bounds.min.z},
                hi{node.bounds.max.x, node.bounds.max.y, node.bounds.max.z};
            for (unsigned k = 0; k < 3; ++k) {
                const auto d = p[k] - std::clamp(p[k], lo[k], hi[k]);
                distance += d * d;
            }
            if (distance > radius * radius)
                return;
            if (node.left >= 0) {
                self(self, node.left);
                self(self, node.right);
                return;
            }
            for (auto i = node.begin; i < node.end; ++i) {
                const auto patch = order_[i];
                if (patches_[patch].surface == 17)
                    continue;
                const auto& v = samples_[patch].points;
                for (unsigned u = 0; u < 8; ++u)
                    for (unsigned w = 0; w < 8; ++w) {
                        const auto a = v[u * 9 + w], b = v[(u + 1) * 9 + w], c = v[(u + 1) * 9 + w + 1],
                                   d = v[u * 9 + w + 1];
                        for (const auto& hit : {swept_triangle(a, b, c, {eye, radius}, {eye, radius}),
                                                swept_triangle(a, c, d, {eye, radius}, {eye, radius})})
                            if (hit && (!deepest || hit->depth > deepest->depth))
                                deepest = hit;
                    }
            }
        };
        visit(visit, 0);
        if (!deepest || deepest->depth < 1e-5)
            break;
        auto normal = deepest->normal;
        if (dot(normal, safe - deepest->point) < 0)
            normal = -normal;
        eye = deepest->point + normal * (radius + .001);
    }
    return eye;
}

std::optional<TerrainHit> Terrain::sweep(Vec3 start, Vec3 end, double radius) const {
    const std::array<ProbeSphere, 1> from{{{start, radius}}}, to{{{end, radius}}};
    return sweep(from, to, false);
}

std::optional<TerrainHit> Terrain::sweep(std::span<const ProbeSphere> start, std::span<const ProbeSphere> end,
                                         bool skip_separating) const {
    const auto hits = body_contacts(start, end, skip_separating);
    std::optional<TerrainHit> closest;
    for (const auto& hit : hits)
        if (!closest || hit.t < closest->t || (hit.t == closest->t && hit.depth > closest->depth))
            closest = hit;
    return closest;
}

std::vector<TerrainHit> Terrain::body_contacts(std::span<const ProbeSphere> start, std::span<const ProbeSphere> end,
                                               bool skip_separating) const {
    if (start.size() != end.size() || start.size() > 32768)
        throw std::invalid_argument("Invalid terrain compound sweep");
    if (start.empty())
        return {};
    std::vector<std::optional<TerrainHit>> contacts(start.size());
    Bounds swept;
    std::vector<Bounds> bounds;
    for (std::size_t i = 0; i < start.size(); ++i) {
        Bounds box;
        for (const auto probe : {start[i], end[i]}) {
            if (!finite(probe.centre) || !std::isfinite(probe.radius) || probe.radius <= 0)
                throw std::invalid_argument("Invalid terrain sphere sweep");
            const Vec3 r{probe.radius, probe.radius, probe.radius};
            box.add(probe.centre - r);
            box.add(probe.centre + r);
        }
        swept.add(box.min);
        swept.add(box.max);
        bounds.push_back(box);
    }
    const auto overlaps = [](const Bounds& a, const Bounds& b) {
        return a.min.x <= b.max.x && a.max.x >= b.min.x && a.min.y <= b.max.y && a.max.y >= b.min.y &&
               a.min.z <= b.max.z && a.max.z >= b.min.z;
    };
    const auto relevant = [&](const Bounds& box) {
        if (start.size() != 1 || !contacts[0])
            return true;
        const auto& hit = *contacts[0];
        const auto radius = std::max(start[0].radius, end[0].radius);
        if (hit.t == 0 && hit.depth > 0) {
            // An initial overlap already wins on time. Only a nearer feature
            // can improve its depth; the control box bounds that distance.
            const auto centre = start[0].centre;
            const Vec3 nearest{std::clamp(centre.x, box.min.x, box.max.x), std::clamp(centre.y, box.min.y, box.max.y),
                               std::clamp(centre.z, box.min.z, box.max.z)};
            const auto delta = centre - nearest;
            const auto distance = std::max(0., radius - hit.depth);
            return dot(delta, delta) <= distance * distance + 1e-12;
        }
        // A later cell cannot beat the first known impact. Clip only the
        // broad-phase search, retaining the original sweep for contact math.
        const auto finish = start[0].centre + (end[0].centre - start[0].centre) * hit.t;
        const Vec3 r{radius, radius, radius};
        Bounds clipped;
        clipped.add(start[0].centre - r);
        clipped.add(start[0].centre + r);
        clipped.add(finish - r);
        clipped.add(finish + r);
        return overlaps(box, clipped);
    };
    const auto visit = [&](auto&& self, int index) -> void {
        const auto& node = nodes_[index];
        if (node.bounds.max.x < swept.min.x || node.bounds.min.x > swept.max.x || node.bounds.max.y < swept.min.y ||
            node.bounds.min.y > swept.max.y || node.bounds.max.z < swept.min.z || node.bounds.min.z > swept.max.z)
            return;
        if (node.left >= 0) {
            self(self, node.left);
            self(self, node.right);
            return;
        }
        for (auto i = node.begin; i < node.end; ++i) {
            const auto patch = order_[i];
            if (patches_[patch].surface == 17)
                continue;
            auto leaf = [&](Vec3 a, Vec3 b, Vec3 c, Vec3 d, const Bounds& quad) {
                for (std::size_t sphere = 0; sphere < start.size(); ++sphere) {
                    if (!overlaps(quad, bounds[sphere]))
                        continue;
                    auto& closest = contacts[sphere];
                    for (const auto& hit : {swept_triangle(a, b, c, start[sphere], end[sphere]),
                                            swept_triangle(a, c, d, start[sphere], end[sphere])})
                        if (hit &&
                            !(skip_separating && hit->depth <= 1e-8 &&
                              dot(end[sphere].centre - start[sphere].centre, hit->normal) >= -1e-9) &&
                            (!closest || hit->t < closest->t || (hit->t == closest->t && hit->depth > closest->depth)))
                            closest = TerrainHit{hit->point, hit->normal, hit->t, 0, 0, patch, patches_[patch].surface,
                                                 false,      hit->depth,  sphere};
                }
            };
            collision_cache_->visit(patch, patches_[patch].points, swept, leaf, relevant);
        }
    };
    const std::lock_guard cache_lock(collision_cache_->mutex);
    visit(visit, 0);
    std::vector<TerrainHit> result;
    for (const auto& contact : contacts)
        if (contact)
            result.push_back(*contact);
    return result;
}

Mesh Terrain::mesh(unsigned subdivisions) const {
    if (subdivisions < 1 || subdivisions > 32)
        throw std::runtime_error("Terrain subdivisions must be 1..32");
    if (patches_.size() * (subdivisions + 1) * (subdivisions + 1) > 8000000)
        throw std::runtime_error("Requested terrain mesh exceeds 8 million vertices");
    Mesh mesh;
    mesh.map_root = map_root_;
    std::map<std::pair<std::string, int>, std::vector<const Patch*>> groups;
    for (const auto& patch : patches_)
        groups[{patch.texture, patch.lightmap_rect[2] > 0 && patch.lightmap_rect[3] > 0 ? patch.lightmap : -1}]
            .push_back(&patch);
    for (const auto& [material, patches] : groups) {
        MeshBatch batch{static_cast<std::uint32_t>(mesh.indices.size()), 0, material.first, material.second};
        for (const auto* patch : patches) {
            const auto& p = *patch;
            const auto range_first = static_cast<std::uint32_t>(mesh.indices.size());
            Bounds render_bounds;
            const auto first = static_cast<std::uint32_t>(mesh.vertices.size());
            for (unsigned u = 0; u <= subdivisions; ++u)
                for (unsigned v = 0; v <= subdivisions; ++v) {
                    const auto point = p.evaluate(u / double(subdivisions), v / double(subdivisions));
                    const auto normal = p.normal(u / double(subdivisions), v / double(subdivisions));
                    const auto light =
                        static_cast<float>(.48 + .52 * std::max(0.0, dot(normal, normalized(Vec3{-.3, .9, .2}))));
                    const auto ice = p.surface == 5;
                    const auto rock = p.surface == 9;
                    const auto uv = p.texture_uv(u / double(subdivisions), v / double(subdivisions)),
                               lm = p.lightmap_uv(u / double(subdivisions), v / double(subdivisions));
                    mesh.vertices.push_back(
                        {static_cast<float>(point.x), static_cast<float>(point.y), static_cast<float>(point.z),
                         light * (rock  ? .48f
                                  : ice ? .55f
                                        : .91f),
                         light * (rock  ? .44f
                                  : ice ? .82f
                                        : .96f),
                         light, float(uv[0]), float(uv[1]), float(lm[0]), float(lm[1]), float(p.lightmap_rect[0]),
                         float(p.lightmap_rect[1]), float(p.lightmap_rect[2]), float(p.lightmap_rect[3])});
                    const auto& vertex = mesh.vertices.back();
                    render_bounds.add({vertex.x, vertex.y, vertex.z});
                }
            for (unsigned u = 0; u < subdivisions; ++u)
                for (unsigned v = 0; v < subdivisions; ++v) {
                    const auto a = first + u * (subdivisions + 1) + v, b = a + subdivisions + 1;
                    mesh.indices.insert(mesh.indices.end(), {a, b, b + 1, a, b + 1, a + 1});
                }
            mesh.terrain_ranges.push_back({range_first, static_cast<std::uint32_t>(mesh.indices.size()) - range_first,
                                           static_cast<std::uint32_t>(mesh.batches.size()), render_bounds});
        }
        batch.count = static_cast<std::uint32_t>(mesh.indices.size()) - batch.first;
        mesh.batches.push_back(std::move(batch));
    }
    return mesh;
}

std::pair<Vec3, Vec3> Terrain::spawn() const {
    const auto paths = CoursePaths::load(map_root_);
    if (const auto start = paths.start_pose())
        return *start;
    if (const auto marker = start_marker(map_root_))
        return *marker;
    if (!paths.race.empty())
        return paths.race.front().pose(4);
    const Patch* best = nullptr;
    double height = -std::numeric_limits<double>::infinity();
    for (const auto& p : patches_) {
        if (p.surface == 0 || p.surface == 17 || p.normal(.5, .5).y < .5)
            continue;
        const auto y = std::max(p.evaluate(.03, .5).y, p.evaluate(.97, .5).y);
        if (y > height) {
            height = y;
            best = &p;
        }
    }
    if (!best)
        throw std::runtime_error("No rideable skyward terrain found");
    const auto u = best->evaluate(.03, .5).y > best->evaluate(.97, .5).y ? .03 : .97;
    const auto position = best->evaluate(u, .5);
    auto downhill = project(Vec3{0, -1, 0}, best->normal(u, .5));
    if (length(downhill) < .01)
        downhill = best->tangents(u, .5)[0];
    return {position, normalized(downhill, {0, 0, -1})};
}
} // namespace openslope
