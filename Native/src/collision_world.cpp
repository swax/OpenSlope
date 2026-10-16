#include "openslope/collision.hpp"
#include "openslope/import.hpp"
#include "openslope/model_animation.hpp"
#include "prop_internal.hpp"
#include <fstream>
#include <map>
#include <nlohmann/json.hpp>
#include <numeric>
#include <set>
#include <sstream>

namespace openslope {
namespace {
using Json = nlohmann::json;

Vec3 axes(Vec3 p) { return {p.x, p.z, -p.y}; }

std::filesystem::path asset(const std::filesystem::path& root, const std::string& name) {
    const auto base = std::filesystem::weakly_canonical(root), path = std::filesystem::weakly_canonical(base / name),
               relative = path.lexically_relative(base);
    if (relative.empty() || relative.is_absolute() || *relative.begin() == "..")
        throw std::runtime_error("Collision asset escapes its course");
    return path;
}

Json read(const std::filesystem::path& path) {
    if (std::filesystem::file_size(path) > 64 * 1024 * 1024)
        throw std::runtime_error("Collision JSON exceeds 64 MiB");
    std::ifstream file(path);
    return Json::parse(file);
}

std::vector<std::uint8_t> decode64(const std::string& text) {
    if (text.size() > 2 * 1024 * 1024 || text.size() % 4)
        throw std::runtime_error("Invalid physics mask text");
    std::vector<std::uint8_t> result;
    unsigned value = 0, bits = 0;
    bool padded = false;
    for (const auto c : text) {
        if (c == '=') {
            padded = true;
            continue;
        }
        if (padded)
            throw std::runtime_error("Invalid base64 padding");
        unsigned x;
        if (c >= 'A' && c <= 'Z')
            x = unsigned(c - 'A');
        else if (c >= 'a' && c <= 'z')
            x = unsigned(c - 'a') + 26;
        else if (c >= '0' && c <= '9')
            x = unsigned(c - '0') + 52;
        else if (c == '+')
            x = 62;
        else if (c == '/')
            x = 63;
        else
            throw std::runtime_error("Invalid physics mask character");
        value = (value << 6) | x;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            result.push_back(std::uint8_t(value >> bits));
        }
    }
    return result;
}

Bounds expanded(Bounds b, double radius) {
    b.min -= Vec3{radius, radius, radius};
    b.max += Vec3{radius, radius, radius};
    return b;
}

bool overlaps(const Bounds& a, const Bounds& b) {
    return a.min.x <= b.max.x + 1e-8 && a.max.x >= b.min.x - 1e-8 && a.min.y <= b.max.y + 1e-8 &&
           a.max.y >= b.min.y - 1e-8 && a.min.z <= b.max.z + 1e-8 && a.max.z >= b.min.z - 1e-8;
}

Bounds placed(const Bounds& box, const Transform& m) {
    Bounds result;
    for (unsigned c = 0; c < 8; ++c)
        result.add(transform_point(
            m, {c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z}));
    return result;
}

struct Tree {
    struct Node {
        Bounds box;
        std::size_t begin{}, end{};
        int left = -1, right = -1, parent = -1;
    };

    std::vector<Node> nodes;
    std::vector<std::size_t> order;
    std::vector<int> leaves;

    void build(const std::vector<Bounds>& boxes) {
        order.resize(boxes.size());
        leaves.assign(boxes.size(), -1);
        std::iota(order.begin(), order.end(), 0);
        nodes.clear();
        if (!boxes.empty())
            split(boxes, 0, boxes.size());
    }

    int split(const std::vector<Bounds>& boxes, std::size_t begin, std::size_t end) {
        const auto id = int(nodes.size());
        nodes.push_back({});
        Bounds box;
        for (auto i = begin; i < end; ++i) {
            box.add(boxes[order[i]].min);
            box.add(boxes[order[i]].max);
        }
        nodes[id] = {box, begin, end};
        if (end - begin <= 8) {
            for (auto i = begin; i < end; ++i)
                leaves[order[i]] = id;
            return id;
        }
        const auto span = box.max - box.min;
        const auto axis = span.x >= span.y && span.x >= span.z ? 0 : span.y >= span.z ? 1 : 2;
        const auto key = [&](std::size_t i) {
            const auto p = boxes[i].center();
            return axis == 0 ? p.x : axis == 1 ? p.y : p.z;
        };
        const auto middle = begin + (end - begin) / 2;
        std::nth_element(order.begin() + begin, order.begin() + middle, order.begin() + end,
                         [&](auto a, auto b) { return key(a) < key(b); });
        const auto left = split(boxes, begin, middle), right = split(boxes, middle, end);
        nodes[id].left = left;
        nodes[id].right = right;
        nodes[left].parent = nodes[right].parent = id;
        return id;
    }

    void refit(const std::vector<Bounds>& boxes, const std::set<std::size_t>& changed) {
        std::set<int, std::greater<int>> dirty;
        for (const auto index : changed)
            for (auto node = leaves.at(index); node >= 0; node = nodes[std::size_t(node)].parent)
                dirty.insert(node);
        for (const auto index : dirty) {
            auto& node = nodes[std::size_t(index)];
            Bounds bound;
            if (node.left < 0) {
                for (auto i = node.begin; i < node.end; ++i) {
                    bound.add(boxes[order[i]].min);
                    bound.add(boxes[order[i]].max);
                }
            } else {
                bound.add(nodes[std::size_t(node.left)].box.min);
                bound.add(nodes[std::size_t(node.left)].box.max);
                bound.add(nodes[std::size_t(node.right)].box.min);
                bound.add(nodes[std::size_t(node.right)].box.max);
            }
            node.box = bound;
        }
    }

    void query(const Bounds& box, std::vector<std::size_t>& out, int node = 0) const {
        if (nodes.empty() || !overlaps(nodes[std::size_t(node)].box, box))
            return;
        const auto& n = nodes[std::size_t(node)];
        if (n.left < 0) {
            for (auto i = n.begin; i < n.end; ++i)
                out.push_back(order[i]);
        } else {
            query(box, out, n.left);
            query(box, out, n.right);
        }
    }
};

struct Triangle {
    Vec3 a, b, c, normal;
};

struct Proxy {
    std::vector<Triangle> triangles;
    Bounds box;
    Tree tree;
};

Proxy proxy(const std::filesystem::path& path) {
    if (std::filesystem::file_size(path) > 64 * 1024 * 1024)
        throw std::runtime_error("Collision OBJ exceeds 64 MiB");
    std::ifstream file(path);
    std::string line;
    std::vector<Vec3> vertices, normals;
    Proxy result;
    std::vector<Bounds> boxes;
    const auto index = [](const std::string& value, std::size_t count) {
        std::size_t used = 0;
        const auto raw = std::stoi(value, &used), i = raw > 0 ? raw - 1 : int(count) + raw;
        if (used != value.size() || !raw || i < 0 || std::size_t(i) >= count)
            throw std::runtime_error("Invalid collision OBJ index");
        return std::size_t(i);
    };
    while (std::getline(file, line)) {
        if (line.size() > 1024 * 1024)
            throw std::runtime_error("Collision OBJ line exceeds its limit");
        std::istringstream input(line);
        std::string kind;
        input >> kind;
        if (kind == "v" || kind == "vn") {
            Vec3 p;
            if (!(input >> p.x >> p.y >> p.z) || !finite(p) || length(p) > 1e9)
                throw std::runtime_error("Invalid collision OBJ vector");
            (kind == "v" ? vertices : normals).push_back(kind == "v" ? axes(p) / 100 : axes(p));
        }
        if (kind == "f") {
            std::vector<std::array<std::size_t, 2>> face;
            std::string token;
            while (input >> token) {
                if (token.starts_with('#'))
                    break;
                const auto slash = token.find('/'), last = token.rfind('/');
                auto n = std::numeric_limits<std::size_t>::max();
                if (last != std::string::npos && last + 1 < token.size())
                    n = index(token.substr(last + 1), normals.size());
                face.push_back({index(token.substr(0, slash), vertices.size()), n});
                if (face.size() > 64)
                    throw std::runtime_error("Collision polygon exceeds 64 vertices");
            }
            if (face.size() < 3)
                throw std::runtime_error("Invalid collision face");
            for (std::size_t j = 1; j + 1 < face.size(); ++j) {
                const auto a = vertices[face[0][0]], b = vertices[face[j][0]], c = vertices[face[j + 1][0]];
                const auto n = face[0][1] < normals.size() ? normals[face[0][1]] : normalized(cross(b - a, c - a));
                Bounds box;
                box.add(a);
                box.add(b);
                box.add(c);
                result.box.add(box.min);
                result.box.add(box.max);
                boxes.push_back(box);
                result.triangles.push_back({a, b, c, n});
            }
        }
        if (vertices.size() + normals.size() > 2000000 || result.triangles.size() > 1000000)
            throw std::runtime_error("Collision OBJ arrays exceed their limits");
    }
    if (result.triangles.empty())
        return result;
    result.tree.build(boxes);
    return result;
}

struct Level {
    double radius{}, offset{};
    std::size_t stride{};
};

struct Body {
    Vec3 centre, mass_centre;
    std::array<double, 9> inverse_inertia{};
    std::vector<Level> levels;
    std::vector<std::uint8_t> masks;
    Bounds box;
};

Vec3 child(Vec3 centre, double offset, unsigned bit) {
    return centre + Vec3{bit & 4 ? offset : -offset, bit & 1 ? offset : -offset, bit & 2 ? -offset : offset};
}

std::vector<std::vector<std::shared_ptr<Body>>> read_bodies(const std::filesystem::path& root) {
    std::vector<std::vector<std::shared_ptr<Body>>> result;
    auto name = "Physics.json";
    if (!std::filesystem::exists(root / name)) {
        name = "SSFLogic.json";
        if (!std::filesystem::exists(root / name))
            return result;
    }
    const auto doc = read(asset(root, name));
    const auto& rows = doc.at("PhysicsHeaders");
    if (!rows.is_array() || rows.size() > 4000)
        throw std::runtime_error("Invalid physics header count");
    for (const auto& header : rows) {
        const auto& data = header.at("PhysicsDatas");
        if (!data.is_array() || data.size() > 256)
            throw std::runtime_error("Invalid physics payload count");
        std::vector<std::shared_ptr<Body>> group;
        for (const auto& row : data) {
            auto body = std::make_shared<Body>();
            body->centre = axes({row.at("UFloat0"), row.at("UFloat1"), row.at("UFloat2")}) / 100;
            body->mass_centre = row.contains("UFloat3") && row.contains("UFloat4") && row.contains("UFloat5")
                                    ? axes({row.at("UFloat3"), row.at("UFloat4"), row.at("UFloat5")}) / 100
                                    : body->centre;
            // [Trailmap: 230-mass] 0.075 times the stored inverse, with cm² -> m² and axes changed.
            const std::array<unsigned, 3> component{0, 2, 1};
            const std::array<double, 3> sign{1, 1, -1};
            for (unsigned r = 0; r < 3; ++r)
                for (unsigned c = 0; c < 3; ++c) {
                    const auto key = "UFloat" + std::to_string(15 + component[r] * 3 + component[c]);
                    const auto value = row.value(key, 0.);
                    if (!std::isfinite(value) || std::abs(value) > 1e9)
                        throw std::runtime_error("Invalid body inverse inertia");
                    body->inverse_inertia[r * 3 + c] = value * 750 * sign[r] * sign[c];
                }
            if (!finite(body->mass_centre))
                throw std::runtime_error("Invalid body centre of mass");
            const auto& levels = row.at("uPhysicsStruct0");
            if (!levels.is_array() || levels.empty() || levels.size() > 7 || !finite(body->centre))
                throw std::runtime_error("Invalid occupancy levels");
            std::size_t stride = 1;
            for (const auto& l : levels) {
                Level level{l.at("U0").get<double>() / 100, l.at("U1").get<double>() / 100, l.at("U2")};
                if (!std::isfinite(level.radius) || level.radius <= 0 || !std::isfinite(level.offset) ||
                    level.offset < 0 || level.stride != stride)
                    throw std::runtime_error("Invalid occupancy level layout");
                body->levels.push_back(level);
                stride *= 8;
            }
            body->masks = occupancy_masks(decode64(row.at("UByteData")), row.value("U2", 1u), unsigned(levels.size()));
            std::function<void(unsigned, std::size_t, Vec3)> bound = [&](unsigned depth, std::size_t index,
                                                                         Vec3 centre) {
                const auto mask = body->masks.at(index);
                if (!mask || depth + 1 == body->levels.size()) {
                    const auto r = body->levels[depth].radius;
                    body->box.add(centre - Vec3{r, r, r});
                    body->box.add(centre + Vec3{r, r, r});
                } else
                    for (unsigned bit = 0; bit < 8; ++bit)
                        if (mask & (1u << bit))
                            bound(depth + 1, index + (bit + 1) * body->levels[depth].stride,
                                  child(centre, body->levels[depth + 1].offset, bit));
            };
            bound(0, 0, body->centre);
            group.push_back(std::move(body));
        }
        result.push_back(std::move(group));
    }
    return result;
}

struct Principal {
    std::array<Vec3, 3> axes;
    std::array<double, 3> scale;
};

Principal principal(const Transform& m) {
    // Diagonalize M*M^T with Jacobi rotations. An affine sphere is an ellipsoid;
    // this retains nonuniform scale and parent-induced shear in shape queries.
    double a[3][3]{}, q[3][3]{{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
    for (unsigned i = 0; i < 3; ++i)
        for (unsigned j = 0; j < 3; ++j)
            for (unsigned k = 0; k < 3; ++k)
                a[i][j] += m[k * 4 + i] * m[k * 4 + j];
    for (unsigned iteration = 0; iteration < 40; ++iteration) {
        unsigned p = 0, r = 1;
        for (unsigned i = 0; i < 3; ++i)
            for (unsigned j = i + 1; j < 3; ++j)
                if (std::abs(a[i][j]) > std::abs(a[p][r])) {
                    p = i;
                    r = j;
                }
        if (std::abs(a[p][r]) < 1e-14 * std::max({1., a[0][0], a[1][1], a[2][2]}))
            break;
        const auto tau = (a[r][r] - a[p][p]) / (2 * a[p][r]),
                   t = (tau < 0 ? -1. : 1.) / (std::abs(tau) + std::sqrt(1 + tau * tau)), c = 1 / std::sqrt(1 + t * t),
                   s = t * c;
        const auto pp = a[p][p], rr = a[r][r], pr = a[p][r];
        a[p][p] = c * c * pp - 2 * s * c * pr + s * s * rr;
        a[r][r] = s * s * pp + 2 * s * c * pr + c * c * rr;
        a[p][r] = a[r][p] = 0;
        for (unsigned k = 0; k < 3; ++k)
            if (k != p && k != r) {
                const auto kp = a[k][p], kr = a[k][r];
                a[k][p] = a[p][k] = c * kp - s * kr;
                a[k][r] = a[r][k] = s * kp + c * kr;
            }
        for (unsigned k = 0; k < 3; ++k) {
            const auto kp = q[k][p], kr = q[k][r];
            q[k][p] = c * kp - s * kr;
            q[k][r] = s * kp + c * kr;
        }
    }
    Principal result;
    for (unsigned i = 0; i < 3; ++i) {
        if (a[i][i] < 1e-18)
            throw std::runtime_error("Degenerate occupancy placement");
        result.axes[i] = {q[0][i], q[1][i], q[2][i]};
        result.scale[i] = std::sqrt(a[i][i]);
    }
    return result;
}

struct Distance {
    Vec3 point, normal;
    double distance{};
};

Distance ellipsoid(Vec3 point, Vec3 centre, double radius, const Principal& p) {
    std::array<double, 3> x{}, a2{}, v{};
    double metric = 0;
    unsigned shortest = 0;
    for (unsigned i = 0; i < 3; ++i) {
        x[i] = dot(point - centre, p.axes[i]);
        a2[i] = radius * radius * p.scale[i] * p.scale[i];
        metric += x[i] * x[i] / a2[i];
        if (a2[i] < a2[shortest])
            shortest = i;
    }
    const auto sum = [&](double lambda) {
        double result = 0;
        for (unsigned i = 0; i < 3; ++i) {
            const auto d = a2[i] + lambda;
            if (d <= 0) {
                if (std::abs(x[i]) > 1e-15)
                    return std::numeric_limits<double>::infinity();
                continue;
            }
            result += a2[i] * x[i] * x[i] / (d * d);
        }
        return result;
    };
    double low = 0, high = 0;
    bool singular = false;
    if (metric >= 1) {
        high = std::max(
            {a2[0], a2[1], a2[2], length(point - centre) * radius * std::max({p.scale[0], p.scale[1], p.scale[2]})});
        while (sum(high) > 1)
            high *= 2;
    } else {
        low = -a2[shortest];
        singular = sum(low) <= 1;
    }
    if (singular) {
        double used = 0;
        for (unsigned i = 0; i < 3; ++i)
            if (a2[i] > a2[shortest] + 1e-14) {
                v[i] = a2[i] * x[i] / (a2[i] - a2[shortest]);
                used += v[i] * v[i] / a2[i];
            }
        v[shortest] = std::sqrt(std::max(0.0, 1 - used) * a2[shortest]) * (x[shortest] < 0 ? -1. : 1.);
    } else {
        for (unsigned i = 0; i < 80; ++i) {
            const auto middle = (low + high) * .5;
            if (sum(middle) > 1)
                low = middle;
            else
                high = middle;
        }
        const auto lambda = (low + high) * .5;
        for (unsigned i = 0; i < 3; ++i)
            v[i] = a2[i] * x[i] / (a2[i] + lambda);
    }
    Vec3 closest = centre;
    for (unsigned i = 0; i < 3; ++i)
        closest += p.axes[i] * v[i];
    const auto delta = point - closest;
    const auto distance = length(delta);
    return {closest, normalized(metric >= 1 ? delta : -delta), metric >= 1 ? distance : -distance};
}

std::optional<ShapeContact> sphere(ProbeSphere start, ProbeSphere end, Vec3 centre, double radius, const Principal& p) {
    const auto velocity = end.centre - start.centre;
    const auto speed = length(velocity), probe = std::max(start.radius, end.radius);
    const auto [smallest, largest] = std::minmax_element(p.scale.begin(), p.scale.end());
    const auto outer_radius = radius * *largest;
    const auto offset = start.centre - centre;
    const auto along = speed > 0 ? std::clamp(-dot(offset, velocity) / (speed * speed), 0., 1.) : 0.;
    // Reject outside a conservative sphere before running the affine distance solver.
    const auto reach = outer_radius + probe + 1e-8;
    if (dot(offset + velocity * along, offset + velocity * along) > reach * reach)
        return {};
    double t = 0;
    // Imported float transforms and their composed poses leave nominal spheres out of round.
    // This application envelope differs from the affine surface by at most 0.01 millimetre.
    if (radius * (*largest - *smallest) <= 1e-5) {
        const auto r = outer_radius, sum = r + probe;
        const auto distance = length(offset);
        if (distance <= sum) {
            const auto normal = normalized(offset, -normalized(velocity));
            return ShapeContact{centre + normal * r, normal, 0, sum - distance};
        }
        const auto a = dot(velocity, velocity), b = 2 * dot(offset, velocity), c = dot(offset, offset) - sum * sum;
        if (a < 1e-18)
            return {};
        const auto discriminant = b * b - 4 * a * c;
        if (discriminant < 0)
            return {};
        t = (-b - std::sqrt(discriminant)) / (2 * a);
        if (t < 0 || t > 1)
            return {};
        const auto normal = normalized(offset + velocity * t);
        return ShapeContact{centre + normal * r, normal, t, 0};
    }
    for (unsigned iteration = 0; iteration < 160; ++iteration) {
        const auto d = ellipsoid(start.centre + velocity * t, centre, radius, p);
        const auto clearance = d.distance - probe;
        if (clearance <= 1e-8)
            return ShapeContact{d.point, d.normal, t, std::max(0.0, -clearance)};
        if (speed < 1e-12)
            return {};
        t += clearance / speed;
        if (t > 1 + 1e-10)
            return {};
        t = std::min(t, 1.0);
    }
    return {};
}

std::optional<ShapeContact> box_ray(const Bounds& box, const Transform& world, const Transform& inverse, Vec3 start,
                                    Vec3 end) {
    const auto a = transform_point(inverse, start), d = transform_point(inverse, end) - a;
    double entry = -std::numeric_limits<double>::infinity(), exit = std::numeric_limits<double>::infinity();
    Vec3 entering, leaving;
    for (unsigned axis = 0; axis < 3; ++axis) {
        const auto value = axis == 0 ? a.x : axis == 1 ? a.y : a.z, speed = axis == 0 ? d.x : axis == 1 ? d.y : d.z;
        const auto low = axis == 0   ? box.min.x
                         : axis == 1 ? box.min.y
                                     : box.min.z,
                   high = axis == 0   ? box.max.x
                          : axis == 1 ? box.max.y
                                      : box.max.z;
        if (std::abs(speed) < 1e-15) {
            if (value < low || value > high)
                return {};
            continue;
        }
        auto first = (low - value) / speed, last = (high - value) / speed;
        Vec3 n{axis == 0 ? -1. : 0, axis == 1 ? -1. : 0, axis == 2 ? -1. : 0}, far = -n;
        if (first > last) {
            std::swap(first, last);
            std::swap(n, far);
        }
        if (first > entry) {
            entry = first;
            entering = n;
        }
        if (last < exit) {
            exit = last;
            leaving = far;
        }
        if (entry > exit)
            return {};
    }
    const auto t = entry >= 0 ? entry : exit;
    if (!std::isfinite(t) || t < 0 || t > 1)
        return {};
    return ShapeContact{start + (end - start) * t, transform_normal(world, entry >= 0 ? entering : leaving), t, 0};
}

std::optional<ShapeContact> body_ray(Vec3 centre, double radius, const Transform& world, const Transform& inverse,
                                     Vec3 start, Vec3 end) {
    const auto a = transform_point(inverse, start) - centre,
               d = transform_point(inverse, end) - transform_point(inverse, start);
    const auto aa = dot(d, d), bb = 2 * dot(a, d), cc = dot(a, a) - radius * radius, disc = bb * bb - 4 * aa * cc;
    if (aa < 1e-18 || disc < 0)
        return {};
    const auto first = (-bb - std::sqrt(disc)) / (2 * aa), last = (-bb + std::sqrt(disc)) / (2 * aa),
               t = first >= 0 ? first : last;
    if (t < 0 || t > 1)
        return {};
    return ShapeContact{start + (end - start) * t, transform_normal(world, normalized(a + d * t)), t, 0};
}
} // namespace

struct CollisionWorld::Data {
    struct Object {
        std::size_t instance{};
        int mode{}, surface = -1, effect = -1;
        double mass{}, bounce{};
        bool response = false, moving = false;
        std::size_t model_object = 0;
        Transform world, inverse, previous, previous_inverse, placement, rest;
        Bounds box;
        std::shared_ptr<Proxy> proxy;
        std::shared_ptr<Body> body;
        Principal principal;
    };

    std::vector<Object> objects;
    std::vector<Bounds> boxes;
    std::vector<std::uint8_t> flags;
    std::vector<std::vector<std::size_t>> instance_objects;
    std::set<std::size_t> dynamic;
    double seconds = 1. / 60;
    Tree tree;
    std::size_t triangle_count{}, body_count{};

    bool responsive(const Object& object) const {
        return object.response || (!flags.empty() && (flags[object.instance] & 8));
    }

    std::optional<ShapeContact> hit_current(const Object& object, ProbeSphere start, ProbeSphere end) const {
        if (object.mode == 2)
            return swept_box(object.box, object.world, start, end);
        if (object.mode == 1) {
            const auto a = transform_point(object.inverse, start.centre),
                       b = transform_point(object.inverse, end.centre);
            Bounds box;
            box.add(a);
            box.add(b);
            double factor = 0;
            for (unsigned i = 0; i < 3; ++i)
                factor += object.inverse[i] * object.inverse[i] + object.inverse[4 + i] * object.inverse[4 + i] +
                          object.inverse[8 + i] * object.inverse[8 + i];
            box = expanded(box, std::max(start.radius, end.radius) * std::sqrt(factor));
            std::vector<std::size_t> candidates;
            object.proxy->tree.query(box, candidates);
            std::optional<ShapeContact> best;
            for (const auto i : candidates) {
                const auto& triangle = object.proxy->triangles[i];
                if (const auto contact = swept_triangle(transform_point(object.world, triangle.a),
                                                        transform_point(object.world, triangle.b),
                                                        transform_point(object.world, triangle.c), start, end);
                    contact && (!best || contact->t < best->t))
                    best = contact;
            }
            return best;
        }
        std::optional<ShapeContact> best;
        const auto& body = *object.body;
        std::function<void(unsigned, std::size_t, Vec3)> visit = [&](unsigned depth, std::size_t index, Vec3 centre) {
            const auto& level = body.levels[depth];
            if (!sphere(start, end, transform_point(object.world, centre), level.radius, object.principal))
                return;
            const auto mask = body.masks.at(index);
            if (!mask || depth + 1 == body.levels.size()) {
                const auto contact =
                    sphere(start, end, transform_point(object.world, centre), level.radius, object.principal);
                if (contact && (!best || contact->t < best->t))
                    best = contact;
            } else
                for (unsigned bit = 0; bit < 8; ++bit)
                    if (mask & (1u << bit))
                        visit(depth + 1, index + (bit + 1) * level.stride,
                              child(centre, body.levels[depth + 1].offset, bit));
        };
        visit(0, 0, body.centre);
        return best;
    }

    ProbeSphere relative(const Object& object, ProbeSphere start) const {
        if (object.moving)
            start.centre = transform_point(object.world, transform_point(object.previous_inverse, start.centre));
        return start;
    }

    Vec3 velocity(const Object& object, Vec3 point, double at = 1) const {
        if (!object.moving)
            return {};
        const auto pose = interpolate_transform(object.previous, object.world, at);
        const auto local = transform_point(inverse_transform(pose), point);
        return (transform_point(object.world, local) - transform_point(object.previous, local)) / seconds;
    }

    std::optional<ShapeContact> hit(const Object& object, ProbeSphere start, ProbeSphere end) const {
        auto contact = hit_current(object, relative(object, start), end);
        if (contact && object.moving) {
            const auto local = transform_point(object.inverse, contact->point);
            const auto pose = interpolate_transform(object.previous, object.world, contact->t);
            const auto n = contact->normal;
            const Vec3 normal{object.world[0] * n.x + object.world[1] * n.y + object.world[2] * n.z,
                              object.world[4] * n.x + object.world[5] * n.y + object.world[6] * n.z,
                              object.world[8] * n.x + object.world[9] * n.y + object.world[10] * n.z};
            contact->point = transform_point(pose, local);
            contact->normal = normalized(transform_normal(pose, normal));
        }
        return contact;
    }

    std::optional<ShapeContact> ray_hit(const Object& object, Vec3 start, Vec3 end) const {
        if (object.mode == 2)
            return box_ray(object.box, object.world, object.inverse, start, end);
        if (object.mode == 1)
            return hit_current(object, {start, 0}, {end, 0});
        std::optional<ShapeContact> best;
        const auto& body = *object.body;
        std::function<void(unsigned, std::size_t, Vec3)> visit = [&](unsigned depth, std::size_t index, Vec3 centre) {
            const auto& level = body.levels[depth];
            if (!sphere({start, 0}, {end, 0}, transform_point(object.world, centre), level.radius, object.principal))
                return;
            const auto mask = body.masks.at(index);
            if (!mask || depth + 1 == body.levels.size()) {
                const auto contact = body_ray(centre, level.radius, object.world, object.inverse, start, end);
                if (contact && (!best || contact->t < best->t))
                    best = contact;
            } else
                for (unsigned bit = 0; bit < 8; ++bit)
                    if (mask & (1u << bit))
                        visit(depth + 1, index + (bit + 1) * level.stride,
                              child(centre, body.levels[depth + 1].offset, bit));
        };
        visit(0, 0, body.centre);
        return best;
    }
};

CollisionWorld::CollisionWorld() : data_(std::make_unique<Data>()) {}

CollisionWorld::~CollisionWorld() = default;
CollisionWorld::CollisionWorld(CollisionWorld&&) noexcept = default;
CollisionWorld& CollisionWorld::operator=(CollisionWorld&&) noexcept = default;

std::vector<std::string> collision_files(const std::filesystem::path& root) {
    std::set<std::string> files;
    if (root.empty() || !std::filesystem::exists(root / "Instances.json"))
        return {};
    const auto doc = read(asset(root, "Instances.json"));
    for (const auto& row : doc.at("Instances"))
        if (row.value("CollsionMode", 0) == 1 && row.contains("CollsionModelPaths") &&
            !row.at("CollsionModelPaths").is_null())
            for (const auto& value : row.at("CollsionModelPaths")) {
                const auto name = value.get<std::string>();
                if (!valid_map_name(name))
                    throw std::runtime_error("Unsafe collision proxy filename");
                files.insert("Collision/" + name);
            }
    return {files.begin(), files.end()};
}

CollisionWorld CollisionWorld::load(const std::filesystem::path& root) {
    CollisionWorld world;
    if (root.empty() || !std::filesystem::exists(root / "Instances.json"))
        return world;
    const auto doc = read(asset(root, "Instances.json"));
    const auto& rows = doc.at("Instances");
    if (!rows.is_array() || rows.size() > 100000)
        throw std::runtime_error("Invalid collision instance count");
    world.data_->instance_objects.resize(rows.size());
    std::vector<std::size_t> box_models;
    bool enabled = false, has_bodies = false;
    for (const auto& row : rows) {
        const auto mode = row.value("CollsionMode", 0);
        if (mode < 0 || mode > 3)
            throw std::runtime_error("Invalid collision mode");
        if (!mode || !row.value("PlayerCollision", false))
            continue;
        enabled = true;
        if (mode == 2)
            box_models.push_back(row.at("ModelID"));
        has_bodies |= mode == 3;
    }
    if (!enabled)
        return world;
    const auto layouts = prop_layout(root, box_models);
    const auto placements = prop_detail::placements(rows);
    const auto physics = has_bodies ? read_bodies(root) : std::vector<std::vector<std::shared_ptr<Body>>>{};
    std::map<std::string, std::shared_ptr<Proxy>> proxies;
    std::set<const Body*> counted;
    for (std::size_t i = 0; i < rows.size(); ++i) {
        const auto& row = rows[i];
        const auto mode = row.value("CollsionMode", 0);
        if (mode < 0 || mode > 3)
            throw std::runtime_error("Invalid collision mode");
        if (!mode || !row.value("PlayerCollision", false))
            continue;
        const auto model = row.at("ModelID").get<std::size_t>();
        if (model >= layouts.size())
            throw std::runtime_error("Collision model is missing");
        std::vector<std::shared_ptr<Proxy>> shapes;
        std::vector<std::shared_ptr<Body>> bodies_for_instance;
        if (mode == 1) {
            if (!row.contains("CollsionModelPaths") || row.at("CollsionModelPaths").is_null())
                continue;
            for (const auto& name : row.at("CollsionModelPaths")) {
                const auto filename = name.get<std::string>();
                if (!valid_map_name(filename))
                    throw std::runtime_error("Unsafe collision proxy path");
                auto& value = proxies[filename];
                if (!value) {
                    value = std::make_shared<Proxy>(proxy(asset(root, "Collision/" + filename)));
                    world.data_->triangle_count += value->triangles.size();
                }
                shapes.push_back(value);
            }
            if (shapes.empty())
                continue;
        }
        if (mode == 3) {
            const auto index = row.value("PhysicsIndex", -1);
            if (index < 0)
                continue;
            if (std::size_t(index) >= physics.size())
                throw std::runtime_error("Physics body pool is missing");
            bodies_for_instance = physics[std::size_t(index)];
            if (bodies_for_instance.empty())
                continue;
        }
        std::vector<std::size_t> objects;
        for (std::size_t j = 0; j < layouts[model].size(); ++j)
            if (mode == 2 ? layouts[model][j].has_box : layouts[model][j].has_geometry)
                objects.push_back(j);
        const auto needed = mode == 1 ? shapes.size() : mode == 3 ? bodies_for_instance.size() : objects.size();
        if (needed != objects.size()) {
            if (needed != layouts[model].size())
                throw std::runtime_error("Collision payload count disagrees with model objects");
            objects.resize(needed);
            std::iota(objects.begin(), objects.end(), 0);
        }
        for (std::size_t j = 0; j < objects.size(); ++j) {
            const auto& layout = layouts[model][objects[j]];
            Data::Object object;
            object.instance = i;
            object.mode = mode;
            object.mass = row.value("U0", 0.);
            object.bounce = row.value("PlayerBounceAmmount", 0.);
            object.surface = row.value("SurfaceType", -1);
            object.effect = row.value("EffectSlotIndex", -1);
            if (!std::isfinite(object.mass) || !std::isfinite(object.bounce) || object.bounce < 0)
                throw std::runtime_error("Invalid collision response values");
            object.response = object.mass != 0 && row.value("PlayerBounce", false);
            object.model_object = objects[j];
            object.placement = placements.at(i);
            object.rest = map_transform(layout.rest);
            object.world = multiply(object.placement, object.rest);
            object.previous = object.world;
            object.inverse = object.previous_inverse = inverse_transform(object.world);
            object.box = layout.box;
            if (mode == 1) {
                object.proxy = shapes[j];
                if (object.proxy->triangles.empty())
                    continue;
                object.box = object.proxy->box;
            }
            if (mode == 3) {
                object.body = bodies_for_instance[j];
                object.box = object.body->box;
                object.principal = principal(object.world);
                if (counted.insert(object.body.get()).second)
                    ++world.data_->body_count;
            }
            world.data_->instance_objects[i].push_back(world.data_->objects.size());
            world.data_->boxes.push_back(placed(object.box, object.world));
            world.data_->objects.push_back(std::move(object));
            if (world.data_->objects.size() > 200000)
                throw std::runtime_error("Too many placed collision objects");
        }
    }
    world.data_->tree.build(world.data_->boxes);
    return world;
}

std::vector<WorldContact> CollisionWorld::sweep(std::span<const ProbeSphere> start, std::span<const ProbeSphere> end,
                                                double trigger_margin) const {
    if (!std::isfinite(trigger_margin) || trigger_margin < 0 || trigger_margin > .1)
        throw std::invalid_argument("Invalid trigger contact margin");
    if (start.empty() || start.size() != end.size() || start.size() > 19)
        throw std::runtime_error("Invalid rider probe volume");
    Bounds query, trigger_query;
    for (std::size_t i = 0; i < start.size(); ++i) {
        if (!finite(start[i].centre) || !finite(end[i].centre) || start[i].radius < 0 || end[i].radius < 0 ||
            !std::isfinite(start[i].radius) || !std::isfinite(end[i].radius))
            throw std::runtime_error("Invalid collision sphere");
        const auto radius = std::max(start[i].radius, end[i].radius);
        trigger_query.add(expanded(Bounds{start[i].centre, start[i].centre}, radius + trigger_margin).min);
        trigger_query.add(expanded(Bounds{start[i].centre, start[i].centre}, radius + trigger_margin).max);
        trigger_query.add(expanded(Bounds{end[i].centre, end[i].centre}, radius + trigger_margin).min);
        trigger_query.add(expanded(Bounds{end[i].centre, end[i].centre}, radius + trigger_margin).max);
        if (i == 0 && start.size() > 1)
            continue;
        query.add(expanded(Bounds{start[i].centre, start[i].centre}, radius).min);
        query.add(expanded(Bounds{start[i].centre, start[i].centre}, radius).max);
        query.add(expanded(Bounds{end[i].centre, end[i].centre}, radius).min);
        query.add(expanded(Bounds{end[i].centre, end[i].centre}, radius).max);
    }
    std::vector<std::size_t> candidates;
    if (trigger_margin == 0)
        trigger_query = query;
    data_->tree.query(trigger_query, candidates);
    std::map<std::size_t, WorldContact> contacts;
    for (const auto index : candidates) {
        const auto& object = data_->objects[index];
        const auto responsive = data_->responsive(object);
        if ((!data_->flags.empty() && !(data_->flags[object.instance] & 2)) ||
            !overlaps(responsive ? query : trigger_query, data_->boxes[index]))
            continue;
        const auto first = object.mode == 3 && start.size() > 1 ? 1u : 0u,
                   limit = object.mode == 2 ? 1u : unsigned(start.size());
        if (object.mode == 3 &&
            !sphere(data_->relative(object, start[0]), end[0], transform_point(object.world, object.body->centre),
                    object.body->levels[0].radius, object.principal))
            continue;
        for (unsigned j = first; j < limit; ++j) {
            auto from = start[j], to = end[j];
            if (!responsive) {
                from.radius += trigger_margin;
                to.radius += trigger_margin;
            }
            if (const auto hit = data_->hit(object, from, to)) {
                WorldContact contact;
                static_cast<ShapeContact&>(contact) = *hit;
                contact.instance = object.instance;
                contact.object = index;
                contact.surface_velocity = data_->velocity(object, contact.point, contact.t);
                contact.mass = object.mass;
                contact.bounce = object.bounce;
                contact.surface = object.surface;
                contact.effect = object.effect;
                contact.response = data_->responsive(object);
                const auto old = contacts.find(object.instance);
                if (old == contacts.end() || hit->t < old->second.t)
                    contacts[object.instance] = contact;
            }
        }
    }
    std::vector<WorldContact> result;
    for (const auto& [id, contact] : contacts) {
        static_cast<void>(id);
        result.push_back(contact);
    }
    std::stable_sort(result.begin(), result.end(), [](const auto& a, const auto& b) { return a.t < b.t; });
    return result;
}

std::optional<PropBodyShape> CollisionWorld::body_shape(std::size_t instance) const {
    if (instance >= data_->instance_objects.size())
        return {};
    for (const auto index : data_->instance_objects[instance]) {
        const auto& object = data_->objects[index];
        if (!object.body)
            continue;
        PropBodyShape shape;
        shape.placement = multiply(object.world, inverse_transform(object.rest));
        // [Trailmap: 230-mass] The mass centre and inverse inertia are model-space data.
        shape.centre = object.body->mass_centre;
        shape.inverse_inertia = object.body->inverse_inertia;
        const auto principal_rest = principal(object.rest);
        const auto scale = *std::max_element(principal_rest.scale.begin(), principal_rest.scale.end());
        const auto visit = [&](auto&& self, unsigned depth, std::size_t mask, Vec3 centre) -> void {
            const auto bits = object.body->masks.at(mask);
            if (!bits || depth + 1 == object.body->levels.size()) {
                if (shape.probes.size() >= 32768)
                    throw std::runtime_error("Dynamic body exceeds sphere budget");
                shape.probes.push_back(
                    {transform_point(object.rest, centre), object.body->levels[depth].radius * scale});
            } else
                for (unsigned bit = 0; bit < 8; ++bit)
                    if (bits & (1u << bit))
                        self(self, depth + 1, mask + (bit + 1) * object.body->levels[depth].stride,
                             child(centre, object.body->levels[depth + 1].offset, bit));
        };
        visit(visit, 0, 0, object.body->centre);
        return shape; // Scripted knock-off bodies use physics payload zero.
    }
    return {};
}

std::vector<WorldContact> CollisionWorld::sweep_body(std::span<const ProbeSphere> start,
                                                     std::span<const ProbeSphere> end, std::size_t exclude) const {
    if (start.empty() || start.size() != end.size() || start.size() > 32768)
        throw std::invalid_argument("Invalid moving body sweep");
    Bounds query;
    std::vector<Bounds> boxes;
    for (std::size_t i = 0; i < start.size(); ++i) {
        Bounds box;
        for (const auto p : {start[i], end[i]}) {
            if (!finite(p.centre) || !std::isfinite(p.radius) || p.radius <= 0)
                throw std::invalid_argument("Invalid moving body sphere");
            box.add(expanded(Bounds{p.centre, p.centre}, p.radius).min);
            box.add(expanded(Bounds{p.centre, p.centre}, p.radius).max);
        }
        boxes.push_back(box);
        query.add(box.min);
        query.add(box.max);
    }
    std::vector<std::size_t> candidates;
    data_->tree.query(query, candidates);
    std::map<std::pair<std::size_t, std::size_t>, WorldContact> contacts;
    for (const auto index : candidates) {
        const auto& object = data_->objects[index];
        if (object.instance == exclude || !data_->responsive(object) ||
            (!data_->flags.empty() && !(data_->flags[object.instance] & 2)) || !overlaps(query, data_->boxes[index]))
            continue;
        for (std::size_t i = 0; i < start.size(); ++i) {
            if (!overlaps(boxes[i], data_->boxes[index]))
                continue;
            const auto hit = data_->hit_current(object, start[i], end[i]);
            if (!hit || (hit->depth <= 1e-8 && dot(end[i].centre - start[i].centre, hit->normal) >= -1e-9))
                continue;
            WorldContact contact;
            static_cast<ShapeContact&>(contact) = *hit;
            contact.instance = object.instance;
            contact.object = index;
            contact.response = true;
            contact.surface_velocity = data_->velocity(object, hit->point);
            contact.surface = object.surface;
            contact.mass = object.mass;
            contact.bounce = object.bounce;
            contact.effect = object.effect;
            const auto key = std::pair{contact.instance, i};
            const auto old = contacts.find(key);
            if (old == contacts.end() || hit->t < old->second.t ||
                (hit->t == old->second.t && hit->depth > old->second.depth))
                contacts[key] = contact;
        }
    }
    std::vector<WorldContact> result;
    for (const auto& [instance, contact] : contacts) {
        static_cast<void>(instance);
        result.push_back(contact);
    }
    std::stable_sort(result.begin(), result.end(), [](const auto& a, const auto& b) { return a.t < b.t; });
    return result;
}

std::optional<WorldContact> CollisionWorld::ray(Vec3 start, Vec3 end, bool rideable) const {
    if (!finite(start) || !finite(end))
        throw std::runtime_error("Invalid collision ray");
    Bounds query;
    query.add(start);
    query.add(end);
    std::vector<std::size_t> candidates;
    data_->tree.query(query, candidates);
    std::optional<WorldContact> result;
    for (const auto index : candidates) {
        const auto& object = data_->objects[index];
        const bool fragile = !data_->flags.empty() && (data_->flags[object.instance] & 4);
        if ((!data_->flags.empty() && !(data_->flags[object.instance] & 2)) ||
            (!data_->responsive(object) && !fragile) ||
            (rideable && !fragile && (object.surface < 0 || object.surface == 17)))
            continue;
        if (const auto hit = data_->ray_hit(object, start, end); hit && (!result || hit->t < result->t)) {
            WorldContact contact;
            static_cast<ShapeContact&>(contact) = *hit;
            contact.instance = object.instance;
            contact.object = index;
            contact.surface_velocity = data_->velocity(object, contact.point);
            contact.surface = fragile && object.surface < 0 ? 1 : object.surface;
            contact.effect = object.effect;
            contact.mass = object.mass;
            contact.bounce = object.bounce;
            contact.response = data_->responsive(object);
            if (dot(contact.normal, end - start) > 0)
                contact.normal = -contact.normal;
            result = contact;
        }
    }
    return result;
}

std::optional<WorldVolume> CollisionWorld::volume(std::size_t instance, Vec3 start, Vec3 end, double radius) const {
    if (!finite(start) || !finite(end) || !std::isfinite(radius) || radius < 0 || radius > 10)
        throw std::invalid_argument("Invalid world volume probe");
    if (instance >= data_->instance_objects.size() || (!data_->flags.empty() && !(data_->flags[instance] & 2)))
        return {};
    std::optional<WorldVolume> result;
    for (const auto index : data_->instance_objects[instance]) {
        const auto& object = data_->objects[index];
        const auto previous = data_->relative(object, {start, 0}).centre;
        bool hit = radius > 0 ? bool(data_->hit_current(object, {previous, radius}, {end, radius}))
                              : bool(data_->ray_hit(object, previous, end));
        const auto contains = [&](Vec3 point) {
            const auto local = transform_point(object.inverse, point);
            const auto& box = object.box;
            if (local.x < box.min.x - 1e-8 || local.x > box.max.x + 1e-8 || local.y < box.min.y - 1e-8 ||
                local.y > box.max.y + 1e-8 || local.z < box.min.z - 1e-8 || local.z > box.max.z + 1e-8)
                return false;
            if (object.mode == 2)
                return true;
            if (object.mode == 3)
                return bool(data_->hit_current(object, {point, 0}, {point, 0}));
            const auto extent = box.max - box.min;
            if (std::min({extent.x, extent.y, extent.z}) < 1e-9)
                return bool(data_->hit_current(object, {point, 0}, {point, 0}));
            const auto outside = local + normalized(Vec3{1, .237, .419}) * (length(extent) * 2 + 1);
            std::vector<double> crossings;
            for (const auto& tri : object.proxy->triangles)
                if (const auto contact = swept_triangle(tri.a, tri.b, tri.c, {local, 0}, {outside, 0})) {
                    if (contact->t < 1e-9)
                        return true;
                    crossings.push_back(contact->t);
                }
            std::sort(crossings.begin(), crossings.end());
            unsigned unique = 0;
            double last = -1;
            for (const auto t : crossings)
                if (t - last > 1e-7) {
                    ++unique;
                    last = t;
                }
            return unique % 2 != 0;
        };
        hit |= contains(previous) || contains(end);
        if (!hit)
            continue;
        const auto box = placed(object.box, object.world);
        if (!result)
            result = WorldVolume{
                box,
                normalized(transform_point(object.world, {1, 0, 0}) - transform_point(object.world, {}), {1, 0, 0})};
        else {
            result->box.add(box.min);
            result->box.add(box.max);
        }
    }
    return result;
}

std::size_t CollisionWorld::objects() const { return data_->objects.size(); }

std::size_t CollisionWorld::triangles() const { return data_->triangle_count; }

std::size_t CollisionWorld::bodies() const { return data_->body_count; }

void CollisionWorld::instance_flags(std::span<const std::uint8_t> flags) {
    if (!flags.empty())
        for (const auto& object : data_->objects)
            if (object.instance >= flags.size())
                throw std::invalid_argument("World instance flags do not cover collision objects");
    data_->flags.assign(flags.begin(), flags.end());
}

void CollisionWorld::motion(std::span<const PropMotion> poses, double seconds) {
    if (!std::isfinite(seconds) || seconds <= 0 || seconds > 1)
        throw std::invalid_argument("Invalid prop collision duration");
    data_->seconds = seconds;
    std::set<std::size_t> changed = data_->dynamic;
    std::map<std::size_t, const PropMotion*> moving;
    for (const auto& pose : poses) {
        for (const auto* frames : {&pose.previous, &pose.current})
            for (const auto& transform : *frames) {
                for (const auto value : transform)
                    if (!std::isfinite(value))
                        throw std::invalid_argument("Invalid collision motion transform");
            }
        if (pose.instance >= data_->instance_objects.size() || pose.current.size() != pose.previous.size() ||
            !moving.emplace(pose.instance, &pose).second)
            throw std::invalid_argument("Invalid collision motion binding");
        for (const auto index : data_->instance_objects[pose.instance]) {
            if (data_->objects[index].model_object >= pose.current.size())
                throw std::invalid_argument("Collision motion misses objects");
            if (!pose.visual_only)
                changed.insert(index);
        }
    }
    data_->dynamic.clear();
    for (const auto index : changed) {
        auto& object = data_->objects[index];
        const auto found = moving.find(object.instance);
        if (found == moving.end() || found->second->visual_only) {
            object.world = multiply(object.placement, object.rest);
            object.previous = object.world;
            object.moving = false;
        } else {
            const auto& pose = *found->second;
            object.world = multiply(multiply(object.placement, pose.current[object.model_object]), object.rest);
            object.previous = multiply(multiply(object.placement, pose.previous[object.model_object]), object.rest);
            object.moving = object.world != object.previous;
            data_->dynamic.insert(index);
        }
        object.inverse = inverse_transform(object.world);
        object.previous_inverse = inverse_transform(object.previous);
        if (object.mode == 3)
            object.principal = principal(object.world);
        auto bounds = placed(object.box, object.world);
        const auto previous = placed(object.box, object.previous);
        bounds.add(previous.min);
        bounds.add(previous.max);
        data_->boxes[index] = bounds;
    }
    data_->tree.refit(data_->boxes, changed);
}

Vec3 CollisionWorld::carry(std::size_t index, Vec3 point) const {
    if (index >= data_->objects.size())
        return {};
    const auto& object = data_->objects[index];
    if (!object.moving)
        return {};
    return transform_point(object.world, transform_point(object.previous_inverse, point)) - point;
}

} // namespace openslope
