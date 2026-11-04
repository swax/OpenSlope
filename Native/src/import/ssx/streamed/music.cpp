#include "music.hpp"
#include <algorithm>
#include <map>
#include <set>

namespace openslope::import_detail {
namespace {
void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
} // namespace

MusicGraph ssx3_main_music(Bytes b, const ImportCancel& cancel) {
    // [Trailmap: 548-ssx3-music] v4 has packed 16-byte nodes and 128-byte
    // stream offsets. Its event programs and async bank track are not v3 routers.
    require(b.data.size() <= 4 * 1024 * 1024 && b.data.size() % 4 == 0, "Invalid SSX 3 music graph size");
    b.range(0, 32);
    require(b.text(0, 4) == "xDFP" && b.le(4, 2) == 4, "Unsupported SSX 3 music graph");
    const auto tracks = b.le(13, 1), events = b.le(15, 1), count = b.le(18, 2);
    require(tracks > 0 && tracks <= 4 && events > 0 && count > 0 && count <= 8192, "Invalid SSX 3 music graph counts");
    b.range(32, count * 2);

    struct Node {
        int sample;
        unsigned track;
        std::vector<MusicLink> links;
    };

    std::vector<Node> nodes;
    std::size_t tail = (32 + count * 2 + 3) & ~std::size_t(3);
    for (unsigned i = 0; i < count; ++i) {
        check_cancel(cancel);
        const auto at = std::size_t(b.le(32 + i * 2, 2)) * 4;
        require(at == tail, "Invalid SSX 3 music node extent");
        b.range(at, 16);
        Node node{b.signed16(at), (b.le(at) >> 16) & 31, {}};
        require(node.sample >= -1 && node.track < tracks, "Invalid SSX 3 music node");
        const auto links = (b.le(at + 4) >> 12) & 15;
        b.range(at + 16, links * 4);
        for (unsigned j = 0; j < links; ++j) {
            const auto p = at + 16 + j * 4;
            const MusicLink link{static_cast<std::int8_t>(b.le(p, 1)), static_cast<std::int8_t>(b.le(p + 1, 1)),
                                 b.signed16(p + 2)};
            require(link.min <= link.max && link.target >= -1 && link.target < int(count), "Invalid SSX 3 music link");
            node.links.push_back(link);
        }
        tail = at + 16 + links * 4;
        nodes.push_back(std::move(node));
    }
    b.range(tail, events * 2);
    std::size_t last_event = 0;
    for (unsigned i = 0; i < events; ++i) {
        const auto at = std::size_t(b.le(tail + i * 2, 2)) * 4;
        require(at >= tail + events * 2 && at >= last_event, "Invalid SSX 3 music event extent");
        b.range(at, 16);
        last_event = at;
    }
    // The event programs are opaque. Identify their following track-boundary
    // table by its self pointer, exact first boundary and final EOF boundary;
    // ambiguity is an error, rather than accepting an arbitrary plausible offset.
    std::vector<std::size_t> boundaries;
    for (auto at = last_event + 16; at + (tracks + 1) * 4 <= b.data.size(); at += 4) {
        if ((at & 4095) == 0)
            check_cancel(cancel);
        if (b.le(at - 4) != at / 4 || b.le(at) != (at + (tracks + 1) * 4) / 4 ||
            b.le(at + tracks * 4) != b.data.size() / 4)
            continue;
        std::vector<std::size_t> candidate;
        bool valid = true;
        for (unsigned i = 0; i <= tracks; ++i) {
            const auto word = b.le(at + i * 4);
            if (word > b.data.size() / 4) {
                valid = false;
                break;
            }
            const auto p = std::size_t(word) * 4;
            if (i && (p <= candidate.back() || (p - candidate.back()) % 8 || (p - candidate.back()) / 8 > 8192))
                valid = false;
            candidate.push_back(p);
        }
        if (!valid)
            continue;
        require(boundaries.empty(), "Ambiguous SSX 3 music sample table");
        boundaries = std::move(candidate);
    }
    require(!boundaries.empty(), "SSX 3 music sample table is missing");
    const auto sample_count = (boundaries[1] - boundaries[0]) / 8;
    std::set<unsigned> reached{0}, samples;
    std::vector<unsigned> pending{0};
    for (std::size_t i = 0; i < pending.size(); ++i) {
        check_cancel(cancel);
        const auto& node = nodes[pending[i]];
        require(node.track == 0 && node.sample <= int(sample_count), "Invalid SSX 3 main music track");
        if (node.sample > 0)
            samples.insert(unsigned(node.sample));
        for (const auto& link : node.links)
            if (link.target >= 0 && reached.insert(unsigned(link.target)).second)
                pending.push_back(unsigned(link.target));
    }
    require(!samples.empty(), "SSX 3 main music track has no samples");
    MusicGraph graph;
    graph.tracks = graph.sections = 1;
    std::map<unsigned, unsigned> node_ids, sample_ids;
    for (const auto index : reached)
        node_ids[index] = unsigned(node_ids.size());
    for (const auto index : samples) {
        const auto p = boundaries[0] + (index - 1) * 8;
        const auto offset = b.le(p), milliseconds = b.le(p + 4);
        require(offset <= 128 * 1024 * 1024 / 128 && milliseconds > 0 && milliseconds <= 120000,
                "Invalid SSX 3 music sample");
        const auto id = unsigned(graph.samples.size());
        sample_ids[index] = id + 1;
        auto name = std::to_string(id);
        while (name.size() < 3)
            name.insert(name.begin(), '0');
        graph.samples.push_back({"chunk_" + name + ".wav", std::size_t(offset) * 128, milliseconds});
    }
    for (const auto index : reached) {
        const auto& source = nodes[index];
        MusicNode node;
        node.sample = source.sample > 0 ? int(sample_ids.at(unsigned(source.sample))) : 0;
        // This common-format adaptation takes the zero-count exit of source
        // loop nodes. Script-controlled counters, event jumps and async mixing
        // remain deferred; source intensity branches are retained unchanged.
        for (const auto& link : source.links) {
            if (source.sample == -1 && (link.min > 0 || link.max < 0))
                continue;
            node.links.push_back({source.sample == -1 ? 0 : link.min, source.sample == -1 ? 127 : link.max,
                                  link.target < 0 ? 0 : int(node_ids.at(unsigned(link.target)))});
            if (source.sample == -1)
                break;
        }
        node.links.push_back({0, 127, 0}); // End/gap: restart the adapted song.
        graph.nodes.push_back(std::move(node));
    }
    for (unsigned level = 0; level <= 127; ++level) {
        MusicCursor cursor;
        for (unsigned i = 0; i < 64; ++i)
            require(music_advance(graph, cursor, level) >= 0, "SSX 3 main music path cannot play");
    }
    return graph;
}

OnTourMusicSong ontour_jukebox_music(Bytes b, std::uint32_t stream_id, std::size_t stream_bytes, unsigned section,
                                     const ImportCancel& cancel) {
    // [Trailmap: 549-ontour-music] Select a complete jukebox song, not the
    // gameplay arrangement. Source event/control programs remain opaque.
    require(b.data.size() <= 4 * 1024 * 1024 && b.data.size() % 4 == 0, "Invalid On Tour music graph size");
    b.range(0, 72);
    require(b.text(0, 4) == "xDFP" && b.le(4, 1) == 5 && b.le(5, 1) == 1 && b.le(13, 1) == 1,
            "Unsupported On Tour jukebox graph");
    const auto count = b.le(18, 2), events = b.le(15, 1), directory = b.le(20), start = b.le(24), nodes_end = b.le(28),
               track = b.le(48), samples = b.le(52);
    require(section > 0 && section <= b.le(14, 1) && section <= 63 && count > 0 && count <= 8192 && events > 0,
            "Invalid On Tour music counts/section");
    require(directory == 72 && start == ((72 + count * 2 + 3) & ~3u) && start <= nodes_end &&
                nodes_end + events * 2 <= track && samples == track + 20 && samples < b.data.size() &&
                (b.data.size() - samples) % 8 == 0 && b.le(56) == b.data.size(),
            "Invalid On Tour music directories");
    b.range(directory, count * 2);
    b.range(track, 20);
    require(stream_bytes >= 128 && stream_bytes <= 512 * 1024 * 1024 && b.le(track + 8) == stream_id,
            "On Tour music stream identity mismatch");
    const auto sample_count = (b.data.size() - samples) / 8;
    require(sample_count > 0 && sample_count <= 8192, "Invalid On Tour music sample count");
    std::vector<std::size_t> positions;
    for (std::size_t i = 0; i < sample_count; ++i) {
        check_cancel(cancel);
        const auto position = std::uint64_t(b.le(samples + i * 8)) * 128;
        const auto milliseconds = b.le(samples + i * 8 + 4);
        require(position >= 128 && position < stream_bytes && (positions.empty() || position > positions.back()) &&
                    milliseconds > 0 && milliseconds <= 3600000,
                "Invalid On Tour music sample extent");
        positions.push_back(std::size_t(position));
    }
    std::set<unsigned> selected;
    std::size_t tail = start;
    for (unsigned i = 0; i < count; ++i) {
        check_cancel(cancel);
        const auto at = std::size_t(b.le(directory + i * 2, 2)) * 4;
        require(at == tail && at + 16 <= nodes_end, "Invalid On Tour music node extent");
        const auto word = b.le(at), links = (b.le(at + 4) >> 12) & 15;
        const auto sample = b.signed16(at);
        require(sample >= -1 && sample <= int(sample_count) && at + 16 + links * 4 <= nodes_end,
                "Invalid On Tour music node");
        for (unsigned j = 0; j < links; ++j) {
            const auto p = at + 16 + j * 4;
            const auto lo = static_cast<std::int8_t>(b.le(p, 1)), hi = static_cast<std::int8_t>(b.le(p + 1, 1));
            const auto target = b.signed16(p + 2);
            require(lo <= hi && target >= -1 && target < int(count), "Invalid On Tour music link");
        }
        if (((word >> 21) & 63) == section && sample > 0) {
            require(((word >> 16) & 31) == 0, "On Tour jukebox song uses an unsupported track");
            selected.insert(unsigned(sample));
        }
        tail = at + 16 + links * 4;
    }
    require(tail == nodes_end && selected.size() == 1, "On Tour jukebox section has no unique complete song");
    const auto index = *selected.begin() - 1;
    const auto offset = positions[index], end = index + 1 < positions.size() ? positions[index + 1] : stream_bytes;
    require(end - offset >= 12, "Invalid On Tour jukebox stream extent");
    MusicGraph graph;
    graph.tracks = graph.sections = 1;
    MusicNode node;
    node.sample = 1;
    node.links.push_back({0, 127, 0});
    graph.nodes.push_back(node);
    graph.samples.push_back({"chunk_000.wav", offset, b.le(samples + index * 8 + 4)});
    return {std::move(graph), end};
}
} // namespace openslope::import_detail
