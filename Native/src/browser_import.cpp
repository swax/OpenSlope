#include "openslope/import.hpp"
#include "openslope/audio_resolver.hpp"
#include <emscripten.h>
#include <nlohmann/json.hpp>
#include <filesystem>
#include <string>

// A worker owns the File. Read only requested extents; the multi-gigabyte ISO never enters Wasm memory.
EM_JS(double, browser_disc_size, (), { return Module.isoFile.size; });
EM_JS(int, browser_disc_read, (double offset, unsigned char* target, unsigned length), {
    try {
        const bytes = new Uint8Array(new FileReaderSync().readAsArrayBuffer(Module.isoFile.slice(offset, offset + length)));
        if (bytes.length !== length) return 0;
        HEAPU8.set(bytes, target);
        return 1;
    } catch (_) { return 0; }
});
EM_JS(void, browser_progress, (const char* message), { postMessage({type: 'progress', message: UTF8ToString(message)}); });

namespace {
std::string result;
openslope::DiscInput disc() {
    return {static_cast<std::uint64_t>(browser_disc_size()), [](std::uint64_t offset, std::span<std::uint8_t> bytes) {
        if (!browser_disc_read(static_cast<double>(offset), bytes.data(), bytes.size()))
            throw std::runtime_error("The ISO could not be read. Choose the file again.");
    }};
}
}

extern "C" {
EMSCRIPTEN_KEEPALIVE const char* browser_collision_sounds() {
    try {
        const auto collision = openslope::disc_collision_routes(disc());
        nlohmann::json events = nlohmann::json::object();
        if (collision) for (const auto& [event, route] : collision->events)
            events[std::to_string(event)] = {{"Group", route.group}, {"Slot", route.slot}};
        result = nlohmann::json{{"SourceExecutable", collision ? collision->executable : ""}, {"CollisionEvents", events}}.dump();
    } catch (const std::exception& error) { result = nlohmann::json{{"error", error.what()}}.dump(); }
    return result.c_str();
}
EMSCRIPTEN_KEEPALIVE const char* browser_courses() {
    try {
        nlohmann::json courses = nlohmann::json::array();
        for (const auto& course : openslope::disc_courses(disc())) courses.push_back(course.name);
        result = nlohmann::json{{"courses", courses}}.dump();
    } catch (const std::exception& error) { result = nlohmann::json{{"error", error.what()}}.dump(); }
    return result.c_str();
}
EMSCRIPTEN_KEEPALIVE const char* browser_extract(const char* course) {
    try {
        const std::filesystem::path output = "/course";
        std::filesystem::remove_all(output);
        openslope::extract_course(disc(), course, output, [](const std::string& text) { browser_progress(text.c_str()); });
        result = "{}";
    } catch (const std::exception& error) { result = nlohmann::json{{"error", error.what()}}.dump(); }
    return result.c_str();
}
}
