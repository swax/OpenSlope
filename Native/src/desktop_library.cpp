#include "openslope/desktop_library.hpp"
#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <deque>
#include <future>
#include <list>
#include <mutex>
#include <optional>
#include <stdexcept>

namespace openslope {
namespace {
std::string lower(std::string value) {
    for (auto& c : value)
        c = char(std::tolower(static_cast<unsigned char>(c)));
    return value;
}

void check_cancel(const ImportCancel& cancelled) {
    if (cancelled && cancelled())
        throw std::runtime_error("Import cancelled");
}
} // namespace

struct DesktopLibrary::Sessions {
    struct Entry {
        std::filesystem::path path;
        std::uintmax_t size;
        std::filesystem::file_time_type modified;
        std::shared_ptr<ImportSession> session;
    };

    std::mutex mutex;
    std::list<Entry> entries;
};

DesktopLibrary::DesktopLibrary(std::filesystem::path folder)
    : sessions_(std::make_shared<Sessions>()), folder_(std::filesystem::absolute(folder)) {}

std::shared_ptr<ImportSession> DesktopLibrary::session(const std::filesystem::path& image) const {
    const auto path = std::filesystem::weakly_canonical(image);
    const auto size = std::filesystem::file_size(path);
    const auto modified = std::filesystem::last_write_time(path);
    std::lock_guard lock(sessions_->mutex);
    const auto found = std::find_if(sessions_->entries.begin(), sessions_->entries.end(), [&](const auto& entry) {
        return entry.path == path && entry.size == size && entry.modified == modified;
    });
    if (found != sessions_->entries.end()) {
        const auto result = found->session;
        sessions_->entries.splice(sessions_->entries.begin(), sessions_->entries, found);
        return result;
    }
    auto result = std::make_shared<ImportSession>(open_disc(path), folder_ / ".openslope-cache" / "music-v1");
    sessions_->entries.remove_if([&](const auto& entry) { return entry.path == path; });
    sessions_->entries.push_front({path, size, modified, result});
    while (sessions_->entries.size() > 2)
        sessions_->entries.pop_back();
    return result;
}

std::vector<std::filesystem::path> DesktopLibrary::images() const {
    std::vector<std::filesystem::path> result;
    for (const auto& entry : std::filesystem::directory_iterator(folder_)) {
        const auto extension = lower(entry.path().extension().string());
        if (entry.is_symlink() || !entry.is_regular_file() ||
            (extension != ".iso" && extension != ".bin" && extension != ".rvz" && extension != ".gcm" &&
             extension != ".gba"))
            continue;
        result.push_back(entry.path());
    }
    std::sort(result.begin(), result.end(), [](const auto& a, const auto& b) {
        const auto x = lower(a.filename().string()), y = lower(b.filename().string());
        return x == y ? a < b : x < y;
    });
    return result;
}

std::vector<std::filesystem::path> DesktopLibrary::maps() const {
    std::vector<std::filesystem::path> result;
    for (const auto& name : available_maps(maps_root()))
        result.push_back(maps_root() / name);
    return result;
}

std::vector<DiscCourse> DesktopLibrary::courses(const std::filesystem::path& image,
                                                const ImportCancel& cancelled) const {
    check_cancel(cancelled);
    return session(image)->courses(cancelled);
}

std::filesystem::path DesktopLibrary::install(const std::filesystem::path& image, const std::string& course,
                                              const ImportProgress& progress, const ImportCancel& cancelled) const {
    check_cancel(cancelled);
    if (!valid_map_name(course))
        throw std::runtime_error("Invalid course name");
    const auto root = maps_root(), destination = root / course;
    if (std::filesystem::is_symlink(root))
        throw std::runtime_error("Choose an application folder with a normal Maps directory");
    if (std::filesystem::exists(destination)) {
        if (std::filesystem::is_symlink(destination) || !std::filesystem::is_directory(destination) ||
            !std::filesystem::is_regular_file(destination / "Patches.json"))
            throw std::runtime_error("Course folder already exists; existing files were kept");
        return destination;
    }
    std::filesystem::create_directories(root);
    static std::atomic<unsigned> serial{0};
    const auto staging =
        root / (".openslope-import-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) +
                "-" + std::to_string(serial++));
    if (!std::filesystem::create_directory(staging))
        throw std::runtime_error("Cannot create import staging folder");

    struct Cleanup {
        std::filesystem::path path;

        ~Cleanup() {
            std::error_code error;
            std::filesystem::remove_all(path, error);
        }
    } cleanup{staging};

    session(image)->extract(course, staging / "course", progress, cancelled);
    check_cancel(cancelled);
    if (std::filesystem::exists(destination))
        throw std::runtime_error("Course folder appeared during import; existing files were kept");
    std::filesystem::rename(staging / "course", destination);
    return destination;
}

struct CourseImportQueue::Work {
    explicit Work(DesktopLibrary value) : library(std::move(value)) {}

    struct Request {
        std::filesystem::path image;
        std::string course;
    };

    struct Progress {
        std::atomic<bool> cancelled{false};
        std::mutex mutex;
        std::string stage = "Starting import";
    };

    DesktopLibrary library;
    std::deque<Request> queued;
    std::optional<Request> active;
    std::shared_ptr<Progress> progress;
    std::future<std::filesystem::path> result;
    std::map<std::string, CourseImportStatus> statuses;

    ~Work() {
        if (progress)
            progress->cancelled = true;
    }
};

CourseImportQueue::CourseImportQueue(DesktopLibrary library) : work_(std::make_unique<Work>(std::move(library))) {}

CourseImportQueue::~CourseImportQueue() = default;

const std::map<std::string, CourseImportStatus>& CourseImportQueue::status() const { return work_->statuses; }

bool CourseImportQueue::busy() const { return work_->active.has_value() || !work_->queued.empty(); }

bool CourseImportQueue::enqueue(std::filesystem::path image, std::string course) {
    if (!valid_map_name(course))
        throw std::runtime_error("Invalid course name");
    if (const auto found = work_->statuses.find(course);
        found != work_->statuses.end() &&
        (found->second.phase == CourseImportPhase::Queued || found->second.phase == CourseImportPhase::Extracting))
        return false;
    if (std::filesystem::is_regular_file(work_->library.maps_root() / course / "Patches.json")) {
        work_->statuses[course] = {CourseImportPhase::Ready, "Ready to play"};
        return false;
    }
    work_->queued.push_back({std::move(image), course});
    work_->statuses[course] = {CourseImportPhase::Queued, "Waiting for the current extraction"};
    return true;
}

void CourseImportQueue::cancel(const std::string& course) {
    if (work_->active && work_->active->course == course) {
        work_->progress->cancelled = true;
        work_->statuses[course].progress = "Cancelling";
    } else {
        const auto removed =
            std::erase_if(work_->queued, [&](const auto& request) { return request.course == course; });
        if (removed)
            work_->statuses[course] = {CourseImportPhase::Cancelled, "Cancelled"};
    }
}

bool CourseImportQueue::update() {
    bool published = false;
    if (work_->active) {
        auto& status = work_->statuses[work_->active->course];
        {
            std::lock_guard lock(work_->progress->mutex);
            status.progress = work_->progress->cancelled ? "Cancelling" : work_->progress->stage;
        }
        if (work_->result.wait_for(std::chrono::seconds(0)) != std::future_status::ready)
            return false;
        try {
            static_cast<void>(work_->result.get());
            status = {CourseImportPhase::Ready, "Ready to play"};
            published = true;
        } catch (const std::exception& e) {
            status = {work_->progress->cancelled ? CourseImportPhase::Cancelled : CourseImportPhase::Failed, e.what()};
        }
        work_->active.reset();
    }
    if (!work_->queued.empty()) {
        work_->active = work_->queued.front();
        work_->queued.pop_front();
        const auto request = *work_->active;
        work_->progress = std::make_shared<Work::Progress>();
        work_->statuses[request.course] = {CourseImportPhase::Extracting, "Starting import"};
        try {
            work_->result =
                std::async(std::launch::async, [library = work_->library, request, progress = work_->progress] {
                    return library.install(
                        request.image, request.course,
                        [progress](const auto& stage) {
                            std::lock_guard lock(progress->mutex);
                            progress->stage = stage;
                        },
                        [progress] { return progress->cancelled.load(); });
                });
        } catch (const std::exception& e) {
            work_->statuses[request.course] = {CourseImportPhase::Failed, e.what()};
            work_->active.reset();
        }
    }
    return published;
}
} // namespace openslope
