#include "vulkan_renderer.hpp"
#include "openslope/graphics_preferences.hpp"
#include "snow_frag.hpp"
#include "snow_vert.hpp"
#include "terrain_frag.hpp"
#include "terrain_rt_frag.hpp"
#include "terrain_vert.hpp"
#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstring>
#include <fstream>
#include <iostream>
#include <limits>
#include <map>
#include <stdexcept>
#include <tuple>

namespace openslope {
namespace {
struct DrawPush {
    Matrix mvp;
    std::array<std::int32_t, 4> options{};
    std::array<float, 4> fog_colour_start{}, eye_end{}, presentation{1, 0, 0, 0};
};

static_assert(sizeof(DrawPush) == 128);

struct SnowPush {
    Matrix clip;
    std::array<float, 4> eye_time, box_lift, motion, fades;
};

static_assert(sizeof(SnowPush) == 128);
constexpr auto draw_stages = VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT;
} // namespace

void vk_check(VkResult result, const char* operation) {
    if (result != VK_SUCCESS)
        throw std::runtime_error(std::string(operation) + ": Vulkan result " + std::to_string(result));
}

VulkanContext::~VulkanContext() {
    if (device) {
        vkDeviceWaitIdle(device);
        vkDestroyDevice(device, nullptr);
    }
    if (instance)
        vkDestroyInstance(instance, nullptr);
}

void VulkanContext::create(bool window, bool request_ray_query) {
    vk_check(volkInitialize(), "Load Vulkan driver");
    VkApplicationInfo app{VK_STRUCTURE_TYPE_APPLICATION_INFO};
    app.pApplicationName = "OpenSlope Native";
    std::uint32_t loader_version = VK_API_VERSION_1_1;
    if (vkEnumerateInstanceVersion)
        vk_check(vkEnumerateInstanceVersion(&loader_version), "Query Vulkan version");
    app.apiVersion = std::min(loader_version, VK_API_VERSION_1_2);
    std::vector<const char*> extensions;
#ifdef _WIN32
    if (window)
        extensions = {VK_KHR_SURFACE_EXTENSION_NAME, VK_KHR_WIN32_SURFACE_EXTENSION_NAME};
#else
    if (window)
        throw std::runtime_error("Desktop window preview is currently Windows-only; use OpenXR or capture mode");
#endif
    VkInstanceCreateInfo info{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};
    info.pApplicationInfo = &app;
    info.enabledExtensionCount = std::uint32_t(extensions.size());
    info.ppEnabledExtensionNames = extensions.data();
    vk_check(vkCreateInstance(&info, nullptr, &instance), "Create Vulkan instance");
    volkLoadInstance(instance);
    std::uint32_t count = 0;
    vk_check(vkEnumeratePhysicalDevices(instance, &count, nullptr), "Enumerate GPUs");
    std::vector<VkPhysicalDevice> devices(count);
    vk_check(vkEnumeratePhysicalDevices(instance, &count, devices.data()), "Enumerate GPUs");
    int best = -1;
    for (auto candidate : devices) {
        VkPhysicalDeviceProperties props;
        vkGetPhysicalDeviceProperties(candidate, &props);
        std::uint32_t families = 0;
        vkGetPhysicalDeviceQueueFamilyProperties(candidate, &families, nullptr);
        std::vector<VkQueueFamilyProperties> queues(families);
        vkGetPhysicalDeviceQueueFamilyProperties(candidate, &families, queues.data());
        for (std::uint32_t i = 0; i < families; ++i)
            if (queues[i].queueFlags & VK_QUEUE_GRAPHICS_BIT) {
                const int score = props.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU ? 2 : 1;
                if (score > best) {
                    physical = candidate;
                    family = i;
                    best = score;
                }
                break;
            }
    }
    if (!physical)
        throw std::runtime_error("No graphics-capable Vulkan device");
    const float priority = 1;
    VkDeviceQueueCreateInfo queue_info{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO};
    queue_info.queueFamilyIndex = family;
    queue_info.queueCount = 1;
    queue_info.pQueuePriorities = &priority;
    const auto features = texture_features();
    VkDeviceCreateInfo device_info{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO};
    device_info.pEnabledFeatures = &features;
    device_info.queueCreateInfoCount = 1;
    device_info.pQueueCreateInfos = &queue_info;
    std::vector<const char*> device_extensions;
    if (window)
        device_extensions.push_back(VK_KHR_SWAPCHAIN_EXTENSION_NAME);
    VkPhysicalDeviceProperties device_properties;
    vkGetPhysicalDeviceProperties(physical, &device_properties);
    VkPhysicalDeviceRayQueryFeaturesKHR ray{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_RAY_QUERY_FEATURES_KHR};
    VkPhysicalDeviceAccelerationStructureFeaturesKHR acceleration{
        VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ACCELERATION_STRUCTURE_FEATURES_KHR};
    VkPhysicalDeviceBufferDeviceAddressFeatures address{
        VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_BUFFER_DEVICE_ADDRESS_FEATURES};
    if (request_ray_query && app.apiVersion >= VK_API_VERSION_1_2 &&
        device_properties.apiVersion >= VK_API_VERSION_1_2) {
        std::uint32_t count = 0;
        vk_check(vkEnumerateDeviceExtensionProperties(physical, nullptr, &count, nullptr), "Count device extensions");
        std::vector<VkExtensionProperties> supported(count);
        vk_check(vkEnumerateDeviceExtensionProperties(physical, nullptr, &count, supported.data()),
                 "Read device extensions");
        const auto has = [&](const char* name) {
            return std::any_of(supported.begin(), supported.end(),
                               [&](const auto& extension) { return std::strcmp(extension.extensionName, name) == 0; });
        };
        if (has(VK_KHR_RAY_QUERY_EXTENSION_NAME) && has(VK_KHR_ACCELERATION_STRUCTURE_EXTENSION_NAME) &&
            has(VK_KHR_DEFERRED_HOST_OPERATIONS_EXTENSION_NAME)) {
            VkPhysicalDeviceFeatures2 available{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2};
            available.pNext = &ray;
            ray.pNext = &acceleration;
            acceleration.pNext = &address;
            vkGetPhysicalDeviceFeatures2(physical, &available);
            ray_query = ray.rayQuery && acceleration.accelerationStructure && address.bufferDeviceAddress;
            if (ray_query) {
                // Enable only the features used by the shadow path.
                ray = {VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_RAY_QUERY_FEATURES_KHR};
                acceleration = {VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ACCELERATION_STRUCTURE_FEATURES_KHR};
                address = {VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_BUFFER_DEVICE_ADDRESS_FEATURES};
                ray.rayQuery = acceleration.accelerationStructure = address.bufferDeviceAddress = VK_TRUE;
                ray.pNext = &acceleration;
                acceleration.pNext = &address;
                device_info.pNext = &ray;
                device_extensions.insert(device_extensions.end(),
                                         {VK_KHR_RAY_QUERY_EXTENSION_NAME, VK_KHR_ACCELERATION_STRUCTURE_EXTENSION_NAME,
                                          VK_KHR_DEFERRED_HOST_OPERATIONS_EXTENSION_NAME});
            }
        }
    }
    device_info.enabledExtensionCount = unsigned(device_extensions.size());
    device_info.ppEnabledExtensionNames = device_extensions.data();
    vk_check(vkCreateDevice(physical, &device_info, nullptr, &device), "Create Vulkan device");
    volkLoadDevice(device);
    vkGetDeviceQueue(device, family, 0, &queue);
}

VkPhysicalDeviceFeatures VulkanContext::texture_features() {
    VkPhysicalDeviceFeatures supported{}, enabled{};
    vkGetPhysicalDeviceFeatures(physical, &supported);
    enabled.samplerAnisotropy = supported.samplerAnisotropy;
    texture_anisotropy = 1;
    if (enabled.samplerAnisotropy) {
        VkPhysicalDeviceProperties properties;
        vkGetPhysicalDeviceProperties(physical, &properties);
        texture_anisotropy = std::min(4.f, properties.limits.maxSamplerAnisotropy);
    }
    return enabled;
}

std::uint32_t VulkanRenderer::memory_type(std::uint32_t bits, VkMemoryPropertyFlags flags) const {
    VkPhysicalDeviceMemoryProperties properties;
    vkGetPhysicalDeviceMemoryProperties(context_.physical, &properties);
    for (std::uint32_t i = 0; i < properties.memoryTypeCount; ++i)
        if ((bits & (1u << i)) && (properties.memoryTypes[i].propertyFlags & flags) == flags)
            return i;
    throw std::runtime_error("No suitable Vulkan memory type");
}

VulkanRenderer::Buffer VulkanRenderer::create_buffer(VkDeviceSize size, VkBufferUsageFlags usage, const void* data) {
    Buffer buffer;
    try {
        VkBufferCreateInfo info{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};
        info.size = size;
        info.usage = usage;
        vk_check(vkCreateBuffer(context_.device, &info, nullptr, &buffer.buffer), "Create buffer");
        VkMemoryRequirements requirements;
        vkGetBufferMemoryRequirements(context_.device, buffer.buffer, &requirements);
        VkMemoryAllocateInfo allocation{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
        allocation.allocationSize = requirements.size;
        allocation.memoryTypeIndex = memory_type(requirements.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT |
                                                                                  VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
        vk_check(vkAllocateMemory(context_.device, &allocation, nullptr, &buffer.memory), "Allocate buffer memory");
        vk_check(vkBindBufferMemory(context_.device, buffer.buffer, buffer.memory, 0), "Bind buffer");
        if (data) {
            void* mapped;
            vk_check(vkMapMemory(context_.device, buffer.memory, 0, size, 0, &mapped), "Map buffer");
            std::memcpy(mapped, data, std::size_t(size));
            vkUnmapMemory(context_.device, buffer.memory);
        }
        return buffer;
    } catch (...) {
        destroy_buffer(buffer);
        throw;
    }
}

void VulkanRenderer::destroy_buffer(Buffer& b) {
    if (b.buffer)
        vkDestroyBuffer(context_.device, b.buffer, nullptr);
    if (b.memory)
        vkFreeMemory(context_.device, b.memory, nullptr);
    b = {};
}

void VulkanRenderer::upload(const Mesh& source, std::span<const std::size_t> flag_models,
                            std::span<const std::size_t> faceted_models) {
    upload(SceneAssets::prepare(source, flag_models, faceted_models));
}

void VulkanRenderer::upload(SceneAssets assets, UploadProgress progress) {
    auto scene = std::make_shared<VulkanScene>(context_);
    scene->upload(std::move(assets), std::move(progress));
    if (scene_) {
        finish();
        reserve_poses(scene->pose_capacity_);
        // Every scene uses the same two-sampler layout, so existing pipelines
        // accept its descriptor sets. Publish only after upload and allocation.
        scene_ = std::move(scene);
        bind_scene_lights();
        ray_failed_ = false;
        stats_ = {};
        return;
    }
    use_scene(std::move(scene));
}

void VulkanRenderer::reserve_poses(std::size_t count) {
    if (count <= pose_capacity_)
        return;
    VkPhysicalDeviceProperties limits;
    vkGetPhysicalDeviceProperties(context_.physical, &limits);
    const auto maximum =
        std::min(std::size_t(1000000), std::size_t(limits.limits.maxStorageBufferRange / sizeof(PropPose)));
    if (count > maximum)
        throw std::invalid_argument("Spline copies exceed GPU placement limit");
    const auto capacity = std::min(maximum, std::max(count, pose_capacity_ * 2));
    auto replacement = create_buffer(capacity * sizeof(PropPose), VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, nullptr);
    destroy_buffer(poses_);
    poses_ = replacement;
    pose_capacity_ = capacity;
    const VkDescriptorBufferInfo data{poses_.buffer, 0, capacity * sizeof(PropPose)};
    VkWriteDescriptorSet write{VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET};
    write.dstSet = pose_set_;
    write.dstBinding = 0;
    write.descriptorCount = 1;
    write.descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
    write.pBufferInfo = &data;
    vkUpdateDescriptorSets(context_.device, 1, &write, 0, nullptr);
}

void VulkanRenderer::use_scene(std::shared_ptr<VulkanScene> scene) {
    if (!scene || &scene->context_ != &context_)
        throw std::runtime_error("Renderer requires a scene on its Vulkan device");
    if (scene_)
        throw std::runtime_error("Renderer already has a scene");
    scene_ = std::move(scene);
    // Eye-local placements allow both views to remain queued on the same GPU.
    pose_capacity_ = scene_->pose_capacity_;
    poses_ = create_buffer(pose_capacity_ * sizeof(PropPose), VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, nullptr);
    lighting_ = create_buffer(sizeof(LightingUniform), VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT, nullptr);
    const std::array<VkDescriptorSetLayoutBinding, 5> bindings{
        {{0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_VERTEX_BIT, nullptr},
         {1, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, nullptr},
         {2, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, nullptr},
         {3, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, nullptr},
         {4, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, nullptr}}};
    VkDescriptorSetLayoutCreateInfo pose_layout{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO};
    pose_layout.bindingCount = unsigned(bindings.size());
    pose_layout.pBindings = bindings.data();
    vk_check(vkCreateDescriptorSetLayout(context_.device, &pose_layout, nullptr, &pose_layout_),
             "Create eye placement layout");
    const std::array<VkDescriptorPoolSize, 2> sizes{
        {{VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 4}, {VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1}}};
    VkDescriptorPoolCreateInfo pose_pool{VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO};
    pose_pool.maxSets = 1;
    pose_pool.poolSizeCount = unsigned(sizes.size());
    pose_pool.pPoolSizes = sizes.data();
    vk_check(vkCreateDescriptorPool(context_.device, &pose_pool, nullptr, &pose_pool_), "Create eye placement pool");
    VkDescriptorSetAllocateInfo pose_allocate{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO};
    pose_allocate.descriptorPool = pose_pool_;
    pose_allocate.descriptorSetCount = 1;
    pose_allocate.pSetLayouts = &pose_layout_;
    vk_check(vkAllocateDescriptorSets(context_.device, &pose_allocate, &pose_set_), "Allocate eye placements");
    const VkDescriptorBufferInfo data{poses_.buffer, 0, scene_->pose_capacity_ * sizeof(PropPose)};
    VkWriteDescriptorSet write{VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET};
    write.dstSet = pose_set_;
    write.dstBinding = 0;
    write.descriptorCount = 1;
    write.descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
    write.pBufferInfo = &data;
    vkUpdateDescriptorSets(context_.device, 1, &write, 0, nullptr);
    const VkDescriptorBufferInfo light_data{lighting_.buffer, 0, sizeof(LightingUniform)};
    write.dstBinding = 1;
    write.descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
    write.pBufferInfo = &light_data;
    vkUpdateDescriptorSets(context_.device, 1, &write, 0, nullptr);
    bind_scene_lights();
    if (context_.ray_query) {
        const VkDescriptorSetLayoutBinding ray_binding{0, VK_DESCRIPTOR_TYPE_ACCELERATION_STRUCTURE_KHR, 1,
                                                       VK_SHADER_STAGE_FRAGMENT_BIT, nullptr};
        VkDescriptorSetLayoutCreateInfo ray_layout{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO};
        ray_layout.bindingCount = 1;
        ray_layout.pBindings = &ray_binding;
        vk_check(vkCreateDescriptorSetLayout(context_.device, &ray_layout, nullptr, &ray_layout_), "Create ray layout");
        const VkDescriptorPoolSize ray_size{VK_DESCRIPTOR_TYPE_ACCELERATION_STRUCTURE_KHR, 1};
        VkDescriptorPoolCreateInfo ray_pool{VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO};
        ray_pool.maxSets = ray_pool.poolSizeCount = 1;
        ray_pool.pPoolSizes = &ray_size;
        vk_check(vkCreateDescriptorPool(context_.device, &ray_pool, nullptr, &ray_pool_), "Create ray descriptor pool");
        VkDescriptorSetAllocateInfo ray_allocate{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO};
        ray_allocate.descriptorPool = ray_pool_;
        ray_allocate.descriptorSetCount = 1;
        ray_allocate.pSetLayouts = &ray_layout_;
        vk_check(vkAllocateDescriptorSets(context_.device, &ray_allocate, &ray_set_), "Allocate ray descriptor");
    }
    VkCommandPoolCreateInfo pool{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};
    pool.queueFamilyIndex = context_.family;
    pool.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    vk_check(vkCreateCommandPool(context_.device, &pool, nullptr, &pool_), "Create command pool");
    VkCommandBufferAllocateInfo allocate{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
    allocate.commandPool = pool_;
    allocate.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    allocate.commandBufferCount = 1;
    vk_check(vkAllocateCommandBuffers(context_.device, &allocate, &command_), "Allocate draw command");
    VkFenceCreateInfo fence{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
    fence.flags = VK_FENCE_CREATE_SIGNALED_BIT;
    vk_check(vkCreateFence(context_.device, &fence, nullptr, &fence_), "Create render fence");
    std::uint32_t families = 0;
    vkGetPhysicalDeviceQueueFamilyProperties(context_.physical, &families, nullptr);
    std::vector<VkQueueFamilyProperties> properties(families);
    vkGetPhysicalDeviceQueueFamilyProperties(context_.physical, &families, properties.data());
    timestamp_bits_ = properties.at(context_.family).timestampValidBits;
    if (timestamp_bits_) {
        VkPhysicalDeviceProperties device;
        vkGetPhysicalDeviceProperties(context_.physical, &device);
        timestamp_period_ = device.limits.timestampPeriod;
        VkQueryPoolCreateInfo query{VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO};
        query.queryType = VK_QUERY_TYPE_TIMESTAMP;
        query.queryCount = 2;
        vk_check(vkCreateQueryPool(context_.device, &query, nullptr, &timing_), "Create frame timestamp queries");
    }
}

VulkanRenderer::~VulkanRenderer() {
    if (!context_.device)
        return;
    vkDeviceWaitIdle(context_.device);
    clear_targets();
    if (fence_)
        vkDestroyFence(context_.device, fence_, nullptr);
    if (pool_)
        vkDestroyCommandPool(context_.device, pool_, nullptr);
    if (timing_)
        vkDestroyQueryPool(context_.device, timing_, nullptr);
    if (pose_pool_)
        vkDestroyDescriptorPool(context_.device, pose_pool_, nullptr);
    if (pose_layout_)
        vkDestroyDescriptorSetLayout(context_.device, pose_layout_, nullptr);
    if (ray_pool_)
        vkDestroyDescriptorPool(context_.device, ray_pool_, nullptr);
    if (ray_layout_)
        vkDestroyDescriptorSetLayout(context_.device, ray_layout_, nullptr);
    destroy_buffer(poses_);
    destroy_buffer(lighting_);
    destroy_buffer(line_vertices_);
    destroy_buffer(visible_indices_);
    destroy_buffer(sprite_vertices_);
    destroy_buffer(particle_vertices_);
    destroy_buffer(celestial_vertices_);
    destroy_buffer(hud_vertices_);
    destroy_buffer(glint_vertices_);
    destroy_buffer(wake_vertices_);
    destroy_buffer(avatar_vertices_);
    destroy_buffer(board_vertices_);
    destroy_buffer(sheet_vertices_);
    destroy_buffer(boost_vertices_);
    destroy_buffer(snow_vertices_);
    destroy_buffer(presentation_vertices_);
}

void VulkanRenderer::clear_targets() {
    if (targets_.empty() && !pass_)
        return;
    vkDeviceWaitIdle(context_.device);
    for (auto& target : targets_) {
        if (target.presentation_framebuffer)
            vkDestroyFramebuffer(context_.device, target.presentation_framebuffer, nullptr);
        if (target.presentation_view)
            vkDestroyImageView(context_.device, target.presentation_view, nullptr);
        if (target.presentation_multisample)
            vkDestroyImage(context_.device, target.presentation_multisample, nullptr);
        if (target.presentation_memory)
            vkFreeMemory(context_.device, target.presentation_memory, nullptr);
        if (target.framebuffer)
            vkDestroyFramebuffer(context_.device, target.framebuffer, nullptr);
        if (target.colour_view)
            vkDestroyImageView(context_.device, target.colour_view, nullptr);
        if (target.depth_view)
            vkDestroyImageView(context_.device, target.depth_view, nullptr);
        if (target.depth)
            vkDestroyImage(context_.device, target.depth, nullptr);
        if (target.depth_memory)
            vkFreeMemory(context_.device, target.depth_memory, nullptr);
        if (target.multisample_view)
            vkDestroyImageView(context_.device, target.multisample_view, nullptr);
        if (target.multisample)
            vkDestroyImage(context_.device, target.multisample, nullptr);
        if (target.multisample_memory)
            vkFreeMemory(context_.device, target.multisample_memory, nullptr);
        if (target.resolved_view)
            vkDestroyImageView(context_.device, target.resolved_view, nullptr);
        if (target.resolved)
            vkDestroyImage(context_.device, target.resolved, nullptr);
        if (target.resolved_memory)
            vkFreeMemory(context_.device, target.resolved_memory, nullptr);
    }
    targets_.clear();
    if (presentation_pipeline_)
        vkDestroyPipeline(context_.device, presentation_pipeline_, nullptr);
    if (presentation_hud_)
        vkDestroyPipeline(context_.device, presentation_hud_, nullptr);
    if (presentation_pass_)
        vkDestroyRenderPass(context_.device, presentation_pass_, nullptr);
    if (presentation_pool_)
        vkDestroyDescriptorPool(context_.device, presentation_pool_, nullptr);
    if (presentation_sampler_)
        vkDestroySampler(context_.device, presentation_sampler_, nullptr);
    presentation_pipeline_ = presentation_hud_ = {};
    presentation_pass_ = {};
    presentation_pool_ = {};
    presentation_sampler_ = {};
    if (pipeline_)
        vkDestroyPipeline(context_.device, pipeline_, nullptr);
    if (blend_pipeline_)
        vkDestroyPipeline(context_.device, blend_pipeline_, nullptr);
    if (ray_pipeline_)
        vkDestroyPipeline(context_.device, ray_pipeline_, nullptr);
    if (ray_blend_pipeline_)
        vkDestroyPipeline(context_.device, ray_blend_pipeline_, nullptr);
    ray_pipeline_ = ray_blend_pipeline_ = {};
    if (layout_)
        vkDestroyPipelineLayout(context_.device, layout_, nullptr);
    if (sprite_pipeline_)
        vkDestroyPipeline(context_.device, sprite_pipeline_, nullptr);
    sprite_pipeline_ = {};
    if (wake_pipeline_)
        vkDestroyPipeline(context_.device, wake_pipeline_, nullptr);
    wake_pipeline_ = {};
    if (sky_pipeline_)
        vkDestroyPipeline(context_.device, sky_pipeline_, nullptr);
    sky_pipeline_ = {};
    if (line_pipeline_)
        vkDestroyPipeline(context_.device, line_pipeline_, nullptr);
    if (celestial_pipeline_)
        vkDestroyPipeline(context_.device, celestial_pipeline_, nullptr);
    celestial_pipeline_ = {};
    if (hud_pipeline_)
        vkDestroyPipeline(context_.device, hud_pipeline_, nullptr);
    hud_pipeline_ = {};
    if (wrist_pipeline_)
        vkDestroyPipeline(context_.device, wrist_pipeline_, nullptr);
    wrist_pipeline_ = {};
    if (snow_pipeline_)
        vkDestroyPipeline(context_.device, snow_pipeline_, nullptr);
    snow_pipeline_ = {};
    line_pipeline_ = {};
    if (pass_)
        vkDestroyRenderPass(context_.device, pass_, nullptr);
    pipeline_ = {};
    blend_pipeline_ = {};
    layout_ = {};
    pass_ = {};
}

void VulkanRenderer::bind_scene_lights() {
    const std::array<VkDescriptorBufferInfo, 3> buffers{{{scene_->local_lights_.buffer, 0, VK_WHOLE_SIZE},
                                                         {scene_->light_cells_.buffer, 0, VK_WHOLE_SIZE},
                                                         {scene_->light_indices_.buffer, 0, VK_WHOLE_SIZE}}};
    for (unsigned i = 0; i < buffers.size(); ++i) {
        VkWriteDescriptorSet write{VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET};
        write.dstSet = pose_set_;
        write.dstBinding = 2 + i;
        write.descriptorCount = 1;
        write.descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
        write.pBufferInfo = &buffers[i];
        vkUpdateDescriptorSets(context_.device, 1, &write, 0, nullptr);
    }
}

void VulkanRenderer::lighting(LightingMode mode) {
    if (mode != LightingMode::Original && mode != LightingMode::Enhanced && mode != LightingMode::Runtime)
        throw std::invalid_argument("Invalid lighting mode");
    if (mode == lighting_mode_)
        return;
    finish();
    lighting_mode_ = mode;
    if (!targets_.empty()) {
        std::vector<VkImage> images;
        for (const auto& target : targets_)
            images.push_back(target.colour);
        targets(images, format_, width_, height_, requested_samples_, requested_scale_);
    }
}

void VulkanRenderer::targets(std::span<const VkImage> images, VkFormat format, std::uint32_t width,
                             std::uint32_t height, unsigned requested_samples, unsigned render_scale) {
    if (!scene_)
        throw std::runtime_error("Upload map assets before creating render targets");
    if (requested_samples != 1 && requested_samples != 2 && requested_samples != 4 && requested_samples != 8)
        throw std::runtime_error("MSAA must be 1, 2, 4 or 8");
    const auto extent = GraphicsPreferences::scene_size(width, height, render_scale);
    clear_targets();
    width_ = width;
    height_ = height;
    render_width_ = extent[0];
    render_height_ = extent[1];
    format_ = format;
    requested_samples_ = requested_samples;
    requested_scale_ = render_scale;
    VkFormatProperties hdr_support;
    vkGetPhysicalDeviceFormatProperties(context_.physical, VK_FORMAT_R16G16B16A16_SFLOAT, &hdr_support);
    constexpr auto hdr_features = VK_FORMAT_FEATURE_COLOR_ATTACHMENT_BIT | VK_FORMAT_FEATURE_SAMPLED_IMAGE_BIT |
                                  VK_FORMAT_FEATURE_SAMPLED_IMAGE_FILTER_LINEAR_BIT;
    hdr_ =
        lighting_mode_ != LightingMode::Original && (hdr_support.optimalTilingFeatures & hdr_features) == hdr_features;
    const bool offscreen = render_scale != 100 || hdr_;
    scene_format_ = render_scale == 100 ? format
                                        : (format == VK_FORMAT_B8G8R8A8_SRGB   ? VK_FORMAT_B8G8R8A8_UNORM
                                           : format == VK_FORMAT_R8G8B8A8_SRGB ? VK_FORMAT_R8G8B8A8_UNORM
                                                                               : format);
    if (hdr_)
        scene_format_ = VK_FORMAT_R16G16B16A16_SFLOAT;
    VkPhysicalDeviceProperties properties;
    vkGetPhysicalDeviceProperties(context_.physical, &properties);
    VkImageFormatProperties colour_support{}, depth_support{}, output_support{};
    const auto scene_usage =
        VkImageUsageFlags(VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | (offscreen ? VK_IMAGE_USAGE_SAMPLED_BIT : 0));
    vk_check(vkGetPhysicalDeviceImageFormatProperties(context_.physical, scene_format_, VK_IMAGE_TYPE_2D,
                                                      VK_IMAGE_TILING_OPTIMAL, scene_usage, 0, &colour_support),
             "Query colour sample counts");
    vk_check(vkGetPhysicalDeviceImageFormatProperties(context_.physical, format_, VK_IMAGE_TYPE_2D,
                                                      VK_IMAGE_TILING_OPTIMAL, VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT, 0,
                                                      &output_support),
             "Query presentation sample counts");
    vk_check(vkGetPhysicalDeviceImageFormatProperties(context_.physical, VK_FORMAT_D32_SFLOAT, VK_IMAGE_TYPE_2D,
                                                      VK_IMAGE_TILING_OPTIMAL,
                                                      VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT, 0, &depth_support),
             "Query depth sample counts");
    if (images.empty() || !width || !height ||
        render_width_ > std::min({colour_support.maxExtent.width, depth_support.maxExtent.width,
                                  properties.limits.maxFramebufferWidth}) ||
        render_height_ > std::min({colour_support.maxExtent.height, depth_support.maxExtent.height,
                                   properties.limits.maxFramebufferHeight}))
        throw std::runtime_error("Invalid render target dimensions/count");
    if (offscreen) {
        VkFormatProperties support;
        vkGetPhysicalDeviceFormatProperties(context_.physical, scene_format_, &support);
        if (!(support.optimalTilingFeatures & VK_FORMAT_FEATURE_SAMPLED_IMAGE_FILTER_LINEAR_BIT))
            throw std::runtime_error("Scene format does not support linear downsampling");
    }
    const auto supported = properties.limits.framebufferColorSampleCounts &
                           properties.limits.framebufferDepthSampleCounts & colour_support.sampleCounts &
                           depth_support.sampleCounts & output_support.sampleCounts;
    samples_ = VK_SAMPLE_COUNT_1_BIT;
    for (const auto count : {8u, 4u, 2u, 1u})
        if (count <= requested_samples && (supported & count)) {
            samples_ = static_cast<VkSampleCountFlagBits>(count);
            break;
        }
    VkAttachmentDescription colour{};
    colour.format = scene_format_;
    colour.samples = VK_SAMPLE_COUNT_1_BIT;
    colour.loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR;
    colour.storeOp = VK_ATTACHMENT_STORE_OP_STORE;
    colour.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    colour.finalLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
    VkAttachmentDescription depth{};
    depth.format = VK_FORMAT_D32_SFLOAT;
    depth.samples = VK_SAMPLE_COUNT_1_BIT;
    depth.loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR;
    depth.storeOp = VK_ATTACHMENT_STORE_OP_DONT_CARE;
    depth.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    depth.finalLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL;
    auto resolve = colour;
    resolve.loadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE;
    colour.samples = depth.samples = samples_;
    if (samples_ != VK_SAMPLE_COUNT_1_BIT)
        colour.storeOp = VK_ATTACHMENT_STORE_OP_DONT_CARE;
    const std::array<VkAttachmentDescription, 3> attachments{colour, depth, resolve};
    VkAttachmentReference colour_ref{0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL},
        depth_ref{1, VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL};
    VkSubpassDescription subpass{};
    subpass.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS;
    subpass.colorAttachmentCount = 1;
    subpass.pColorAttachments = &colour_ref;
    subpass.pDepthStencilAttachment = &depth_ref;
    const VkAttachmentReference resolve_ref{2, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL};
    if (samples_ != VK_SAMPLE_COUNT_1_BIT)
        subpass.pResolveAttachments = &resolve_ref;
    VkSubpassDependency dependency{};
    dependency.srcSubpass = VK_SUBPASS_EXTERNAL;
    dependency.dstSubpass = 0;
    dependency.srcStageMask = dependency.dstStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT |
                                                        VK_PIPELINE_STAGE_EARLY_FRAGMENT_TESTS_BIT |
                                                        VK_PIPELINE_STAGE_LATE_FRAGMENT_TESTS_BIT;
    dependency.dstAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT | VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT;
    VkRenderPassCreateInfo pass{VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO};
    pass.attachmentCount = samples_ == VK_SAMPLE_COUNT_1_BIT ? 2 : 3;
    pass.pAttachments = attachments.data();
    pass.subpassCount = 1;
    pass.pSubpasses = &subpass;
    pass.dependencyCount = 1;
    pass.pDependencies = &dependency;
    vk_check(vkCreateRenderPass(context_.device, &pass, nullptr, &pass_), "Create terrain render pass");
    VkPushConstantRange push{draw_stages, 0, sizeof(DrawPush)};
    const std::array<VkDescriptorSetLayout, 3> sets{scene_->descriptors_, pose_layout_, ray_layout_};
    VkPipelineLayoutCreateInfo layout{VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};
    layout.pushConstantRangeCount = 1;
    layout.pPushConstantRanges = &push;
    layout.setLayoutCount = context_.ray_query ? 3 : 2;
    layout.pSetLayouts = sets.data();
    vk_check(vkCreatePipelineLayout(context_.device, &layout, nullptr, &layout_), "Create pipeline layout");
    const auto shader = [&](const auto& words) {
        VkShaderModuleCreateInfo info{VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO};
        info.codeSize = sizeof(words);
        info.pCode = words;
        VkShaderModule result;
        vk_check(vkCreateShaderModule(context_.device, &info, nullptr, &result), "Create shader");
        return result;
    };
    const auto vertex = shader(terrain_vert), fragment = shader(terrain_frag);
    const auto ray_fragment = context_.ray_query ? shader(terrain_rt_frag) : VkShaderModule{};
    std::array<VkPipelineShaderStageCreateInfo, 2> stages{};
    stages[0] = {VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO};
    stages[0].stage = VK_SHADER_STAGE_VERTEX_BIT;
    stages[0].module = vertex;
    stages[0].pName = "main";
    stages[1] = {VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO};
    stages[1].stage = VK_SHADER_STAGE_FRAGMENT_BIT;
    stages[1].module = fragment;
    stages[1].pName = "main";
    VkVertexInputBindingDescription binding{0, sizeof(Vertex), VK_VERTEX_INPUT_RATE_VERTEX};
    const std::array<VkVertexInputAttributeDescription, 6> attributes{
        {{0, 0, VK_FORMAT_R32G32B32_SFLOAT, offsetof(Vertex, x)},
         {1, 0, VK_FORMAT_R32G32B32_SFLOAT, offsetof(Vertex, r)},
         {2, 0, VK_FORMAT_R32G32_SFLOAT, offsetof(Vertex, s)},
         {3, 0, VK_FORMAT_R32G32_SFLOAT, offsetof(Vertex, ls)},
         {4, 0, VK_FORMAT_R32G32B32A32_SFLOAT, offsetof(Vertex, lx)},
         {5, 0, VK_FORMAT_R32G32B32_SFLOAT, offsetof(Vertex, nx)}}};
    VkPipelineVertexInputStateCreateInfo input{VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO};
    input.vertexBindingDescriptionCount = 1;
    input.pVertexBindingDescriptions = &binding;
    input.vertexAttributeDescriptionCount = 6;
    input.pVertexAttributeDescriptions = attributes.data();
    VkPipelineInputAssemblyStateCreateInfo assembly{VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO};
    assembly.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
    VkPipelineViewportStateCreateInfo viewport{VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO};
    viewport.viewportCount = 1;
    viewport.scissorCount = 1;
    VkPipelineRasterizationStateCreateInfo raster{VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO};
    raster.polygonMode = VK_POLYGON_MODE_FILL;
    raster.cullMode = VK_CULL_MODE_NONE;
    raster.lineWidth = 1;
    VkPipelineMultisampleStateCreateInfo multisample{VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO};
    multisample.rasterizationSamples = samples_;
    VkPipelineDepthStencilStateCreateInfo depth_state{VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO};
    depth_state.depthTestEnable = VK_TRUE;
    depth_state.depthWriteEnable = VK_TRUE;
    depth_state.depthCompareOp = VK_COMPARE_OP_GREATER_OR_EQUAL;
    VkPipelineColorBlendAttachmentState blend{};
    blend.colorWriteMask = 15;
    VkPipelineColorBlendStateCreateInfo blend_state{VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO};
    blend_state.attachmentCount = 1;
    blend_state.pAttachments = &blend;
    const std::array<VkDynamicState, 2> dynamic_states{VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR};
    VkPipelineDynamicStateCreateInfo dynamic{VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO};
    dynamic.dynamicStateCount = 2;
    dynamic.pDynamicStates = dynamic_states.data();
    VkGraphicsPipelineCreateInfo pipeline{VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO};
    pipeline.stageCount = 2;
    pipeline.pStages = stages.data();
    pipeline.pVertexInputState = &input;
    pipeline.pInputAssemblyState = &assembly;
    pipeline.pViewportState = &viewport;
    pipeline.pRasterizationState = &raster;
    pipeline.pMultisampleState = &multisample;
    pipeline.pDepthStencilState = &depth_state;
    pipeline.pColorBlendState = &blend_state;
    pipeline.pDynamicState = &dynamic;
    pipeline.layout = layout_;
    pipeline.renderPass = pass_;
    const auto pipeline_result = vkCreateGraphicsPipelines(context_.device, {}, 1, &pipeline, nullptr, &pipeline_);
    VkResult ray_result = VK_SUCCESS, ray_blend_result = VK_SUCCESS;
    if (ray_fragment) {
        stages[1].module = ray_fragment;
        ray_result = vkCreateGraphicsPipelines(context_.device, {}, 1, &pipeline, nullptr, &ray_pipeline_);
        stages[1].module = fragment;
    }
    VkResult blend_result = pipeline_result;
    if (pipeline_result == VK_SUCCESS) {
        blend.blendEnable = VK_TRUE;
        blend.srcColorBlendFactor = VK_BLEND_FACTOR_SRC_ALPHA;
        blend.dstColorBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
        blend.colorBlendOp = VK_BLEND_OP_ADD;
        blend.srcAlphaBlendFactor = VK_BLEND_FACTOR_ONE;
        blend.dstAlphaBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
        blend.alphaBlendOp = VK_BLEND_OP_ADD;
        depth_state.depthWriteEnable = VK_FALSE;
        blend_result = vkCreateGraphicsPipelines(context_.device, {}, 1, &pipeline, nullptr, &blend_pipeline_);
        if (ray_fragment) {
            stages[1].module = ray_fragment;
            ray_blend_result =
                vkCreateGraphicsPipelines(context_.device, {}, 1, &pipeline, nullptr, &ray_blend_pipeline_);
            stages[1].module = fragment;
        }
    }
    VkResult sprite_result = blend_result;
    if (blend_result == VK_SUCCESS) {
        blend.dstColorBlendFactor = VK_BLEND_FACTOR_ONE;
        blend.dstAlphaBlendFactor = VK_BLEND_FACTOR_ONE;
        depth_state.depthWriteEnable = VK_FALSE;
        sprite_result = vkCreateGraphicsPipelines(context_.device, {}, 1, &pipeline, nullptr, &sprite_pipeline_);
    }
    VkResult wake_result = sprite_result;
    if (sprite_result == VK_SUCCESS) {
        blend.dstColorBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
        blend.dstAlphaBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
        wake_result = vkCreateGraphicsPipelines(context_.device, {}, 1, &pipeline, nullptr, &wake_pipeline_);
    }
    VkResult sky_result = wake_result;
    if (wake_result == VK_SUCCESS) {
        blend.blendEnable = VK_FALSE;
        sky_result = vkCreateGraphicsPipelines(context_.device, {}, 1, &pipeline, nullptr, &sky_pipeline_);
    }
    VkResult line_result = sky_result;
    if (sky_result == VK_SUCCESS) {
        assembly.topology = VK_PRIMITIVE_TOPOLOGY_LINE_LIST;
        blend.blendEnable = VK_TRUE;
        line_result = vkCreateGraphicsPipelines(context_.device, {}, 1, &pipeline, nullptr, &line_pipeline_);
    }
    vk_check(line_result, "Create spline line pipeline");
    assembly.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
    depth_state.depthTestEnable = VK_FALSE;
    depth_state.depthWriteEnable = VK_FALSE;
    blend.blendEnable = VK_TRUE;
    blend.dstColorBlendFactor = blend.dstAlphaBlendFactor = VK_BLEND_FACTOR_ONE;
    vk_check(vkCreateGraphicsPipelines(context_.device, {}, 1, &pipeline, nullptr, &celestial_pipeline_),
             "Create celestial additive pipeline");
    blend.blendEnable = VK_FALSE;
    vk_check(vkCreateGraphicsPipelines(context_.device, {}, 1, &pipeline, nullptr, &hud_pipeline_),
             "Create HUD overlay pipeline");
    depth_state.depthTestEnable = VK_TRUE;
    vk_check(vkCreateGraphicsPipelines(context_.device, {}, 1, &pipeline, nullptr, &wrist_pipeline_),
             "Create depth-tested controller panel pipeline");
    if (offscreen) {
        auto attachment = resolve;
        attachment.format = format_;
        attachment.loadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE;
        attachment.samples = samples_;
        auto output_attachment = attachment;
        output_attachment.samples = VK_SAMPLE_COUNT_1_BIT;
        if (samples_ != VK_SAMPLE_COUNT_1_BIT)
            attachment.storeOp = VK_ATTACHMENT_STORE_OP_DONT_CARE;
        const std::array<VkAttachmentDescription, 2> present_attachments{attachment, output_attachment};
        const VkAttachmentReference present_resolve{1, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL};
        VkSubpassDescription present_subpass{};
        present_subpass.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS;
        present_subpass.colorAttachmentCount = 1;
        present_subpass.pColorAttachments = &colour_ref;
        if (samples_ != VK_SAMPLE_COUNT_1_BIT)
            present_subpass.pResolveAttachments = &present_resolve;
        VkRenderPassCreateInfo present_pass{VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO};
        present_pass.attachmentCount = samples_ == VK_SAMPLE_COUNT_1_BIT ? 1 : 2;
        present_pass.pAttachments = present_attachments.data();
        present_pass.subpassCount = 1;
        present_pass.pSubpasses = &present_subpass;
        present_pass.dependencyCount = 1;
        present_pass.pDependencies = &dependency;
        vk_check(vkCreateRenderPass(context_.device, &present_pass, nullptr, &presentation_pass_),
                 "Create native-resolution presentation pass");
        pipeline.renderPass = presentation_pass_;
        multisample.rasterizationSamples = samples_;
        depth_state.depthTestEnable = VK_FALSE;
        vk_check(vkCreateGraphicsPipelines(context_.device, {}, 1, &pipeline, nullptr, &presentation_pipeline_),
                 "Create scene downsampling pipeline");
        vk_check(vkCreateGraphicsPipelines(context_.device, {}, 1, &pipeline, nullptr, &presentation_hud_),
                 "Create native-resolution UI pipeline");
        pipeline.renderPass = pass_;
        multisample.rasterizationSamples = samples_;
        depth_state.depthTestEnable = VK_TRUE;
        const VkDescriptorPoolSize pool_size{VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, unsigned(images.size() * 2)};
        VkDescriptorPoolCreateInfo pool{VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO};
        pool.maxSets = unsigned(images.size());
        pool.poolSizeCount = 1;
        pool.pPoolSizes = &pool_size;
        vk_check(vkCreateDescriptorPool(context_.device, &pool, nullptr, &presentation_pool_),
                 "Create scene presentation descriptors");
        VkSamplerCreateInfo sampler{VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO};
        sampler.magFilter = sampler.minFilter = VK_FILTER_LINEAR;
        sampler.mipmapMode = VK_SAMPLER_MIPMAP_MODE_NEAREST;
        sampler.addressModeU = sampler.addressModeV = sampler.addressModeW = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
        vk_check(vkCreateSampler(context_.device, &sampler, nullptr, &presentation_sampler_),
                 "Create scene downsampling sampler");
        if (!presentation_vertices_.buffer) {
            std::array<Vertex, 6> vertices{};
            const std::array<std::array<float, 2>, 6> corners{{{-1, -1}, {1, -1}, {1, 1}, {-1, -1}, {1, 1}, {-1, 1}}};
            for (unsigned i = 0; i < vertices.size(); ++i) {
                auto& v = vertices[i];
                v.x = corners[i][0];
                v.y = corners[i][1];
                v.s = (v.x + 1) * .5f;
                v.t = (v.y + 1) * .5f;
            }
            presentation_vertices_ =
                create_buffer(sizeof(vertices), VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, vertices.data());
        }
    }
    const auto snow_vertex = shader(snow_vert), snow_fragment = shader(snow_frag);
    auto snow_stages = stages;
    snow_stages[0].module = snow_vertex;
    snow_stages[1].module = snow_fragment;
    const VkVertexInputBindingDescription snow_binding{0, sizeof(SnowFlake), VK_VERTEX_INPUT_RATE_INSTANCE};
    const std::array<VkVertexInputAttributeDescription, 2> snow_attributes{
        {{0, 0, VK_FORMAT_R32G32B32_SFLOAT, offsetof(SnowFlake, base)},
         {1, 0, VK_FORMAT_R32G32B32A32_SFLOAT, offsetof(SnowFlake, random)}}};
    VkPipelineVertexInputStateCreateInfo snow_input{VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO};
    snow_input.vertexBindingDescriptionCount = 1;
    snow_input.pVertexBindingDescriptions = &snow_binding;
    snow_input.vertexAttributeDescriptionCount = 2;
    snow_input.pVertexAttributeDescriptions = snow_attributes.data();
    auto snow_pipeline = pipeline;
    snow_pipeline.pStages = snow_stages.data();
    snow_pipeline.pVertexInputState = &snow_input;
    blend.blendEnable = VK_TRUE;
    blend.srcColorBlendFactor = blend.srcAlphaBlendFactor = VK_BLEND_FACTOR_ONE;
    blend.dstColorBlendFactor = blend.dstAlphaBlendFactor = VK_BLEND_FACTOR_ONE;
    const auto snow_result =
        vkCreateGraphicsPipelines(context_.device, {}, 1, &snow_pipeline, nullptr, &snow_pipeline_);
    vkDestroyShaderModule(context_.device, snow_vertex, nullptr);
    vkDestroyShaderModule(context_.device, snow_fragment, nullptr);
    vk_check(snow_result, "Create instanced snowfall pipeline");
    vkDestroyShaderModule(context_.device, vertex, nullptr);
    vkDestroyShaderModule(context_.device, fragment, nullptr);
    if (ray_fragment)
        vkDestroyShaderModule(context_.device, ray_fragment, nullptr);
    if (ray_result != VK_SUCCESS || ray_blend_result != VK_SUCCESS) {
        ray_failed_ = true;
        std::cerr << "Ray shadow pipelines unavailable; using enhanced lighting without traced shadows\n";
    }
    vk_check(pipeline_result, "Create terrain pipeline");
    vk_check(blend_result, "Create prop blend pipeline");
    vk_check(sprite_result, "Create additive sprite pipeline");
    vk_check(sky_result, "Create sky panorama pipeline");
    vk_check(wake_result, "Create alpha wake pipeline");
    for (auto image : images) {
        targets_.push_back({});
        auto& target = targets_.back();
        target.colour = image;
        VkImageViewCreateInfo view_info{VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO};
        view_info.image = image;
        view_info.viewType = VK_IMAGE_VIEW_TYPE_2D;
        view_info.format = format;
        view_info.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
        vk_check(vkCreateImageView(context_.device, &view_info, nullptr, &target.colour_view), "Create colour view");
        if (offscreen) {
            VkImageCreateInfo info{VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO};
            info.imageType = VK_IMAGE_TYPE_2D;
            info.format = scene_format_;
            info.extent = {render_width_, render_height_, 1};
            info.mipLevels = info.arrayLayers = 1;
            info.samples = VK_SAMPLE_COUNT_1_BIT;
            info.tiling = VK_IMAGE_TILING_OPTIMAL;
            info.usage = scene_usage;
            vk_check(vkCreateImage(context_.device, &info, nullptr, &target.resolved), "Create scaled scene image");
            VkMemoryRequirements requirements;
            vkGetImageMemoryRequirements(context_.device, target.resolved, &requirements);
            VkMemoryAllocateInfo allocation{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
            allocation.allocationSize = requirements.size;
            allocation.memoryTypeIndex = memory_type(requirements.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
            vk_check(vkAllocateMemory(context_.device, &allocation, nullptr, &target.resolved_memory),
                     "Allocate scaled scene");
            vk_check(vkBindImageMemory(context_.device, target.resolved, target.resolved_memory, 0),
                     "Bind scaled scene");
            view_info.image = target.resolved;
            view_info.format = scene_format_;
            vk_check(vkCreateImageView(context_.device, &view_info, nullptr, &target.resolved_view),
                     "Create scaled scene view");
            VkDescriptorSetAllocateInfo allocate{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO};
            allocate.descriptorPool = presentation_pool_;
            allocate.descriptorSetCount = 1;
            allocate.pSetLayouts = &scene_->descriptors_;
            vk_check(vkAllocateDescriptorSets(context_.device, &allocate, &target.presentation_set),
                     "Allocate scene descriptor");
            const VkDescriptorImageInfo texture{presentation_sampler_, target.resolved_view,
                                                VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL};
            std::array<VkWriteDescriptorSet, 2> writes{};
            for (unsigned i = 0; i < writes.size(); ++i) {
                writes[i] = {VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET};
                writes[i].dstSet = target.presentation_set;
                writes[i].dstBinding = i;
                writes[i].descriptorCount = 1;
                writes[i].descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
                writes[i].pImageInfo = &texture;
            }
            vkUpdateDescriptorSets(context_.device, unsigned(writes.size()), writes.data(), 0, nullptr);
            if (samples_ != VK_SAMPLE_COUNT_1_BIT) {
                auto native_info = info;
                native_info.format = format_;
                native_info.extent = {width_, height_, 1};
                native_info.samples = samples_;
                native_info.usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;
                vk_check(vkCreateImage(context_.device, &native_info, nullptr, &target.presentation_multisample),
                         "Create native-resolution UI multisample image");
                vkGetImageMemoryRequirements(context_.device, target.presentation_multisample, &requirements);
                allocation.allocationSize = requirements.size;
                allocation.memoryTypeIndex =
                    memory_type(requirements.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
                vk_check(vkAllocateMemory(context_.device, &allocation, nullptr, &target.presentation_memory),
                         "Allocate native-resolution UI multisample image");
                vk_check(
                    vkBindImageMemory(context_.device, target.presentation_multisample, target.presentation_memory, 0),
                    "Bind native-resolution UI multisample image");
                view_info.image = target.presentation_multisample;
                view_info.format = format_;
                vk_check(vkCreateImageView(context_.device, &view_info, nullptr, &target.presentation_view),
                         "Create native-resolution UI multisample view");
            }
            const std::array<VkImageView, 2> native_views{
                samples_ == VK_SAMPLE_COUNT_1_BIT ? target.colour_view : target.presentation_view, target.colour_view};
            VkFramebufferCreateInfo framebuffer{VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO};
            framebuffer.renderPass = presentation_pass_;
            framebuffer.attachmentCount = samples_ == VK_SAMPLE_COUNT_1_BIT ? 1 : 2;
            framebuffer.pAttachments = native_views.data();
            framebuffer.width = width_;
            framebuffer.height = height_;
            framebuffer.layers = 1;
            vk_check(vkCreateFramebuffer(context_.device, &framebuffer, nullptr, &target.presentation_framebuffer),
                     "Create native-resolution presentation framebuffer");
        }
        VkImageCreateInfo depth_info{VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO};
        depth_info.imageType = VK_IMAGE_TYPE_2D;
        depth_info.format = VK_FORMAT_D32_SFLOAT;
        depth_info.extent = {render_width_, render_height_, 1};
        depth_info.mipLevels = 1;
        depth_info.arrayLayers = 1;
        depth_info.samples = samples_;
        depth_info.tiling = VK_IMAGE_TILING_OPTIMAL;
        depth_info.usage = VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT;
        vk_check(vkCreateImage(context_.device, &depth_info, nullptr, &target.depth), "Create depth image");
        VkMemoryRequirements memory;
        vkGetImageMemoryRequirements(context_.device, target.depth, &memory);
        VkMemoryAllocateInfo allocation{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
        allocation.allocationSize = memory.size;
        allocation.memoryTypeIndex = memory_type(memory.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
        vk_check(vkAllocateMemory(context_.device, &allocation, nullptr, &target.depth_memory),
                 "Allocate depth memory");
        vk_check(vkBindImageMemory(context_.device, target.depth, target.depth_memory, 0), "Bind depth memory");
        view_info.image = target.depth;
        view_info.format = VK_FORMAT_D32_SFLOAT;
        view_info.subresourceRange.aspectMask = VK_IMAGE_ASPECT_DEPTH_BIT;
        vk_check(vkCreateImageView(context_.device, &view_info, nullptr, &target.depth_view), "Create depth view");
        if (samples_ != VK_SAMPLE_COUNT_1_BIT) {
            auto info = depth_info;
            info.format = scene_format_;
            info.usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;
            vk_check(vkCreateImage(context_.device, &info, nullptr, &target.multisample), "Create multisample colour");
            vkGetImageMemoryRequirements(context_.device, target.multisample, &memory);
            allocation.allocationSize = memory.size;
            allocation.memoryTypeIndex = memory_type(memory.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
            vk_check(vkAllocateMemory(context_.device, &allocation, nullptr, &target.multisample_memory),
                     "Allocate multisample colour");
            vk_check(vkBindImageMemory(context_.device, target.multisample, target.multisample_memory, 0),
                     "Bind multisample colour");
            view_info.image = target.multisample;
            view_info.format = scene_format_;
            view_info.subresourceRange.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT;
            vk_check(vkCreateImageView(context_.device, &view_info, nullptr, &target.multisample_view),
                     "Create multisample colour view");
        }
        const auto resolved_view = target.resolved_view ? target.resolved_view : target.colour_view;
        const std::array<VkImageView, 3> views{samples_ == VK_SAMPLE_COUNT_1_BIT ? resolved_view
                                                                                 : target.multisample_view,
                                               target.depth_view, resolved_view};
        VkFramebufferCreateInfo framebuffer{VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO};
        framebuffer.renderPass = pass_;
        framebuffer.attachmentCount = pass.attachmentCount;
        framebuffer.pAttachments = views.data();
        framebuffer.width = render_width_;
        framebuffer.height = render_height_;
        framebuffer.layers = 1;
        vk_check(vkCreateFramebuffer(context_.device, &framebuffer, nullptr, &target.framebuffer),
                 "Create framebuffer");
    }
}

void VulkanRenderer::render(unsigned image, const Matrix& camera, const Matrix& board, VkImageLayout final_layout,
                            VkSemaphore wait, VkSemaphore signal, Vec3 eye, std::span<const Sprite> sprites,
                            std::span<const WakeVertex> wake, std::span<const SprayVertex> sheet,
                            std::span<const Vertex> avatar, float fade, std::span<const std::uint8_t> instance_flags,
                            std::span<const PropMotion> motions, double alpha, std::span<const PropRouteMotion> routes,
                            std::span<const PropTextureFrame> texture_frames, std::span<const BoostTrailVertex> boost,
                            std::span<const ParticleSprite> particles, CelestialView glare_view,
                            std::span<const Vertex> hud, bool screen_hud, SnowfallView snow, const LampView* lamps,
                            std::span<const Matrix> opponents, std::span<const Vertex> shadow_casters) {
    if (opponents.size() > 16)
        throw std::invalid_argument("Too many opponent boards");
    for (const auto& opponent : opponents)
        for (const auto value : opponent.values)
            if (!std::isfinite(value))
                throw std::invalid_argument("Invalid opponent board transform");
    if (!finite(snow.eye) || !std::isfinite(snow.time) || snow.time < 0 || snow.time > 1e9)
        throw std::invalid_argument("Invalid snowfall view");
    const auto weather = snow_settings(snow.amount);
    if (boost.size() > 17 * 84 || boost.size() % 12)
        throw std::invalid_argument("Boost trail submission exceeds its history bound");
    for (const auto& point : boost) {
        if (!finite(point.position) ||
            std::max({std::abs(point.position.x), std::abs(point.position.y), std::abs(point.position.z)}) > 1e9)
            throw std::invalid_argument("Invalid boost trail vertex");
        for (const auto channel : point.colour)
            if (!std::isfinite(channel) || channel < 0 || channel > 1)
                throw std::invalid_argument("Invalid boost trail colour");
    }
    if (!instance_flags.empty() && (!scene_ || instance_flags.size() != scene_->props_.instances.size()))
        throw std::invalid_argument("World instance flags disagree with rendered props");
    if (!std::isfinite(alpha) || alpha < 0 || alpha > 1)
        throw std::invalid_argument("Invalid motion interpolation");
    std::vector<const PropMotion*> moving;
    if (!motions.empty()) {
        if (!scene_)
            throw std::invalid_argument("Prop motion has no scene");
        moving.resize(scene_->props_.instances.size());
        for (const auto& motion : motions) {
            if (motion.instance >= moving.size() || moving[motion.instance] ||
                motion.current.size() != motion.previous.size())
                throw std::invalid_argument("Invalid prop motion binding");
            for (const auto* frames : {&motion.current, &motion.previous})
                for (const auto& transform : *frames) {
                    for (const auto value : transform)
                        if (!std::isfinite(value))
                            throw std::invalid_argument("Invalid prop motion transform");
                    static_cast<void>(inverse_transform(transform));
                }
            for (const auto part : scene_->props_.models[scene_->props_.instances[motion.instance].model].parts)
                if (scene_->props_.parts[part].object >= motion.current.size())
                    throw std::invalid_argument("Prop motion misses model objects");
            moving[motion.instance] = &motion;
        }
    }
    std::vector<const PropRouteMotion*> route_by_instance;
    std::size_t required_poses = scene_ ? scene_->pose_capacity_ : 0, line_vertices = 0;
    if (!routes.empty()) {
        if (!scene_)
            throw std::invalid_argument("Spline motion has no scene");
        route_by_instance.resize(scene_->props_.instances.size());
        for (const auto& route : routes) {
            if (route.instance >= route_by_instance.size() || route_by_instance[route.instance] ||
                route.current.empty() || route.current.size() > 1024 || route.current.size() != route.previous.size())
                throw std::invalid_argument("Invalid spline copy binding");
            for (const auto* frames : {&route.previous, &route.current})
                for (const auto& transform : *frames) {
                    for (const auto value : transform)
                        if (!std::isfinite(value))
                            throw std::invalid_argument("Invalid spline copy pose");
                    static_cast<void>(inverse_transform(transform));
                }
            for (const auto& line : route.lines) {
                for (const auto point : line.points)
                    if (!finite(point))
                        throw std::invalid_argument("Invalid spline line point");
                for (const auto c : line.colour)
                    if (!std::isfinite(c) || c < 0 || c > 1)
                        throw std::invalid_argument("Invalid spline line colour");
                line_vertices += 20;
                if (line_vertices > 1000000)
                    throw std::invalid_argument("Spline lines exceed vertex limit");
            }
            required_poses += (route.current.size() - 1) *
                              scene_->props_.models[scene_->props_.instances[route.instance].model].parts.size();
            route_by_instance[route.instance] = &route;
        }
        VkPhysicalDeviceProperties limits;
        vkGetPhysicalDeviceProperties(context_.physical, &limits);
        if (required_poses > 1000000 || required_poses * sizeof(PropPose) > limits.limits.maxStorageBufferRange)
            throw std::invalid_argument("Spline copies exceed GPU placement limit");
    }
    constexpr auto base_frame = PropTextureFrame::resting;
    std::vector<const PropTextureFrame*> frames;
    if (!texture_frames.empty()) {
        if (!scene_)
            throw std::invalid_argument("Texture frame has no scene");
        frames.resize(scene_->props_.instances.size());
        for (const auto& state : texture_frames) {
            if (state.instance >= frames.size() || frames[state.instance] ||
                (state.frame != base_frame && (state.frame > 4095 || (state.crowd && state.frame > 15))))
                throw std::invalid_argument("Invalid prop texture frame binding");
            for (const auto value : state.uv)
                if (!std::isfinite(value) || std::abs(value) > 1e6)
                    throw std::invalid_argument("Invalid prop UV phase");
            const auto& model = scene_->props_.models[scene_->props_.instances[state.instance].model];
            if (state.materials.size() > model.parts.size())
                throw std::invalid_argument("Too many prop material frame bindings");
            for (std::size_t i = 0; i < state.materials.size(); ++i) {
                const auto& material = state.materials[i];
                if (material.frame > 4095 || (state.crowd && material.frame > 15) ||
                    std::any_of(state.materials.begin(), state.materials.begin() + i,
                                [&](const auto& earlier) { return earlier.material == material.material; }) ||
                    std::none_of(model.parts.begin(), model.parts.end(), [&](const auto part) {
                        return scene_->props_.parts[part].material == material.material;
                    }))
                    throw std::invalid_argument("Invalid prop material frame binding");
            }
            if (state.wave) {
                static_cast<void>(flag_pose(scene_->props_.instances[state.instance].pose, *state.wave));
                if (std::none_of(model.parts.begin(), model.parts.end(),
                                 [&](const auto part) { return scene_->props_.parts[part].wave_count != 0; }))
                    throw std::invalid_argument("Flag model was not prepared for waves");
            }
            frames[state.instance] = &state;
        }
    }
    if (!std::isfinite(fade) || fade < 0 || fade > 1)
        throw std::invalid_argument("Invalid scene fade");
    if (hud.size() > 120000 || hud.size() % 3)
        throw std::invalid_argument("HUD submission exceeds bounds");
    for (const auto& v : hud)
        if (!finite({v.x, v.y, v.z}) || !std::isfinite(v.r) || !std::isfinite(v.g) || !std::isfinite(v.b))
            throw std::invalid_argument("Invalid HUD vertex");
    glare_view.clip = camera.values;
    if (!glare_view.stereo)
        glare_view.anchor = eye;
    auto celestial = celestial_mesh(glare(), glare_view);
    const auto glints = lamp_glint_mesh(scene_->world_.glints, camera.values, eye, width_, height_, 600, lamps);
    const auto fan_count = celestial.fan.size();
    celestial.fan.insert(celestial.fan.end(), celestial.corona.begin(), celestial.corona.end());
    const auto visibility = 1 - fade;
    const auto started = std::chrono::steady_clock::now();
    finish();
    reserve_poses(required_poses);
    bool ray_active = ray_shadows_active();
    if (ray_active) {
        try {
            if (!scene_->ray_geometry_)
                scene_->ray_geometry_ =
                    std::make_shared<RayGeometry>(context_, scene_->vertices_.buffer, scene_->indices_.buffer,
                                                  scene_->vertex_count_, scene_->ray_meshes_);
            if (ray_geometry_ != scene_->ray_geometry_) {
                ray_world_ = std::make_unique<RayWorld>(context_, scene_->ray_geometry_);
                ray_geometry_ = scene_->ray_geometry_;
            }
        } catch (const std::exception& e) {
            ray_failed_ = true;
            ray_active = false;
            std::cerr << "Ray shadows unavailable: " << e.what() << "; using enhanced lighting\n";
        }
    }
    auto lighting = lighting_mode_ == LightingMode::Runtime    ? runtime_lighting(scene_->world_, eye)
                    : lighting_mode_ == LightingMode::Enhanced ? enhanced_lighting(scene_->world_, eye)
                                                               : LightingUniform{};
    lighting.settings[0] = float(lighting_mode_);
    lighting.settings[2] = hdr_ ? 1.f : 0.f;
    if (weather.flakes && !snow_vertices_.buffer) {
        const auto flakes = snow_flakes();
        snow_vertices_ =
            create_buffer(flakes.size() * sizeof(SnowFlake), VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, flakes.data());
    }
    const auto previous_gpu = stats_.gpu_ms;
    stats_ = {};
    if (deferred_)
        stats_.gpu_ms = previous_gpu;
    stats_.wait_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    vk_check(vkResetFences(context_.device, 1, &fence_), "Reset render fence");
    vk_check(vkResetCommandBuffer(command_, 0), "Reset draw command");
    const auto cull_start = std::chrono::steady_clock::now();
    terrain_draws_.clear();
    packed_indices_.clear();
    stats_.terrain_patches = unsigned(scene_->terrain_ranges_.size());
    stats_.terrain_total_indices = scene_->terrain_total_indices_;
    bool compact = false;
    stats_.visible_terrain = stats_.terrain_patches;
    if (!scene_->terrain_ranges_.empty()) {
        const ViewRange range(eye, terrain_draw_distance);
        if (terrain_culling_)
            scene_->terrain_visibility_.query(Frustum(camera.values), visible_ranges_, stats_.visibility_tests, &range);
        else
            scene_->terrain_visibility_.query(range, visible_ranges_, stats_.visibility_tests);
        stats_.visible_terrain = unsigned(visible_ranges_.size());
        std::uint64_t retained = 0;
        for (const auto id : visible_ranges_)
            retained += scene_->terrain_ranges_[id].count;
        // A dense-view fallback must not reintroduce out-of-range terrain.
        compact = retained < scene_->terrain_total_indices_;
    }
    stats_.terrain_compacted = compact;
    if (compact) {
        for (const auto id : visible_ranges_) {
            const auto& range = scene_->terrain_ranges_[id];
            if (terrain_draws_.empty() || terrain_draws_.back().material != range.batch)
                terrain_draws_.push_back({std::uint32_t(packed_indices_.size()), 0, range.batch});
            terrain_draws_.back().count += range.count;
            packed_indices_.insert(packed_indices_.end(), scene_->terrain_indices_.begin() + range.first,
                                   scene_->terrain_indices_.begin() + range.first + range.count);
        }
        if (packed_indices_.size() > index_capacity_) {
            destroy_buffer(visible_indices_);
            index_capacity_ =
                std::min(scene_->terrain_indices_.size(), std::max(packed_indices_.size(), index_capacity_ * 2));
            visible_indices_ =
                create_buffer(index_capacity_ * sizeof(std::uint32_t), VK_BUFFER_USAGE_INDEX_BUFFER_BIT, nullptr);
        }
        if (!packed_indices_.empty()) {
            void* mapped;
            vk_check(vkMapMemory(context_.device, visible_indices_.memory, 0,
                                 packed_indices_.size() * sizeof(std::uint32_t), 0, &mapped),
                     "Map visible terrain indices");
            std::memcpy(mapped, packed_indices_.data(), packed_indices_.size() * sizeof(std::uint32_t));
            vkUnmapMemory(context_.device, visible_indices_.memory);
        }
        stats_.terrain_indices = packed_indices_.size();
    } else {
        stats_.terrain_indices = stats_.terrain_total_indices;
        for (std::size_t i = 0; i < scene_->draws_.size(); ++i) {
            const auto& draw = scene_->draws_[i];
            terrain_draws_.push_back({draw.first, draw.count, i});
        }
    }
    stats_.terrain_draws = unsigned(terrain_draws_.size());
    stats_.cull_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - cull_start).count();
    auto& sprite_mesh = sprite_mesh_;
    sprite_mesh.clear();
    if (scene_->effect_set_ && !sprites.empty()) {
        if (sprites.size() > 1024)
            throw std::runtime_error("Sprite submission exceeds its fixed pool limit");
        sprite_mesh.reserve(sprites.size() * 6);
        for (const auto& sprite : sprites) {
            if (!finite(sprite.position) || !std::isfinite(sprite.radius) || !std::isfinite(sprite.alpha) ||
                !std::isfinite(sprite.rotation) || sprite.radius < 0 || sprite.radius > 100 || sprite.alpha < 0 ||
                sprite.alpha > 1)
                throw std::runtime_error("Invalid sprite submission");
            if (sprite.alpha <= 0 || sprite.radius <= 0)
                continue;
            for (const auto uv :
                 std::array<std::array<float, 2>, 6>{{{0, 0}, {1, 0}, {1, 1}, {0, 0}, {1, 1}, {0, 1}}}) {
                Vertex v{float(sprite.position.x), float(sprite.position.y), float(sprite.position.z), 1, 1, 1};
                v.s = uv[0];
                v.t = uv[1];
                v.ls = sprite.radius;
                v.lt = sprite.rotation;
                v.lx = sprite.alpha;
                sprite_mesh.push_back(v);
            }
            ++stats_.sprites;
        }
        if (sprite_mesh.size() > sprite_capacity_) {
            destroy_buffer(sprite_vertices_);
            sprite_capacity_ = std::min(std::size_t(6144), std::max(sprite_mesh.size(), sprite_capacity_ * 2));
            sprite_vertices_ =
                create_buffer(sprite_capacity_ * sizeof(Vertex), VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, nullptr);
        }
        if (!sprite_mesh.empty()) {
            void* mapped;
            vk_check(vkMapMemory(context_.device, sprite_vertices_.memory, 0, sprite_mesh.size() * sizeof(Vertex), 0,
                                 &mapped),
                     "Map billboard vertices");
            std::memcpy(mapped, sprite_mesh.data(), sprite_mesh.size() * sizeof(Vertex));
            vkUnmapMemory(context_.device, sprite_vertices_.memory);
        }
    }
    particle_mesh_.clear();
    particle_draws_.clear();
    if (particles.size() > WorldParticles::maximum_sprites)
        throw std::runtime_error("World particle submission exceeds its bound");
    std::vector<const ParticleSprite*> ordered;
    ordered.reserve(particles.size());
    for (const auto& p : particles) {
        if (!finite(p.position) || !std::isfinite(p.radius) || p.radius < 0 || p.radius > 100)
            throw std::runtime_error("Invalid world particle geometry");
        for (auto c : p.colour)
            if (!std::isfinite(c) || c < 0 || c > 1)
                throw std::runtime_error("Invalid world particle colour");
        if (p.texture < scene_->particle_sets_.size() && scene_->particle_sets_[p.texture] && p.radius > 0 &&
            p.colour[3] > 0)
            ordered.push_back(&p);
    }
    std::stable_sort(ordered.begin(), ordered.end(), [&](auto a, auto b) {
        const bool aa = a->blend == ParticleBlend::Additive, ba = b->blend == ParticleBlend::Additive;
        if (aa != ba)
            return aa;
        if (aa)
            return a->texture < b->texture;
        return dot(a->position - eye, a->position - eye) > dot(b->position - eye, b->position - eye);
    });
    particle_mesh_.reserve(ordered.size() * 6);
    for (const auto* particle : ordered) {
        const auto& p = *particle;
        const auto first = std::uint32_t(particle_mesh_.size());
        for (const auto uv : std::array<std::array<float, 2>, 6>{{{0, 0}, {1, 0}, {1, 1}, {0, 0}, {1, 1}, {0, 1}}}) {
            const bool dark = p.blend == ParticleBlend::Darken;
            Vertex v{float(p.position.x),    float(p.position.y),    float(p.position.z),
                     dark ? 0 : p.colour[0], dark ? 0 : p.colour[1], dark ? 0 : p.colour[2]};
            v.s = uv[0];
            v.t = uv[1];
            v.ls = p.radius;
            v.lx = p.colour[3];
            particle_mesh_.push_back(v);
        }
        if (!particle_draws_.empty() && particle_draws_.back().texture == p.texture &&
            particle_draws_.back().blend == p.blend)
            particle_draws_.back().count += 6;
        else
            particle_draws_.push_back({first, 6, p.texture, p.blend});
    }
    stats_.world_sprites = unsigned(ordered.size());
    if (!particle_mesh_.empty()) {
        if (particle_mesh_.size() > particle_capacity_) {
            destroy_buffer(particle_vertices_);
            particle_capacity_ =
                std::min(WorldParticles::maximum_sprites * 6, std::max(particle_mesh_.size(), particle_capacity_ * 2));
            particle_vertices_ =
                create_buffer(particle_capacity_ * sizeof(Vertex), VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, nullptr);
        }
        void* mapped;
        vk_check(vkMapMemory(context_.device, particle_vertices_.memory, 0, particle_mesh_.size() * sizeof(Vertex), 0,
                             &mapped),
                 "Map world particles");
        std::memcpy(mapped, particle_mesh_.data(), particle_mesh_.size() * sizeof(Vertex));
        vkUnmapMemory(context_.device, particle_vertices_.memory);
    }
    wake_mesh_.clear();
    if (scene_->wake_set_ && !wake.empty()) {
        if (wake.size() > 594 || wake.size() % 6)
            throw std::runtime_error("Wake submission exceeds its section limit");
        wake_mesh_.reserve(wake.size());
        for (const auto& point : wake) {
            if (!finite(point.position) || !finite(point.normal) || !std::isfinite(point.across) ||
                !std::isfinite(point.along) || !std::isfinite(point.alpha) || point.alpha < 0 || point.alpha > 1)
                throw std::runtime_error("Invalid wake submission");
            Vertex v{float(point.position.x), float(point.position.y), float(point.position.z), 1, 1, 1};
            v.s = point.across;
            v.t = point.along;
            v.ls = point.alpha;
            v.nx = float(point.normal.x);
            v.ny = float(point.normal.y);
            v.nz = float(point.normal.z);
            wake_mesh_.push_back(v);
        }
        if (wake_mesh_.size() > wake_capacity_) {
            destroy_buffer(wake_vertices_);
            wake_capacity_ = std::min(std::size_t(594), std::max(wake_mesh_.size(), wake_capacity_ * 2));
            wake_vertices_ = create_buffer(wake_capacity_ * sizeof(Vertex), VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, nullptr);
        }
        void* mapped;
        vk_check(vkMapMemory(context_.device, wake_vertices_.memory, 0, wake_mesh_.size() * sizeof(Vertex), 0, &mapped),
                 "Map wake vertices");
        std::memcpy(mapped, wake_mesh_.data(), wake_mesh_.size() * sizeof(Vertex));
        vkUnmapMemory(context_.device, wake_vertices_.memory);
        stats_.wake_segments = unsigned(wake.size() / 6);
    }
    constexpr std::size_t maximum_avatar_vertices = 120000 + 16 * 30000;
    const bool runtime = lighting_mode_ == LightingMode::Runtime;
    const bool dynamic_boards = runtime || board_lighting_;
    board_mesh_.clear();
    if (dynamic_boards) {
        const auto& gear = snowboard_mesh();
        const auto append = [&](const Matrix& frame, unsigned design) {
            const auto& m = frame.values;
            const auto light = runtime ? SceneLight{} : board_lighting_->sample({m[12], m[13], m[14]});
            for (const auto index : gear.indices) {
                auto v = gear.vertices[index];
                const Vec3 normal{m[0] * v.nx + m[4] * v.ny + m[8] * v.nz, m[1] * v.nx + m[5] * v.ny + m[9] * v.nz,
                                  m[2] * v.nx + m[6] * v.ny + m[10] * v.nz};
                const bool stock = design < stock_board_count;
                if (runtime) {
                    const Vec3 position{m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12],
                                        m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13],
                                        m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14]};
                    v.x = float(position.x);
                    v.y = float(position.y);
                    v.z = float(position.z);
                    v.nx = float(normal.x);
                    v.ny = float(normal.y);
                    v.nz = float(normal.z);
                } else {
                    const auto illumination = light.evaluate(normal);
                    v.r = float(illumination.x) * (stock ? 1.f : v.r);
                    v.g = float(illumination.y) * (stock ? 1.f : v.g);
                    v.b = float(illumination.z) * (stock ? 1.f : v.b);
                }
                board_mesh_.push_back(v);
            }
        };
        append(board, board_design_);
        for (std::size_t i = 0; i < opponents.size(); ++i)
            append(opponents[i], i < opponent_designs_.size() ? opponent_designs_[i] : board_design_);
        if (board_mesh_.size() > board_capacity_) {
            destroy_buffer(board_vertices_);
            board_capacity_ = board_mesh_.size();
            board_vertices_ =
                create_buffer(board_capacity_ * sizeof(Vertex), VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, nullptr);
        }
        void* mapped;
        vk_check(
            vkMapMemory(context_.device, board_vertices_.memory, 0, board_mesh_.size() * sizeof(Vertex), 0, &mapped),
            "Map scene-lit boards");
        std::memcpy(mapped, board_mesh_.data(), board_mesh_.size() * sizeof(Vertex));
        vkUnmapMemory(context_.device, board_vertices_.memory);
    }
    if (avatar.size() > maximum_avatar_vertices || avatar.size() % 3)
        throw std::runtime_error("Avatar submission exceeds bounds");
    for (const auto& v : avatar)
        if (!finite({v.x, v.y, v.z}) || !std::isfinite(v.r) || !std::isfinite(v.g) || !std::isfinite(v.b))
            throw std::runtime_error("Invalid avatar vertex");
    if (!avatar.empty()) {
        if (avatar.size() > avatar_capacity_) {
            destroy_buffer(avatar_vertices_);
            avatar_capacity_ = std::min(maximum_avatar_vertices, std::max(avatar.size(), avatar_capacity_ * 2));
            avatar_vertices_ =
                create_buffer(avatar_capacity_ * sizeof(Vertex), VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, nullptr);
        }
        void* mapped;
        vk_check(vkMapMemory(context_.device, avatar_vertices_.memory, 0, avatar.size() * sizeof(Vertex), 0, &mapped),
                 "Map avatar vertices");
        std::memcpy(mapped, avatar.data(), avatar.size() * sizeof(Vertex));
        vkUnmapMemory(context_.device, avatar_vertices_.memory);
    }
    stats_.avatar_triangles = unsigned(avatar.size() / 3);
    const auto upload_dynamic = [&](std::span<const Vertex> vertices, Buffer& buffer, std::size_t& capacity) {
        if (vertices.empty())
            return;
        if (vertices.size() > capacity) {
            destroy_buffer(buffer);
            capacity = vertices.size();
            buffer = create_buffer(capacity * sizeof(Vertex), VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, nullptr);
        }
        void* mapped;
        vk_check(vkMapMemory(context_.device, buffer.memory, 0, vertices.size() * sizeof(Vertex), 0, &mapped),
                 "Map celestial/HUD vertices");
        std::memcpy(mapped, vertices.data(), vertices.size() * sizeof(Vertex));
        vkUnmapMemory(context_.device, buffer.memory);
    };
    upload_dynamic(celestial.fan, celestial_vertices_, celestial_capacity_);
    upload_dynamic(hud, hud_vertices_, hud_capacity_);
    upload_dynamic(glints, glint_vertices_, glint_capacity_);
    stats_.lamp_glints = unsigned(glints.size() / 30);
    boost_mesh_.clear();
    boost_mesh_.reserve(boost.size());
    for (const auto& point : boost) {
        Vertex v{float(point.position.x), float(point.position.y), float(point.position.z),
                 point.colour[0],         point.colour[1],         point.colour[2]};
        v.ls = point.colour[3];
        boost_mesh_.push_back(v);
    }
    if (!boost_mesh_.empty()) {
        if (boost_mesh_.size() > boost_capacity_) {
            destroy_buffer(boost_vertices_);
            boost_capacity_ = boost_mesh_.size();
            boost_vertices_ =
                create_buffer(boost_capacity_ * sizeof(Vertex), VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, nullptr);
        }
        void* mapped;
        vk_check(
            vkMapMemory(context_.device, boost_vertices_.memory, 0, boost_mesh_.size() * sizeof(Vertex), 0, &mapped),
            "Map boost trail vertices");
        std::memcpy(mapped, boost_mesh_.data(), boost_mesh_.size() * sizeof(Vertex));
        vkUnmapMemory(context_.device, boost_vertices_.memory);
        stats_.boost_segments = unsigned(boost_mesh_.size() / 12);
    }
    sheet_mesh_.clear();
    if (scene_->sheet_set_ && !sheet.empty()) {
        if (sheet.size() > 2286 || sheet.size() % 18)
            throw std::runtime_error("Spray sheet submission exceeds its column limit");
        sheet_mesh_.reserve(sheet.size());
        for (const auto& point : sheet) {
            if (!finite(point.position) || !std::isfinite(point.u) || !std::isfinite(point.v) ||
                !std::isfinite(point.alpha) || point.alpha < 0 || point.alpha > 1)
                throw std::runtime_error("Invalid spray sheet submission");
            Vertex v{float(point.position.x), float(point.position.y), float(point.position.z), 1, 1, 1};
            v.s = point.u;
            v.t = point.v;
            v.ls = point.alpha;
            sheet_mesh_.push_back(v);
        }
        if (sheet_mesh_.size() > sheet_capacity_) {
            destroy_buffer(sheet_vertices_);
            sheet_capacity_ = std::min(std::size_t(2286), std::max(sheet_mesh_.size(), sheet_capacity_ * 2));
            sheet_vertices_ =
                create_buffer(sheet_capacity_ * sizeof(Vertex), VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, nullptr);
        }
        void* mapped;
        vk_check(
            vkMapMemory(context_.device, sheet_vertices_.memory, 0, sheet_mesh_.size() * sizeof(Vertex), 0, &mapped),
            "Map spray sheet vertices");
        std::memcpy(mapped, sheet_mesh_.data(), sheet_mesh_.size() * sizeof(Vertex));
        vkUnmapMemory(context_.device, sheet_vertices_.memory);
        stats_.sheet_segments = unsigned(sheet.size() / 18);
    }
    constexpr unsigned crowd_frame_bit = 1u << 16;
    const auto material_for = [&](std::size_t part, unsigned frame) {
        const auto& draw = scene_->prop_draws_[part];
        return frame == base_frame         ? VulkanScene::PropFrame{draw.set, draw.alpha}
               : (frame & crowd_frame_bit) ? scene_->crowd_frames_[frame & ~crowd_frame_bit]
                                           : draw.frames[frame];
    };

    struct VisibleDraw {
        std::size_t part;
        std::uint32_t first, count;
        unsigned frame;
        bool wave;
    };

    std::vector<VisibleDraw> prop_draws;
    std::vector<RayInstance> ray_instances;
    if (ray_active) {
        ray_instances.push_back({0, Matrix::identity().values});
        const auto board_mesh = scene_->props_.parts.size() + 1;
        ray_instances.push_back({board_mesh, board.values});
        for (const auto& opponent : opponents)
            ray_instances.push_back({board_mesh, opponent.values});
    }
    std::vector<PropPose> poses;
    std::map<std::tuple<bool, std::size_t, unsigned, bool>, std::vector<PropPose>> groups;

    struct Translucent {
        std::size_t part;
        PropPose pose;
        int depth;
        unsigned frame;
        bool wave;
    };

    std::vector<Translucent> transparent;
    for (std::size_t i = 0; i < scene_->props_.instances.size(); ++i) {
        const auto& instance = scene_->props_.instances[i];
        const auto& model = scene_->props_.models[instance.model];
        const auto* route = route_by_instance.empty() ? nullptr : route_by_instance[i];
        const auto visible = instance_flags.empty() ? instance.visible : (instance_flags[i] & 1) != 0;
        if ((!visible && !route) || model.parts.empty())
            continue;
        const auto* motion = moving.empty() ? nullptr : moving[i];
        const auto* state = frames.empty() ? nullptr : frames[i];
        const bool flag = state && state->wave.has_value() && state->wave->amplitude != 0;
        const auto static_visible = prop_visible(instance.bounds, camera.values, eye);
        if (!motion && !route && !flag && !static_visible && !ray_active)
            continue;
        const auto copies = route ? route->current.size() : 1;
        for (std::size_t copy = 0; copy < copies; ++copy) {
            bool submitted = false;
            unsigned part_index = 0;
            for (const auto part : model.parts) {
                const auto caster =
                    scene_->prop_casters_.empty() || motion || route ? 0 : scene_->prop_casters_[i] + part_index;
                ++part_index;
                const bool wave = flag && scene_->props_.parts[part].wave_count != 0;
                auto requested = state ? state->frame : base_frame;
                if (state)
                    for (const auto& selection : state->materials)
                        if (selection.material == scene_->props_.parts[part].material) {
                            requested = selection.frame;
                            break;
                        }
                const auto frame =
                    state && state->crowd
                        ? (requested < scene_->crowd_frames_.size() ? crowd_frame_bit | requested : base_frame)
                        : (requested < scene_->prop_draws_[part].frames.size() ? requested : base_frame);
                const auto material = material_for(part, frame);
                auto pose = instance.pose;
                if (state)
                    // OBJ V is already inverted in the vertex stream. Unlike
                    // an image-flipping texture upload, this offset follows it.
                    pose.uv = {float(state->uv[0]), float(state->uv[1]), 0, 0};
                Vec3 centre{pose.matrix[12], pose.matrix[13], pose.matrix[14]};
                bool part_visible = flag || static_visible;
                if (motion || route || wave) {
                    auto delta = identity_transform();
                    if (motion) {
                        const auto object = scene_->props_.parts[part].object;
                        delta = interpolate_transform(motion->previous[object], motion->current[object], alpha);
                    }
                    if (route)
                        delta =
                            multiply(interpolate_transform(route->previous[copy], route->current[copy], alpha), delta);
                    pose = moved_prop_pose(pose, delta);
                    if (wave)
                        pose = flag_pose(pose, *state->wave);
                    const auto bounds = flag_bounds(scene_->props_.parts[part].bounds, pose);
                    part_visible = prop_visible(bounds, camera.values, eye);
                    centre = bounds.center();
                }
                if (ray_active && material.alpha == 0 && !wave)
                    ray_instances.push_back(
                        {part + 1, pose.matrix, 0, caster,
                         std::binary_search(scene_->lamp_housings_.begin(), scene_->lamp_housings_.end(), caster)});
                if (!part_visible)
                    continue;
                submitted = true;
                if (wave)
                    stats_.flag_sections += 8;
                if (material.alpha == 2) {
                    const auto depth = camera.values[3] * centre.x + camera.values[7] * centre.y +
                                       camera.values[11] * centre.z + camera.values[15];
                    transparent.push_back({part, pose, int(std::clamp(depth * 1023 / 400, 0., 1023.)), frame, wave});
                } else
                    groups[{(scene_->props_.parts[part].flags & (1u << 17)) != 0, part, frame, wave}].push_back(pose);
            }
            stats_.visible_props += submitted ? 1 : 0;
            if (route && submitted)
                ++stats_.route_copies;
        }
    }
    line_mesh_.clear();
    for (const auto& route : routes)
        for (const auto& line : route.lines) {
            Bounds bounds;
            for (const auto point : line.points)
                bounds.add(point);
            if (line.colour[3] <= 0 || !prop_visible(bounds, camera.values, eye))
                continue;
            for (unsigned i = 0; i < 10; ++i)
                for (const auto point : {line.points[i], line.points[i + 1]}) {
                    Vertex vertex{float(point.x), float(point.y), float(point.z),
                                  line.colour[0], line.colour[1], line.colour[2]};
                    vertex.ls = line.colour[3];
                    line_mesh_.push_back(vertex);
                }
            ++stats_.route_lines;
        }
    if (!line_mesh_.empty()) {
        if (line_mesh_.size() > line_capacity_) {
            destroy_buffer(line_vertices_);
            line_capacity_ = std::max(line_mesh_.size(), line_capacity_ * 2);
            line_vertices_ = create_buffer(line_capacity_ * sizeof(Vertex), VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, nullptr);
        }
        void* mapped;
        vk_check(vkMapMemory(context_.device, line_vertices_.memory, 0, line_mesh_.size() * sizeof(Vertex), 0, &mapped),
                 "Map spline lines");
        std::memcpy(mapped, line_mesh_.data(), line_mesh_.size() * sizeof(Vertex));
        vkUnmapMemory(context_.device, line_vertices_.memory);
    }
    for (const auto& [key, instances] : groups) {
        const auto first = std::uint32_t(poses.size());
        poses.insert(poses.end(), instances.begin(), instances.end());
        prop_draws.push_back(
            {std::get<1>(key), first, std::uint32_t(instances.size()), std::get<2>(key), std::get<3>(key)});
    }
    std::stable_sort(transparent.begin(), transparent.end(),
                     [](const auto& a, const auto& b) { return a.depth > b.depth; });
    for (const auto& draw : transparent) {
        prop_draws.push_back({draw.part, std::uint32_t(poses.size()), 1, draw.frame, draw.wave});
        poses.push_back(draw.pose);
    }
    if (!poses.empty()) {
        if (poses.size() > pose_capacity_)
            throw std::runtime_error("Visible instance buffer exceeds capacity");
        void* mapped;
        vk_check(vkMapMemory(context_.device, poses_.memory, 0, poses.size() * sizeof(PropPose), 0, &mapped),
                 "Map visible placements");
        std::memcpy(mapped, poses.data(), poses.size() * sizeof(PropPose));
        vkUnmapMemory(context_.device, poses_.memory);
    }
    stats_.prop_draws = unsigned(prop_draws.size());
    if (ray_active) {
        try {
            const auto casters = shadow_casters.empty() ? avatar : shadow_casters;
            std::vector<Vertex> triangles;
            if (casters.size() > maximum_avatar_vertices || casters.size() % 3)
                throw std::invalid_argument("Invalid rider shadow triangles");
            for (std::size_t i = 0; i < casters.size(); i += 3)
                if (casters[i].nx || casters[i].ny || casters[i].nz)
                    triangles.insert(triangles.end(), casters.begin() + i, casters.begin() + i + 3);
            if (!triangles.empty() && !ray_actor_)
                ray_actor_ = std::make_unique<RayActor>(context_);
            if (ray_actor_) {
                ray_actor_->update(triangles);
                if (const auto address = ray_actor_->address())
                    ray_instances.push_back({0, Matrix::identity().values, address});
            }
            ray_world_->update(ray_instances);
            const auto acceleration = ray_world_->handle();
            VkWriteDescriptorSetAccelerationStructureKHR data{
                VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET_ACCELERATION_STRUCTURE_KHR};
            data.accelerationStructureCount = 1;
            data.pAccelerationStructures = &acceleration;
            VkWriteDescriptorSet write{VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET};
            write.pNext = &data;
            write.dstSet = ray_set_;
            write.descriptorCount = 1;
            write.descriptorType = VK_DESCRIPTOR_TYPE_ACCELERATION_STRUCTURE_KHR;
            vkUpdateDescriptorSets(context_.device, 1, &write, 0, nullptr);
        } catch (const std::exception& e) {
            ray_failed_ = true;
            ray_active = false;
            std::cerr << "Ray instances unavailable: " << e.what() << "; using enhanced lighting\n";
        }
    }
    lighting.settings[3] = ray_active ? 1.f : 0.f;
    void* light_data;
    vk_check(vkMapMemory(context_.device, lighting_.memory, 0, sizeof(lighting), 0, &light_data), "Map lighting");
    std::memcpy(light_data, &lighting, sizeof(lighting));
    vkUnmapMemory(context_.device, lighting_.memory);
    VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    vk_check(vkBeginCommandBuffer(command_, &begin), "Begin draw command");
    if (timing_) {
        vkCmdResetQueryPool(command_, timing_, 0, 2);
        vkCmdWriteTimestamp(command_, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, timing_, 0);
    }
    if (ray_active) {
        if (ray_actor_)
            ray_actor_->record(command_);
        ray_world_->record(command_);
    }
    const auto opaque_pipeline = ray_active ? ray_pipeline_ : pipeline_;
    const bool srgb = scene_format_ == VK_FORMAT_R8G8B8A8_SRGB || scene_format_ == VK_FORMAT_B8G8R8A8_SRGB;
    const bool linear = srgb || hdr_;
    std::array<VkClearValue, 2> clear{};
    for (unsigned c = 0; c < 3; ++c) {
        const auto v = scene_->world_.sky_colour[c] * visibility;
        clear[0].color.float32[c] = linear ? (v <= .04045f ? v / 12.92f : std::pow((v + .055f) / 1.055f, 2.4f)) : v;
    }
    clear[0].color.float32[3] = 1;
    clear[1].depthStencil = {0, 0};
    VkRenderPassBeginInfo pass{VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO};
    pass.renderPass = pass_;
    pass.framebuffer = targets_.at(image).framebuffer;
    pass.renderArea.extent = {render_width_, render_height_};
    pass.clearValueCount = 2;
    pass.pClearValues = clear.data();
    vkCmdBeginRenderPass(command_, &pass, VK_SUBPASS_CONTENTS_INLINE);
    vkCmdBindPipeline(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, opaque_pipeline);
    vkCmdBindDescriptorSets(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, layout_, 1, 1, &pose_set_, 0, nullptr);
    if (ray_active)
        vkCmdBindDescriptorSets(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, layout_, 2, 1, &ray_set_, 0, nullptr);
    const VkViewport viewport{0, 0, float(render_width_), float(render_height_), 0, 1};
    const VkRect2D scissor{{0, 0}, {render_width_, render_height_}};
    vkCmdSetViewport(command_, 0, 1, &viewport);
    vkCmdSetScissor(command_, 0, 1, &scissor);
    const VkDeviceSize offset = 0;
    vkCmdBindVertexBuffers(command_, 0, 1, &scene_->vertices_.buffer, &offset);
    vkCmdBindIndexBuffer(command_, scene_->indices_.buffer, 0, VK_INDEX_TYPE_UINT32);
    const auto fog = scene_->world_.draw_fog(float(terrain_draw_distance));
    DrawPush push{camera,
                  {0, linear ? 1 : 0, 0, 0},
                  {scene_->world_.fog_colour[0], scene_->world_.fog_colour[1], scene_->world_.fog_colour[2], fog[0]},
                  {float(eye.x), float(eye.y), float(eye.z), fog[1]}};
    push.presentation[0] = visibility;
    if (!scene_->sky_draws_.empty()) {
        // [Trailmap: 400-backdrop] Cancel each eye's translation independently.
        auto centre = Matrix::identity();
        centre.values[12] = float(eye.x);
        centre.values[13] = float(eye.y);
        centre.values[14] = float(eye.z);
        push.mvp = camera * centre;
        push.options[0] = 7;
        vkCmdBindPipeline(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, sky_pipeline_);
        for (const auto& draw : scene_->sky_draws_) {
            vkCmdBindDescriptorSets(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, layout_, 0, 1, &draw.set, 0, nullptr);
            vkCmdPushConstants(command_, layout_, draw_stages, 0, sizeof(push), &push);
            vkCmdDrawIndexed(command_, draw.count, 1, draw.first, 0, 0);
        }
        push.mvp = camera;
        vkCmdBindPipeline(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, opaque_pipeline);
    }
    if (compact && !packed_indices_.empty())
        vkCmdBindIndexBuffer(command_, visible_indices_.buffer, 0, VK_INDEX_TYPE_UINT32);
    for (const auto& visible : terrain_draws_) {
        const auto& draw = scene_->draws_[visible.material];
        push.options[0] = runtime && draw.mode == 0 ? 15 : draw.mode;
        vkCmdBindDescriptorSets(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, layout_, 0, 1, &draw.set, 0, nullptr);
        vkCmdPushConstants(command_, layout_, draw_stages, 0, sizeof(push), &push);
        vkCmdDrawIndexed(command_, visible.count, 1, visible.first, 0, 0);
    }
    vkCmdBindIndexBuffer(command_, scene_->indices_.buffer, 0, VK_INDEX_TYPE_UINT32);
    const auto world_eye = push.eye_end;
    const auto relative = eye - Vec3{board.values[12], board.values[13], board.values[14]};
    if (!runtime)
        for (unsigned c = 0; c < 3; ++c)
            push.eye_end[c] =
                float(dot(relative, {board.values[c * 4], board.values[c * 4 + 1], board.values[c * 4 + 2]}));
    push.mvp = runtime ? camera : camera * board;
    const auto bind_board = [&](unsigned design) {
        const bool stock = design < stock_board_count;
        push.options[0] = stock ? 14 : runtime ? 15 : 0;
        push.options[2] = board_lighting_ && !runtime ? 1 : 0;
        const auto set = stock ? scene_->stock_board_sets_[design] : scene_->board_set_;
        if (stock) {
            const auto colour = stock_board_info(design).edge;
            push.presentation[1] = float((colour >> 16) & 255) / 255;
            push.presentation[2] = float((colour >> 8) & 255) / 255;
            push.presentation[3] = float(colour & 255) / 255;
        }
        vkCmdBindDescriptorSets(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, layout_, 0, 1, &set, 0, nullptr);
    };
    bind_board(board_design_);
    if (dynamic_boards)
        vkCmdBindVertexBuffers(command_, 0, 1, &board_vertices_.buffer, &offset);
    const auto draw_board = [&](unsigned index) {
        if (dynamic_boards)
            vkCmdDraw(command_, scene_->board_count_, 1, index * scene_->board_count_, 0);
        else
            vkCmdDrawIndexed(command_, scene_->board_count_, 1, scene_->board_first_, 0, 0);
    };
    vkCmdPushConstants(command_, layout_, draw_stages, 0, sizeof(push), &push);
    draw_board(0);
    stats_.opponent_boards = unsigned(opponents.size());
    unsigned opponent_index = 0;
    for (const auto& opponent : opponents) {
        const auto relative_eye = eye - Vec3{opponent.values[12], opponent.values[13], opponent.values[14]};
        if (!runtime)
            for (unsigned c = 0; c < 3; ++c)
                push.eye_end[c] = float(dot(
                    relative_eye, {opponent.values[c * 4], opponent.values[c * 4 + 1], opponent.values[c * 4 + 2]}));
        push.mvp = runtime ? camera : camera * opponent;
        bind_board(opponent_index < opponent_designs_.size() ? opponent_designs_[opponent_index] : board_design_);
        ++opponent_index;
        vkCmdPushConstants(command_, layout_, draw_stages, 0, sizeof(push), &push);
        draw_board(opponent_index);
    }
    push.eye_end = world_eye;
    if (dynamic_boards)
        vkCmdBindVertexBuffers(command_, 0, 1, &scene_->vertices_.buffer, &offset);
    push.presentation[1] = push.presentation[2] = push.presentation[3] = 0;
    vkCmdBindDescriptorSets(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, layout_, 0, 1, &scene_->board_set_, 0, nullptr);
    push.mvp = camera;
    push.options[0] = runtime ? 15 : 0;
    if (!avatar.empty()) {
        vkCmdBindVertexBuffers(command_, 0, 1, &avatar_vertices_.buffer, &offset);
        vkCmdPushConstants(command_, layout_, draw_stages, 0, sizeof(push), &push);
        vkCmdDraw(command_, std::uint32_t(avatar.size()), 1, 0, 0);
        vkCmdBindVertexBuffers(command_, 0, 1, &scene_->vertices_.buffer, &offset);
    }
    push.options[0] = 3;
    bool blending = false;
    for (const auto& visible : prop_draws) {
        const auto& draw = scene_->prop_draws_[visible.part];
        const auto material = material_for(visible.part, visible.frame);
        if (material.alpha == 2 && !blending) {
            vkCmdBindPipeline(command_, VK_PIPELINE_BIND_POINT_GRAPHICS,
                              ray_active ? ray_blend_pipeline_ : blend_pipeline_);
            blending = true;
        }
        push.options[2] = material.alpha;
        vkCmdBindDescriptorSets(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, layout_, 0, 1, &material.set, 0, nullptr);
        vkCmdPushConstants(command_, layout_, draw_stages, 0, sizeof(push), &push);
        vkCmdDrawIndexed(command_, visible.wave ? draw.wave_count : draw.count, visible.count,
                         visible.wave ? draw.wave_first : draw.first, 0, visible.first);
        if (visible.wave)
            ++stats_.flag_draws;
    }
    if (!line_mesh_.empty()) {
        vkCmdBindPipeline(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, line_pipeline_);
        vkCmdBindVertexBuffers(command_, 0, 1, &line_vertices_.buffer, &offset);
        push.mvp = camera;
        push.options[0] = 8;
        push.options[2] = 0;
        vkCmdPushConstants(command_, layout_, draw_stages, 0, sizeof(push), &push);
        vkCmdDraw(command_, std::uint32_t(line_mesh_.size()), 1, 0, 0);
        ++stats_.line_draws;
    }
    if (!wake_mesh_.empty()) {
        vkCmdBindPipeline(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, wake_pipeline_);
        vkCmdBindVertexBuffers(command_, 0, 1, &wake_vertices_.buffer, &offset);
        push.mvp = camera;
        push.options[0] = 5;
        push.options[2] = 0;
        vkCmdBindDescriptorSets(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, layout_, 0, 1, &scene_->wake_set_, 0,
                                nullptr);
        for (int layer = 0; layer < 2; ++layer) {
            push.options[3] = layer;
            vkCmdPushConstants(command_, layout_, draw_stages, 0, sizeof(push), &push);
            vkCmdDraw(command_, std::uint32_t(wake_mesh_.size()), 1, 0, 0);
            ++stats_.wake_draws;
        }
        push.options[3] = 0;
    }
    if (!sprite_mesh.empty()) {
        vkCmdBindPipeline(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, sprite_pipeline_);
        vkCmdBindVertexBuffers(command_, 0, 1, &sprite_vertices_.buffer, &offset);
        push.mvp = camera;
        push.options[0] = 4;
        push.options[2] = 0;
        vkCmdBindDescriptorSets(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, layout_, 0, 1, &scene_->effect_set_, 0,
                                nullptr);
        vkCmdPushConstants(command_, layout_, draw_stages, 0, sizeof(push), &push);
        vkCmdDraw(command_, std::uint32_t(sprite_mesh.size()), 1, 0, 0);
    }
    if (!particle_mesh_.empty()) {
        vkCmdBindVertexBuffers(command_, 0, 1, &particle_vertices_.buffer, &offset);
        push.mvp = camera;
        push.options[0] = 4;
        push.options[2] = 0;
        for (const auto& draw : particle_draws_) {
            vkCmdBindPipeline(command_, VK_PIPELINE_BIND_POINT_GRAPHICS,
                              draw.blend == ParticleBlend::Additive ? sprite_pipeline_ : blend_pipeline_);
            push.options[3] = draw.blend == ParticleBlend::Additive ? 0 : 1;
            const auto set = scene_->particle_sets_[draw.texture];
            vkCmdBindDescriptorSets(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, layout_, 0, 1, &set, 0, nullptr);
            vkCmdPushConstants(command_, layout_, draw_stages, 0, sizeof(push), &push);
            vkCmdDraw(command_, draw.count, 1, draw.first, 0);
            ++stats_.particle_draws;
        }
        push.options[3] = 0;
    }
    if (!sheet_mesh_.empty()) {
        // Public board-FX profile: the connected carve sheet uses always-pass depth.
        vkCmdBindPipeline(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, celestial_pipeline_);
        vkCmdBindVertexBuffers(command_, 0, 1, &sheet_vertices_.buffer, &offset);
        push.mvp = camera;
        push.options[0] = 6;
        push.options[2] = 0;
        vkCmdBindDescriptorSets(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, layout_, 0, 1, &scene_->sheet_set_, 0,
                                nullptr);
        vkCmdPushConstants(command_, layout_, draw_stages, 0, sizeof(push), &push);
        vkCmdDraw(command_, std::uint32_t(sheet_mesh_.size()), 1, 0, 0);
        ++stats_.sheet_draws;
    }
    if (!boost_mesh_.empty()) {
        vkCmdBindPipeline(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, sprite_pipeline_);
        vkCmdBindVertexBuffers(command_, 0, 1, &boost_vertices_.buffer, &offset);
        push.mvp = camera;
        push.options[0] = 9;
        push.options[2] = 0;
        vkCmdBindDescriptorSets(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, layout_, 0, 1, &scene_->board_set_, 0,
                                nullptr);
        vkCmdPushConstants(command_, layout_, draw_stages, 0, sizeof(push), &push);
        vkCmdDraw(command_, std::uint32_t(boost_mesh_.size()), 1, 0, 0);
        ++stats_.boost_draws;
    }
    if (weather.flakes) {
        const SnowPush data{
            camera,
            {float(snow.eye.x), float(snow.eye.y), float(snow.eye.z), float(snow.time)},
            {float(weather.box.x), float(weather.box.y), float(weather.box.z), float(weather.lift)},
            {float(weather.fall_min), float(weather.fall_max), float(weather.drift),
             float(weather.alpha * weather.brightness * visibility)},
            {float(weather.near_start), float(weather.near_end), float(weather.edge_fade), linear ? 1.f : 0.f}};
        vkCmdBindPipeline(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, snow_pipeline_);
        vkCmdBindVertexBuffers(command_, 0, 1, &snow_vertices_.buffer, &offset);
        vkCmdPushConstants(command_, layout_, draw_stages, 0, sizeof(data), &data);
        vkCmdDraw(command_, 6, weather.flakes, 0, 0);
        stats_.snowflakes = weather.flakes;
        stats_.snow_draws = 1;
    }
    if (!glints.empty()) {
        vkCmdBindPipeline(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, sprite_pipeline_);
        vkCmdBindVertexBuffers(command_, 0, 1, &glint_vertices_.buffer, &offset);
        push.mvp = camera;
        push.options[0] = 12;
        push.options[2] = scene_->lamp_set_ ? 1 : 0;
        push.options[3] = 0;
        const auto set = scene_->lamp_set_ ? scene_->lamp_set_ : scene_->board_set_;
        vkCmdBindDescriptorSets(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, layout_, 0, 1, &set, 0, nullptr);
        vkCmdPushConstants(command_, layout_, draw_stages, 0, sizeof(push), &push);
        vkCmdDraw(command_, std::uint32_t(glints.size()), 1, 0, 0);
    }
    if (!celestial.fan.empty()) {
        vkCmdBindPipeline(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, celestial_pipeline_);
        vkCmdBindVertexBuffers(command_, 0, 1, &celestial_vertices_.buffer, &offset);
        push.mvp = Matrix::identity();
        push.options[2] = push.options[3] = 0;
        if (fan_count) {
            push.options[0] = 10;
            vkCmdPushConstants(command_, layout_, draw_stages, 0, sizeof(push), &push);
            vkCmdDraw(command_, std::uint32_t(fan_count), 1, 0, 0);
            ++stats_.celestial_draws;
        }
        if (!celestial.corona.empty()) {
            push.options[0] = 11;
            vkCmdBindDescriptorSets(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, layout_, 0, 1, &scene_->corona_set_, 0,
                                    nullptr);
            vkCmdPushConstants(command_, layout_, draw_stages, 0, sizeof(push), &push);
            vkCmdDraw(command_, std::uint32_t(celestial.corona.size()), 1, std::uint32_t(fan_count), 0);
            ++stats_.celestial_draws;
        }
        stats_.celestial_triangles = unsigned(celestial.fan.size() / 3);
    }
    if (!hud.empty() && !(screen_hud && presentation_pass_)) {
        vkCmdBindPipeline(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, screen_hud ? hud_pipeline_ : wrist_pipeline_);
        vkCmdBindVertexBuffers(command_, 0, 1, &hud_vertices_.buffer, &offset);
        push.mvp = screen_hud ? Matrix::identity() : camera;
        push.options[0] = push.options[2] = push.options[3] = 0;
        push.eye_end[3] = 0;
        vkCmdPushConstants(command_, layout_, draw_stages, 0, sizeof(push), &push);
        vkCmdDraw(command_, std::uint32_t(hud.size()), 1, 0, 0);
    }
    vkCmdEndRenderPass(command_);
    if (presentation_pass_) {
        auto& target = targets_[image];
        VkImageMemoryBarrier sampled{VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER};
        sampled.srcAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT;
        sampled.dstAccessMask = VK_ACCESS_SHADER_READ_BIT;
        sampled.oldLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
        sampled.newLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL;
        sampled.srcQueueFamilyIndex = sampled.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
        sampled.image = target.resolved;
        sampled.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
        vkCmdPipelineBarrier(command_, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,
                             VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT, 0, 0, nullptr, 0, nullptr, 1, &sampled);
        VkRenderPassBeginInfo present{VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO};
        present.renderPass = presentation_pass_;
        present.framebuffer = target.presentation_framebuffer;
        present.renderArea.extent = {width_, height_};
        vkCmdBeginRenderPass(command_, &present, VK_SUBPASS_CONTENTS_INLINE);
        const VkViewport native_viewport{0, 0, float(width_), float(height_), 0, 1};
        const VkRect2D native_scissor{{0, 0}, {width_, height_}};
        vkCmdSetViewport(command_, 0, 1, &native_viewport);
        vkCmdSetScissor(command_, 0, 1, &native_scissor);
        vkCmdBindPipeline(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, presentation_pipeline_);
        vkCmdBindVertexBuffers(command_, 0, 1, &presentation_vertices_.buffer, &offset);
        vkCmdBindDescriptorSets(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, layout_, 0, 1, &target.presentation_set, 0,
                                nullptr);
        DrawPush output{
            Matrix::identity(),
            {hdr_ ? 13 : 1, (format_ == VK_FORMAT_R8G8B8A8_SRGB || format_ == VK_FORMAT_B8G8R8A8_SRGB) ? 1 : 0, 0, 0}};
        vkCmdPushConstants(command_, layout_, draw_stages, 0, sizeof(output), &output);
        vkCmdDraw(command_, 6, 1, 0, 0);
        if (screen_hud && !hud.empty()) {
            vkCmdBindPipeline(command_, VK_PIPELINE_BIND_POINT_GRAPHICS, presentation_hud_);
            vkCmdBindVertexBuffers(command_, 0, 1, &hud_vertices_.buffer, &offset);
            output.options[0] = 0;
            output.presentation[0] = visibility;
            vkCmdPushConstants(command_, layout_, draw_stages, 0, sizeof(output), &output);
            vkCmdDraw(command_, unsigned(hud.size()), 1, 0, 0);
        }
        vkCmdEndRenderPass(command_);
    }
    if (final_layout != VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL) {
        VkImageMemoryBarrier barrier{VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER};
        barrier.srcAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT;
        barrier.dstAccessMask = final_layout == VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL ? VK_ACCESS_TRANSFER_READ_BIT : 0;
        barrier.oldLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
        barrier.newLayout = final_layout;
        barrier.srcQueueFamilyIndex = barrier.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
        barrier.image = targets_[image].colour;
        barrier.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
        vkCmdPipelineBarrier(command_, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,
                             final_layout == VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL
                                 ? VK_PIPELINE_STAGE_TRANSFER_BIT
                                 : VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT,
                             0, 0, nullptr, 0, nullptr, 1, &barrier);
    }
    if (timing_)
        vkCmdWriteTimestamp(command_, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, timing_, 1);
    vk_check(vkEndCommandBuffer(command_), "End draw command");
    const VkPipelineStageFlags stage = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
    VkSubmitInfo submit{VK_STRUCTURE_TYPE_SUBMIT_INFO};
    submit.commandBufferCount = 1;
    submit.pCommandBuffers = &command_;
    if (wait) {
        submit.waitSemaphoreCount = 1;
        submit.pWaitSemaphores = &wait;
        submit.pWaitDstStageMask = &stage;
    }
    if (signal) {
        submit.signalSemaphoreCount = 1;
        submit.pSignalSemaphores = &signal;
    }
    vk_check(vkQueueSubmit(context_.queue, 1, &submit, fence_), "Submit terrain frame");
    pending_ = true;
    if (!deferred_) {
        const auto waited = std::chrono::steady_clock::now();
        finish();
        stats_.wait_ms += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - waited).count();
    }
    stats_.cpu_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
}

void VulkanRenderer::finish() {
    if (!pending_)
        return;
    vk_check(vkWaitForFences(context_.device, 1, &fence_, VK_TRUE, UINT64_MAX), "Wait for renderer resources");
    if (timing_) {
        std::array<std::uint64_t, 2> ticks{};
        vk_check(vkGetQueryPoolResults(context_.device, timing_, 0, 2, sizeof(ticks), ticks.data(),
                                       sizeof(std::uint64_t), VK_QUERY_RESULT_64_BIT),
                 "Read completed GPU timestamps");
        const auto mask = timestamp_bits_ >= 64 ? UINT64_MAX : (std::uint64_t(1) << timestamp_bits_) - 1;
        stats_.gpu_ms = double((ticks[1] - ticks[0]) & mask) * timestamp_period_ / 1e6;
    }
    pending_ = false;
}

void VulkanRenderer::capture(unsigned image, const std::filesystem::path& output) {
    finish();
    auto buffer = create_buffer(VkDeviceSize(width_) * height_ * 4, VK_BUFFER_USAGE_TRANSFER_DST_BIT, nullptr);
    vk_check(vkResetCommandBuffer(command_, 0), "Reset capture command");
    VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    vk_check(vkBeginCommandBuffer(command_, &begin), "Begin capture");
    VkBufferImageCopy copy{};
    copy.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
    copy.imageExtent = {width_, height_, 1};
    vkCmdCopyImageToBuffer(command_, targets_.at(image).colour, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, buffer.buffer, 1,
                           &copy);
    vk_check(vkEndCommandBuffer(command_), "End capture");
    VkSubmitInfo submit{VK_STRUCTURE_TYPE_SUBMIT_INFO};
    submit.commandBufferCount = 1;
    submit.pCommandBuffers = &command_;
    vk_check(vkQueueSubmit(context_.queue, 1, &submit, {}), "Submit capture");
    vk_check(vkQueueWaitIdle(context_.queue), "Finish capture");
    void* mapped;
    vk_check(vkMapMemory(context_.device, buffer.memory, 0, VK_WHOLE_SIZE, 0, &mapped), "Read capture");
    std::ofstream file(output, std::ios::binary);
    if (!file)
        throw std::runtime_error("Cannot write capture");
    file << "P6\n" << width_ << ' ' << height_ << "\n255\n";
    const auto* pixels = static_cast<const unsigned char*>(mapped);
    for (std::size_t i = 0; i < std::size_t(width_) * height_; ++i)
        file.write(reinterpret_cast<const char*>(pixels + i * 4), 3);
    vkUnmapMemory(context_.device, buffer.memory);
    destroy_buffer(buffer);
}
} // namespace openslope
