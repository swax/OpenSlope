#include "titles.hpp"
#include "import/containers/pak.hpp"
#include "import/strings.hpp"
#include <map>
#include <sstream>

namespace openslope::import_detail {
void madtrix_titles(const DiscInput& disc, std::vector<DiscCourse>& courses, const ImportCancel& cancel) {
    std::ostringstream path;
    path << "DATA/" << std::uppercase << std::hex << Pak::name_hash("config.pak") << ".DAT";
    const Iso iso(disc);
    const Pak config(disc, iso.find(path.str()), cancel);
    if (!config.contains("Text/strings.csv"))
        return;
    const auto data = config.file("Text/strings.csv", cancel);
    if (data.size() > 2 * 1024 * 1024)
        throw std::runtime_error("Oversized course-name CSV");
    // The first field is the package key and the second is the USA English title.
    // Quoted commas/newlines and doubled quotes occur in this source CSV.
    std::map<std::string, std::string> names;
    std::vector<std::string> row;
    std::string field;
    bool quoted = false;
    for (std::size_t i = 0; i <= data.size(); ++i) {
        if (i % 65536 == 0)
            check_cancel(cancel);
        const char c = i == data.size() ? '\n' : char(data[i]);
        if (c == '"') {
            if (quoted && i + 1 < data.size() && data[i + 1] == '"') {
                field += '"';
                ++i;
            } else
                quoted = !quoted;
        } else if (!quoted && (c == ',' || c == '\n')) {
            row.push_back(field);
            field.clear();
            if (c == '\n') {
                if (row.size() > 1 && row[0].size() > 4 && upper(row[0]).ends_with(".PAK") && row[1].size() <= 200)
                    names.emplace(upper(row[0]), row[1]);
                row.clear();
            }
        } else if (c != '\r')
            field += c;
    }
    if (quoted)
        throw std::runtime_error("Unterminated course-name CSV field");
    for (auto& course : courses) {
        if (!course.name.starts_with("MADTRIX_"))
            continue;
        if (const auto found = names.find(course.name.substr(8) + ".PAK");
            found != names.end() && !found->second.empty()) {
            course.display_name = found->second;
            course.name_source = path.str() + ":Text/strings.csv/en-US";
        }
    }
}
} // namespace openslope::import_detail
