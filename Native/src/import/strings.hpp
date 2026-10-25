#pragma once
#include <cctype>
#include <string>

namespace openslope::import_detail {
inline std::string upper(std::string text) {
    for (auto& c : text)
        c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    return text;
}
} // namespace openslope::import_detail
