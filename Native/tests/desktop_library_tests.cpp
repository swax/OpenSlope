#include "openslope/course_names.hpp"
#include "openslope/desktop_library.hpp"
#include "openslope/ride_ui.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <thread>

namespace {
using namespace openslope;

void check(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(message);
}

void no_staging(const DesktopLibrary& library) {
    for (const auto& entry : std::filesystem::directory_iterator(library.maps_root()))
        check(!entry.path().filename().string().starts_with(".openslope-import-"), "Import staging was not cleaned up");
}
} // namespace

int main(int argc, char** argv) {
    try {
        if (argc != 3)
            throw std::runtime_error("Expected scenario and application folder");
        const std::string scenario = argv[1];
        const DesktopLibrary library(argv[2]);
        const auto images = library.images();
        const bool ssx = scenario == "ssx";
        const std::string course = ssx ? "SSX_FIXTURE" : "FIXTURE";
        check(images.size() == 2 && images[0].filename() == (ssx ? "First.BIN" : "First.ISO") &&
                  images[1].filename() == "second.iso",
              "Sources must be sorted, nonrecursive, case-insensitive ISO/BIN files beside the application");
        check(library.maps_root() == std::filesystem::absolute(argv[2]) / "Maps",
              "Maps root must follow executable folder, not working directory");
        if (scenario == "import" || ssx) {
            const auto courses = library.courses(images[0]);
            check(courses.size() == 1 && courses[0].name == course,
                  "Real format discovery must supply the selectable course");
            const auto map = library.install(images[0], courses[0].name);
            check(map == library.maps_root() / course && Terrain::load(map).patches().size() == 1,
                  "Published import must load as a standard map");
            check(library.maps().size() == 1, "Completed import must appear in the installed library");
            std::ofstream(map / "keep-local.txt") << "local edits";
            check(library.install(library.folder() / "missing.iso", course) == map,
                  "Installed maps must be reused without opening a disc");
            check(std::filesystem::exists(map / "keep-local.txt"), "Reusing an import must preserve local files");
            no_staging(library);
        } else if (scenario == "cancel") {
            bool cancel = false, failed = false;
            try {
                library.install(
                    images[0], "FIXTURE", [&](const auto& stage) { cancel |= stage.starts_with("Texture "); },
                    [&] { return cancel; });
            } catch (const std::exception&) {
                failed = true;
            }
            check(cancel && failed, "Cancellation must interrupt an actual partially extracted course");
            check(!std::filesystem::exists(library.maps_root() / "FIXTURE"), "Cancelled course must not be published");
            check(std::filesystem::exists(library.maps_root() / "CUSTOM" / "Patches.json"),
                  "Cancellation must preserve other courses");
            check(library.maps().size() == 1, "Only the pre-existing custom map should be listed");
            no_staging(library);
        } else if (scenario == "invalid") {
            bool failed = false;
            try {
                library.courses(images[0]);
            } catch (const std::exception&) {
                failed = true;
            }
            check(failed, "Unsupported or corrupt discs must not be accepted from their filename");
            try {
                library.install(images[0], "FIXTURE");
                failed = false;
            } catch (const std::exception&) {
            }
            check(failed && !std::filesystem::exists(library.maps_root() / "FIXTURE"),
                  "Failed extraction must not publish a partial course");
            no_staging(library);
        } else if (scenario == "existing") {
            bool failed = false;
            try {
                library.install(images[0], "FIXTURE");
            } catch (const std::exception&) {
                failed = true;
            }
            check(failed && std::filesystem::exists(library.maps_root() / "FIXTURE" / "keep-local.txt"),
                  "An existing incomplete or custom directory must never be replaced");
        } else if (scenario == "queue") {
            CourseImportQueue queue(library);
            check(queue.enqueue(images[0], "FIXTURE") && queue.enqueue(images[1], "SECOND"),
                  "Different ISO sources must be queueable without waiting");
            check(!queue.enqueue(images[0], "FIXTURE"), "Repeated clicks must not duplicate an import");
            queue.enqueue(library.folder() / "broken.img", "THIRD");
            queue.enqueue(images[0], "FOURTH");
            queue.cancel("FOURTH");
            const auto drain = [&] {
                const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
                while (queue.busy() && std::chrono::steady_clock::now() < deadline) {
                    queue.update();
                    unsigned active = 0;
                    for (const auto& [name, state] : queue.status())
                        active += state.phase == CourseImportPhase::Extracting;
                    check(active <= 1, "Only one course may extract at once");
                    std::this_thread::sleep_for(std::chrono::milliseconds(1));
                }
                check(!queue.busy(), "Queued extractions must finish without blocking the UI thread");
            };
            drain();
            check(queue.status().at("FIXTURE").phase == CourseImportPhase::Ready &&
                      queue.status().at("SECOND").phase == CourseImportPhase::Ready,
                  "Queued courses must finish ready for an explicit Play click");
            check(queue.status().at("THIRD").phase == CourseImportPhase::Failed &&
                      queue.status().at("FOURTH").phase == CourseImportPhase::Cancelled,
                  "Failed or cancelled jobs must not prevent other jobs from finishing");
            check(!std::filesystem::exists(library.maps_root() / "FOURTH"),
                  "Cancelling a queued course must not create files");
            check(queue.enqueue(images[0], "THIRD"), "A failed extraction must be retryable");
            drain();
            check(library.maps().size() == 3 && queue.status().at("THIRD").phase == CourseImportPhase::Ready,
                  "Retried extraction must publish a complete map");
            no_staging(library);
        } else
            throw std::runtime_error("Unknown library scenario");
        RideUi ui;
        ui.library = ui.iso_library = true;
        ui.iso_paths = images;
        auto buttons = ui.buttons();
        check(buttons[0].map == images[0] && buttons[0].action == UiAction::SelectSource,
              "ISO button must carry the complete source path");
        ui.iso_source = images[0];
        ui.iso_courses = {{"FIXTURE", false}, {"CUSTOM", true}};
        buttons = ui.buttons();
        check(buttons[0].action == UiAction::ImportMap && buttons[0].value == "FIXTURE" && buttons[0].map == images[0],
              "Course selection must preserve its source and exact course name");
        check(buttons[1].text == "PLAY CUSTOM" && buttons[1].action == UiAction::LoadMap,
              "Installed maps must use a separate explicit Play action");
        RideUi named;
        named.library = true;
        named.map_paths = {library.maps_root() / "AVALANCHE_CRS01_00"};
        check(named.buttons()[0].text == "Tenderfoot Pass" && named.buttons()[0].map == named.map_paths[0],
              "Existing Avalanche maps must show retail names while retaining the original folder");
        named.immersive = true;
        check(named.buttons()[0].text == "Tenderfoot Pass", "The wrist library must use the same course names");
        named.iso_library = true;
        named.iso_source = images[0];
        named.import_root = library.maps_root();
        named.iso_courses = {{"AVALANCHE_CRS01_00", false}, {"AVALANCHE_CRS06_03", true}};
        auto named_buttons = named.buttons();
        check(named_buttons[0].text == "EXTRACT Tenderfoot Pass" && named_buttons[0].value == "AVALANCHE_CRS01_00" &&
                  named_buttons[0].map == images[0],
              "Friendly source labels must preserve the ID and source used for extraction");
        check(named_buttons[1].text == "PLAY Wit's Thicket" &&
                  named_buttons[1].map == library.maps_root() / "AVALANCHE_CRS06_03",
              "Play must keep the canonical imported map path");
        named.import_rows["AVALANCHE_CRS01_00"] = {CourseImportPhase::Queued, "Waiting"};
        named_buttons = named.buttons();
        check(named_buttons[0].text == "QUEUED Tenderfoot Pass" && named_buttons[1].action == UiAction::CancelImport &&
                  named_buttons[1].value == "AVALANCHE_CRS01_00",
              "Named import progress must still cancel the original queued ID");
        check(course_display_name("My custom course") == "My custom course" &&
                  course_display_name("AVALANCHE_CRS00_01") == "AVALANCHE_CRS00_01",
              "Custom map names and unknown layouts must remain unchanged");
        ui.import_rows["FIXTURE"] = {CourseImportPhase::Extracting, "Decoding textures"};
        buttons = ui.buttons();
        check(buttons[0].text == "EXTRACTING FIXTURE" && buttons[0].detail == "Decoding textures" &&
                  buttons[0].action == UiAction::None,
              "Extraction progress belongs in its course row without hiding the library");
        check(buttons[1].action == UiAction::CancelImport && buttons[1].value == "FIXTURE",
              "Each active row must have its own cancel control");
        ui.iso_courses.clear();
        for (unsigned i = 0; i < 11; ++i)
            ui.iso_courses.emplace_back("COURSE" + std::to_string(i), false);
        ui.visible = true;
        check(ui.scroll_library(-.4) && ui.scroll_library(-.6) && ui.library_scroll == 1,
              "Fractional wheel input must accumulate into list scrolling");
        check(ui.buttons()[0].value == "COURSE1", "Scrolling must reveal the next course without a page transition");
        ui.scroll_library(-100);
        check(ui.library_scroll == 6 && ui.buttons()[4].value == "COURSE10",
              "Scrolling must clamp to the final full list window");
        ui.scroll_library(100);
        check(ui.library_scroll == 0, "Scrolling upward must clamp at the start");
        const auto scrolled_buttons = ui.buttons();
        check(std::none_of(scrolled_buttons.begin(), scrolled_buttons.end(),
                           [](const auto& b) { return b.action == UiAction::Next || b.action == UiAction::Previous; }),
              "Desktop lists must not show paging buttons");
        ui.frame({{0, 0, 0}, {1, 0, 0}, {0, -1, 0}, true});
        ui.pointer({{.965, -.72, 1}, {0, 0, -1}, true}, true);
        check(ui.library_scroll == 6, "Scrollbar track clicks must reach the end of the list");
        ui.pointer({{.965, -.30, 1}, {0, 0, -1}, true}, true);
        check(ui.library_scroll == 0, "Dragging the scrollbar must return to the top");
        ui.pointer({{.965, -.30, 1}, {0, 0, -1}, true}, false);
        ui.loading = ui.importing = true;
        check(ui.buttons().size() == 1 && ui.buttons()[0].action == UiAction::CancelImport,
              "Import progress must offer cancellation without other actions");
        ui.importing = false;
        check(ui.buttons().empty(), "The ordinary map loading screen must keep its input guard");
        std::cout << "PASS: desktop library " << scenario << '\n';
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "Desktop library: " << e.what() << '\n';
        return 1;
    }
}
