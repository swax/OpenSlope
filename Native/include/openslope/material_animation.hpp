#pragma once
#include <filesystem>
#include <vector>
#include <string>
namespace openslope {
std::vector<std::vector<std::string>> material_flipbooks(const std::filesystem::path& root);
}
