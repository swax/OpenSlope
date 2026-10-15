#include "openslope/appearance.hpp"
#include "openslope/crowd.hpp"
#include "openslope/gear.hpp"
#include "vulkan_renderer.hpp"
#include <cstring>
#include <iomanip>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>

namespace openslope {
namespace {
std::uint32_t memory_type(VulkanContext& context, std::uint32_t bits, VkMemoryPropertyFlags flags) {
    VkPhysicalDeviceMemoryProperties properties;
    vkGetPhysicalDeviceMemoryProperties(context.physical, &properties);
    for (std::uint32_t i = 0; i < properties.memoryTypeCount; ++i)
        if ((bits & (1u << i)) && (properties.memoryTypes[i].propertyFlags & flags) == flags)
            return i;
    throw std::runtime_error("No suitable Vulkan memory type for map assets");
}

struct UploadPool {
    VulkanContext& context;
    VkCommandPool pool{};

    ~UploadPool() {
        if (pool)
            vkDestroyCommandPool(context.device, pool, nullptr);
    }
};
} // namespace

VulkanScene::Buffer VulkanScene::buffer(VkDeviceSize size, VkBufferUsageFlags usage, const void* data) {
    Buffer result;
    try {
        VkBufferCreateInfo info{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};
        info.size = size;
        info.usage = usage;
        vk_check(vkCreateBuffer(context_.device, &info, nullptr, &result.buffer), "Create scene buffer");
        VkMemoryRequirements requirements;
        vkGetBufferMemoryRequirements(context_.device, result.buffer, &requirements);
        VkMemoryAllocateInfo allocation{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
        allocation.allocationSize = requirements.size;
        allocation.memoryTypeIndex =
            memory_type(context_, requirements.memoryTypeBits,
                        VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
        vk_check(vkAllocateMemory(context_.device, &allocation, nullptr, &result.memory), "Allocate scene buffer");
        vk_check(vkBindBufferMemory(context_.device, result.buffer, result.memory, 0), "Bind scene buffer");
        if (data) {
            void* mapped;
            vk_check(vkMapMemory(context_.device, result.memory, 0, size, 0, &mapped), "Map scene buffer");
            std::memcpy(mapped, data, std::size_t(size));
            vkUnmapMemory(context_.device, result.memory);
        }
        return result;
    } catch (...) {
        if (result.buffer)
            vkDestroyBuffer(context_.device, result.buffer, nullptr);
        if (result.memory)
            vkFreeMemory(context_.device, result.memory, nullptr);
        throw;
    }
}

VulkanScene::Image VulkanScene::image(const RgbaImage& pixels, VkCommandPool pool, bool mipmapped) {
    VkPhysicalDeviceProperties properties;
    vkGetPhysicalDeviceProperties(context_.physical, &properties);
    if (pixels.width > properties.limits.maxImageDimension2D || pixels.height > properties.limits.maxImageDimension2D)
        throw std::runtime_error("Map image exceeds this GPU's texture size limit");
    Image result;
    Buffer staging;
    VkCommandBuffer command{};
    const auto cleanup = [&] {
        if (command)
            vkFreeCommandBuffers(context_.device, pool, 1, &command);
        if (staging.buffer)
            vkDestroyBuffer(context_.device, staging.buffer, nullptr);
        if (staging.memory)
            vkFreeMemory(context_.device, staging.memory, nullptr);
    };
    try {
        const auto levels = mipmapped ? diffuse_mips(pixels) : std::vector<RgbaImage>{pixels};
        std::vector<std::uint8_t> packed;
        std::vector<VkBufferImageCopy> copies;
        for (std::size_t i = 0; i < levels.size(); ++i) {
            const auto& level = levels[i];
            VkBufferImageCopy copy{};
            copy.bufferOffset = packed.size();
            copy.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, std::uint32_t(i), 0, 1};
            copy.imageExtent = {level.width, level.height, 1};
            copies.push_back(copy);
            packed.insert(packed.end(), level.pixels.begin(), level.pixels.end());
        }
        staging = buffer(packed.size(), VK_BUFFER_USAGE_TRANSFER_SRC_BIT, packed.data());
        // [Trailmap: 160-luminance, 400-lighting] Blend the exported byte domain;
        // automatic sRGB texture conversion would alter the residual subtraction.
        VkImageCreateInfo info{VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO};
        info.imageType = VK_IMAGE_TYPE_2D;
        info.format = VK_FORMAT_R8G8B8A8_UNORM;
        info.extent = {pixels.width, pixels.height, 1};
        info.mipLevels = std::uint32_t(levels.size());
        info.arrayLayers = 1;
        info.samples = VK_SAMPLE_COUNT_1_BIT;
        info.tiling = VK_IMAGE_TILING_OPTIMAL;
        info.usage = VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_SAMPLED_BIT;
        vk_check(vkCreateImage(context_.device, &info, nullptr, &result.image), "Create map image");
        VkMemoryRequirements requirements;
        vkGetImageMemoryRequirements(context_.device, result.image, &requirements);
        if (requirements.size > 512ull * 1024 * 1024 - image_bytes_)
            throw std::runtime_error("Map sampled images exceed the 512 MiB GPU budget");
        VkMemoryAllocateInfo allocation{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
        allocation.allocationSize = requirements.size;
        allocation.memoryTypeIndex =
            memory_type(context_, requirements.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
        vk_check(vkAllocateMemory(context_.device, &allocation, nullptr, &result.memory), "Allocate map image");
        vk_check(vkBindImageMemory(context_.device, result.image, result.memory, 0), "Bind map image");
        VkCommandBufferAllocateInfo allocate{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
        allocate.commandPool = pool;
        allocate.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
        allocate.commandBufferCount = 1;
        vk_check(vkAllocateCommandBuffers(context_.device, &allocate, &command), "Allocate image upload command");
        VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
        begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
        vk_check(vkBeginCommandBuffer(command, &begin), "Begin image upload");
        VkImageMemoryBarrier barrier{VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER};
        barrier.oldLayout = VK_IMAGE_LAYOUT_UNDEFINED;
        barrier.newLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;
        barrier.dstAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
        barrier.srcQueueFamilyIndex = barrier.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
        barrier.image = result.image;
        barrier.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, info.mipLevels, 0, 1};
        vkCmdPipelineBarrier(command, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, nullptr,
                             0, nullptr, 1, &barrier);
        vkCmdCopyBufferToImage(command, staging.buffer, result.image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                               std::uint32_t(copies.size()), copies.data());
        barrier.oldLayout = barrier.newLayout;
        barrier.newLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL;
        barrier.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
        barrier.dstAccessMask = VK_ACCESS_SHADER_READ_BIT;
        vkCmdPipelineBarrier(command, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT, 0, 0,
                             nullptr, 0, nullptr, 1, &barrier);
        vk_check(vkEndCommandBuffer(command), "End image upload");
        VkSubmitInfo submit{VK_STRUCTURE_TYPE_SUBMIT_INFO};
        submit.commandBufferCount = 1;
        submit.pCommandBuffers = &command;
        vk_check(vkQueueSubmit(context_.queue, 1, &submit, {}), "Submit image upload");
        vk_check(vkQueueWaitIdle(context_.queue), "Finish image upload");
        VkImageViewCreateInfo view{VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO};
        view.image = result.image;
        view.viewType = VK_IMAGE_VIEW_TYPE_2D;
        view.format = info.format;
        view.subresourceRange = barrier.subresourceRange;
        vk_check(vkCreateImageView(context_.device, &view, nullptr, &result.view), "Create map image view");
        image_bytes_ += requirements.size;
        cleanup();
        return result;
    } catch (...) {
        vkDeviceWaitIdle(context_.device);
        cleanup();
        if (result.view)
            vkDestroyImageView(context_.device, result.view, nullptr);
        if (result.image)
            vkDestroyImage(context_.device, result.image, nullptr);
        if (result.memory)
            vkFreeMemory(context_.device, result.memory, nullptr);
        throw;
    }
}

VulkanScene::~VulkanScene() {
    if (!context_.device)
        return;
    vkDeviceWaitIdle(context_.device);
    if (descriptor_pool_)
        vkDestroyDescriptorPool(context_.device, descriptor_pool_, nullptr);
    if (descriptors_)
        vkDestroyDescriptorSetLayout(context_.device, descriptors_, nullptr);
    if (repeat_)
        vkDestroySampler(context_.device, repeat_, nullptr);
    if (clamp_)
        vkDestroySampler(context_.device, clamp_, nullptr);
    if (sky_sampler_)
        vkDestroySampler(context_.device, sky_sampler_, nullptr);
    for (auto& value : images_) {
        if (value.view)
            vkDestroyImageView(context_.device, value.view, nullptr);
        if (value.image)
            vkDestroyImage(context_.device, value.image, nullptr);
        if (value.memory)
            vkFreeMemory(context_.device, value.memory, nullptr);
    }
    for (auto* value : {&vertices_, &indices_}) {
        if (value->buffer)
            vkDestroyBuffer(context_.device, value->buffer, nullptr);
        if (value->memory)
            vkFreeMemory(context_.device, value->memory, nullptr);
    }
}

void VulkanScene::upload(const Mesh& source, std::span<const std::size_t> flag_models) {
    if (vertices_.buffer)
        throw std::runtime_error("Scene has already been uploaded");
    terrain_total_indices_ = source.indices.size();
    if (!source.terrain_ranges.empty()) {
        std::size_t batch_cursor = 0;
        for (const auto& batch : source.batches) {
            if (batch.first != batch_cursor || !batch.count || batch.count % 3 ||
                batch.count > source.indices.size() - batch_cursor)
                throw std::runtime_error("Invalid culled terrain material partition");
            batch_cursor += batch.count;
        }
        if (batch_cursor != source.indices.size())
            throw std::runtime_error("Terrain materials do not cover their indices");
        std::size_t cursor = 0;
        std::vector<Bounds> boxes;
        for (const auto& range : source.terrain_ranges) {
            if (range.first != cursor || !range.count || range.count % 3 ||
                range.count > source.indices.size() - cursor || range.batch >= source.batches.size())
                throw std::runtime_error("Invalid terrain visibility range");
            const auto& batch = source.batches[range.batch];
            if (range.first < batch.first ||
                std::uint64_t(range.first) + range.count > std::uint64_t(batch.first) + batch.count)
                throw std::runtime_error("Terrain visibility range crosses its material");
            for (std::size_t i = range.first; i < std::size_t(range.first) + range.count; ++i) {
                const auto index = source.indices[i];
                if (index >= source.vertices.size())
                    throw std::runtime_error("Terrain index exceeds its vertices");
                const auto& vertex = source.vertices[index];
                const Vec3 p{vertex.x, vertex.y, vertex.z};
                const auto contained = [](double value, double low, double high) {
                    const auto epsilon = 8 * std::numeric_limits<float>::epsilon() *
                                         (std::abs(value) + std::abs(low) + std::abs(high) + 1);
                    return std::isfinite(value) && value >= low - epsilon && value <= high + epsilon;
                };
                if (!contained(p.x, range.bounds.min.x, range.bounds.max.x) ||
                    !contained(p.y, range.bounds.min.y, range.bounds.max.y) ||
                    !contained(p.z, range.bounds.min.z, range.bounds.max.z))
                    throw std::runtime_error("Terrain visibility bounds exclude their geometry");
            }
            cursor += range.count;
            boxes.push_back(range.bounds);
        }
        if (cursor != source.indices.size())
            throw std::runtime_error("Terrain visibility ranges do not cover the source mesh");
        terrain_visibility_.build(boxes);
        terrain_ranges_ = source.terrain_ranges;
        terrain_indices_ = source.indices;
    }
    crowd_frames_.clear();
    props_ = Props::load(source.map_root, false, flag_models);
    world_ = World::load(source.map_root);
    auto batches = source.batches;
    for (const auto& part : props_.parts) {
        batches.push_back({0, 0, part.texture, -1});
        for (const auto& frame : part.frames)
            batches.push_back({0, 0, frame, -1});
    }
    const auto crowd = crowd_frames(source.map_root);
    for (const auto& frame : crowd)
        batches.push_back({0, 0, frame, -1});
    const auto sprite = riding_sprite(source.map_root);
    if (!sprite.empty())
        batches.push_back({0, 0, sprite, -1});
    const auto wake = riding_sprite(source.map_root, "Wake");
    if (!wake.empty())
        batches.push_back({0, 0, wake, -1});
    const auto sheet = riding_sprite(source.map_root, "Sheet");
    if (!sheet.empty())
        batches.push_back({0, 0, sheet, -1});
    const auto particles = particle_textures(source.map_root);
    for (const auto& name : particles)
        if (!name.empty())
            batches.push_back({0, 0, name, -1});
    auto appearance = Appearance::load(source.map_root, batches);
    world_.fit_colours(appearance);
    if (!appearance.missing.empty())
        std::cerr << "OpenSlope: " << appearance.missing.size()
                  << " referenced map images are missing; using available textures or terrain colours\n";
    VkFormatProperties format;
    vkGetPhysicalDeviceFormatProperties(context_.physical, VK_FORMAT_R8G8B8A8_UNORM, &format);
    if (!(format.optimalTilingFeatures & VK_FORMAT_FEATURE_SAMPLED_IMAGE_FILTER_LINEAR_BIT))
        throw std::runtime_error("GPU cannot linearly sample RGBA map images");
    UploadPool upload{context_};
    VkCommandPoolCreateInfo pool{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};
    pool.queueFamilyIndex = context_.family;
    pool.flags = VK_COMMAND_POOL_CREATE_TRANSIENT_BIT;
    vk_check(vkCreateCommandPool(context_.device, &pool, nullptr, &upload.pool), "Create map upload pool");
    images_.reserve(appearance.images.size() + 2);
    images_.push_back(image({1, 1, {255, 255, 255, 255}}, upload.pool));
    images_.push_back(image({1, 1, {0, 0, 0, 255}}, upload.pool));
    std::map<std::string, std::size_t> names;
    std::map<std::string, bool> fractional;
    for (auto& [name, pixels] : appearance.images) {
        bool smooth = false;
        for (std::size_t p = 3; p < pixels.pixels.size(); p += 4)
            if (pixels.pixels[p] > 0 && pixels.pixels[p] < 255) {
                smooth = true;
                break;
            }
        fractional[name] = smooth;
        names.emplace(name, images_.size());
        images_.push_back(image(pixels, upload.pool, !name.starts_with("Lightmaps/")));
        pixels.pixels.clear();
        pixels.pixels.shrink_to_fit();
    }
    pose_capacity_ = 1;
    for (const auto& instance : props_.instances)
        pose_capacity_ += props_.models[instance.model].parts.size();
    VkPhysicalDeviceProperties limits;
    vkGetPhysicalDeviceProperties(context_.physical, &limits);
    if (pose_capacity_ > 1000000 || pose_capacity_ * sizeof(PropPose) > limits.limits.maxStorageBufferRange)
        throw std::runtime_error("Prop instance buffer exceeds this GPU's limit");
    VkSamplerCreateInfo sampler{VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO};
    sampler.magFilter = sampler.minFilter = VK_FILTER_LINEAR;
    sampler.mipmapMode = VK_SAMPLER_MIPMAP_MODE_LINEAR;
    sampler.maxLod = VK_LOD_CLAMP_NONE;
    sampler.addressModeU = sampler.addressModeV = sampler.addressModeW = VK_SAMPLER_ADDRESS_MODE_REPEAT;
    vk_check(vkCreateSampler(context_.device, &sampler, nullptr, &repeat_), "Create diffuse sampler");
    sampler.addressModeU = sampler.addressModeV = sampler.addressModeW = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
    vk_check(vkCreateSampler(context_.device, &sampler, nullptr, &sky_sampler_), "Create sky sampler");
    sampler.maxLod = 0;
    vk_check(vkCreateSampler(context_.device, &sampler, nullptr, &clamp_), "Create lightmap sampler");
    const std::array<VkDescriptorSetLayoutBinding, 2> bindings{
        {{0, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, nullptr},
         {1, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, nullptr}}};
    VkDescriptorSetLayoutCreateInfo layout{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO};
    layout.bindingCount = 2;
    layout.pBindings = bindings.data();
    vk_check(vkCreateDescriptorSetLayout(context_.device, &layout, nullptr, &descriptors_),
             "Create map descriptor layout");
    const auto count = std::uint32_t(batches.size() + world_.sky.parts.size() + 2);
    const VkDescriptorPoolSize size{VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, count * 2};
    VkDescriptorPoolCreateInfo descriptor_pool{VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO};
    descriptor_pool.maxSets = count;
    descriptor_pool.poolSizeCount = 1;
    descriptor_pool.pPoolSizes = &size;
    vk_check(vkCreateDescriptorPool(context_.device, &descriptor_pool, nullptr, &descriptor_pool_),
             "Create map descriptor pool");
    const auto descriptor = [&](std::size_t diffuse, std::size_t lightmap, bool sky = false) {
        VkDescriptorSet set{};
        VkDescriptorSetAllocateInfo allocate{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO};
        allocate.descriptorPool = descriptor_pool_;
        allocate.descriptorSetCount = 1;
        allocate.pSetLayouts = &descriptors_;
        vk_check(vkAllocateDescriptorSets(context_.device, &allocate, &set), "Allocate map descriptor");
        const std::array<VkDescriptorImageInfo, 2> images{
            {{sky ? sky_sampler_ : repeat_, images_[diffuse].view, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL},
             {clamp_, images_[lightmap].view, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL}}};
        std::array<VkWriteDescriptorSet, 2> writes{};
        for (unsigned i = 0; i < 2; ++i) {
            writes[i] = {VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET};
            writes[i].dstSet = set;
            writes[i].dstBinding = i;
            writes[i].descriptorCount = 1;
            writes[i].descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
            writes[i].pImageInfo = &images[i];
        }
        vkUpdateDescriptorSets(context_.device, 2, writes.data(), 0, nullptr);
        return set;
    };
    for (const auto& frame : crowd) {
        const auto found = names.find("Textures/" + frame);
        crowd_frames_.push_back({descriptor(found == names.end() ? 0 : found->second, 1), 1});
    }
    if (const auto found = names.find("Textures/" + sprite); !sprite.empty() && found != names.end())
        effect_set_ = descriptor(found->second, 1);
    if (const auto found = names.find("Textures/" + wake); !wake.empty() && found != names.end())
        wake_set_ = descriptor(found->second, 1);
    if (const auto found = names.find("Textures/" + sheet); !sheet.empty() && found != names.end())
        sheet_set_ = descriptor(found->second, 1);
    particle_sets_.resize(particles.size());
    for (std::size_t i = 0; i < particles.size(); ++i)
        if (const auto found = names.find("Textures/" + particles[i]); !particles[i].empty() && found != names.end())
            particle_sets_[i] = descriptor(found->second, 1);
    for (const auto& batch : source.batches) {
        auto diffuse = names.find("Textures/" + batch.texture);
        std::ostringstream page;
        page << "Lightmaps/" << std::setfill('0') << std::setw(4) << batch.lightmap << ".png";
        auto lightmap = names.find(page.str());
        const bool base = diffuse != names.end(), lit = batch.lightmap >= 0 && lightmap != names.end();
        draws_.push_back({batch.first, batch.count, descriptor(base ? diffuse->second : 0, lit ? lightmap->second : 1),
                          base ? (lit ? 2 : 1) : 0});
    }
    auto mesh = source;
    const auto prop_first = std::uint32_t(mesh.indices.size()), prop_vertex = std::uint32_t(mesh.vertices.size());
    mesh.vertices.insert(mesh.vertices.end(), props_.geometry.vertices.begin(), props_.geometry.vertices.end());
    for (const auto i : props_.geometry.indices)
        mesh.indices.push_back(i + prop_vertex);
    for (const auto& part : props_.parts) {
        const auto bind = [&](const std::string& texture) {
            const auto name = "Textures/" + texture;
            const auto found = names.find(name);
            return PropFrame{descriptor(found == names.end() ? 0 : found->second, 1),
                             // Priority overlays also carry pixel alpha (scanlines, for example).
                             // [Slopesmith public texture-array tests: priority partial alpha]
                             (part.flags & ((1u << 18) | (1u << 17))) ? (fractional[name] ? 2 : 1) : 0};
        };
        const auto base = bind(part.texture);
        PropDraw draw{part.first + prop_first, part.count, base.set, base.alpha, {}};
        draw.wave_first = part.wave_first + prop_first;
        draw.wave_count = part.wave_count;
        for (const auto& frame : part.frames)
            draw.frames.push_back(bind(frame));
        prop_draws_.push_back(std::move(draw));
    }
    // Geometry is uploaded once; CPU retained data is only bounds and placements.
    props_.geometry = {};
    const auto sky_first = std::uint32_t(mesh.indices.size()), sky_vertex = std::uint32_t(mesh.vertices.size());
    mesh.vertices.insert(mesh.vertices.end(), world_.sky.geometry.vertices.begin(), world_.sky.geometry.vertices.end());
    for (const auto i : world_.sky.geometry.indices)
        mesh.indices.push_back(i + sky_vertex);
    for (const auto& part : world_.sky.parts) {
        const auto found = names.find("Skybox/Textures/" + part.texture);
        sky_draws_.push_back(
            {part.first + sky_first, part.count, descriptor(found == names.end() ? 0 : found->second, 1, true), 7});
    }
    world_.sky = {};
    board_first_ = std::uint32_t(mesh.indices.size());
    const auto offset = std::uint32_t(mesh.vertices.size());
    const auto& gear = snowboard_mesh();
    mesh.vertices.insert(mesh.vertices.end(), gear.vertices.begin(), gear.vertices.end());
    for (const auto index : gear.indices)
        mesh.indices.push_back(offset + index);
    board_count_ = std::uint32_t(gear.indices.size());
    board_set_ = descriptor(0, 1);
    vertices_ = buffer(mesh.vertices.size() * sizeof(Vertex), VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, mesh.vertices.data());
    indices_ =
        buffer(mesh.indices.size() * sizeof(std::uint32_t), VK_BUFFER_USAGE_INDEX_BUFFER_BIT, mesh.indices.data());
}
} // namespace openslope
