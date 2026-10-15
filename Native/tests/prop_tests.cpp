#include "openslope/props.hpp"
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace {
using namespace openslope;
using Json = nlohmann::json;
unsigned checks = 0;

void require(bool value, const char* message) {
    ++checks;
    if (!value)
        throw std::runtime_error(message);
}

void near(double a, double b, const char* message) { require(std::abs(a - b) < 1e-5, message); }

template <class F> void rejects(F operation, const char* message) {
    bool rejected = false;
    try {
        operation();
    } catch (const std::exception&) {
        rejected = true;
    }
    require(rejected, message);
}

Json read(const std::filesystem::path& path) {
    std::ifstream f(path);
    return Json::parse(f);
}

void write(const std::filesystem::path& path, const Json& value) {
    std::ofstream f(path);
    f << value;
}
} // namespace

int main(int argc, char** argv) {
    try {
        require(argc == 2, "Supply authored prop fixtures");
        const auto root = std::filesystem::path(argv[1]) / "props";
        const auto props = Props::load(root);
        require(props.models.size() == 1 && props.parts.size() == 1 && props.instances.size() == 5,
                "Read shared model and placements");
        require(props.geometry.vertices.size() == 4 && props.geometry.indices.size() == 6,
                "Reuse OBJ vertices across polygons and placements");
        require(!props.instances[2].visible, "Retain authored hidden instances without drawing them");
        near(props.instances[0].bounds.min.x, -.61, "Placement scale and centimetres");
        near(props.instances[1].bounds.max.x, .61, "Rotated placement bounds");
        const auto light = prop_light({1, 0, 0}, props.instances[1].pose);
        near(light[0], 1.5, "Lighting keeps overbright headroom");
        near(light[1], 1, "Lighting is model-local under rotated placement");
        near(light[2], .5, "Independent key colour channels");
        const auto files = prop_files(root);
        require(files == std::vector<std::string>({"Meshes/quad.obj", "Textures/prop-state.png", "Textures/prop.png"}),
                "Unique metadata references for document providers");
        std::array<float, 16> camera{};
        camera[0] = camera[5] = camera[10] = camera[15] = 1;
        require(prop_visible(props.instances[0].bounds, camera, {}), "Visible bounds accepted");
        require(!prop_visible(props.instances[4].bounds, camera, {}), "Frustum culls off-screen geometry");
        require(!prop_visible(props.instances[3].bounds, camera, {}), "Distance culls far geometry");
        Bounds crossing;
        crossing.add({-2, -2, .2});
        crossing.add({2, 2, .8});
        require(prop_visible(crossing, camera, {}), "Straddling bounds remain visible");
        Bounds behind;
        behind.add({-.1, -.1, -2});
        behind.add({.1, .1, -1});
        require(!prop_visible(behind, camera, {}), "Near clip rejects behind-camera bounds");
        auto document = read(root / "Models.json");
        const auto original = document;
        document["Models"][0]["ModelObjects"][0]["ParentID"] = 0;
        write(root / "Models.json", document);
        rejects([&] { static_cast<void>(Props::load(root)); }, "Reject cyclic model hierarchy");
        document = original;
        document["Models"][0]["ModelObjects"][0]["MeshData"][0]["MeshPath"] = "../outside.obj";
        write(root / "Models.json", document);
        rejects([&] { static_cast<void>(prop_files(root)); }, "Reject mesh traversal before copying assets");
        document = original;
        document["Models"][0]["ModelObjects"][0]["Position"] = {100, 0, 0};
        document["Models"][0]["ModelObjects"][0]["Rotation"] = {0, 0, 0, 1};
        document["Models"][0]["ModelObjects"][0]["Scale"] = {1, 1, 1};
        auto child = document["Models"][0]["ModelObjects"][0];
        child["ParentID"] = 0;
        child["Position"] = {200, 0, 0};
        document["Models"][0]["ModelObjects"][0]["MeshData"] = Json::array();
        document["Models"][0]["ModelObjects"].push_back(child);
        write(root / "Models.json", document);
        const auto hierarchy = Props::load(root);
        near(hierarchy.models[0].bounds.min.x, 2.7, "Compose meshless parent and child rest transforms");
        document = original;
        auto& animated = document["Models"][0]["ModelObjects"][0];
        animated["IncludeAnimation"] = true;
        animated["Position"] = {900, 0, 0};
        animated["Rotation"] = {0, 1, 0, 0};
        animated["Animation"] = {
            {"U1", 100},
            {"U2", 0},
            {"U3", 0},
            {"U4", 90},
            {"U5", 90},
            {"U6", 90},
            {"AnimationAction", 1},
            {"AnimationEntries", Json::array({{{"AnimationMaths", Json::array({{{"Value1", 0},
                                                                                {"Value2", 0},
                                                                                {"Value3", 20},
                                                                                {"Value4", 200},
                                                                                {"Value5", 0},
                                                                                {"Value6", 2}}})}}})}};
        write(root / "Models.json", document);
        const auto snapshot = Props::load(root);
        near(snapshot.models[0].bounds.min.x, 1.7, "Animated translation channel replaces base and rest at time zero");
        near(snapshot.models[0].bounds.max.x, 2.3,
             "Unchannelled Euler and rest rotation do not rotate animated objects");
        animated["Animation"]["AnimationEntries"][0]["AnimationMaths"][0]["Value5"] = 3;
        write(root / "Models.json", document);
        rejects([&] { static_cast<void>(Props::load(root)); }, "Reject backwards animation time window");
        document = original;
        document["Models"][0]["ModelObjects"][0]["ParentID"] = -2;
        write(root / "Models.json", document);
        rejects([&] { static_cast<void>(Props::load(root)); }, "Reject invalid negative parent");
        write(root / "Models.json", original);
        auto materials = read(root / "Materials.json");
        const auto original_materials = materials;
        materials["Materials"][0]["TexturePath"] = nullptr;
        write(root / "Materials.json", materials);
        require(Props::load(root).parts[0].texture == "prop.png",
                "Frame zero supplies resting art even when base is null");
        require(prop_files(root) ==
                    std::vector<std::string>({"Meshes/quad.obj", "Textures/prop-state.png", "Textures/prop.png"}),
                "Null base retains independently referenced frame images");
        materials["Materials"][0]["TextureFlipbook"] = Json::array();
        write(root / "Materials.json", materials);
        require(prop_files(root) == std::vector<std::string>({"Meshes/quad.obj"}) &&
                    Props::load(root).parts[0].texture.empty(),
                "Null base and empty frame list remain untextured");
        materials["Materials"][0]["TextureFlipbook"] = {"../outside.png"};
        write(root / "Materials.json", materials);
        rejects([&] { static_cast<void>(prop_files(root)); }, "Reject frame image traversal before copying");
        write(root / "Materials.json", original_materials);
        require(Props::load(std::filesystem::path(argv[1]) / "missing").instances.empty(),
                "Terrain-only map remains valid");
        std::cout << "PASS: " << checks << " prop contract, transform, light and visibility checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
