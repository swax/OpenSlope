#include "openslope/appearance.hpp"
#include "openslope/paths.hpp"
#include "openslope/terrain.hpp"
#include "terrain.hpp"
#include <algorithm>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <tuple>

namespace openslope::import_detail::gba {
Json write_rails(const Geometry& geometry, const std::filesystem::path& output, const ImportCancel& cancel);

namespace {
void scenery(const Geometry& g, const std::vector<Face>& all, const std::set<unsigned>& terrain,
             const std::filesystem::path& out) {
    std::filesystem::create_directories(out / "Meshes");
    std::filesystem::create_directories(out / "Collision");

    struct Prop {
        std::vector<Face> faces;
        std::vector<std::array<unsigned, 3>> collision;
        Vec3 low{std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity(),
                 std::numeric_limits<double>::infinity()};
        Vec3 high{-std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity(),
                  -std::numeric_limits<double>::infinity()};
        std::string name;
    };

    std::vector<Face> source;
    for (const auto& f : all)
        if (!terrain.contains(f.record))
            source.push_back(f);
    for (unsigned i = 0; i < g.records.size(); ++i)
        if (const auto& r = g.records[i]; (r.tag & 63) == 7)
            source.push_back({r.vertices, {}, i, 7, 0, r.last, {}, false});

    // Position-only source vertices can repeat at UV/material seams. Weld their
    // identities before finding edge-connected objects, keeping both alpha groups together.
    std::map<std::array<double, 3>, unsigned> positions;
    std::vector<unsigned> welded;
    for (const auto& point : g.points)
        welded.push_back(positions.try_emplace({point.x, point.y, point.z}, unsigned(positions.size())).first->second);
    std::vector<unsigned> parent(source.size());
    for (unsigned i = 0; i < parent.size(); ++i)
        parent[i] = i;
    const auto root = [&](unsigned i) {
        while (parent[i] != i) {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        return i;
    };
    std::map<std::array<unsigned, 2>, unsigned> edges;
    for (unsigned i = 0; i < source.size(); ++i)
        for (unsigned j = 0; j < 3; ++j) {
            const auto a = welded[source[i].ids[j]], b = welded[source[i].ids[(j + 1) % 3]];
            if (a == b)
                continue;
            const auto [edge, inserted] = edges.try_emplace({std::min(a, b), std::max(a, b)}, i);
            if (!inserted) {
                const auto x = root(i), y = root(edge->second);
                parent[std::max(x, y)] = std::min(x, y);
            }
        }
    std::map<unsigned, std::vector<Face>> components;
    for (unsigned i = 0; i < source.size(); ++i)
        components[root(i)].push_back(source[i]);

    const auto cell_for = [&](const std::array<unsigned, 3>& ids) {
        const auto centre = (g.points[ids[0]] + g.points[ids[1]] + g.points[ids[2]]) / 3.;
        return std::pair{int(std::floor(centre.x / 100)), int(std::floor(centre.z / 100))};
    };
    const auto expand = [&](Prop& prop, const Face& face) {
        for (auto id : face.ids) {
            const auto p = g.points[id];
            prop.low = {std::min(prop.low.x, p.x), std::min(prop.low.y, p.y), std::min(prop.low.z, p.z)};
            prop.high = {std::max(prop.high.x, p.x), std::max(prop.high.y, p.y), std::max(prop.high.z, p.z)};
        }
    };
    std::vector<Prop> props;
    unsigned object = 0;
    for (const auto& [component, faces] : components) {
        Prop bounds;
        for (const auto& face : faces)
            expand(bounds, face);
        const bool split = bounds.high.x - bounds.low.x > 100 || bounds.high.z - bounds.low.z > 100;
        std::map<std::pair<int, int>, Prop> parts;
        for (const auto& f : faces) {
            auto& part = parts[split ? cell_for(f.ids) : std::pair{0, 0}];
            expand(part, f);
            if (f.kind != 7)
                part.faces.push_back(f);
            if (f.kind == 2 || f.kind == 3 || f.kind == 7)
                part.collision.push_back(f.ids);
        }
        unsigned piece = 0;
        const bool collision_only = std::all_of(faces.begin(), faces.end(), [](const auto& f) { return f.kind == 7; });
        for (auto& [cell, prop] : parts) {
            prop.name = (collision_only ? "GBA collision " : "GBA prop ") + std::to_string(object);
            if (parts.size() > 1)
                prop.name += " part " + std::to_string(piece++);
            props.push_back(std::move(prop));
        }
        ++object;
    }

    Json models = Json::array(), instances = Json::array();
    unsigned mesh_serial = 0, collision_serial = 0;
    for (auto& prop : props) {
        // A base-centred pivot makes an imported object useful as a placed prop.
        // Only long connected structures are subdivided for camera-range queries.
        const Vec3 origin{(prop.low.x + prop.high.x) * .5, prop.low.y, (prop.low.z + prop.high.z) * .5};
        const bool visible = !prop.faces.empty();
        if (!visible)
            for (const auto& ids : prop.collision)
                prop.faces.push_back({ids, {}, 0, 7, 0, 0, {}, false}); // Hidden mesh supplies collider bounds.
        Json parts = Json::array();
        for (unsigned group = 0; group < 2; ++group) {
            std::ostringstream obj;
            obj << std::setprecision(12);
            unsigned vertex = 0;
            for (const auto& f : prop.faces)
                if (f.keyed == bool(group)) {
                    for (unsigned j = 0; j < 3; ++j) {
                        const auto p = raw(g.points[f.ids[j]] - origin);
                        obj << "v " << p[0].get<double>() << ' ' << p[1].get<double>() << ' ' << p[2].get<double>()
                            << '\n';
                        obj << "vt " << f.uv[j][0] << ' ' << 1 - f.uv[j][1] << '\n';
                    }
                    obj << "f " << vertex + 1 << '/' << vertex + 1 << ' ' << vertex + 2 << '/' << vertex + 2 << ' '
                        << vertex + 3 << '/' << vertex + 3 << '\n';
                    vertex += 3;
                }
            if (vertex) {
                const auto name = "gba-scenery-" + std::to_string(mesh_serial++) + ".obj";
                std::ofstream file(out / "Meshes" / name);
                file << obj.str();
                require(bool(file), "Cannot write GBA scenery");
                parts.push_back({{"MeshPath", name}, {"MaterialID", group}});
            }
        }
        Json paths = Json::array();
        if (!prop.collision.empty()) {
            const auto name = "gba-world" + (collision_serial ? "-" + std::to_string(collision_serial) : "") + ".obj";
            ++collision_serial;
            std::ofstream col(out / "Collision" / name);
            col << std::setprecision(12);
            unsigned vertex = 0;
            for (const auto& ids : prop.collision) {
                for (auto id : ids) {
                    const auto p = raw(g.points[id] - origin);
                    col << "v " << p[0].get<double>() << ' ' << p[1].get<double>() << ' ' << p[2].get<double>() << '\n';
                }
                col << "f " << vertex + 1 << ' ' << vertex + 2 << ' ' << vertex + 3 << '\n';
                vertex += 3;
            }
            require(bool(col), "Cannot write GBA collision");
            paths.push_back(name);
        }
        const auto id = models.size();
        Json model{{"ModelName", prop.name},
                   {"ModelObjects", {{{"ObjectName", "GBA source mesh"}, {"ParentID", -1}, {"MeshData", parts}}}}};
        if (!paths.empty())
            model["PlacementCollisionPath"] = paths[0];
        models.push_back(model);
        instances.push_back({{"InstanceName", prop.name},
                             {"ModelID", id},
                             {"Location", raw(origin)},
                             {"Rotation", {0, 0, 0, 1}},
                             {"Scale", {1, 1, 1}},
                             {"Visable", visible},
                             {"PlayerCollision", !paths.empty()},
                             {"CollsionMode", paths.empty() ? 0 : 1},
                             {"CollsionModelPaths", paths},
                             {"SurfaceType", 1},
                             {"U0", 1},
                             {"PlayerBounce", !paths.empty()},
                             {"PlayerBounceAmmount", 0},
                             {"IncludeSound", false},
                             {"AmbentLightColour", {256, 256, 256}}});
    }
    save(out / "Materials.json", {{"Materials",
                                   {{{"TexturePath", "gba-opaque.png"}, {"AlphaMode", "opaque"}},
                                    {{"TexturePath", "gba-keyed.png"}, {"AlphaMode", "cutout"}}}}});
    save(out / "TextureAlpha.overrides.json", {{"gba-opaque.png", "opaque"}, {"gba-keyed.png", "cutout"}});
    save(out / "Models.json", {{"Models", models}});
    save(out / "Instances.json", {{"Instances", instances}});
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
    const auto all = terrain_faces(geometry, textures);
    const auto terrain = terrain_patches(geometry, all, cancel);
    const auto& patches = terrain.patches;
    require(!patches.empty(), "GBA course has no terrain");
    save(out / "Patches.json", {{"Patches", patches}});
    notify("Converting GBA scenery and collision");
    scenery(geometry, all, terrain.records, out);
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
          {"PairedTrianglePatches", terrain.paired},
          {"FlatColourQuadPatches", terrain.flat},
          {"UnpairedTrianglePatches", terrain.triangles},
          {"QuadSplitTriangles", 0},
          {"CurvedTerrainEdges", terrain.curved_edges},
          {"LinearHangingEdges", 0},
          {"FittedTerrainPatches", terrain.fitted},
          {"DisplayTriangles", all.size()},
          {"Rails", rails},
          {"Environment", sky},
          {"GeometryPolicy", "Compatible faces are rematched into the most quads; isolated faces stay single patches. "
                             "Shared boundary curves and fitted interior heights smooth joins up to 20 degrees."},
          {"SpawnPolicy", "section route re-seated on converted terrain; final guard omitted"},
          {"Deferred",
           {"native-pickup-checkpoint-placement", "type6-event-billboards", "original-music-scheduling",
            "hardware-noise-emulation"}},
          {"Outputs",
           {"Patches.json", "Textures", "Models.json", "Instances.json", "Materials.json", "Meshes", "Collision",
            "AIP.json", "Splines.json", "Skybox", "Audio", "Origin.json"}}});
}
} // namespace openslope::import_detail::gba
