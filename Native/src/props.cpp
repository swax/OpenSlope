#include "openslope/props.hpp"
#include "openslope/crowd.hpp"
#include "openslope/import.hpp"
#include "openslope/material_animation.hpp"
#include "openslope/model_animation.hpp"
#include "prop_internal.hpp"
#include <bit>
#include <fstream>
#include <functional>
#include <map>
#include <nlohmann/json.hpp>
#include <set>
#include <sstream>
#include <tuple>

namespace openslope {
namespace {
using Json = nlohmann::json;

Vec3 vector3(const Json& value) {
    if (!value.is_array() || value.size() < 3)
        throw std::runtime_error("Invalid prop vector");
    Vec3 v{value[0], value[1], value[2]};
    if (!finite(v))
        throw std::runtime_error("Non-finite prop vector");
    return v;
}

Vec3 axes(Vec3 v) { return {v.x, v.z, -v.y}; }

std::string safe(const std::string& name) {
    if (!valid_map_name(name))
        throw std::runtime_error("Unsafe prop asset filename");
    return name;
}

std::filesystem::path asset(const std::filesystem::path& root, const std::string& relative) {
    const auto base = std::filesystem::weakly_canonical(root),
               path = std::filesystem::weakly_canonical(base / relative), within = path.lexically_relative(base);
    if (within.empty() || within.is_absolute() || *within.begin() == "..")
        throw std::runtime_error("Prop asset resolves outside its course");
    return path;
}

Json json_file(const std::filesystem::path& path) {
    if (std::filesystem::file_size(path) > 64 * 1024 * 1024)
        throw std::runtime_error("Prop JSON exceeds 64 MiB");
    std::ifstream stream(path);
    return Json::parse(stream);
}

struct Tables {
    Json models, instances, materials;
};

std::string texture_name(const Json& material) {
    const auto& name = material.at("TexturePath");
    return name.is_null() ? std::string{} : name.get<std::string>();
}

Tables tables(const std::filesystem::path& root, bool model_only = false) {
    if (root.empty())
        return {};
    unsigned present = 0;
    for (const auto name : {"Models.json", "Instances.json", "Materials.json"})
        if (!model_only || std::string_view(name) != "Instances.json")
            present += std::filesystem::is_regular_file(root / name) ? 1 : 0;
    if (!present)
        return {};
    if (present != (model_only ? 2u : 3u))
        throw std::runtime_error("Incomplete model/placement/material tables");
    Tables t{json_file(asset(root, "Models.json")).at("Models"),
             model_only ? Json::array() : json_file(asset(root, "Instances.json")).at("Instances"),
             json_file(asset(root, "Materials.json")).at("Materials")};
    if (!t.models.is_array() || t.models.size() > 16384 || !t.instances.is_array() || t.instances.size() > 100000 ||
        !t.materials.is_array() || t.materials.size() > 65535)
        throw std::runtime_error("Invalid prop table counts");
    return t;
}

Transform row_pose(const Json& row) {
    if (row.contains("TransformMatrix")) {
        const auto matrix = row.at("TransformMatrix").get<Transform>();
        for (auto x : matrix)
            if (!std::isfinite(x))
                throw std::runtime_error("Invalid prop transform");
        if (std::abs(matrix[3]) + std::abs(matrix[7]) + std::abs(matrix[11]) + std::abs(matrix[15] - 1) > 1e-5)
            throw std::runtime_error("Prop transform must be affine");
        return matrix;
    }
    const auto location = row.contains("Location") ? "Location" : "Position";
    const auto p = row.contains(location) && !row.at(location).is_null() ? vector3(row.at(location)) : Vec3{};
    const auto s = row.contains("Scale") && !row.at("Scale").is_null() ? vector3(row.at("Scale")) : Vec3{1, 1, 1};
    const auto q = row.contains("Rotation") && !row.at("Rotation").is_null()
                       ? row.at("Rotation").get<std::array<double, 4>>()
                       : std::array<double, 4>{0, 0, 0, 1};
    return placement(p, q, s);
}

PropObjectMotion motion_object(const Json& row) {
    PropObjectMotion result;
    result.rest = row_pose(row);
    result.parent = row.value("ParentID", -1);
    result.animated =
        row.value("IncludeAnimation", false) && row.contains("Animation") && !row.at("Animation").is_null();
    if (!result.animated)
        return result;
    const auto& animation = row.at("Animation");
    result.base = {animation.value("U1", 0.), animation.value("U2", 0.), animation.value("U3", 0.)};
    if (!finite(result.base))
        throw std::runtime_error("Invalid prop animation base");
    const auto mask = animation.value("AnimationAction", 0u);
    if (mask > 63 || animation.at("AnimationEntries").size() != std::size_t(std::popcount(mask)))
        throw std::runtime_error("Invalid animation channels");
    unsigned entry = 0;
    for (unsigned channel = 0; channel < 6; ++channel)
        if (mask & (1u << channel)) {
            const auto& segments = animation.at("AnimationEntries").at(entry++).at("AnimationMaths");
            if (!segments.is_array() || segments.size() > 100000)
                throw std::runtime_error("Invalid animation curve count");
            for (const auto& segment_row : segments) {
                PropCurveSegment segment;
                for (unsigned i = 0; i < 4; ++i)
                    segment.coefficient[i] = segment_row.at("Value" + std::to_string(i + 1));
                segment.start = segment_row.at("Value5");
                segment.end = segment_row.at("Value6");
                for (const auto value : segment.coefficient)
                    if (!std::isfinite(value))
                        throw std::runtime_error("Invalid prop curve coefficient");
                if (!std::isfinite(segment.start) || !std::isfinite(segment.end) || segment.start > segment.end)
                    throw std::runtime_error("Invalid prop curve window");
                result.channels[channel].push_back(segment);
            }
        }
    return result;
}

Transform object_pose(const Json& row) { return motion_object(row).pose(0); }

Vec3 normal_transform(const Transform& m, Vec3 n) {
    const Vec3 a{m[0], m[1], m[2]}, b{m[4], m[5], m[6]}, c{m[8], m[9], m[10]};
    const auto determinant = dot(a, cross(b, c));
    if (std::abs(determinant) < 1e-12)
        throw std::runtime_error("Singular model rest transform");
    // Preserve the packed normal at identity; inverse transpose for rest scale.
    return (cross(b, c) * n.x + cross(c, a) * n.y + cross(a, b) * n.z) / determinant;
}

int index(const std::string& field, std::size_t size) {
    if (field.empty())
        return -1;
    std::size_t used = 0;
    const int value = std::stoi(field, &used);
    const auto i = value > 0 ? value - 1 : static_cast<int>(size) + value;
    if (used != field.size() || !value || i < 0 || std::size_t(i) >= size)
        throw std::runtime_error("OBJ index outside its array");
    return i;
}

void mesh_file(Props& props, const std::filesystem::path& path, const Transform& rest, PropPart& part, Bounds& bounds,
               bool flag, bool faceted) {
    if (std::filesystem::file_size(path) > 64 * 1024 * 1024)
        throw std::runtime_error("OBJ exceeds 64 MiB");
    std::ifstream file(path);
    std::string line;
    std::vector<Vec3> points, normals;
    std::vector<std::array<double, 2>> uv;
    std::map<std::tuple<int, int, int>, std::uint32_t> vertices;
    std::vector<int> point_order;
    part.first = static_cast<std::uint32_t>(props.geometry.indices.size());
    while (std::getline(file, line)) {
        if (line.size() > 1024 * 1024)
            throw std::runtime_error("OBJ line exceeds limit");
        std::istringstream input(line);
        std::string kind;
        input >> kind;
        if (kind == "v" || kind == "vn") {
            Vec3 v;
            if (!(input >> v.x >> v.y >> v.z) || !finite(v) || length(v) > 1e9)
                throw std::runtime_error("Invalid OBJ vector");
            (kind == "v" ? points : normals).push_back(v);
        } else if (kind == "vt") {
            std::array<double, 2> v;
            if (!(input >> v[0] >> v[1]) || !std::isfinite(v[0]) || !std::isfinite(v[1]) ||
                std::abs(v[0]) + std::abs(v[1]) > 1e6)
                throw std::runtime_error("Invalid OBJ UV");
            uv.push_back(v);
        } else if (kind == "f") {
            std::vector<std::tuple<int, int, int>> face;
            std::string token;
            while (input >> token) {
                if (token.starts_with('#'))
                    break;
                const auto a = token.find('/'), b = a == std::string::npos ? std::string::npos : token.find('/', a + 1);
                const auto p = index(token.substr(0, a), points.size()),
                           t = a == std::string::npos
                                   ? -1
                                   : index(token.substr(a + 1, b == std::string::npos ? b : b - a - 1), uv.size()),
                           n = b == std::string::npos ? -1 : index(token.substr(b + 1), normals.size());
                face.emplace_back(p, t, n);
                if (face.size() > 64)
                    throw std::runtime_error("OBJ polygon exceeds 64 corners");
            }
            if (face.size() < 3)
                throw std::runtime_error("OBJ face has fewer than three corners");
            for (std::size_t triangle = 1; triangle + 1 < face.size(); ++triangle) {
                auto normal = normalized(cross(points[std::get<0>(face[triangle])] - points[std::get<0>(face[0])],
                                               points[std::get<0>(face[triangle + 1])] - points[std::get<0>(face[0])]));
                if (faceted) {
                    Vec3 authored{};
                    for (const auto& corner : {face[0], face[triangle], face[triangle + 1]})
                        if (const auto n = std::get<2>(corner); n >= 0)
                            authored += normals[std::size_t(n)];
                    if (dot(normal, authored) < 0)
                        normal = -normal;
                }
                for (const auto& corner : {face[0], face[triangle], face[triangle + 1]}) {
                    const auto [p, t, n] = corner;
                    if (flag)
                        point_order.push_back(p);
                    auto found = n < 0 || faceted ? vertices.end() : vertices.find(corner);
                    std::uint32_t vertex;
                    if (found == vertices.end()) {
                        const auto position = axes(transform_point(rest, points[std::size_t(p)])) / 100;
                        const auto shaded = normal_transform(rest, n < 0 || faceted ? normal : normals[std::size_t(n)]);
                        const auto tex = t < 0 ? std::array<double, 2>{0, 0} : uv[std::size_t(t)];
                        vertex = static_cast<std::uint32_t>(props.geometry.vertices.size());
                        props.geometry.vertices.push_back({float(position.x), float(position.y), float(position.z), 1,
                                                           1, 1, float(tex[0]), float(1 - tex[1]), 0, 0, 0, 0, 0, 0,
                                                           float(shaded.x), float(shaded.y), float(shaded.z)});
                        bounds.add(position);
                        if (n >= 0 && !faceted)
                            vertices.emplace(corner, vertex);
                    } else
                        vertex = found->second;
                    props.geometry.indices.push_back(vertex);
                    if (props.geometry.vertices.size() * sizeof(Vertex) + props.geometry.indices.size() * 4 >
                        256 * 1024 * 1024)
                        throw std::runtime_error("Prop geometry exceeds 256 MiB");
                }
            }
        }
        if (points.size() + normals.size() + uv.size() > 8000000)
            throw std::runtime_error("OBJ arrays exceed their limit");
    }
    part.count = static_cast<std::uint32_t>(props.geometry.indices.size()) - part.first;
    if (flag) {
        if (points.size() != 4 || point_order.size() != 6)
            throw std::runtime_error("Flag mesh requires a four-corner strip: " + path.filename().string());
        std::map<std::pair<int, int>, unsigned> edges;
        for (unsigned triangle = 0; triangle < 2; ++triangle)
            for (unsigned e = 0; e < 3; ++e) {
                auto a = point_order[triangle * 3 + e], b = point_order[triangle * 3 + (e + 1) % 3];
                if (a > b)
                    std::swap(a, b);
                ++edges[{a, b}];
            }
        const auto boundary = [&](int a, int b) {
            if (a > b)
                std::swap(a, b);
            return edges[{a, b}] == 1;
        };
        if (!boundary(0, 1))
            throw std::runtime_error("Flag first sampled pair is not an edge");
        const int c = boundary(0, 2) ? 2 : 3, d = c == 2 ? 3 : 2;
        if (!boundary(1, d) || !boundary(c, d))
            throw std::runtime_error("Invalid flag strip topology");
        std::array<Vertex, 4> corners{};
        std::array<bool, 4> found{};
        for (unsigned i = 0; i < 6; ++i) {
            const auto raw = std::size_t(point_order[i]);
            corners[raw] = props.geometry.vertices[props.geometry.indices[part.first + i]];
            found[raw] = true;
        }
        if (!std::all_of(found.begin(), found.end(), [](bool x) { return x; }))
            throw std::runtime_error("Incomplete flag corners");
        const auto interpolate = [](const Vertex& a, const Vertex& b, float t) {
            Vertex v{std::lerp(a.x, b.x, t), std::lerp(a.y, b.y, t), std::lerp(a.z, b.z, t), 1, 1, 1};
            v.s = std::lerp(a.s, b.s, t);
            v.t = std::lerp(a.t, b.t, t);
            v.nx = std::lerp(a.nx, b.nx, t);
            v.ny = std::lerp(a.ny, b.ny, t);
            v.nz = std::lerp(a.nz, b.nz, t);
            v.ls = t;
            v.lt = 1;
            return v;
        };
        const auto start = std::uint32_t(props.geometry.vertices.size());
        part.wave_first = std::uint32_t(props.geometry.indices.size());
        for (unsigned k = 0; k <= 8; ++k) {
            props.geometry.vertices.push_back(interpolate(corners[0], corners[std::size_t(c)], float(k) / 8));
            props.geometry.vertices.push_back(interpolate(corners[1], corners[std::size_t(d)], float(k) / 8));
        }
        // Keep the source winding even when a custom quad uses the other diagonal.
        const auto a = points[std::size_t(point_order[0])], b = points[std::size_t(point_order[1])],
                   e = points[std::size_t(point_order[2])];
        const bool reverse =
            dot(cross(b - a, e - a), cross(points[1] - points[0], points[std::size_t(c)] - points[0])) < 0;
        for (unsigned k = 0; k < 8; ++k) {
            const auto q = start + 2 * k;
            for (auto triangle :
                 std::array<std::array<std::uint32_t, 3>, 2>{{{q, q + 1, q + 2}, {q + 2, q + 1, q + 3}}}) {
                if (reverse)
                    std::swap(triangle[1], triangle[2]);
                props.geometry.indices.insert(props.geometry.indices.end(), triangle.begin(), triangle.end());
            }
        }
        part.wave_count = 48;
        if (props.geometry.vertices.size() * sizeof(Vertex) + props.geometry.indices.size() * 4 > 256 * 1024 * 1024)
            throw std::runtime_error("Flag geometry exceeds prop budget");
    }
}
} // namespace

Transform identity_transform() {
    Transform m{};
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
}

int prop_alpha_mode(const PropPart& part, bool fractional_alpha) {
    if (part.alpha_mode >= 0)
        return part.alpha_mode;
    return (part.flags & ((1u << 18) | (1u << 17))) ? (fractional_alpha ? 2 : 1) : 0;
}

Transform multiply(const Transform& a, const Transform& b) {
    Transform m{};
    for (unsigned c = 0; c < 4; ++c)
        for (unsigned r = 0; r < 4; ++r)
            for (unsigned k = 0; k < 4; ++k)
                m[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return m;
}

Vec3 transform_point(const Transform& m, Vec3 p) {
    return {m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12], m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
            m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14]};
}

Transform placement(Vec3 p, std::array<double, 4> q, Vec3 s) {
    if (!finite(p) || !finite(s))
        throw std::runtime_error("Invalid prop placement");
    double length2 = 0;
    for (auto v : q) {
        if (!std::isfinite(v))
            throw std::runtime_error("Invalid prop quaternion");
        length2 += v * v;
    }
    if (length2 < 1e-20)
        throw std::runtime_error("Zero prop quaternion");
    for (auto& v : q)
        v /= std::sqrt(length2);
    const auto x = q[0], y = q[1], z = q[2], w = q[3];
    auto m = identity_transform();
    m[0] = (1 - 2 * (y * y + z * z)) * s.x;
    m[1] = 2 * (x * y + w * z) * s.x;
    m[2] = 2 * (x * z - w * y) * s.x;
    m[4] = 2 * (x * y - w * z) * s.y;
    m[5] = (1 - 2 * (x * x + z * z)) * s.y;
    m[6] = 2 * (y * z + w * x) * s.y;
    m[8] = 2 * (x * z + w * y) * s.z;
    m[9] = 2 * (y * z - w * x) * s.z;
    m[10] = (1 - 2 * (x * x + y * y)) * s.z;
    m[12] = p.x;
    m[13] = p.y;
    m[14] = p.z;
    return m;
}

Transform map_transform(Transform raw) {
    auto b = identity_transform();
    b[5] = b[10] = 0;
    b[6] = -1;
    b[9] = 1;
    auto inverse = b;
    inverse[6] = 1;
    inverse[9] = -1;
    raw[12] /= 100;
    raw[13] /= 100;
    raw[14] /= 100;
    return multiply(multiply(b, raw), inverse);
}

Transform inverse_transform(const Transform& m) {
    const Vec3 a{m[0], m[1], m[2]}, b{m[4], m[5], m[6]}, c{m[8], m[9], m[10]};
    const auto det = dot(a, cross(b, c));
    if (std::abs(det) < 1e-12)
        throw std::runtime_error("Singular collision placement");
    const auto x = cross(b, c) / det, y = cross(c, a) / det, z = cross(a, b) / det;
    auto result = identity_transform();
    result[0] = x.x;
    result[4] = x.y;
    result[8] = x.z;
    result[1] = y.x;
    result[5] = y.y;
    result[9] = y.z;
    result[2] = z.x;
    result[6] = z.y;
    result[10] = z.z;
    const auto p = transform_point(result, {m[12], m[13], m[14]});
    result[12] = -p.x;
    result[13] = -p.y;
    result[14] = -p.z;
    return result;
}

Transform interpolate_transform(const Transform& a, const Transform& b, double alpha) {
    if (!std::isfinite(alpha) || alpha < 0 || alpha > 1)
        throw std::invalid_argument("Invalid prop interpolation");
    Transform result;
    for (unsigned i = 0; i < 16; ++i)
        result[i] = std::lerp(a[i], b[i], alpha);
    const Vec3 x{result[0], result[1], result[2]}, y{result[4], result[5], result[6]},
        z{result[8], result[9], result[10]};
    if (std::abs(dot(x, cross(y, z))) < 1e-9)
        return alpha < .5 ? a : b;
    return result;
}

PropPose moved_prop_pose(const PropPose& original, const Transform& delta) {
    auto result = original;
    Transform base;
    for (unsigned i = 0; i < 16; ++i)
        base[i] = original.matrix[i];
    const auto world = multiply(base, delta);
    for (unsigned i = 0; i < 16; ++i)
        result.matrix[i] = float(world[i]);
    const auto inverse = inverse_transform(delta);
    for (unsigned light = 0; light < 3; ++light) {
        const auto& d = original.direction[light];
        const auto v = axes({d[0], d[1], d[2]});
        const auto rotated = transform_point(inverse, v) - transform_point(inverse, {});
        result.direction[light] = {float(rotated.x), float(-rotated.z), float(rotated.y), d[3]};
    }
    return result;
}

Vec3 transform_normal(const Transform& m, Vec3 n) { return normal_transform(m, n); }

std::vector<Transform> prop_placements(const std::filesystem::path& root) {
    if (root.empty() || !std::filesystem::exists(root / "Instances.json"))
        return {};
    const auto doc = json_file(asset(root, "Instances.json"));
    return prop_detail::placements(doc.at("Instances"));
}

std::vector<Transform> prop_detail::placements(const Json& rows) {
    if (!rows.is_array() || rows.size() > 100000)
        throw std::runtime_error("Invalid prop instance count");
    std::vector<Transform> result;
    result.reserve(rows.size());
    for (const auto& row : rows)
        result.push_back(map_transform(row_pose(row)));
    return result;
}

std::vector<std::vector<PropObjectLayout>> prop_layout(const std::filesystem::path& root,
                                                       std::span<const std::size_t> box_models) {
    std::vector<std::vector<PropObjectLayout>> result;
    if (root.empty() || !std::filesystem::exists(root / "Models.json"))
        return result;
    const auto doc = json_file(asset(root, "Models.json"));
    const auto& models = doc.at("Models");
    if (!models.is_array() || models.size() > 16384)
        throw std::runtime_error("Invalid collision model count");
    for (std::size_t id = 0; id < models.size(); ++id) {
        const auto& model = models[id];
        const bool needs_bounds = std::find(box_models.begin(), box_models.end(), id) != box_models.end();
        const auto& rows = model.at("ModelObjects");
        if (!rows.is_array() || rows.size() > 256)
            throw std::runtime_error("Invalid collision object count");
        std::vector<PropObjectLayout> objects(rows.size());
        std::vector<unsigned> state(rows.size());
        std::function<Transform(std::size_t)> resolve = [&](std::size_t i) {
            if (state[i] == 1)
                throw std::runtime_error("Cyclic collision hierarchy");
            if (state[i] == 2)
                return objects[i].rest;
            state[i] = 1;
            auto m = object_pose(rows[i]);
            const auto parent = rows[i].value("ParentID", -1);
            if (parent < -1 || parent >= int(rows.size()))
                throw std::runtime_error("Invalid collision parent");
            if (parent >= 0)
                m = multiply(resolve(std::size_t(parent)), m);
            state[i] = 2;
            return objects[i].rest = m;
        };
        for (std::size_t i = 0; i < rows.size(); ++i) {
            resolve(i);
            auto& object = objects[i];
            object.has_geometry = !rows[i].at("MeshData").empty();
            if (!needs_bounds || (!object.has_geometry && !rows[i].contains("CollisionBounds")))
                continue;
            Bounds raw;
            if (rows[i].contains("CollisionBounds")) {
                raw.min = vector3(rows[i].at("CollisionBounds").at("Min"));
                raw.max = vector3(rows[i].at("CollisionBounds").at("Max"));
                if (raw.min.x > raw.max.x || raw.min.y > raw.max.y || raw.min.z > raw.max.z)
                    throw std::runtime_error("Invalid authored collision bounds");
            } else
                for (const auto& part : rows[i].at("MeshData")) {
                    const auto path = asset(root, "Meshes/" + safe(part.at("MeshPath")));
                    if (std::filesystem::file_size(path) > 64 * 1024 * 1024)
                        throw std::runtime_error("Collision box source exceeds 64 MiB");
                    std::ifstream file(path);
                    std::string line;
                    while (std::getline(file, line)) {
                        if (line.size() > 1024 * 1024)
                            throw std::runtime_error("Collision box line too long");
                        std::istringstream input(line);
                        std::string type;
                        input >> type;
                        if (type == "v") {
                            Vec3 p;
                            if (!(input >> p.x >> p.y >> p.z) || !finite(p))
                                throw std::runtime_error("Invalid collision box vertex");
                            raw.add(p);
                        }
                    }
                }
            if (!finite(raw.min) || !finite(raw.max))
                throw std::runtime_error("Collision object has no local bounds");
            object.has_box = true;
            for (unsigned corner = 0; corner < 8; ++corner)
                object.box.add(axes({corner & 1 ? raw.max.x : raw.min.x, corner & 2 ? raw.max.y : raw.min.y,
                                     corner & 4 ? raw.max.z : raw.min.z}) /
                               100);
        }
        result.push_back(std::move(objects));
    }
    return result;
}

std::vector<std::string> prop_files(const std::filesystem::path& root, bool model_only) {
    const auto t = tables(root, model_only);
    if (t.models.is_null())
        return {};
    const auto frames = material_flipbooks(root);
    std::set<std::string> names;
    for (const auto& model : t.models)
        for (const auto& object : model.at("ModelObjects"))
            for (const auto& part : object.at("MeshData")) {
                names.insert("Meshes/" + safe(part.at("MeshPath")));
                const auto id = part.at("MaterialID").get<int>();
                if (id == -1)
                    continue;
                if (id < -1)
                    throw std::runtime_error("Invalid prop material");
                const auto name = texture_name(t.materials.at(id));
                if (!name.empty())
                    names.insert("Textures/" + safe(name));
                for (const auto& frame : frames.at(id))
                    names.insert("Textures/" + safe(frame));
            }
    for (const auto& name : crowd_frames(root))
        names.insert("Textures/" + safe(name));
    return {names.begin(), names.end()};
}

Props Props::load(const std::filesystem::path& root, bool model_only, std::span<const std::size_t> flag_models,
                  std::span<const std::size_t> faceted_models) {
    Props result;
    const auto t = tables(root, model_only);
    if (t.models.is_null())
        return result;
    const auto frames = material_flipbooks(root);
    result.models.resize(t.models.size());
    result.geometry.map_root = root;
    for (std::size_t model = 0; model < t.models.size(); ++model) {
        const auto& objects = t.models[model].at("ModelObjects");
        if (!objects.is_array() || objects.size() > 256)
            throw std::runtime_error("Invalid model object count");
        std::vector<Transform> rest(objects.size());
        std::vector<unsigned> state(objects.size());
        std::function<Transform(std::size_t)> resolve = [&](std::size_t i) {
            if (state[i] == 1)
                throw std::runtime_error("Model hierarchy contains a cycle");
            if (state[i] == 2)
                return rest[i];
            state[i] = 1;
            auto m = object_pose(objects[i]);
            const auto parent = objects[i].value("ParentID", -1);
            if (parent < -1)
                throw std::runtime_error("Invalid model parent");
            if (parent >= 0) {
                if (std::size_t(parent) >= objects.size())
                    throw std::runtime_error("Invalid model parent");
                m = multiply(resolve(std::size_t(parent)), m);
            }
            state[i] = 2;
            return rest[i] = m;
        };
        for (std::size_t i = 0; i < objects.size(); ++i)
            resolve(i);
        for (std::size_t i = 0; i < objects.size(); ++i)
            for (const auto& data : objects[i].at("MeshData")) {
                const auto material = data.at("MaterialID").get<int>();
                if (material < -1)
                    throw std::runtime_error("Invalid prop material");
                const auto mat = material == -1 ? Json{{"TexturePath", nullptr}} : t.materials.at(material);
                PropPart part;
                part.texture = texture_name(mat);
                if (!part.texture.empty())
                    safe(part.texture);
                part.flags = mat.value("UnknownInt18", 0u);
                if (mat.contains("AlphaMode")) {
                    const auto mode = mat.at("AlphaMode").get<std::string>();
                    if (mode == "opaque")
                        part.alpha_mode = 0;
                    else if (mode == "cutout")
                        part.alpha_mode = 1;
                    else if (mode == "blend" || mode == "glow")
                        part.alpha_mode = 2;
                    else
                        throw std::runtime_error("Invalid prop alpha mode");
                }
                part.material = std::size_t(material);
                if (material >= 0)
                    part.frames = frames.at(material);
                if (!part.frames.empty())
                    part.texture = part.frames.front();
                part.object = i;
                mesh_file(result, asset(root, "Meshes/" + safe(data.at("MeshPath"))), resolve(i), part, part.bounds,
                          std::find(flag_models.begin(), flag_models.end(), model) != flag_models.end(),
                          std::find(faceted_models.begin(), faceted_models.end(), model) != faceted_models.end());
                if (!part.count)
                    continue;
                result.models[model].bounds.add(part.bounds.min);
                result.models[model].bounds.add(part.bounds.max);
                result.models[model].parts.push_back(result.parts.size());
                result.parts.push_back(std::move(part));
            }
    }
    auto basis = identity_transform();
    basis[5] = basis[10] = 0;
    basis[6] = -1;
    basis[9] = 1;
    auto inverse = basis;
    inverse[6] = 1;
    inverse[9] = -1;
    for (const auto& row : t.instances) {
        PropInstance instance;
        instance.model = row.at("ModelID").get<std::size_t>();
        if (instance.model >= result.models.size())
            throw std::runtime_error("Prop instance references a missing model");
        instance.visible = row.value("Visable", true);
        auto raw = row_pose(row);
        raw[12] /= 100;
        raw[13] /= 100;
        raw[14] /= 100;
        const auto world = multiply(multiply(basis, raw), inverse);
        for (unsigned i = 0; i < 16; ++i)
            instance.pose.matrix[i] = float(world[i]);
        const auto ambient =
            row.contains("AmbentLightColour") ? vector3(row.at("AmbentLightColour")) : Vec3{256, 256, 256};
        instance.pose.ambient = {float(ambient.x / 256), float(ambient.y / 256), float(ambient.z / 256), 0};
        for (unsigned key = 0; key < 3; ++key) {
            const auto colour = "LightColour" + std::to_string(key + 1),
                       direction = "LightVector" + std::to_string(key + 1);
            if (row.contains(colour)) {
                const auto c = vector3(row.at(colour)), d = vector3(row.at(direction));
                instance.pose.colour[key] = {float(c.x / 256), float(c.y / 256), float(c.z / 256), 0};
                instance.pose.direction[key] = {float(d.x), float(d.y), float(d.z), 0};
            }
        }
        const auto& box = result.models[instance.model].bounds;
        if (!result.models[instance.model].parts.empty())
            for (unsigned corner = 0; corner < 8; ++corner)
                instance.bounds.add(
                    transform_point(world, {corner & 1 ? box.max.x : box.min.x, corner & 2 ? box.max.y : box.min.y,
                                            corner & 4 ? box.max.z : box.min.z}));
        result.instances.push_back(instance);
    }
    return result;
}

bool prop_visible(const Bounds& b, std::span<const float, 16> camera, Vec3 eye, double range) {
    const auto delta = Vec3{std::clamp(eye.x, b.min.x, b.max.x), std::clamp(eye.y, b.min.y, b.max.y),
                            std::clamp(eye.z, b.min.z, b.max.z)} -
                       eye;
    if (dot(delta, delta) > range * range)
        return false;
    std::array<unsigned, 6> outside{};
    for (unsigned corner = 0; corner < 8; ++corner) {
        const Vec3 p{corner & 1 ? b.max.x : b.min.x, corner & 2 ? b.max.y : b.min.y, corner & 4 ? b.max.z : b.min.z};
        std::array<double, 4> clip{};
        for (unsigned r = 0; r < 4; ++r)
            clip[r] = camera[r] * p.x + camera[4 + r] * p.y + camera[8 + r] * p.z + camera[12 + r];
        const auto x = clip[0], y = clip[1], z = clip[2], w = clip[3];
        outside[0] += x < -w;
        outside[1] += x > w;
        outside[2] += y < -w;
        outside[3] += y > w;
        outside[4] += z < 0;
        outside[5] += z > w;
    }
    return std::none_of(outside.begin(), outside.end(), [](auto count) { return count == 8; });
}

std::array<double, 3> prop_light(Vec3 normal, const PropPose& pose) {
    const auto magnitude = length(normal);
    normal = magnitude > .00001 ? normal / magnitude : Vec3{};
    std::array<double, 3> result{pose.ambient[0], pose.ambient[1], pose.ambient[2]};
    for (unsigned key = 0; key < 3; ++key) {
        const auto& d = pose.direction[key];
        const auto amount = std::max(0.0, dot(normal, {d[0], d[1], d[2]}));
        for (unsigned c = 0; c < 3; ++c)
            result[c] += amount * pose.colour[key][c];
    }
    for (auto& c : result)
        c = std::clamp(c, 0.0, 1.0);
    return result;
}

Transform PropObjectMotion::pose(double seconds) const {
    if (!std::isfinite(seconds) || std::abs(seconds) > 1e6)
        throw std::invalid_argument("Invalid model clip time");
    if (!animated)
        return rest;
    std::array<double, 6> values{base.x, base.y, base.z, 0, 0, 0};
    for (unsigned channel = 0; channel < 6; ++channel) {
        const auto& curve = channels[channel];
        if (curve.empty())
            continue;
        const PropCurveSegment* segment = &curve.back();
        for (const auto& candidate : curve)
            if (seconds <= candidate.end) {
                segment = &candidate;
                break;
            }
        const auto time = std::clamp(seconds, segment->start, segment->end);
        const auto& c = segment->coefficient;
        values[channel] = ((c[0] * time + c[1]) * time + c[2]) * time + c[3];
        if (!std::isfinite(values[channel]))
            throw std::runtime_error("Prop curve exceeds numeric limits");
    }
    const auto x = values[3] * pi / 360, y = values[4] * pi / 360, z = values[5] * pi / 360;
    const auto sx = std::sin(x), cx = std::cos(x), sy = std::sin(y), cy = std::cos(y), sz = std::sin(z),
               cz = std::cos(z);
    return placement({values[0], values[1], values[2]},
                     {sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz,
                      cx * cy * cz + sx * sy * sz},
                     {1, 1, 1});
}

PropClips::PropClips(std::vector<PropClip> clips) : clips_(std::move(clips)) {
    order_.resize(clips_.size());
    inverse_rest_.resize(clips_.size());
    for (std::size_t m = 0; m < clips_.size(); ++m) {
        const auto& clip = clips_[m];
        if (!std::isfinite(clip.frames) || clip.frames < 0 || clip.frames > 1e6 || clip.objects.size() > 256)
            throw std::runtime_error("Invalid prop clip");
        std::vector<unsigned> state(clip.objects.size());
        std::function<void(std::size_t)> visit = [&](std::size_t i) {
            if (state[i] == 2)
                return;
            if (state[i] == 1)
                throw std::runtime_error("Cyclic prop clip hierarchy");
            state[i] = 1;
            const auto parent = clip.objects[i].parent;
            if (parent < -1 || parent >= int(clip.objects.size()))
                throw std::runtime_error("Invalid prop clip parent");
            if (parent >= 0)
                visit(std::size_t(parent));
            state[i] = 2;
            order_[m].push_back(i);
        };
        for (std::size_t i = 0; i < clip.objects.size(); ++i)
            visit(i);
        for (const auto& rest : sample(m, 0))
            inverse_rest_[m].push_back(inverse_transform(rest));
    }
}

PropClips PropClips::load(const std::filesystem::path& root) {
    if (root.empty() || !std::filesystem::is_regular_file(root / "Models.json"))
        return PropClips{};
    const auto doc = json_file(asset(root, "Models.json"));
    const auto& models = doc.at("Models");
    if (!models.is_array() || models.size() > 16384)
        throw std::runtime_error("Invalid prop clip model count");
    std::vector<PropClip> clips;
    for (const auto& row : models) {
        PropClip clip;
        clip.frames = row.value("AnimTime", 0.);
        const auto& objects = row.at("ModelObjects");
        if (!objects.is_array() || objects.size() > 256)
            throw std::runtime_error("Invalid prop clip object count");
        for (const auto& object : objects)
            clip.objects.push_back(motion_object(object));
        clips.push_back(std::move(clip));
    }
    return PropClips(std::move(clips));
}

std::size_t PropClips::objects(std::size_t model) const {
    return model < clips_.size() ? clips_[model].objects.size() : 0;
}

double PropClips::frames(std::size_t model) const { return model < clips_.size() ? clips_[model].frames : 0; }

std::vector<Transform> PropClips::sample(std::size_t model, double frame, std::optional<double> basis) const {
    if (model >= clips_.size() || !std::isfinite(frame) || frame < 0 || frame > 1e6)
        throw std::invalid_argument("Invalid model frame sample");
    const auto& clip = clips_[model];
    std::vector<Transform> raw(clip.objects.size());
    for (const auto i : order_[model]) {
        raw[i] = clip.objects[i].pose(frame / 30);
        if (basis && clip.objects[i].animated)
            raw[i] = multiply(clip.objects[i].pose(*basis / 30), raw[i]);
        const auto parent = clip.objects[i].parent;
        if (parent >= 0)
            raw[i] = multiply(raw[std::size_t(parent)], raw[i]);
    }
    for (auto& transform : raw)
        transform = map_transform(transform);
    return raw;
}

std::vector<Transform> PropClips::delta(std::size_t model, double frame, std::optional<double> basis) const {
    auto current = sample(model, frame, basis);
    for (std::size_t i = 0; i < current.size(); ++i)
        current[i] = multiply(current[i], inverse_rest_[model][i]);
    return current;
}

} // namespace openslope
