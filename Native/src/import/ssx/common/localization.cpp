#include "localization.hpp"
#include "import/strings.hpp"
#include <cctype>

namespace openslope::import_detail {
std::uint32_t locale_key(std::string_view key) {
    std::uint32_t hash = 0;
    for (const unsigned char c : key) {
        hash = (hash << 4) + c;
        const auto high = hash & 0xf0000000u;
        if (high)
            hash ^= high >> 23;
        hash &= ~high;
    }
    return hash;
}

std::map<std::uint32_t, std::string> localized_titles(std::span<const std::uint8_t> data) {
    const Bytes b{data};
    if (data.size() < 36 || data.size() > 4 * 1024 * 1024 || b.text(0, 4) != "LOCH")
        return {};
    const auto locl = b.le(16);
    b.range(locl, 16);
    if (b.text(locl, 4) != "LOCL")
        return {};
    const auto size = b.le(locl + 4), count = b.le(locl + 12);
    if (count > 65535 || size < 16 + std::uint64_t(count) * 4)
        throw std::runtime_error("Invalid locale text table");
    b.range(locl, size);
    // On Tour puts LOCT after LOCL; SSX 3 puts it before. Both offsets are file-relative.
    const auto loct = locl == 20 ? locl + size : 20;
    b.range(loct, 12);
    if (b.text(loct, 4) != "LOCT")
        return {};
    const auto header = b.le(loct + 4);
    const auto end = locl == 20 ? data.size() : std::size_t(locl);
    if (header < 12 || header > 64 || std::size_t(loct) + header > end || (end - loct - header) % 8)
        throw std::runtime_error("Invalid locale hash table");
    const auto text = [&](std::uint32_t index) {
        if (index >= count)
            throw std::runtime_error("Invalid locale text index");
        const auto start = b.le(locl + 16 + index * 4);
        if (start < 16 + count * 4 || start >= size || start % 2)
            throw std::runtime_error("Invalid locale string offset");
        std::string result;
        const auto append = [&](std::uint32_t c) {
            if (c < 0x80)
                result += char(c);
            else if (c < 0x800) {
                result += char(0xc0 | (c >> 6));
                result += char(0x80 | (c & 63));
            } else if (c < 0x10000) {
                result += char(0xe0 | (c >> 12));
                result += char(0x80 | ((c >> 6) & 63));
                result += char(0x80 | (c & 63));
            } else {
                result += char(0xf0 | (c >> 18));
                result += char(0x80 | ((c >> 12) & 63));
                result += char(0x80 | ((c >> 6) & 63));
                result += char(0x80 | (c & 63));
            }
        };
        for (std::size_t p = start; p + 2 <= size && result.size() <= 800; p += 2) {
            auto c = b.le(locl + p, 2);
            if (!c)
                return result;
            if (c >= 0xd800 && c <= 0xdbff) {
                if (p + 4 > size)
                    return std::string{};
                const auto low = b.le(locl + p + 2, 2);
                if (low < 0xdc00 || low > 0xdfff)
                    return std::string{};
                c = 0x10000 + ((c - 0xd800) << 10) + low - 0xdc00;
                p += 2;
            } else if (c >= 0xdc00 && c <= 0xdfff)
                return std::string{};
            append(c);
        }
        return std::string{};
    };
    std::map<std::uint32_t, std::string> result;
    for (std::size_t p = loct + header; p + 8 <= end; p += 8)
        result.emplace(b.le(p), text(b.le(p + 4)));
    return result;
}

void ontour_titles(const DiscInput& disc, std::vector<DiscCourse>& courses, const ImportCancel& cancel) {
    const auto data = disc_file(disc, "DATA/LOCALE/FEAMER.LOC");
    const auto names = localized_titles(data);
    for (auto& course : courses) {
        check_cancel(cancel);
        if (course.name.size() < 13 || !course.name.starts_with("SSXOT_"))
            continue;
        auto code = course.name.substr(6, 3);
        for (auto& c : code)
            c = char(std::tolower(static_cast<unsigned char>(c)));
        const auto key = code == "vh1" ? "TRACK_AREA_Village" : "TRACK_NAME_" + code;
        const auto found = names.find(locale_key(key));
        if (found == names.end() || found->second.empty())
            continue;
        auto title = found->second;
        const auto variant =
            names.find(locale_key(course.name.ends_with("_NIGHT") ? "MAP_FreerideNight" : "MAP_FreerideDay"));
        if (variant != names.end()) {
            const auto marker = variant->second.find("%s");
            if (marker != std::string::npos) {
                auto suffix = variant->second.substr(marker + 2);
                const auto first = suffix.find_first_not_of(' ');
                if (first != std::string::npos)
                    title += " (" + suffix.substr(first) + ")";
            }
        }
        course.display_name = title;
        course.name_source = "DATA/LOCALE/FEAMER.LOC:" + key;
    }
}
} // namespace openslope::import_detail
