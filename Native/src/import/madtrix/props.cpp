#include "props.hpp"
#include "import/strings.hpp"
#include "openslope/props.hpp"
#include <fstream>
#include <map>
#include <nlohmann/json.hpp>
#include <regex>
#include <sstream>

namespace openslope::import_detail {
namespace {
using Json = nlohmann::json;
using Fields = std::map<std::string, std::string>;

void require(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(message);
}

void save(const std::filesystem::path& path, const Json& value) {
    std::ofstream file(path, std::ios::binary);
    file << value.dump() << '\n';
    require(bool(file), "Cannot write Mad Trix animated prop metadata");
}

double number(const Fields& fields, const std::string& name) {
    const auto found = fields.find(name);
    require(found != fields.end(), "Missing Mad Trix animated prop transform");
    std::size_t used = 0;
    const auto value = std::stod(found->second, &used);
    require(used == found->second.size() && std::isfinite(value) && std::abs(value) <= 1e6,
            "Invalid Mad Trix animated prop transform");
    return value;
}

std::array<double, 4> euler(double x, double y, double z) {
    const auto sx = std::sin(x / 2), cx = std::cos(x / 2), sy = std::sin(y / 2), cy = std::cos(y / 2),
               sz = std::sin(z / 2), cz = std::cos(z / 2);
    return {sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz,
            cx * cy * cz + sx * sy * sz};
}

void panel(const Pak& pak, const std::string& name, const std::filesystem::path& path, bool waterfall,
           const ImportCancel& cancel) {
    // [Trailmap: 550-signs, 550-waterfalls] Admit one-material MDL0 VIF streams:
    // V2_16 UVs and V3_32 positions. Waterfall meshes also carry ADC strip masks.
    const auto model = pak.file("model_" + name + ".b", cancel),
               hierarchy = pak.file("hierarchy_" + name + ".b", cancel);
    const Bytes b{model}, h{hierarchy};
    b.range(0, 144);
    const auto count = b.le(142, 1), position_at = 184 + count * 8, adc_at = position_at + 20 + count * 12;
    require((waterfall ? count >= 3 && count <= 128 && model.size() <= 65536
                       : (count == 4 || count == 5) && model.size() == 320 + count * 16) &&
                b.text(0, 4) == "MDL0" && b.le(40, 2) == 1 && b.le(42, 2) == 1 && b.le(143, 1) == 0x75 &&
                (b.le(position_at) >> 16) == (0x7800 | count),
            "Unsupported Mad Trix animated prop layout");
    if (waterfall) {
        // [Trailmap: 550-waterfalls] ADC suppresses strip-bridging triangles.
        require((b.le(adc_at - 4) >> 16) == (0x7100 | count), "Unsupported Mad Trix waterfall strip mask");
        b.range(adc_at, count * 2);
        for (unsigned i = 0; i < count; ++i)
            require(b.le(adc_at + i * 2, 2) == 0 || b.le(adc_at + i * 2, 2) == 0x8000,
                    "Invalid Mad Trix waterfall strip flag");
    }
    require(hierarchy.size() == 80 && h.text(0, 4) == "HIR4" && h.le(8) == 1 && h.le(4) == b.le(4),
            "Unsupported Mad Trix animated prop hierarchy");
    std::array<double, 4> q{};
    double norm = 0;
    for (unsigned i = 0; i < 4; ++i) {
        q[i] = h.number(48 + i * 4);
        norm += q[i] * q[i];
    }
    require(std::isfinite(norm) && norm > .99 && norm < 1.01, "Invalid Mad Trix animated prop rest rotation");
    for (auto& v : q)
        v /= std::sqrt(norm);
    const auto rest = placement({h.number(64) * 100, h.number(68) * 100, h.number(72) * 100}, q, {1, 1, 1});
    std::vector<Vec3> points(count);
    std::ofstream file(path, std::ios::binary);
    for (unsigned i = 0; i < count; ++i) {
        const auto p = position_at + 4 + i * 12;
        points[i] = transform_point(rest, {b.number(p) * 100, b.number(p + 4) * 100, b.number(p + 8) * 100});
        require(finite(points[i]) && length(points[i]) < 1e6, "Invalid Mad Trix animated prop vertex");
        file << "v " << points[i].x << ' ' << points[i].y << ' ' << points[i].z << '\n';
    }
    const auto uv = [&](unsigned i) -> std::array<double, 2> {
        return {b.signed16(144 + i * 4) / 4096., b.signed16(146 + i * 4) / 4096.};
    };
    if (!waterfall)
        for (unsigned i = 0; i < count; ++i)
            file << "vt " << uv(i)[0] << ' ' << 1 - uv(i)[1] << '\n';
    unsigned triangles = 0;
    for (unsigned i = 2; i < count; ++i) {
        if (waterfall && (b.le(adc_at + i * 2, 2) & 0x8000))
            continue;
        const auto a = i & 1 ? i - 1 : i - 2, c = i & 1 ? i - 2 : i - 1;
        if (length(cross(points[c] - points[a], points[i] - points[a])) < 1e-6)
            continue;
        std::array<unsigned, 3> vertices{a, c, i}, texcoords{a + 1, c + 1, i + 1};
        if (waterfall) {
            // [Trailmap: 550-waterfalls] Source sections mirror/rotate their UVs.
            // Rotate or reflect this repeating water tile so increasing U follows
            // the dominant downhill direction, preserving its repeat density.
            std::array<std::array<double, 2>, 3> coords{uv(a), uv(c), uv(i)};
            const auto du1 = coords[1][0] - coords[0][0], dv1 = coords[1][1] - coords[0][1],
                       du2 = coords[2][0] - coords[0][0], dv2 = coords[2][1] - coords[0][1],
                       dz1 = points[c].z - points[a].z, dz2 = points[i].z - points[a].z,
                       determinant = du1 * dv2 - du2 * dv1;
            double gu = 0, gv = 0;
            if (std::abs(determinant) > 1e-9) {
                gu = (dz1 * dv2 - dz2 * dv1) / determinant;
                gv = (du1 * dz2 - du2 * dz1) / determinant;
            }
            const bool swap = std::abs(gv) > std::abs(gu);
            const auto sign = (swap ? gv : gu) > 0 ? -1. : 1.;
            for (unsigned v = 0; v < 3; ++v) {
                file << "vt " << sign * coords[v][swap ? 1 : 0] << ' ' << 1 - coords[v][swap ? 0 : 1] << '\n';
                texcoords[v] = triangles * 3 + v + 1;
            }
        }
        file << "f";
        for (unsigned v = 0; v < 3; ++v)
            file << ' ' << vertices[v] + 1 << '/' << texcoords[v];
        file << '\n';
        ++triangles;
    }
    require(triangles > 0 && bool(file), "Cannot write Mad Trix animated prop mesh");
}
} // namespace

Json write_madtrix_props(const Pak& pak, const std::string& course, const std::filesystem::path& output,
                         const std::function<Image(const std::string&)>& image, const ImportCancel& cancel) {
    std::vector<Fields> definitions, placements;
    static const std::regex attribute(R"re(([A-Za-z_0-9]+)="([^"]*)")re");
    for (unsigned i = 0; i < 4096; ++i) {
        check_cancel(cancel);
        auto index = std::to_string(i);
        index.insert(0, 4 - index.size(), '0');
        const auto name = "xml_" + index + ".xml";
        if (!pak.contains(name))
            continue;
        const auto bytes = pak.file(name, cancel);
        require(bytes.size() <= 1024 * 1024, "Mad Trix animated prop XML exceeds limit");
        const std::string text(bytes.begin(), bytes.end());
        if (!text.starts_with("<ParameterClass ") && !text.starts_with("<ObjectInstance "))
            continue;
        Fields fields;
        for (auto it = std::sregex_iterator(text.begin(), text.end(), attribute); it != std::sregex_iterator(); ++it)
            fields.emplace((*it)[1], (*it)[2]);
        (text.starts_with("<ParameterClass ") ? definitions : placements).push_back(std::move(fields));
    }
    const std::map<std::string, std::string> supported{{"SS_marquee_sign_left.log", "SS_Marquee"},
                                                       {"SS_marquee_sign_right.log", "SS_Marquee"},
                                                       {"SS_marquee_sign_up.log", "SS_Marquee"},
                                                       {"SS_marquee_sign_down.log", "SS_Marquee"},
                                                       {"LV_neonsign_welcome.log", "LV_TI_sign_welcome"},
                                                       {"LV_neonsign1.log", "LV_neonsign1_P0"},
                                                       {"LV_Waterfall.log", "LV_water"}};
    std::map<std::string, std::string> classes;
    for (const auto& fields : definitions) {
        const auto model = fields.find("s_model_name"), type = fields.find("class_name");
        if (model != fields.end() && type != fields.end() && supported.contains(model->second))
            classes.emplace(type->second, model->second);
    }
    Json models = Json::array(), materials = Json::array(), instances = Json::array();
    std::map<std::string, unsigned> model_ids;
    unsigned waterfall_instances = 0, waterfall_models = 0;
    for (const auto& fields : placements) {
        check_cancel(cancel);
        const auto type = fields.find("objParamClass");
        if (type == fields.end() || !classes.contains(type->second))
            continue;
        const auto& model_file = classes.at(type->second);
        const bool waterfall = model_file == "LV_Waterfall.log";
        auto found = model_ids.find(model_file);
        if (found == model_ids.end()) {
            const auto name = model_file.substr(0, model_file.size() - 4);
            if (!pak.contains("model_" + name + ".b") || !pak.contains("hierarchy_" + name + ".b"))
                continue;
            std::filesystem::create_directories(output / "Meshes");
            const auto prefix =
                std::string(waterfall ? "madtrix-waterfall-" : "madtrix-sign-") + std::to_string(models.size());
            const auto mesh = prefix + ".obj";
            panel(pak, name, output / "Meshes" / mesh, waterfall, cancel);
            const auto texture_name = supported.at(model_file);
            std::vector<std::string> frames;
            if (waterfall) {
                frames = {prefix + ".png"};
                write_png(output / "Textures" / frames[0], image(texture_name));
                ++waterfall_models;
            } else if (model_file == "LV_neonsign1.log") {
                // [Trailmap: 550-signs] P0..P3 are distinct source image frames.
                for (unsigned frame = 0; frame < 4; ++frame) {
                    const auto filename = prefix + "-" + std::to_string(frame) + ".png";
                    write_png(output / "Textures" / filename, image("LV_neonsign1_P" + std::to_string(frame)));
                    frames.push_back(filename);
                }
            } else {
                auto bright = image(texture_name), dim = bright;
                // Authored OpenSlope adapter: pulse a static panel's luminous art.
                // This is explicitly not recovered Mad Trix animation timing.
                for (std::size_t p = 0; p < dim.rgba.size(); p += 4) {
                    const auto hi = std::max({dim.rgba[p], dim.rgba[p + 1], dim.rgba[p + 2]});
                    if (hi >= 128)
                        for (unsigned c = 0; c < 3; ++c)
                            dim.rgba[p + c] /= 4;
                }
                frames = {prefix + "-on.png", prefix + "-off.png"};
                write_png(output / "Textures" / frames[0], bright);
                write_png(output / "Textures" / frames[1], dim);
            }
            const auto material = materials.size();
            Json surface = {{"TexturePath", frames[0]},
                            {"AlphaMode", waterfall ? "blend" : "cutout"},
                            {"RepeatTexture", true},
                            {"UnknownInt18", 0x20000}};
            if (!waterfall)
                surface["TextureFlipbook"] = frames;
            materials.push_back(surface);
            const auto id = unsigned(models.size());
            models.push_back({{"ModelName", name},
                              {"ModelObjects",
                               {{{"ParentID", -1}, {"MeshData", {{{"MeshPath", mesh}, {"MaterialID", material}}}}}}}});
            found = model_ids.emplace(model_file, id).first;
        }
        const Vec3 p{number(fields, "position_v0") * 100, number(fields, "position_v1") * 100,
                     number(fields, "position_v2") * 100};
        const auto q =
            euler(number(fields, "rotation_v0"), number(fields, "rotation_v1"), number(fields, "rotation_v2"));
        const auto name = fields.find("objectName");
        instances.push_back({{"InstanceName", name == fields.end() ? type->second : name->second},
                             {"ModelID", found->second},
                             {"Location", {p.x, p.y, p.z}},
                             {"Rotation", q},
                             {"Scale", {1, 1, 1}},
                             {"Visable", true},
                             {"PlayerCollision", false},
                             {"PlayerBounce", false},
                             {"CollsionMode", 0},
                             {"EffectSlotIndex", waterfall ? 1 : 0}});
        waterfall_instances += waterfall;
    }
    save(output / "Models.json", {{"Models", models}});
    save(output / "Materials.json", {{"Materials", materials}});
    save(output / "Instances.json", {{"Instances", instances}});
    if (!instances.empty()) {
        Json circumstances = {{"persistent", "madtrix-sign-pulse"}};
        for (const auto name : {"collision", "slot3", "slot4", "trigger", "slot6", "slot7"})
            circumstances[name] = nullptr;
        const Json node = {
            {"id", "madtrix-sign-pulse:0"},
            {"mainType", 0},
            {"semanticType", "property.texture-flip"},
            {"payload",
             {{"type0",
               {{"SubType", 11},
                {"TextureFlip", {{"U0", 0}, {"Direction", 0}, {"Speed", 2}, {"Length", 0}, {"U4", 0}}}}}}}};
        Json graphs = {{{"id", "madtrix-sign-pulse"}, {"name", "OpenSlope adapted sign pulse"}, {"nodes", {node}}}};
        Json slots = {{{"id", "madtrix-signs"}, {"circumstances", circumstances}}};
        if (waterfall_instances) {
            // Sampling decreasing U advects the aligned art downwards.
            // The half-repeat/s speed is authored.
            const Json scroll = {
                {"id", "madtrix-waterfall-scroll:0"},
                {"mainType", 0},
                {"semanticType", "property.uv-scroll"},
                {"payload",
                 {{"type0",
                   {{"SubType", 10},
                    {"UVScroll", {{"U0", 0}, {"U1", -.5 / 60}, {"U2", 0}, {"U3", 1}, {"U4", 0}, {"U5", 0}}}}}}}};
            graphs.push_back({{"id", "madtrix-waterfall-scroll"},
                              {"name", "OpenSlope adapted waterfall flow"},
                              {"nodes", {scroll}}});
            circumstances["persistent"] = "madtrix-waterfall-scroll";
            slots.push_back({{"id", "madtrix-waterfalls"}, {"circumstances", circumstances}});
        }
        save(output / "Effects.json",
             {{"kind", "openslope-effects"},
              {"version", 1},
              {"target",
               {{"game", "jonny-moseley-mad-trix"}, {"platform", "ps2"}, {"region", "USA"}, {"level", course}}},
              {"header", {{"U1", 0}, {"U2", 0}, {"U3", 0}}},
              {"graphs", graphs},
              {"slots", slots},
              {"functions", Json::array()},
              {"objectProperties", Json::array()},
              {"instances", Json::array()},
              {"physics", Json::array()},
              {"collisionModels", Json::array()},
              {"splines", Json::array()}});
    }
    return {
        {"Instances", instances.size()},
        {"Signs",
         {{"Fidelity", "Approximate"},
          {"Models", models.size() - waterfall_models},
          {"Instances", instances.size() - waterfall_instances},
          {"Policy", "Source sign panels and available neon frames; OpenSlope 2 fps static-panel pulse; original "
                     "timing deferred"}}},
        {"Waterfalls",
         {{"Fidelity", "Approximate"},
          {"Models", waterfall_models},
          {"Instances", waterfall_instances},
          {"Policy",
           "Source LV_Waterfall mesh and water art; flow-aligned UVs; authored downhill U scroll at half a repeat per "
           "second; original driver deferred"}}}};
}
} // namespace openslope::import_detail
