#pragma once
#include "openslope/appearance.hpp"
#include "openslope/boost_trail.hpp"
#include "openslope/gear.hpp"
#include "openslope/lighting.hpp"
#include "openslope/particles.hpp"
#include "openslope/props.hpp"
#include "openslope/riding_effects.hpp"
#include "openslope/scene_lighting.hpp"
#include "openslope/snowfall.hpp"
#include "openslope/spline_motion.hpp"
#include "openslope/terrain.hpp"
#include "openslope/visibility.hpp"
#include "openslope/world.hpp"
#include "openslope/world_properties.hpp"
#include "ray_tracing.hpp"
#include "render_math.hpp"
#include <filesystem>
#include <functional>
#include <memory>
#include <span>
#include <volk.h>

namespace openslope {
void vk_check(VkResult result, const char* operation);
using UploadProgress = std::function<void(double, std::string_view)>;

// CPU-only preparation can run on a worker while the previous scene stays live.
struct SceneAssets {
    Mesh mesh;
    Props props;
    World world;
    Appearance appearance;
    std::vector<MeshBatch> batches;
    std::vector<std::string> crowd, particles;
    std::string sprite, wake, sheet;
    static SceneAssets prepare(Mesh mesh, std::span<const std::size_t> flag_models = {},
                               std::span<const std::size_t> faceted_models = {}, UploadProgress progress = {});
};

struct VulkanContext {
    VkInstance instance{};
    VkPhysicalDevice physical{};
    VkDevice device{};
    VkQueue queue{};
    std::uint32_t family{};
    float texture_anisotropy = 1;
    bool ray_query = false;
    VulkanContext() = default;
    VulkanContext(const VulkanContext&) = delete;
    ~VulkanContext();
    void create(bool window, bool request_ray_query = true);
    VkPhysicalDeviceFeatures texture_features();
};

// Geometry, samplers and sampled images are shared by stereo eye renderers.
class VulkanScene {
public:
    explicit VulkanScene(VulkanContext& context) : context_(context) {}

    ~VulkanScene();
    VulkanScene(const VulkanScene&) = delete;
    void upload(const Mesh& mesh, std::span<const std::size_t> flag_models = {},
                std::span<const std::size_t> faceted_models = {});
    void upload(SceneAssets assets, UploadProgress progress = {});
    void avatar_texture(std::shared_ptr<const RgbaImage> pixels);

private:
    friend class VulkanRenderer;
    VulkanContext& context_;

    struct Buffer {
        VkBuffer buffer{};
        VkDeviceMemory memory{};
    } vertices_, indices_, local_lights_, light_cells_, light_indices_;

    struct Image {
        VkImage image{};
        VkDeviceMemory memory{};
        VkImageView view{};
        VkDeviceSize bytes{};
    };

    struct Draw {
        std::uint32_t first{}, count{};
        VkDescriptorSet set{};
        int mode{};
    };

    std::vector<Image> images_;
    std::vector<Draw> draws_;
    std::vector<TerrainRange> terrain_ranges_;
    std::vector<RayMesh> ray_meshes_;
    std::uint32_t vertex_count_{};
    std::shared_ptr<RayGeometry> ray_geometry_;
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
    std::vector<std::uint32_t> prop_casters_;
    std::vector<std::uint32_t> lamp_housings_;
    std::vector<PropDraw> prop_draws_;
    std::vector<PropFrame> crowd_frames_;
    std::size_t pose_capacity_{};
    World world_;
    unsigned local_light_count_{}, spot_light_count_{};
    std::vector<Draw> sky_draws_;
    std::uint32_t board_first_{};
    std::uint32_t board_count_{};
    VkDescriptorSet board_set_{};
    std::array<VkDescriptorSet, stock_board_count> stock_board_sets_{};
    VkDescriptorSetLayout descriptors_{};
    VkDescriptorPool descriptor_pool_{};
    VkSampler repeat_{}, clamp_{}, sky_sampler_{};
    VkDeviceSize image_bytes_{};
    VkDescriptorSet effect_set_{}, wake_set_{}, sheet_set_{};
    VkDescriptorSet corona_set_{}, lamp_set_{};
    Image avatar_image_;
    VkDescriptorPool avatar_pool_{};
    VkDescriptorSet avatar_set_{};
    std::shared_ptr<const RgbaImage> avatar_pixels_;
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
            world_sprites{}, particle_draws{}, celestial_triangles{}, celestial_draws{}, lamp_glints{}, snowflakes{},
            snow_draws{}, opponent_boards{};
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
    void upload(SceneAssets assets, UploadProgress progress = {});
    void use_scene(std::shared_ptr<VulkanScene> scene);
    void targets(std::span<const VkImage> images, VkFormat format, std::uint32_t width, std::uint32_t height,
                 unsigned requested_samples = 1, unsigned render_scale = 100);

    unsigned samples() const { return unsigned(samples_); }

    std::uint32_t scene_width() const { return render_width_; }

    std::uint32_t scene_height() const { return render_height_; }

    void cull_terrain(bool enabled) { terrain_culling_ = enabled; }

    void deferred(bool enabled) { deferred_ = enabled; }

    void lighting(LightingMode mode);

    bool hdr() const { return hdr_; }

    unsigned local_lights() const { return scene_ ? scene_->local_light_count_ : 0; }

    unsigned spot_lights() const { return scene_ ? scene_->spot_light_count_ : 0; }

    void ray_shadows(bool enabled) { ray_shadows_ = enabled; }

    bool ray_shadows_active() const {
        return lighting_mode_ != LightingMode::Original && ray_shadows_ && context_.ray_query && !ray_failed_;
    }

    unsigned ray_instances() const { return ray_world_ ? ray_world_->instances() : 0; }

    std::uint64_t ray_bytes() const { return ray_geometry_ ? ray_geometry_->bytes() : 0; }

    void finish();

    void avatar_texture(std::shared_ptr<const RgbaImage> pixels) { scene_->avatar_texture(std::move(pixels)); }

    void board_art(unsigned design, std::span<const unsigned> opponents = {}, const SceneLighting* lighting = nullptr) {
        if (design >= stock_board_count)
            throw std::out_of_range("Invalid board design");
        board_design_ = design;
        opponent_designs_.assign(opponents.begin(), opponents.end());
        board_lighting_ = lighting;
    }

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
                CelestialView glare_view = {}, std::span<const Vertex> hud = {}, bool screen_hud = false,
                SnowfallView snow = {}, const LampView* lamps = nullptr, std::span<const Matrix> opponents = {},
                std::span<const Vertex> shadow_casters = {});

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
    unsigned board_design_ = stock_board_count; // legacy debug draws may use solid vertex art.
    std::vector<unsigned> opponent_designs_;
    const SceneLighting* board_lighting_ = nullptr;
    std::uint32_t width_{}, height_{}, render_width_{}, render_height_{};
    VkFormat format_{}, scene_format_{};
    unsigned requested_samples_ = 1, requested_scale_ = 100;
    bool hdr_ = false;
    VkSampleCountFlagBits samples_ = VK_SAMPLE_COUNT_1_BIT;
    VkCommandPool pool_{};
    VkCommandBuffer command_{};
    VkFence fence_{};
    VkRenderPass pass_{};
    VkPipelineLayout layout_{};
    VkPipeline pipeline_{}, blend_pipeline_{}, sprite_pipeline_{}, wake_pipeline_{}, sky_pipeline_{}, line_pipeline_{};
    std::array<std::array<VkPipeline, 16>, 2> material_pipelines_{};
    VkPipeline celestial_pipeline_{}, hud_pipeline_{}, wrist_pipeline_{};
    VkPipeline snow_pipeline_{};
    Buffer snow_vertices_;
    VkRenderPass presentation_pass_{};
    VkPipeline presentation_pipeline_{}, presentation_hud_{};
    VkDescriptorPool presentation_pool_{};
    VkSampler presentation_sampler_{};
    Buffer presentation_vertices_;
    Stats stats_;
    VkQueryPool timing_{};
    double timestamp_period_{};
    unsigned timestamp_bits_{};
    bool deferred_ = false, pending_ = false;
    Buffer poses_;
    Buffer lighting_;
    LightingMode lighting_mode_ = LightingMode::Original;
    bool ray_shadows_ = true, ray_failed_ = false;
    std::shared_ptr<RayGeometry> ray_geometry_;
    std::unique_ptr<RayWorld> ray_world_;
    std::unique_ptr<RayActor> ray_actor_;
    VkDescriptorSetLayout ray_layout_{};
    VkDescriptorPool ray_pool_{};
    VkDescriptorSet ray_set_{};
    VkPipeline ray_pipeline_{}, ray_blend_pipeline_{};
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
    Buffer board_vertices_;
    std::size_t board_capacity_{};
    std::vector<Vertex> board_mesh_;
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
        VkImage colour{}, depth{}, multisample{}, resolved{}, presentation_multisample{};
        VkDeviceMemory depth_memory{}, multisample_memory{}, resolved_memory{}, presentation_memory{};
        VkImageView colour_view{}, depth_view{}, multisample_view{}, resolved_view{}, presentation_view{};
        VkFramebuffer framebuffer{}, presentation_framebuffer{};
        VkDescriptorSet presentation_set{};
    };

    std::vector<Target> targets_;
    Buffer create_buffer(VkDeviceSize size, VkBufferUsageFlags usage, const void* data);
    std::uint32_t memory_type(std::uint32_t bits, VkMemoryPropertyFlags flags) const;
    void destroy_buffer(Buffer& buffer);
    void reserve_poses(std::size_t count);
    void bind_scene_lights();
};
} // namespace openslope
