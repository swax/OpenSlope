#pragma once
#include "paths.hpp"
#include <deque>
#include <functional>

namespace openslope {
enum class RecoverySource {AIPath,RaceLine,Trail,Start};
struct RecoveryPose {Vec3 position,forward{0,0,-1};RecoverySource source=RecoverySource::Start;std::size_t path=0;double station=0;};
class CourseRecovery {
public:
    explicit CourseRecovery(CoursePaths paths={});
    void tick(double seconds);
    void observe(Vec3 position,Vec3 forward);
    bool blocked(Vec3 position) const;
    std::optional<RecoveryPose> choose(Vec3 position,RecoveryPose start,const std::function<bool(Vec3)>& safe);
private:
    struct Line {CoursePath path;Bounds bounds;std::vector<double> arc;};
    struct Projection {std::size_t path;double station,distance;Vec3 point;};
    std::vector<Line> lines_;std::size_t ai_count_=0;
    std::optional<std::size_t> tracked_;
    std::optional<Vec3> observed_;
    std::deque<RecoveryPose> trail_;
    std::deque<double> requests_;
    double elapsed_=0;
    Projection project(std::size_t path,Vec3 position) const;
    RecoveryPose pose(std::size_t path,double station) const;
    std::vector<Projection> nearest(Vec3 position,bool ai,bool respawn_only) const;
};
}
