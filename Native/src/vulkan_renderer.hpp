#pragma once
#include <volk.h>
#include "openslope/terrain.hpp"
#include "render_math.hpp"
#include "openslope/props.hpp"
#include "openslope/visibility.hpp"
#include <filesystem>
#include <span>
#include <memory>

namespace openslope {
void vk_check(VkResult result,const char* operation);
struct VulkanContext {
    VkInstance instance{};VkPhysicalDevice physical{};VkDevice device{};VkQueue queue{};std::uint32_t family{};
    VulkanContext()=default;
    VulkanContext(const VulkanContext&)=delete;
    ~VulkanContext();
    void create(bool window);
};
// Geometry, samplers and sampled images are shared by stereo eye renderers.
class VulkanScene {
public:
    explicit VulkanScene(VulkanContext& context):context_(context){}
    ~VulkanScene();
    VulkanScene(const VulkanScene&)=delete;
    void upload(const Mesh& mesh);
private:
    friend class VulkanRenderer;
    VulkanContext& context_;
    struct Buffer {VkBuffer buffer{};VkDeviceMemory memory{};} vertices_,indices_,poses_;
    struct Image {VkImage image{};VkDeviceMemory memory{};VkImageView view{};};
    struct Draw {std::uint32_t first{},count{};VkDescriptorSet set{};int mode{};};
    std::vector<Image> images_;std::vector<Draw> draws_;
    std::vector<TerrainRange> terrain_ranges_;std::vector<std::uint32_t> terrain_indices_;
    VisibilityTree terrain_visibility_;std::uint64_t terrain_total_indices_{};
    struct PropDraw {std::uint32_t first{},count{};VkDescriptorSet set{};int alpha{};};
    Props props_;std::vector<PropDraw> prop_draws_;std::size_t pose_capacity_{};
    std::uint32_t board_first_{};VkDescriptorSet board_set_{};
    VkDescriptorSetLayout descriptors_{};VkDescriptorPool descriptor_pool_{};
    VkSampler repeat_{},clamp_{};
    VkDeviceSize image_bytes_{};
    Image image(const struct RgbaImage& pixels,VkCommandPool pool,bool mipmapped=true);
    Buffer buffer(VkDeviceSize size,VkBufferUsageFlags usage,const void* data);
};
class VulkanRenderer {
public:
    struct Stats {unsigned visible_props{},prop_draws{},terrain_patches{},visible_terrain{},terrain_draws{};std::uint64_t terrain_indices{},terrain_total_indices{};std::size_t visibility_tests{};bool terrain_compacted=false;double cull_ms{},cpu_ms{},gpu_ms=-1;};
    explicit VulkanRenderer(VulkanContext& context):context_(context){}
    ~VulkanRenderer();
    VulkanRenderer(const VulkanRenderer&)=delete;
    void upload(const Mesh& mesh);
    void use_scene(std::shared_ptr<VulkanScene> scene);
    void targets(std::span<const VkImage> images,VkFormat format,std::uint32_t width,std::uint32_t height,unsigned requested_samples=1);
    unsigned samples() const {return unsigned(samples_);}
    void cull_terrain(bool enabled){terrain_culling_=enabled;}
    void render(unsigned image,const Matrix& camera,const Matrix& board,VkImageLayout final_layout,
        VkSemaphore wait={},VkSemaphore signal={},Vec3 eye={});
    const Stats& stats() const {return stats_;}
    void capture(unsigned image,const std::filesystem::path& output);
    void clear_targets();
private:
    VulkanContext& context_;
    struct Buffer { VkBuffer buffer{};VkDeviceMemory memory{}; };
    std::shared_ptr<VulkanScene> scene_;
    std::uint32_t width_{},height_{};VkFormat format_{};
    VkSampleCountFlagBits samples_=VK_SAMPLE_COUNT_1_BIT;
    VkCommandPool pool_{};VkCommandBuffer command_{};VkFence fence_{};
    VkRenderPass pass_{};VkPipelineLayout layout_{};VkPipeline pipeline_{},blend_pipeline_{};
    Stats stats_;VkQueryPool timing_{};double timestamp_period_{};unsigned timestamp_bits_{};
    bool terrain_culling_=true;Buffer visible_indices_;std::size_t index_capacity_{};
    std::vector<std::size_t> visible_ranges_;std::vector<std::uint32_t> packed_indices_;
    struct TerrainDraw {std::uint32_t first{},count{};std::size_t material{};};std::vector<TerrainDraw> terrain_draws_;
    struct Target { VkImage colour{},depth{},multisample{};VkDeviceMemory depth_memory{},multisample_memory{};VkImageView colour_view{},depth_view{},multisample_view{};VkFramebuffer framebuffer{}; };
    std::vector<Target> targets_;
    Buffer create_buffer(VkDeviceSize size,VkBufferUsageFlags usage,const void* data);
    std::uint32_t memory_type(std::uint32_t bits,VkMemoryPropertyFlags flags) const;
    void destroy_buffer(Buffer& buffer);
};
}
