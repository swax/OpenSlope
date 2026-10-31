#include "openslope/course_names.hpp"
#include "openslope/desktop_library.hpp"
#include "openslope/ride_ui.hpp"
#include <algorithm>
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
        const bool gba = scenario == "gba";
        const std::string course = gba ? "SSXGBA_GARIBALDI" : ssx ? "SSX_FIXTURE" : "TRICKY_FIXTURE";
        check(images.size() == 2 &&
                  images[0].filename() == (gba   ? "First.GBA"
                                           : ssx ? "First.BIN"
                                                 : "First.ISO") &&
                  images[1].filename() == "second.iso",
              "Sources must be sorted, nonrecursive, case-insensitive game images beside the application");
        check(library.maps_root() == std::filesystem::absolute(argv[2]) / "Maps",
              "Maps root must follow executable folder, not working directory");
        if (scenario == "import" || ssx || gba) {
            const auto courses = library.courses(images[0]);
            check(courses.size() == (gba ? 8u : 1u) && courses[0].name == course,
                  "Real format discovery must supply the selectable course");
            const auto chosen = library.folder().parent_path() / "chosen disc outside app.iso";
            std::filesystem::copy_file(images[0], chosen, std::filesystem::copy_options::overwrite_existing);
            const DesktopLibrary picked(library.folder() / "chosen destination");
            const auto patch_count = gba ? 3u : 1u;
            check(picked.courses(chosen).front().name == course &&
                      Terrain::load(picked.install(chosen, course)).patches().size() == patch_count,
                  "A chosen disc outside the executable folder must scan and import without copying the image");
            const auto map = library.install(images[0], courses[0].name);
            check(map == library.maps_root() / course && Terrain::load(map).patches().size() == patch_count,
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
        check(std::any_of(buttons.begin(), buttons.end(),
                          [](const auto& button) { return button.action == UiAction::ChooseIso; }),
              "The source picker must offer a native file chooser");
        ui.iso_source = images[0];
        ui.iso_courses = {{"FIXTURE", false}, {"CUSTOM", true}};
        buttons = ui.buttons();
        check(buttons[0].action == UiAction::ImportMap && buttons[0].value == "FIXTURE" && buttons[0].map == images[0],
              "Course selection must preserve its source and exact course name");
        check(buttons[1].text == "PLAY CUSTOM" && buttons[1].action == UiAction::LoadMap,
              "Installed maps must use a separate explicit Play action");
        RideUi runs;
        runs.visible = runs.library = runs.iso_library = true;
        runs.iso_source = images[0];
        runs.import_root = library.maps_root();
        std::vector<DiscCourse> catalogue;
        const auto add_course = [&](std::string id, std::string label, std::string type) {
            DiscCourse row{std::move(id), 0};
            row.display_name = std::move(label);
            row.map_type = std::move(type);
            catalogue.push_back(row);
        };
        for (unsigned i = 0; i < 17; ++i)
            add_course("SSX3_RUN_" + std::to_string(i), "Disc run " + std::to_string(i), "run");
        for (char c = 'A'; c <= 'E'; ++c)
            add_course(std::string("SSX3_") + c, "Station", "hub");
        for (unsigned i = 0; i < 21; ++i)
            add_course("SSX3_A_CONNECTOR" + std::to_string(i), "Connector", "connector");
        for (unsigned i = 1; i <= 3; ++i)
            add_course("SSX3_PEAK" + std::to_string(i), "Peak", "run-chain");
        runs.set_iso_courses(catalogue);
        check(runs.library_count() == 17 && runs.visible_iso_courses().size() == 17,
              "Source metadata must default to exactly the 17 named runs");
        auto run_buttons = runs.buttons();
        check(run_buttons[0].text == "EXTRACT Disc run 0" && run_buttons[0].value == "SSX3_RUN_0" &&
                  run_buttons[0].map == images[0],
              "The named row must retain its exact source and canonical ID");
        check(std::any_of(run_buttons.begin(), run_buttons.end(),
                          [](const auto& button) { return button.action == UiAction::IsoMapTypes; }),
              "Advanced map types must remain accessible");
        runs.scroll_library(-100);
        check(runs.library_scroll == 12, "Scrolling must count the filtered rows");
        runs.toggle_iso_map_types();
        check(runs.library_count() == 46 && runs.library_scroll == 0,
              "Advanced mode must restore all source sections and reset scrolling");
        runs.toggle_iso_map_types();
        runs.immersive = true;
        runs.page = 3;
        run_buttons = runs.buttons();
        check(std::count_if(run_buttons.begin(), run_buttons.end(),
                            [](const auto& button) { return button.action == UiAction::ImportMap; }) == 2,
              "The wrist picker must paginate only the visible runs");
        runs.set_iso_courses({{"SSX3_ARA1", 0}, {"SSX3_A", 0}, {"SSX3_A_ARA1", 0}, {"SSX3_PEAK1", 0}, {"GARI", 0}});
        runs.iso_course_types.clear();
        check(runs.library_count() == 2,
              "Older scans must hide SSX3 structural sections and keep other games selectable");
        runs.iso_course_names["GARI"] = "Disc Garibaldi";
        runs.iso_courses[0].second = true;
        check(runs.buttons()[0].text == "PLAY Disc Garibaldi",
              "Installed legacy folders must use the scanned name when metadata is absent");
        RideUi named;
        named.library = true;
        named.map_paths = {library.maps_root() / "AVALANCHE_CRS01_00"};
        named.select_game("1080-avalanche");
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
        std::filesystem::create_directories(named.map_paths[0]);
        std::ofstream(named.map_paths[0] / "Import.json") << R"({"DisplayName":"A title recovered from disc"})";
        named.iso_library = false;
        named.map_titles.clear();
        check(named.buttons()[0].text == "A title recovered from disc" && named.buttons()[0].map == named.map_paths[0],
              "Stored disc titles override legacy labels without changing map paths");
        named.iso_library = true;
        named.iso_course_names["AVALANCHE_CRS01_00"] = "Scanned course title";
        check(named.buttons()[0].text == "QUEUED Scanned course title" && named.buttons()[0].value.empty(),
              "Queued source choices use the scanned title while cancellation retains the source ID");
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
