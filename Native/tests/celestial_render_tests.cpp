#include "vulkan_renderer.hpp"
#include <algorithm>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>

namespace {
using namespace openslope;
unsigned checks = 0;

void check(bool v, const char* message) {
    ++checks;
    if (!v)
        throw std::runtime_error(message);
}

struct Target {
    VulkanContext& context;
    VkImage image{};
    VkDeviceMemory memory{};

    Target(VulkanContext& c, VkFormat format) : context(c) {
        VkImageCreateInfo info{VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO};
        info.imageType = VK_IMAGE_TYPE_2D;
        info.format = format;
        info.extent = {128, 128, 1};
        info.mipLevels = info.arrayLayers = 1;
        info.samples = VK_SAMPLE_COUNT_1_BIT;
        info.tiling = VK_IMAGE_TILING_OPTIMAL;
        info.usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT;
        vk_check(vkCreateImage(c.device, &info, nullptr, &image), "Create celestial test image");
        VkMemoryRequirements requirements;
        vkGetImageMemoryRequirements(c.device, image, &requirements);
        VkPhysicalDeviceMemoryProperties props;
        vkGetPhysicalDeviceMemoryProperties(c.physical, &props);
        VkMemoryAllocateInfo allocation{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
        allocation.allocationSize = requirements.size;
        allocation.memoryTypeIndex = UINT32_MAX;
        for (unsigned i = 0; i < props.memoryTypeCount; ++i)
            if ((requirements.memoryTypeBits & (1u << i)) &&
                (props.memoryTypes[i].propertyFlags & VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT)) {
                allocation.memoryTypeIndex = i;
                break;
            }
        check(allocation.memoryTypeIndex != UINT32_MAX, "Image memory type exists");
        vk_check(vkAllocateMemory(c.device, &allocation, nullptr, &memory), "Allocate celestial test image");
        vk_check(vkBindImageMemory(c.device, image, memory, 0), "Bind celestial test image");
    }

    ~Target() {
        if (image)
            vkDestroyImage(context.device, image, nullptr);
        if (memory)
            vkFreeMemory(context.device, memory, nullptr);
    }
};

std::vector<unsigned char> pixels(VulkanRenderer& renderer, const std::filesystem::path& output) {
    renderer.capture(0, output);
    std::ifstream file(output, std::ios::binary);
    std::string magic;
    unsigned w, h, max;
    file >> magic >> w >> h >> max;
    file.get();
    check(magic == "P6" && w == 128 && h == 128 && max == 255, "Real GPU capture header is valid");
    std::vector<unsigned char> result(w * h * 3);
    file.read(reinterpret_cast<char*>(result.data()), result.size());
    check(bool(file), "Real GPU capture is complete");
    return result;
}

std::array<Vertex, 6> quad(double width, double z, std::array<float, 3> colour) {
    const auto v = [&](double x, double y) {
        return Vertex{float(x), float(y), float(z), colour[0], colour[1], colour[2]};
    };
    return {v(-width, -width), v(width, -width), v(width, width), v(-width, -width), v(width, width), v(-width, width)};
}

void submit(VulkanRenderer& renderer, const Matrix& camera, CelestialView frame = {}, Vec3 eye = {},
            std::span<const Vertex> body = {}, std::span<const Vertex> hud = {}, float fade = 0,
            const LampView* lamps = nullptr) {
    auto board = Matrix::identity();
    board.values[12] = 20;
    renderer.render(0, camera, board, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, eye, {}, {}, {}, body, fade, {}, {},
                    1, {}, {}, {}, {}, frame, hud, false, {}, lamps);
}

int channel(const std::vector<unsigned char>& image, unsigned x, unsigned y, unsigned c) {
    return image[(y * 128 + x) * 3 + c];
}
} // namespace

int main(int argc, char** argv) {
    try {
        check(argc == 2, "Supply authored celestial fixtures");
        const auto root = std::filesystem::path(argv[1]);
        VulkanContext context;
        context.create(false);
        const auto camera = projection(-1, 1, -1, 1) * view({}, {0, 0, -1});
        for (const auto format : {VK_FORMAT_R8G8B8A8_UNORM, VK_FORMAT_R8G8B8A8_SRGB})
            for (const auto samples : {1u, 4u})
                for (const auto name : {"fallback", "atlas"}) {
                    Target a(context, format), b(context, format);
                    VulkanRenderer first(context), second(context);
                    auto scene = std::make_shared<VulkanScene>(context);
                    Mesh mesh;
                    mesh.map_root = root / name;
                    scene->upload(mesh);
                    first.use_scene(scene);
                    second.use_scene(scene);
                    first.targets(std::span(&a.image, 1), format, 128, 128, samples);
                    second.targets(std::span(&b.image, 1), format, 128, 128, samples);
                    const auto output = root / "frame.ppm";
                    CelestialView hidden;
                    hidden.visibility = 0;
                    submit(first, camera, hidden);
                    const auto rest = pixels(first, output);
                    check(first.stats().celestial_draws == 0, "Fully occluded sun submits no draw");
                    submit(first, camera);
                    const auto clear = pixels(first, output);
                    check(first.stats().celestial_draws == 2 && first.stats().celestial_triangles >= 34,
                          "Fan and corona use separate bounded draws");
                    check(channel(clear, 64, 64, 1) > channel(rest, 64, 64, 1) + 25,
                          "Broad corona is visible at its projected centre");
                    const auto wall = quad(2, -1, {.04f, .06f, .08f});
                    submit(first, camera, hidden, {}, wall);
                    const auto wall_rest = pixels(first, output);
                    submit(first, camera, {}, {}, wall);
                    const auto over_wall = pixels(first, output);
                    check(channel(over_wall, 64, 64, 1) > channel(wall_rest, 64, 64, 1) + 25,
                          "Glare is composited over the opaque world/rider depth");
                    const auto hud = quad(.05, -.25, {0, 1, 0});
                    submit(first, camera, {}, {}, wall, hud);
                    const auto with_hud = pixels(first, output);
                    for (unsigned c = 0; c < 3; ++c)
                        check(std::abs(channel(with_hud, 64, 64, c) - (c == 1 ? 255 : 0)) <= 1,
                              "Late menu/wrist text retains its colour over the sun");
                    const Vec3 eye{123, 45, -70};
                    submit(first, projection(-1, 1, -1, 1) * view(eye, {0, 0, -1}), {}, eye);
                    const auto moved = pixels(first, output);
                    unsigned max_delta = 0;
                    for (std::size_t i = 0; i < clear.size(); ++i)
                        max_delta = std::max(max_delta, unsigned(std::abs(int(clear[i]) - int(moved[i]))));
                    check(max_delta <= 2, "Camera-relative sun does not translate across the view during travel");
                    submit(first, projection(-1, 1, -1, 1) * view({}, {0, 0, 1}));
                    check(pixels(first, output) == rest && first.stats().celestial_draws == 0,
                          "Behind-camera glare is absent");
                    submit(first, camera, {}, {}, {}, {}, 1);
                    const auto faded = pixels(first, output);
                    check(std::all_of(faded.begin(), faded.end(), [](auto c) { return c == 0; }),
                          "Reset fade includes the entire glare layer");
                    CelestialView low;
                    low.visibility = .2;
                    submit(first, camera, low);
                    const auto dim = pixels(first, output);
                    first.deferred(true);
                    second.deferred(true);
                    for (unsigned turn = 0; turn < 6; ++turn) {
                        submit(first, camera, low);
                        submit(second, camera);
                        check(pixels(first, output) == dim && pixels(second, output) == clear,
                              "Queued eyes keep separate dynamic celestial buffers");
                    }
                    first.deferred(false);
                    second.deferred(false);
                    CelestialView stereo;
                    stereo.stereo = true;
                    stereo.anchor = {};
                    for (const auto x : {-.032, .032}) {
                        submit(first, projection(-1, 1, -1, 1) * view({x, 0, 0}, {0, 0, -1}), stereo, {x, 0, 0});
                        const auto drawn = pixels(first, output);
                        check(first.stats().celestial_triangles == 34 &&
                                  channel(drawn, 64, 64, 1) > channel(rest, 64, 64, 1) + 20,
                              "Each eye projects the shared distant sky disc and corona");
                    }
                    auto invalid = stereo;
                    invalid.visibility = std::numeric_limits<double>::infinity();
                    bool rejected = false;
                    try {
                        submit(first, camera, invalid);
                    } catch (const std::invalid_argument&) {
                        rejected = true;
                    }
                    check(rejected, "Invalid glare submission is rejected before fence reset");
                    submit(first, camera);
                    check(pixels(first, output) == clear, "A rejected glare submission leaves the renderer usable");
                    if (std::string(name) == "atlas")
                        check(channel(clear, 64, 64, 1) > channel(clear, 64, 64, 0) * 2,
                              "Only the lens atlas top-right green tile is submitted");
                }
        for (const auto name : {"lamps", "lamps-atlas", "lamps-invalid-atlas"}) {
            const bool atlas = std::string(name) == "lamps-atlas";
            const auto lamps = root / name;
            std::filesystem::create_directories(lamps);
            std::ofstream(lamps / "World.json")
                << R"({"Schema":"openslope-world/v1","SkyColor":[0,0,0],"Fog":{"Enabled":false}})";
            std::ofstream(lamps / "Lights.json")
                << (atlas ? R"({"Lights":[{"SpriteRes":32,"Colour":[1,1,1],"Position":[0,500,0]}]})"
                          : R"({"Lights":[{"SpriteRes":32,"Colour":[1,0,0],"Position":[0,500,0]}]})");
            for (const auto format : {VK_FORMAT_R8G8B8A8_UNORM, VK_FORMAT_R8G8B8A8_SRGB})
                for (const auto samples : {1u, 4u}) {
                    Target image(context, format);
                    VulkanRenderer renderer(context);
                    Mesh mesh;
                    mesh.map_root = lamps;
                    auto scene = std::make_shared<VulkanScene>(context);
                    scene->upload(mesh);
                    renderer.use_scene(scene);
                    renderer.targets(std::span(&image.image, 1), format, 128, 128, samples);
                    submit(renderer, camera);
                    const auto lit = pixels(renderer, lamps / "visible.ppm");
                    check(renderer.stats().lamp_glints == 1 && channel(lit, 64, 64, atlas ? 1 : 0) > 120,
                          "Real GPU lamp batch adds its source hue at the projected light");
                    check(channel(lit, 50, 50, 0) > channel(lit, 54, 54, 0) + 20,
                          "Lamp draws a circular rim around its soft aura, rather than a flat disc");
                    if (atlas) {
                        check(channel(lit, 50, 50, 1) < channel(lit, 50, 50, 0) / 2 && channel(lit, 50, 50, 2) < 5,
                              "Halo samples the isolated upper-left lens ring tile");
                        check(channel(lit, 64, 64, 0) < 10 && channel(lit, 64, 64, 1) > 120,
                              "Core uses the upper-right tile without the unused lower-right tile");
                    }
                    const auto wall = quad(20, -2, {0, 0, 0});
                    submit(renderer, camera, {}, {}, wall);
                    const auto hidden = pixels(renderer, lamps / "hidden.ppm");
                    check(channel(hidden, 64, 64, 0) == 0 && channel(hidden, 50, 50, 0) == 0,
                          "World geometry in front of the pulled glow occludes its halo and fixed core");
                    const auto edge = quad(.2, -2, {0, 0, 0});
                    submit(renderer, camera, {}, {}, edge);
                    const auto partial = pixels(renderer, lamps / "partial.ppm");
                    check(channel(partial, 64, 64, 0) == 0 && channel(partial, 50, 50, 0) > 20,
                          "Halo clips per pixel at an occluder edge without reading through its centre");
                    Target other_image(context, format);
                    VulkanRenderer other(context);
                    other.use_scene(scene);
                    other.targets(std::span(&other_image.image, 1), format, 128, 128, samples);
                    const Vec3 left_eye{-.032, 0, 0}, right_eye{.032, 0, 0};
                    const auto left = projection(-1, 1, -1, 1) * view(left_eye, {0, 0, -1});
                    const auto right = projection(-1, 1, -1, 1) * view(right_eye, {0, 0, -1});
                    const auto common = stereo_lamp_view(left.values, right.values, left_eye, right_eye);
                    submit(renderer, left, {}, left_eye, {}, {}, 0, &common);
                    submit(other, right, {}, right_eye, {}, {}, 0, &common);
                    const auto l = pixels(renderer, lamps / "left.ppm");
                    const auto r = pixels(other, lamps / "right.ppm");
                    double l_energy = 0, r_energy = 0;
                    for (std::size_t i = 0; i < l.size(); ++i) {
                        l_energy += l[i];
                        r_energy += r[i];
                    }
                    check(renderer.stats().lamp_glints == 1 && other.stats().lamp_glints == 1 && l != r,
                          "Queued eye renderers draw the shared lamp cloud with visible stereo separation");
                    check(l_energy > 1000 && std::abs(l_energy - r_energy) < l_energy * .02,
                          "Cyclopean bloom retains matching stereo glow energy after both eyes are queued");
                }
        }
        std::cout << "PASS: " << checks
                  << " actual Vulkan celestial, depth, HUD, camera, stereo and queued-eye checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
