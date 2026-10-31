#pragma once
#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <span>
#include <string>
#include <vector>

namespace openslope {
namespace import_detail {
struct ImportContext;
}

// A bounded, seekable input. Android supplies pread on a granted document FD;
// desktop tools supply an ordinary file. No filesystem path is inferred from a URI.
struct DiscInput {
    std::uint64_t size{};
    std::function<void(std::uint64_t, std::span<std::uint8_t>)> read_at;
    std::shared_ptr<import_detail::ImportContext> context{};
    std::vector<std::uint8_t> read(std::uint64_t offset, std::size_t length) const;
};

struct DiscCourse {
    std::string name;
    std::uint64_t archive_bytes{};
    std::string display_name{}, name_source{};
    std::string map_type{"run"}, world_id{}, parent_map{};
    std::vector<std::string> source_sections{}, connects{};
};

using ImportProgress = std::function<void(const std::string&)>;
using ImportCancel = std::function<bool()>;

struct ImportSessionStats {
    std::uint64_t source_reads{}, read_hits{}, scans{}, extractions{}, music_hits{}, music_misses{};
};

// A serial, reusable disc reader. Converted music stays optional and maps remain self-contained.
class ImportSession {
public:
    explicit ImportSession(DiscInput source, std::filesystem::path music_cache = {}, bool external_cache = false);
    std::vector<DiscCourse> courses(const ImportCancel& cancelled = {});
    void extract(const std::string& course, const std::filesystem::path& output, const ImportProgress& progress = {},
                 const ImportCancel& cancelled = {});
    // The browser restores only the requested tracks before extraction, then persists new entries.
    std::string music_plan(const std::string& course, const ImportCancel& cancelled = {});
    std::string music_entries() const;
    ImportSessionStats stats() const;

private:
    struct State;
    std::shared_ptr<State> state_;
};

DiscInput open_disc(const std::filesystem::path& path);
// Unwraps a supported GameCube RVZ or presents ISO9660 logical sectors for a
// plain ISO / Mode 2 Form 1 BIN. All views seek bounded source extents.
DiscInput logical_disc(const DiscInput& input);

struct DiscEntry {
    std::string name;
    std::uint64_t bytes{};
    bool directory = false;
};

std::vector<DiscEntry> disc_directory(const DiscInput& disc, const std::string& path);
std::vector<std::uint8_t> disc_file(const DiscInput& disc, const std::string& path);
std::vector<DiscEntry> disc_archive_directory(const DiscInput& disc, const std::string& path);
std::vector<std::uint8_t> disc_archive_file(const DiscInput& disc, const std::string& path, const std::string& member);
std::vector<DiscCourse> disc_courses(const DiscInput& disc, const ImportCancel& cancelled = {});
// Writes a NEW directory only. A failed/cancelled import removes only that
// directory. The host publishes it to Maps after this returns successfully.
void extract_course(const DiscInput& disc, const std::string& course, const std::filesystem::path& output,
                    const ImportProgress& progress = {}, const ImportCancel& cancelled = {});
std::vector<std::uint8_t> decode_refpack(std::span<const std::uint8_t> input);
bool valid_map_name(const std::string& name);
std::vector<std::string> available_maps(const std::filesystem::path& root);
// Add the common riding banks to an existing streamed-title map's decoded Audio.
// Original banks and a backup of SoundIndex.json are preserved.
std::string adapt_riding_audio(const std::filesystem::path& map, const ImportCancel& cancelled = {});
std::string adapt_course_ambience(const std::filesystem::path& map, const ImportCancel& cancelled = {});
// Approximate helper/lighting repair; retires inferred reset boxes and keeps PlaytestBackup-v2.
std::string polish_streamed_map(const std::filesystem::path& map, const ImportCancel& cancelled = {});
} // namespace openslope
