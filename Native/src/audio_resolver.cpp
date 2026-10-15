#include "openslope/audio_resolver.hpp"
#include "executable_internal.hpp"
#include <array>
#include <bit>
#include <set>

namespace openslope {
namespace {
using executable_detail::Executable;
using executable_detail::Range;
constexpr auto output_base = executable_detail::record_base;
constexpr auto stack_base = executable_detail::stack_base;
constexpr std::uint32_t return_marker = UINT32_MAX;

struct Reject {};

using Number = std::optional<std::uint64_t>;

std::uint64_t word(std::uint64_t n) {
    return std::uint64_t(std::int64_t(std::bit_cast<std::int32_t>(std::uint32_t(n))));
}

std::int64_t signed_number(std::uint64_t n) { return std::bit_cast<std::int64_t>(n); }

std::optional<std::size_t> file_offset(const Executable& image, std::uint32_t address) {
    for (const auto& segment : image.segments)
        if (address >= segment.address && std::uint64_t(address) - segment.address < segment.size)
            return std::size_t(segment.offset) + address - segment.address;
    return {};
}

std::optional<std::size_t> code_offset(const Executable& image, std::uint32_t address) {
    if (address % 4)
        return {};
    const auto offset = file_offset(image, address);
    if (offset && std::any_of(image.text.begin(), image.text.end(),
                              [&](auto range) { return *offset >= range.begin && *offset + 4 <= range.end; }))
        return offset;
    return {};
}

std::uint32_t code_address(const Executable& image, std::size_t offset) {
    for (const auto& segment : image.segments)
        if (offset >= segment.offset && offset - segment.offset < segment.size)
            return segment.address + std::uint32_t(offset - segment.offset);
    throw Reject{};
}

struct Result {
    bool table_used = false;
    std::optional<SoundRoute> route;
};

struct Probe {
    const Executable& image;
    std::array<Number, 32> regs{};
    std::array<std::optional<std::size_t>, 32> origins{};
    std::array<std::optional<std::uint8_t>, 8192> stack{};
    std::array<std::optional<std::uint8_t>, 8> output{};
    unsigned touched = 0;

    Probe(const Executable& source, unsigned event) : image(source) {
        regs[0] = 0;
        regs[5] = event;
        regs[6] = output_base;
        regs[7] = output_base + 4;
        regs[29] = stack_base + 4096;
        regs[31] = return_marker;
        if (image.gp)
            regs[28] = *image.gp;
    }

    Number read(std::uint32_t address, unsigned width) const {
        std::uint64_t n = 0;
        for (unsigned i = 0; i < width; ++i) {
            if (std::uint64_t(address) + i > UINT32_MAX)
                throw Reject{};
            const auto at = address + i;
            std::optional<std::uint8_t> byte;
            if (at >= output_base && std::uint64_t(at) - output_base < output.size())
                byte = output[at - output_base];
            else if (at >= stack_base && std::uint64_t(at) - stack_base < stack.size())
                byte = stack[at - stack_base];
            else
                byte = image.read(at);
            if (!byte)
                return {};
            n |= std::uint64_t(*byte) << (8 * i);
        }
        return n;
    }

    void write(std::uint32_t address, Number value, unsigned width) {
        const auto end = std::uint64_t(address) + width;
        const bool out = address >= output_base && end <= std::uint64_t(output_base) + output.size();
        const bool local = address >= stack_base && end <= std::uint64_t(stack_base) + stack.size();
        if (!out && !local)
            throw Reject{};
        for (unsigned i = 0; i < width; ++i) {
            const auto byte =
                value && i < 8 ? std::optional<std::uint8_t>(std::uint8_t(*value >> (8 * i))) : std::nullopt;
            if (out) {
                const auto at = address - output_base + i;
                output[at] = byte;
                touched |= 1u << at;
            } else
                stack[address - stack_base + i] = byte;
        }
    }

    std::optional<Result> run(std::size_t start, Range table, unsigned& work, const ImportCancel& cancelled) {
        try {
            auto pc = code_address(image, start);
            std::optional<std::uint32_t> pending;
            bool delay = false;
            Result result;
            for (unsigned step = 0; step < 4096; ++step) {
                if (++work > 15000000)
                    throw std::runtime_error("Collision resolver analysis exceeds its work limit");
                if ((step & 63) == 0)
                    import_detail::check_cancel(cancelled);
                if (pc == return_marker) {
                    if (!(touched & 240))
                        return result;
                    const auto group = read(output_base, 4), slot = read(output_base + 4, 4);
                    if (!group || !slot || (*group != 2 && *group != 3 && *group != 6) || *slot > 999)
                        throw Reject{};
                    result.route = SoundRoute{unsigned(*group), unsigned(*slot)};
                    return result;
                }
                const auto at = code_offset(image, pc);
                if (!at)
                    throw Reject{};
                const auto w = image.bytes.le(*at), op = w >> 26, rs = (w >> 21) & 31, rt = (w >> 16) & 31,
                           rd = (w >> 11) & 31, fn = w & 63, shift = (w >> 6) & 31;
                const auto imm = std::uint16_t(w);
                const auto si = std::int64_t(std::bit_cast<std::int16_t>(imm));
                const auto a = regs[rs], b = regs[rt];
                const auto address =
                    a ? std::optional<std::uint32_t>(std::uint32_t(*a + std::uint64_t(si))) : std::nullopt;
                const bool control = op == 1 || op == 2 || op == 3 || op == 4 || op == 5 || op == 6 || op == 7 ||
                                     op == 20 || op == 21 || (op == 0 && (fn == 8 || fn == 9));
                if (delay && control)
                    throw Reject{};
                if (op == 15 && rs != 0)
                    throw Reject{};
                if (op == 0 && ((fn == 0 || fn == 2 || fn == 3) ? rs != 0 : shift != 0))
                    throw Reject{};
                std::optional<std::uint32_t> target;
                bool annul = false;
                const auto set = [&](unsigned reg, Number value, std::optional<std::size_t> origin = std::nullopt) {
                    regs[reg] = value;
                    origins[reg] = origin;
                };
                const auto unary = [&](const auto& action) -> Number { return a ? Number(action(*a)) : std::nullopt; };
                const auto binary = [&](const auto& action) -> Number {
                    return a && b ? Number(action(*a, *b)) : std::nullopt;
                };
                switch (op) {
                case 15: set(rt, word(std::uint32_t(imm) << 16)); break;
                case 9: set(rt, unary([&](auto n) { return word(n + std::uint64_t(si)); })); break;
                case 25: set(rt, unary([&](auto n) { return n + std::uint64_t(si); })); break;
                case 12: set(rt, unary([&](auto n) { return n & imm; })); break;
                case 13: set(rt, unary([&](auto n) { return n | imm; }), imm == 0 ? origins[rs] : std::nullopt); break;
                case 14: set(rt, unary([&](auto n) { return n ^ imm; })); break;
                case 10: set(rt, unary([&](auto n) { return std::uint64_t(signed_number(n) < si); })); break;
                case 11: set(rt, unary([&](auto n) { return std::uint64_t(n < std::uint64_t(si)); })); break;
                case 0:
                    switch (fn) {
                    case 0: set(rd, b ? Number(word(*b << shift)) : std::nullopt); break;
                    case 2: set(rd, b ? Number(word(std::uint32_t(*b) >> shift)) : std::nullopt); break;
                    case 3:
                        set(rd, b ? Number(word(std::uint64_t(std::bit_cast<std::int32_t>(std::uint32_t(*b)) >> shift)))
                                  : std::nullopt);
                        break;
                    case 33:
                        set(rd, binary([](auto x, auto y) { return word(x + y); }),
                            rs == 0   ? origins[rt]
                            : rt == 0 ? origins[rs]
                                      : std::nullopt);
                        break;
                    case 35: set(rd, binary([](auto x, auto y) { return word(x - y); })); break;
                    case 45:
                        set(rd, binary([](auto x, auto y) { return x + y; }),
                            rs == 0   ? origins[rt]
                            : rt == 0 ? origins[rs]
                                      : std::nullopt);
                        break;
                    case 47: set(rd, binary([](auto x, auto y) { return x - y; })); break;
                    case 36: set(rd, binary([](auto x, auto y) { return x & y; })); break;
                    case 37:
                        set(rd, binary([](auto x, auto y) { return x | y; }),
                            rs == 0   ? origins[rt]
                            : rt == 0 ? origins[rs]
                                      : std::nullopt);
                        break;
                    case 38: set(rd, binary([](auto x, auto y) { return x ^ y; })); break;
                    case 39: set(rd, binary([](auto x, auto y) { return ~(x | y); })); break;
                    case 42:
                        set(rd,
                            binary([](auto x, auto y) { return std::uint64_t(signed_number(x) < signed_number(y)); }));
                        break;
                    case 43: set(rd, binary([](auto x, auto y) { return std::uint64_t(x < y); })); break;
                    case 8:
                    case 9:
                        if (!a || rt != 0 || (fn == 8 && rd != 0))
                            throw Reject{};
                        target = std::uint32_t(*a);
                        if (origins[rs] && *origins[rs] >= table.begin && *origins[rs] < table.end)
                            result.table_used = true;
                        if (fn == 9)
                            set(rd, pc + 8);
                        break;
                    default: throw Reject{};
                    }
                    break;
                case 2:
                case 3:
                    target = ((pc + 4) & 0xf0000000u) | ((w & 0x3ffffffu) << 2);
                    if (op == 3)
                        set(31, pc + 8);
                    break;
                case 1:
                case 4:
                case 5:
                case 6:
                case 7:
                case 20:
                case 21: {
                    if (!a || ((op == 4 || op == 5 || op == 20 || op == 21) && !b))
                        throw Reject{};
                    if ((op == 6 || op == 7) && rt != 0)
                        throw Reject{};
                    bool take = false;
                    if (op == 1) {
                        if (rt > 1)
                            throw Reject{};
                        take = rt == 0 ? signed_number(*a) < 0 : signed_number(*a) >= 0;
                    } else
                        take = op == 4 || op == 20   ? *a == *b
                               : op == 5 || op == 21 ? *a != *b
                               : op == 6             ? signed_number(*a) <= 0
                                                     : signed_number(*a) > 0;
                    if (take)
                        target = std::uint32_t(std::uint64_t(pc) + 4 + std::uint64_t(si * 4));
                    else
                        annul = op == 20 || op == 21;
                    break;
                }
                case 32:
                case 33:
                case 35:
                case 36:
                case 37:
                case 39:
                case 55:
                case 30: {
                    const unsigned width = op == 32 || op == 36   ? 1u
                                           : op == 33 || op == 37 ? 2u
                                           : op == 55 || op == 30 ? 8u
                                                                  : 4u;
                    if (address && *address % (op == 30 ? 16 : width))
                        throw Reject{};
                    auto value = address ? read(*address, width) : std::nullopt;
                    if (value && (op == 32 || op == 33 || op == 35)) {
                        if (width == 4)
                            value = word(*value);
                        else {
                            const auto bits = width * 8;
                            const auto sign = std::uint64_t(1) << (bits - 1);
                            value = (*value ^ sign) - sign;
                        }
                    }
                    std::optional<std::size_t> origin;
                    if (address && value && width == 4 && code_offset(image, std::uint32_t(*value)))
                        origin = file_offset(image, *address);
                    set(rt, value, origin);
                    break;
                }
                case 40:
                case 41:
                case 43:
                case 63:
                case 31: {
                    const unsigned width = op == 40 ? 1u : op == 41 ? 2u : op == 43 ? 4u : op == 63 ? 8u : 16u;
                    if (!address || *address % width)
                        throw Reject{};
                    write(*address, b, width);
                    break;
                }
                default: throw Reject{};
                }
                regs[0] = 0;
                origins[0].reset();
                const auto next = pending.value_or(pc + (annul ? 8 : 4));
                pending = target;
                delay = control && !annul;
                pc = next;
            }
        } catch (const Reject&) {
        }
        return {};
    }
};

std::vector<Range> pointer_tables(const Executable& image, const ImportCancel& cancelled) {
    std::vector<Range> tables;
    std::optional<std::size_t> begin;
    const auto finish = [&](std::size_t end) {
        if (begin && end - *begin >= 24 * 4 && end - *begin <= 1024 * 4)
            tables.push_back({*begin, end});
        begin.reset();
    };
    for (std::size_t p = 0; p + 4 <= image.bytes.data.size(); p += 4) {
        if ((p & 65535) == 0)
            import_detail::check_cancel(cancelled);
        if (code_offset(image, image.bytes.le(p))) {
            if (!begin)
                begin = p;
        } else
            finish(p);
    }
    finish(image.bytes.data.size() & ~std::size_t(3));
    if (tables.size() > 512)
        throw std::runtime_error("Too many collision-dispatch candidates");
    return tables;
}
} // namespace

std::optional<std::map<unsigned, SoundRoute>> executable_collision_routes(std::span<const std::uint8_t> source,
                                                                          const ImportCancel& cancelled) {
    import_detail::check_cancel(cancelled);
    Executable image(source);
    std::optional<std::map<unsigned, SoundRoute>> result;
    unsigned work = 0;
    for (const auto table : pointer_tables(image, cancelled)) {
        std::set<std::size_t> targets;
        for (auto p = table.begin; p < table.end; p += 4)
            targets.insert(*code_offset(image, image.bytes.le(p)));
        if (targets.size() < 8 || *targets.rbegin() - *targets.begin() > 16384)
            continue;
        const auto low = *targets.begin();
        std::vector<std::size_t> starts;
        for (const auto range : image.text)
            if (low >= range.begin && low < range.end) {
                auto block = std::max(range.begin, low > 4096 ? low - 4096 : std::size_t(0));
                for (auto p = block; p < low; p += 4) {
                    const auto w = image.bytes.le(p), op = w >> 26, rs = (w >> 21) & 31, rt = (w >> 16) & 31;
                    if (op == 0 && (w & 63) == 8 && rs == 31 && ((w >> 6) & 32767) == 0)
                        block = p + 8;
                    if ((op == 9 || op == 25) && rs == 29 && rt == 29 && (w & 32768))
                        starts.push_back(p);
                }
                starts.push_back(block);
            }
        std::sort(starts.begin(), starts.end());
        starts.erase(std::unique(starts.begin(), starts.end()), starts.end());
        if (starts.size() > 64)
            throw std::runtime_error("Too many collision-dispatch entry points");
        for (const auto start : starts) {
            bool witnessed = false;
            for (unsigned event = 0; event < 32; ++event) {
                Probe probe(image, event);
                const auto row = probe.run(start, table, work, cancelled);
                if (!row)
                    break;
                if (row->table_used && row->route && (row->route->group == 2 || row->route->group == 3)) {
                    witnessed = true;
                    break;
                }
            }
            if (!witnessed)
                continue;
            std::map<unsigned, SoundRoute> routes;
            std::set<unsigned> slots;
            bool valid = true;
            for (unsigned event = 0; event < 1024; ++event) {
                Probe probe(image, event);
                const auto row = probe.run(start, table, work, cancelled);
                if (!row) {
                    valid = false;
                    break;
                }
                if (row->route) {
                    routes[event] = *row->route;
                    if (row->route->group == 2 || row->route->group == 3)
                        slots.insert(row->route->slot);
                }
            }
            if (!valid || routes.size() < 16 || slots.size() < 8)
                continue;
            if (result && *result != routes)
                throw std::runtime_error("Ambiguous collision resolver in supplied executable");
            result = std::move(routes);
        }
    }
    return result;
}

std::optional<CollisionRoutes> disc_collision_routes(const DiscInput& disc, const ImportCancel& cancelled) {
    const auto boot = executable_detail::boot_executable(disc, cancelled);
    if (!boot)
        return {};
    const auto routes = executable_collision_routes(boot->bytes, cancelled);
    if (!routes)
        return {};
    return CollisionRoutes{boot->name, *routes};
}
} // namespace openslope
