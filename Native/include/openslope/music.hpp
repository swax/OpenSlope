#pragma once
#include "audio.hpp"
#include <optional>
#include <string>

namespace openslope {
struct MusicLink {
    int min{}, max{}, target{};
};

struct MusicNode {
    int sample{};
    unsigned track{}, flags{}, word1{}, word2{};
    std::vector<MusicLink> links;
};

struct MusicSample {
    std::string wav;
    std::size_t offset{};
    unsigned milliseconds{};
};

struct MusicGraph {
    unsigned tracks{}, sections{}, events{};
    std::vector<MusicNode> nodes;
    std::vector<MusicSample> samples;
    std::vector<std::uint8_t> event_table;
    std::vector<std::uint32_t> routers, variable_offsets;
    std::vector<std::vector<std::array<int, 2>>> variables;
    static MusicGraph decode(std::span<const std::uint8_t> source);
    static MusicGraph load(const std::filesystem::path& path);
    void save(const std::filesystem::path& path, const std::string& name, double bpm = 120, double volume = 1) const;
};

struct MusicCursor {
    int node = 0;
    int loop_count{}, loop_node = -1;
    unsigned track{};
    double action_volume = 1;
    bool ended = false;
};

// Resolves control nodes without scheduling any audio. Events are applied only
// by the caller at a chunk boundary; first inclusive matching link wins.
int music_advance(const MusicGraph& graph, MusicCursor& cursor, unsigned level, std::optional<unsigned> event = {});
} // namespace openslope
