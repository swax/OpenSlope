#pragma once
#include "disc.hpp"
#include <map>
#include <string_view>

namespace openslope::import_detail {
// Seekable, hash-indexed PGRP/PFIL packages. Independent of game selection.
class Pak {
    struct Chunk {
        std::uint32_t source{}, packed{}, size{}, offset{}, window{}, maximum{}, fill{};
        bool compressed{};
    };

    struct Member {
        std::uint32_t size{}, count{};
        std::vector<Chunk> chunks;
    };

    const DiscInput& disc_;
    Extent extent_;
    std::map<std::uint32_t, std::vector<Member>> members_;
    std::vector<std::uint8_t> read(const Member& member, const ImportCancel& cancel) const;

public:
    Pak(const DiscInput& disc, const Extent& extent, const ImportCancel& cancel = {});
    static std::uint32_t name_hash(std::string_view name);
    bool contains(std::string_view name) const;
    std::vector<std::uint8_t> file(std::string_view name, const ImportCancel& cancel = {}) const;
    // Opt in only when every repeated resource decodes to identical bytes.
    std::vector<std::uint8_t> equivalent_file(std::string_view name, const ImportCancel& cancel = {}) const;
};
} // namespace openslope::import_detail
