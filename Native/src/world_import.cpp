#include "openslope/world_import.hpp"
#include "executable_internal.hpp"
#include "import_internal.hpp"
#include "openslope/ride.hpp"
#include "surface_spray.hpp"
#include "world_layout.hpp"
#include <algorithm>
#include <array>
#include <bit>
#include <cctype>
#include <nlohmann/json.hpp>
#include <optional>

namespace openslope {
namespace {
using Json = nlohmann::json;
using executable_detail::Executable;
using executable_detail::Range;
using import_detail::Bytes;

struct Reject {};

constexpr std::uint32_t record_base = 0x40000000, stack_base = 0x7ffef000;
constexpr std::size_t record_limit = 8192, stack_size = 8192;
constexpr unsigned step_limit = 32768;

const Json& layout() {
    static const auto value = Json::parse(std::begin(bundled::world_layout), std::end(bundled::world_layout));
    return value;
}

struct Value {
    std::uint64_t bits = 0;
    std::uint8_t known = 0;

    static Value constant(std::uint64_t n) { return {n, 255}; }

    std::optional<std::uint64_t> number(unsigned width = 8) const {
        const auto mask = (1u << width) - 1;
        if ((known & mask) != mask)
            return {};
        return width == 8 ? bits : bits & ((std::uint64_t(1) << (width * 8)) - 1);
    }

    void byte(unsigned at, std::optional<std::uint8_t> value) {
        bits &= ~(std::uint64_t(255) << (at * 8));
        known &= std::uint8_t(~(1u << at));
        if (value) {
            bits |= std::uint64_t(*value) << (at * 8);
            known |= std::uint8_t(1u << at);
        }
    }

    std::optional<std::uint8_t> byte(unsigned at) const {
        if (!(known & (1u << at)))
            return {};
        return std::uint8_t(bits >> (at * 8));
    }
};

std::uint64_t word(std::uint64_t n) {
    return std::uint64_t(std::int64_t(std::bit_cast<std::int32_t>(std::uint32_t(n))));
}

std::int64_t signed_value(std::uint64_t n) { return std::bit_cast<std::int64_t>(n); }

struct Initializer {
    const Executable& executable;
    std::array<Value, 32> regs{}, fp{};
    std::vector<std::optional<std::uint8_t>> records;
    std::array<std::optional<std::uint8_t>, stack_size> stack{};

    Initializer(const Executable& image, std::size_t size) : executable(image), records(size) {
        regs[0] = Value::constant(0);
        regs[4] = Value::constant(record_base);
        regs[29] = Value::constant(stack_base + 4096);
        if (image.gp)
            regs[28] = Value::constant(*image.gp);
    }

    std::optional<std::uint8_t> read(std::uint32_t address) const {
        if (address >= record_base && std::uint64_t(address) - record_base < records.size())
            return records[address - record_base];
        if (address >= stack_base && std::uint64_t(address) - stack_base < stack.size())
            return stack[address - stack_base];
        return executable.read(address);
    }

    void write(std::uint32_t address, std::optional<std::uint8_t> value) {
        if (address >= record_base && std::uint64_t(address) - record_base < records.size())
            records[address - record_base] = value;
        else if (address >= stack_base && std::uint64_t(address) - stack_base < stack.size())
            stack[address - stack_base] = value;
        else
            throw Reject{};
    }

    Value load(std::uint32_t address, unsigned size) const {
        Value v;
        for (unsigned i = 0; i < size; ++i) {
            if (std::uint64_t(address) + i > UINT32_MAX)
                throw Reject{};
            v.byte(i, read(address + i));
        }
        return v;
    }

    std::optional<std::vector<std::uint8_t>> run(Range block, const ImportCancel& cancelled, unsigned& total_steps) {
        std::optional<std::size_t> pending;
        bool returning = false;
        bool delay = false;
        auto pc = block.begin;
        try {
            for (unsigned step = 0; step < step_limit; ++step) {
                if (++total_steps > 2000000)
                    throw std::runtime_error("World initializer analysis exceeds its work limit");
                if ((step & 63) == 0)
                    import_detail::check_cancel(cancelled);
                if (pc < block.begin || pc >= block.end || pc % 4)
                    throw Reject{};
                const auto w = executable.bytes.le(pc), op = w >> 26, rs = (w >> 21) & 31, rt = (w >> 16) & 31,
                           rd = (w >> 11) & 31, fn = w & 63, sh = (w >> 6) & 31;
                const auto imm = std::uint16_t(w);
                const auto si = std::int64_t(std::bit_cast<std::int16_t>(imm));
                const auto a = regs[rs].number(), b = regs[rt].number();
                const auto address =
                    a ? std::optional<std::uint32_t>(std::uint32_t(*a + std::uint64_t(si))) : std::nullopt;
                const bool control = op == 4 || op == 5 || op == 6 || op == 7 || (op == 0 && fn == 8);
                if (delay && control)
                    throw Reject{};
                if (op == 15 && rs != 0)
                    throw Reject{};
                if (op == 0 && ((fn == 0 || fn == 2 || fn == 3) ? rs != 0 : sh != 0))
                    throw Reject{};
                if (op == 17 && (rs == 0 || rs == 4) && (w & 2047))
                    throw Reject{};
                if ((op == 6 || op == 7) && rt != 0)
                    throw Reject{};
                std::optional<std::size_t> branch;
                bool finish = false;
                const auto unary = [&](const auto& operation) { return a ? Value::constant(operation(*a)) : Value{}; };
                const auto binary = [&](const auto& operation) {
                    return a && b ? Value::constant(operation(*a, *b)) : Value{};
                };
                switch (op) {
                case 15: regs[rt] = Value::constant(word(std::uint32_t(imm) << 16)); break;
                case 9: regs[rt] = unary([&](auto v) { return word(v + std::uint64_t(si)); }); break;
                case 25: regs[rt] = unary([&](auto v) { return v + std::uint64_t(si); }); break;
                case 12: regs[rt] = unary([&](auto v) { return v & imm; }); break;
                case 13: regs[rt] = unary([&](auto v) { return v | imm; }); break;
                case 14: regs[rt] = unary([&](auto v) { return v ^ imm; }); break;
                case 10: regs[rt] = unary([&](auto v) { return std::uint64_t(signed_value(v) < si); }); break;
                case 11: regs[rt] = unary([&](auto v) { return std::uint64_t(v < std::uint64_t(si)); }); break;
                case 0:
                    switch (fn) {
                    case 0: regs[rd] = b ? Value::constant(word(*b << sh)) : Value{}; break;
                    case 2: regs[rd] = b ? Value::constant(word(std::uint32_t(*b) >> sh)) : Value{}; break;
                    case 3:
                        regs[rd] = b ? Value::constant(
                                           word(std::uint64_t(std::bit_cast<std::int32_t>(std::uint32_t(*b)) >> sh)))
                                     : Value{};
                        break;
                    case 33: regs[rd] = binary([](auto x, auto y) { return word(x + y); }); break;
                    case 35: regs[rd] = binary([](auto x, auto y) { return word(x - y); }); break;
                    case 45: regs[rd] = binary([](auto x, auto y) { return x + y; }); break;
                    case 47: regs[rd] = binary([](auto x, auto y) { return x - y; }); break;
                    case 36: regs[rd] = binary([](auto x, auto y) { return x & y; }); break;
                    case 37: regs[rd] = binary([](auto x, auto y) { return x | y; }); break;
                    case 42:
                        regs[rd] =
                            binary([](auto x, auto y) { return std::uint64_t(signed_value(x) < signed_value(y)); });
                        break;
                    case 43: regs[rd] = binary([](auto x, auto y) { return std::uint64_t(x < y); }); break;
                    case 24:
                    case 25:
                        regs[rd] = binary(
                            [](auto x, auto y) { return word(std::uint64_t(std::uint32_t(x)) * std::uint32_t(y)); });
                        break;
                    case 8:
                        if (rs != 31 || rt != 0 || rd != 0)
                            throw Reject{};
                        finish = true;
                        break;
                    default: throw Reject{};
                    }
                    break;
                case 17:
                    if (rs == 4) {
                        fp[rd] = regs[rt];
                        fp[rd].known &= 15;
                    } else if (rs == 0) {
                        const auto v = fp[rd].number(4);
                        regs[rt] = v ? Value::constant(word(*v)) : Value{};
                    } else if (rs == 16 && fn == 6)
                        fp[(w >> 6) & 31] = fp[rd];
                    else
                        throw Reject{};
                    break;
                case 35:
                case 39:
                case 55:
                case 49: {
                    const auto width = op == 55 ? 8u : 4u;
                    if (address && *address % width)
                        throw Reject{};
                    auto v = address ? load(*address, width) : Value{};
                    if (op == 35) {
                        const auto n = v.number(4);
                        v = n ? Value::constant(word(*n)) : Value{};
                    } else if (op == 39) {
                        const auto n = v.number(4);
                        v = n ? Value::constant(*n) : Value{};
                    }
                    if (op == 49)
                        fp[rt] = v;
                    else
                        regs[rt] = v;
                    break;
                }
                case 43:
                case 63:
                case 57: {
                    if (!address)
                        throw Reject{};
                    const auto width = op == 63 ? 8u : 4u;
                    const auto v = op == 57 ? fp[rt] : regs[rt];
                    if (*address % width)
                        throw Reject{};
                    for (unsigned i = 0; i < width; ++i)
                        write(*address + i, v.byte(i));
                    break;
                }
                case 26:
                case 27:
                case 44:
                case 45:
                case 34:
                case 38:
                case 42:
                case 46: {
                    if (!address)
                        throw Reject{};
                    const auto width = (op == 26 || op == 27 || op == 44 || op == 45) ? 8u : 4u;
                    const auto offset = *address % width, aligned = *address - offset;
                    const bool left = op == 26 || op == 44 || op == 34 || op == 42,
                               loading = op == 26 || op == 27 || op == 34 || op == 38;
                    const auto count = left ? offset + 1 : width - offset, first = left ? width - count : 0,
                               memory = left ? aligned : *address;
                    for (unsigned i = 0; i < count; ++i)
                        if (loading)
                            regs[rt].byte(first + i, read(memory + i));
                        else
                            write(memory + i, regs[rt].byte(first + i));
                    if (loading && width == 4)
                        if (const auto n = regs[rt].number(4))
                            regs[rt] = Value::constant(word(*n));
                    break;
                }
                case 4:
                case 5:
                case 6:
                case 7: {
                    if (!a || ((op == 4 || op == 5) && !b))
                        throw Reject{};
                    const auto take = op == 4   ? *a == *b
                                      : op == 5 ? *a != *b
                                      : op == 6 ? signed_value(*a) <= 0
                                                : signed_value(*a) > 0;
                    if (take) {
                        const auto target = std::int64_t(pc) + 4 + si * 4;
                        if (target < std::int64_t(block.begin) || target >= std::int64_t(block.end))
                            throw Reject{};
                        branch = std::size_t(target);
                    }
                    break;
                }
                default: throw Reject{};
                }
                regs[0] = Value::constant(0);
                if (returning) {
                    if (finish || branch)
                        throw Reject{};
                    std::vector<std::uint8_t> result;
                    for (const auto v : records) {
                        if (!v)
                            throw Reject{};
                        result.push_back(*v);
                    }
                    return result;
                }
                if (pending && (finish || branch))
                    throw Reject{};
                const auto next = pending.value_or(pc + 4);
                pending = branch;
                returning = finish;
                delay = control;
                pc = next;
            }
        } catch (const Reject&) {
        }
        return {};
    }
};

std::optional<Json> profiles(const std::vector<std::uint8_t>& records) {
    const auto& spec = layout();
    const auto stride = spec.at("RecordBytes").get<std::size_t>();
    Bytes data{records};
    Json result = Json::object();
    try {
        for (std::size_t slot = 0; slot < spec.at("Slots").size(); ++slot) {
            const auto base = slot * stride;
            const auto& fields = spec.at("Fields");
            const auto integer = [&](const char* key) { return data.le(base + fields.at(key).get<std::size_t>()); };
            const auto rgb = [&](const char* key) {
                Json colour = Json::array();
                for (const auto& offset : fields.at(key)) {
                    const auto v = data.le(base + offset.get<std::size_t>());
                    if (v > 255)
                        throw Reject{};
                    colour.push_back(v);
                }
                return colour;
            };
            const auto scalar = [&](const char* key, double lo, double hi) {
                const auto f = data.number(base + fields.at(key).get<std::size_t>());
                if (f < lo || f > hi)
                    throw Reject{};
                return double(f);
            };
            if (integer("Enabled") > 1)
                throw Reject{};
            const auto name = spec.at("Slots")[slot].get<std::string>();
            result[name] = {{"Schema", "openslope-world/v1"},
                            {"Course", name},
                            {"SkyColor", rgb("SkyColor")},
                            {"Glare",
                             {{"Enabled", integer("Enabled") != 0},
                              {"CoreColour", rgb("CoreColour")},
                              {"FanIntensity", scalar("FanIntensity", 0, 10)},
                              {"RimColour", rgb("RimColour")},
                              {"SpriteIntensity", scalar("SpriteIntensity", 0, 10)},
                              {"AzimuthDegrees", scalar("AzimuthDegrees", -360000, 360000)},
                              {"ElevationDegrees", scalar("ElevationDegrees", -90, 90)},
                              {"DistanceUnits", scalar("DistanceUnits", 1, 1e8)},
                              {"SizeUnits", scalar("SizeUnits", 0, 1e8)}}}};
        }
    } catch (const Reject&) {
        return {};
    } catch (const std::runtime_error&) {
        return {};
    }
    return result;
}

template <class Decode>
std::optional<Json> recover(std::span<const std::uint8_t> source, const ImportCancel& cancelled, std::size_t size,
                            const Decode& decode) {
    Executable executable(source);
    if (!size || size > record_limit)
        throw std::runtime_error("Invalid world layout contract");
    std::optional<Json> result;
    unsigned total_steps = 0;
    for (const auto range : executable.text) {
        auto begin = range.begin;
        const auto inspect = [&](Range block) {
            if (block.end - block.begin > 256 * 1024)
                return;
            unsigned stores = 0, constants = 0;
            for (auto p = block.begin; p < block.end; p += 4) {
                const auto op = executable.bytes.le(p) >> 26;
                stores += op == 43 || op == 57;
                constants += op == 15;
            }
            if (stores < 16 || constants < 16)
                return;
            std::vector<std::size_t> starts{block.begin};
            for (auto p = block.begin; p < std::min(block.end, block.begin + 256); p += 4) {
                const auto w = executable.bytes.le(p);
                if ((w >> 26) == 9 && ((w >> 21) & 31) == 29 && ((w >> 16) & 31) == 29 && (w & 32768))
                    starts.push_back(p);
            }
            std::sort(starts.begin(), starts.end());
            starts.erase(std::unique(starts.begin(), starts.end()), starts.end());
            for (const auto start : starts) {
                Initializer state(executable, size);
                const auto bytes = state.run({start, block.end}, cancelled, total_steps);
                if (!bytes)
                    continue;
                const auto candidate = decode(*bytes);
                if (!candidate)
                    continue;
                if (result && *result != *candidate)
                    throw std::runtime_error("Ambiguous scalar settings in supplied executable");
                result = candidate;
            }
        };
        for (auto p = range.begin; p + 8 <= range.end; p += 4) {
            if ((p & 65535) == 0)
                import_detail::check_cancel(cancelled);
            const auto w = executable.bytes.le(p);
            if ((w >> 26) == 0 && (w & 63) == 8 && ((w >> 21) & 31) == 31 && ((w >> 6) & 32767) == 0) {
                inspect({begin, p + 8});
                begin = p + 8;
            }
        }
    }
    return result;
}

std::string upper(std::string value) {
    for (auto& c : value)
        c = char(std::toupper(static_cast<unsigned char>(c)));
    return value;
}
} // namespace

std::string executable_world_profile(std::span<const std::uint8_t> executable, const std::string& course,
                                     const ImportCancel& cancelled) {
    import_detail::check_cancel(cancelled);
    const auto name = upper(course);
    const auto& slots = layout().at("Slots");
    if (std::find(slots.begin(), slots.end(), Json(name)) == slots.end())
        return {};
    import_detail::check_cancel(cancelled);
    const auto result =
        recover(executable, cancelled, layout().at("RecordBytes").get<std::size_t>() * slots.size(), profiles);
    return result ? result->at(name).dump(2) : std::string{};
}

std::string disc_world_profile(const DiscInput& disc, const std::string& course, const ImportCancel& cancelled) {
    const auto boot = executable_detail::boot_executable(disc, cancelled);
    return boot ? executable_world_profile(boot->bytes, course, cancelled) : std::string{};
}

std::string executable_surface_spray_profile(std::span<const std::uint8_t> source, const ImportCancel& cancelled) {
    import_detail::check_cancel(cancelled);
    const auto spec = Json::parse(std::begin(bundled::surface_spray_layout), std::end(bundled::surface_spray_layout));
    const auto stride = spec.at("recordBytes").get<std::size_t>(), count = spec.at("records").get<std::size_t>();
    if (spec.at("schema") != "openslope-surface-spray-layout/v1" || count != 20 || stride < 84 ||
        stride > record_limit / count)
        throw std::runtime_error("Invalid surface spray layout");
    RideContract motion;
    const auto decode = [&](const std::vector<std::uint8_t>& bytes) -> std::optional<Json> {
        try {
            Bytes data{bytes};
            Json rows = Json::array();
            for (std::size_t i = 0; i < count; ++i) {
                const auto base = i * stride;
                const auto scalar = [&](const char* key) {
                    return double(data.number(base + spec.at("fields").at(key).get<unsigned>()));
                };
                // Clean 310's existing response facts identify the table rather
                // than an executable address or a revision-specific byte match.
                const auto& r = motion.surface(int(i));
                const auto value = [&](const char* key) {
                    return double(data.number(base + spec.at("motion").at(key).get<unsigned>()));
                };
                if (std::abs(value("stiffness") - r.A) > .01 || std::abs(value("damping") - r.P) > .01 ||
                    std::abs(value("bog") * .01 - r.bog) > .001 || std::abs(value("sink") * .01 - r.budget) > .001 ||
                    std::abs(value("target") / 3.6 - r.target) > .01)
                    return {};
                const auto rate = scalar("rate"), size = scalar("sizeUnits"), lo = scalar("fadeMin"),
                           hi = scalar("fadeMax"), alpha = scalar("alpha");
                const auto sprite = data.le(base + spec.at("fields").at("sprite").get<unsigned>());
                if (rate < 0 || rate > 10 || size < 0 || size > 100 || lo <= 0 || lo > hi || hi > 10 || alpha < 0 ||
                    alpha > 1 || sprite >= 38)
                    return {};
                rows.push_back({{"type", i},
                                {"rate", rate},
                                {"sizeUnits", size},
                                {"fadeMin", lo},
                                {"fadeMax", hi},
                                {"sprite", sprite},
                                {"alpha", alpha}});
            }
            return Json{{"schema", "openslope-surface-spray/v1"}, {"version", 1}, {"rows", rows}};
        } catch (const std::runtime_error&) {
            return {};
        }
    };
    const auto result = recover(source, cancelled, stride * count, decode);
    return result ? result->dump(2) : std::string{};
}

std::string disc_surface_spray_profile(const DiscInput& disc, const ImportCancel& cancelled) {
    const auto boot = executable_detail::boot_executable(disc, cancelled);
    return boot ? executable_surface_spray_profile(boot->bytes, cancelled) : std::string{};
}
} // namespace openslope
