#include "openslope/music.hpp"
#include "audio.hpp"
#include "import/strings.hpp"
#include "openslope/audio.hpp"
#include <algorithm>
#include <fstream>
#include <iomanip>
#include <nlohmann/json.hpp>
#include <set>
#include <sstream>

namespace openslope::import_detail {
namespace {
using Json = nlohmann::json;

void require(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(message);
}

void save(const std::filesystem::path& path, const Json& document) {
    std::ofstream file(path, std::ios::binary);
    file << document.dump() << '\n';
    require(bool(file), "Cannot write Mad Trix music metadata");
}

std::string name(Bytes b, unsigned at, unsigned length) {
    auto text = b.text(at, length);
    const auto end = text.find('\0');
    require(end != std::string::npos, "Unterminated Mad Trix music name");
    text.resize(end);
    return text;
}

struct Bank {
    Bytes bytes;
    std::vector<std::pair<unsigned, unsigned>> entries;

    explicit Bank(Bytes b) : bytes(b) {
        // [Trailmap: 550-music] MET TOC references are zero-based resource
        // indices, independent of PAK hashes and physical BIN sectors.
        require(b.text(0, 4) == "tTOC" && b.le(8) == 16 && b.le(12) > 0 && b.le(12) <= 4096 && b.le(12) % 16 == 0,
                "Invalid Mad Trix music TOC");
        b.range(16, b.le(12));
        for (unsigned p = 16; p < 16 + b.le(12); p += 16) {
            const auto at = b.le(p + 8), size = b.le(p + 12);
            require(b.text(p, 4) == "tXXX" && at >= 16 + b.le(12) && size > 0, "Invalid Mad Trix music resource");
            b.range(at, size);
            entries.emplace_back(at, size);
        }
        auto sorted = entries;
        std::sort(sorted.begin(), sorted.end());
        for (unsigned i = 1; i < sorted.size(); ++i)
            require(std::uint64_t(sorted[i - 1].first) + sorted[i - 1].second <= sorted[i].first,
                    "Overlapping Mad Trix music resources");
    }

    Bytes resource(unsigned i) const {
        require(i < entries.size(), "Invalid Mad Trix music resource reference");
        const auto [at, size] = entries[i];
        return {bytes.data.subspan(at, size)};
    }
};

unsigned reference(const std::string& value) {
    const std::string prefix = "MUSIC.MET[";
    require(value.starts_with(prefix) && value.back() == ']' && value.size() > prefix.size() + 1,
            "Invalid Mad Trix music reference");
    unsigned result = 0;
    for (auto i = prefix.size(); i + 1 < value.size(); ++i) {
        require(value[i] >= '0' && value[i] <= '9' && result <= 255, "Invalid Mad Trix music reference index");
        result = result * 10 + unsigned(value[i] - '0');
    }
    return result;
}

Json song(Bytes source, const std::string& voice, const std::filesystem::path& root, const ImportCancel& cancel) {
    source.range(0, 48);
    const auto size = source.be(12), rate = source.be(16);
    require(source.text(0, 4) == "VAGp" && size > 0 && size <= 16 * 1024 * 1024 && size % 16 == 0 &&
                source.data.size() == size + 48 && rate >= 8000 && rate <= 48000,
            "Invalid Mad Trix music VAG extent or rate");
    const auto id = name(source, 32, 16);
    require(valid_map_name(id), "Unsafe Mad Trix music track name");
    const auto folder = root / id;
    require(std::filesystem::create_directory(folder), "Duplicate Mad Trix music track");
    // Decode on ADPCM block boundaries, carrying predictor history across WAVs.
    // Four seconds keeps the existing players' first-two-chunk preload bounded.
    const auto blocks_per_chunk = rate * 4 / 28;
    Json samples = Json::array(), nodes = Json::array();
    nodes.push_back({{"Index", 0},
                     {"Sample", 0},
                     {"Track", 0},
                     {"Flags", 0},
                     {"Word1", 0},
                     {"Word2", 0},
                     {"Links", {1}},
                     {"LinkRaw", {std::uint32_t(1 << 16 | 127 << 8)}}});
    AdpcmState history;
    unsigned index = 0;
    std::size_t frames = 0;
    for (unsigned block = 0; block < size / 16; ++index) {
        check_cancel(cancel);
        const auto count = std::min(blocks_per_chunk, size / 16 - block);
        const auto data = source.data.subspan(48 + block * 16, count * 16);
        for (unsigned p = 0; p < data.size(); p += 16)
            require((data[p] >> 4) <= 4 && (data[p] & 15) <= 12 && data[p + 1] <= 7,
                    "Invalid Mad Trix music ADPCM frame");
        const auto pcm = decode_audio_frames(data, 5, count * 28, history);
        PcmClip clip;
        clip.rate = rate;
        clip.samples.reserve(pcm.size());
        for (const auto value : pcm)
            clip.samples.push_back(value / 32768.f);
        std::ostringstream filename;
        filename << "chunk_" << std::setfill('0') << std::setw(3) << index << ".wav";
        write_wave(folder / filename.str(), clip);
        const auto seconds = double(clip.frames()) / rate;
        samples.push_back({{"Index", index},
                           {"Wav", filename.str()},
                           {"MusOffset", 48 + block * 16},
                           {"Meta", std::lround(seconds * 1000)},
                           {"Samples", clip.frames()},
                           {"Rate", rate},
                           {"Channels", 1},
                           {"Seconds", seconds}});
        frames += clip.frames();
        block += count;
        const auto next = block == size / 16 ? 1 : index + 2;
        nodes.push_back({{"Index", index + 1},
                         {"Sample", index + 1},
                         {"Track", 0},
                         {"Flags", 0},
                         {"Word1", 0},
                         {"Word2", 0},
                         {"Links", {next}},
                         {"LinkRaw", {std::uint32_t(next << 16 | 127 << 8)}}});
    }
    save(folder / "graph.json", {{"Schema", "openslope-music-graph/v1"},
                                 {"Song", "Mad Trix " + id},
                                 {"Short", id},
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
    return {{"Song", id},
            {"SourceVoice", voice},
            {"Frames", frames},
            {"Rate", rate},
            {"Channels", 1},
            {"Chunks", samples.size()},
            {"Seconds", double(frames) / rate}};
}
} // namespace

unsigned write_madtrix_music(const DiscInput& disc, const std::filesystem::path& output, const ImportCancel& cancel) {
    check_cancel(cancel);
    Iso iso(disc);
    const auto entries = iso.children(iso.find(""));
    const auto directory =
        std::find_if(entries.begin(), entries.end(), [](const auto& e) { return upper(e.name) == "MUSIC"; });
    if (directory == entries.end())
        return 0;
    require(directory->directory, "Invalid Mad Trix music directory");
    const auto extent = iso.find("MUSIC/MUSIC.MET");
    require(!extent.directory && extent.size >= 32 && extent.size <= 64 * 1024 * 1024,
            "Mad Trix music bank exceeds its limit");
    check_cancel(cancel);
    const auto data = disc.read(extent.offset, std::size_t(extent.size));
    const Bank bank{Bytes{data}};
    const auto root = output / "Audio/Music";
    std::filesystem::create_directories(root);
    Json playlist = Json::array(), sources = Json::array();
    std::set<std::string> voices;
    for (unsigned i = 0; i < bank.entries.size(); ++i) {
        check_cancel(cancel);
        const auto descriptor = bank.resource(i);
        if (descriptor.data.size() < 40 || descriptor.text(36, 4) != "SVAG")
            continue;
        require(descriptor.data.size() == 156 && descriptor.text(0, 4) == "LOAD" && descriptor.text(28, 4) == "TYPE" &&
                    descriptor.le(32) == 4 && descriptor.text(40, 4) == "SVAG" && descriptor.le(44) == 108,
                "Invalid Mad Trix streaming voice");
        const auto voice = name(descriptor, 64, 12);
        require(valid_map_name(voice) && voices.insert(upper(voice)).second && voices.size() <= 64,
                "Invalid Mad Trix music voice table");
        const auto entry = song(bank.resource(reference(name(descriptor, 136, 16))), voice, root, cancel);
        playlist.push_back(entry.at("Song"));
        sources.push_back(entry);
    }
    require(!playlist.empty(), "Mad Trix music bank has no streaming songs");
    save(root / "playlist.json", playlist);
    save(root / "MusicImport.json",
         {{"Schema", "openslope-music-import/v1"},
          {"Game", "jonny-moseley-mad-trix"},
          {"SourceBank", "MUSIC/MUSIC.MET"},
          {"Songs", sources},
          {"Policy", "All source music voices; OpenSlope per-run selection and full-track looping"},
          {"OriginalMusicScheduling", "Deferred"}});
    return unsigned(playlist.size());
}
} // namespace openslope::import_detail
