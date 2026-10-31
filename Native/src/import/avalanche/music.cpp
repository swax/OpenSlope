#include "openslope/music.hpp"
#include "formats.hpp"
#include "import/containers/disc.hpp"
#include "import/music_cache.hpp"
#include "import/strings.hpp"
#include "openslope/audio.hpp"
#include <algorithm>
#include <array>
#include <fstream>
#include <iomanip>
#include <nlohmann/json.hpp>
#include <set>
#include <sstream>

namespace openslope::import_detail {
namespace {
using Json = nlohmann::json;
constexpr unsigned rate = 48000, blocks_per_chunk = rate * 4 / 28;

void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}

void save(const std::filesystem::path& path, const Json& value) {
    std::ofstream file(path, std::ios::binary);
    file << value.dump() << '\n';
    require(bool(file), "Cannot write Avalanche music metadata");
}

std::string fixed_name(Bytes b, unsigned at, unsigned length) {
    auto value = b.text(at, length);
    const auto end = value.find('\0');
    require(end != std::string::npos, "Unterminated Avalanche sound member");
    value.resize(end);
    require(valid_map_name(value), "Unsafe Avalanche sound member");
    return value;
}

Bytes catalogue(Bytes bank) {
    // [Trailmap: 606-bank] The sound package has fixed directory records;
    // member offsets and lengths are relative to the whole package.
    require(bank.text(0, 8) == std::string("SNDFILE\0", 8), "Invalid Avalanche sound package");
    const auto count = bank.be(8);
    require(count > 0 && count <= 4096, "Invalid Avalanche sound member count");
    bank.range(32, count * 64);
    const auto first = 32 + count * 64;
    std::set<std::string> names;
    std::vector<std::pair<unsigned, unsigned>> spans;
    Bytes result;
    for (unsigned i = 0; i < count; ++i) {
        const auto p = 32 + i * 64;
        const auto name = upper(fixed_name(bank, p, 32));
        const auto at = bank.be(p + 32), size = bank.be(p + 36);
        require(names.insert(name).second && at >= first && size > 0, "Invalid Avalanche sound member extent");
        bank.range(at, size);
        spans.emplace_back(at, size);
        if (name == "BGMLIST.DAT")
            result = {bank.data.subspan(at, size)};
    }
    std::sort(spans.begin(), spans.end());
    for (unsigned i = 1; i < spans.size(); ++i)
        require(std::uint64_t(spans[i - 1].first) + spans[i - 1].second <= spans[i].first,
                "Overlapping Avalanche sound members");
    require(!result.data.empty(), "Avalanche sound package has no music catalogue");
    return result;
}

std::string text(Bytes b, unsigned pointer, unsigned first) {
    const auto at = b.be(pointer);
    if (!at)
        return {};
    require(at >= first, "Avalanche music string overlaps its table");
    b.range(at, 1);
    auto end = at;
    while (end < b.data.size() && b.data[end] && end - at < 128) {
        require(b.data[end] >= 32 && b.data[end] <= 126, "Invalid Avalanche music text");
        ++end;
    }
    require(end < b.data.size() && !b.data[end], "Unterminated Avalanche music text");
    return b.text(at, end - at);
}

struct Decoder {
    std::array<std::array<std::int64_t, 2>, 2> history{};

    PcmClip decode(std::span<const std::uint8_t> bytes, const ImportCancel& cancel) {
        // [Trailmap: 606-dtk] Disc-stream ADPCM: 28 stereo frames per
        // 32-byte block. Histories retain six fractional bits across chunks.
        constexpr std::array<std::array<int, 2>, 4> filters{{{0, 0}, {60, 0}, {115, -52}, {98, -55}}};
        PcmClip clip;
        clip.rate = rate;
        clip.channels = 2;
        clip.samples.reserve(bytes.size() / 32 * 56);
        for (std::size_t at = 0; at < bytes.size(); at += 32) {
            if (at % 32768 == 0)
                check_cancel(cancel);
            const auto block = bytes.subspan(at, 32);
            require(block[0] == block[2] && block[1] == block[3], "Invalid Avalanche ADPCM duplicate header");
            for (unsigned channel = 0; channel < 2; ++channel)
                require((block[channel] >> 4) < 4 && (block[channel] & 15) <= 12,
                        "Invalid Avalanche ADPCM predictor or scale");
            for (unsigned frame = 0; frame < 28; ++frame)
                for (unsigned channel = 0; channel < 2; ++channel) {
                    const auto header = block[channel];
                    const auto filter = filters[header >> 4];
                    auto& h = history[channel];
                    const auto nibble = (block[frame + 4] >> (channel * 4)) & 15;
                    const int residual = nibble >= 8 ? int(nibble) - 16 : int(nibble);
                    const auto prediction = std::clamp((h[0] * filter[0] + h[1] * filter[1] + 32) >> 6,
                                                       std::int64_t(-2097152), std::int64_t(2097151));
                    const auto value = prediction + residual * (4096 >> (header & 15)) * 64;
                    h[1] = h[0];
                    h[0] = value;
                    clip.samples.push_back(float(std::clamp(value >> 6, std::int64_t(-32768), std::int64_t(32767))) /
                                           32768.f);
                }
        }
        return clip;
    }
};

Json song(const DiscInput& disc, const DiscEntry& entry, const std::string& id, const std::string& title,
          const std::string& artist, const std::filesystem::path& root, const ImportCancel& cancel) {
    require(!entry.directory && entry.bytes > 0 && entry.bytes <= 32 * 1024 * 1024 && entry.bytes % 32 == 0,
            "Avalanche music stream exceeds its extent limit");
    const auto data = gamecube_file(disc, "1080Data/sound/" + entry.name);
    const auto folder = root / id;
    const auto key =
        music_key("avalanche-music-v1", Json{{"Id", id}, {"Title", title}, {"Artist", artist}}.dump(), {data});
    cached_music(
        disc, key, folder,
        [&] {
            require(std::filesystem::create_directory(folder), "Duplicate Avalanche music stream");
            Decoder decoder;
            Json samples = Json::array(), nodes = Json::array();
            const auto node = [](unsigned index, unsigned sample, unsigned next) {
                return Json{{"Index", index},  {"Sample", sample},
                            {"Track", 0},      {"Flags", 0},
                            {"Word1", 0},      {"Word2", 0},
                            {"Links", {next}}, {"LinkRaw", {std::uint32_t(next << 16 | 127 << 8)}}};
            };
            nodes.push_back(node(0, 0, 1));
            for (std::size_t at = 0; at < data.size();) {
                check_cancel(cancel);
                const auto size = std::min(std::size_t(blocks_per_chunk) * 32, data.size() - at);
                const auto clip = decoder.decode(std::span(data).subspan(at, size), cancel);
                std::ostringstream filename;
                filename << "chunk_" << std::setfill('0') << std::setw(3) << samples.size() << ".wav";
                write_wave(folder / filename.str(), clip);
                const auto seconds = double(clip.frames()) / rate;
                samples.push_back({{"Index", samples.size()},
                                   {"Wav", filename.str()},
                                   {"MusOffset", at},
                                   {"Meta", std::lround(seconds * 1000)},
                                   {"Samples", clip.frames()},
                                   {"Rate", rate},
                                   {"Channels", 2},
                                   {"Seconds", seconds}});
                at += size;
                const auto index = unsigned(samples.size());
                nodes.push_back(node(index, index, at == data.size() ? 1 : index + 1));
            }
            save(folder / "graph.json", {{"Schema", "openslope-music-graph/v1"},
                                         {"Song", title + " - " + artist},
                                         {"Short", id},
                                         {"Artist", artist},
                                         {"Bpm", 0},
                                         {"Volume", 1},
                                         {"Tracks", 1},
                                         {"Sections", 1},
                                         {"Events", 0},
                                         {"EventTable", ""},
                                         {"Routers", Json::array()},
                                         {"Vars", Json::array()},
                                         {"Nodes", nodes},
                                         {"Samples", samples}});
            static_cast<void>(MusicGraph::load(folder / "graph.json"));
        },
        cancel);
    const auto frames = data.size() / 32 * 28;
    const auto chunks = (data.size() + blocks_per_chunk * 32 - 1) / (blocks_per_chunk * 32);
    return {{"Song", id},   {"Title", title}, {"Artist", artist}, {"SourceFile", entry.name},        {"Frames", frames},
            {"Rate", rate}, {"Channels", 2},  {"Chunks", chunks}, {"Seconds", double(frames) / rate}};
}
} // namespace

unsigned write_avalanche_music(const DiscInput& disc, const std::filesystem::path& output,
                               const ImportProgress& progress, const ImportCancel& cancel) {
    check_cancel(cancel);
    const auto header = disc.read(0, 6);
    require(Bytes{header}.text(0, 6) == "GTEE01", "Unsupported Avalanche music source");
    const auto files = gamecube_directory(disc, "1080Data/sound");
    const auto bank =
        std::find_if(files.begin(), files.end(), [](const auto& e) { return upper(e.name) == "SNDDATA.OBJ"; });
    if (bank == files.end())
        return 0;
    require(!bank->directory && bank->bytes >= 32 && bank->bytes <= 64 * 1024 * 1024,
            "Avalanche sound package exceeds its limit");
    const auto bytes = gamecube_file(disc, "1080Data/sound/" + bank->name);
    const auto list = catalogue(Bytes{bytes});
    const auto count = list.be(0);
    require(count > 0 && count <= 256, "Invalid Avalanche music catalogue count");
    list.range(12, count * 20);
    const auto first = 12 + count * 20;
    const auto root = output / "Audio/Music";
    std::filesystem::create_directories(root.parent_path());
    require(std::filesystem::create_directory(root), "Avalanche music destination already exists");

    struct Cleanup {
        std::filesystem::path path;
        bool complete = false;

        ~Cleanup() {
            if (!complete) {
                std::error_code ec;
                std::filesystem::remove_all(path, ec);
            }
        }
    } cleanup{root};

    std::set<std::string> ids;
    Json playlist = Json::array(), sources = Json::array();
    std::uint64_t decoded_bytes = 0;
    for (unsigned i = 0; i < count; ++i) {
        check_cancel(cancel);
        const auto p = 12 + i * 20;
        const auto title = text(list, p, first), artist = text(list, p + 4, first), id = text(list, p + 8, first);
        require(valid_map_name(id), "Unsafe Avalanche music stream name");
        // [Trailmap: 606-catalogue] Named artist/title rows identify the
        // soundtrack. Blank cue rows and the explicit off entry are excluded.
        if (title.empty() || artist.find_first_not_of(' ') == std::string::npos || upper(id) == "_INVALID" ||
            !ids.insert(upper(id)).second)
            continue;
        const auto entry = std::find_if(files.begin(), files.end(),
                                        [&](const auto& e) { return upper(e.name) == upper(id + ".adp"); });
        require(entry != files.end(), "Missing named Avalanche music stream");
        decoded_bytes += entry->bytes / 32 * 28 * 4;
        require(decoded_bytes <= 1280ull * 1024 * 1024, "Avalanche soundtrack exceeds its decoded limit");
        if (progress)
            progress("Preparing Avalanche music: " + title);
        sources.push_back(song(disc, *entry, id, title, artist, root, cancel));
        playlist.push_back(id);
    }
    require(!playlist.empty(), "Avalanche music catalogue has no named songs");
    save(root / "playlist.json", playlist);
    save(root / "MusicImport.json",
         {{"Schema", "openslope-music-import/v1"},
          {"Game", "1080-avalanche"},
          {"SourceBank", "1080Data/sound/snddata.obj"},
          {"Songs", sources},
          {"Policy",
           "Named soundtrack streams in catalogue order; duplicate streams decoded once; OpenSlope full-track looping"},
          {"OriginalMusicScheduling", "Deferred"},
          {"DecodedPcmBytes", decoded_bytes}});
    check_cancel(cancel);
    cleanup.complete = true;
    return unsigned(playlist.size());
}
} // namespace openslope::import_detail
