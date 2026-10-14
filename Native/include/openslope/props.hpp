#pragma once
#include "terrain.hpp"
#include <span>

namespace openslope {
using Transform=std::array<double,16>; // Column-major affine matrix, raw model frame.
Transform identity_transform();
Transform multiply(const Transform& a,const Transform& b);
Vec3 transform_point(const Transform& matrix,Vec3 point);
Transform placement(Vec3 position,std::array<double,4> rotation,Vec3 scale);
// GPU layout is std430: one matrix and seven vec4s, with lighting model-local.
struct PropPose {
    std::array<float,16> matrix{};
    std::array<float,4> ambient{};
    std::array<std::array<float,4>,3> direction{},colour{};
};
static_assert(sizeof(PropPose)==176);
struct PropPart {std::uint32_t first{},count{};std::string texture;std::uint32_t flags{};};
struct PropModel {std::vector<std::size_t> parts;Bounds bounds;};
struct PropObjectLayout {Transform rest;Bounds box;bool has_geometry=false;};
std::vector<std::vector<PropObjectLayout>> prop_layout(const std::filesystem::path& root);
std::vector<Transform> prop_placements(const std::filesystem::path& root);
Transform map_transform(Transform raw);
Transform inverse_transform(const Transform& matrix);
Vec3 transform_normal(const Transform& matrix,Vec3 normal);
struct PropInstance {std::size_t model{};PropPose pose;Bounds bounds;bool visible=true;};
struct Props {
    Mesh geometry;
    std::vector<PropPart> parts;
    std::vector<PropModel> models;
    std::vector<PropInstance> instances;
    static Props load(const std::filesystem::path& root);
};
// Metadata-only references used by document providers before mesh loading.
std::vector<std::string> prop_files(const std::filesystem::path& root);
bool prop_visible(const Bounds& bounds,std::span<const float,16> camera,Vec3 eye,double range=300);
std::array<double,3> prop_light(Vec3 normal,const PropPose& pose);
}
