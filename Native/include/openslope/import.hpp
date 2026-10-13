#pragma once
#include <cstdint>
#include <filesystem>
#include <functional>
#include <span>
#include <string>
#include <vector>

namespace openslope {
// A bounded, seekable input. Android supplies pread on a granted document FD;
// desktop tools supply an ordinary file. No filesystem path is inferred from a URI.
struct DiscInput {
    std::uint64_t size{};
    std::function<void(std::uint64_t,std::span<std::uint8_t>)> read_at;
    std::vector<std::uint8_t> read(std::uint64_t offset,std::size_t length) const;
};
struct DiscCourse { std::string name;std::uint64_t archive_bytes{}; };
using ImportProgress=std::function<void(const std::string&)>;
using ImportCancel=std::function<bool()>;
DiscInput open_disc(const std::filesystem::path& path);
std::vector<DiscCourse> disc_courses(const DiscInput& disc,const ImportCancel& cancelled={});
// Writes a NEW directory only. A failed/cancelled import removes only that
// directory. The host publishes it to Maps after this returns successfully.
void extract_course(const DiscInput& disc,const std::string& course,
                    const std::filesystem::path& output,
                    const ImportProgress& progress={},const ImportCancel& cancelled={});
std::vector<std::uint8_t> decode_refpack(std::span<const std::uint8_t> input);
bool valid_map_name(const std::string& name);
std::vector<std::string> available_maps(const std::filesystem::path& root);
}
