#pragma once
#include "import.hpp"
#include <map>
#include <memory>

namespace openslope {
// Local desktop sources are files beside the executable. Installed maps keep
// the shared Maps/<course> contract and never depend on an ISO for playback.
class DesktopLibrary {
public:
    explicit DesktopLibrary(std::filesystem::path executable_folder);

    const std::filesystem::path& folder() const { return folder_; }

    std::filesystem::path maps_root() const { return folder_ / "Maps"; }

    std::vector<std::filesystem::path> images() const;
    std::vector<std::filesystem::path> maps() const;
    std::vector<DiscCourse> courses(const std::filesystem::path& image, const ImportCancel& cancelled = {}) const;
    std::filesystem::path install(const std::filesystem::path& image, const std::string& course,
                                  const ImportProgress& progress = {}, const ImportCancel& cancelled = {}) const;

private:
    std::filesystem::path folder_;
};

enum class CourseImportPhase { Queued, Extracting, Ready, Failed, Cancelled };

struct CourseImportStatus {
    CourseImportPhase phase = CourseImportPhase::Queued;
    std::string progress;
};

// One extraction at a time; browsing and queuing stay on the UI thread.
class CourseImportQueue {
public:
    explicit CourseImportQueue(DesktopLibrary library);
    ~CourseImportQueue();
    bool enqueue(std::filesystem::path image, std::string course);
    void cancel(const std::string& course);
    bool update(); // True when an installed map becomes available.
    bool busy() const;
    const std::map<std::string, CourseImportStatus>& status() const;

private:
    struct Work;
    std::unique_ptr<Work> work_;
};
} // namespace openslope
