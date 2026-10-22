#include "openslope/avatar_preferences.hpp"
#include "openslope/ride_ui.hpp"
#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>

namespace openslope {
std::span<const unsigned char> builtin_avatar_bytes(std::string_view);
}

namespace {
using namespace openslope;
unsigned checks = 0;

void check(bool value, const char* message) {
    ++checks;
    if (!value)
        throw std::runtime_error(message);
}

void reject(std::span<const unsigned char> bytes) {
    try {
        Avatar avatar(bytes);
    } catch (const std::exception&) {
        ++checks;
        return;
    }
    throw std::runtime_error("Malformed avatar was accepted");
}

std::vector<unsigned char> mutate(const std::function<void(nlohmann::json&)>& edit) {
    const auto source = builtin_avatar_bytes("builtin:blocky-rider");
    std::uint32_t json_size;
    std::memcpy(&json_size, source.data() + 12, 4);
    auto json = nlohmann::json::parse(source.begin() + 20, source.begin() + 20 + json_size);
    edit(json);
    auto text = json.dump();
    while (text.size() % 4)
        text += ' ';
    std::vector<unsigned char> bytes(20 + text.size());
    std::copy_n(source.begin(), 12, bytes.begin());
    const auto word = [&](std::size_t at, std::uint32_t value) { std::memcpy(bytes.data() + at, &value, 4); };
    word(12, std::uint32_t(text.size()));
    word(16, 0x4e4f534a);
    std::copy(text.begin(), text.end(), bytes.begin() + 20);
    bytes.insert(bytes.end(), source.begin() + 20 + json_size, source.end());
    word(8, std::uint32_t(bytes.size()));
    return bytes;
}

AvatarPose bind_pose(double arm_angle) {
    AvatarPose pose;
    pose.forward = pose.head_forward = {0, 0, 1};
    pose.up = pose.head_up = {0, 1, 0};
    pose.on_foot = true;
    pose.controller_models = false;
    const auto at = [&](AvatarJoint joint, Vec3 point) { pose.joints[unsigned(joint)] = point; };
    at(AvatarJoint::Hips, {0, 1.0364, 0});
    at(AvatarJoint::Spine, {0, 1.1764, 0});
    at(AvatarJoint::Chest, {0, 1.2284, 0});
    at(AvatarJoint::Neck, {0, 1.4704, 0});
    at(AvatarJoint::Head, {0, 1.5454, 0});
    for (unsigned side = 0; side < 2; ++side) {
        const auto sign = side ? -1. : 1.;
        const Vec3 direction{sign * std::sin(arm_angle), -std::cos(arm_angle), 0};
        const auto shoulder = Vec3{sign * .165, 1.3954, 0}, elbow = shoulder + direction * .3162,
                   wrist = elbow + direction * .2482;
        at(side ? AvatarJoint::RightShoulder : AvatarJoint::LeftShoulder, shoulder);
        at(side ? AvatarJoint::RightElbow : AvatarJoint::LeftElbow, elbow);
        at(side ? AvatarJoint::RightWrist : AvatarJoint::LeftWrist, wrist);
        at(side ? AvatarJoint::RightHip : AvatarJoint::LeftHip, {sign * .11, .9497, 0});
        at(side ? AvatarJoint::RightKnee : AvatarJoint::LeftKnee, {sign * .11, .5332, 0});
        at(side ? AvatarJoint::RightAnkle : AvatarJoint::LeftAnkle, {sign * .11, .115, 0});
        at(side ? AvatarJoint::RightToe : AvatarJoint::LeftToe, {sign * .11, .115, .13});
    }
    return pose;
}

// A neutral skin must reproduce the author's actual triangles, including mixed-weight coat panels.
// This oracle reads only positions/indices: it does not reconstruct Native's bone or skin transforms.
std::vector<Vec3> authored_triangles(std::string_view id) {
    const auto bytes = builtin_avatar_bytes(id);
    std::uint32_t json_size;
    std::memcpy(&json_size, bytes.data() + 12, 4);
    const auto json = nlohmann::json::parse(bytes.begin() + 20, bytes.begin() + 20 + json_size);
    const auto binary = bytes.subspan(28 + json_size);
    const auto element = [&](unsigned accessor, unsigned index) {
        const auto& a = json.at("accessors").at(accessor);
        const auto& view = json.at("bufferViews").at(a.at("bufferView").get<unsigned>());
        const auto scalar = a.at("componentType") == 5125 ? 4u : 2u;
        const auto size = a.at("type") == "VEC3" ? 12u : scalar;
        return binary.data() + view.value("byteOffset", 0u) + a.value("byteOffset", 0u) +
               index * view.value("byteStride", size);
    };
    std::vector<Vec3> out;
    for (const auto& mesh : json.at("meshes"))
        for (const auto& primitive : mesh.at("primitives")) {
            const auto indices = primitive.at("indices").get<unsigned>(),
                       positions = primitive.at("attributes").at("POSITION").get<unsigned>();
            const auto& accessor = json.at("accessors").at(indices);
            const auto size = accessor.at("componentType") == 5125 ? 4u : 2u;
            for (unsigned corner = 0; corner < accessor.at("count").get<unsigned>(); ++corner) {
                unsigned index = 0;
                std::memcpy(&index, element(indices, corner), size);
                std::array<float, 3> point;
                std::memcpy(point.data(), element(positions, index), 12);
                out.push_back({point[0], point[1], point[2]});
            }
        }
    return out;
}

void authored_proportions() {
    for (const auto& [id, angle] : std::array<std::pair<std::string_view, double>, 2>{
             {{"builtin:blocky-rider", 0}, {"builtin:robin", 40 * pi / 180}}}) {
        auto avatar = Avatar::builtin(id);
        const auto original = authored_triangles(id);
        for (const auto yaw : {0., .9, -2.1}) {
            auto pose = bind_pose(angle);
            const Vec3 offset{4, 2, -3};
            for (auto& joint : pose.joints)
                joint = rotate(joint, {0, 1, 0}, yaw) + offset;
            pose.forward = pose.head_forward = rotate(pose.forward, {0, 1, 0}, yaw);
            const auto mesh = avatar.mesh(pose, false, false);
            check(mesh.size() == original.size(), "Neutral skin retains the authored topology");
            double maximum_error = 0;
            for (std::size_t i = 0; i < original.size(); ++i) {
                const auto expected = rotate(original[i], {0, 1, 0}, yaw) + offset;
                maximum_error = std::max(maximum_error, length(Vec3{mesh[i].x, mesh[i].y, mesh[i].z} - expected));
            }
            if (maximum_error >= .0002)
                throw std::runtime_error(std::string(id) + " neutral skin differs from authored shape by " +
                                         std::to_string(maximum_error) + " metres");
            ++checks;
        }
    }
    auto blocky = Avatar::builtin("builtin:blocky-rider");
    auto pose = bind_pose(0);
    pose.joints[unsigned(AvatarJoint::Spine)].y += .25;
    pose.joints[unsigned(AvatarJoint::LeftElbow)] += Vec3{.2, .3, .2};
    const auto drawn = blocky.mesh(pose, false, false);
    const auto original = authored_triangles("builtin:blocky-rider");
    for (std::size_t i = 0; i < drawn.size(); i += 3)
        for (unsigned side = 0; side < 3; ++side) {
            const auto a = i + side, b = i + (side + 1) % 3;
            const auto length_after =
                length(Vec3{drawn[a].x - drawn[b].x, drawn[a].y - drawn[b].y, drawn[a].z - drawn[b].z});
            check(std::abs(length_after - length(original[a] - original[b])) < .00002,
                  "Rigid blocky parts keep their authored dimensions when pose landmarks stretch");
        }
}
} // namespace

int main() {
    std::filesystem::path temporary;
    try {
        authored_proportions();
        Player player(Terrain::demo());
        const auto pose = avatar_pose(player);
        const auto before = player.rider().position;
        check(builtin_avatars().size() == 7, "Slopesmith's complete catalog is bundled");
        for (const auto& option : builtin_avatars()) {
            auto avatar = Avatar::builtin(option.id);
            const auto drawn = avatar.mesh(pose, false, false);
            const std::vector<Vertex> mesh(drawn.begin(), drawn.end());
            check(!mesh.empty() && mesh.size() == avatar.source_triangles() * 3, "Entire built-in skin is posed");
            for (const auto& v : mesh) {
                check(finite({v.x, v.y, v.z}) && std::abs(v.x) < 100 && std::abs(v.y) < 100, "Finite bounded skin");
                check(std::isfinite(v.nx) && std::isfinite(v.ny) && std::isfinite(v.nz), "Finite blended normal");
            }
            const auto full = mesh.size();
            check(avatar.mesh(pose, true, false).size() < full, "First person hides each avatar's head");
            check(avatar.shadow_mesh().size() == full, "First person retains complete shadow skin");
            AvatarTracking tracked;
            tracked.head = pose.eye();
            tracked.controllers[0].valid = true;
            tracked.controllers[0].position = pose.joint(AvatarJoint::LeftWrist);
            check(!avatar.mesh(avatar_pose(player, &tracked), true, true, tracked.head).empty(),
                  "Tracked skin and controllers draw");
            if (option.id == "builtin:kestrel" || option.id == "builtin:robin" || option.id == "builtin:raven") {
                check(avatar.texture() && !avatar.texture()->pixels.empty(), "JPEG rider textures decoded");
                check(std::any_of(mesh.begin(), mesh.end(),
                                  [](const auto& v) { return v.lh == 1 && v.s > 0 && v.t > 0; }),
                      "Texture coordinates reach renderer");
            }
            if (option.id == "builtin:raven")
                check(std::any_of(mesh.begin(), mesh.end(),
                                  [](const auto& v) { return v.lx > 0 || v.ly > 0 || v.lw > 0; }),
                      "Raven's emissive mask reaches renderer");
            std::cout << "Loaded " << option.label << ": " << avatar.source_vertices() << " vertices, "
                      << avatar.source_triangles() << " triangles\n";
        }
        check(length(before - player.rider().position) == 0, "Choosing avatars leaves physics alone");
        for (unsigned i = 0; i < 30; ++i) {
            const auto random = AvatarPreferences::random_rider();
            check(random != "builtin:stick-figure" && random.starts_with("builtin:"),
                  "Windows random default excludes diagnostic Stick Figure");
        }
        check(AvatarPreferences::load({}).selected == "builtin:stick-figure", "Fresh Quest default is Stick Figure");
        const auto random_default = AvatarPreferences::random_rider();
        check(AvatarPreferences::load({}, random_default).selected == random_default,
              "Fresh Windows default is random");
        reject({});
        reject(mutate([](auto& j) { j["bufferViews"][0]["byteLength"] = 1; }));
        reject(mutate([](auto& j) { j["nodes"][1]["children"].push_back(0); }));
        reject(mutate([](auto& j) { j["nodes"][1]["name"] = "MissingHips"; }));
        reject(mutate([](auto& j) { j["accessors"][0]["count"] = 30001; }));
        reject(mutate([](auto& j) { j["buffers"][0]["uri"] = "external.bin"; }));
        temporary =
            std::filesystem::temp_directory_path() /
            ("openslope-avatar-model-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::create_directories(temporary / "characters");
        const auto file = temporary / "avatar-preferences.json";
        {
            const auto bytes = builtin_avatar_bytes("builtin:kestrel");
            std::ofstream out(temporary / "characters" / "My rider.glb", std::ios::binary);
            out.write(reinterpret_cast<const char*>(bytes.data()), std::streamsize(bytes.size()));
        }
        {
            std::ofstream out(temporary / "characters" / "Broken.glb");
            out << "bad GLB";
        }
        RideUi ui;
        ui.visible = true;
        AvatarPreferences preferences;
        preferences.present(ui, file);
        check(ui.avatar_choices.size() == 9, "Catalog includes top-level custom GLBs");
        const auto main_buttons = ui.buttons();
        check(std::any_of(main_buttons.begin(), main_buttons.end(),
                          [](const auto& b) { return b.action == UiAction::Avatars; }),
              "Main menu offers avatar settings");
        Avatar avatar;
        check(preferences.handle({UiAction::SelectAvatar, false, {}, preferences.selected}, ui, avatar),
              "Explicit selection remembers the current platform default");
        preferences.handle({UiAction::Avatars}, ui, avatar);
        check(ui.avatar_options && ui.buttons().size() == 8, "Avatar picker presents five choices plus page controls");
        preferences.handle({UiAction::NextAvatarPage}, ui, avatar);
        check(ui.avatar_page == 1, "Picker reaches remaining built-ins and custom avatars");
        check(preferences.handle({UiAction::SelectAvatar, false, {}, "My rider.glb"}, ui, avatar),
              "Custom avatar selection succeeds");
        check(preferences.save(file), "Avatar preference saves");
        check(AvatarPreferences::load(file).selected == "My rider.glb", "Custom choice survives restart");
        check(AvatarPreferences::load(file, AvatarPreferences::random_rider()).selected == "My rider.glb",
              "Saved choice overrides Windows random default");
        const auto count = avatar.source_triangles();
        check(!preferences.handle({UiAction::SelectAvatar, false, {}, "Broken.glb"}, ui, avatar),
              "Broken custom avatar is rejected");
        check(preferences.selected == "My rider.glb" && avatar.source_triangles() == count,
              "Broken selection preserves previous skin and preference");
        check(!preferences.handle({UiAction::SelectAvatar, false, {}, "../escape.glb"}, ui, avatar),
              "Selection cannot escape the library");
        {
            std::ofstream out(file);
            out << "broken JSON";
        }
        check(AvatarPreferences::load(file).selected == "builtin:stick-figure",
              "Corrupt Quest settings restore Stick Figure");
        std::filesystem::remove_all(temporary);
        std::cout << "PASS: " << checks << " avatar catalog, skin, texture, malformed GLB and settings checks\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL: " << error.what() << '\n';
        return 1;
    }
}
