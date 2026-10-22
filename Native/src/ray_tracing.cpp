#include "ray_tracing.hpp"
#include "vulkan_renderer.hpp"
#include <algorithm>
#include <cstring>
#include <utility>

namespace openslope {
namespace {
VkDeviceAddress buffer_address(VulkanContext& context, VkBuffer buffer) {
    VkBufferDeviceAddressInfo info{VK_STRUCTURE_TYPE_BUFFER_DEVICE_ADDRESS_INFO};
    info.buffer = buffer;
    return vkGetBufferDeviceAddress(context.device, &info);
}

VkDeviceSize aligned(VkDeviceSize value, VkDeviceSize alignment) { return (value + alignment - 1) & ~(alignment - 1); }

std::uint32_t scratch_alignment(VulkanContext& context) {
    VkPhysicalDeviceAccelerationStructurePropertiesKHR ray{
        VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ACCELERATION_STRUCTURE_PROPERTIES_KHR};
    VkPhysicalDeviceProperties2 properties{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2};
    properties.pNext = &ray;
    vkGetPhysicalDeviceProperties2(context.physical, &properties);
    return ray.minAccelerationStructureScratchOffsetAlignment;
}

struct RayBuffer {
    VulkanContext& context;
    VkBuffer buffer{};
    VkDeviceMemory memory{};
    VkDeviceSize size{};

    explicit RayBuffer(VulkanContext& ctx) : context(ctx) {}

    ~RayBuffer() {
        if (buffer)
            vkDestroyBuffer(context.device, buffer, nullptr);
        if (memory)
            vkFreeMemory(context.device, memory, nullptr);
    }

    void allocate(VkDeviceSize bytes, VkBufferUsageFlags usage, bool host = false) {
        RayBuffer replacement(context);
        VkBufferCreateInfo info{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};
        info.size = std::max(VkDeviceSize(16), bytes);
        info.usage = usage | VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT;
        vk_check(vkCreateBuffer(context.device, &info, nullptr, &replacement.buffer), "Create ray buffer");
        VkMemoryRequirements requirements;
        vkGetBufferMemoryRequirements(context.device, replacement.buffer, &requirements);
        VkPhysicalDeviceMemoryProperties properties;
        vkGetPhysicalDeviceMemoryProperties(context.physical, &properties);
        const auto flags = host ? VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT
                                : VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT;
        std::uint32_t type = UINT32_MAX;
        for (std::uint32_t i = 0; i < properties.memoryTypeCount; ++i)
            if ((requirements.memoryTypeBits & (1u << i)) &&
                (properties.memoryTypes[i].propertyFlags & flags) == flags) {
                type = i;
                break;
            }
        if (type == UINT32_MAX)
            throw std::runtime_error("No suitable ray buffer memory");
        VkMemoryAllocateFlagsInfo address{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_FLAGS_INFO};
        address.flags = VK_MEMORY_ALLOCATE_DEVICE_ADDRESS_BIT;
        VkMemoryAllocateInfo allocation{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
        allocation.pNext = &address;
        allocation.allocationSize = requirements.size;
        allocation.memoryTypeIndex = type;
        vk_check(vkAllocateMemory(context.device, &allocation, nullptr, &replacement.memory), "Allocate ray memory");
        vk_check(vkBindBufferMemory(context.device, replacement.buffer, replacement.memory, 0), "Bind ray memory");
        std::swap(buffer, replacement.buffer);
        std::swap(memory, replacement.memory);
        size = info.size;
    }

    VkDeviceAddress address() const { return buffer_address(context, buffer); }
};

struct RayHandle {
    VulkanContext& context;
    VkAccelerationStructureKHR value{};

    explicit RayHandle(VulkanContext& ctx) : context(ctx) {}

    ~RayHandle() {
        if (value)
            vkDestroyAccelerationStructureKHR(context.device, value, nullptr);
    }
};

struct RayCommands {
    VulkanContext& context;
    VkCommandPool pool{};
    VkCommandBuffer command{};

    explicit RayCommands(VulkanContext& ctx) : context(ctx) {
        try {
            VkCommandPoolCreateInfo create{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};
            create.queueFamilyIndex = context.family;
            vk_check(vkCreateCommandPool(context.device, &create, nullptr, &pool), "Create ray upload pool");
            VkCommandBufferAllocateInfo allocate{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
            allocate.commandPool = pool;
            allocate.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
            allocate.commandBufferCount = 1;
            vk_check(vkAllocateCommandBuffers(context.device, &allocate, &command), "Allocate ray upload command");
            VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
            begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
            vk_check(vkBeginCommandBuffer(command, &begin), "Begin ray upload");
        } catch (...) {
            if (pool)
                vkDestroyCommandPool(context.device, pool, nullptr);
            throw;
        }
    }

    ~RayCommands() { vkDestroyCommandPool(context.device, pool, nullptr); }

    void submit() {
        vk_check(vkEndCommandBuffer(command), "End ray upload");
        VkSubmitInfo submit{VK_STRUCTURE_TYPE_SUBMIT_INFO};
        submit.commandBufferCount = 1;
        submit.pCommandBuffers = &command;
        vk_check(vkQueueSubmit(context.queue, 1, &submit, {}), "Submit ray upload");
        vk_check(vkQueueWaitIdle(context.queue), "Finish ray upload");
    }
};

void build_barrier(VkCommandBuffer command, VkPipelineStageFlags destination) {
    VkMemoryBarrier barrier{VK_STRUCTURE_TYPE_MEMORY_BARRIER};
    barrier.srcAccessMask =
        VK_ACCESS_ACCELERATION_STRUCTURE_READ_BIT_KHR | VK_ACCESS_ACCELERATION_STRUCTURE_WRITE_BIT_KHR;
    barrier.dstAccessMask =
        VK_ACCESS_ACCELERATION_STRUCTURE_READ_BIT_KHR | VK_ACCESS_ACCELERATION_STRUCTURE_WRITE_BIT_KHR;
    vkCmdPipelineBarrier(command, VK_PIPELINE_STAGE_ACCELERATION_STRUCTURE_BUILD_BIT_KHR, destination, 0, 1, &barrier,
                         0, nullptr, 0, nullptr);
}
} // namespace

struct RayGeometry::Impl {
    VulkanContext& context;
    RayBuffer storage;
    std::vector<std::unique_ptr<RayHandle>> handles;
    std::vector<VkDeviceAddress> addresses;

    Impl(VulkanContext& ctx, VkBuffer vertices, VkBuffer indices, std::uint32_t vertex_count,
         std::span<const RayMesh> meshes)
        : context(ctx), storage(ctx), handles(meshes.size()), addresses(meshes.size()) {
        if (!context.ray_query || !vertex_count)
            throw std::runtime_error("Ray geometry requires a supported device and vertices");
        std::vector<VkAccelerationStructureGeometryKHR> geometry(meshes.size());
        std::vector<VkAccelerationStructureBuildGeometryInfoKHR> builds(meshes.size());
        std::vector<VkAccelerationStructureBuildSizesInfoKHR> sizes(meshes.size());
        std::vector<VkDeviceSize> offsets(meshes.size());
        VkDeviceSize bytes = 0, scratch_bytes = 0;
        for (std::size_t i = 0; i < meshes.size(); ++i) {
            if (!meshes[i].count)
                continue;
            auto& triangles = geometry[i];
            triangles.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_KHR;
            triangles.geometryType = VK_GEOMETRY_TYPE_TRIANGLES_KHR;
            triangles.flags = VK_GEOMETRY_OPAQUE_BIT_KHR;
            auto& data = triangles.geometry.triangles;
            data.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_TRIANGLES_DATA_KHR;
            data.vertexFormat = VK_FORMAT_R32G32B32_SFLOAT;
            data.vertexData.deviceAddress = buffer_address(ctx, vertices);
            data.vertexStride = sizeof(Vertex);
            data.maxVertex = vertex_count - 1;
            data.indexType = VK_INDEX_TYPE_UINT32;
            data.indexData.deviceAddress = buffer_address(ctx, indices) + VkDeviceSize(meshes[i].first) * 4;
            auto& build = builds[i];
            build.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_GEOMETRY_INFO_KHR;
            build.type = VK_ACCELERATION_STRUCTURE_TYPE_BOTTOM_LEVEL_KHR;
            build.flags = VK_BUILD_ACCELERATION_STRUCTURE_PREFER_FAST_TRACE_BIT_KHR;
            build.mode = VK_BUILD_ACCELERATION_STRUCTURE_MODE_BUILD_KHR;
            build.geometryCount = 1;
            build.pGeometries = &triangles;
            sizes[i].sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_SIZES_INFO_KHR;
            const auto primitives = meshes[i].count / 3;
            vkGetAccelerationStructureBuildSizesKHR(ctx.device, VK_ACCELERATION_STRUCTURE_BUILD_TYPE_DEVICE_KHR, &build,
                                                    &primitives, &sizes[i]);
            offsets[i] = bytes;
            bytes += aligned(sizes[i].accelerationStructureSize, 256);
            scratch_bytes = std::max(scratch_bytes, sizes[i].buildScratchSize);
        }
        if (bytes > 1024ull * 1024 * 1024)
            throw std::runtime_error("Ray geometry exceeds the 1 GiB acceleration budget");
        storage.allocate(bytes, VK_BUFFER_USAGE_ACCELERATION_STRUCTURE_STORAGE_BIT_KHR);
        RayBuffer scratch(ctx);
        const auto alignment = scratch_alignment(ctx);
        scratch.allocate(scratch_bytes + alignment, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
        RayCommands commands(ctx);
        for (std::size_t i = 0; i < meshes.size(); ++i) {
            if (!meshes[i].count)
                continue;
            handles[i] = std::make_unique<RayHandle>(ctx);
            VkAccelerationStructureCreateInfoKHR create{VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_CREATE_INFO_KHR};
            create.buffer = storage.buffer;
            create.offset = offsets[i];
            create.size = sizes[i].accelerationStructureSize;
            create.type = VK_ACCELERATION_STRUCTURE_TYPE_BOTTOM_LEVEL_KHR;
            vk_check(vkCreateAccelerationStructureKHR(ctx.device, &create, nullptr, &handles[i]->value),
                     "Create mesh acceleration");
            auto& build = builds[i];
            build.dstAccelerationStructure = handles[i]->value;
            build.scratchData.deviceAddress = aligned(scratch.address(), alignment);
            VkAccelerationStructureBuildRangeInfoKHR range{};
            range.primitiveCount = meshes[i].count / 3;
            const auto* ranges = &range;
            vkCmdBuildAccelerationStructuresKHR(commands.command, 1, &build, &ranges);
            build_barrier(commands.command, VK_PIPELINE_STAGE_ACCELERATION_STRUCTURE_BUILD_BIT_KHR);
            VkAccelerationStructureDeviceAddressInfoKHR address{
                VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_DEVICE_ADDRESS_INFO_KHR};
            address.accelerationStructure = handles[i]->value;
            addresses[i] = vkGetAccelerationStructureDeviceAddressKHR(ctx.device, &address);
        }
        commands.submit();
    }
};

RayGeometry::RayGeometry(VulkanContext& context, VkBuffer vertices, VkBuffer indices, std::uint32_t vertex_count,
                         std::span<const RayMesh> meshes)
    : impl_(std::make_unique<Impl>(context, vertices, indices, vertex_count, meshes)) {}

RayGeometry::~RayGeometry() = default;

VkDeviceAddress RayGeometry::address(std::size_t mesh) const { return impl_->addresses.at(mesh); }

std::uint64_t RayGeometry::bytes() const { return impl_->storage.size; }

struct RayActor::Impl {
    VulkanContext& context;
    RayBuffer vertices, storage, scratch;
    std::unique_ptr<RayHandle> handle;
    VkAccelerationStructureGeometryKHR geometry{};
    std::uint32_t capacity{}, count{}, built_count{}, alignment;
    VkDeviceAddress address{};

    explicit Impl(VulkanContext& ctx)
        : context(ctx), vertices(ctx), storage(ctx), scratch(ctx), alignment(scratch_alignment(ctx)) {}

    VkAccelerationStructureBuildGeometryInfoKHR build() const {
        VkAccelerationStructureBuildGeometryInfoKHR result{
            VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_GEOMETRY_INFO_KHR};
        result.type = VK_ACCELERATION_STRUCTURE_TYPE_BOTTOM_LEVEL_KHR;
        result.flags = VK_BUILD_ACCELERATION_STRUCTURE_PREFER_FAST_BUILD_BIT_KHR |
                       VK_BUILD_ACCELERATION_STRUCTURE_ALLOW_UPDATE_BIT_KHR;
        const bool refit = count == built_count && built_count != 0;
        result.mode =
            refit ? VK_BUILD_ACCELERATION_STRUCTURE_MODE_UPDATE_KHR : VK_BUILD_ACCELERATION_STRUCTURE_MODE_BUILD_KHR;
        result.srcAccelerationStructure = refit ? handle->value : VkAccelerationStructureKHR{};
        result.dstAccelerationStructure = handle ? handle->value : VkAccelerationStructureKHR{};
        result.geometryCount = 1;
        result.pGeometries = &geometry;
        if (scratch.buffer)
            result.scratchData.deviceAddress = aligned(scratch.address(), alignment);
        return result;
    }

    void update(std::span<const Vertex> source) {
        if (source.size() > 600000 || source.size() % 3)
            throw std::runtime_error("Posed shadow geometry exceeds its limit or is not triangular");
        for (const auto& v : source)
            if (!finite(Vec3{v.x, v.y, v.z}))
                throw std::runtime_error("Invalid posed shadow position");
        count = std::uint32_t(source.size() / 3);
        if (!count)
            return;
        if (!handle || count > capacity) {
            capacity = std::max({count, capacity * 2, 1u});
            built_count = 0;
            vertices.allocate(VkDeviceSize(capacity) * 3 * 12,
                              VK_BUFFER_USAGE_ACCELERATION_STRUCTURE_BUILD_INPUT_READ_ONLY_BIT_KHR, true);
            geometry.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_KHR;
            geometry.geometryType = VK_GEOMETRY_TYPE_TRIANGLES_KHR;
            geometry.flags = VK_GEOMETRY_OPAQUE_BIT_KHR;
            auto& triangles = geometry.geometry.triangles;
            triangles.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_TRIANGLES_DATA_KHR;
            triangles.vertexFormat = VK_FORMAT_R32G32B32_SFLOAT;
            triangles.vertexData.deviceAddress = vertices.address();
            triangles.vertexStride = 12;
            triangles.maxVertex = capacity * 3 - 1;
            triangles.indexType = VK_INDEX_TYPE_NONE_KHR;
            auto info = build();
            VkAccelerationStructureBuildSizesInfoKHR sizes{
                VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_SIZES_INFO_KHR};
            vkGetAccelerationStructureBuildSizesKHR(context.device, VK_ACCELERATION_STRUCTURE_BUILD_TYPE_DEVICE_KHR,
                                                    &info, &capacity, &sizes);
            if (sizes.accelerationStructureSize > 64ull * 1024 * 1024)
                throw std::runtime_error("Posed shadow acceleration exceeds its budget");
            handle.reset();
            storage.allocate(sizes.accelerationStructureSize, VK_BUFFER_USAGE_ACCELERATION_STRUCTURE_STORAGE_BIT_KHR);
            scratch.allocate(std::max(sizes.buildScratchSize, sizes.updateScratchSize) + alignment,
                             VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
            handle = std::make_unique<RayHandle>(context);
            VkAccelerationStructureCreateInfoKHR create{VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_CREATE_INFO_KHR};
            create.buffer = storage.buffer;
            create.size = sizes.accelerationStructureSize;
            create.type = VK_ACCELERATION_STRUCTURE_TYPE_BOTTOM_LEVEL_KHR;
            vk_check(vkCreateAccelerationStructureKHR(context.device, &create, nullptr, &handle->value),
                     "Create posed shadow acceleration");
            VkAccelerationStructureDeviceAddressInfoKHR query{
                VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_DEVICE_ADDRESS_INFO_KHR};
            query.accelerationStructure = handle->value;
            address = vkGetAccelerationStructureDeviceAddressKHR(context.device, &query);
        }
        void* mapped;
        vk_check(vkMapMemory(context.device, vertices.memory, 0, source.size() * 12, 0, &mapped),
                 "Map posed shadow vertices");
        auto* positions = static_cast<float*>(mapped);
        for (const auto& v : source) {
            *positions++ = v.x;
            *positions++ = v.y;
            *positions++ = v.z;
        }
        vkUnmapMemory(context.device, vertices.memory);
    }
};

RayActor::RayActor(VulkanContext& context) : impl_(std::make_unique<Impl>(context)) {}

RayActor::~RayActor() = default;

void RayActor::update(std::span<const Vertex> vertices) { impl_->update(vertices); }

VkDeviceAddress RayActor::address() const { return impl_->count ? impl_->address : 0; }

void RayActor::record(VkCommandBuffer command) {
    if (!impl_->count)
        return;
    auto info = impl_->build();
    VkAccelerationStructureBuildRangeInfoKHR range{};
    range.primitiveCount = impl_->count;
    const auto* ranges = &range;
    vkCmdBuildAccelerationStructuresKHR(command, 1, &info, &ranges);
    build_barrier(command, VK_PIPELINE_STAGE_ACCELERATION_STRUCTURE_BUILD_BIT_KHR);
    impl_->built_count = impl_->count;
}

struct RayWorld::Impl {
    VulkanContext& context;
    std::shared_ptr<RayGeometry> geometry;
    RayBuffer storage, scratch, instances;
    std::unique_ptr<RayHandle> handle;
    std::uint32_t capacity = 0, count = 0;
    std::uint32_t alignment;
    VkAccelerationStructureGeometryKHR description{};

    Impl(VulkanContext& ctx, std::shared_ptr<RayGeometry> meshes)
        : context(ctx), geometry(std::move(meshes)), storage(ctx), scratch(ctx), instances(ctx),
          alignment(scratch_alignment(ctx)) {}

    VkAccelerationStructureBuildGeometryInfoKHR build() const {
        VkAccelerationStructureBuildGeometryInfoKHR result{
            VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_GEOMETRY_INFO_KHR};
        result.type = VK_ACCELERATION_STRUCTURE_TYPE_TOP_LEVEL_KHR;
        result.flags = VK_BUILD_ACCELERATION_STRUCTURE_PREFER_FAST_BUILD_BIT_KHR;
        result.mode = VK_BUILD_ACCELERATION_STRUCTURE_MODE_BUILD_KHR;
        result.geometryCount = 1;
        result.pGeometries = &description;
        result.dstAccelerationStructure = handle ? handle->value : VkAccelerationStructureKHR{};
        if (scratch.buffer)
            result.scratchData.deviceAddress = aligned(scratch.address(), alignment);
        return result;
    }

    void update(std::span<const RayInstance> source) {
        std::vector<VkAccelerationStructureInstanceKHR> data;
        data.reserve(source.size());
        for (const auto& instance : source) {
            const auto address =
                instance.external_address ? instance.external_address : geometry->address(instance.mesh);
            if (!address)
                continue;
            const auto& m = instance.transform;
            const auto determinant = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) +
                                     m[8] * (m[1] * m[6] - m[5] * m[2]);
            if (std::abs(determinant) < 1e-12f)
                continue;
            VkAccelerationStructureInstanceKHR output{};
            for (unsigned row = 0; row < 3; ++row)
                for (unsigned col = 0; col < 4; ++col)
                    output.transform.matrix[row][col] = instance.transform[col * 4 + row];
            output.mask = 255;
            output.instanceCustomIndex = instance.custom_index;
            output.flags = VK_GEOMETRY_INSTANCE_TRIANGLE_FACING_CULL_DISABLE_BIT_KHR;
            if (instance.light_housing)
                output.flags |= VK_GEOMETRY_INSTANCE_FORCE_NO_OPAQUE_BIT_KHR;
            output.accelerationStructureReference = address;
            data.push_back(output);
        }
        if (data.size() > 100000)
            throw std::runtime_error("Ray scene exceeds 100000 instances");
        count = std::uint32_t(data.size());
        if (!handle || count > capacity) {
            capacity = std::max({count, capacity * 2, 1u});
            instances.allocate(VkDeviceSize(capacity) * sizeof(VkAccelerationStructureInstanceKHR),
                               VK_BUFFER_USAGE_ACCELERATION_STRUCTURE_BUILD_INPUT_READ_ONLY_BIT_KHR, true);
            description.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_KHR;
            description.geometryType = VK_GEOMETRY_TYPE_INSTANCES_KHR;
            description.geometry.instances.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_INSTANCES_DATA_KHR;
            description.geometry.instances.data.deviceAddress = instances.address();
            auto info = build();
            VkAccelerationStructureBuildSizesInfoKHR sizes{
                VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_SIZES_INFO_KHR};
            vkGetAccelerationStructureBuildSizesKHR(context.device, VK_ACCELERATION_STRUCTURE_BUILD_TYPE_DEVICE_KHR,
                                                    &info, &capacity, &sizes);
            handle.reset();
            storage.allocate(sizes.accelerationStructureSize, VK_BUFFER_USAGE_ACCELERATION_STRUCTURE_STORAGE_BIT_KHR);
            scratch.allocate(sizes.buildScratchSize + alignment, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
            handle = std::make_unique<RayHandle>(context);
            VkAccelerationStructureCreateInfoKHR create{VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_CREATE_INFO_KHR};
            create.buffer = storage.buffer;
            create.size = sizes.accelerationStructureSize;
            create.type = VK_ACCELERATION_STRUCTURE_TYPE_TOP_LEVEL_KHR;
            vk_check(vkCreateAccelerationStructureKHR(context.device, &create, nullptr, &handle->value),
                     "Create scene acceleration");
        }
        if (count) {
            void* mapped;
            vk_check(vkMapMemory(context.device, instances.memory, 0, data.size() * sizeof(data[0]), 0, &mapped),
                     "Map ray instances");
            std::memcpy(mapped, data.data(), data.size() * sizeof(data[0]));
            vkUnmapMemory(context.device, instances.memory);
        }
    }
};

RayWorld::RayWorld(VulkanContext& context, std::shared_ptr<RayGeometry> geometry)
    : impl_(std::make_unique<Impl>(context, std::move(geometry))) {}

RayWorld::~RayWorld() = default;

void RayWorld::update(std::span<const RayInstance> instances) { impl_->update(instances); }

VkAccelerationStructureKHR RayWorld::handle() const {
    return impl_->handle ? impl_->handle->value : VkAccelerationStructureKHR{};
}

unsigned RayWorld::instances() const { return impl_->count; }

void RayWorld::record(VkCommandBuffer command) {
    auto build = impl_->build();
    VkAccelerationStructureBuildRangeInfoKHR range{};
    range.primitiveCount = impl_->count;
    const auto* ranges = &range;
    vkCmdBuildAccelerationStructuresKHR(command, 1, &build, &ranges);
    // TLAS construction must finish before fragment-stage ray queries read it.
    VkMemoryBarrier barrier{VK_STRUCTURE_TYPE_MEMORY_BARRIER};
    barrier.srcAccessMask = VK_ACCESS_ACCELERATION_STRUCTURE_WRITE_BIT_KHR;
    barrier.dstAccessMask = VK_ACCESS_ACCELERATION_STRUCTURE_READ_BIT_KHR;
    vkCmdPipelineBarrier(command, VK_PIPELINE_STAGE_ACCELERATION_STRUCTURE_BUILD_BIT_KHR,
                         VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT, 0, 1, &barrier, 0, nullptr, 0, nullptr);
}
} // namespace openslope
