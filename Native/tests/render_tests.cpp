#include "openslope/world_logic.hpp"
#include "vulkan_renderer.hpp"
#include <cmath>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>

namespace {
using namespace openslope;
unsigned checks = 0;

struct Target {
    VulkanContext& context;
    VkImage image{};
    VkDeviceMemory memory{};

    ~Target() {
        if (image)
            vkDestroyImage(context.device, image, nullptr);
        if (memory)
            vkFreeMemory(context.device, memory, nullptr);
    }

    void create(VkFormat format) {
        VkImageCreateInfo info{VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO};
        info.imageType = VK_IMAGE_TYPE_2D;
        info.format = format;
        info.extent = {128, 128, 1};
        info.mipLevels = 1;
        info.arrayLayers = 1;
        info.samples = VK_SAMPLE_COUNT_1_BIT;
        info.tiling = VK_IMAGE_TILING_OPTIMAL;
        info.usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT;
        vk_check(vkCreateImage(context.device, &info, nullptr, &image), "Create test target");
        VkMemoryRequirements requirements;
        vkGetImageMemoryRequirements(context.device, image, &requirements);
        VkPhysicalDeviceMemoryProperties properties;
        vkGetPhysicalDeviceMemoryProperties(context.physical, &properties);
        std::uint32_t type = UINT32_MAX;
        for (std::uint32_t i = 0; i < properties.memoryTypeCount; ++i)
            if ((requirements.memoryTypeBits & (1u << i)) &&
                (properties.memoryTypes[i].propertyFlags & VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT)) {
                type = i;
                break;
            }
        if (type == UINT32_MAX)
            throw std::runtime_error("No test image memory");
        VkMemoryAllocateInfo allocation{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
        allocation.allocationSize = requirements.size;
        allocation.memoryTypeIndex = type;
        vk_check(vkAllocateMemory(context.device, &allocation, nullptr, &memory), "Allocate test image");
        vk_check(vkBindImageMemory(context.device, image, memory, 0), "Bind test image");
    }
};

std::vector<unsigned char> read_capture(VulkanRenderer& renderer, const std::filesystem::path& output) {
    renderer.capture(0, output);
    std::ifstream file(output, std::ios::binary);
    std::string magic;
    unsigned width, height, maximum;
    file >> magic >> width >> height >> maximum;
    file.get();
    if (magic != "P6" || width != 128 || height != 128 || maximum != 255)
        throw std::runtime_error("Invalid GPU capture");
    std::vector<unsigned char> pixels(128 * 128 * 3);
    file.read(reinterpret_cast<char*>(pixels.data()), pixels.size());
    if (!file)
        throw std::runtime_error("Truncated GPU capture");
    return pixels;
}

std::vector<unsigned char> capture(VulkanRenderer& renderer, const std::filesystem::path& output, const Matrix& camera,
                                   std::span<const Sprite> sprites = {}, std::span<const WakeVertex> wake = {},
                                   std::span<const SprayVertex> sheet = {}, Vec3 eye = {}, float fade = 0,
                                   std::span<const std::uint8_t> flags = {}, std::span<const PropMotion> motions = {},
                                   double alpha = 1, std::span<const PropRouteMotion> routes = {},
                                   std::span<const PropTextureFrame> texture_frames = {},
                                   std::span<const BoostTrailVertex> boost = {},
                                   std::span<const ParticleSprite> particles = {}) {
    auto board = Matrix::identity();
    board.values[12] = 10;
    renderer.render(0, camera, board, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, eye, sprites, wake, sheet, {}, fade,
                    flags, motions, alpha, routes, texture_frames, boost, particles);
    return read_capture(renderer, output);
}

void pixel(const std::vector<unsigned char>& pixels, double u, double v, std::array<int, 3> expected) {
    const auto x = unsigned((.1 + .8 * u) * 128), y = unsigned((.1 + .8 * v) * 128);
    for (unsigned c = 0; c < 3; ++c) {
        ++checks;
        const auto actual = int(pixels[(y * 128 + x) * 3 + c]);
        if (std::abs(actual - expected[c]) > 1)
            throw std::runtime_error("GPU pixel differs at (" + std::to_string(u) + "," + std::to_string(v) +
                                     "), channel " + std::to_string(c) + ": " + std::to_string(actual) + " expected " +
                                     std::to_string(expected[c]));
    }
}

std::array<WakeVertex, 6> ribbon(double z, float alpha = .5f) {
    const WakeVertex a{{-.8, -.8, z}, {0, 0, -1}, 0, 0, alpha}, b{{.8, -.8, z}, {0, 0, -1}, 1, 0, alpha},
        c{{.8, .8, z}, {0, 0, -1}, 1, 2, alpha}, d{{-.8, .8, z}, {0, 0, -1}, 0, 2, alpha};
    return {a, b, c, a, c, d};
}

std::array<BoostTrailVertex, 12> boost_sheet(double z, float alpha = .5f) {
    std::array<BoostTrailVertex, 12> result;
    unsigned i = 0;
    for (const auto x : {-.8, 0.}) {
        const std::array<float, 4> colour{.8f, .2f, 0, alpha};
        const BoostTrailVertex a{{x, -.8, z}, colour}, b{{x + .8, -.8, z}, colour}, c{{x + .8, .8, z}, colour},
            d{{x, .8, z}, colour};
        for (const auto vertex : {a, b, c, a, c, d})
            result[i++] = vertex;
    }
    return result;
}

std::vector<SprayVertex> spray_sheet(double z, float alpha = .5f) {
    std::vector<SprayVertex> result;
    for (unsigned rail = 0; rail < 3; ++rail) {
        const auto lo = float(rail) / 3, hi = float(rail + 1) / 3;
        const SprayVertex a{{-.8, -.8 + 1.6 * lo, z}, 0, lo, alpha}, b{{.8, -.8 + 1.6 * lo, z}, 1, lo, alpha},
            c{{.8, -.8 + 1.6 * hi, z}, 1, hi, alpha}, d{{-.8, -.8 + 1.6 * hi, z}, 0, hi, alpha};
        result.insert(result.end(), {a, b, c, a, c, d});
    }
    return result;
}
} // namespace

int main(int argc, char** argv) {
    try {
        if (argc != 2)
            throw std::runtime_error("Supply authored rendering fixtures");
        const auto root = std::filesystem::path(argv[1]);
        VulkanContext context;
        context.create(false);
        for (const auto samples : {1u, 4u})
            for (const auto name : {"handedness",
                                    "orientation",
                                    "lighting",
                                    "repeat",
                                    "props",
                                    "props_light_range",
                                    "props_light_normals",
                                    "props_light_grazing",
                                    "props_fence",
                                    "props_untextured",
                                    "props_uv",
                                    "props_flag",
                                    "props_crowd",
                                    "props_cutout",
                                    "props_blend",
                                    "props_priority",
                                    "props_layers",
                                    "props_depth_precision",
                                    "minification",
                                    "antialiasing",
                                    "visibility",
                                    "sprites",
                                    "boost",
                                    "boost_fog",
                                    "wake",
                                    "wake_repeat",
                                    "sheet",
                                    "sky",
                                    "sky_foreground",
                                    "sky_authored",
                                    "fog",
                                    "sprites_fog",
                                    "wake_fog",
                                    "sheet_fog",
                                    "props_fog"}) {
                auto scene = std::make_shared<VulkanScene>(context);
                Mesh mesh;
                if (std::string(name) == "antialiasing") {
                    mesh.vertices = {
                        {-.83f, -.73f, .5f, 1, 1, 1}, {.77f, -.61f, .5f, 1, 1, 1}, {-.67f, .81f, .5f, 1, 1, 1}};
                    mesh.indices = {0, 1, 2};
                    mesh.batches = {{0, 3, "", -1}};
                } else if (std::string(name) == "visibility") {
                    std::vector<Patch> patches;
                    for (const auto center : std::array<Vec3, 8>{{{-.6, 0, .5},
                                                                  {.6, 0, .5},
                                                                  {-3, 0, .5},
                                                                  {3, 0, .5},
                                                                  {0, 0, -2},
                                                                  {0, 4, .5},
                                                                  {0, -4, .5},
                                                                  {0, 0, 2}}}) {
                        Patch p;
                        p.texture = patches.size() % 2 ? "missing-b" : "missing-a";
                        for (unsigned u = 0; u < 4; ++u)
                            for (unsigned v = 0; v < 4; ++v)
                                p.points[u * 4 + v] = center + Vec3{u * .8 / 3 - .4, v * .8 / 3 - .4, 0};
                        patches.push_back(p);
                    }
                    mesh = Terrain(std::move(patches)).mesh(4);
                } else
                    mesh = Terrain::load(root / name).mesh(4);
                const std::array<std::size_t, 1> flag_models{{0}};
                scene->upload(mesh, std::string(name) == "props_flag" ? std::span<const std::size_t>(flag_models)
                                                                      : std::span<const std::size_t>{});
                // The same scene is used by two renderers, just like the stereo host.
                Target unorm{context}, srgb{context};
                unorm.create(VK_FORMAT_R8G8B8A8_UNORM);
                srgb.create(VK_FORMAT_R8G8B8A8_SRGB);
                VulkanRenderer first(context), second(context);
                first.use_scene(scene);
                second.use_scene(scene);
                first.targets(std::span(&unorm.image, 1), VK_FORMAT_R8G8B8A8_UNORM, 128, 128, samples);
                second.targets(std::span(&srgb.image, 1), VK_FORMAT_R8G8B8A8_SRGB, 128, 128, samples);
                auto orthographic = Matrix::identity();
                orthographic.values[10] = -1;
                orthographic.values[14] = 1;
                const auto camera = std::string(name) == "handedness" || std::string(name) == "props_depth_precision"
                                        ? projection(-1, 1, -1, 1) * view({0, 0, 0}, {0, 0, -1})
                                        : orthographic;
                if (std::string(name).ends_with("_fog")) {
                    for (auto* renderer : {&first, &second}) {
                        const auto plain = capture(*renderer, root / "effects-fog-plain.ppm", camera);
                        pixel(plain, .5, .5, {200, 40, 20});
                        if (std::string(name) == "props_fog") {
                            pixel(plain, .25, .5, {200, 40, 20});
                            pixel(plain, .75, .5, {200, 40, 20});
                            continue;
                        }
                        const std::array<Sprite, 1> sprites{{{{0, 0, .25}, .2f, .25f, 0}}};
                        const auto wake = ribbon(.25);
                        const auto sheet = spray_sheet(.25);
                        const auto drawn =
                            capture(*renderer, root / "effects-fog-drawn.ppm", camera,
                                    std::string(name) == "sprites_fog" ? std::span<const Sprite>(sprites)
                                                                       : std::span<const Sprite>{},
                                    std::string(name) == "wake_fog" ? std::span<const WakeVertex>(wake)
                                                                    : std::span<const WakeVertex>{},
                                    std::string(name) == "sheet_fog" ? std::span<const SprayVertex>(sheet)
                                                                     : std::span<const SprayVertex>{});
                        ++checks;
                        if (drawn != plain)
                            throw std::runtime_error("Fog injects colour into fully attenuated riding effects");
                    }
                    continue;
                }
                if (std::string(name).starts_with("sky")) {
                    const auto sky_camera = std::string(name) == "sky_foreground"
                                                ? camera
                                                : projection(-1, 1, -1, 1) * view({}, {0, 0, -1});
                    const auto a = capture(first, root / "sky-unorm.ppm", sky_camera),
                               b = capture(second, root / "sky-srgb.ppm", sky_camera);
                    for (const auto* pixels : {&a, &b}) {
                        if (std::string(name) == "sky_foreground") {
                            pixel(*pixels, .5, .5, {40, 80, 120});
                            pixel(*pixels, 1.1, .5, {80, 20, 40});
                        } else {
                            pixel(*pixels, .15, .5, {20, 40, 80});
                            pixel(*pixels, .85, .5, {80, 20, 40});
                            pixel(*pixels, .5, .01,
                                  std::string(name) == "sky_authored" ? std::array<int, 3>{90, 110, 130}
                                                                      : std::array<int, 3>{120, 160, 200});
                        }
                    }
                    if (std::string(name) != "sky_foreground") {
                        for (const auto eye : std::array<Vec3, 3>{{{5, 3, -7}, {-.032, 0, 0}, {.032, 0, 0}}}) {
                            const auto moved = projection(-1, 1, -1, 1) * view(eye, {0, 0, -1});
                            ++checks;
                            if (capture(first, root / "sky-translated.ppm", moved, {}, {}, {}, eye) != a)
                                throw std::runtime_error("Camera or stereo eye translation parallaxes the backdrop");
                        }
                        const auto turned = projection(-1, 1, -1, 1) * view({}, {0, 0, 1});
                        ++checks;
                        if (capture(first, root / "sky-rotated.ppm", turned) == a)
                            throw std::runtime_error("Sky ignores camera orientation");
                    }
                    first.targets(std::span(&unorm.image, 1), VK_FORMAT_R8G8B8A8_UNORM, 128, 128, samples);
                    ++checks;
                    if (capture(first, root / "sky-recreated.ppm", sky_camera) != a)
                        throw std::runtime_error("Sky changed after target recreation");
                    continue;
                }
                if (std::string(name) == "fog") {
                    for (auto* renderer : {&first, &second}) {
                        const auto pixels = capture(*renderer, root / "fog.ppm", camera);
                        pixel(pixels, .5, .5, {120, 60, 70});
                        pixel(pixels, .01, .01, {200, 40, 20});
                        pixel(pixels, 1.1, .5, {23, 61, 127});
                    }
                    first.targets(std::span(&unorm.image, 1), VK_FORMAT_R8G8B8A8_UNORM, 128, 128, samples);
                    pixel(capture(first, root / "fog-recreated.ppm", camera), .5, .5, {120, 60, 70});
                    continue;
                }
                if (std::string(name) == "props_flag") {
                    const auto sample = [&](VulkanRenderer& renderer, const PropTextureFrame& state) {
                        return capture(renderer, root / "flag.ppm", camera, {}, {}, {}, {}, 0, {}, {}, 1, {},
                                       std::span(&state, 1));
                    };
                    const auto plain = capture(first, root / "flag-rest.ppm", camera);
                    PropTextureFrame wave;
                    wave.instance = 0;
                    wave.wave = FlagWave{false, 40, .25};
                    const auto a = sample(first, wave);
                    auto opposite = wave;
                    opposite.wave->opposite = true;
                    const auto b = sample(second, opposite);
                    checks += 2;
                    if (a == plain || b == plain)
                        throw std::runtime_error("Flag ripple does not change geometry");
                    if (first.stats().flag_sections != 8 || first.stats().flag_draws != 1)
                        throw std::runtime_error("Flag does not draw exactly eight sections");
                    // Independent screen-space strip edges: 45-degree source placement,
                    // uniform vertical stations and original 0.6-m cross-edge width.
                    const auto verify = [&](const std::vector<unsigned char>& pixels, bool flipped) {
                        const auto rgb = [&](unsigned x, unsigned y) {
                            return std::array<int, 3>{pixels[(y * 128 + x) * 3], pixels[(y * 128 + x) * 3 + 1],
                                                      pixels[(y * 128 + x) * 3 + 2]};
                        };
                        for (unsigned y = 49; y < 79; ++y) {
                            const auto world_y = 2 * (double(y) + .5) / 128 - 1;
                            const auto station = (.3 - world_y) / .6;
                            const auto at = std::clamp(station * 8, 0., 7.999999), t = at - std::floor(at);
                            const auto edge = [&](double s) {
                                const auto k = flipped ? 1 - s : s;
                                return .4 * k * std::sin(2 * pi * (k - .25)) / std::sqrt(2.);
                            };
                            const auto offset = std::lerp(edge(std::floor(at) / 8), edge((std::floor(at) + 1) / 8), t);
                            for (unsigned x = 5; x < 119; ++x) {
                                const auto world_x = 2 * (double(x) + .5) / 128 - 1;
                                const auto distance = std::abs(world_x - (-.4 + offset)) - .3 / std::sqrt(2.);
                                const auto sibling = std::abs(world_x - .4) - .3 / std::sqrt(2.);
                                if (std::abs(distance) < .025 || std::abs(sibling) < .025)
                                    continue;
                                const bool red = distance < 0 || sibling < 0;
                                const auto value = rgb(x, y);
                                ++checks;
                                if (red ? (value[0] < 220 || value[1] > 40) : (value[0] > 220 && value[1] < 40))
                                    throw std::runtime_error(
                                        "Flag pixels disagree with independently sampled eight-station silhouette");
                            }
                        }
                    };
                    verify(a, false);
                    verify(b, true);
                    auto outside = wave;
                    outside.instance = 2;
                    outside.wave->amplitude = 80;
                    const auto expanded = sample(first, outside);
                    checks += 2;
                    if (expanded == plain || first.stats().flag_sections != 8)
                        throw std::runtime_error("Rest-pose frustum culling clips a flag waving into view");
                    auto zero = wave;
                    zero.wave->amplitude = 0;
                    ++checks;
                    if (sample(first, zero) != plain)
                        throw std::runtime_error("Zero-amplitude flag changes original geometry");
                    first.deferred(true);
                    second.deferred(true);
                    auto board = Matrix::identity();
                    board.values[12] = 10;
                    for (unsigned turn = 0; turn < 4; ++turn) {
                        const auto submit = [&](VulkanRenderer& renderer, const PropTextureFrame& state) {
                            renderer.render(0, camera, board, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, {}, {}, {},
                                            {}, {}, 0, {}, {}, 1, {}, std::span(&state, 1));
                        };
                        if (turn % 2) {
                            submit(second, opposite);
                            submit(first, wave);
                        } else {
                            submit(first, wave);
                            submit(second, opposite);
                        }
                        checks += 2;
                        if (read_capture(first, root / "flag-left.ppm") != a ||
                            read_capture(second, root / "flag-right.ppm") != b)
                            throw std::runtime_error("Queued stereo flag phases overwrite each other");
                    }
                    first.deferred(false);
                    second.deferred(false);
                    for (unsigned invalid = 0; invalid < 3; ++invalid) {
                        auto bad = wave;
                        if (invalid == 0)
                            bad.wave->phase = std::numeric_limits<double>::quiet_NaN();
                        else if (invalid == 1)
                            bad.wave->phase = 2;
                        else
                            bad.wave->amplitude = std::numeric_limits<double>::infinity();
                        bool refused = false;
                        try {
                            sample(first, bad);
                        } catch (const std::invalid_argument&) {
                            refused = true;
                        }
                        checks += 2;
                        if (!refused || capture(first, root / "flag-recovered.ppm", camera) != plain)
                            throw std::runtime_error("Invalid flag state damages later frame");
                    }
                    continue;
                }
                if (std::string(name) == "boost" || std::string(name) == "boost_fog") {
                    const auto sample = [&](VulkanRenderer& renderer, std::span<const BoostTrailVertex> trail,
                                            float fade = 0) {
                        return capture(renderer, root / "boost.ppm", camera, {}, {}, {}, {}, fade, {}, {}, 1, {}, {},
                                       trail);
                    };
                    const auto front = boost_sheet(.25), behind = boost_sheet(.75);
                    const auto plain = sample(first, {});
                    if (std::string(name) == "boost_fog") {
                        ++checks;
                        if (sample(first, front) != plain)
                            throw std::runtime_error("Fog adds colour instead of fading additive boost geometry");
                        continue;
                    }
                    ++checks;
                    if (sample(first, behind) != plain)
                        throw std::runtime_error("Boost trail ignores opaque scene depth");
                    const auto red = sample(first, front);
                    pixel(red, .5, .5, {142, 106, 120});
                    ++checks;
                    if (first.stats().boost_segments != 1 || first.stats().boost_draws != 1)
                        throw std::runtime_error("Boost sheets are not one bounded batch");
                    const auto encoded = sample(second, front);
                    pixel(encoded, .5, .5, {154, 88, 120});
                    pixel(sample(first, front, .5f), .5, .5, {71, 53, 60});
                    ++checks;
                    if (sample(first, boost_sheet(.25, 0)) != plain)
                        throw std::runtime_error("Transparent boost geometry changed pixels");
                    std::vector<BoostTrailVertex> stacked(front.begin(), front.end());
                    const auto farther = boost_sheet(.35);
                    stacked.insert(stacked.end(), farther.begin(), farther.end());
                    pixel(sample(first, stacked), .5, .5, {244, 131, 120});
                    auto gradient = front;
                    for (auto& point : gradient) {
                        const auto weight = float((point.position.y + .8) / 1.6);
                        for (unsigned c = 0; c < 3; ++c)
                            point.colour[c] *= weight;
                    }
                    pixel(sample(first, gradient), .5, .125, {53, 83, 120});
                    pixel(sample(first, gradient), .5, .875, {129, 102, 120});
                    auto green = front;
                    for (auto& point : green)
                        point.colour = {.1f, .8f, .1f, .5f};
                    const auto green_reference = sample(second, green);
                    first.deferred(true);
                    second.deferred(true);
                    auto board = Matrix::identity();
                    board.values[12] = 10;
                    for (unsigned frame = 0; frame < 4; ++frame) {
                        first.render(0, camera, board, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, {}, {}, {}, {}, {},
                                     0, {}, {}, 1, {}, {}, front);
                        second.render(0, camera, board, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, {}, {}, {}, {},
                                      {}, 0, {}, {}, 1, {}, {}, green);
                        checks += 2;
                        if (read_capture(first, root / "boost-left.ppm") != red ||
                            read_capture(second, root / "boost-right.ppm") != green_reference)
                            throw std::runtime_error("Queued stereo renderers share mutable boost geometry");
                    }
                    first.deferred(false);
                    second.deferred(false);
                    for (unsigned bad_case = 0; bad_case < 3; ++bad_case) {
                        auto bad = front;
                        std::span<const BoostTrailVertex> view = bad;
                        if (bad_case == 0)
                            bad[0].colour[0] = std::numeric_limits<float>::quiet_NaN();
                        else if (bad_case == 1)
                            bad[0].colour[3] = 2;
                        else
                            view = view.first(11);
                        bool rejected = false;
                        try {
                            sample(first, view);
                        } catch (const std::invalid_argument&) {
                            rejected = true;
                        }
                        checks += 2;
                        if (!rejected || sample(first, {}) != plain)
                            throw std::runtime_error("Invalid boost submission corrupts the next frame");
                    }
                    first.targets(std::span(&unorm.image, 1), VK_FORMAT_R8G8B8A8_UNORM, 128, 128, samples);
                    pixel(sample(first, front), .5, .5, {142, 106, 120});
                    ++checks;
                    if (sample(first, {}) != plain)
                        throw std::runtime_error("Boost trail retained stale geometry after clear");
                    continue;
                }
                if (std::string(name) == "sheet") {
                    const auto plain = capture(first, root / "sheet-plain.ppm", camera);
                    const auto front = spray_sheet(.25), behind = spray_sheet(.75);
                    const auto drawn = capture(first, root / "sheet-drawn.ppm", camera, {}, {}, front);
                    ++checks;
                    if (capture(first, root / "sheet-overlay.ppm", camera, {}, {}, behind) != drawn)
                        throw std::runtime_error("Spray sheet does not retain the public always-pass depth profile");
                    ++checks;
                    if (capture(second, root / "sheet-srgb-overlay.ppm", camera, {}, {}, behind) !=
                        capture(second, root / "sheet-srgb-front.ppm", camera, {}, {}, front))
                        throw std::runtime_error("sRGB spray sheet is incorrectly occluded by scene depth");
                    pixel(drawn, .5, .5, {104, 144, 184});
                    ++checks;
                    if (first.stats().sheet_segments != 1 || first.stats().sheet_draws != 1)
                        throw std::runtime_error("Four-rail sheet did not draw as one three-band ribbon");
                    auto stacked = front;
                    const auto back = spray_sheet(.35);
                    stacked.insert(stacked.end(), back.begin(), back.end());
                    pixel(capture(first, root / "sheet-stacked.ppm", camera, {}, {}, stacked), .5, .5, {168, 208, 248});
                    auto gradient = spray_sheet(.25);
                    for (auto& p : gradient)
                        p.alpha = p.v;
                    const auto fade = capture(first, root / "sheet-gradient.ppm", camera, {}, {}, gradient);
                    pixel(fade, .5, .125, {56, 96, 136});
                    pixel(fade, .5, .875, {152, 192, 232});
                    pixel(capture(second, root / "sheet-srgb.ppm", camera, {}, {}, front), .5, .5, {142, 156, 177});
                    first.targets(std::span(&unorm.image, 1), VK_FORMAT_R8G8B8A8_UNORM, 128, 128, samples);
                    pixel(capture(first, root / "sheet-recreated.ppm", camera, {}, {}, front), .5, .5, {104, 144, 184});
                    ++checks;
                    if (capture(first, root / "sheet-cleared.ppm", camera) != plain)
                        throw std::runtime_error("Spray sheet leaves stale geometry");
                    continue;
                }
                if (std::string(name) == "wake" || std::string(name) == "wake_repeat") {
                    const auto plain = capture(first, root / "wake-plain.ppm", camera);
                    const auto front = ribbon(.25), behind = ribbon(.75);
                    const auto hidden = capture(first, root / "wake-hidden.ppm", camera, {}, behind);
                    ++checks;
                    if (plain != hidden)
                        throw std::runtime_error("Wake ignores scene depth");
                    const auto drawn = capture(first, root / "wake-drawn.ppm", camera, {}, front);
                    ++checks;
                    if (first.stats().wake_segments != 1 || first.stats().wake_draws != 2)
                        throw std::runtime_error("Wake did not submit both alpha passes");
                    if (std::string(name) == "wake") {
                        pixel(drawn, .5, .5, {110, 89, 89});
                        const auto further = ribbon(.35);
                        std::vector<WakeVertex> stacked(front.begin(), front.end());
                        stacked.insert(stacked.end(), further.begin(), further.end());
                        pixel(capture(first, root / "wake-stacked.ppm", camera, {}, stacked), .5, .5, {150, 94, 72});
                        const auto transparent = ribbon(.25, 0);
                        ++checks;
                        if (capture(first, root / "wake-zero.ppm", camera, {}, transparent) != plain)
                            throw std::runtime_error("Zero-alpha wake changed scene pixels");
                        const auto fade = capture(first, root / "wake-fade.ppm", camera, {}, ribbon(.25, .25f));
                        pixel(fade, .5, .5, {78, 85, 104});
                        auto gradient = ribbon(.25);
                        for (auto& v : gradient)
                            v.alpha = v.along * .5f;
                        const auto tapered = capture(first, root / "wake-taper.ppm", camera, {}, gradient);
                        pixel(tapered, .5, .125, {59, 82, 112});
                        pixel(tapered, .5, .875, {149, 94, 72});
                        const auto encoded = capture(second, root / "wake-srgb.ppm", camera, {}, front);
                        pixel(encoded, .5, .5, {141, 89, 97});
                        first.targets(std::span(&unorm.image, 1), VK_FORMAT_R8G8B8A8_UNORM, 128, 128, samples);
                        pixel(capture(first, root / "wake-recreated.ppm", camera, {}, front), .5, .5, {110, 89, 89});
                    } else {
                        for (const auto u : {.125, .875})
                            for (const auto v : {.125, .625})
                                pixel(drawn, u, v, {120, 140, 160});
                        for (const auto v : {.125, .375, .625, .875})
                            pixel(drawn, .5, v, {40, 80, 120});
                        for (const auto u : {.125, .875})
                            for (const auto v : {.375, .875})
                                pixel(drawn, u, v, {40, 80, 120});
                    }
                    ++checks;
                    if (capture(first, root / "wake-cleared.ppm", camera) != plain)
                        throw std::runtime_error("Wake pass retained stale geometry");
                    continue;
                }
                if (std::string(name) == "sprites") {
                    const std::array<Sprite, 1> front{{{{0, 0, .25}, .2f, .25f, 0}}},
                        behind{{{{0, 0, .75}, .2f, .25f, 0}}};
                    const auto plain = capture(first, root / "sprite-plain.ppm", camera),
                               hidden = capture(first, root / "sprite-hidden.ppm", camera, behind);
                    ++checks;
                    if (plain != hidden)
                        throw std::runtime_error("Sprite depth test failed");
                    const auto additive = capture(first, root / "sprite-add.ppm", camera, front);
                    pixel(additive, .5, .5, {104, 144, 184});
                    ++checks;
                    if (first.stats().sprites != 1)
                        throw std::runtime_error("Sprite draw was not submitted");
                    const std::array<Sprite, 2> stacked{{front[0], {{0, 0, .35}, .2f, .25f, 0}}};
                    pixel(capture(first, root / "sprite-stack.ppm", camera, stacked), .5, .5, {168, 208, 248});
                    const auto cleared = capture(first, root / "sprite-cleared.ppm", camera);
                    ++checks;
                    if (cleared != plain)
                        throw std::runtime_error("Sprite pass left stale geometry");
                    const auto encoded = capture(second, root / "sprite-srgb.ppm", camera, front);
                    pixel(encoded, .5, .5, {142, 156, 177});
                    continue;
                }
                const auto a = capture(first, root / (std::string(name) + "-unorm.ppm"), camera),
                           b = capture(second, root / (std::string(name) + "-srgb.ppm"), camera);
                const auto visibility = first.stats();
                first.cull_terrain(false);
                second.cull_terrain(false);
                const auto baseline_a = capture(first, root / "baseline-unorm.ppm", camera),
                           baseline_b = capture(second, root / "baseline-srgb.ppm", camera);
                checks += 2;
                if (a != baseline_a || b != baseline_b)
                    throw std::runtime_error("Culled pixels differ from complete terrain submission");
                first.cull_terrain(true);
                second.cull_terrain(true);
                if (std::string(name) == "props_fence") {
                    auto reaction = WorldLogic::load(root / name);
                    reaction.contact(0, 12, true, 1, {1, 0, 0});
                    reaction.tick(1. / 18);
                    for (auto* renderer : {&first, &second}) {
                        const auto moved = capture(*renderer, root / "fence-hit.ppm", camera, {}, {}, {}, {}, 0, {},
                                                   reaction.motions());
                        pixel(moved, .14, .5, {40, 80, 120});
                        pixel(moved, .4, .5, {200, 160, 120});
                        pixel(moved, .75, .5, {200, 160, 120});
                        const auto original = renderer == &first ? a : b;
                        const auto before = capture(*renderer, root / "fence-before.ppm", camera, {}, {}, {}, {}, 0, {},
                                                    reaction.motions(), 0);
                        ++checks;
                        if (before != original)
                            throw std::runtime_error("Fence interpolation does not begin at its prior pose");
                        const auto midway = capture(*renderer, root / "fence-interpolated.ppm", camera, {}, {}, {}, {},
                                                    0, {}, reaction.motions(), .5);
                        ++checks;
                        if (midway == before || midway == moved)
                            throw std::runtime_error("Fence interpolation jumps between fixed ticks");
                    }
                    for (unsigned tick = 0; tick < 96; ++tick)
                        reaction.tick(1. / 60);
                    checks += 3;
                    if (!reaction.motions().empty() ||
                        capture(first, root / "fence-restored.ppm", camera, {}, {}, {}, {}, 0, {},
                                reaction.motions()) != a ||
                        capture(second, root / "fence-restored-srgb.ppm", camera, {}, {}, {}, {}, 0, {},
                                reaction.motions()) != b)
                        throw std::runtime_error("Fence reaction does not restore exact resting pixels");
                    continue;
                }
                if (std::string(name) == "props_crowd") {
                    const PropTextureFrame left{0, PropTextureFrame::resting, {}, {{0, 3}}, true},
                        right{1, PropTextureFrame::resting, {}, {{0, 9}}, true};
                    const auto sampled = [&](VulkanRenderer& renderer, const PropTextureFrame& state) {
                        return capture(renderer, root / "crowd-page.ppm", camera, {}, {}, {}, {}, 0, {}, {}, 1, {},
                                       std::span(&state, 1));
                    };
                    const auto left_pixels = sampled(first, left), right_pixels = sampled(second, right);
                    pixel(left_pixels, .1875, .45, {40, 80, 120});
                    pixel(left_pixels, .3125, .45, {50, 55, 182});
                    pixel(left_pixels, .6875, .45, {20, 40, 240});
                    pixel(right_pixels, .6875, .45, {40, 80, 120});
                    pixel(right_pixels, .8125, .45, {110, 85, 146});
                    pixel(right_pixels, .1875, .45, {20, 40, 240});
                    first.deferred(true);
                    second.deferred(true);
                    auto board = Matrix::identity();
                    board.values[12] = 10;
                    for (unsigned frame = 0; frame < 4; ++frame) {
                        const auto submit = [&](VulkanRenderer& renderer, const PropTextureFrame& state) {
                            renderer.render(0, camera, board, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, {}, {}, {},
                                            {}, {}, 0, {}, {}, 1, {}, std::span(&state, 1));
                        };
                        if (frame % 2) {
                            submit(second, right);
                            submit(first, left);
                        } else {
                            submit(first, left);
                            submit(second, right);
                        }
                        checks += 2;
                        if (read_capture(first, root / "crowd-first.ppm") != left_pixels ||
                            read_capture(second, root / "crowd-second.ppm") != right_pixels)
                            throw std::runtime_error("Queued crowd pages overwrite another eye's placement state");
                    }
                    first.deferred(false);
                    second.deferred(false);
                    auto invalid = left;
                    invalid.materials[0].frame = 16;
                    bool refused = false;
                    try {
                        sampled(first, invalid);
                    } catch (const std::invalid_argument&) {
                        refused = true;
                    }
                    ++checks;
                    if (!refused)
                        throw std::runtime_error("Out-of-bank crowd frame was accepted");
                    ++checks;
                    if (capture(first, root / "crowd-restored.ppm", camera) != a)
                        throw std::runtime_error("Crowd override survives teardown or invalid input");
                    continue;
                }
                if (std::string(name) == "props_uv") {
                    const PropTextureFrame horizontal{0, PropTextureFrame::resting, {.5, 0}},
                        vertical{0, PropTextureFrame::resting, {0, .5}};
                    const auto sample = [&](VulkanRenderer& renderer, const PropTextureFrame& state,
                                            std::span<const PropMotion> motions = std::span<const PropMotion>{}) {
                        return capture(renderer, root / "uv-phase.ppm", camera, {}, {}, {}, {}, 0, {}, motions, 1, {},
                                       std::span(&state, 1));
                    };
                    const auto colour_at = [&](const auto& pixels, double u, double v) {
                        const auto p = (unsigned((.1 + .8 * v) * 128) * 128 + unsigned((.1 + .8 * u) * 128)) * 3;
                        return std::array<int, 3>{pixels[p], pixels[p + 1], pixels[p + 2]};
                    };
                    pixel(a, .1875, .4125, {20, 40, 240});
                    pixel(a, .3125, .4125, {240, 190, 10});
                    pixel(a, .1875, .5875, {240, 20, 40});
                    pixel(a, .3125, .5875, {20, 220, 40});
                    const auto shifted_u = sample(first, horizontal), shifted_v = sample(second, vertical);
                    for (const auto v : {.4125, .5875}) {
                        pixel(shifted_u, .1875, v, colour_at(a, .3125, v));
                        pixel(shifted_u, .3125, v, colour_at(a, .1875, v));
                        pixel(shifted_u, .6875, v, colour_at(a, .6875, v));
                        pixel(shifted_u, .8125, v, colour_at(a, .8125, v));
                    }
                    for (const auto u : {.1875, .3125}) {
                        pixel(shifted_v, u, .4125, colour_at(b, u, .5875));
                        pixel(shifted_v, u, .5875, colour_at(b, u, .4125));
                    }
                    const PropTextureFrame native_v{0, PropTextureFrame::resting, {0, .25}};
                    const auto signed_v = sample(first, native_v);
                    pixel(signed_v, .1875, .45, {20, 40, 240});
                    pixel(signed_v, .3125, .45, {240, 190, 10});
                    const PropTextureFrame reverse_v{0, PropTextureFrame::resting, {0, -.25}};
                    const auto signed_reverse_v = sample(second, reverse_v);
                    pixel(signed_reverse_v, .1875, .45, {240, 20, 40});
                    pixel(signed_reverse_v, .3125, .45, {20, 220, 40});
                    const auto identity = identity_transform();
                    const PropMotion held{0, {identity}, {identity}};
                    ++checks;
                    if (sample(first, horizontal, std::span(&held, 1)) != shifted_u)
                        throw std::runtime_error("Model pose composition drops private UV phase");
                    const PropTextureFrame selected{0, PropTextureFrame::resting, {}, {{0, 1}}};
                    const auto picked = sample(first, selected);
                    pixel(picked, .1875, .4125, {80, 120, 200});
                    pixel(picked, .8125, .5875, colour_at(a, .8125, .5875));
                    first.deferred(true);
                    second.deferred(true);
                    auto board = Matrix::identity();
                    board.values[12] = 10;
                    for (unsigned turn = 0; turn < 4; ++turn) {
                        const auto submit = [&](VulkanRenderer& renderer, const PropTextureFrame& state) {
                            renderer.render(0, camera, board, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, {}, {}, {},
                                            {}, {}, 0, {}, {}, 1, {}, std::span(&state, 1));
                        };
                        if (turn % 2) {
                            submit(second, vertical);
                            submit(first, horizontal);
                        } else {
                            submit(first, horizontal);
                            submit(second, vertical);
                        }
                        checks += 2;
                        if (read_capture(first, root / "uv-first.ppm") != shifted_u ||
                            read_capture(second, root / "uv-second.ppm") != shifted_v)
                            throw std::runtime_error("Queued eyes overwrite private UV offsets");
                    }
                    first.deferred(false);
                    second.deferred(false);
                    for (unsigned failure = 0; failure < 3; ++failure) {
                        auto invalid = horizontal;
                        if (failure == 0)
                            invalid.uv[0] = std::numeric_limits<double>::infinity();
                        if (failure == 1)
                            invalid.materials = {{999, 0}};
                        if (failure == 2)
                            invalid.materials = {{0, 0}, {0, 1}};
                        bool refused = false;
                        try {
                            sample(first, invalid);
                        } catch (const std::invalid_argument&) {
                            refused = true;
                        }
                        ++checks;
                        if (!refused)
                            throw std::runtime_error("Invalid UV/material submission was accepted");
                        ++checks;
                        if (capture(first, root / "uv-invalid-restored.ppm", camera) != a)
                            throw std::runtime_error("Invalid UV/material submission corrupts the next frame");
                    }
                    continue;
                }
                if (std::string(name) == "props_cutout")
                    for (auto* renderer : {&first, &second}) {
                        const std::array<PropTextureFrame, 1> state{{{0, 1}}};
                        const auto swapped = capture(*renderer, root / "private-alpha.ppm", camera, {}, {}, {}, {}, 0,
                                                     {}, {}, 1, {}, state);
                        pixel(swapped, .5, .5,
                              renderer == &first ? std::array<int, 3>{140, 90, 80} : std::array<int, 3>{178, 91, 91});
                        const auto restored = capture(*renderer, root / "private-alpha-restored.ppm", camera);
                        pixel(restored, .40625, .5, {40, 80, 120});
                        pixel(restored, .59375, .5, {240, 100, 40});
                    }
                if (std::string(name) == "props") {
                    auto shifted = camera;
                    shifted.values[12] = -1.2f;
                    const auto shifted_b = capture(second, root / "queued-reference.ppm", shifted);
                    ++checks;
                    if (second.stats().visible_props != 1 || shifted_b == b)
                        throw std::runtime_error("Stereo fixture must compact different placements for each eye");
                    first.deferred(true);
                    second.deferred(true);
                    auto board = Matrix::identity();
                    board.values[12] = 10;
                    for (unsigned frame = 0; frame < 4; ++frame) {
                        const auto submit_first = [&] {
                            first.render(0, camera, board, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL);
                        };
                        const auto submit_second = [&] {
                            second.render(0, shifted, board, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL);
                        };
                        if (frame % 2) {
                            submit_second();
                            submit_first();
                        } else {
                            submit_first();
                            submit_second();
                        }
                        if (frame == 2)
                            submit_first();
                        if (frame == 3)
                            submit_second();
                        checks += 2;
                        if (read_capture(first, root / "queued-first.ppm") != a ||
                            read_capture(second, root / "queued-second.ppm") != shifted_b)
                            throw std::runtime_error(
                                "Queued stereo views overwrite each other's placements or buffers");
                    }
                    first.deferred(false);
                    second.deferred(false);
                    capture(first, root / "restored-first.ppm", camera);
                    capture(second, root / "restored-second.ppm", camera);
                }
                if (std::string(name) == "orientation")
                    for (auto* renderer : {&first, &second}) {
                        const auto faded = capture(*renderer, root / "half-fade.ppm", camera, {}, {}, {}, {}, .5f);
                        pixel(faded, .15, .15, {120, 10, 20});
                        pixel(faded, .85, .15, {20, 30, 115});
                        const auto black = capture(*renderer, root / "opaque-fade.ppm", camera, {}, {}, {}, {}, 1);
                        ++checks;
                        if (std::any_of(black.begin(), black.end(), [](auto value) { return value != 0; }))
                            throw std::runtime_error("Opaque course fade leaves scene or clear pixels visible");
                    }
                if (std::string(name) == "visibility") {
                    ++checks;
                    if (visibility.visible_terrain != 2 || visibility.terrain_patches != 8 ||
                        visibility.terrain_indices * 4 != visibility.terrain_total_indices ||
                        visibility.terrain_draws != 2)
                        throw std::runtime_error("Terrain compaction did not retain two visible material groups");
                    auto empty = camera;
                    empty.values[12] = 100;
                    const auto culled = capture(first, root / "empty-cull.ppm", empty);
                    ++checks;
                    if (first.stats().terrain_indices || first.stats().terrain_draws)
                        throw std::runtime_error("Empty view still submitted terrain");
                    first.cull_terrain(false);
                    const auto complete = capture(first, root / "empty-full.ppm", empty);
                    ++checks;
                    if (culled != complete)
                        throw std::runtime_error("Empty view lost visible pixels");
                    continue;
                }
                if (std::string(name) == "antialiasing") {
                    for (const auto* pixels : {&a, &b}) {
                        std::size_t partial = 0;
                        for (std::size_t p = 0; p < pixels->size(); p += 3)
                            if ((*pixels)[p] > 90 && (*pixels)[p] < 240)
                                ++partial;
                        ++checks;
                        if ((first.samples() > 1) != (partial > 0))
                            throw std::runtime_error("MSAA resolve did not produce expected geometric edge coverage");
                    }
                    first.targets(std::span(&unorm.image, 1), VK_FORMAT_R8G8B8A8_UNORM, 128, 128, 1);
                    capture(first, root / "aa-recreated.ppm", camera);
                    continue;
                }
                if (std::string(name) == "props") {
                    auto identity = identity_transform(), translated = identity;
                    translated[12] = .6;
                    PropMotion motion{0, {identity}, {translated}};
                    const auto sample = [&](VulkanRenderer& renderer, const PropMotion& pose, double alpha) {
                        return capture(renderer, root / "moving-prop.ppm", camera, {}, {}, {}, {}, 0, {},
                                       std::span(&pose, 1), alpha);
                    };
                    ++checks;
                    if (sample(first, motion, 0) != a)
                        throw std::runtime_error("Animation alpha zero changes the previous pose");
                    auto half = identity;
                    half[12] = .3;
                    const PropMotion halfway{0, {half}, {half}};
                    ++checks;
                    if (sample(first, motion, .5) != sample(first, halfway, 1))
                        throw std::runtime_error("Interpolated translation differs from its sampled midpoint");
                    const auto moved = sample(first, motion, 1);
                    ++checks;
                    if (moved == a)
                        throw std::runtime_error("Current animated placement does not move pixels");
                    pixel(moved, .75, .5, {200, 160, 60});
                    auto opposite = identity;
                    opposite[12] = -.6;
                    const PropMotion other{0, {identity}, {opposite}};
                    const auto second_moved = sample(second, other, 1);
                    first.deferred(true);
                    second.deferred(true);
                    auto board = Matrix::identity();
                    board.values[12] = 10;
                    for (unsigned frame = 0; frame < 4; ++frame) {
                        const auto submit = [&](VulkanRenderer& renderer, const PropMotion& pose) {
                            renderer.render(0, camera, board, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, {}, {}, {},
                                            {}, {}, 0, {}, std::span(&pose, 1), 1);
                        };
                        if (frame % 2) {
                            submit(second, other);
                            submit(first, motion);
                        } else {
                            submit(first, motion);
                            submit(second, other);
                        }
                        checks += 2;
                        if (read_capture(first, root / "moving-first.ppm") != moved ||
                            read_capture(second, root / "moving-second.ppm") != second_moved)
                            throw std::runtime_error("Queued eye renderers overwrite animated placements");
                    }
                    first.deferred(false);
                    second.deferred(false);
                    for (const auto failure : {0u, 1u, 2u}) {
                        bool refused = false;
                        try {
                            auto bad = motion;
                            if (failure == 0)
                                bad.current.clear();
                            if (failure == 1)
                                bad.current[0][0] = 0;
                            sample(first, bad, failure == 2 ? 1.1 : 1);
                        } catch (const std::invalid_argument&) {
                            refused = true;
                        } catch (const std::runtime_error&) {
                            refused = true;
                        }
                        ++checks;
                        if (!refused)
                            throw std::runtime_error("Malformed animation was accepted");
                        ++checks;
                        if (capture(first, root / "motion-after-invalid.ppm", camera) != a)
                            throw std::runtime_error("Invalid animation corrupts the next frame");
                    }
                    capture(second, root / "motion-restored-second.ppm", camera);
                    auto left = identity, right = identity;
                    left[12] = -.3;
                    right[12] = .3;
                    const PropRouteMotion copies{0, {left, identity, right}, {left, identity, right}, {}};
                    const PropRouteMotion fewer{0, {identity, right}, {identity, right}, {}};
                    const auto route_sample = [&](VulkanRenderer& renderer, const PropRouteMotion& route) {
                        return capture(renderer, root / "route-copies.ppm", camera, {}, {}, {}, {}, 0, {}, {}, 1,
                                       std::span(&route, 1));
                    };
                    const auto many = route_sample(first, copies), few = route_sample(second, fewer);
                    checks += 2;
                    if (first.stats().route_copies != 3 || second.stats().route_copies != 2)
                        throw std::runtime_error("Detached copies do not expand renderer-local capacity");
                    first.deferred(true);
                    second.deferred(true);
                    for (unsigned frame = 0; frame < 4; ++frame) {
                        const auto submit = [&](VulkanRenderer& renderer, const PropRouteMotion& route) {
                            renderer.render(0, camera, board, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, {}, {}, {},
                                            {}, {}, 0, {}, {}, 1, std::span(&route, 1));
                        };
                        if (frame % 2) {
                            submit(second, fewer);
                            submit(first, copies);
                        } else {
                            submit(first, copies);
                            submit(second, fewer);
                        }
                        checks += 2;
                        if (read_capture(first, root / "copies-first.ppm") != many ||
                            read_capture(second, root / "copies-second.ppm") != few)
                            throw std::runtime_error("Queued eye renderers share detached copy placements");
                    }
                    first.deferred(false);
                    second.deferred(false);
                    for (const auto failure : {0u, 1u, 2u}) {
                        auto bad = copies;
                        if (failure == 0)
                            bad.previous.clear();
                        if (failure == 1)
                            bad.current[0][0] = 0;
                        if (failure == 2) {
                            RouteLine line{};
                            line.colour = {2, 0, 0, 1};
                            bad.lines.push_back(line);
                        }
                        bool refused = false;
                        try {
                            route_sample(first, bad);
                        } catch (const std::exception&) {
                            refused = true;
                        }
                        ++checks;
                        if (!refused)
                            throw std::runtime_error("Malformed detached copy submission was accepted");
                        ++checks;
                        if (capture(first, root / "copy-after-invalid.ppm", camera) != a)
                            throw std::runtime_error("Invalid route copy corrupts the next frame");
                    }
                    capture(second, root / "copies-restored-second.ppm", camera);
                    const PropTextureFrame frame_first{0, 1}, frame_second{1, 1}, frame_zero{0, 0};
                    const auto framed = [&](VulkanRenderer& renderer, const PropTextureFrame& frame) {
                        return capture(renderer, root / "private-material.ppm", camera, {}, {}, {}, {}, 0, {}, {}, 1,
                                       {}, std::span(&frame, 1));
                    };
                    const auto private_a = framed(first, frame_first), private_b = framed(second, frame_second);
                    pixel(private_a, .25, .5, {60, 60, 50});
                    pixel(private_a, .75, .5, {200, 160, 60});
                    pixel(private_b, .25, .5, {150, 80, 30});
                    pixel(private_b, .75, .5, {80, 120, 100});
                    ++checks;
                    if (framed(first, frame_zero) != a)
                        throw std::runtime_error("Explicit material frame zero differs from base image");
                    first.deferred(true);
                    second.deferred(true);
                    for (unsigned turn = 0; turn < 4; ++turn) {
                        const auto submit = [&](VulkanRenderer& renderer, const PropTextureFrame& frame) {
                            renderer.render(0, camera, board, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, {}, {}, {}, {}, {},
                                            {}, {}, 0, {}, {}, 1, {}, std::span(&frame, 1));
                        };
                        if (turn % 2) {
                            submit(second, frame_second);
                            submit(first, frame_first);
                        } else {
                            submit(first, frame_first);
                            submit(second, frame_second);
                        }
                        checks += 2;
                        if (read_capture(first, root / "private-first.ppm") != private_a ||
                            read_capture(second, root / "private-second.ppm") != private_b)
                            throw std::runtime_error("Queued stereo views overwrite private material frame selection");
                    }
                    first.deferred(false);
                    second.deferred(false);
                    for (const auto invalid : std::array<PropTextureFrame, 2>{{{99, 1}, {0, 4096}}}) {
                        bool refused = false;
                        try {
                            framed(first, invalid);
                        } catch (const std::invalid_argument&) {
                            refused = true;
                        }
                        ++checks;
                        if (!refused)
                            throw std::runtime_error("Invalid material frame binding was accepted");
                    }
                    ++checks;
                    if (capture(first, root / "private-restored.ppm", camera) != a)
                        throw std::runtime_error("Private material frame leaks into later draws");
                    capture(second, root / "private-restored-second.ppm", camera);
                }
                if (std::string(name) == "props")
                    for (auto* renderer : {&first, &second}) {
                        const std::array<std::uint8_t, 5> hidden{};
                        const auto pixels =
                            capture(*renderer, root / "runtime-hidden.ppm", camera, {}, {}, {}, {}, 0, hidden);
                        pixel(pixels, .25, .5, {40, 80, 120});
                        pixel(pixels, .75, .5, {40, 80, 120});
                        ++checks;
                        if (renderer->stats().visible_props || renderer->stats().prop_draws)
                            throw std::runtime_error("Tombstoned props still draw");
                        bool refused = false;
                        try {
                            const std::array<std::uint8_t, 1> bad{};
                            capture(*renderer, root / "bad-flags.ppm", camera, {}, {}, {}, {}, 0, bad);
                        } catch (const std::invalid_argument&) {
                            refused = true;
                        }
                        ++checks;
                        if (!refused)
                            throw std::runtime_error("Short runtime flags were accepted");
                        capture(*renderer, root / "runtime-restored.ppm", camera);
                    }
                for (const auto* pixels : {&a, &b}) {
                    if (std::string(name) == "minification") {
                        for (const auto u : {.15, .35, .5, .65, .85})
                            for (const auto v : {.15, .35, .5, .65, .85})
                                pixel(*pixels, u, v, {128, 128, 128});
                    } else if (std::string(name) == "handedness") {
                        pixel(*pixels, .15, .15, {240, 20, 40});
                        pixel(*pixels, .85, .15, {30, 220, 50});
                        pixel(*pixels, .15, .85, {40, 60, 230});
                        pixel(*pixels, .85, .85, {230, 210, 190});
                    } else if (std::string(name) == "orientation") {
                        pixel(*pixels, .15, .15, {240, 20, 40});
                        pixel(*pixels, .85, .15, {40, 60, 230});
                        pixel(*pixels, .15, .85, {30, 220, 50});
                        pixel(*pixels, .85, .85, {230, 210, 190});
                    } else if (std::string(name) == "lighting") {
                        pixel(*pixels, .15, .15, {90, 70, 50});
                        pixel(*pixels, .85, .15, {113, 60, 0});
                        pixel(*pixels, .15, .85, {100, 170, 130});
                        pixel(*pixels, .85, .85, {50, 45, 40});
                        pixel(*pixels, .01, .01, {90, 70, 50});
                        pixel(*pixels, .99, .01, {113, 60, 0});
                        pixel(*pixels, .01, .99, {100, 170, 130});
                        pixel(*pixels, .99, .99, {50, 45, 40});
                    } else if (std::string(name) == "repeat") {
                        pixel(*pixels, .1, .1, {240, 20, 40});
                        pixel(*pixels, .35, .1, {40, 60, 230});
                        pixel(*pixels, .1, .35, {30, 220, 50});
                        pixel(*pixels, .35, .35, {230, 210, 190});
                        pixel(*pixels, .6, .6, {240, 20, 40});
                    } else if (std::string(name) == "props_light_range" || std::string(name) == "props_untextured") {
                        const auto base = std::string(name) == "props_untextured" ? std::array<int, 3>{194, 187, 170}
                                                                                  : std::array<int, 3>{200, 160, 120};
                        for (unsigned i = 0; i < 5; ++i) {
                            const auto factor = i == 0 ? .25 : i == 1 ? .5 : 1.;
                            pixel(*pixels, .1 + .2 * i, .5,
                                  {int(std::round(base[0] * factor)), int(std::round(base[1] * factor)),
                                   int(std::round(base[2] * factor))});
                        }
                    } else if (std::string(name) == "props_light_grazing") {
                        for (const auto u : {.1, .3, .5, .7, .9})
                            for (const auto v : {.2, .5, .8})
                                pixel(*pixels, u, v, {75, 60, 45});
                    } else if (std::string(name) == "props_light_normals") {
                        for (const auto u : {.05, .2, .4, .48})
                            for (const auto v : {.2, .5, .8})
                                pixel(*pixels, u, v, {0, 0, 0});
                        for (const auto u : {.52, .6, .8, .95})
                            for (const auto v : {.2, .5, .8})
                                pixel(*pixels, u, v, {200, 160, 120});
                    } else if (std::string(name) == "props") {
                        pixel(*pixels, .25, .5, {150, 80, 30});
                        pixel(*pixels, .75, .5, {200, 160, 60});
                        pixel(*pixels, .5, .5, {40, 80, 120});
                        if (first.stats().visible_props != 2 || first.stats().prop_draws != 1 ||
                            second.stats().prop_draws != 1)
                            throw std::runtime_error("Props are not culled/instanced as expected");
                    } else if (std::string(name) == "props_depth_precision") {
                        pixel(*pixels, .5, .5, {20, 40, 220});
                    } else if (std::string(name) == "props_cutout") {
                        pixel(*pixels, .40625, .5, {40, 80, 120});
                        pixel(*pixels, .59375, .5, {240, 100, 40});
                    } else if (std::string(name) == "props_layers") {
                        pixel(*pixels, .5, .5,
                              pixels == &a ? std::array<int, 3>{160, 140, 120} : std::array<int, 3>{177, 145, 120});
                    } else {
                        pixel(*pixels, .5, .5,
                              pixels == &a ? std::array<int, 3>{120, 120, 120} : std::array<int, 3>{149, 128, 120});
                    }
                }
            }
        for (const auto format : {VK_FORMAT_R8G8B8A8_UNORM, VK_FORMAT_R8G8B8A8_SRGB})
            for (const auto samples : {1u, 4u})
                for (const auto name : {"world_particles", "world_particles_fog"}) {
                    auto mesh = Terrain::load(root / name).mesh(4);
                    VulkanRenderer renderer(context);
                    renderer.upload(mesh);
                    Target target{context};
                    target.create(format);
                    renderer.targets(std::span(&target.image, 1), format, 128, 128, samples);
                    const auto render = [&](std::span<const ParticleSprite> particles) {
                        auto orthographic = Matrix::identity();
                        orthographic.values[10] = -1;
                        orthographic.values[14] = 1;
                        return capture(renderer, root / "world-particles.ppm", orthographic, {}, {}, {}, {}, 0, {}, {},
                                       1, {}, {}, {}, particles);
                    };
                    const auto baseline = render({});
                    ParticleSprite p{{0, 0, .25}, .3f, {.8f, .2f, .1f, .5f}, 0, ParticleBlend::Additive};
                    auto additive = render(std::span(&p, 1));
                    if (renderer.stats().world_sprites != 1 || renderer.stats().particle_draws != 1)
                        throw std::runtime_error("World particle was not submitted");
                    ++checks;
                    p.blend = ParticleBlend::Alpha;
                    const auto alpha = render(std::span(&p, 1));
                    p.blend = ParticleBlend::Darken;
                    const auto dark = render(std::span(&p, 1));
                    constexpr unsigned center = (64 * 128 + 64) * 3;
                    for (unsigned c = 0; c < 3; ++c) {
                        checks += 2;
                        if (additive[center + c] <= baseline[center + c] || dark[center + c] >= baseline[center + c])
                            throw std::runtime_error("Additive/darkening world particle pixels do not composite");
                        if (format == VK_FORMAT_R8G8B8A8_UNORM) {
                            const double fade = std::string_view(name).ends_with("_fog") ? .75 : 1.;
                            const auto opacity = .5 * (128. / 255) * fade;
                            const auto expected_add = baseline[center + c] + p.colour[c] * 255 * opacity;
                            const auto expected_alpha =
                                baseline[center + c] * (1 - opacity) + p.colour[c] * 255 * opacity;
                            const auto expected_dark = baseline[center + c] * (1 - opacity);
                            checks += 3;
                            if (std::abs(additive[center + c] - expected_add) > 2 ||
                                std::abs(alpha[center + c] - expected_alpha) > 2 ||
                                std::abs(dark[center + c] - expected_dark) > 2)
                                throw std::runtime_error(
                                    "World particle blend or fog law differs from framebuffer pixels");
                        }
                    }
                    p.position.z = .75;
                    const auto behind = render(std::span(&p, 1));
                    if (behind != baseline)
                        throw std::runtime_error("World particles ignore opaque depth");
                    ++checks;
                    p.position.z = .25;
                    p.blend = ParticleBlend::Additive;
                    p.colour = {0, 0, 0, .5};
                    if (render(std::span(&p, 1)) != baseline)
                        throw std::runtime_error("Black additive control changes the frame");
                    ++checks;
                    p.texture = 255;
                    if (render(std::span(&p, 1)) != baseline || renderer.stats().world_sprites != 0)
                        throw std::runtime_error("Missing sprite selects unrelated art");
                    ++checks;
                    const std::array<ParticleSprite, 2> layers{
                        {{{0, 0, .3}, .3f, {1, 1, 1, .5f}, 19, ParticleBlend::Additive},
                         {{0, 0, .25}, .3f, {1, 1, 1, .5f}, 0, ParticleBlend::Darken}}};
                    const auto layered = render(layers);
                    if (renderer.stats().world_sprites != 2 || renderer.stats().particle_draws != 2 ||
                        layered == baseline)
                        throw std::runtime_error("World particle layers do not retain sprite and blend batches");
                    ++checks;
                }
        std::cout << "PASS: " << checks << " actual Vulkan texture/lightmap channel checks on UNORM and sRGB targets\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
