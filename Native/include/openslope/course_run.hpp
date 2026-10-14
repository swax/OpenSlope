#pragma once
#include "paths.hpp"
#include <string>
#include <string_view>

namespace openslope {
enum class RunMode {Freeride,Race,Showoff};
enum class RunPhase {Ready,Countdown,Running,Finished,Expired};
RunMode run_mode(std::string_view name);
const char* run_name(RunMode mode);
const char* run_name(RunPhase phase);
std::string run_clock(double seconds);
struct RunSettings {
    RunMode mode=RunMode::Freeride;
    unsigned laps=1;
    double showoff_seconds=120,countdown_seconds=3;
    static RunSettings load(const std::filesystem::path& root,RunMode mode);
};
struct CourseProgress {std::size_t route{};double station{},distance_to_finish{},distance{},fraction{};Vec3 point{},forward{0,0,-1};};
struct RunStatus {
    RunMode mode=RunMode::Freeride;RunPhase phase=RunPhase::Running;
    double clock{},countdown{},elapsed{},checkpoint_notice{},checkpoint_bonus{};
    unsigned checkpoints{},lap=1,remaining{},passes=1;
    std::optional<CourseProgress> progress;
};
// Course events and clocks are independent of the rider's recovered motion/control states.
class CourseRun {
public:
    CourseRun()=default;
    CourseRun(CoursePaths paths,CoursePaths finish_paths,RunSettings settings);
    static CourseRun load(const std::filesystem::path& root,RunMode mode);
    void restart();
    bool begin_tick(double seconds,bool mounted);
    void end_tick(Vec3 position,std::uint64_t placement_serial);
    const RunStatus& status() const {return status_;}
    const CoursePaths& paths() const {return paths_;}
    std::optional<CourseProgress> locate(Vec3 position) const;
    std::optional<std::pair<Vec3,Vec3>> finish() const {return finish_;}
private:
    struct Route {Bounds bounds;std::vector<double> arc;};
    CoursePaths paths_;std::vector<Route> routes_;RunSettings settings_;RunStatus status_;
    std::optional<std::pair<Vec3,Vec3>> finish_;
    bool lap_events_=false;
    double total_=0;
    std::optional<double> previous_dtf_;
    std::optional<Vec3> previous_position_;
    std::uint64_t serial_=0;
};
}
