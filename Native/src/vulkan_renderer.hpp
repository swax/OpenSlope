#pragma once
#include <volk.h>
#include "openslope/terrain.hpp"
#include "render_math.hpp"
#include <filesystem>
#include <span>

namespace openslope {
void vk_check(VkResult result,const char* operation);
struct VulkanContext {
    VkInstance instance{};VkPhysicalDevice physical{};VkDevice device{};VkQueue queue{};std::uint32_t family{};
    VulkanContext()=default;
    VulkanContext(const VulkanContext&)=delete;
    ~VulkanContext();
    void create(bool window);
};
class VulkanRenderer {
public:
    explicit VulkanRenderer(VulkanContext& context):context_(context){}
    ~VulkanRenderer();
    VulkanRenderer(const VulkanRenderer&)=delete;
    void upload(const Mesh& mesh);
    void targets(std::span<const VkImage> images,VkFormat format,std::uint32_t width,std::uint32_t height);
    void render(unsigned image,const Matrix& camera,const Matrix& board,VkImageLayout final_layout,
        VkSemaphore wait={},VkSemaphore signal={});
    void capture(unsigned image,const std::filesystem::path& output);
    void clear_targets();
private:
    VulkanContext& context_;
    struct Buffer { VkBuffer buffer{};VkDeviceMemory memory{}; } vertices_,indices_;
    std::uint32_t terrain_indices_{},board_indices_{};
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
