#pragma once
#include "../shared.hpp"

namespace openslope::import_detail {
struct Extent {
    std::string name;
    std::uint64_t offset{}, size{};
    bool directory{};
};

class Iso {
    const DiscInput& disc_;
    Extent root_;
    Extent record(Bytes bytes, std::size_t offset) const;

public:
    explicit Iso(const DiscInput& disc);
    std::vector<Extent> children(const Extent& directory) const;
    Extent find(const std::string& path) const;
};

bool iso9660_disc(const DiscInput& disc);
DiscInput rvz_disc(const DiscInput& source);
bool gamecube_disc(const DiscInput& disc);
std::vector<DiscEntry> gamecube_directory(const DiscInput& disc, const std::string& path);
std::vector<std::uint8_t> gamecube_file(const DiscInput& disc, const std::string& path);
} // namespace openslope::import_detail
