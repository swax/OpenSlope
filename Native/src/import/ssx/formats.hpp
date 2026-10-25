#pragma once
#include "../shared.hpp"
#include <map>
#include <nlohmann/json_fwd.hpp>

namespace openslope::import_detail {
std::vector<DiscCourse> ssx3_courses(std::span<const std::uint8_t> database, std::uint64_t bytes);
std::vector<DiscCourse> ontour_courses(std::span<const std::uint8_t> database, std::span<const std::uint8_t> ids,
                                       std::span<const std::uint8_t> strings, const std::vector<DiscEntry>& members,
                                       std::uint64_t bytes);
void write_mountain_course(const DiscInput& disc, const DiscInput& stream, std::span<const std::uint8_t> database,
                           std::span<const std::uint8_t> identifiers, std::span<const std::uint8_t> names,
                           const std::string& course, const std::filesystem::path& output,
                           const ImportProgress& progress, const ImportCancel& cancel);
nlohmann::json import_pose(Bytes data, std::size_t offset, double scale = 1);
std::size_t write_ssx3_mesh(Bytes data, double x, double y, double z, const std::filesystem::path& path,
                            const ImportCancel& cancel);
nlohmann::json streamed_material_setup(Bytes program, bool tour);
std::pair<bool, bool> streamed_prop_admission(const std::string& name, bool debug);
bool ontour_boundary_helper(const std::string& name);
bool ontour_course_helper(const std::string& name);
bool ontour_course_root(const std::filesystem::path& root);
unsigned prepare_ontour_helpers(nlohmann::json& instances, const nlohmann::json& models);
unsigned repair_ontour_helper_instances(const std::filesystem::path& root, nlohmann::json& instances);
void retire_streamed_reset_bindings(nlohmann::json& effects);
nlohmann::json streamed_playtest_props(nlohmann::json& instances, nlohmann::json& effects,
                                       const ImportCancel& cancel = {});
unsigned streamed_playtest_lights(nlohmann::json& document);
nlohmann::json write_streamed_riding_audio(const std::filesystem::path& map, bool tour, const ImportCancel& cancel);
nlohmann::json write_streamed_ambient_audio(const std::filesystem::path& map, bool tour, const ImportCancel& cancel);
bool write_ssx3_audio(const DiscInput& disc, const std::filesystem::path& output, const std::string& course,
                      const ImportProgress& progress, const ImportCancel& cancel);
bool write_ssx_audio(const DiscInput& disc, const std::filesystem::path& output, const std::string& course,
                     const ImportProgress& progress, const ImportCancel& cancel);
bool write_ontour_audio(const DiscInput& disc, const std::filesystem::path& output, const std::string& course,
                        const ImportProgress& progress, const ImportCancel& cancel);

void ssx_header(std::span<const std::uint8_t> index);
void write_ssx_course(const DiscInput& disc, const std::map<std::string, std::vector<std::uint8_t>>& files,
                      const std::string& course, const std::filesystem::path& output, const ImportProgress& progress,
                      const ImportCancel& cancel);
bool write_ssx_props(std::span<const std::uint8_t> index, std::span<const std::uint8_t> models,
                     std::span<const std::uint8_t> instances, const std::vector<Image>& textures,
                     const std::filesystem::path& output, const ImportCancel& cancel);
std::string patch_document(std::span<const std::uint8_t> records, const std::vector<std::string>& names,
                           const std::vector<Image>& images, bool original = false);

void write_crowd(std::span<const std::uint8_t> source, const std::filesystem::path& root,
                 const ImportCancel& cancel = {});
std::vector<Image> decode_ssh(std::span<const std::uint8_t> bytes, bool lightmap, const ImportCancel& cancelled,
                              bool particle = false, bool original = false);
std::string light_document(std::span<const std::uint8_t> geometry);
std::string ssx_light_document(std::span<const std::uint8_t> index, std::span<const std::uint8_t> world);
void write_paths(const std::vector<std::uint8_t>& bytes, const std::filesystem::path& output,
                 const ImportCancel& cancelled);
void write_collision(const std::vector<std::uint8_t>& bytes, const std::filesystem::path& output,
                     const ImportCancel& cancelled, bool original = false);
std::string logic_document(std::span<const std::uint8_t> bytes, const std::string& course,
                           const ImportCancel& cancelled = {});
void write_logic(const std::vector<std::uint8_t>& bytes, const std::filesystem::path& output, const std::string& course,
                 const ImportCancel& cancelled);
void write_rails(const std::vector<std::uint8_t>& geometry, const std::vector<std::uint8_t>& linker,
                 const std::vector<std::uint8_t>* behavior, const std::filesystem::path& output,
                 const ImportCancel& cancelled);
std::vector<std::vector<std::uint32_t>> material_frame_indices(std::span<const std::uint8_t> source);
void write_props(const std::vector<std::uint8_t>& pbd, const std::vector<std::uint8_t>& linker,
                 const std::vector<Image>& textures, const std::vector<std::uint8_t>* behavior,
                 const std::filesystem::path& output, const ImportCancel& cancelled, bool anonymous = false);
bool write_course_audio(const DiscInput& disc, const std::string& course,
                        const std::map<std::string, std::vector<std::uint8_t>>& files,
                        const std::filesystem::path& output, const ImportProgress& progress,
                        const ImportCancel& cancelled);

void pbd_header(Bytes bytes);
void write_tricky_course(const DiscInput& disc, const std::map<std::string, std::vector<std::uint8_t>>& files,
                         const std::string& course, const std::filesystem::path& output, const ImportProgress& progress,
                         const ImportCancel& cancel);
} // namespace openslope::import_detail
