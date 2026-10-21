#pragma once
#include <array>
#include <cstdint>
#include <memory>
#include <span>
#include <volk.h>

namespace openslope {
struct VulkanContext;

struct RayMesh {
    std::uint32_t first{}, count{};
};

struct RayInstance {
    std::size_t mesh{};
    std::array<float, 16> transform{};
};

// Immutable mesh acceleration structures shared with the uploaded scene.
class RayGeometry {
public:
    RayGeometry(VulkanContext& context, VkBuffer vertices, VkBuffer indices, std::uint32_t vertex_count,
                std::span<const RayMesh> meshes);
    ~RayGeometry();
    VkDeviceAddress address(std::size_t mesh) const;
    std::uint64_t bytes() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

// Each renderer owns its mutable instance acceleration structure and scratch.
class RayWorld {
public:
    RayWorld(VulkanContext& context, std::shared_ptr<RayGeometry> geometry);
    ~RayWorld();
    void update(std::span<const RayInstance> instances);
    void record(VkCommandBuffer command);
    VkAccelerationStructureKHR handle() const;
    unsigned instances() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace openslope
