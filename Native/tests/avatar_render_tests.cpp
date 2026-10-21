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
        if (argc < 2 || argc > 3)
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
        {
            // Compare colour transfer without gamma-vs-linear MSAA edge resolves.
            a.targets(std::span(&left.image, 1), VK_FORMAT_R8G8B8A8_UNORM, 1024, 1024, 1);
            b.targets(std::span(&right.image, 1), VK_FORMAT_R8G8B8A8_SRGB, 1024, 1024, 1);
            const Vec3 eye{2.8, 2.1, 3.2};
            const auto camera = projection(-.85, .85, -.85, .85) * view(eye, {-2.8, -1, -3.2});
            const auto board =
                board_transform(player.render_board_position(), player.render_forward(), player.render_up());
            const auto unlit = avatar.mesh(avatar_pose(player), false, false);
            a.render(0, camera, board, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, eye, {}, {}, {}, unlit);
            a.capture(0, root / "scene-light-baseline.ppm");
            SceneLighting lighting({LightProbe{{}, {.1, .6, .1}}});
            const auto body = avatar.mesh(avatar_pose(player), false, false, {}, {}, &lighting);
            a.render(0, camera, board, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, eye, {}, {}, {}, body);
            a.capture(0, root / "scene-lit-avatar.ppm");
            b.render(0, camera, board, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, eye, {}, {}, {}, body);
            b.capture(0, root / "scene-lit-avatar-srgb.ppm");
            const auto original = pixels(root / "scene-light-baseline.ppm"),
                       lit = pixels(root / "scene-lit-avatar.ppm"), srgb = pixels(root / "scene-lit-avatar-srgb.ppm");
            unsigned changed = 0, green = 0, differences = 0;
            for (std::size_t i = 0; i < lit.size(); i += 3) {
                if (original[i] != lit[i] || original[i + 1] != lit[i + 1] || original[i + 2] != lit[i + 2]) {
                    ++changed;
                    green += lit[i + 1] > lit[i] * 2 && lit[i + 1] > lit[i + 2] * 2;
                }
                for (unsigned c = 0; c < 3; ++c)
                    differences += std::abs(int(lit[i + c]) - int(srgb[i + c])) > 2;
            }
            check(changed > 500, "scene lighting actually changes visible avatar pixels in the original pipeline");
            check(green > changed / 2, "course probe colour reaches the visible body");
            check(differences < 100, "scene-lit avatar agrees across UNORM and sRGB targets");
            a.targets(std::span(&left.image, 1), VK_FORMAT_R8G8B8A8_UNORM, 1024, 1024, 4);
            b.targets(std::span(&right.image, 1), VK_FORMAT_R8G8B8A8_SRGB, 1024, 1024, 4);
        }
        for (const auto lead : {-1, 1}) {
            player.warp({0, 10, 0}, {0, 0, -1});
            auto& rider = const_cast<Rider&>(player.rider());
            rider.grounded = false;
            rider.motion = Motion::Air;
            rider.lead = lead;
            const auto hips = avatar_pose(player).joint(AvatarJoint::Hips);
            for (const auto flip : {90., 180., 270.}) {
                rider.flip_degrees = flip;
                const auto pose = avatar_pose(player);
                check(length(pose.joint(AvatarJoint::Hips) - hips) < .02,
                      "Rendered flips retain the airborne pelvis centre");
                render("flip-" + std::to_string(lead) + "-" + std::to_string(unsigned(flip)), pose, false,
                       {2.8, 12.1, 3.2}, {-2.8, -1.2, -3.2}, false);
            }
        }
        player.warp({0, 0, 0}, {0, 0, -1});
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
        for (unsigned side = 0; side < 2; ++side) {
            auto hand_pose = avatar_pose(player, &tracking);
            auto& grip = hand_pose.controllers[side];
            grip.right = {1, 0, 0};
            grip.up = {0, 1, 0};
            grip.forward = {0, 0, -1};
            const auto eye = grip.position - grip.up * .08 - grip.forward * .38;
            const auto camera = projection(-.4, .4, -.4, .4) * view(eye, grip.forward);
            std::array<std::vector<unsigned char>, 2> states;
            for (unsigned closed = 0; closed < 2; ++closed) {
                grip.fingers.fill(closed);
                const auto all = avatar.mesh(hand_pose, true, false);
                std::vector<Vertex> hand;
                for (std::size_t i = 0; i < all.size(); i += 3) {
                    bool near = true;
                    for (unsigned k = 0; k < 3; ++k)
                        near &= length(Vec3{all[i + k].x, all[i + k].y, all[i + k].z} - grip.position) < .23;
                    if (near)
                        hand.insert(hand.end(), all.begin() + i, all.begin() + i + 3);
                }
                check(hand.size() > 1000, "Close-up contains the posed hand and unchanged controller model");
                for (auto* renderer : {&a, &b}) {
                    const auto name = std::string(side ? "right-hand-" : "left-hand-") + (closed ? "closed" : "open") +
                                      (renderer == &a ? "-unorm" : "-srgb");
                    renderer->render(0, camera, board_transform({0, -10000, 0}, {0, 0, -1}, {0, 1, 0}),
                                     VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, eye, {}, {}, {}, hand);
                    const auto path = root / (name + ".ppm");
                    renderer->capture(0, path);
                    const auto image = pixels(path);
                    if (renderer == &a)
                        states[closed] = image;
                    else {
                        double difference = 0;
                        for (std::size_t i = 0; i < image.size(); ++i)
                            difference += std::abs(int(image[i]) - int(states[closed][i]));
                        check(difference / image.size() < 1., "Open and curled hands match across target formats");
                    }
                }
            }
            unsigned difference = 0;
            for (std::size_t i = 0; i < states[0].size(); i += 3)
                difference += std::abs(int(states[0][i]) - int(states[1][i])) +
                                  std::abs(int(states[0][i + 1]) - int(states[1][i + 1])) +
                                  std::abs(int(states[0][i + 2]) - int(states[1][i + 2])) >
                              30;
            check(difference > 2000, "Sensor-driven finger closure visibly changes each rendered hand");
        }
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
        player.scoring().start();
        player.scoring().step(1. / 60, ScoreMotion::Air);
        player.scoring().step_off_board(1, 0);
        const auto grab = avatar_pose(player, &tracking);
        check(grab.score_text[1] == "TRICK +4590" && grab.score_text[3] == "LEFT GRAB 1.0S",
              "VR grab readout shares the scored hand, points and duration");
        const auto held_grab = render("vr-score-grab", grab, true, tracking.head, {0, -.7, -1}, true);
        auto no_detail = grab;
        no_detail.score_text[3].clear();
        const auto hidden_detail =
            render("vr-score-grab-no-detail", no_detail, true, tracking.head, {0, -.7, -1}, true);
        changed = 0;
        for (std::size_t i = 0; i < held_grab.size(); i += 3)
            changed += std::abs(int(held_grab[i]) - int(hidden_detail[i])) +
                           std::abs(int(held_grab[i + 1]) - int(hidden_detail[i + 1])) +
                           std::abs(int(held_grab[i + 2]) - int(hidden_detail[i + 2])) >
                       30;
        check(changed > 100, "Grab hand and timer reach actual controller-panel pixels");
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
            const auto attached = RideUi::wrist(tracking.controllers[0], tracking.head);
            const auto eye = tracking.head,
                       direction = wrist ? normalized(attached.origin + attached.right * .5 + attached.down * .5 - eye)
                                         : normalized(Vec3{0, -.2, -1});
            CameraPose c{eye, direction, {0, 1, 0}};
            ui.visible = visible;
            ui.controls = controls;
            ui.immersive = wrist;
            ui.third_person = false;
            ui.frame(wrist ? RideUi::wrist(tracking.controllers[0], eye) : RideUi::desktop(c, 1, ui.visible));
            auto pose = avatar_pose(player, &tracking);
            pose.controller_models &= !wrist || visible;
            const auto body = avatar.mesh(pose, true, false, eye);
            std::vector<Vertex> hud;
            const auto button = ui.frame().origin + ui.frame().right * .25 + ui.frame().down * .35;
            EquipmentRay pointer{tracking.controllers[1].position,
                                 normalized(button - tracking.controllers[1].position), true};
            ui.release();
            ui.pointer(pointer, true);
            ui.append(hud, player, wrist, 90);
            if (wrist)
                ui.append_pointer(hud, pointer);
            if (wrist && !visible)
                check(hud.empty(), "Hidden wrist mode submits no HUD or pointer geometry");
            const auto tangent = std::tan(c.fov / 2);
            const auto matrix = projection(-tangent, tangent, -tangent, tangent, c.near_clip) * view(eye, direction);
            for (auto* renderer : {&a, &b}) {
                renderer->render(
                    0, matrix,
                    board_transform(player.render_board_position(), player.render_forward(), player.render_up()),
                    VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, eye, {}, {}, {}, body, 0, {}, {}, 1, {}, {}, {}, {},
                    {}, hud, !wrist);
                const auto path = root / (name + (renderer == &a ? "-unorm.ppm" : "-srgb.ppm"));
                renderer->capture(0, path);
                const auto image = pixels(path);
                unsigned mint = 0, white = 0;
                for (std::size_t k = 0; k < image.size(); k += 3) {
                    mint += image[k + 1] > image[k] * 1.5 && image[k + 2] > image[k] * 1.3 && image[k + 1] > 100;
                    white += image[k] > 180 && image[k + 1] > 180 && image[k + 2] > 180;
                }
                if (!wrist || visible) {
                    check(mint > 80, "Menu accents really reach the GPU target");
                    check(white > 100, "UI text draws in front of panel background");
                } else {
                    renderer->render(
                        0, matrix,
                        board_transform(player.render_board_position(), player.render_forward(), player.render_up()),
                        VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, eye, {}, {}, {}, body);
                    renderer->capture(0, root / "hidden-wrist-body-only.ppm");
                    check(image == pixels(root / "hidden-wrist-body-only.ppm"),
                          "Hidden wrist rendering matches the body/hand-only frame exactly");
                }
                check(renderer->stats().avatar_triangles == body.size() / 3,
                      "Avatar draw stays separate from the late UI overlay");
            }
        };
        render_ui("desktop-menu", false, false, true);
        render_ui("desktop-controls", false, true, true);
        render_ui("desktop-hud", false, false, false);
        render_ui("wrist-menu", true, false, true);
        render_ui("wrist-controls", true, true, true);
        render_ui("wrist-hidden", true, false, false);
        RideUi depth_ui;
        depth_ui.visible = true;
        depth_ui.frame({{-.5, 2.15, -1}, {1, 0, 0}, {0, -1, 0}, true});
        std::vector<Vertex> depth_hud;
        depth_ui.append(depth_hud, player, true);
        const std::vector<Vertex> foreground{{-.2f, 1.45f, 0, 1, 0, 1}, {.2f, 1.45f, 0, 1, 0, 1},
                                             {.2f, 1.85f, 0, 1, 0, 1},  {-.2f, 1.45f, 0, 1, 0, 1},
                                             {.2f, 1.85f, 0, 1, 0, 1},  {-.2f, 1.85f, 0, 1, 0, 1}};
        const Vec3 depth_eye{0, 1.65, 1};
        a.render(0, projection(-.7, .7, -.7, .7) * view(depth_eye, {0, 0, -1}),
                 board_transform({0, -10000, 0}, {0, 0, -1}, {0, 1, 0}), VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {},
                 depth_eye, {}, {}, {}, foreground, 0, {}, {}, 1, {}, {}, {}, {}, {}, depth_hud);
        a.capture(0, root / "wrist-depth-occlusion.ppm");
        const auto depth_image = pixels(root / "wrist-depth-occlusion.ppm");
        const auto centre_pixel = (512 * 1024 + 512) * 3;
        check(depth_image[centre_pixel] > 240 && depth_image[centre_pixel + 1] < 10 &&
                  depth_image[centre_pixel + 2] > 240,
              "World-space wrist panel preserves nearer hand/controller pixels through real depth testing");
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
        {
            std::vector<Vertex> field;
            std::array<Matrix, 16> boards;
            for (unsigned i = 0; i < 16; ++i) {
                player.warp({(double(i % 4) - 1.5) * 3, 0, -double(i / 4) * 3}, {0, 0, -1});
                const auto mesh = avatar.mesh(avatar_pose(player), false, false);
                field.insert(field.end(), mesh.begin(), mesh.end());
                boards[i] =
                    board_transform(player.render_board_position(), player.render_forward(), player.render_up());
            }
            const auto hidden_board = board_transform({10000, 10000, 10000}, {0, 0, -1}, {0, 1, 0});
            for (unsigned eye_index = 0; eye_index < 2; ++eye_index) {
                auto& renderer = eye_index ? b : a;
                const auto target = eye_index ? right.image : left.image;
                renderer.targets(std::span(&target, 1), eye_index ? VK_FORMAT_R8G8B8A8_SRGB : VK_FORMAT_R8G8B8A8_UNORM,
                                 1024, 1024, 4, 150);
                const Vec3 eye{eye_index ? .032 : -.032, 7, 12};
                const auto matrix = projection(-.85, .85, -.85, .85) * view(eye, Vec3{0, 0, -4} - eye);
                renderer.render(0, matrix, hidden_board, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, eye, {}, {}, {},
                                field, 0, {}, {}, 1, {}, {}, {}, {}, {}, {}, false, {}, nullptr, boards);
                check(renderer.stats().opponent_boards == 16 && renderer.stats().avatar_triangles == field.size() / 3,
                      "The complete field and sixteen shared boards reach each actual stereo GPU submission");
                const auto name = root / ("field-eye-" + std::to_string(eye_index) + ".ppm");
                renderer.capture(0, name);
                check(landmarks(pixels(name)) > 1000, "The full opponent field has visible figure pixels in both eyes");
            }
        }
        if (argc == 3) {
            const auto maps = std::filesystem::path(argv[2]);
            const auto course = maps / "MERQUER";
            auto logic = WorldLogic::load(course);
            const auto paths = spline_paths(course);
            PropRoute track(paths.at(38).curves);
            const auto centre = track.sample(track.length() * .5).position;
            const Vec3 eye = centre + Vec3{0, 8, 35};
            const auto matrix = projection(-.7, .7, -.7, .7) * view(eye, centre - eye);
            Mesh empty;
            empty.map_root = course;
            auto train_scene = std::make_shared<VulkanScene>(context);
            train_scene->upload(empty);
            VulkanRenderer owned(context);
            owned.use_scene(train_scene);
            owned.targets(std::span(&left.image, 1), VK_FORMAT_R8G8B8A8_UNORM, 1024, 1024, 1);
            const auto no_board = board_transform({0, -10000, 0}, {0, 0, -1}, {0, 1, 0});
            std::vector<std::uint8_t> hidden(logic.flags().size());
            const std::array<Vec3, 1> observer{centre};
            unsigned visible = 0;
            for (unsigned frame = 0; frame <= 480; ++frame) {
                logic.tick(1. / 60, 0, observer);
                if (frame % 60)
                    continue;
                const auto routes = logic.route_motions();
                const auto train =
                    std::find_if(routes.begin(), routes.end(), [](const auto& r) { return r.instance == 344; });
                check(train != routes.end(), "Owned MERQUER train remains an active detached mover");
                owned.render(0, matrix, no_board, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, eye, {}, {}, {}, {}, 0,
                             hidden, {}, 1, std::span(&*train, 1));
                visible += owned.stats().route_copies;
                owned.capture(0, root / ("owned-merquer-train-" + std::to_string(frame) + ".ppm"));
            }
            check(visible > 0, "Owned MERQUER train produces actual GPU draw calls during a complete pass");
            {
                const auto course = maps / "GARI";
                auto logic = WorldLogic::load(course);
                logic.restart(RunMode::Showoff);
                const auto props = Props::load(course);
                const auto centre = props.instances.at(392).bounds.center();
                const auto size = length(props.instances.at(392).bounds.max - props.instances.at(392).bounds.min);
                const auto eye = centre + Vec3{size * .9, size * .3, size * .9};
                const auto camera = projection(-.6, .6, -.6, .6) * view(eye, centre - eye);
                Mesh mesh;
                mesh.map_root = course;
                auto scene = std::make_shared<VulkanScene>(context);
                scene->upload(mesh, logic.flag_models(), logic.faceted_models());
                VulkanRenderer gem(context);
                gem.use_scene(scene);
                gem.targets(std::span(&left.image, 1), VK_FORMAT_R8G8B8A8_UNORM, 1024, 1024, 1);
                std::vector<std::uint8_t> only(logic.flags().size());
                only[392] = WorldDraw;
                const std::array<Vec3, 1> view{centre};
                for (unsigned frame = 0; frame <= 60; ++frame) {
                    logic.tick(1. / 60, 0, view);
                    if (frame % 15)
                        continue;
                    gem.render(0, camera, no_board, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, eye, {}, {}, {}, {},
                               0, only, logic.motions(), 1, {}, logic.texture_frames());
                    check(gem.stats().visible_props == 1, "Owned rotating gem reaches the GPU with authored lighting");
                    gem.capture(0, root / ("owned-gari-gem-" + std::to_string(frame) + ".ppm"));
                }
            }
        }
        std::cout << "PASS: " << checks
                  << " actual Vulkan avatar, look-down, labels, tracking fallback and stereo checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
