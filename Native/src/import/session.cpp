#include "game_importer.hpp"
#include "music_cache.hpp"
#include "strings.hpp"
#include <algorithm>
#include <atomic>
#include <list>
#include <mutex>

namespace openslope {
struct ImportSession::State {
    struct Read {
        std::uint64_t offset;
        std::vector<std::uint8_t> bytes;
    };

    std::mutex mutex;
    std::shared_ptr<import_detail::ImportContext> context = std::make_shared<import_detail::ImportContext>();
    DiscInput disc;
    std::list<Read> reads;
    std::size_t read_bytes{};
};

ImportSession::ImportSession(DiscInput source, std::filesystem::path cache, bool external)
    : state_(std::make_shared<State>()) {
    auto& state = *state_;
    state.context->music_root = std::move(cache);
    state.context->external = external;
    const auto logical = logical_disc(source);
    // Capturing a weak owner avoids a cycle through the stored reader.
    state.disc = {logical.size,
                  [logical, weak = std::weak_ptr(state_)](std::uint64_t offset, std::span<std::uint8_t> output) {
                      const auto locked = weak.lock();
                      if (!locked)
                          throw std::runtime_error("Import session was closed");
                      auto& value = *locked;
                      const auto found = std::find_if(value.reads.begin(), value.reads.end(), [&](const auto& row) {
                          return row.offset == offset && row.bytes.size() == output.size();
                      });
                      if (found != value.reads.end()) {
                          std::copy(found->bytes.begin(), found->bytes.end(), output.begin());
                          value.reads.splice(value.reads.begin(), value.reads, found);
                          ++value.context->stats.read_hits;
                          return;
                      }
                      logical.read_at(offset, output);
                      ++value.context->stats.source_reads;
                      if (output.size() <= 1024 * 1024) {
                          value.reads.push_front({offset, {output.begin(), output.end()}});
                          value.read_bytes += output.size();
                          while (value.read_bytes > 32 * 1024 * 1024 || value.reads.size() > 2048) {
                              value.read_bytes -= value.reads.back().bytes.size();
                              value.reads.pop_back();
                          }
                      }
                  },
                  state.context};
}

std::vector<DiscCourse> ImportSession::courses(const ImportCancel& cancel) {
    std::lock_guard lock(state_->mutex);
    return disc_courses(state_->disc, cancel);
}

void ImportSession::extract(const std::string& course, const std::filesystem::path& output,
                            const ImportProgress& progress, const ImportCancel& cancel) {
    std::lock_guard lock(state_->mutex);
    disc_courses(state_->disc, cancel);
    state_->context->music = nlohmann::json::array();
    state_->context->progress = progress;

    struct Cleanup {
        ImportProgress& progress;

        ~Cleanup() { progress = {}; }
    } cleanup{state_->context->progress};

    extract_course(state_->disc, course, output, progress, cancel);
    ++state_->context->stats.extractions;
}

std::string ImportSession::music_plan(const std::string& course, const ImportCancel& cancel) {
    std::lock_guard lock(state_->mutex);
    auto& context = *state_->context;
    disc_courses(state_->disc, cancel);
    context.music = nlohmann::json::array();
    if (!context.family->music || context.music_root.empty())
        return "[]";
    static std::atomic<unsigned> serial{0};
    const auto output = context.music_root / (".planning-" + std::to_string(serial++));
    std::filesystem::create_directories(context.music_root);
    if (!std::filesystem::create_directory(output))
        throw std::runtime_error("Cannot prepare music import");

    struct Cleanup {
        std::filesystem::path path;
        bool& planning;

        ~Cleanup() {
            planning = false;
            std::error_code ec;
            std::filesystem::remove_all(path, ec);
        }
    } cleanup{output, context.planning};

    context.planning = true;
    context.family->music(state_->disc, import_detail::upper(course), output, {}, cancel);
    for (auto& entry : context.music)
        entry["Destination"] =
            "/course/" + std::filesystem::relative(entry["Destination"].get<std::string>(), output).generic_string();
    return context.music.dump();
}

std::string ImportSession::music_entries() const {
    std::lock_guard lock(state_->mutex);
    return state_->context->music.dump();
}

ImportSessionStats ImportSession::stats() const {
    std::lock_guard lock(state_->mutex);
    return state_->context->stats;
}
} // namespace openslope
