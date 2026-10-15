#include "openslope/audio_program.hpp"
#include <algorithm>
#include <cctype>
#include <cmath>
#include <sstream>
#include <stdexcept>

namespace openslope {
namespace {
std::string upper(std::string s) {
    for (auto& c : s)
        c = char(std::toupper(static_cast<unsigned char>(c)));
    return s;
}

std::string trim(std::string s) {
    const auto begin = s.find_first_not_of(" \r\t");
    if (begin == std::string::npos)
        return {};
    s = s.substr(begin);
    s.resize(s.find_last_not_of(" \r\t") + 1);
    return s;
}

bool family(const std::string& s) {
    return s == "PACK" || s == "POWDER" || s == "LOOSE" || s == "ICE" || s == "METAL" || s == "WOOD" || s == "RAIL" ||
           s == "ROCK" || s == "GLASS" || s == "CHUTE";
}
} // namespace

AudioPrograms parse_audio_programs(const std::string& text) {
    if (text.size() > 1024 * 1024)
        throw std::runtime_error("Board sound programs exceed their limit");
    AudioPrograms result;
    std::vector<std::string> families;
    std::string mode, line;
    std::istringstream stream(text);
    while (std::getline(stream, line)) {
        line = trim(line.substr(0, line.find('#')));
        if (line.empty())
            continue;
        if (line.front() == '[' && line.back() == ']') {
            const auto section = upper(trim(line.substr(1, line.size() - 2)));
            if (family(section)) {
                if (!mode.empty()) {
                    families.clear();
                    mode.clear();
                }
                families.push_back(section);
            } else {
                if (families.empty() || (section != "GLIDE" && section != "CARVE" && section != "AIGLIDE"))
                    throw std::runtime_error("Unknown board sound program section");
                mode = section;
            }
            continue;
        }
        if (mode.empty() || families.empty())
            throw std::runtime_error("Board sound instruction has no program");
        std::replace(line.begin(), line.end(), ',', ' ');
        std::istringstream input(line);
        AudioInstruction instruction;
        input >> instruction.op;
        instruction.op = upper(instruction.op);
        if (instruction.op == "ADDS")
            instruction.op = "SADD";
        if (instruction.op == "LOAD") {
            std::string value;
            if (!(input >> value))
                throw std::runtime_error("Missing Load operand");
            value = upper(value);
            if (value == "SLIP" || value == "DIG" || value == "LEAN" || value == "BOARD" || value == "BEND")
                instruction.signal = value;
            else {
                std::size_t used = 0;
                instruction.first = std::stod(value, &used);
                if (used != value.size())
                    throw std::runtime_error("Invalid Load number");
            }
        } else if (instruction.op == "MAP" || instruction.op == "ADD" || instruction.op == "SUB" ||
                   instruction.op == "MUL" || instruction.op == "DIV") {
            if (!(input >> instruction.first))
                throw std::runtime_error("Missing arithmetic operand");
            if ((instruction.op == "MAP" || instruction.op == "DIV") && instruction.first == 0)
                throw std::runtime_error("Zero audio program divisor");
        } else if (instruction.op == "BOUND") {
            if (!(input >> instruction.first >> instruction.second) || instruction.first > instruction.second)
                throw std::runtime_error("Invalid audio program bounds");
        } else if (instruction.op != "SQUARE" && instruction.op != "SQRT" && instruction.op != "PUSH" &&
                   instruction.op != "POP" && instruction.op != "SADD" && instruction.op != "SSUB" &&
                   instruction.op != "SMUL" && instruction.op != "SDIV" && instruction.op != "ASSIGNVOL" &&
                   instruction.op != "ASSIGNBEND")
            throw std::runtime_error("Unknown board audio instruction");
        std::string extra;
        if (input >> extra)
            throw std::runtime_error("Extra audio program operands");
        if (!std::isfinite(instruction.first) || !std::isfinite(instruction.second))
            throw std::runtime_error("Non-finite audio operand");
        for (const auto& f : families) {
            auto& program = result[f][mode];
            if (program.size() >= 1024)
                throw std::runtime_error("Audio program is too long");
            program.push_back(instruction);
        }
    }
    return result;
}

RideAudioLevel evaluate_audio_program(const AudioProgram& program, RideAudioSignals signals) {
    const std::array<double, 5> inputs{signals.slip, signals.dig, signals.lean, signals.board, signals.bend};
    for (const auto value : inputs)
        if (!std::isfinite(value))
            throw std::runtime_error("Non-finite board audio signal");
    double accumulator = 0;
    std::array<double, 64> stack{};
    std::size_t count = 0;
    RideAudioLevel result;
    for (const auto& i : program) {
        if (i.op == "LOAD")
            accumulator = i.signal.empty()      ? i.first
                          : i.signal == "SLIP"  ? signals.slip
                          : i.signal == "DIG"   ? signals.dig
                          : i.signal == "LEAN"  ? signals.lean
                          : i.signal == "BOARD" ? signals.board
                                                : signals.bend;
        else if (i.op == "MAP")
            accumulator *= 127 / i.first;
        else if (i.op == "ADD")
            accumulator += i.first;
        else if (i.op == "SUB")
            accumulator -= i.first;
        else if (i.op == "MUL")
            accumulator *= i.first;
        else if (i.op == "DIV")
            accumulator /= i.first;
        else if (i.op == "SQUARE")
            accumulator *= accumulator;
        else if (i.op == "SQRT")
            accumulator = std::sqrt(std::max(0., accumulator));
        else if (i.op == "BOUND")
            accumulator = std::clamp(accumulator, i.first, i.second);
        else if (i.op == "PUSH") {
            if (count == stack.size())
                throw std::runtime_error("Audio expression stack overflow");
            stack[count++] = accumulator;
        } else if (i.op == "POP") {
            if (!count)
                throw std::runtime_error("Audio expression stack underflow");
            accumulator = stack[--count];
        } else if (i.op == "SADD" || i.op == "SSUB" || i.op == "SMUL" || i.op == "SDIV") {
            if (count < 2)
                throw std::runtime_error("Audio expression stack underflow");
            const auto b = stack[--count];
            auto& a = stack[count - 1];
            if (i.op == "SADD")
                a += b;
            else if (i.op == "SSUB")
                a -= b;
            else if (i.op == "SMUL")
                a *= b;
            else {
                if (b == 0)
                    throw std::runtime_error("Zero audio expression divisor");
                a /= b;
            }
        } else if (i.op == "ASSIGNVOL")
            result.volume = std::clamp(accumulator, 0., 127.);
        else if (i.op == "ASSIGNBEND")
            result.bend = std::clamp(accumulator, 0., 127.);
        if (!std::isfinite(accumulator) || std::abs(accumulator) > 1e12)
            throw std::runtime_error("Audio expression exceeds its numeric range");
    }
    return result;
}

double ambient_curve(unsigned curve, double d) {
    if (!std::isfinite(d))
        throw std::runtime_error("Invalid ambient distance");
    d = std::clamp(d, 0., 1.);
    switch (curve) {
    case 0: return 1 - d * d;
    case 1: return 1 - d / (1.5 - .5 * d);
    case 2: return 1 - d;
    case 3: return (1 - d) / (1.5 - .5 * (1 - d));
    case 4: return (1 - d) * (1 - d);
    case 5: return d <= .7 ? 1 : (1 - d) / .3;
    default: throw std::runtime_error("Unsupported ambient falloff");
    }
}
} // namespace openslope
