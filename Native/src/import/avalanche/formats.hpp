#pragma once
#include "../shared.hpp"
#include <nlohmann/json_fwd.hpp>

namespace openslope::import_detail {
std::vector<DiscCourse> avalanche_courses(const DiscInput& disc, const ImportCancel& cancel);
unsigned write_avalanche_music(const DiscInput& disc, const std::filesystem::path& output,
                               const ImportProgress& progress, const ImportCancel& cancel);
nlohmann::json refresh_avalanche_lighting(const DiscInput& disc, const std::string& course,
                                          const std::filesystem::path& staging, const ImportCancel& cancel);
void write_avalanche_course(const DiscInput& disc, const std::string& course, const std::filesystem::path& output,
                            const ImportProgress& progress, const ImportCancel& cancel);
nlohmann::json refine_avalanche_props(const std::filesystem::path& output, Bytes collision,
                                      const std::vector<std::string>& materials, const ImportCancel& cancel);

} // namespace openslope::import_detail
