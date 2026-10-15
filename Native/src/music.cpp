#include "openslope/music.hpp"
#include "import_internal.hpp"
#include <fstream>
#include <nlohmann/json.hpp>

namespace openslope {
namespace {
using Json = nlohmann::json;
using import_detail::Bytes;

std::string encode64(std::span<const std::uint8_t> bytes) {
    const char* alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string text;
    for (std::size_t i = 0; i < bytes.size(); i += 3) {
        const auto left = bytes.size() - i;
        const auto v =
            (unsigned(bytes[i]) << 16) | (left > 1 ? unsigned(bytes[i + 1]) << 8 : 0) | (left > 2 ? bytes[i + 2] : 0);
        text += alphabet[(v >> 18) & 63];
        text += alphabet[(v >> 12) & 63];
        text += left > 1 ? alphabet[(v >> 6) & 63] : '=';
        text += left > 2 ? alphabet[v & 63] : '=';
    }
    return text;
}

std::vector<std::uint8_t> decode64(const std::string& text) {
    if (text.size() > 1024 * 1024 || text.size() % 4)
        throw std::runtime_error("Invalid music event table encoding");
    std::vector<std::uint8_t> bytes;
    unsigned value = 0, bits = 0;
    bool padding = false;
    for (const auto c : text) {
        if (c == '=') {
            padding = true;
            continue;
        }
        if (padding)
            throw std::runtime_error("Invalid music event table padding");
        unsigned n;
        if (c >= 'A' && c <= 'Z')
            n = unsigned(c - 'A');
        else if (c >= 'a' && c <= 'z')
            n = unsigned(c - 'a') + 26;
        else if (c >= '0' && c <= '9')
            n = unsigned(c - '0') + 52;
        else if (c == '+')
            n = 62;
        else if (c == '/')
            n = 63;
        else
            throw std::runtime_error("Invalid music event table character");
        value = (value << 6) | n;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes.push_back(std::uint8_t(value >> bits));
        }
    }
    return bytes;
}

void validate(const MusicGraph& g) {
    if (!g.tracks || g.tracks > 4 || !g.sections || g.sections > 128 || g.events > 128 || g.nodes.empty() ||
        g.nodes.size() > 8192 || g.samples.size() > 8192 || g.routers.size() > 256 ||
        g.event_table.size() != g.tracks * g.sections * g.events)
        throw std::runtime_error("Invalid music graph counts");
    for (const auto& n : g.nodes) {
        if (n.track >= g.tracks || n.sample < -1 || n.sample > int(g.samples.size()) || n.links.size() > 255 ||
            ((n.word2 >> 16) & 255) > g.variables.size())
            throw std::runtime_error("Invalid music node");
        for (const auto& l : n.links)
            if (l.target < 0 || std::size_t(l.target) >= g.nodes.size() || l.min > l.max)
                throw std::runtime_error("Invalid music link");
    }
    for (const auto index : g.event_table)
        if (index >= g.routers.size())
            throw std::runtime_error("Invalid music router index");
    for (const auto& pairs : g.variables)
        for (const auto& pair : pairs)
            if (pair[0] < 0 || pair[1] < 0 || std::size_t(pair[0]) >= g.nodes.size() ||
                std::size_t(pair[1]) >= g.nodes.size())
                throw std::runtime_error("Invalid music variable remap");
}
} // namespace

MusicGraph MusicGraph::decode(std::span<const std::uint8_t> source) {
    // [Trailmap: 270-header, 270-node, 270-link, 270-tail] Every pointer is
    // in four-byte units. Variable lists are bounded by the next list or track.
    Bytes b{source};
    b.range(0, 36);
    if (b.text(0, 4) != "xDFP" || b.le(4, 1) != 3 || b.le(5, 1) != 1)
        throw std::runtime_error("Unsupported music graph signature/version");
    MusicGraph g;
    g.tracks = b.le(13, 1);
    g.sections = b.le(14, 1);
    g.events = b.le(15, 1);
    const auto routers = b.le(16, 1), variables = b.le(17, 1), count = b.le(18, 2);
    if (!count || count > 8192 || source.size() > 4 * 1024 * 1024)
        throw std::runtime_error("Music graph exceeds its limits");
    b.range(36, count * 2);
    std::size_t tail = 36 + count * 2;
    for (unsigned i = 0; i < count; ++i) {
        const auto p = std::size_t(b.le(36 + i * 2, 2)) * 4;
        b.range(p, 12);
        if (p < 36 + count * 2)
            throw std::runtime_error("Music node overlaps its header");
        MusicNode n;
        n.sample = b.signed16(p);
        n.track = b.le(p + 2, 1);
        n.flags = b.le(p + 3, 1);
        n.word1 = b.le(p + 4);
        n.word2 = b.le(p + 8);
        const auto links = b.le(p + 11, 1);
        b.range(p + 12, links * 4);
        for (unsigned j = 0; j < links; ++j) {
            const auto q = p + 12 + j * 4;
            n.links.push_back(
                {static_cast<std::int8_t>(b.le(q, 1)), static_cast<std::int8_t>(b.le(q + 1, 1)), b.signed16(q + 2)});
        }
        tail = std::max(tail, p + 12 + links * 4);
        g.nodes.push_back(std::move(n));
    }
    const auto bytes = std::size_t(g.tracks) * g.sections * g.events;
    b.range(tail, bytes);
    g.event_table = {source.begin() + tail, source.begin() + tail + bytes};
    tail = (tail + bytes + 3) & ~std::size_t(3);
    b.range(tail, routers * 4 + variables * 4 + 4);
    for (unsigned i = 0; i < routers; ++i) {
        g.routers.push_back(b.le(tail));
        tail += 4;
    }
    for (unsigned i = 0; i < variables; ++i) {
        g.variable_offsets.push_back(b.le(tail));
        tail += 4;
    }
    const auto track = std::size_t(b.le(tail)) * 4;
    tail += 4;
    for (unsigned i = 0; i < variables; ++i) {
        const auto begin = std::size_t(g.variable_offsets[i]) * 4,
                   end = i + 1 < variables ? std::size_t(g.variable_offsets[i + 1]) * 4 : track;
        if (begin < tail || end < begin || end > track || (end - begin) / 4 > 4096)
            throw std::runtime_error("Invalid music variable list extent");
        b.range(begin, end - begin);
        std::vector<std::array<int, 2>> pairs;
        for (auto p = begin; p < end; p += 4) {
            const auto word = b.le(p);
            pairs.push_back({int(word >> 16), int(word & 65535)});
        }
        g.variables.push_back(std::move(pairs));
    }
    b.range(track, g.tracks * 4);
    const auto samples = track + g.tracks * 4;
    if (samples > source.size() || (source.size() - samples) % 8)
        throw std::runtime_error("Invalid music sample table extent");
    for (auto p = samples; p < source.size(); p += 8) {
        const auto index = g.samples.size();
        auto number = std::to_string(index);
        while (number.size() < 3)
            number.insert(number.begin(), '0');
        g.samples.push_back({"chunk_" + number + ".wav", std::size_t(b.le(p)) * 4, b.le(p + 4)});
    }
    validate(g);
    return g;
}

MusicGraph MusicGraph::load(const std::filesystem::path& path) {
    if (std::filesystem::file_size(path) > 8 * 1024 * 1024)
        throw std::runtime_error("Music JSON exceeds its limit");
    std::ifstream file(path);
    const auto doc = Json::parse(file);
    MusicGraph g;
    g.tracks = doc.at("Tracks");
    g.sections = doc.at("Sections");
    g.events = doc.at("Events");
    g.routers = doc.at("Routers").get<std::vector<std::uint32_t>>();
    g.event_table = decode64(doc.at("EventTable"));
    if (doc.contains("Vars"))
        g.variable_offsets = doc.at("Vars").get<std::vector<std::uint32_t>>();
    if (doc.contains("VariableMaps"))
        g.variables = doc.at("VariableMaps").get<std::vector<std::vector<std::array<int, 2>>>>();
    else if (!g.variable_offsets.empty())
        throw std::runtime_error("Music graph lacks variable remaps; re-import its graph");
    for (const auto& row : doc.at("Nodes")) {
        MusicNode n;
        n.sample = row.at("Sample");
        n.track = row.value("Track", 0u);
        n.flags = row.at("Flags");
        n.word1 = row.at("Word1");
        n.word2 = row.at("Word2");
        for (const auto& raw : row.at("LinkRaw")) {
            const auto word = raw.get<std::uint32_t>();
            n.links.push_back({static_cast<std::int8_t>(word & 255), static_cast<std::int8_t>((word >> 8) & 255),
                               static_cast<std::int16_t>(word >> 16)});
        }
        g.nodes.push_back(std::move(n));
    }
    for (const auto& row : doc.at("Samples"))
        g.samples.push_back({row.at("Wav"), row.value("MusOffset", std::size_t(0)), row.value("Meta", 0u)});
    validate(g);
    return g;
}

void MusicGraph::save(const std::filesystem::path& path, const std::string& name, double bpm, double volume) const {
    validate(*this);
    Json ns = Json::array(), ss = Json::array();
    for (std::size_t i = 0; i < nodes.size(); ++i) {
        const auto& n = nodes[i];
        Json raw = Json::array(), links = Json::array();
        for (const auto& l : n.links) {
            raw.push_back(std::uint32_t(std::uint8_t(l.min)) | (std::uint32_t(std::uint8_t(l.max)) << 8) |
                          (std::uint32_t(std::uint16_t(l.target)) << 16));
            links.push_back(l.target);
        }
        ns.push_back({{"Index", i},
                      {"Sample", n.sample},
                      {"Track", n.track},
                      {"Flags", n.flags},
                      {"Word1", n.word1},
                      {"Word2", n.word2},
                      {"Links", links},
                      {"LinkRaw", raw}});
    }
    for (std::size_t i = 0; i < samples.size(); ++i)
        ss.push_back({{"Index", i},
                      {"Wav", samples[i].wav},
                      {"MusOffset", samples[i].offset},
                      {"Meta", samples[i].milliseconds}});
    std::ofstream file(path);
    file << Json({{"Schema", "openslope-music-graph/v1"},
                  {"Song", name},
                  {"Bpm", bpm},
                  {"Volume", volume},
                  {"Tracks", tracks},
                  {"Sections", sections},
                  {"Events", events},
                  {"EventTable", encode64(event_table)},
                  {"Routers", routers},
                  {"Vars", variable_offsets},
                  {"VariableMaps", variables},
                  {"Nodes", ns},
                  {"Samples", ss}})
                .dump()
         << '\n';
    if (!file)
        throw std::runtime_error("Cannot write music graph");
}

int music_advance(const MusicGraph& g, MusicCursor& c, unsigned level, std::optional<unsigned> event) {
    if (c.ended)
        return -1;
    if (level > 127 || c.track >= g.tracks || c.node < 0 || std::size_t(c.node) >= g.nodes.size())
        throw std::runtime_error("Invalid music cursor");
    bool jump = false;
    if (event && *event < g.events) {
        const auto queue_router = g.routers.at(g.event_table.at((c.track * g.events + *event) * g.sections));
        if (!((queue_router >> 8) & 128)) {
            const auto section = g.nodes[std::size_t(c.node)].flags & 127;
            if (section < g.sections) {
                const auto router =
                    g.routers.at(g.event_table.at((c.track * g.events + *event) * g.sections + section));
                const auto action = static_cast<std::int8_t>(router & 255);
                const auto flags = (router >> 8) & 255;
                const auto target = static_cast<std::int16_t>(router >> 16);
                if (action >= 0)
                    c.action_volume = action / 127.;
                if (flags & 64) {
                    c.ended = true;
                    return -1;
                }
                if (flags & 3) {
                    if (target < 0 || std::size_t(target) >= g.nodes.size() ||
                        g.nodes[std::size_t(target)].track != c.track)
                        throw std::runtime_error("Music event target is invalid");
                    c.node = target;
                    jump = true;
                }
            }
        }
    }
    const auto next = [&] {
        const auto& n = g.nodes[std::size_t(c.node)];
        int target = -1;
        const auto value = n.sample == -1 ? c.loop_count : int(level);
        for (const auto& l : n.links)
            if (value >= l.min && value <= l.max) {
                target = l.target;
                break;
            }
        if (target < 0) {
            c.ended = true;
            return;
        }
        const auto variable = (n.word2 >> 16) & 255;
        if (variable)
            for (const auto& pair : g.variables.at(variable - 1))
                if (pair[0] == target)
                    target = pair[1];
        if (n.sample == -1 && c.loop_count > 0)
            --c.loop_count;
        c.node = target;
    };
    if (!jump && g.nodes[std::size_t(c.node)].sample > 0)
        next();
    for (unsigned steps = 0; !c.ended && steps < 8192; ++steps) {
        const auto& n = g.nodes[std::size_t(c.node)];
        if (n.track != c.track)
            throw std::runtime_error("Music walk crosses tracks");
        if (n.sample > 0)
            return n.sample - 1;
        if (n.sample == -1 && c.loop_node != c.node) {
            c.loop_node = c.node;
            c.loop_count = int((n.word2 >> 8) & 255);
        }
        next();
    }
    if (!c.ended)
        throw std::runtime_error("Music control-node cycle has no samples");
    return -1;
}
} // namespace openslope
