#pragma once
#include <volk.h>
#include "openslope/terrain.hpp"
#include "render_math.hpp"
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
    struct Buffer {VkBuffer buffer{};VkDeviceMemory memory{};} vertices_,indices_;
    struct Image {VkImage image{};VkDeviceMemory memory{};VkImageView view{};};
    struct Draw {std::uint32_t first{},count{};VkDescriptorSet set{};int mode{};};
    std::vector<Image> images_;std::vector<Draw> draws_;
    std::uint32_t board_first_{};VkDescriptorSet board_set_{};
    VkDescriptorSetLayout descriptors_{};VkDescriptorPool descriptor_pool_{};
    VkSampler repeat_{},clamp_{};
    Image image(const struct RgbaImage& pixels,VkCommandPool pool);
    Buffer buffer(VkDeviceSize size,VkBufferUsageFlags usage,const void* data);
};
class VulkanRenderer {
public:
    explicit VulkanRenderer(VulkanContext& context):context_(context){}
    ~VulkanRenderer();
    VulkanRenderer(const VulkanRenderer&)=delete;
    void upload(const Mesh& mesh);
    void use_scene(std::shared_ptr<VulkanScene> scene);
    void targets(std::span<const VkImage> images,VkFormat format,std::uint32_t width,std::uint32_t height);
    void render(unsigned image,const Matrix& camera,const Matrix& board,VkImageLayout final_layout,
        VkSemaphore wait={},VkSemaphore signal={});
    void capture(unsigned image,const std::filesystem::path& output);
    void clear_targets();
private:
    VulkanContext& context_;
    struct Buffer { VkBuffer buffer{};VkDeviceMemory memory{}; };
    std::shared_ptr<VulkanScene> scene_;
    std::uint32_t width_{},height_{};VkFormat format_{};
    VkCommandPool pool_{};VkCommandBuffer command_{};VkFence fence_{};
    VkRenderPass pass_{};VkPipelineLayout layout_{};VkPipeline pipeline_{};
    struct Target { VkImage colour{},depth{};VkDeviceMemory depth_memory{};VkImageView colour_view{},depth_view{};VkFramebuffer framebuffer{}; };
    std::vector<Target> targets_;
    Buffer create_buffer(VkDeviceSize size,VkBufferUsageFlags usage,const void* data);
    std::uint32_t memory_type(std::uint32_t bits,VkMemoryPropertyFlags flags) const;
    void destroy_buffer(Buffer& buffer);
};
}
