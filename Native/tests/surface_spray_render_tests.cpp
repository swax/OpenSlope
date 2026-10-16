#include "openslope/graphics_preferences.hpp"
#include "openslope/ride_ui.hpp"
#include "vulkan_renderer.hpp"
#include <fstream>
#include <iostream>
#include <limits>

namespace {
using namespace openslope;
constexpr unsigned side = 512;
unsigned checks = 0;

void check(bool value, const char* message) {
    ++checks;
    if (!value)
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
        info.extent = {side, side, 1};
        info.mipLevels = info.arrayLayers = 1;
        info.samples = VK_SAMPLE_COUNT_1_BIT;
        info.tiling = VK_IMAGE_TILING_OPTIMAL;
        info.usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT;
        vk_check(vkCreateImage(c.device, &info, nullptr, &image), "Create weather test image");
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
        check(allocation.memoryTypeIndex != UINT32_MAX, "Device-local image memory is available");
        vk_check(vkAllocateMemory(c.device, &allocation, nullptr, &memory), "Allocate weather image");
        vk_check(vkBindImageMemory(c.device, image, memory, 0), "Bind weather image");
    }

    ~Target() {
        vkDestroyImage(context.device, image, nullptr);
        vkFreeMemory(context.device, memory, nullptr);
    }
};

std::vector<unsigned char> capture(VulkanRenderer& renderer, const std::filesystem::path& root) {
    renderer.capture(0, root / "weather-frame.ppm");
    std::ifstream file(root / "weather-frame.ppm", std::ios::binary);
    std::string magic;
    unsigned w = 0, h = 0, max = 0;
    file >> magic >> w >> h >> max;
    file.get();
    check(magic == "P6" && w == side && h == side && max == 255,
          "Supersampled captures retain the native output dimensions");
    std::vector<unsigned char> result(w * h * 3);
    file.read(reinterpret_cast<char*>(result.data()), std::streamsize(result.size()));
    check(bool(file), "GPU readback is complete");
    return result;
}

std::array<Vertex, 6> quad(double width, double depth, std::array<float, 3> rgb) {
    const auto v = [&](double x, double y) { return Vertex{float(x), float(y), float(depth), rgb[0], rgb[1], rgb[2]}; };
    return {v(-width, -width), v(width, -width), v(width, width), v(-width, -width), v(width, width), v(-width, width)};
}

unsigned lit(const std::vector<unsigned char>& p) {
    return unsigned(std::count_if(p.begin(), p.end(), [](auto c) { return c > 2; }));
}
} // namespace

int main(int argc, char** argv) {
    try {
        check(argc == 2, "Supply an authored sprite fixture directory");
        const auto root = std::filesystem::path(argv[1]);
        std::ofstream(root / "World.json")
            << R"({"Schema":"openslope-world/v1","SkyColor":[0,0,0],"Fog":{"Enabled":false}})";
        VulkanContext context;
        context.create(false);
        const auto camera = projection(-1, 1, -1, 1, .01) * view({}, {0, 0, -1});
        auto board = Matrix::identity();
        board.values[12] = 100;
        const auto draw = [&](VulkanRenderer& renderer, const Matrix& matrix, std::span<const ParticleSprite> sprites,
                              std::span<const Vertex> wall = std::span<const Vertex>{}, float fade = 0) {
            renderer.render(0, matrix, board, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, {}, {}, {}, {}, wall, fade,
                            {}, {}, 1, {}, {}, {}, sprites);
        };
        for (const auto format : {VK_FORMAT_R8G8B8A8_UNORM, VK_FORMAT_R8G8B8A8_SRGB})
            for (const auto msaa : {1u, 4u}) {
                Target left(context, format), right(context, format);
                VulkanRenderer a(context), b(context);
                Mesh mesh;
                mesh.map_root = root;
                auto scene = std::make_shared<VulkanScene>(context);
                scene->upload(mesh);
                a.use_scene(scene);
                b.use_scene(scene);
                a.targets(std::span(&left.image, 1), format, side, side, msaa);
                b.targets(std::span(&right.image, 1), format, side, side, msaa);
                for (const auto name : {"packed", "off-track", "powder", "ice", "metal", "rail", "air"}) {
                    SurfaceSpray fx;
                    Rider rider;
                    rider.position = {0, -.15, -2.5};
                    rider.forward = {0, 0, -1};
                    rider.velocity = {0, 0, -18};
                    rider.grounded = true;
                    rider.motion = Motion::Ground;
                    rider.surface = 1;
                    rider.lean = .9;
                    const std::string kind = name;
                    if (kind == "off-track")
                        rider.surface = 2;
                    if (kind == "powder")
                        rider.surface = 3;
                    if (kind == "ice")
                        rider.surface = 5;
                    if (kind == "metal" || kind == "rail") {
                        rider.surface = 13;
                        rider.lean = 0;
                    }
                    if (kind == "rail")
                        rider.motion = Motion::Rail;
                    auto before = rider;
                    if (kind == "air") {
                        rider.grounded = false;
                        rider.motion = Motion::Air;
                        rider.velocity = {0, 6, -14};
                        rider.lean = 0;
                    }
                    for (unsigned i = 0; i < 12; ++i) {
                        fx.step(before, rider, 1. / 60);
                        before = rider;
                    }
                    const auto sprites = fx.draw(.6);
                    check(!sprites.empty(), "Each riding situation produces its real simulator snapshot");
                    draw(a, camera, sprites);
                    const auto pixels = capture(a, root);
                    check(a.stats().world_sprites == sprites.size() && lit(pixels) > 20,
                          "Every registered riding sprite reaches the actual GPU batch");
                    std::array<std::uint64_t, 3> sum{};
                    for (std::size_t i = 0; i < pixels.size(); ++i)
                        sum[i % 3] += pixels[i];
                    if (kind == "packed")
                        check(sum[0] > sum[1] * 10 + 100 && sum[0] > sum[2] * 10,
                              "Packed chunks sample their isolated red blb1 fixture");
                    if (kind == "powder")
                        check(sum[1] > sum[0] * 10 + 100 && sum[1] > sum[2] * 10,
                              "Powder twinkles sample their isolated green str3 fixture");
                    if (kind == "ice")
                        check(sum[1] + sum[2] > sum[0] * 10 + 100,
                              "Ice shards sample their isolated cyan cnf2 fixture");
                    if (kind == "metal" || kind == "rail")
                        check(sum[0] > sum[1] && sum[1] > sum[2],
                              "Actual spark trails remain orange-yellow on both target formats");
                    if (kind == "air")
                        check(sum[2] > sum[0] && sum[0] > sum[1], "Takeoff puffs use the isolated purple swp2 fixture");
                    draw(a, camera, sprites);
                    check(capture(a, root) == pixels, "Repeating an eye draw neither ages nor reshuffles the effect");
                    const auto wall = quad(2, -.02, {0, 0, 0});
                    draw(a, camera, sprites, wall);
                    check(lit(capture(a, root)) == 0,
                          "Opaque world geometry occludes chunks, sparks and airborne puffs");
                    draw(a, camera, sprites, {}, 1);
                    check(lit(capture(a, root)) == 0, "The rider reset fade includes all ring families");
                    a.deferred(true);
                    b.deferred(true);
                    draw(a, projection(-1, 1, -1, 1, .01) * view({-.032, 0, 0}, {0, 0, -1}), sprites);
                    draw(b, projection(-1, 1, -1, 1, .01) * view({.032, 0, 0}, {0, 0, -1}), sprites);
                    const auto l = capture(a, root), r = capture(b, root);
                    check(lit(l) > 20 && lit(r) > 20 && l != r,
                          "Queued stereo eyes view the same world-fixed effect with binocular parallax");
                    a.deferred(false);
                    b.deferred(false);
                    draw(a, camera, {});
                    check(lit(capture(a, root)) == 0, "An expired or disabled ring leaves no stale GPU sprites");
                }
            }
        std::cout << "PASS: " << checks
                  << " real GPU surface sprite selection, motion snapshot, depth, fade and stereo checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
