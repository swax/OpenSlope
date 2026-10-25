#include "formats.hpp"
#include "import/containers/disc.hpp"
#include "openslope/terrain.hpp"
#include <algorithm>
#include <fstream>
#include <iomanip>
#include <nlohmann/json.hpp>
#include <numeric>
#include <set>
#include <sstream>
#include <unordered_map>

namespace openslope::import_detail {
namespace {
using Json = nlohmann::json;

struct Vertex {
    Vec3 p;
    std::array<double, 2> uv{};
};

struct Triangle {
    std::array<Vertex, 3> v;
    unsigned material{}, source{};
};

struct Box {
    Vec3 min{1e100, 1e100, 1e100}, max{-1e100, -1e100, -1e100};

    void add(Vec3 p) {
        min = {std::min(min.x, p.x), std::min(min.y, p.y), std::min(min.z, p.z)};
        max = {std::max(max.x, p.x), std::max(max.y, p.y), std::max(max.z, p.z)};
    }

    bool contains(Vec3 p, double margin = 20) const {
        return p.x >= min.x - margin && p.x <= max.x + margin && p.y >= min.y - margin && p.y <= max.y + margin &&
               p.z >= min.z - margin && p.z <= max.z + margin;
    }

    double size() const { return length(max - min); }
};

struct Group {
    std::vector<Triangle> triangles, proxy;
    Box box;
    std::set<unsigned> sources;
    std::string name;
    Json original;
    bool tree{}, foliage{}, ground{}, helper{};
};

struct Union {
    std::vector<unsigned> parent;

    explicit Union(unsigned n) : parent(n) { std::iota(parent.begin(), parent.end(), 0); }

    unsigned root(unsigned i) { return parent[i] == i ? i : parent[i] = root(parent[i]); }

    void join(unsigned a, unsigned b) {
        a = root(a);
        b = root(b);
        if (a != b)
            parent[std::max(a, b)] = std::min(a, b);
    }
};

bool has(const std::string& name, std::initializer_list<std::string_view> keys) {
    for (auto key : keys)
        if (name.find(key) != std::string::npos)
            return true;
    return false;
}

std::string lower(std::string s) {
    for (auto& c : s)
        c = char(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

bool leaves(const std::string& s) { return has(s, {"branch", "leaves", "leaf", "cedar", "foliage", "grass"}); }

bool tree(const std::string& s) { return leaves(s) || has(s, {"tree", "trunk", "birch", "pine"}); }

bool ground(const std::string& s) {
    return has(s, {"cf_a", "cf_b", "cf_c"}) && !has(s, {"sculpt", "wall", "roof", "tree"});
}

bool effect(const std::string& s) {
    return has(s, {"pt_add", "spray", "smoke", "shadow", "envshdwoff", "glow"}) &&
           has(s, {"pt_add", "spray", "smoke", "shadow", "glow"});
}

Json read(const std::filesystem::path& p) {
    std::ifstream in(p);
    return Json::parse(in);
}

void save(const std::filesystem::path& p, const Json& j) {
    std::ofstream out(p);
    out << j.dump() << '\n';
    if (!out)
        throw std::runtime_error("Cannot write separated Avalanche props");
}

Vec3 point(const Json& p) { return {p[0].get<double>(), p[1].get<double>(), p[2].get<double>()}; }

Vec3 raw(Vec3 p) { return {-p.x, -p.z, p.y}; }

Vec3 source_point(Bytes b, std::size_t p) {
    return raw({std::bit_cast<float>(b.be(p)), std::bit_cast<float>(b.be(p + 4)), std::bit_cast<float>(b.be(p + 8))});
}

std::vector<Triangle> read_mesh(const std::filesystem::path& p, unsigned material) {
    std::ifstream in(p);
    if (!in)
        throw std::runtime_error("Missing Avalanche scenery mesh");
    std::vector<Vec3> pos;
    std::vector<std::array<double, 2>> uv;
    std::vector<Triangle> result;
    std::string line;
    while (std::getline(in, line)) {
        std::istringstream row(line);
        std::string key;
        row >> key;
        if (key == "v") {
            Vec3 v;
            row >> v.x >> v.y >> v.z;
            pos.push_back(v);
        } else if (key == "vt") {
            std::array<double, 2> t{};
            row >> t[0] >> t[1];
            uv.push_back(t);
        } else if (key == "f") {
            Triangle t{};
            t.material = material;
            for (auto& v : t.v) {
                unsigned a = 0, b = 0;
                char slash = 0;
                row >> a >> slash >> b;
                if (!a || !b || a > pos.size() || b > uv.size() || slash != '/')
                    throw std::runtime_error("Invalid generated Avalanche OBJ");
                v = {pos[a - 1], uv[b - 1]};
            }
            result.push_back(t);
        }
    }
    return result;
}

void add(Group& g, const Triangle& t) {
    g.triangles.push_back(t);
    g.sources.insert(t.source);
    for (const auto& v : t.v)
        g.box.add(v.p);
}

std::string mesh_text(const std::vector<Triangle>& tris, Vec3 pivot, bool textured) {
    std::ostringstream out;
    out << std::setprecision(12);
    unsigned n = 0;
    for (const auto& t : tris) {
        for (const auto& v : t.v) {
            auto p = v.p - pivot;
            out << "v " << p.x << ' ' << p.y << ' ' << p.z << '\n';
            if (textured)
                out << "vt " << v.uv[0] << ' ' << v.uv[1] << '\n';
        }
        out << "f";
        for (unsigned k = 1; k <= 3; ++k) {
            out << ' ' << n + k;
            if (textured)
                out << '/' << n + k;
        }
        out << '\n';
        n += 3;
    }
    return out.str();
}

void write(const std::filesystem::path& p, const std::string& text) {
    std::ofstream out(p);
    out << text;
    if (!out)
        throw std::runtime_error("Cannot write Avalanche prop mesh");
}

void cylinder(Group& g, Vec3 a, Vec3 b, double radius) {
    const auto axis = normalized(b - a),
               side = normalized(cross(axis, std::abs(axis.z) < .9 ? Vec3{0, 0, 1} : Vec3{1, 0, 0})),
               other = cross(axis, side);
    std::array<Vec3, 24> v{};
    for (unsigned k = 0; k < 12; ++k) {
        auto d = (side * std::cos(2 * pi * k / 12) + other * std::sin(2 * pi * k / 12)) * radius;
        v[k] = a + d;
        v[k + 12] = b + d;
    }
    const auto tri = [&](unsigned i, unsigned j, unsigned k) {
        g.proxy.push_back({{{{v[i], {}}, {v[j], {}}, {v[k], {}}}}, 0, 0});
    };
    for (unsigned k = 0; k < 12; ++k) {
        auto next = (k + 1) % 12;
        tri(k, next, next + 12);
        tri(k, next + 12, k + 12);
    }
    for (unsigned k = 1; k < 11; ++k) {
        tri(0, k + 1, k);
        tri(12, k + 12, k + 13);
    }
}

using Key = std::array<long long, 4>;

struct Hash {
    std::size_t operator()(const Key& k) const {
        std::size_t h = 0;
        for (auto v : k)
            h ^= std::hash<long long>{}(v) + 0x9e3779b9 + (h << 6) + (h >> 2);
        return h;
    }
};
} // namespace

Json refine_avalanche_props(const std::filesystem::path& output, Bytes col, const std::vector<std::string>& names,
                            const ImportCancel& cancel) {
    const auto models = read(output / "Models.json"), instances = read(output / "Instances.json");
    std::vector<std::string> labels;
    for (const auto& name : names)
        labels.push_back(lower(name));
    const auto label = [&](unsigned m) -> const std::string& {
        static const std::string empty;
        return m < labels.size() ? labels[m] : empty;
    };
    std::map<unsigned, std::vector<Triangle>> cached;
    std::set<std::filesystem::path> old_files;
    std::vector<Triangle> baked;
    std::vector<Group> groups;
    Json kept = Json::array();
    for (const auto& instance : instances.at("Instances")) {
        check_cancel(cancel);
        if (!instance.value("Visable", true)) {
            kept.push_back(instance);
            continue;
        }
        const auto id = instance.at("ModelID").get<unsigned>();
        const auto& model = models.at("Models").at(id);
        if (!cached.contains(id)) {
            auto& mesh = cached[id];
            for (const auto& object : model.at("ModelObjects"))
                for (const auto& sub : object.at("MeshData")) {
                    const auto file = output / "Meshes" / sub.at("MeshPath").get<std::string>();
                    old_files.insert(file);
                    auto part = read_mesh(file, sub.at("MaterialID").get<unsigned>());
                    mesh.insert(mesh.end(), part.begin(), part.end());
                }
        }
        const auto pivot = point(instance.at("Location"));
        const auto source = instance.value("SourceObjectIndex", 0u);
        const auto name = model.at("ModelName").get<std::string>();
        const bool helper = name.starts_with("QObj_");
        Group g;
        g.name = name;
        g.original = instance;
        g.helper = helper;
        for (auto t : cached.at(id)) {
            t.source = source;
            for (auto& v : t.v)
                v.p += pivot;
            if (instance.contains("SourcePlacementIndex") || helper)
                add(g, t);
            else
                baked.push_back(t);
        }
        if (!g.triangles.empty())
            groups.push_back(std::move(g));
    }
    // Weld positions, not OBJ indices: UV/material seams and source grid cuts
    // must not turn one continuous object into dozens of separate paint pieces.
    Union joins(unsigned(baked.size()));
    std::unordered_map<Key, unsigned, Hash> vertices;
    for (unsigned i = 0; i < baked.size(); ++i) {
        check_cancel(cancel);
        const auto& s = label(baked[i].material);
        const auto family = ground(s) ? 1 : leaves(s) ? 2 : 0;
        for (const auto& v : baked[i].v) {
            Key key{std::llround(v.p.x * 10), std::llround(v.p.y * 10), std::llround(v.p.z * 10), family};
            auto [it, added] = vertices.emplace(key, i);
            if (!added)
                joins.join(i, it->second);
        }
    }
    std::map<unsigned, Group> components;
    for (unsigned i = 0; i < baked.size(); ++i)
        add(components[joins.root(i)], baked[i]);
    std::vector<Group> islands;
    for (auto& [id, g] : components) {
        static_cast<void>(id);
        g.ground = true;
        for (const auto& t : g.triangles) {
            g.tree |= tree(label(t.material));
            g.ground &= ground(label(t.material));
        }
        islands.push_back(std::move(g));
    }
    Union clusters(unsigned(islands.size()));
    const auto shared_source = [](const Group& a, const Group& b) {
        for (auto s : a.sources)
            if (b.sources.contains(s))
                return true;
        return false;
    };
    const auto family_name = [&](const Group& g) {
        std::set<std::string> result;
        for (const auto& t : g.triangles) {
            auto s = label(t.material);
            s.resize(s.find('*') == std::string::npos ? s.size() : s.find('*'));
            if (!s.empty())
                result.insert(s);
        }
        return result;
    };
    for (unsigned i = 0; i < islands.size(); ++i)
        for (unsigned j = i + 1; j < islands.size(); ++j) {
            const auto& a = islands[i];
            const auto& b = islands[j];
            if (a.tree || b.tree || a.ground || b.ground || !shared_source(a, b))
                continue;
            const auto fa = family_name(a), fb = family_name(b);
            bool common = false;
            for (const auto& f : fa)
                common |= fb.contains(f);
            if (!common)
                continue;
            if (a.box.min.x <= b.box.max.x + 20 && b.box.min.x <= a.box.max.x + 20 && a.box.min.y <= b.box.max.y + 20 &&
                b.box.min.y <= a.box.max.y + 20 && a.box.min.z <= b.box.max.z + 20 && b.box.min.z <= a.box.max.z + 20)
                clusters.join(i, j);
        }
    // Keep small disconnected lettering/windows with their enclosing structure.
    // Merely overlapping bounds never join neighbouring trees or buildings.
    for (unsigned i = 0; i < islands.size(); ++i) {
        check_cancel(cancel);
        const auto& a = islands[i];
        if (a.box.size() > 3000)
            continue;
        unsigned owner = i;
        double best = 1e100;
        for (unsigned j = 0; j < islands.size(); ++j) {
            const auto& b = islands[j];
            if (i == j || a.tree != b.tree || a.ground != b.ground || b.box.size() < a.box.size() * 1.5 ||
                b.box.size() > 30000)
                continue;
            if (!shared_source(a, b))
                continue;
            const auto margin = std::min(150., b.box.size() * .02);
            if (b.box.contains(a.box.min, margin) && b.box.contains(a.box.max, margin) && b.box.size() < best) {
                owner = j;
                best = b.box.size();
            }
        }
        clusters.join(i, owner);
    }
    // Baked tree canopies can be disconnected from their trunks. A source
    // cylinder is a useful common anchor, unlike arbitrary overlapping bounds.
    std::map<unsigned, unsigned> tree_anchors;
    for (unsigned j = 0; j < islands.size(); ++j) {
        const auto& g = islands[j];
        if (!g.tree)
            continue;
        unsigned anchor = col.be(0x54);
        double best = 1e100;
        for (unsigned i = 0; i < col.be(0x54); ++i) {
            const auto at = col.be(0x50) + std::size_t(i) * 48;
            if (col.be(at) >> 28 || col.be(at + 4, 2) != 65535)
                continue;
            const auto a = source_point(col, at + 8), b = source_point(col, at + 20), center = (a + b) * .5;
            if (center.x < g.box.min.x - 100 || center.x > g.box.max.x + 100 || center.y < g.box.min.y - 100 ||
                center.y > g.box.max.y + 100 || g.box.max.z < std::min(a.z, b.z) - 200 ||
                g.box.min.z > std::max(a.z, b.z) + 200)
                continue;
            const auto d = (g.box.min + g.box.max) * .5 - center;
            const auto score = d.x * d.x + d.y * d.y;
            if (score < best) {
                best = score;
                anchor = i;
            }
        }
        if (anchor < col.be(0x54)) {
            auto [it, added] = tree_anchors.emplace(anchor, j);
            if (!added)
                clusters.join(j, it->second);
        }
    }
    std::map<unsigned, Group> merged;
    for (unsigned i = 0; i < islands.size(); ++i)
        for (const auto& t : islands[i].triangles)
            add(merged[clusters.root(i)], t);
    for (auto& [id, g] : merged) {
        static_cast<void>(id);
        g.name = "Avalanche scenery " + std::to_string(groups.size());
        groups.push_back(std::move(g));
    }
    const auto placed_groups = groups.size();
    std::map<unsigned, unsigned> nodes;
    for (unsigned i = 0; i < groups.size(); ++i) {
        auto& g = groups[i];
        g.foliage = true;
        g.ground = true;
        for (const auto& t : g.triangles) {
            g.tree |= tree(label(t.material));
            g.foliage &= leaves(label(t.material)) || effect(label(t.material));
            g.ground &= ground(label(t.material));
        }
        if (g.original.empty()) {
            std::map<unsigned, unsigned> counts;
            for (const auto& t : g.triangles)
                ++counts[t.material];
            auto material = std::max_element(counts.begin(), counts.end(), [](const auto& a, const auto& b) {
                                return a.second < b.second;
                            })->first;
            auto name = label(material);
            name.resize(name.find('*') == std::string::npos ? name.size() : name.find('*'));
            g.name = "Avalanche " + (name.empty() ? "scenery" : name) + " " + std::to_string(i);
        }
        if (g.original.contains("SourcePlacementIndex"))
            nodes.emplace(g.original.at("SourcePlacementIndex").get<unsigned>(), i);
    }
    unsigned trunks = 0;
    for (unsigned i = 0; i < col.be(0x54); ++i) {
        check_cancel(cancel);
        auto at = col.be(0x50) + std::size_t(i) * 48;
        if (col.be(at) >> 28)
            continue;
        auto a = source_point(col, at + 8), b = source_point(col, at + 20);
        const auto radius = double(std::bit_cast<float>(col.be(at + 32)));
        unsigned owner = unsigned(groups.size());
        const auto node = col.be(at + 4, 2);
        if (nodes.contains(node)) {
            auto n = nodes.at(node);
            if (groups[n].box.contains(a, 1000) && groups[n].box.contains(b, 1000))
                owner = n;
        }
        if (owner == groups.size()) {
            double best = 1e100;
            const auto center = (a + b) * .5;
            for (unsigned j = 0; j < groups.size(); ++j) {
                const auto& g = groups[j];
                if (!g.tree || g.helper || !g.box.contains(center, 1000))
                    continue;
                const auto delta = (g.box.min + g.box.max) * .5 - center;
                const auto score = delta.x * delta.x + delta.y * delta.y;
                if (score < best) {
                    owner = j;
                    best = score;
                }
            }
        }
        if (owner != groups.size()) {
            cylinder(groups[owner], a, b, radius);
            ++trunks;
        }
    }
    // Source polygon hulls give authored copies a collision donor independent of
    // their visible art. Keep every original world face in the static reference.
    unsigned matched = 0;
    for (unsigned i = 0; i < col.be(40); ++i) {
        check_cancel(cancel);
        auto at = col.be(32) + std::size_t(i) * 32;
        if (col.be(at + 13, 1) == 'a')
            continue;
        Triangle t{};
        for (unsigned k = 0; k < 3; ++k)
            t.v[k].p = source_point(col, col.be(36) + std::size_t(col.be(at + k * 4)) * 12);
        std::swap(t.v[1], t.v[2]);
        unsigned owner = unsigned(groups.size());
        double best = 1e100;
        for (unsigned j = 0; j < groups.size(); ++j) {
            const auto& g = groups[j];
            if (g.helper || g.foliage || g.ground || g.tree)
                continue;
            if (g.box.contains(t.v[0].p, 30) && g.box.contains(t.v[1].p, 30) && g.box.contains(t.v[2].p, 30) &&
                g.box.size() < best) {
                owner = j;
                best = g.box.size();
            }
        }
        if (owner != groups.size()) {
            groups[owner].proxy.push_back(t);
            ++matched;
        }
    }
    Json out_models = Json::array();
    for (const auto& m : models.at("Models")) {
        if (out_models.size() > 1)
            break; // hidden utility models are one shared empty root
        if (m.at("ModelObjects")[0].at("MeshData").empty())
            out_models.push_back(m);
    }
    if (out_models.empty())
        out_models.push_back({{"ModelName", "Avalanche collision"},
                              {"ModelObjects", {{{"ParentID", -1}, {"MeshData", Json::array()}}}}});
    for (auto& i : kept)
        i["ModelID"] = 0;
    std::map<std::string, unsigned> shared;
    unsigned solid = 0, ghost = 0, meshes = 0, triangles = 0;
    for (unsigned i = 0; i < groups.size(); ++i) {
        check_cancel(cancel);
        auto& g = groups[i];
        triangles += unsigned(g.triangles.size());
        const auto pivot = g.original.empty() ? (g.box.min + g.box.max) * .5 : point(g.original.at("Location"));
        const auto solid_material = [&](const Triangle& t) {
            const auto& s = label(t.material);
            return !leaves(s) && !effect(s) && !ground(s) &&
                   has(s, {"wood", "metal", "stone", "rock", "concrete", "cement", "wall", "fence", "sculpt",
                           "building", "trunk", "trecollision"});
        };
        if (g.proxy.empty() && !g.tree && !g.helper)
            for (const auto& t : g.triangles)
                if (solid_material(t))
                    g.proxy.push_back(t);
        const bool collidable = !g.proxy.empty() && !g.helper;
        collidable ? ++solid : ++ghost;
        Json defaults{{"nativeCollision",
                       {{"mode", collidable ? 1 : 0},
                        {"playerCollision", collidable},
                        {"responseMass", collidable ? 1e30 : 0},
                        {"playerBounce", collidable},
                        {"bounceAmount", 0}}}};
        std::map<unsigned, std::vector<Triangle>> parts;
        for (const auto& t : g.triangles)
            parts[t.material].push_back(t);
        // Generated source-node variants can still share identical geometry and
        // local hulls; translation is never part of the identity.
        std::string key;
        if (!g.original.empty())
            key = std::to_string(g.original.at("ModelID").get<unsigned>()) + ":" + mesh_text(g.proxy, pivot, false);
        auto found = shared.find(key);
        unsigned id = 0;
        if (!key.empty() && found != shared.end())
            id = found->second;
        else {
            id = unsigned(out_models.size());
            Json subs = Json::array();
            for (const auto& [material, tris] : parts) {
                const auto file = "ava-prop-" + std::to_string(id) + "-" + std::to_string(material) + ".obj";
                write(output / "Meshes" / file, mesh_text(tris, pivot, true));
                subs.push_back({{"MeshPath", file}, {"MaterialID", material}});
                ++meshes;
            }
            Json model{{"ModelName", g.name},
                       {"SourceObjects", g.sources},
                       {"PlacementDefaults", defaults},
                       {"ModelObjects", {{{"ParentID", -1}, {"MeshData", subs}}}}};
            if (collidable) {
                const auto file = "ava-prop-" + std::to_string(id) + ".obj";
                write(output / "Collision" / file, mesh_text(g.proxy, pivot, false));
                model["PlacementCollisionPath"] = file;
            }
            out_models.push_back(model);
            if (!key.empty())
                shared.emplace(std::move(key), id);
        }
        auto instance = g.original.empty() ? Json{{"InstanceName", g.name},
                                                  {"SourceObjects", g.sources},
                                                  {"Location", {pivot.x, pivot.y, pivot.z}},
                                                  {"Rotation", {0, 0, 0, 1}},
                                                  {"Scale", {1, 1, 1}},
                                                  {"Visable", true},
                                                  {"PlayerCollision", false},
                                                  {"CollsionMode", 0},
                                                  {"AmbentLightColour", {256, 256, 256}}}
                                           : g.original;
        instance["ModelID"] = id;
        kept.push_back(instance);
    }
    save(output / "Models.json", {{"Models", out_models}});
    save(output / "Instances.json", {{"Instances", kept}});
    for (const auto& p : old_files)
        std::filesystem::remove(p);
    return {{"Policy", "position-welded scenery islands; enclosed small details grouped; source hulls and trunk "
                       "cylinders for authored copies"},
            {"BakedComponents", components.size()},
            {"SceneryGroups", placed_groups},
            {"PlacementModels", out_models.size() - 1},
            {"SolidPlacementDefaults", solid},
            {"DecorativePlacementDefaults", ghost},
            {"MatchedTrunkProxies", trunks},
            {"MatchedPolygonProxies", matched},
            {"Triangles", triangles},
            {"Meshes", meshes}};
}
} // namespace openslope::import_detail
