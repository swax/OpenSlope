#include "music_cache.hpp"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <fstream>

namespace openslope::import_detail {
namespace {
using Json = nlohmann::json;

void check(const ImportCancel& cancel) {
    if (cancel && cancel())
        throw std::runtime_error("Import cancelled");
}

bool relative_file(const std::string& name) {
    const std::filesystem::path path(name);
    if (name.empty() || path.is_absolute() || path.has_root_name() || name.find('\\') != std::string::npos)
        return false;
    for (const auto& part : path)
        if (part == ".." || part == "." || part.empty())
            return false;
    return true;
}

std::string file_hash(const std::filesystem::path& path, const ImportCancel& cancel) {
    std::ifstream input(path, std::ios::binary);
    if (!input)
        throw std::runtime_error("Cannot read music cache file");
    Sha256 hash;
    std::array<std::uint8_t, 65536> buffer{};
    while (input) {
        check(cancel);
        input.read(reinterpret_cast<char*>(buffer.data()), buffer.size());
        hash.add(std::span(buffer).first(std::size_t(input.gcount())));
    }
    if (!input.eof())
        throw std::runtime_error("Cannot finish reading music cache file");
    return hash.finish();
}

Json manifest(const std::string& key, const std::filesystem::path& root, const ImportCancel& cancel) {
    Json files = Json::array();
    std::uint64_t total = 0;
    for (const auto& file : std::filesystem::recursive_directory_iterator(root)) {
        check(cancel);
        if (file.is_symlink())
            throw std::runtime_error("Music cache cannot contain links");
        if (!file.is_regular_file())
            continue;
        const auto name = std::filesystem::relative(file.path(), root).generic_string();
        const auto size = file.file_size();
        if (!relative_file(name) || size > 64 * 1024 * 1024 || (total += size) > 512ull * 1024 * 1024 ||
            files.size() >= 4096)
            throw std::runtime_error("Music cache entry exceeds its limits");
        files.push_back({{"Path", name}, {"Bytes", size}, {"Hash", file_hash(file.path(), cancel)}});
    }
    if (files.empty())
        throw std::runtime_error("Empty music cache entry");
    return {{"Version", 1}, {"Key", key}, {"Files", files}, {"Bytes", total}};
}

bool valid(const Json& value, const std::string& key, const std::filesystem::path& root, const ImportCancel& cancel) {
    if (std::filesystem::is_symlink(root) || !std::filesystem::is_directory(root))
        return false;
    if (!value.is_object() || value.value("Version", 0) != 1 || value.value("Key", std::string{}) != key ||
        !value.contains("Files") || !value["Files"].is_array() || value["Files"].empty() ||
        value["Files"].size() > 4096)
        return false;
    std::uint64_t total = 0;
    for (const auto& file : value["Files"]) {
        check(cancel);
        const auto name = file.at("Path").get<std::string>();
        if (!relative_file(name))
            return false;
        const auto path = root / name;
        auto parent = path;
        while (parent != root) {
            if (std::filesystem::is_symlink(parent))
                return false;
            parent = parent.parent_path();
        }
        const auto size = file.at("Bytes").get<std::uint64_t>();
        if (size > 64 * 1024 * 1024 || (total += size) > 512ull * 1024 * 1024 ||
            !std::filesystem::is_regular_file(path) || std::filesystem::file_size(path) != size ||
            file_hash(path, cancel) != file.at("Hash").get<std::string>())
            return false;
    }
    std::size_t count = 0;
    for (const auto& file : std::filesystem::recursive_directory_iterator(root)) {
        if (file.is_symlink() || (!file.is_directory() && !file.is_regular_file()))
            return false;
        if (file.is_regular_file() && ++count > value["Files"].size())
            return false;
    }
    return count == value["Files"].size() && total == value.value("Bytes", std::uint64_t{});
}

void copy_files(const Json& value, const std::filesystem::path& source, const std::filesystem::path& target,
                const ImportCancel& cancel) {
    std::filesystem::create_directories(target);
    for (const auto& file : value.at("Files")) {
        check(cancel);
        const auto name = file.at("Path").get<std::string>();
        std::filesystem::create_directories((target / name).parent_path());
        std::filesystem::copy_file(source / name, target / name);
    }
}

bool cache_room(const ImportContext& context, const std::string& keep, std::uint64_t needed,
                const ImportCancel& cancel) {
    struct Entry {
        std::filesystem::path path;
        std::uint64_t bytes;
        std::filesystem::file_time_type used;
    };

    std::vector<Entry> entries;
    std::uint64_t total = 0;
    for (const auto& directory : std::filesystem::directory_iterator(context.music_root)) {
        check(cancel);
        const auto name = directory.path().filename().string();
        if (!directory.is_symlink() && directory.is_directory() && name.starts_with(".pending-") &&
            directory.last_write_time() < std::filesystem::file_time_type::clock::now() - std::chrono::hours(1)) {
            std::filesystem::remove_all(directory.path());
            continue;
        }
        if (directory.is_symlink() || !directory.is_directory() || name.size() != 64 ||
            name.find_first_not_of("0123456789abcdef") != std::string::npos || name == keep)
            continue;
        const auto path = directory.path() / "manifest.json";
        try {
            if (!std::filesystem::is_regular_file(path) || std::filesystem::file_size(path) > 1024 * 1024)
                continue;
            std::ifstream file(path);
            const auto value = Json::parse(file);
            const auto bytes = value.at("Bytes").get<std::uint64_t>();
            if (bytes > 512ull * 1024 * 1024)
                continue;
            total += bytes;
            entries.push_back({directory.path(), bytes, directory.last_write_time()});
        } catch (const std::exception&) {
            check(cancel);
        }
    }
    std::sort(entries.begin(), entries.end(), [](const auto& a, const auto& b) { return a.used < b.used; });
    for (const auto& entry : entries) {
        if (total + needed <= context.music_limit)
            break;
        // Recently used entries may be being copied by another process.
        if (entry.used > std::filesystem::file_time_type::clock::now() - std::chrono::minutes(5))
            continue;
        check(cancel);
        std::filesystem::remove_all(entry.path);
        total -= entry.bytes;
    }
    return total + needed <= context.music_limit;
}
} // namespace

std::string music_key(std::string_view converter, std::string_view parameters,
                      std::initializer_list<std::span<const std::uint8_t>> sources) {
    Sha256 hash;
    const auto add = [&](std::span<const std::uint8_t> bytes) {
        std::array<std::uint8_t, 8> size{};
        for (unsigned i = 0; i < 8; ++i)
            size[i] = std::uint8_t(std::uint64_t(bytes.size()) >> (i * 8));
        hash.add(size);
        hash.add(bytes);
    };
    add({reinterpret_cast<const std::uint8_t*>(converter.data()), converter.size()});
    add({reinterpret_cast<const std::uint8_t*>(parameters.data()), parameters.size()});
    for (const auto bytes : sources)
        add(bytes);
    return hash.finish();
}

void cached_music(const DiscInput& disc, const std::string& key, const std::filesystem::path& destination,
                  const std::function<void()>& convert, const ImportCancel& cancel) {
    const auto context = disc.context;
    if (!context || context->music_root.empty()) {
        convert();
        return;
    }
    if (key.size() != 64 || key.find_first_not_of("0123456789abcdef") != std::string::npos)
        throw std::runtime_error("Invalid music cache key");
    if (context->planning) {
        context->music.push_back({{"Key", key}, {"Destination", destination.generic_string()}});
        return;
    }
    const auto entry = context->music_root / key;
    Json stored;
    bool hit = false;
    try {
        if (!std::filesystem::is_symlink(context->music_root) && !std::filesystem::is_symlink(entry) &&
            std::filesystem::is_regular_file(entry / "manifest.json") &&
            std::filesystem::file_size(entry / "manifest.json") <= 1024 * 1024) {
            std::ifstream input(entry / "manifest.json");
            stored = Json::parse(input);
            hit = valid(stored, key, entry / "files", cancel);
        }
    } catch (const std::exception&) {
        check(cancel);
    }
    if (hit) {
        check(cancel);
        std::error_code touch_error;
        std::filesystem::last_write_time(entry, std::filesystem::file_time_type::clock::now(), touch_error);
        std::filesystem::create_directories(destination.parent_path());
        if (context->external)
            std::filesystem::rename(entry / "files", destination);
        else
            copy_files(stored, entry / "files", destination, cancel);
        ++context->stats.music_hits;
        if (context->progress)
            context->progress("Reusing imported music");
    } else {
        convert();
        ++context->stats.music_misses;
        stored = manifest(key, destination, cancel);
        if (!context->external) {
            // Cache failures are optional; completed map output still belongs to the importer.
            std::filesystem::path staging;
            try {
                if (std::filesystem::is_symlink(context->music_root))
                    throw std::runtime_error("Music cache root is a link");
                std::filesystem::create_directories(context->music_root);
                if (!cache_room(*context, key, stored.at("Bytes").get<std::uint64_t>(), cancel))
                    throw std::runtime_error("Music cache budget reached");
                static std::atomic<unsigned> serial{0};
                staging = context->music_root /
                          (".pending-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) +
                           "-" + std::to_string(serial++));
                if (!std::filesystem::create_directory(staging))
                    throw std::runtime_error("Cannot stage music cache");
                copy_files(stored, destination, staging / "files", cancel);
                std::ofstream file(staging / "manifest.json");
                file << stored.dump();
                file.close();
                if (!file)
                    throw std::runtime_error("Cannot publish music cache manifest");
                check(cancel);
                if (std::filesystem::exists(entry))
                    std::filesystem::remove_all(entry);
                std::filesystem::rename(staging, entry);
            } catch (const std::exception&) {
                if (!staging.empty()) {
                    std::error_code ec;
                    std::filesystem::remove_all(staging, ec);
                }
                check(cancel);
            }
        }
    }
    context->music.push_back(
        {{"Key", key}, {"Destination", destination.generic_string()}, {"Manifest", stored}, {"Hit", hit}});
}
} // namespace openslope::import_detail
