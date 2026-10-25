#include "import/ssx/formats.hpp"
#include <algorithm>
#include <array>
#include <nlohmann/json.hpp>
#include <optional>

namespace openslope::import_detail {
// [Trailmap: 516-literal-setup] Translate a complete, unconditional material
// setup only. This is a bounded constant decoder, not a world-script VM.
nlohmann::json streamed_material_setup(Bytes b, bool tour) {
    using Json = nlohmann::json;
    if (b.data.size() < 16 || b.le(0) != 0x004e554c)
        return nullptr;
    const auto end = b.le(4), extent = b.le(8);
    if (end < 16 || end % 4 || extent < end || extent > b.data.size())
        throw std::runtime_error("Invalid streamed material program extent");
    if (end > 65536)
        return nullptr;
    std::array<std::optional<double>, 256> registers{};
    std::vector<std::pair<unsigned, double>> arguments;
    Json nodes = Json::array();
    bool reset = false;
    for (std::size_t p = 16; p < end;) {
        const auto word = b.le(p), op = word & 255, index = (word >> 8) & 255;
        p += 4;
        if (op == 0x16 || op == 0x17 || op == 0x25 || op == 0x26 || op == 0x27) {
            if (p + 4 > end)
                throw std::runtime_error("Truncated streamed material constant");
            const double value = op == 0x17 || op == 0x26 ? b.number(p) : double(std::bit_cast<std::int32_t>(b.le(p)));
            p += 4;
            if (op == 0x16 || op == 0x17)
                registers[index] = value;
            else
                arguments.emplace_back(index, value);
        } else if (op == 0x28 || op == 0x29) {
            arguments.emplace_back(index, (word >> 16) & 255);
        } else if (op == 0x23) {
            const auto source = (word >> 16) & 255;
            if (!registers[source])
                return nullptr;
            registers[index] = -*registers[source];
        } else if (op == 0x20) {
            const auto source = (word >> 16) & 255;
            if (!registers[source])
                return nullptr;
            arguments.emplace_back(index, *registers[source]);
        } else if (op == 0x21) {
            const auto command = (word >> 16) & 255, count = word >> 24;
            // A setup call must consume exactly its literal argument list.
            if (count != arguments.size())
                return nullptr;
            std::map<unsigned, double> fields;
            for (const auto& [key, value] : arguments)
                if (!std::isfinite(value) || std::abs(value) > 1e6 || !fields.emplace(key, value).second)
                    return nullptr;
            arguments.clear();
            registers[index].reset(); // Calls never produce a constant value.
            if (!reset && nodes.empty() && command == 0 && fields.empty()) {
                reset = true;
                continue;
            }
            // On Tour installs its model-animation base before the independent
            // UV modifier. The model channel remains deferred; no branch or
            // arbitrary call may be skipped to reach a material command.
            if (tour && !reset && nodes.empty() && command == 2 && fields == std::map<unsigned, double>{{5, 1}}) {
                reset = true;
                continue;
            }
            if (command != (tour ? 19u : 21u))
                return nullptr;
            const auto value = [&](unsigned key, double fallback) {
                const auto it = fields.find(key);
                return it == fields.end() ? fallback : it->second;
            };
            // Constant scrolling only. Initial offsets, oscillation, rotation,
            // alternate targets and UV transforms need their own playback laws.
            if (value(0, -1) != -1 || value(1, 5) != 5 || value(2, 0) != 0 || value(3, 0) != 0 || value(6, 1) < 0 ||
                value(7, 0) < 0 || value(8, 0) != 0 || value(9, 0) != 0 || value(10, 0) != 0 || value(11, 1) != 1 ||
                std::any_of(fields.begin(), fields.end(), [](const auto& field) { return field.first > 11; }))
                return nullptr;
            nodes.push_back({{"mainType", 0},
                             {"payload",
                              {{"type0",
                                {{"SubType", 10},
                                 {"UVScroll",
                                  {{"U0", 0},
                                   {"U1", value(4, .0166667)},
                                   {"U2", value(5, .0166667)},
                                   {"U3", value(6, 1)},
                                   {"U4", value(7, 0)},
                                   {"U5", 0}}}}}}}});
        } else if (op == 0x2a && p == end && arguments.empty()) {
            return nodes.empty() ? Json(nullptr) : nodes;
        } else {
            return nullptr;
        }
        if (arguments.size() > 16 || nodes.size() > 16)
            return nullptr;
    }
    return nullptr;
}
} // namespace openslope::import_detail
