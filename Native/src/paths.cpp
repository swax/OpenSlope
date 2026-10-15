#include "openslope/paths.hpp"
#include "openslope/props.hpp"
#include <fstream>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace openslope {
namespace {
using Json = nlohmann::json;

Vec3 axes(Vec3 v) { return {v.x, v.z, -v.y}; }

Vec3 raw_vector(const Json& value) {
    if (!value.is_array() || value.size() != 3)
        throw std::runtime_error("Invalid path vector");
    Vec3 v{value[0], value[1], value[2]};
    if (!finite(v) || length(v) > 1e9)
        throw std::runtime_error("Path vector outside its limits");
    return v;
}

Json read(const std::filesystem::path& path) {
    if (std::filesystem::file_size(path) > 64 * 1024 * 1024)
        throw std::runtime_error("Path metadata exceeds 64 MiB");
    const auto parent = std::filesystem::weakly_canonical(path.parent_path()),
               resolved = std::filesystem::weakly_canonical(path), relative = resolved.lexically_relative(parent);
    if (relative.empty() || relative.is_absolute() || *relative.begin() == "..")
        throw std::runtime_error("Path metadata resolves outside its course");
    std::ifstream file(resolved);
    return Json::parse(file);
}

std::vector<CoursePath> paths(const Json& rows, bool race, std::size_t& total) {
    if (!rows.is_array() || rows.size() > 4000)
        throw std::runtime_error("Invalid course path count");
    std::vector<CoursePath> result;
    for (const auto& row : rows) {
        CoursePath path;
        auto point = axes(raw_vector(row.at("PathPos"))) / 100;
        path.points.push_back(point);
        const auto& steps = row.at("PathPoints");
        if (!steps.is_array() || steps.size() > 100000 || total + steps.size() > 1000000)
            throw std::runtime_error("Course path points exceed their limits");
        total += steps.size();
        // [Trailmap: 250-seed-vertex, 250-accumulation] JSON stores expanded
        // displacement steps, not absolute positions. Keep the seed as vertex 0.
        for (const auto& delta : steps) {
            point += axes(raw_vector(delta)) / 100;
            path.points.push_back(point);
        }
        path.rating = row.value("U3", 50u);
        path.respawnable = row.value("Respawnable", true);
        path.distance_to_finish = race ? row.at("DistanceToFinish").get<double>() / 100 : 0;
        if (path.rating > 100 || !std::isfinite(path.distance_to_finish) || path.distance_to_finish < 0)
            throw std::runtime_error("Invalid course path attributes");
        if (row.contains("PathEvents")) {
            const auto& events = row.at("PathEvents");
            if (!events.is_array() || events.size() > 100000 || total + events.size() > 1000000)
                throw std::runtime_error("Invalid path event count");
            total += events.size();
            for (const auto& e : events) {
                PathEvent event{e.at("EventType"), e.at("EventValue"), e.at("EventStart").get<double>() / 100,
                                e.at("EventEnd").get<double>() / 100};
                if (!std::isfinite(event.start) || !std::isfinite(event.end) || event.start < 0 || event.end < 0)
                    throw std::runtime_error("Invalid path event station");
                path.events.push_back(event);
            }
        }
        result.push_back(std::move(path));
    }
    return result;
}

Vec3 along(const std::vector<Vec3>& points, double distance) {
    for (std::size_t i = 1; i < points.size(); ++i) {
        const auto delta = points[i] - points[i - 1];
        const auto span = length(delta);
        if (span <= 1e-9)
            continue;
        if (distance <= span)
            return points[i - 1] + delta * (distance / span);
        distance -= span;
    }
    return points.back();
}
} // namespace

std::pair<Vec3, Vec3> CoursePath::pose(double distance, double baseline) const {
    if (points.empty() || !std::isfinite(distance) || distance < 0 || !std::isfinite(baseline) || baseline <= 0)
        throw std::runtime_error("Invalid path pose request");
    const auto position = along(points, distance), ahead = along(points, distance + baseline);
    auto direction = ahead - position;
    if (length(direction) < 1e-6 && points.size() > 1)
        direction = points.back() - points.front();
    return {position, normalized(direction, {0, 0, -1})};
}

CoursePaths CoursePaths::load(const std::filesystem::path& input) {
    CoursePaths result;
    if (input.empty())
        return result;
    auto path = input;
    if (std::filesystem::is_directory(input)) {
        path = input / "AIP.json";
        if (!std::filesystem::exists(path))
            path = input / "SOP.json";
        if (!std::filesystem::exists(path))
            return result;
    }
    const auto doc = read(path);
    std::size_t total = 0;
    result.ai = paths(doc.at("AIPaths"), false, total);
    result.race = paths(doc.at("RaceLines"), true, total);
    const auto& starts = doc.at("StartPosList");
    if (!starts.is_array() || starts.size() > 64)
        throw std::runtime_error("Invalid start row");
    for (const auto& start : starts) {
        const auto index = start.get<std::size_t>();
        if (index >= result.ai.size())
            throw std::runtime_error("Start row references a missing path");
        result.starts.push_back(index);
    }
    return result;
}

std::optional<std::pair<Vec3, Vec3>> CoursePaths::start_pose() const {
    if (starts.empty())
        return {};
    return ai[starts[starts.size() / 2]].pose();
}

std::optional<std::pair<Vec3, Vec3>> start_marker(const std::filesystem::path& root) {
    if (root.empty() || !std::filesystem::exists(root / "Instances.json"))
        return {};
    const auto doc = read(root / "Instances.json");
    const auto& rows = doc.at("Instances");
    if (!rows.is_array() || rows.size() > 100000)
        throw std::runtime_error("Invalid start placement table");
    for (const auto& row : rows) {
        if (row.value("InstanceName", std::string{}) == "Mdl_StageArea_Start_0") {
            // [Trailmap: 120-stagearea] The staging anchor is a fallback, not a
            // substitute for the authored start-row paths in chapter 250.
            auto matrix = identity_transform();
            if (row.contains("TransformMatrix"))
                matrix = row.at("TransformMatrix").get<Transform>();
            else
                matrix = placement(raw_vector(row.at("Location")), row.at("Rotation").get<std::array<double, 4>>(),
                                   raw_vector(row.at("Scale")));
            for (auto v : matrix)
                if (!std::isfinite(v))
                    throw std::runtime_error("Invalid start marker transform");
            const auto position = transform_point(matrix, {}),
                       direction = transform_point(matrix, {0, 1, 0}) - position;
            return std::pair{axes(position) / 100, normalized(axes(direction), {0, 0, -1})};
        }
    }
    return {};
}
} // namespace openslope
