#include "import/ssx/formats.hpp"
#include <fstream>
#include <nlohmann/json.hpp>

namespace openslope::import_detail {
namespace {
using Json = nlohmann::json;

Json vector(Bytes b, std::size_t p) { return Json::array({b.number(p), b.number(p + 4), b.number(p + 8)}); }

Json records(Bytes b, std::size_t& p, unsigned count, bool race, const ImportCancel& cancel) {
    if (count > 4000)
        throw std::runtime_error("Imported path count exceeds its limit");
    Json rows = Json::array();
    std::size_t total = 0;
    for (unsigned i = 0; i < count; ++i) {
        check_cancel(cancel);
        const unsigned header = race ? 60 : 72;
        b.range(p, header);
        if (b.le(p) != (race ? 1u : 2u))
            throw std::runtime_error("Unsupported course path record");
        const auto point_count = b.le(p + (race ? 16 : 28)), event_count = b.le(p + (race ? 20 : 32));
        if (point_count > 100000 || event_count > 100000 || total + point_count + event_count > 1000000)
            throw std::runtime_error("Imported path arrays exceed their limits");
        total += point_count + event_count;
        const auto position = p + (race ? 24 : 36);
        Json row = {{"Name", std::string(race ? "Race Line " : "AI Path ") + std::to_string(i)},
                    {"PathPos", vector(b, position)},
                    {"PathPoints", Json::array()},
                    {"PathEvents", Json::array()}};
        if (race) {
            const auto distance = b.number(p + 12);
            if (distance < 0)
                throw std::runtime_error("Invalid distance to finish");
            row["DistanceToFinish"] = distance;
        } else {
            const auto rating = b.le(p + 12), respawn = b.le(p + 24);
            if (rating > 100 || respawn > 1)
                throw std::runtime_error("Invalid AI path attributes");
            row["U3"] = rating;
            row["Respawnable"] = bool(respawn);
        }
        p += header;
        b.range(p, std::size_t(point_count) * 16);
        for (unsigned j = 0; j < point_count; ++j) {
            const auto w = b.number(p + 12);
            if (w < 0)
                throw std::runtime_error("Invalid path step length");
            row["PathPoints"].push_back(
                {double(b.number(p)) * w, double(b.number(p + 4)) * w, double(b.number(p + 8)) * w});
            p += 16;
        }
        b.range(p, std::size_t(event_count) * 16);
        // Some authored events have end < start. Preserve both stations; the
        // consuming event system, not the format reader, decides their meaning.
        for (unsigned j = 0; j < event_count; ++j) {
            const auto start = b.number(p + 8), end = b.number(p + 12);
            if (start < 0 || end < 0)
                throw std::runtime_error("Invalid path event station");
            row["PathEvents"].push_back({{"EventType", static_cast<std::int32_t>(b.le(p))},
                                         {"EventValue", b.le(p + 4)},
                                         {"EventStart", start},
                                         {"EventEnd", end}});
            p += 16;
        }
        rows.push_back(std::move(row));
    }
    return rows;
}
} // namespace

void write_paths(const std::vector<std::uint8_t>& bytes, const std::filesystem::path& output,
                 const ImportCancel& cancel) {
    // [Trailmap: 250-header, 250-section-a, 250-section-b, 250-patha,
    // 250-pathb, 250-accumulation, 250-events] Independent bounded path reader.
    Bytes all{bytes};
    all.range(0, 16);
    if (all.le(0) != 0x0a0a0a0a || all.le(4) != 2)
        throw std::runtime_error("Unsupported course path container");
    const auto first = std::size_t(16) + all.le(8), second = std::size_t(16) + all.le(12);
    if (first < 16 || second <= first || second > bytes.size())
        throw std::runtime_error("Invalid course path sections");
    Bytes a{all.data.subspan(first, second - first)};
    const auto count = a.le(0), slots = a.le(4);
    if (slots != 6)
        throw std::runtime_error("A disc course requires six start slots");
    a.range(8, slots * 4);
    Json starts = Json::array();
    for (unsigned i = 0; i < slots; ++i) {
        const auto id = a.le(8 + i * 4);
        if (id >= count)
            throw std::runtime_error("Invalid start slot index");
        starts.push_back(id);
    }
    std::size_t p = 8 + slots * 4;
    auto ai = records(a, p, count, false, cancel);
    if (p != a.data.size())
        throw std::runtime_error("AI path section length disagrees with its records");
    Bytes b{all.data.subspan(second)};
    b.range(0, 16);
    if (b.le(0) != 1 || std::size_t(b.le(4)) + 8 != b.data.size() || b.le(12) != 0)
        throw std::runtime_error("Invalid race path section header");
    p = 16;
    auto race = records(b, p, b.le(8), true, cancel);
    if (p != b.data.size())
        throw std::runtime_error("Race path section length disagrees with its records");
    const Json doc = {{"StartPosList", starts}, {"AIPaths", ai}, {"RaceLines", race}};
    const auto text = doc.dump();
    if (text.size() > 64 * 1024 * 1024)
        throw std::runtime_error("Imported path JSON exceeds 64 MiB");
    std::ofstream file(output, std::ios::binary);
    file << text << '\n';
    if (!file)
        throw std::runtime_error("Cannot write course paths");
}
} // namespace openslope::import_detail
