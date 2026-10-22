#include "openslope/avatar.hpp"
#include <cstring>
#include <functional>
#include <nlohmann/json.hpp>
#include <stb_image.h>
#include <stdexcept>

namespace openslope {
namespace {
using Json = nlohmann::json;
using Matrix = std::array<double, 16>;
constexpr Matrix identity{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};

Matrix avatar_multiply(const Matrix& a, const Matrix& b) {
    Matrix out{};
    for (unsigned c = 0; c < 4; ++c)
        for (unsigned r = 0; r < 4; ++r)
            for (unsigned k = 0; k < 4; ++k)
                out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return out;
}

Vec3 map(const Matrix& m, Vec3 p, double w = 1) {
    return {m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12] * w, m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13] * w,
            m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14] * w};
}

Matrix local_matrix(const Json& node) {
    if (node.contains("matrix"))
        return node.at("matrix").get<Matrix>();
    const auto t = node.value("translation", std::array<double, 3>{}),
               s = node.value("scale", std::array<double, 3>{1, 1, 1});
    const auto q = node.value("rotation", std::array<double, 4>{0, 0, 0, 1});
    const auto x = q[0], y = q[1], z = q[2], w = q[3];
    return {(1 - 2 * y * y - 2 * z * z) * s[0],
            (2 * x * y + 2 * z * w) * s[0],
            (2 * x * z - 2 * y * w) * s[0],
            0,
            (2 * x * y - 2 * z * w) * s[1],
            (1 - 2 * x * x - 2 * z * z) * s[1],
            (2 * y * z + 2 * x * w) * s[1],
            0,
            (2 * x * z + 2 * y * w) * s[2],
            (2 * y * z - 2 * x * w) * s[2],
            (1 - 2 * x * x - 2 * y * y) * s[2],
            0,
            t[0],
            t[1],
            t[2],
            1};
}

float display(double value) {
    value = std::clamp(value, 0., 1.);
    return float(value <= .0031308 ? value * 12.92 : 1.055 * std::pow(value, 1 / 2.4) - .055);
}

std::string normalized_name(std::string_view name) {
    std::string result;
    for (const auto c : name) {
        if (c >= 'A' && c <= 'Z')
            result += char(c - 'A' + 'a');
        else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))
            result += c;
    }
    return result;
}

// Canonical names are shared with Slopesmith's character contract. Punctuation is optional.
std::string canonical_name(const std::string& name) {
    static const std::vector<std::string> names = [] {
        std::vector<std::string> out{"Hips", "Spine", "Chest", "ChestUpper", "Neck", "Head"};
        for (const auto* side : {"L", "R"})
            for (const auto* part :
                 {"Clavicle", "UpperArm", "LowerArm", "Hand", "Pelvis", "UpperLeg", "LowerLeg", "Foot"})
                out.push_back(std::string(part) + "." + side);
        for (const auto* side : {"Left", "Right"})
            for (const auto* finger : {"Thumb", "Index", "Middle", "Ring", "Pinky"})
                for (unsigned i = 1; i <= 3; ++i)
                    out.push_back(std::string(side) + "Hand" + finger + std::to_string(i));
        return out;
    }();
    const auto key = normalized_name(name);
    for (const auto& candidate : names)
        if (normalized_name(candidate) == key)
            return candidate;
    return name;
}
} // namespace

Avatar::Avatar(std::span<const unsigned char> bytes) {
    if (bytes.size() < 28 || bytes.size() > 32 * 1024 * 1024)
        throw std::runtime_error("Avatar GLB size exceeds bounds");
    const auto word = [&](std::size_t offset) {
        if (offset > bytes.size() - 4)
            throw std::runtime_error("Truncated avatar GLB");
        std::uint32_t v;
        std::memcpy(&v, bytes.data() + offset, 4);
        return v;
    };
    if (word(0) != 0x46546c67 || word(4) != 2 || word(8) != bytes.size() || word(16) != 0x4e4f534a)
        throw std::runtime_error("Invalid avatar GLB");
    const auto header = std::size_t(20) + word(12);
    if (header > bytes.size() - 8 || word(header + 4) != 0x004e4942 || word(header) != bytes.size() - header - 8)
        throw std::runtime_error("Invalid avatar binary chunk");
    const auto binary = bytes.subspan(header + 8);
    if (header - 20 > 4 * 1024 * 1024)
        throw std::runtime_error("Avatar JSON exceeds bounds");
    const auto data =
        Json::parse(bytes.begin() + 20, bytes.begin() + header, [](int depth, Json::parse_event_t, Json&) {
            if (depth > 64)
                throw std::runtime_error("Avatar JSON nesting exceeds bounds");
            return true;
        });
    if (data.at("buffers").size() != 1 || data.at("buffers").at(0).contains("uri"))
        throw std::runtime_error("Avatar must embed its buffer");
    const auto view_bytes = [&](unsigned index) {
        const auto& v = data.at("bufferViews").at(index);
        const auto offset = v.value("byteOffset", std::size_t(0)), size = v.at("byteLength").get<std::size_t>();
        if (v.value("buffer", 0) != 0 || offset > binary.size() || size > binary.size() - offset)
            throw std::runtime_error("Avatar buffer view outside binary");
        return binary.subspan(offset, size);
    };
    const auto read = [&](unsigned index, std::string_view shape, unsigned limit) {
        const auto& a = data.at("accessors").at(index);
        const auto type = a.at("componentType").get<unsigned>();
        const auto lanes = shape == "SCALAR" ? 1u
                           : shape == "VEC2" ? 2u
                           : shape == "VEC3" ? 3u
                           : shape == "VEC4" ? 4u
                                             : 16u;
        const auto size = type == 5121 ? 1u : type == 5123 ? 2u : type == 5125 || type == 5126 ? 4u : 0u;
        const auto count = a.at("count").get<std::size_t>();
        if (!size || a.at("type").get<std::string>() != shape || a.contains("sparse") || count > limit)
            throw std::runtime_error("Unsupported avatar accessor");
        const auto v = view_bytes(a.at("bufferView").get<unsigned>());
        const auto& descriptor = data.at("bufferViews").at(a.at("bufferView").get<unsigned>());
        const auto stride = descriptor.value("byteStride", std::size_t(size * lanes)),
                   offset = a.value("byteOffset", std::size_t(0));
        if (stride < size * lanes || offset > v.size() ||
            (count &&
             ((count - 1) > (v.size() - offset) / stride || size * lanes > v.size() - offset - (count - 1) * stride)))
            throw std::runtime_error("Avatar accessor outside buffer view");
        std::vector<double> out;
        out.reserve(count * lanes);
        for (std::size_t i = 0; i < count; ++i)
            for (unsigned k = 0; k < lanes; ++k) {
                const auto* p = v.data() + offset + i * stride + k * size;
                double value;
                if (type == 5126) {
                    float f;
                    std::memcpy(&f, p, 4);
                    value = f;
                } else {
                    std::uint32_t n = 0;
                    std::memcpy(&n, p, size);
                    value = n;
                }
                if (a.value("normalized", false) && type != 5126)
                    value /= type == 5121 ? 255. : type == 5123 ? 65535. : 4294967295.;
                if (!std::isfinite(value))
                    throw std::runtime_error("Non-finite avatar accessor");
                out.push_back(value);
            }
        return out;
    };
    const auto& nodes = data.at("nodes");
    if (nodes.empty() || nodes.size() > 512 || data.at("skins").size() != 1)
        throw std::runtime_error("Avatar rig exceeds bounds");
    std::vector<int> parents(nodes.size(), -1), states(nodes.size());
    std::vector<Matrix> global(nodes.size());
    for (unsigned i = 0; i < nodes.size(); ++i)
        for (const auto& c : nodes[i].value("children", Json::array())) {
            const auto child = c.get<unsigned>();
            if (child >= nodes.size() || parents[child] != -1)
                throw std::runtime_error("Invalid avatar hierarchy");
            parents[child] = int(i);
        }
    std::function<void(unsigned)> visit = [&](unsigned i) {
        if (states[i] == 1)
            throw std::runtime_error("Cyclic avatar hierarchy");
        if (states[i] == 2)
            return;
        states[i] = 1;
        if (parents[i] >= 0)
            visit(unsigned(parents[i]));
        const auto local = local_matrix(nodes[i]);
        global[i] = parents[i] < 0 ? local : avatar_multiply(global[unsigned(parents[i])], local);
        for (const auto v : global[i])
            if (!std::isfinite(v) || std::abs(v) > 10000)
                throw std::runtime_error("Invalid avatar transform");
        states[i] = 2;
    };
    for (unsigned i = 0; i < nodes.size(); ++i)
        visit(i);
    const auto& skin = data.at("skins").at(0);
    const auto joints = skin.at("joints").get<std::vector<unsigned>>();
    if (joints.empty() || joints.size() > 128)
        throw std::runtime_error("Avatar joints exceed bounds");
    std::vector<int> node_bone(nodes.size(), -1);
    std::vector<unsigned> remap(joints.size());
    std::function<unsigned(unsigned)> add_bone = [&](unsigned index) {
        const auto node = joints.at(index);
        if (node >= nodes.size())
            throw std::runtime_error("Avatar joint outside nodes");
        if (node_bone[node] >= 0)
            return unsigned(node_bone[node]);
        int parent = parents[node];
        unsigned parent_bone = unsigned(bones_.size());
        while (parent >= 0) {
            const auto found = std::find(joints.begin(), joints.end(), unsigned(parent));
            if (found != joints.end()) {
                parent_bone = add_bone(unsigned(found - joints.begin()));
                break;
            }
            parent = parents[unsigned(parent)];
        }
        const auto output = unsigned(bones_.size());
        if (parent < 0)
            parent_bone = output;
        const auto& m = global[node];
        const auto head = map(m, {});
        const auto name = canonical_name(nodes[node].value("name", std::string{}));
        std::array<Vec3, 3> axes{normalized(map(m, {1, 0, 0}, 0)), normalized(map(m, {0, 1, 0}, 0)),
                                 normalized(map(m, {0, 0, 1}, 0))};
        auto tail = head + axes[1] * .1;
        // Branch order differs between Blender and the generated GLBs.
        const std::string next = name == "Hips"                 ? "Spine"
                                 : name == "Spine"              ? "Chest"
                                 : name == "Chest"              ? "Neck"
                                 : name == "Neck"               ? "Head"
                                 : name.starts_with("Clavicle") ? "UpperArm" + name.substr(8)
                                 : name.starts_with("UpperArm") ? "LowerArm" + name.substr(8)
                                 : name.starts_with("LowerArm") ? "Hand" + name.substr(8)
                                 : name.starts_with("Pelvis")   ? "UpperLeg" + name.substr(6)
                                 : name.starts_with("UpperLeg") ? "LowerLeg" + name.substr(8)
                                 : name.starts_with("LowerLeg") ? "Foot" + name.substr(8)
                                                                : "";
        for (const auto candidate : joints)
            if (!next.empty() && canonical_name(nodes.at(candidate).value("name", std::string{})) == next)
                tail = map(global[candidate], {});
        if (name.starts_with("LeftHand") || name.starts_with("RightHand"))
            for (const auto& child : nodes[node].value("children", Json::array())) {
                tail = map(global.at(child.get<unsigned>()), {});
                break;
            }
        bones_.push_back({name, head, tail, parent_bone, axes});
        node_bone[node] = int(output);
        return output;
    };
    for (unsigned i = 0; i < joints.size(); ++i)
        remap[i] = add_bone(i);
    for (const auto* name : {"Hips", "Chest", "Head", "UpperArm.L", "LowerArm.L", "Hand.L", "UpperArm.R", "LowerArm.R",
                             "Hand.R", "UpperLeg.L", "LowerLeg.L", "Foot.L", "UpperLeg.R", "LowerLeg.R", "Foot.R"})
        if (std::none_of(bones_.begin(), bones_.end(), [&](const auto& b) { return b.name == name; }))
            throw std::runtime_error("Avatar is missing a required bone");
    std::vector<Matrix> bind(joints.size(), identity);
    if (skin.contains("inverseBindMatrices")) {
        const auto values = read(skin.at("inverseBindMatrices").get<unsigned>(), "MAT4", 128);
        if (values.size() != joints.size() * 16)
            throw std::runtime_error("Avatar inverse bind count differs");
        for (unsigned i = 0; i < joints.size(); ++i)
            std::copy_n(values.begin() + i * 16, 16, bind[i].begin());
    }
    for (unsigned i = 0; i < joints.size(); ++i)
        bind[i] = avatar_multiply(global[joints[i]], bind[i]);
    const auto& materials = data.at("materials");
    if (materials.empty() || materials.size() > 32)
        throw std::runtime_error("Avatar materials exceed bounds");
    // One bounded atlas includes base colour and emissive art. Two-pixel gutters protect mip edges.
    constexpr unsigned tile = 516, edge = 512;
    std::vector<RgbaImage> images;
    std::map<unsigned, unsigned> image_slots;
    const auto image_slot = [&](unsigned texture) {
        const auto source = data.at("textures").at(texture).at("source").get<unsigned>();
        if (image_slots.contains(source))
            return image_slots.at(source);
        if (images.size() >= 32)
            throw std::runtime_error("Avatar image count exceeds bounds");
        const auto& image = data.at("images").at(source);
        const auto encoded = view_bytes(image.at("bufferView").get<unsigned>());
        RgbaImage pixels;
        if (image.at("mimeType") == "image/png")
            pixels = read_png(encoded);
        else if (image.at("mimeType") == "image/jpeg") {
            int w = 0, h = 0, channels = 0;
            if (!stbi_info_from_memory(encoded.data(), int(encoded.size()), &w, &h, &channels) || w <= 0 || h <= 0 ||
                w > 4096 || h > 4096)
                throw std::runtime_error("Avatar JPEG dimensions exceed bounds");
            auto* raw = stbi_load_from_memory(encoded.data(), int(encoded.size()), &w, &h, &channels, 4);
            if (!raw)
                throw std::runtime_error("Invalid avatar JPEG");
            pixels.width = unsigned(w);
            pixels.height = unsigned(h);
            pixels.pixels.assign(raw, raw + std::size_t(w) * std::size_t(h) * 4);
            stbi_image_free(raw);
        } else
            throw std::runtime_error("Avatar textures require embedded PNG or JPEG");
        if (pixels.width > edge || pixels.height > edge) {
            RgbaImage small{std::min(edge, pixels.width), std::min(edge, pixels.height), {}};
            small.pixels.resize(std::size_t(small.width) * small.height * 4);
            for (unsigned y = 0; y < small.height; ++y)
                for (unsigned x = 0; x < small.width; ++x) {
                    const auto source_pixel = (std::size_t(y * pixels.height / small.height) * pixels.width +
                                               x * pixels.width / small.width) *
                                              4;
                    std::copy_n(pixels.pixels.begin() + source_pixel, 4,
                                small.pixels.begin() + (std::size_t(y) * small.width + x) * 4);
                }
            pixels = std::move(small);
        }
        const auto slot = unsigned(images.size());
        image_slots[source] = slot;
        images.push_back(std::move(pixels));
        return slot;
    };
    std::vector<std::array<int, 2>> slots(materials.size(), {-1, -1});
    for (unsigned i = 0; i < materials.size(); ++i) {
        const auto& material = materials[i];
        const auto pbr = material.value("pbrMetallicRoughness", Json::object());
        if (pbr.contains("baseColorTexture"))
            slots[i][0] = int(image_slot(pbr.at("baseColorTexture").at("index").get<unsigned>()));
        if (material.contains("emissiveTexture"))
            slots[i][1] = int(image_slot(material.at("emissiveTexture").at("index").get<unsigned>()));
    }
    auto atlas = std::make_shared<RgbaImage>();
    const auto columns = std::min(6u, unsigned(images.size()) + 1),
               rows = (unsigned(images.size()) + columns) / columns;
    if (!images.empty()) {
        atlas->width = columns * tile;
        atlas->height = rows * tile;
        atlas->pixels.resize(std::size_t(atlas->width) * atlas->height * 4, 0);
        // The last tile is white for untextured base colours. Empty emissive slots use zero strength.
        images.push_back({1, 1, {255, 255, 255, 255}});
        for (unsigned i = 0; i < images.size(); ++i)
            for (unsigned y = 0; y < tile; ++y)
                for (unsigned x = 0; x < tile; ++x) {
                    const auto& source = images[i];
                    const auto sx = unsigned(std::clamp(int(x) - 2, 0, int(edge) - 1)) * source.width / edge,
                               sy = unsigned(std::clamp(int(y) - 2, 0, int(edge) - 1)) * source.height / edge;
                    const auto dest = (std::size_t(i / columns * tile + y) * atlas->width + i % columns * tile + x) * 4;
                    std::copy_n(source.pixels.begin() + (std::size_t(sy) * source.width + sx) * 4, 4,
                                atlas->pixels.begin() + dest);
                }
        texture_ = atlas;
    }
    const auto uv_at = [&](int slot, double u, double v) {
        if (slot < 0)
            slot = int(images.size()) - 1;
        u = std::clamp(u, 0., 1.);
        v = std::clamp(v, 0., 1.);
        return std::array<float, 2>{float((unsigned(slot) % columns * tile + 2.5 + u * (edge - 1)) / atlas->width),
                                    float((unsigned(slot) / columns * tile + 2.5 + v * (edge - 1)) / atlas->height)};
    };
    std::map<std::string, unsigned> attribute_bases;
    for (const auto& node : nodes) {
        if (!node.contains("mesh"))
            continue;
        if (node.value("skin", unsigned(-1)) != 0)
            throw std::runtime_error("Avatar mesh must use its skin");
        for (const auto& primitive : data.at("meshes").at(node.at("mesh").get<unsigned>()).at("primitives")) {
            if (primitive.value("mode", 4) != 4)
                throw std::runtime_error("Avatar requires triangle primitives");
            const auto& attributes = primitive.at("attributes");
            const auto points = read(attributes.at("POSITION").get<unsigned>(), "VEC3", 30000),
                       normals = read(attributes.at("NORMAL").get<unsigned>(), "VEC3", 30000),
                       indices = read(primitive.at("indices").get<unsigned>(), "SCALAR", 120000),
                       skin_joints = read(attributes.at("JOINTS_0").get<unsigned>(), "VEC4", 30000),
                       weights = read(attributes.at("WEIGHTS_0").get<unsigned>(), "VEC4", 30000);
            const auto count = points.size() / 3;
            if (points.size() != normals.size() || skin_joints.size() != count * 4 || weights.size() != count * 4 ||
                indices.size() % 3 || corners_.size() + indices.size() > 90000)
                throw std::runtime_error("Avatar attribute counts exceed bounds or differ");
            const auto material = primitive.at("material").get<unsigned>();
            const auto& m = materials.at(material);
            const auto pbr = m.value("pbrMetallicRoughness", Json::object());
            const auto colour = pbr.value("baseColorFactor", std::array<double, 4>{1, 1, 1, 1});
            const bool textured = texture_ != nullptr;
            std::vector<double> uvs;
            if (attributes.contains("TEXCOORD_0"))
                uvs = read(attributes.at("TEXCOORD_0").get<unsigned>(), "VEC2", 30000);
            if ((!uvs.empty() && uvs.size() != count * 2) || (slots.at(material)[0] >= 0 && uvs.empty()))
                throw std::runtime_error("Avatar texture coordinates are missing");
            // Share attributes between material groups when their accessors match.
            const auto key = attributes.dump();
            const bool existing = attribute_bases.contains(key);
            const auto base = existing ? attribute_bases.at(key) : unsigned(vertices_.size());
            if (!existing && vertices_.size() + count > 120000)
                throw std::runtime_error("Avatar vertex count exceeds bounds");
            for (std::size_t i = 0; !existing && i < count; ++i) {
                SkinVertex v{};
                double total = 0;
                const Vec3 point{points[i * 3], points[i * 3 + 1], points[i * 3 + 2]},
                    normal{normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]};
                for (unsigned k = 0; k < 4; ++k) {
                    const auto joint = skin_joints[i * 4 + k];
                    const auto weight = weights[i * 4 + k];
                    if (joint < 0 || joint >= joints.size() || std::floor(joint) != joint || weight < 0 || weight > 1)
                        throw std::runtime_error("Invalid avatar skin influence");
                    v.bones[k] = remap[unsigned(joint)];
                    v.weights[k] = weight;
                    total += weight;
                    v.position += map(bind[unsigned(joint)], point) * weight;
                    v.normal += map(bind[unsigned(joint)], normal, 0) * weight;
                }
                if (total < .0001)
                    throw std::runtime_error("Avatar vertex has no skin weight");
                v.position = v.position / total;
                v.normal = normalized(v.normal);
                if (!finite(v.position) || length(v.position) > 10)
                    throw std::runtime_error("Avatar vertex exceeds bounds");
                for (auto& weight : v.weights)
                    weight /= total;
                vertices_.push_back(v);
            }
            attribute_bases[key] = base;
            for (const auto index : indices) {
                if (index < 0 || index >= count || std::floor(index) != index)
                    throw std::runtime_error("Avatar index outside primitive");
                Corner corner{};
                corner.vertex = base + unsigned(index);
                const auto emission = m.value("emissiveFactor", std::array<double, 3>{});
                for (unsigned c = 0; c < 3; ++c)
                    corner.emissive[c] = display(emission[c]);
                for (unsigned c = 0; c < 3; ++c)
                    corner.colour[c] = display(colour[c]);
                if (textured) {
                    const auto u = uvs.empty() ? 0 : uvs[unsigned(index) * 2],
                               v = uvs.empty() ? 0 : uvs[unsigned(index) * 2 + 1];
                    const auto base_uv = uv_at(slots[material][0], u, v), emissive_uv = uv_at(slots[material][1], u, v);
                    corner.uv = {base_uv[0], base_uv[1], emissive_uv[0], emissive_uv[1]};
                    corner.textured = true;
                }
                corners_.push_back(corner);
            }
        }
    }
    if (corners_.empty())
        throw std::runtime_error("Avatar has no skinned triangles");
    mesh_.reserve(corners_.size() + 20000);
}
} // namespace openslope
