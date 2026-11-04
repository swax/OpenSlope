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
} // namespace openslope::import_detail
