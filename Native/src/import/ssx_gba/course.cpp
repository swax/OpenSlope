#include "assets.hpp"
#include "openslope/appearance.hpp"
#include "openslope/paths.hpp"
#include "openslope/terrain.hpp"
#include <algorithm>
#include <fstream>
#include <iomanip>
#include <map>
#include <set>
#include <sstream>

namespace openslope::import_detail::gba {
Json write_rails(const Geometry& geometry, const std::filesystem::path& output, const ImportCancel& cancel);

namespace {
using UV = std::array<double, 2>;

struct Face {
    std::array<unsigned, 3> ids;
    std::array<UV, 3> uv;
    unsigned record, kind, material, flags;
    Vec3 normal;
    bool keyed;
};

std::vector<Face> faces(const Geometry& g, const Textures& t) {
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

Json patch(const Geometry& g, std::array<unsigned, 4> q, std::array<UV, 4> uv, unsigned source) {
    // GBA triangle records carry mixed winding. Portable analytic terrain is one-sided;
    // transpose the parameter frame and its UV corners together to expose the skyward side.
    const auto du = g.points[q[1]] + g.points[q[3]] - g.points[q[0]] - g.points[q[2]];
    const auto dv = g.points[q[2]] + g.points[q[3]] - g.points[q[0]] - g.points[q[1]];
    if (cross(du, dv).y < 0) {
        std::swap(q[1], q[2]);
        std::swap(uv[1], uv[2]);
    }
    Json controls = Json::array();
    for (unsigned i = 0; i < 4; ++i)
        for (unsigned j = 0; j < 4; ++j) {
            const double u = i / 3., v = j / 3.;
            controls.push_back(raw(g.points[q[0]] * ((1 - u) * (1 - v)) + g.points[q[1]] * (u * (1 - v)) +
                                   g.points[q[2]] * ((1 - u) * v) + g.points[q[3]] * (u * v)));
        }
    return {{"PatchName", "GBA surface " + std::to_string(source)},
            {"Points", controls},
            {"UVPoints", uv},
            {"TexturePath", "gba-opaque.png"},
            {"SurfaceType", 1},
            {"LightmapID", -1},
            {"LightMapPoint", {0, 0, 0, 0}},
            {"TrickOnlyPatch", false},
            {"SourceRecord", source}};
}

void scenery(const Geometry& g, const std::vector<Face>& all, const std::set<unsigned>& terrain,
             const std::filesystem::path& out) {
    std::filesystem::create_directories(out / "Meshes");
    std::filesystem::create_directories(out / "Collision");
    Json parts = Json::array();
    for (unsigned group = 0; group < 2; ++group) {
        std::ostringstream obj;
        obj << std::setprecision(12);
        unsigned vertex = 0;
        for (const auto& f : all)
            if (!terrain.contains(f.record) && f.keyed == bool(group)) {
                for (unsigned j = 0; j < 3; ++j) {
                    const auto p = raw(g.points[f.ids[j]]);
                    obj << "v " << p[0].get<double>() << ' ' << p[1].get<double>() << ' ' << p[2].get<double>() << '\n';
                    obj << "vt " << f.uv[j][0] << ' ' << 1 - f.uv[j][1] << '\n';
                }
                obj << "f " << vertex + 1 << '/' << vertex + 1 << ' ' << vertex + 2 << '/' << vertex + 2 << ' '
                    << vertex + 3 << '/' << vertex + 3 << '\n';
                vertex += 3;
            }
        if (vertex) {
            const auto name = "gba-scenery-" + std::to_string(group) + ".obj";
            std::ofstream file(out / "Meshes" / name);
            file << obj.str();
            require(bool(file), "Cannot write GBA scenery");
            parts.push_back({{"MeshPath", name}, {"MaterialID", group}});
        }
    }
    save(out / "Materials.json", {{"Materials",
                                   {{{"TexturePath", "gba-opaque.png"}, {"AlphaMode", "opaque"}},
                                    {{"TexturePath", "gba-keyed.png"}, {"AlphaMode", "cutout"}}}}});
    save(out / "TextureAlpha.overrides.json", {{"gba-opaque.png", "opaque"}, {"gba-keyed.png", "cutout"}});
    save(out / "Models.json",
         {{"Models",
           {{{"ModelName", "GBA scenery"},
             {"PlacementCollisionPath", "gba-world.obj"},
             {"ModelObjects", {{{"ObjectName", "GBA source mesh"}, {"ParentID", -1}, {"MeshData", parts}}}}}}}});
    Json instance{{"InstanceName", "GBA scenery and collision"},
                  {"ModelID", 0},
                  {"Location", {0, 0, 0}},
                  {"Rotation", {0, 0, 0, 1}},
                  {"Scale", {1, 1, 1}},
                  {"Visable", true},
                  {"PlayerCollision", true},
                  {"CollsionMode", 1},
                  {"CollsionModelPaths", {"gba-world.obj"}},
                  {"SurfaceType", 1},
                  {"U0", 1},
                  {"PlayerBounce", true},
                  {"PlayerBounceAmmount", 0},
                  {"AmbentLightColour", {256, 256, 256}}};
    save(out / "Instances.json", {{"Instances", {instance}}});
    std::ofstream col(out / "Collision/gba-world.obj");
    col << std::setprecision(12);
    for (const auto& p : g.points) {
        const auto r = raw(p);
        col << "v " << r[0].get<double>() << ' ' << r[1].get<double>() << ' ' << r[2].get<double>() << '\n';
    }
    for (const auto& f : all)
        if (!terrain.contains(f.record) && (f.kind == 2 || f.kind == 3))
            col << "f " << f.ids[0] + 1 << ' ' << f.ids[1] + 1 << ' ' << f.ids[2] + 1 << '\n';
    for (const auto& r : g.records)
        if ((r.tag & 63) == 7)
            col << "f " << r.vertices[0] + 1 << ' ' << r.vertices[1] + 1 << ' ' << r.vertices[2] + 1 << '\n';
    require(bool(col), "Cannot write GBA collision");
}

void route(const Geometry& g, const Terrain& terrain, const std::filesystem::path& out) {
    auto nodes = g.route;
    if (nodes.size() > 2)
        nodes.pop_back(); // Source guard section is not a finish waypoint.
    auto first = nodes.front();
    bool seated = false;
    for (unsigned i = 0; i < std::min<std::size_t>(nodes.size() - 1, 8); ++i) {
        if (const auto hit = terrain.intersect(nodes[i] + Vec3{0, 2, 0}, nodes[i] - Vec3{0, 40, 0});
            hit && hit->normal.y > .35) {
            first = hit->point;
            nodes.erase(nodes.begin(), nodes.begin() + i);
            nodes.front() = first;
            seated = true;
            break;
        }
    }
    require(seated, "No supported GBA starting surface was found");
    Json deltas = Json::array();
    for (unsigned i = 1; i < nodes.size(); ++i)
        deltas.push_back(raw(nodes[i] - nodes[i - 1]));
    save(out / "AIP.json", {{"AIPaths",
                             {{{"Type", 2},
                               {"PathPos", raw(first)},
                               {"PathPoints", deltas},
                               {"U3", 50},
                               {"Respawnable", true},
                               {"PathEvents", Json::array()}}}},
                            {"RaceLines", Json::array()},
                            {"StartPosList", {0}}});
}
} // namespace

void write_course(const Rom& rom, const Course& course, const std::filesystem::path& out,
                  const ImportProgress& progress, const ImportCancel& cancel) {
    const auto notify = [&](const char* message) {
        check_cancel(cancel);
        if (progress)
            progress(message);
    };
    notify("Decoding GBA terrain and textures");
    const Geometry geometry{rom.resource(course.geometry), cancel};
    const Textures textures{rom.resource(course.textures), cancel};
    std::filesystem::create_directories(out / "Textures");
    write_png(out / "Textures/gba-opaque.png", textures.opaque);
    write_png(out / "Textures/gba-keyed.png", textures.keyed);
    const auto all = faces(geometry, textures);
    Json patches = Json::array();
    std::set<unsigned> terrain, consumed;
    std::map<std::array<unsigned, 4>, std::vector<unsigned>> partners;
    for (unsigned i = 0; i < all.size(); ++i) {
        const auto& f = all[i];
        if (f.kind == 3 && !f.keyed)
            partners[{f.material, f.flags, f.ids[2], f.ids[0]}].push_back(i);
    }
    unsigned pairs = 0;
    for (const auto& f : all) {
        check_cancel(cancel);
        if (f.kind < 2 || f.kind > 4 || f.keyed || consumed.contains(f.record))
            continue;
        if (f.kind == 2) {
            const auto found = partners.find({f.material, f.flags, f.ids[0], f.ids[2]});
            if (found != partners.end() && found->second.size() == 1) {
                const auto& other = all[found->second.front()];
                const std::array<unsigned, 4> q{f.ids[1], f.ids[0], f.ids[2], other.ids[1]};
                const auto deviation = length(geometry.points[q[0]] + geometry.points[q[3]] - geometry.points[q[1]] -
                                              geometry.points[q[2]]) /
                                       4;
                const auto edge0 = geometry.points[q[1]] - geometry.points[q[0]],
                           edge1 = geometry.points[q[2]] - geometry.points[q[0]];
                bool convex = true;
                const std::array<unsigned, 4> ring{q[0], q[1], q[3], q[2]};
                const auto normal = cross(edge0, edge1);
                for (unsigned i = 0; i < 4; ++i)
                    convex &= dot(cross(geometry.points[ring[(i + 1) % 4]] - geometry.points[ring[i]],
                                        geometry.points[ring[(i + 2) % 4]] - geometry.points[ring[(i + 1) % 4]]),
                                  normal) > 1e-10;
                if (!consumed.contains(other.record) && std::set(q.begin(), q.end()).size() == 4 && convex &&
                    dot(f.normal, other.normal) >= std::cos(20 * pi / 180) && deviation <= .05) {
                    patches.push_back(patch(geometry, q, {f.uv[1], f.uv[0], f.uv[2], other.uv[1]}, f.record));
                    consumed.insert(other.record);
                    terrain.insert(other.record);
                    consumed.insert(f.record);
                    terrain.insert(f.record);
                    ++pairs;
                    continue;
                }
            }
        }
        patches.push_back(
            patch(geometry, {f.ids[0], f.ids[1], f.ids[2], f.ids[2]}, {f.uv[0], f.uv[1], f.uv[2], f.uv[2]}, f.record));
        consumed.insert(f.record);
        terrain.insert(f.record);
    }
    require(!patches.empty(), "GBA course has no terrain");
    save(out / "Patches.json", {{"Patches", patches}});
    notify("Converting GBA scenery and collision");
    scenery(geometry, all, terrain, out);
    notify("Tracing GBA grind surfaces");
    const auto rails = write_rails(geometry, out, cancel);
    notify("Converting GBA horizon");
    const auto sky = write_sky(rom, course, out, cancel);
    notify("Converting GBA riding sounds");
    write_audio(rom, out, cancel);
    notify("Preparing GBA music");
    write_music(rom, course, out, progress, cancel);
    notify("Validating GBA terrain and supported start");
    const auto loaded = Terrain::load(out);
    route(geometry, loaded, out);
    require(Appearance::load(loaded).missing.empty(), "GBA terrain textures are missing");
    static_cast<void>(CoursePaths::load(out));
    save(out / "Origin.json", {{"Schema", "openslope-origin/v1"},
                               {"Origin", "retail"},
                               {"Game", "ssx-tricky-gba"},
                               {"Course", course.id},
                               {"RetailData", true},
                               {"Reasons", {"retail-extract"}}});
    save(out / "Import.json",
         {{"Schema", "openslope-native-import/v1"},
          {"Game", "ssx-tricky-gba"},
          {"Course", course.id},
          {"Complete", false},
          {"SourceGameCode", "AXYE"},
          {"SourceRevision", 0},
          {"NativeCourseIndex", course.index},
          {"SourceGeometryResource", course.geometry},
          {"SourceTextureResource", course.textures},
          {"MetresPerSourceUnit", metres_per_unit},
          {"CreaseThresholdDegrees", 20},
          {"TerrainPatches", patches.size()},
          {"PairedTrianglePatches", pairs},
          {"DisplayTriangles", all.size()},
          {"Rails", rails},
          {"Environment", sky},
          {"GeometryPolicy",
           "UV-matched low-angle pairs become bilinear bicubics; remaining faces retain exact triangle geometry"},
          {"SpawnPolicy", "section route re-seated on converted terrain; final guard omitted"},
          {"Deferred",
           {"native-pickup-checkpoint-placement", "type6-event-billboards", "original-music-scheduling",
            "hardware-noise-emulation"}},
          {"Outputs",
           {"Patches.json", "Textures", "Models.json", "Instances.json", "Materials.json", "Meshes", "Collision",
            "AIP.json", "Splines.json", "Skybox", "Audio", "Origin.json"}}});
}
} // namespace openslope::import_detail::gba
