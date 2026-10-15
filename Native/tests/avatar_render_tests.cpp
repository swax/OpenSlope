#include "openslope/avatar.hpp"
#include "openslope/ride_ui.hpp"
#include "vulkan_renderer.hpp"
#include <fstream>
#include <iostream>
#include <stdexcept>

namespace {
using namespace openslope;
unsigned checks = 0;

void check(bool value, const char* what) {
    ++checks;
    if (!value)
        throw std::runtime_error(what);
}

struct Target {
    VulkanContext& context;
    VkImage image{};
    VkDeviceMemory memory{};

    explicit Target(VulkanContext& c, VkFormat format) : context(c) {
        VkImageCreateInfo info{VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO};
        info.imageType = VK_IMAGE_TYPE_2D;
        info.format = format;
        info.extent = {1024, 1024, 1};
        info.mipLevels = info.arrayLayers = 1;
        info.samples = VK_SAMPLE_COUNT_1_BIT;
        info.tiling = VK_IMAGE_TILING_OPTIMAL;
        info.usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT;
        vk_check(vkCreateImage(c.device, &info, nullptr, &image), "Create avatar test target");
        VkMemoryRequirements need;
        vkGetImageMemoryRequirements(c.device, image, &need);
        VkPhysicalDeviceMemoryProperties types;
        vkGetPhysicalDeviceMemoryProperties(c.physical, &types);
        unsigned memory_type = 0;
        while (memory_type < types.memoryTypeCount &&
               (!(need.memoryTypeBits & (1u << memory_type)) ||
                !(types.memoryTypes[memory_type].propertyFlags & VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT)))
            ++memory_type;
        VkMemoryAllocateInfo allocation{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
        allocation.allocationSize = need.size;
        allocation.memoryTypeIndex = memory_type;
        vk_check(vkAllocateMemory(c.device, &allocation, nullptr, &memory), "Allocate avatar target");
        vk_check(vkBindImageMemory(c.device, image, memory, 0), "Bind avatar target");
    }

    ~Target() {
        if (image)
            vkDestroyImage(context.device, image, nullptr);
        if (memory)
            vkFreeMemory(context.device, memory, nullptr);
    }
};

std::vector<unsigned char> pixels(const std::filesystem::path& path) {
    std::ifstream file(path, std::ios::binary);
    std::string magic;
    unsigned width, height, max;
    file >> magic >> width >> height >> max;
    file.get();
    check(magic == "P6" && width == 1024 && height == 1024 && max == 255, "capture dimensions");
    std::vector<unsigned char> p(width * height * 3);
    file.read(reinterpret_cast<char*>(p.data()), std::streamsize(p.size()));
    check(bool(file), "complete capture");
    return p;
}

unsigned landmarks(const std::vector<unsigned char>& p) {
    unsigned n = 0;
    for (std::size_t i = 0; i < p.size(); i += 3) {
        const auto r = p[i], g = p[i + 1], b = p[i + 2];
        n += (g > r * 1.4 && g > b * 1.4 && g > 90) || (r > g * 1.3 && g > b * 1.8 && r > 100) ||
             (b > r * 1.5 && b > g && b > 100);
    }
    return n;
}
} // namespace

int main(int argc, char** argv) {
    try {
        if (argc != 2)
            throw std::runtime_error("Provide capture output directory");
        const auto root = std::filesystem::path(argv[1]);
        std::filesystem::create_directories(root);
        VulkanContext context;
        context.create(false);
        Patch patch;
        for (unsigned u = 0; u < 4; ++u)
            for (unsigned v = 0; v < 4; ++v)
                patch.points[u * 4 + v] = {double(u) * 20 / 3 - 10, 0, double(v) * 20 / 3 - 10};
        Player player(Terrain({patch}));
        player.warp({0, 0, 0}, {0, 0, -1});
        auto scene = std::make_shared<VulkanScene>(context);
        scene->upload(player.terrain().mesh());
        Avatar avatar;
        Target left{context, VK_FORMAT_R8G8B8A8_UNORM}, right{context, VK_FORMAT_R8G8B8A8_SRGB};
        VulkanRenderer a(context), b(context);
        a.use_scene(scene);
        b.use_scene(scene);
        a.targets(std::span(&left.image, 1), VK_FORMAT_R8G8B8A8_UNORM, 1024, 1024, 4);
        b.targets(std::span(&right.image, 1), VK_FORMAT_R8G8B8A8_SRGB, 1024, 1024, 4);
        AvatarTracking tracking;
        tracking.head = {0, 1.65, 0};
        tracking.forward = {0, 0, -1};
        for (unsigned i = 0; i < 2; ++i) {
            auto& c = tracking.controllers[i];
            c.valid = true;
            c.position = {i ? .24 : -.24, 1.15, -.36};
            c.up = normalized(Vec3{0, .85, .3});
            c.forward = normalized(cross(c.up, c.right));
        }
        const auto render = [&](std::string name, const AvatarPose& pose, bool first_person, Vec3 eye, Vec3 direction,
                                bool labels, Vec3 controller_offset = Vec3{}) {
            const auto mesh = avatar.mesh(pose, first_person, labels, eye, controller_offset);
            const auto camera = projection(-.85, .85, -.85, .85) * view(eye, direction);
            a.render(0, camera,
                     board_transform(player.render_board_position(), player.render_forward(), player.render_up()),
                     VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, eye, {}, {}, {}, mesh);
            a.capture(0, root / (name + ".ppm"));
            check(a.stats().avatar_triangles == mesh.size() / 3, "avatar triangles actually drawn");
            auto p = pixels(root / (name + ".ppm"));
            check(landmarks(p) > 500, "visible avatar tracking landmarks");
            return p;
        };
        render("desktop", avatar_pose(player), false, {2.8, 2.1, 3.2}, {-2.8, -1, -3.2}, false);
        const AvatarLook down_look{normalized(Vec3{0, -1, -.22}), {0, 1, 0}};
        const auto down_pose = avatar_pose(player, nullptr, &down_look);
        render("desktop-down", down_pose, true, down_pose.eye(), down_look.forward, false);
        // Keep the torso and camera fixed to isolate all three head rotation axes.
        auto head_pose = avatar_pose(player);
        head_pose.head_forward = {0, 0, -1};
        head_pose.head_up = {0, 1, 0};
        const auto head_eye = head_pose.joint(AvatarJoint::Head) + Vec3{0, .18, -2};
        const auto head_direction = head_pose.joint(AvatarJoint::Head) + Vec3{0, .10, 0} - head_eye;
        const auto head_base = render("head-forward", head_pose, false, head_eye, head_direction, false);
        const auto hidden_base = render("head-hidden-base", head_pose, true, head_eye, head_direction, false);
        for (unsigned axis = 0; axis < 3; ++axis) {
            auto turned = head_pose;
            const Vec3 turn_axis = axis == 0 ? Vec3{0, 1, 0} : axis == 1 ? Vec3{1, 0, 0} : Vec3{0, 0, 1};
            turned.head_forward = rotate(turned.head_forward, turn_axis, pi * .4);
            turned.head_up = rotate(turned.head_up, turn_axis, pi * .4);
            const auto name = "head-axis-" + std::to_string(axis);
            const auto rotated_head = render(name, turned, false, head_eye, head_direction, false);
            unsigned difference = 0;
            for (std::size_t i = 0; i < head_base.size(); i += 3)
                difference += std::abs(int(head_base[i]) - int(rotated_head[i])) +
                                  std::abs(int(head_base[i + 1]) - int(rotated_head[i + 1])) +
                                  std::abs(int(head_base[i + 2]) - int(rotated_head[i + 2])) >
                              30;
            check(difference > 300, "head yaw/pitch/roll changes real skinned pixels");
            check(render(name + "-hidden", turned, true, head_eye, head_direction, false) == hidden_base,
                  "own head remains hidden and head look leaves body pixels unchanged");
        }
        player.start_on_foot();
        std::array<std::vector<unsigned char>, 2> walk_pixels;
        for (unsigned phase = 0; phase < 2; ++phase) {
            RideInput walk;
            walk.posture = 1;
            for (unsigned tick = 0; tick < 11; ++tick)
                player.tick(walk);
            auto pose = avatar_pose(player);
            for (auto& joint : pose.joints)
                joint -= player.render_position();
            walk_pixels[phase] =
                render("walk-phase-" + std::to_string(phase), pose, false, {2.8, 2.1, 3.2}, {-2.8, -1, -3.2}, false);
        }
        unsigned walking_change = 0;
        for (std::size_t i = 0; i < walk_pixels[0].size(); i += 3)
            walking_change += std::abs(int(walk_pixels[0][i]) - int(walk_pixels[1][i])) +
                                  std::abs(int(walk_pixels[0][i + 1]) - int(walk_pixels[1][i + 1])) +
                                  std::abs(int(walk_pixels[0][i + 2]) - int(walk_pixels[1][i + 2])) >
                              30;
        check(walking_change > 300, "walk gait changes real avatar pixels with root translation removed");
        player.warp({0, 0, 0}, {0, 0, -1});
        auto fallback = avatar_pose(player, &tracking);
        auto labels = render("vr-help", fallback, true, tracking.head, {0, -.7, -1}, true);
        auto no_labels = render("vr-no-help", fallback, true, tracking.head, {0, -.7, -1}, false);
        unsigned changed = 0;
        for (std::size_t i = 0; i < labels.size(); i += 3)
            changed += std::abs(int(labels[i]) - int(no_labels[i])) +
                           std::abs(int(labels[i + 1]) - int(no_labels[i + 1])) +
                           std::abs(int(labels[i + 2]) - int(no_labels[i + 2])) >
                       30;
        check(changed > 2000, "controller text is visible to the viewer");
        tracking.body_active = true;
        tracking.full_body = true;
        tracking.confidence = .85;
        tracking.joints = fallback.joints;
        tracking.valid.fill(true);
        tracking.joints[unsigned(AvatarJoint::LeftKnee)] += {-.08, 0, -.1};
        tracking.joints[unsigned(AvatarJoint::RightKnee)] += {.08, 0, -.1};
        auto full = avatar_pose(player, &tracking);
        render("vr-full-body", full, true, tracking.head, {0, -1, -.22}, true);
        const auto mesh = avatar.mesh(full, true, true, tracking.head);
        const auto eye_a = tracking.head + Vec3{-.032, 0, 0}, eye_b = tracking.head + Vec3{.032, 0, 0},
                   direction = normalized(Vec3{0, -.7, -1});
        a.render(0, projection(-.85, .85, -.85, .85) * view(eye_a, direction),
                 board_transform({}, player.render_forward(), player.render_up()), VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
                 {}, {}, eye_a, {}, {}, {}, mesh);
        b.render(0, projection(-.85, .85, -.85, .85) * view(eye_b, direction),
                 board_transform({}, player.render_forward(), player.render_up()), VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
                 {}, {}, eye_b, {}, {}, {}, mesh);
        a.capture(0, root / "vr-left.ppm");
        b.capture(0, root / "vr-right.ppm");
        auto pa = pixels(root / "vr-left.ppm"), pb = pixels(root / "vr-right.ppm");
        check(landmarks(pa) > 500 && landmarks(pb) > 500, "both stereo targets retain body/controllers");
        check(pa != pb, "stereo uses distinct eye positions");
        b.render(0, projection(-.85, .85, -.85, .85) * view(eye_a, direction),
                 board_transform({}, player.render_forward(), player.render_up()), VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
                 {}, {}, eye_a, {}, {}, {}, mesh);
        b.capture(0, root / "vr-srgb.ppm");
        pb = pixels(root / "vr-srgb.ppm");
        double error = 0;
        for (std::size_t i = 0; i < pa.size(); ++i)
            error += std::abs(int(pa[i]) - int(pb[i]));
        check(error / pa.size() < 1.0, "sRGB and display-domain avatar match");
        a.targets(std::span(&left.image, 1), VK_FORMAT_R8G8B8A8_UNORM, 1024, 1024, 1);
        render("vr-single-sample", full, true, tracking.head, {0, -.7, -1}, true);
        tracking.body_active = false;
        tracking.controllers[0].valid = tracking.controllers[1].valid = false;
        render("vr-tracking-lost", avatar_pose(player, &tracking), true, tracking.head, {0, -1, -.22}, true);
        player.start_on_foot();
        tracking.body_active = false;
        tracking.head = player.render_position() + Vec3{0, 1.65, 0};
        for (unsigned i = 0; i < 2; ++i) {
            tracking.controllers[i].valid = true;
            tracking.controllers[i].position = tracking.head + Vec3{i ? .24 : -.24, -.5, -.36};
        }
        render("vr-on-foot-help", avatar_pose(player, &tracking), true, tracking.head, {0, -.7, -1}, true);
        player.configure_run(RunMode::Showoff);
        const auto timed = avatar_pose(player, &tracking);
        check(timed.run_text[0] == "SHOWOFF 2:00.00" && timed.run_text[1] == "MOUNT TO START",
              "VR run text comes from shared clock/phase");
        auto no_run = timed;
        no_run.run_text = {};
        const auto basic = render("vr-run-empty", no_run, true, tracking.head, {0, -.7, -1}, true);
        const auto panel = render("vr-run-clock", timed, true, tracking.head, {0, -.7, -1}, true);
        changed = 0;
        for (std::size_t i = 0; i < panel.size(); i += 3)
            changed += std::abs(int(panel[i]) - int(basic[i])) + std::abs(int(panel[i + 1]) - int(basic[i + 1])) +
                           std::abs(int(panel[i + 2]) - int(basic[i + 2])) >
                       30;
        check(changed > 1000, "clock digits and control help actually appear in VR");
        player.scoring().start();
        player.scoring().step(1. / 60, ScoreMotion::Air);
        for (unsigned i = 0; i < 80; ++i)
            player.scoring().step(1. / 60, ScoreMotion::Air, 4.5);
        const auto live = avatar_pose(player, &tracking);
        check(live.score_text[1] == "TRICK +1700", "VR live score uses shared preview");
        auto blank = live;
        blank.score_text = {};
        const auto without_score = render("vr-score-empty", blank, true, tracking.head, {0, -.7, -1}, true);
        const auto with_score = render("vr-score-live", live, true, tracking.head, {0, -.7, -1}, true);
        changed = 0;
        for (std::size_t i = 0; i < with_score.size(); i += 3)
            changed += std::abs(int(with_score[i]) - int(without_score[i])) +
                           std::abs(int(with_score[i + 1]) - int(without_score[i + 1])) +
                           std::abs(int(with_score[i + 2]) - int(without_score[i + 2])) >
                       30;
        check(changed > 1000, "right-controller score and boost digits actually render");
        player.scoring().land();
        const auto landed = avatar_pose(player, &tracking);
        check(landed.score_result == 1 && landed.score_text[1] == "BANKED 1700", "clean bank selects green result");
        const auto green = render("vr-score-banked", landed, true, tracking.head, {0, -.7, -1}, true);
        check(green != with_score, "landed score changes rendered feedback");
        player.scoring().step(1. / 60, ScoreMotion::Air);
        for (unsigned i = 0; i < 40; ++i)
            player.scoring().step(1. / 60, ScoreMotion::Air, 4.5);
        player.scoring().lose(ScoreLoss::Crash, .1);
        const auto bailed = avatar_pose(player, &tracking);
        check(bailed.score_result == -1 && bailed.score_text[1] == "LOST 850", "crash selects red lost-trick result");
        const auto red = render("vr-score-lost", bailed, true, tracking.head, {0, -.7, -1}, true);
        check(red != green, "lost trick changes rendered feedback");
        auto neutral = landed;
        neutral.score_result = 0;
        const auto white_bank = render("vr-score-bank-white", neutral, true, tracking.head, {0, -.7, -1}, true);
        changed = 0;
        for (std::size_t i = 0; i < green.size(); i += 3)
            changed += int(green[i + 1]) - int(green[i]) > 40 && int(white_bank[i]) - int(green[i]) > 40;
        check(changed > 100, "banked result actually uses green text pixels");
        neutral = bailed;
        neutral.score_result = 0;
        const auto white_loss = render("vr-score-loss-white", neutral, true, tracking.head, {0, -.7, -1}, true);
        changed = 0;
        for (std::size_t i = 0; i < red.size(); i += 3)
            changed += int(red[i]) - int(red[i + 1]) > 40 && int(white_loss[i + 1]) - int(red[i + 1]) > 40;
        check(changed > 100, "lost result actually uses red text pixels");
        for (unsigned i = 0; i < 2; ++i) {
            tracking.controllers[i].right = {1, 0, 0};
            tracking.controllers[i].up = {0, 0, 1};
            tracking.controllers[i].forward = {0, 1, 0};
        }
        const auto upright = avatar_pose(player, &tracking);
        const auto upright_pixels = render("vr-grip-upright", upright, true, tracking.head, {0, -.7, -1}, true);
        auto rolled_tracking = tracking;
        for (auto& c : rolled_tracking.controllers) {
            c.right = rotate(c.right, {0, 0, -1}, pi / 2);
            c.up = rotate(c.up, {0, 0, -1}, pi / 2);
            c.forward = rotate(c.forward, {0, 0, -1}, pi / 2);
        }
        const auto rolled_pixels =
            render("vr-grip-roll", avatar_pose(player, &rolled_tracking), true, tracking.head, {0, -.7, -1}, true);
        changed = 0;
        for (std::size_t i = 0; i < upright_pixels.size(); i += 3)
            changed += std::abs(int(rolled_pixels[i]) - int(upright_pixels[i])) +
                           std::abs(int(rolled_pixels[i + 1]) - int(upright_pixels[i + 1])) +
                           std::abs(int(rolled_pixels[i + 2]) - int(upright_pixels[i + 2])) >
                       30;
        check(changed > 1000, "Full wrist roll changes real hand/controller pixels");
        VrPresentation presentation;
        VrButtons camera_button;
        camera_button.camera = true;
        presentation.step(0, camera_button);
        const auto offset = presentation.camera_offset({0, 0, -1});
        const auto third =
            render("vr-third-person", upright, false, tracking.head + offset, {0, -.7, -1}, true, offset);
        const auto displaced =
            render("vr-third-person-unshifted-controls", upright, false, tracking.head + offset, {0, -.7, -1}, true);
        check(third != displaced, "Third-person controls remain beside the presented headset");

        // The real renderer must show text above panel backgrounds in both target colour spaces.
        RideUi ui;
        const auto render_ui = [&](std::string name, bool wrist, bool controls, bool visible) {
            const auto eye = tracking.head,
                       direction = wrist
                                       ? normalized(tracking.controllers[0].position + Vec3{0, .18, 0} - tracking.head)
                                       : normalized(Vec3{0, -.2, -1});
            CameraPose c{eye, direction, {0, 1, 0}};
            ui.visible = visible;
            ui.controls = controls;
            ui.immersive = wrist;
            ui.third_person = false;
            ui.frame(wrist ? RideUi::wrist(tracking.controllers[0], eye) : RideUi::desktop(c, 1, ui.visible));
            const auto body = avatar.mesh(avatar_pose(player, &tracking), true, false, eye);
            std::vector<Vertex> mesh(body.begin(), body.end());
            const auto button = ui.frame().origin + ui.frame().right * .25 + ui.frame().down * .35;
            EquipmentRay pointer{tracking.controllers[1].position,
                                 normalized(button - tracking.controllers[1].position), true};
            ui.release();
            ui.pointer(pointer, true);
            ui.append(mesh, player, wrist, 90);
            if (wrist)
                ui.append_pointer(mesh, pointer);
            const auto tangent = std::tan(c.fov / 2);
            const auto matrix = projection(-tangent, tangent, -tangent, tangent, c.near_clip) * view(eye, direction);
            for (auto* renderer : {&a, &b}) {
                renderer->render(
                    0, matrix,
                    board_transform(player.render_board_position(), player.render_forward(), player.render_up()),
                    VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, eye, {}, {}, {}, mesh);
                const auto path = root / (name + (renderer == &a ? "-unorm.ppm" : "-srgb.ppm"));
                renderer->capture(0, path);
                const auto image = pixels(path);
                unsigned mint = 0, white = 0;
                for (std::size_t k = 0; k < image.size(); k += 3) {
                    mint += image[k + 1] > image[k] * 1.5 && image[k + 2] > image[k] * 1.3 && image[k + 1] > 100;
                    white += image[k] > 180 && image[k + 1] > 180 && image[k + 2] > 180;
                }
                check(mint > 80, "Menu accents really reach the GPU target");
                check(white > 100, "UI text draws in front of panel background");
                check(renderer->stats().avatar_triangles == mesh.size() / 3, "UI and avatar share a bounded real draw");
            }
        };
        render_ui("desktop-menu", false, false, true);
        render_ui("desktop-controls", false, true, true);
        render_ui("desktop-hud", false, false, false);
        render_ui("wrist-menu", true, false, true);
        render_ui("wrist-controls", true, true, true);
        player.warp({0, 0, 0}, {0, 0, -1});
        player.start_on_foot();
        RideInput holding;
        holding.equipment.tracked = true;
        holding.equipment.head = {0, 1.65, 0};
        holding.equipment.hands[1] = {{.3, 1.1, -.25}, {0, 1, 0}, {0, 0, -1}, {1, 0, 0}, true};
        holding.equipment.grip[1] = true;
        player.tick(holding);
        check(player.carrying_board(), "GPU fixture genuinely carries the board");
        render("desktop-board-held", avatar_pose(player), false, {2.8, 2.1, 3.2}, {-2.8, -1, -3.2}, false);
        std::cout << "PASS: " << checks
                  << " actual Vulkan avatar, look-down, labels, tracking fallback and stereo checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
