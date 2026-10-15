#pragma once
#include "openslope/boost_trail.hpp"
#include "openslope/particles.hpp"
#include "openslope/props.hpp"
#include "openslope/riding_effects.hpp"
#include "openslope/spline_motion.hpp"
#include "openslope/terrain.hpp"
#include "openslope/visibility.hpp"
#include "openslope/world.hpp"
#include "openslope/world_properties.hpp"
#include "render_math.hpp"
#include <filesystem>
#include <memory>
#include <span>
#include <volk.h>

namespace openslope {
void vk_check(VkResult result, const char* operation);

struct VulkanContext {
    VkInstance instance{};
    VkPhysicalDevice physical{};
    VkDevice device{};
    VkQueue queue{};
    std::uint32_t family{};
    VulkanContext() = default;
    VulkanContext(const VulkanContext&) = delete;
    ~VulkanContext();
    void create(bool window);
};

// Geometry, samplers and sampled images are shared by stereo eye renderers.
class VulkanScene {
public:
    explicit VulkanScene(VulkanContext& context) : context_(context) {}

    ~VulkanScene();
    VulkanScene(const VulkanScene&) = delete;
    void upload(const Mesh& mesh, std::span<const std::size_t> flag_models = {},
                std::span<const std::size_t> faceted_models = {});

private:
    friend class VulkanRenderer;
    VulkanContext& context_;

    struct Buffer {
        VkBuffer buffer{};
        VkDeviceMemory memory{};
    } vertices_, indices_;

    struct Image {
        VkImage image{};
        VkDeviceMemory memory{};
        VkImageView view{};
    };

    struct Draw {
        std::uint32_t first{}, count{};
        VkDescriptorSet set{};
        int mode{};
    };

    std::vector<Image> images_;
    std::vector<Draw> draws_;
    std::vector<TerrainRange> terrain_ranges_;
    std::vector<std::uint32_t> terrain_indices_;
    VisibilityTree terrain_visibility_;
    std::uint64_t terrain_total_indices_{};

    struct PropFrame {
        VkDescriptorSet set{};
        int alpha{};
    };

    struct PropDraw {
        std::uint32_t first{}, count{};
        VkDescriptorSet set{};
        int alpha{};
        std::vector<PropFrame> frames;
        std::uint32_t wave_first = 0, wave_count = 0;
    };

    Props props_;
    std::vector<PropDraw> prop_draws_;
    std::vector<PropFrame> crowd_frames_;
    std::size_t pose_capacity_{};
    World world_;
    std::vector<Draw> sky_draws_;
    std::uint32_t board_first_{};
    std::uint32_t board_count_{};
    VkDescriptorSet board_set_{};
    VkDescriptorSetLayout descriptors_{};
    VkDescriptorPool descriptor_pool_{};
    VkSampler repeat_{}, clamp_{}, sky_sampler_{};
    VkDeviceSize image_bytes_{};
    VkDescriptorSet effect_set_{}, wake_set_{}, sheet_set_{};
    VkDescriptorSet corona_set_{};
    std::vector<VkDescriptorSet> particle_sets_;
    Image image(const struct RgbaImage& pixels, VkCommandPool pool, bool mipmapped = true);
    Buffer buffer(VkDeviceSize size, VkBufferUsageFlags usage, const void* data);
};

class VulkanRenderer {
public:
    struct Stats {
        unsigned flag_sections{}, flag_draws{}, route_copies{}, route_lines{}, line_draws{}, avatar_triangles{},
            visible_props{}, prop_draws{}, terrain_patches{}, visible_terrain{}, terrain_draws{}, sprites{},
            wake_segments{}, wake_draws{}, sheet_segments{}, sheet_draws{}, boost_segments{}, boost_draws{},
            world_sprites{}, particle_draws{}, celestial_triangles{}, celestial_draws{}, lamp_glints{};
        std::uint64_t terrain_indices{}, terrain_total_indices{};
        std::size_t visibility_tests{};
        bool terrain_compacted = false;
        double cull_ms{}, cpu_ms{}, wait_ms{}, gpu_ms = -1;
    };

    explicit VulkanRenderer(VulkanContext& context) : context_(context) {}

    ~VulkanRenderer();
    VulkanRenderer(const VulkanRenderer&) = delete;
    void upload(const Mesh& mesh, std::span<const std::size_t> flag_models = {},
                std::span<const std::size_t> faceted_models = {});
    void use_scene(std::shared_ptr<VulkanScene> scene);
    void targets(std::span<const VkImage> images, VkFormat format, std::uint32_t width, std::uint32_t height,
                 unsigned requested_samples = 1);

    unsigned samples() const { return unsigned(samples_); }

    void cull_terrain(bool enabled) { terrain_culling_ = enabled; }

    void deferred(bool enabled) { deferred_ = enabled; }

    void finish();

    const Glare& glare() const {
        static const Glare empty;
        return scene_ ? scene_->world_.glare : empty;
    }

    void render(unsigned image, const Matrix& camera, const Matrix& board, VkImageLayout final_layout,
                VkSemaphore wait = {}, VkSemaphore signal = {}, Vec3 eye = {}, std::span<const Sprite> sprites = {},
                std::span<const WakeVertex> wake = {}, std::span<const SprayVertex> sheet = {},
                std::span<const Vertex> avatar = {}, float fade = 0, std::span<const std::uint8_t> instance_flags = {},
                std::span<const PropMotion> motions = {}, double alpha = 1,
                std::span<const PropRouteMotion> routes = {}, std::span<const PropTextureFrame> texture_frames = {},
                std::span<const BoostTrailVertex> boost = {}, std::span<const ParticleSprite> particles = {},
                CelestialView glare_view = {}, std::span<const Vertex> hud = {}, bool screen_hud = false);

    const Stats& stats() const { return stats_; }

    void capture(unsigned image, const std::filesystem::path& output);
    void clear_targets();

private:
    VulkanContext& context_;

    struct Buffer {
        VkBuffer buffer{};
        VkDeviceMemory memory{};
    };

    std::shared_ptr<VulkanScene> scene_;
    std::uint32_t width_{}, height_{};
    VkFormat format_{};
    VkSampleCountFlagBits samples_ = VK_SAMPLE_COUNT_1_BIT;
    VkCommandPool pool_{};
    VkCommandBuffer command_{};
    VkFence fence_{};
    VkRenderPass pass_{};
    VkPipelineLayout layout_{};
    VkPipeline pipeline_{}, blend_pipeline_{}, sprite_pipeline_{}, wake_pipeline_{}, sky_pipeline_{}, line_pipeline_{};
    VkPipeline celestial_pipeline_{}, hud_pipeline_{}, wrist_pipeline_{};
    Stats stats_;
    VkQueryPool timing_{};
    double timestamp_period_{};
    unsigned timestamp_bits_{};
    bool deferred_ = false, pending_ = false;
    Buffer poses_;
    std::size_t pose_capacity_ = 0;
    VkDescriptorSetLayout pose_layout_{};
    VkDescriptorPool pose_pool_{};
    VkDescriptorSet pose_set_{};
    bool terrain_culling_ = true;
    Buffer visible_indices_;
    std::size_t index_capacity_{};
    std::vector<std::size_t> visible_ranges_;
    std::vector<std::uint32_t> packed_indices_;

    struct TerrainDraw {
        std::uint32_t first{}, count{};
        std::size_t material{};
    };

    std::vector<TerrainDraw> terrain_draws_;
    Buffer sprite_vertices_;
    std::size_t sprite_capacity_{};
    std::vector<Vertex> sprite_mesh_;
    Buffer particle_vertices_;
    std::size_t particle_capacity_{};
    std::vector<Vertex> particle_mesh_;
    Buffer celestial_vertices_, hud_vertices_;
    Buffer glint_vertices_;
    std::size_t glint_capacity_{};
    std::size_t celestial_capacity_{}, hud_capacity_{};

    struct ParticleDraw {
        std::uint32_t first{}, count{};
        unsigned texture{};
        ParticleBlend blend = ParticleBlend::Additive;
    };

    std::vector<ParticleDraw> particle_draws_;
    Buffer wake_vertices_;
    std::size_t wake_capacity_{};
    std::vector<Vertex> wake_mesh_;
    Buffer avatar_vertices_;
    std::size_t avatar_capacity_{};
    Buffer line_vertices_;
    std::size_t line_capacity_ = 0;
    std::vector<Vertex> line_mesh_;
    Buffer boost_vertices_;
    std::size_t boost_capacity_{};
    std::vector<Vertex> boost_mesh_;
    Buffer sheet_vertices_;
    std::size_t sheet_capacity_{};
    std::vector<Vertex> sheet_mesh_;

    struct Target {
        VkImage colour{}, depth{}, multisample{};
        VkDeviceMemory depth_memory{}, multisample_memory{};
        VkImageView colour_view{}, depth_view{}, multisample_view{};
        VkFramebuffer framebuffer{};
    };

    std::vector<Target> targets_;
    Buffer create_buffer(VkDeviceSize size, VkBufferUsageFlags usage, const void* data);
    std::uint32_t memory_type(std::uint32_t bits, VkMemoryPropertyFlags flags) const;
    void destroy_buffer(Buffer& buffer);
    void reserve_poses(std::size_t count);
};
} // namespace openslope
