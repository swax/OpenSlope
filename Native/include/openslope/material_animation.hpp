#pragma once
#include <filesystem>
#include <string>
#include <vector>

namespace openslope {
std::vector<std::vector<std::string>> material_flipbooks(const std::filesystem::path& root);
}
