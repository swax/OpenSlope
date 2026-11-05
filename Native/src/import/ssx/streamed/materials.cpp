#include "import/ssx/formats.hpp"
#include <algorithm>
#include <array>
#include <nlohmann/json.hpp>
#include <optional>

namespace openslope::import_detail {
namespace {
constexpr std::uint32_t absent = 0xffffffffu;

// [Trailmap: 516-ssx3-bindings] File tables, not runtime object layouts.
struct SetupBundle {
    Bytes bytes;
    bool available = false;

    SetupBundle(Bytes source, bool preview) : bytes(source) {
        if (bytes.data.size() < 8 || bytes.le(0) != 4096 || bytes.le(4) != (preview ? 13824u : 14336u))
            return;
        bytes.range(0, 92);
        if (bytes.data.size() > 16 * 1024 * 1024)
            throw std::runtime_error("Streamed setup bundle exceeds its limit");
        for (const auto [count, table, width] :
             {std::array<unsigned, 3>{24, 28, 24}, {56, 60, 4}, {68, 72, 2}, {76, 80, 4}}) {
            if (bytes.le(count) > 65536)
                throw std::runtime_error("Too many streamed setup records");
            bytes.range(bytes.le(table), std::size_t(bytes.le(count)) * width);
        }
        const auto start = bytes.le(64), end = bytes.le(72);
        if (start > end || end > bytes.data.size())
            throw std::runtime_error("Invalid streamed definition data extent");
        available = true;
    }

    Bytes definition(unsigned instance) const {
        if (!available)
            return {};
        if (instance >= bytes.le(68))
            throw std::runtime_error("Invalid streamed setup instance");
        const auto definition = bytes.le(bytes.le(72) + instance * 2, 2);
        if (definition == 65535)
            return {};
        const auto count = bytes.le(76), table = bytes.le(80), start = bytes.le(64), end = bytes.le(72);
        if (definition >= count)
            throw std::runtime_error("Invalid streamed setup definition");
        const auto offset = bytes.le(table + definition * 4);
        const auto next = definition + 1 < count ? bytes.le(table + (definition + 1) * 4) : end - start;
        if (offset > next || next > end - start || next - offset < 28)
            throw std::runtime_error("Invalid streamed setup definition extent");
        return {bytes.data.subspan(start + offset, next - offset)};
    }

    std::uint32_t property(unsigned instance) const {
        const auto row = definition(instance);
        return row.data.empty() ? absent : row.le(8);
    }

    std::uint32_t persistent(unsigned property) const {
        if (!available)
            return absent;
        if (property >= bytes.le(24))
            throw std::runtime_error("Invalid streamed setup property");
        return bytes.le(bytes.le(28) + property * 24 + 4);
    }

    Bytes program(unsigned index) const {
        if (!available)
            return {};
        if (index >= bytes.le(56))
            throw std::runtime_error("Invalid streamed setup program");
        const auto at = bytes.le(bytes.le(60) + index * 4);
        bytes.range(at, 16);
        const auto extent = bytes.le(at + 8);
        bytes.range(at, extent);
        return {bytes.data.subspan(at, extent)};
    }
};
} // namespace

std::uint32_t ssx3_setup_property(Bytes bundle, unsigned instance, bool preview) {
    return SetupBundle(bundle, preview).property(instance);
}

std::uint32_t ssx3_setup_persistent(Bytes bundle, unsigned property, bool preview) {
    return SetupBundle(bundle, preview).persistent(property);
}

Bytes ssx3_setup_program(Bytes bundle, unsigned program, bool preview) {
    return SetupBundle(bundle, preview).program(program);
}

// [Trailmap: 552-part-admission] Only the measured triangle-proxy layout is
// admitted. Nonzero known states keep their existing response; unknown states
// and layouts remain deferred rather than acquiring inferred bit semantics.
nlohmann::json ssx3_collision_parts(Bytes bundle, unsigned instance, unsigned objects, bool preview) {
    using Json = nlohmann::json;
    const auto row = SetupBundle(bundle, preview).definition(instance);
    if (!objects || objects > 256 || row.data.size() != 16 + std::size_t(objects) * 12 || row.le(0) != 1 ||
        row.le(12) == absent)
        return nullptr;
    Json enabled = Json::array();
    for (unsigned i = 0; i < objects; ++i) {
        const auto state = row.le(24 + i * 12, 2);
        if (state > 3)
            return nullptr;
        enabled.push_back(state != 0);
    }
    return {{"Resource", row.le(12)}, {"Enabled", std::move(enabled)}};
}

// [Trailmap: 552-ontour-part-admission] On Tour stores bounded object response
// states on the placement. Its solid-response bit is independent of the other states.
nlohmann::json ontour_collision_parts(Bytes instance, unsigned objects) {
    using Json = nlohmann::json;
    const auto end = 160 + std::size_t(objects) * 12;
    if (!objects || objects > 256 || instance.data.size() < end || instance.le(148) != 1 ||
        instance.le(144) != ((end + 15) & ~std::size_t(15)) || instance.le(156) == absent)
        return nullptr;
    Json enabled = Json::array();
    for (unsigned i = 0; i < objects; ++i) {
        const auto state = instance.le(168 + i * 12, 2);
        if (state & ~7u)
            return nullptr;
        enabled.push_back((state & 1) != 0);
    }
    return {{"Resource", instance.le(156)}, {"Enabled", std::move(enabled)}};
}

// [Trailmap: 516-literal-setup] Translate a complete, unconditional material
// setup only. This is a bounded constant decoder, not a world-script VM.
nlohmann::json streamed_material_setup(Bytes b, bool tour, bool preview) {
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
    std::optional<unsigned> last_call;
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
            last_call = index;
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
        } else if (!preview && op == 0x2a && p == end && arguments.empty()) {
            return nodes.empty() ? Json(nullptr) : nodes;
        } else if (preview && word == 0x0000021e && p + 4 == end && b.le(p) == 0x0000021f && arguments.empty() &&
                   last_call == 2) {
            // [Trailmap: 516-preview-bytecode] Complete paired preview exit;
            // no branch, unknown command or pending argument can be bypassed.
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
