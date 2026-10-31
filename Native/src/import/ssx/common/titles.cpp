#include "titles.hpp"
#include "executable_internal.hpp"
#include "import/strings.hpp"
#include "localization.hpp"
#include <map>

namespace openslope::import_detail {
void ssx_titles(const DiscInput& disc, std::vector<DiscCourse>& courses, const ImportCancel& cancel) {
    if (!courses.empty() && courses.front().name.starts_with("SSXOT_")) {
        ontour_titles(disc, courses, cancel);
        return;
    }
    const auto boot = executable_detail::boot_executable(disc, cancel);
    if (!boot)
        return;
    const executable_detail::Executable executable(boot->bytes);
    const Bytes b{boot->bytes};
    const auto text = [&](std::uint32_t address, unsigned limit = 80) {
        std::string value;
        for (unsigned i = 0; i < limit; ++i) {
            const auto c = executable.read(address + i);
            if (!c)
                return std::string{};
            if (!*c)
                return value;
            if (*c < 32 || *c > 126)
                return std::string{};
            value.push_back(char(*c));
        }
        return std::string{};
    };
    std::map<std::string, std::string> titles;
    const bool streamed =
        !courses.empty() && (courses.front().name.starts_with("SSX3_") || courses.front().name.starts_with("SSXOT_"));
    const unsigned stride = !courses.empty() && courses.front().name.starts_with("SSX_") ? 24 : 28;
    for (std::size_t p = 0; p + 100 <= boot->bytes.size(); p += 4) {
        if (p % 65536 == 0)
            check_cancel(cancel);
        // SSX/Tricky's course records: ordinal, title, menu key, length, alias, file stem.
        if (!streamed && b.le(p) < 64) {
            const auto key = upper(text(b.le(p + 20), 16));
            if (!key.empty()) {
                const auto title = text(b.le(p + 4));
                const auto menu_key = text(b.le(p + 8), 32);
                const bool neighbour =
                    (p + stride + 24 <= boot->bytes.size() && b.le(p + stride) == b.le(p) + 1 &&
                     !text(b.le(p + stride + 20), 16).empty()) ||
                    (p >= stride && b.le(p - stride) + 1 == b.le(p) && !text(b.le(p - stride + 20), 16).empty());
                if (neighbour && !title.empty() && !menu_key.empty() && upper(menu_key) == menu_key)
                    titles.emplace(key, title);
            }
        }
        // SSX 3's fixed course descriptors: title[32], short title[16], section[16], world[16].
        if (b.text(p + 64, 3) == "BAM" && boot->bytes[p + 67] == 0) {
            const auto inline_text = [&](std::size_t at, unsigned length) {
                std::string value;
                for (unsigned i = 0; i < length; ++i) {
                    const auto c = boot->bytes[at + i];
                    if (!c)
                        return value;
                    if (c < 32 || c > 126)
                        return std::string{};
                    value.push_back(char(c));
                }
                return std::string{};
            };
            const auto key = upper(inline_text(p + 48, 16)), title = inline_text(p, 32);
            if (!key.empty() && !title.empty())
                titles.emplace("SSX3_" + key, title);
        }
    }
    for (auto& course : courses) {
        const auto key = course.name.starts_with("SSX_")      ? course.name.substr(4)
                         : course.name.starts_with("TRICKY_") ? course.name.substr(7)
                                                              : course.name;
        if (const auto found = titles.find(key); found != titles.end()) {
            course.display_name = found->second;
            course.name_source = boot->name + ":course-descriptors";
        }
    }
    for (auto& course : courses) {
        if (!course.display_name.empty() || !course.name.starts_with("SSX3_"))
            continue;
        if (course.name.size() == 10 && course.name.starts_with("SSX3_PEAK") && course.name.back() >= '1' &&
            course.name.back() <= '3') {
            course.display_name = "Peak " + course.name.substr(9);
            course.name_source = "openslope:peak-selection";
            continue;
        }
        const auto split = course.name.find('_', 5);
        if (split == std::string::npos)
            continue;
        const auto first = titles.find(course.name.substr(0, split)),
                   last = titles.find("SSX3_" + course.name.substr(split + 1));
        if (first != titles.end() && last != titles.end()) {
            course.display_name = first->second + " / " + last->second;
            course.name_source = boot->name + ":course-descriptors/connector";
        }
    }
}
} // namespace openslope::import_detail
