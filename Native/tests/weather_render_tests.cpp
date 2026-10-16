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

void submit(VulkanRenderer& r, const Matrix& camera, SnowfallView weather = {}, std::span<const Vertex> body = {},
            std::span<const Vertex> hud = {}, float fade = 0) {
    auto board = Matrix::identity();
    board.values[12] = 100;
    r.render(0, camera, board, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, weather.eye, {}, {}, {}, body, fade, {},
             {}, 1, {}, {}, {}, {}, {}, hud, true, weather);
}

unsigned lit(const std::vector<unsigned char>& p) {
    return unsigned(std::count_if(p.begin(), p.end(), [](auto c) { return c > 2; }));
}
} // namespace

int main(int argc, char** argv) {
    try {
        check(argc == 2, "Supply a temporary output directory");
        const auto root = std::filesystem::path(argv[1]);
        std::filesystem::create_directories(root);
        std::ofstream(root / "World.json")
            << R"({"Schema":"openslope-world/v1","SkyColor":[0,0,0],"Fog":{"Enabled":false}})";
        VulkanContext context;
        context.create(false);
        const auto camera = projection(-1, 1, -1, 1, .01) * view({}, {0, 0, -1});
        const auto hud_quad = quad(.101, 0, {0, .7f, .2f});
        std::vector<Vertex> hud(hud_quad.begin(), hud_quad.end());
        Player menu_player(Terrain::demo());
        RideUi menu;
        menu.visible = true;
        menu.frame(RideUi::desktop(CameraPose{}, 1, true));
        menu.append(hud, menu_player);
        const std::array<Vertex, 3> triangle{
            {{-.773f, -.631f, -1, 1, 0, 0}, {.817f, -.613f, -1, 1, 0, 0}, {-.183f, .807f, -1, 1, 0, 0}}};
        for (const auto format : {VK_FORMAT_R8G8B8A8_UNORM, VK_FORMAT_R8G8B8A8_SRGB})
            for (const auto msaa : {1u, 4u}) {
                Target target(context, format);
                VulkanRenderer renderer(context);
                Mesh mesh;
                mesh.map_root = root;
                renderer.upload(mesh);
                std::vector<unsigned char> native_hud, native_scene;
                for (const auto scale : {100u, 125u, 150u, 200u}) {
                    renderer.targets(std::span(&target.image, 1), format, side, side, msaa, scale);
                    check(renderer.scene_width() == side * scale / 100 && renderer.scene_height() == side * scale / 100,
                          "World targets use the selected supersampling dimensions");
                    submit(renderer, camera, {}, {}, hud);
                    const auto drawn_hud = capture(renderer, root);
                    if (scale == 100)
                        native_hud = drawn_hud;
                    else
                        check(drawn_hud == native_hud,
                              "Native UI retains identical edge coverage and MSAA at every scene scale");
                    submit(renderer, camera, {}, triangle);
                    const auto scene = capture(renderer, root);
                    check(lit(scene) > 20000, "The scaled world reaches the final output");
                    check(scene[(256 * side + 256) * 3] > 240 && scene[(100 * side + 450) * 3] == 0,
                          "Scene presentation preserves orientation and full-frame placement");
                    if (scale == 100)
                        native_scene = scene;
                    else {
                        check(scene != native_scene, "Higher resolution changes geometric edge coverage");
                        const auto partial =
                            std::count_if(scene.begin(), scene.end(), [](auto c) { return c > 0 && c < 255; });
                        check(partial > 100, "Downsampling produces fractional edge coverage");
                    }
                    submit(renderer, camera, {{}, 3.5, 3});
                    const auto snow = capture(renderer, root);
                    check(renderer.stats().snow_draws == 1 && renderer.stats().snowflakes == 600 && lit(snow) > 300,
                          "Default snow is visible in one bounded instanced draw");
                    submit(renderer, camera, {{}, 3.5, 1});
                    const auto sparse = capture(renderer, root);
                    check(renderer.stats().snowflakes == 200 && lit(sparse) < lit(snow),
                          "Lower settings thin the same field");
                    unsigned excess = 0;
                    for (std::size_t i = 0; i < snow.size(); ++i)
                        excess += sparse[i] > unsigned(snow[i]) + 1;
                    check(excess == 0, "Sparse flakes are an exact prefix rather than a reshuffled field");
                    submit(renderer, camera, {{}, 3.5, 3});
                    check(capture(renderer, root) == snow, "A fixed clock redraws snow without animation drift");
                    submit(renderer, camera, {{}, 3.6, 3});
                    check(capture(renderer, root) != snow, "The GPU clock advances falling and drifting flakes");
                    submit(renderer, camera, {{}, 3.5, 0});
                    check(lit(capture(renderer, root)) == 0 && renderer.stats().snow_draws == 0,
                          "Clear weather submits no snow draw");
                    submit(renderer, camera, {{}, 3.5, 10});
                    const auto storm = capture(renderer, root);
                    check(renderer.stats().snowflakes == maximum_snowflakes && renderer.stats().snow_draws == 1 &&
                              lit(storm) > lit(snow) * 10,
                          "Blizzard increases density within the same single-draw budget");
                    const auto wall = quad(2, -.02, {0, 0, 0});
                    submit(renderer, camera, {{}, 3.5, 3}, wall);
                    check(lit(capture(renderer, root)) == 0, "Opaque world depth occludes snow behind it");
                    submit(renderer, camera, {{}, 3.5, 3}, {}, {}, 1);
                    check(lit(capture(renderer, root)) == 0, "The reset fade includes snowfall");
                    SnowfallView moved{{1, 0, 0}, 3.5, 3};
                    submit(renderer, projection(-1, 1, -1, 1, .01) * view(moved.eye, {0, 0, -1}), moved);
                    check(capture(renderer, root) != snow, "Camera travel produces snow parallax");
                    SnowfallView periodic{{40, 0, 0}, 3.5, 3};
                    submit(renderer, projection(-1, 1, -1, 1, .01) * view(periodic.eye, {0, 0, -1}), periodic);
                    const auto translated = capture(renderer, root);
                    std::uint64_t difference = 0;
                    for (std::size_t i = 0; i < snow.size(); ++i)
                        difference += std::abs(int(snow[i]) - int(translated[i]));
                    check(difference < 1000, "Whole-box camera translations preserve the wrapped field without a seam");
                    bool rejected = false;
                    try {
                        submit(renderer, camera, {{}, std::numeric_limits<double>::quiet_NaN(), 3});
                    } catch (const std::invalid_argument&) {
                        rejected = true;
                    }
                    check(rejected, "Bad weather inputs are rejected before resetting the render fence");
                    submit(renderer, camera, {{}, 3.5, 3});
                    check(capture(renderer, root) == snow, "Rejected submissions leave the renderer usable");
                }
                Target other(context, format);
                VulkanRenderer right(context);
                right.upload(mesh);
                right.targets(std::span(&other.image, 1), format, side, side, msaa);
                renderer.deferred(true);
                right.deferred(true);
                const auto left_camera = projection(-1, 1, -1, 1, .01) * view({-.032, 0, 0}, {0, 0, -1});
                const auto right_camera = projection(-1, 1, -1, 1, .01) * view({.032, 0, 0}, {0, 0, -1});
                for (unsigned i = 0; i < 3; ++i) {
                    submit(renderer, left_camera, {{}, 4, 3});
                    submit(right, right_camera, {{}, 4, 3});
                    check(lit(capture(renderer, root)) > 300 && lit(capture(right, root)) > 300,
                          "Queued stereo eyes render one shared cyclopean weather field");
                }
                renderer.finish();
                right.finish();
                Player player(Terrain::demo());
                RideUi ui;
                ui.visible = ui.loading = true;
                ui.load_name = "TEST COURSE";
                ui.load_stage = "UPLOADING TEXTURES";
                ui.frame({{}, {1, 0, 0}, {0, -1, 0}, true, true, 1.5, 1.5});
                std::vector<unsigned char> early;
                for (const auto progress : {.25, .75}) {
                    ui.load_progress = progress;
                    std::vector<Vertex> vertices;
                    ui.append(vertices, player);
                    submit(renderer, camera, {}, {}, vertices);
                    const auto image = capture(renderer, root);
                    if (progress == .25)
                        early = image;
                    else {
                        unsigned added = 0, removed = 0;
                        for (std::size_t i = 0; i < image.size(); i += 3) {
                            const auto mint = [](const auto& p, std::size_t i) {
                                return p[i + 1] > 180 && p[i] < 100 && p[i + 2] > 130;
                            };
                            added += mint(image, i) && !mint(early, i);
                            removed += mint(early, i) && !mint(image, i);
                        }
                        check(added > 1000 && removed == 0,
                              "The real loading bar fills monotonically at native output resolution");
                    }
                }
                submit(renderer, camera);
                const auto old = capture(renderer, root);
                auto replacement = SceneAssets::prepare(mesh);
                replacement.world.sky_colour = {.8f, .1f, .1f};
                unsigned callbacks = 0;
                bool cancelled = false;
                try {
                    renderer.upload(std::move(replacement), [&](double progress, std::string_view) {
                        ++callbacks;
                        submit(renderer, camera);
                        check(capture(renderer, root) == old, "Upload callbacks can still draw the previous scene");
                        if (progress > .9)
                            throw std::runtime_error("Authored upload cancellation");
                    });
                } catch (const std::runtime_error& e) {
                    if (std::string_view(e.what()) != "Authored upload cancellation")
                        throw;
                    cancelled = true;
                }
                check(cancelled && callbacks >= 2, "A partial GPU upload can be interrupted safely");
                submit(renderer, camera);
                check(capture(renderer, root) == old,
                      "Failed uploads preserve the previous scene and its native presentation targets");
            }
        std::cout << "PASS: " << checks << " GPU snowfall, supersampling, native UI and queued stereo checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
