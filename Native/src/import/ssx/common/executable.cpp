#include "import/ssx/common/executable_internal.hpp"
#include <cctype>

namespace openslope::executable_detail {
namespace {
std::string upper(std::string value) {
    for (auto& c : value)
        c = char(std::toupper(static_cast<unsigned char>(c)));
    return value;
}
} // namespace

std::optional<BootExecutable> boot_executable(const DiscInput& disc, const ImportCancel& cancelled) {
    import_detail::check_cancel(cancelled);
    const auto entries = disc_directory(disc, "");
    const auto cnf = std::find_if(entries.begin(), entries.end(),
                                  [](const auto& e) { return !e.directory && upper(e.name) == "SYSTEM.CNF"; });
    if (cnf == entries.end())
        return {};
    if (cnf->bytes > 65536)
        throw std::runtime_error("Boot settings exceed limit");
    const auto config = disc_file(disc, cnf->name);
    std::string text(config.begin(), config.end()), path;
    std::size_t at = 0;
    while (at < text.size()) {
        auto end = text.find_first_of("\r\n", at);
        if (end == std::string::npos)
            end = text.size();
        auto line = text.substr(at, end - at);
        at = end + 1;
        const auto equal = line.find('=');
        if (equal == std::string::npos)
            continue;
        auto key = upper(line.substr(0, equal));
        key.erase(std::remove_if(key.begin(), key.end(), [](unsigned char c) { return std::isspace(c); }), key.end());
        if (key != "BOOT2")
            continue;
        auto value = line.substr(equal + 1);
        const auto prefix = upper(value).find("CDROM");
        if (prefix == std::string::npos)
            throw std::runtime_error("Invalid boot executable reference");
        const auto colon = value.find(':', prefix);
        if (colon == std::string::npos)
            throw std::runtime_error("Invalid boot executable reference");
        value = value.substr(colon + 1);
        const auto semi = value.find(';');
        if (semi != std::string::npos)
            value.resize(semi);
        const auto last = value.find_last_not_of(" \t");
        if (last != std::string::npos)
            value.resize(last + 1);
        std::replace(value.begin(), value.end(), '\\', '/');
        const auto first = value.find_first_not_of('/');
        if (first == std::string::npos)
            throw std::runtime_error("Empty boot executable reference");
        path = value.substr(first);
        break;
    }
    if (path.empty())
        return {};
    const auto parts = std::filesystem::path(path);
    for (const auto& part : parts)
        if (!valid_map_name(part.string()) || part == "." || part == "..")
            throw std::runtime_error("Unsafe boot executable reference");
    import_detail::check_cancel(cancelled);
    const auto slash = path.find_last_of('/');
    const auto directory = slash == std::string::npos ? std::string{} : path.substr(0, slash);
    const auto leaf = upper(slash == std::string::npos ? path : path.substr(slash + 1));
    const auto files = disc_directory(disc, directory);
    const auto boot = std::find_if(files.begin(), files.end(),
                                   [&](const auto& file) { return !file.directory && upper(file.name) == leaf; });
    if (boot == files.end() || boot->bytes > 64 * 1024 * 1024)
        throw std::runtime_error("Missing or oversized boot executable");
    const auto executable = disc_file(disc, path);
    return BootExecutable{leaf, executable};
}
} // namespace openslope::executable_detail
