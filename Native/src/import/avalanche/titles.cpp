#include "titles.hpp"
#include "import/shared.hpp"
#include <algorithm>
#include <array>

namespace openslope::import_detail {
void avalanche_titles(const DiscInput& disc, std::vector<DiscCourse>& courses, const ImportCancel& cancel) {
    check_cancel(cancel);
    // GTEE01 revision 0: menu category/title pairs, family * 4 + layout.
    // Read the DOL load map; these are virtual pointers, never disc offsets.
    const auto boot = disc.read(0, 0x440);
    if (Bytes{boot}.text(0, 6) != "GTEE01" || boot[7] != 0)
        return;
    const auto start = Bytes{boot}.be(0x420);
    if (!start)
        return; // Authored fixtures and unsupported executables have no menu titles.
    const auto header = disc.read(start, 0x100);

    struct Section {
        std::uint32_t offset, address, size;
    };

    std::vector<Section> sections;
    std::size_t end = 0x100;
    for (unsigned i = 0; i < 18; ++i) {
        const Section s{Bytes{header}.be(i * 4), Bytes{header}.be(0x48 + i * 4), Bytes{header}.be(0x90 + i * 4)};
        if (!s.size)
            continue;
        if (s.offset < 0x100 || s.size > 32 * 1024 * 1024 || std::uint64_t(s.address) + s.size > 0x100000000ULL)
            throw std::runtime_error("Invalid course-title DOL section");
        end = std::max(end, std::size_t(s.offset) + s.size);
        sections.push_back(s);
    }
    if (end > 32 * 1024 * 1024)
        throw std::runtime_error("Oversized course-title DOL");
    const auto data = disc.read(start, end);
    const auto offset = [&](std::uint32_t address, std::size_t size) -> std::size_t {
        for (const auto& s : sections)
            if (address >= s.address && std::uint64_t(address) - s.address + size <= s.size)
                return std::size_t(s.offset) + address - s.address;
        throw std::runtime_error("Course-title pointer is outside DOL sections");
    };
    const auto title = [&](std::uint32_t address) {
        std::string text;
        for (unsigned i = 0; i <= 160; ++i) {
            const auto c = data[offset(address + i, 1)];
            if (!c)
                return text;
            if (c < 32 || c > 126)
                throw std::runtime_error("Invalid course-title text");
            text.push_back(char(c));
        }
        throw std::runtime_error("Unterminated course title");
    };
    constexpr std::uint32_t menu = 0x8018bef4;
    std::array<std::string, 28> names;
    for (unsigned i = 0; i < names.size(); ++i) {
        const auto p = offset(menu + i * 8, 8);
        if (title(Bytes{data}.be(p)).empty())
            throw std::runtime_error("Missing course category");
        names[i] = title(Bytes{data}.be(p + 4));
        if (names[i].empty())
            throw std::runtime_error("Missing course title");
    }
    for (auto& course : courses) {
        check_cancel(cancel);
        if (course.name.size() != 18 || !course.name.starts_with("AVALANCHE_CRS0") || course.name[15] != '_' ||
            course.name[16] != '0' || course.name[14] < '0' || course.name[14] > '6' || course.name[17] < '0' ||
            course.name[17] > '3')
            continue;
        // Canonical slot spelling is validated below rather than accepting arbitrary suffixes.
        const auto stem = course.name.substr(10);
        if (stem.size() != 8)
            continue;
        const auto family = unsigned(stem[4] - '0'), layout = unsigned(stem[7] - '0');
        if (family > 6 || layout > 3)
            continue;
        course.display_name = names[family * 4 + layout];
        course.name_source = "main.dol:menu-course-titles";
    }
}
} // namespace openslope::import_detail
