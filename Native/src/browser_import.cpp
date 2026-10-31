#include "import/course_metadata.hpp"
#include "openslope/audio_resolver.hpp"
#include "openslope/import.hpp"
#include <emscripten.h>
#include <filesystem>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

// A worker owns the File. Read only requested extents; the multi-gigabyte ISO never enters Wasm memory.
// clang-format off
EM_JS(double, browser_disc_size, (), { return Module.isoFile.size; });
EM_JS(int, browser_disc_read, (double offset, unsigned char* target, unsigned length), {
    try {
        const bytes =
            new Uint8Array(new FileReaderSync().readAsArrayBuffer(Module.isoFile.slice(offset, offset + length)));
        if (bytes.length !== length)
            return 0;
        HEAPU8.set(bytes, target);
        return 1;
    } catch (_) {
        return 0;
    }
});
EM_JS(void, browser_progress, (const char* message),
      { postMessage({type : 'progress', message : UTF8ToString(message)}); });
// clang-format on

namespace {
std::string result;

openslope::DiscInput disc() {
    return {static_cast<std::uint64_t>(browser_disc_size()), [](std::uint64_t offset, std::span<std::uint8_t> bytes) {
                if (!browser_disc_read(static_cast<double>(offset), bytes.data(), bytes.size()))
                    throw std::runtime_error("The ISO could not be read. Choose the file again.");
            }};
}

std::unique_ptr<openslope::ImportSession> current_session;

openslope::ImportSession& session() {
    if (!current_session)
        current_session = std::make_unique<openslope::ImportSession>(disc(), "/music-cache", true);
    return *current_session;
}
} // namespace

extern "C" {
EMSCRIPTEN_KEEPALIVE const char* browser_collision_sounds() {
    try {
        const auto collision = openslope::disc_collision_routes(disc());
        nlohmann::json events = nlohmann::json::object();
        if (collision)
            for (const auto& [event, route] : collision->events)
                events[std::to_string(event)] = {{"Group", route.group}, {"Slot", route.slot}};
        result = nlohmann::json{
            {"SourceExecutable", collision ? collision->executable : ""},
            {"CollisionEvents",
             events}}.dump();
    } catch (const std::exception& error) {
        result = nlohmann::json{{"error", error.what()}}.dump();
    }
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* browser_courses() {
    try {
        nlohmann::json courses = nlohmann::json::array();
        nlohmann::json names = nlohmann::json::object(), layouts = nlohmann::json::object();
        for (const auto& course : session().courses()) {
            courses.push_back(course.name);
            if (!course.display_name.empty())
                names[course.name] = course.display_name;
            layouts[course.name] = openslope::import_detail::course_metadata(course);
        }
        result = nlohmann::json{{"courses", courses}, {"names", names}, {"layouts", layouts}}.dump();
    } catch (const std::exception& error) {
        result = nlohmann::json{{"error", error.what()}}.dump();
    }
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* browser_extract(const char* course) {
    try {
        const std::filesystem::path output = "/course";
        std::filesystem::remove_all(output);
        session().extract(course, output, [](const std::string& text) { browser_progress(text.c_str()); });
        result = "{}";
    } catch (const std::exception& error) {
        result = nlohmann::json{{"error", error.what()}}.dump();
    }
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* browser_music_plan(const char* course) {
    try {
        result = session().music_plan(course);
    } catch (const std::exception& error) {
        result = nlohmann::json{{"error", error.what()}}.dump();
    }
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* browser_music_entries() {
    result = session().music_entries();
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* browser_import_stats() {
    const auto stats = session().stats();
    result =
        nlohmann::json{
            {"scans", stats.scans},        {"extractions", stats.extractions}, {"sourceReads", stats.source_reads},
            {"readHits", stats.read_hits}, {"musicHits", stats.music_hits},    {"musicMisses", stats.music_misses}}
            .dump();
    return result.c_str();
}
}
