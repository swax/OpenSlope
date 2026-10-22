#include "openslope/audio_data.hpp"
#include "import_internal.hpp"
#include <fstream>
#include <map>
#include <nlohmann/json.hpp>

namespace openslope {
namespace {
using import_detail::Bytes;

std::map<unsigned, std::uint32_t> patches(Bytes b, std::size_t& p) {
    if (b.text(p, 2) != "PT" || b.le(p + 2, 2) != 5)
        throw std::runtime_error("Unsupported audio platform");
    p += 4;
    const auto start = p;
    std::map<unsigned, std::uint32_t> fields;
    while (p < b.data.size() && p - start < 4096) {
        const auto tag = b.le(p++, 1);
        if (tag == 0xfe || tag == 0xff)
            return fields;
        if (tag == 0xfc || tag == 0xfd)
            continue;
        const auto count = b.le(p++, 1);
        b.range(p, count);
        if (count <= 4)
            fields[tag] = b.be(p, count);
        p += count;
    }
    throw std::runtime_error("Unterminated audio patch table");
}

PcmClip format(const std::map<unsigned, std::uint32_t>& fields) {
    const auto field = [&](unsigned tag, unsigned fallback) {
        const auto i = fields.find(tag);
        return i == fields.end() ? fallback : i->second;
    };
    PcmClip clip;
    clip.rate = field(0x84, 22050);
    clip.channels = field(0x82, 1);
    clip.priority = field(6, 90);
    if (clip.rate < 8000 || clip.rate > 192000 || clip.channels < 1 || clip.channels > 2 || clip.priority > 255)
        throw std::runtime_error("Unsupported audio channel/rate/priority");
    return clip;
}

void interleave(PcmClip& clip, const std::array<std::vector<std::int16_t>, 2>& channels) {
    const auto count = channels[0].size();
    if (clip.channels == 2 && channels[1].size() != count)
        throw std::runtime_error("Audio channels have different extents");
    if (clip.samples.size() + count * clip.channels > 32 * 1024 * 1024)
        throw std::runtime_error("Decoded audio clip exceeds its limit");
    // Streamed clips append many blocks. Reserving the exact new size on each
    // block copies the entire decoded prefix repeatedly (quadratic work).
    // Grow geometrically, while keeping capacity inside the decoded clip limit.
    const auto required = clip.samples.size() + count * clip.channels;
    if (required > clip.samples.capacity())
        clip.samples.reserve(std::min<std::size_t>(32 * 1024 * 1024, std::max(required, clip.samples.capacity() * 2)));
    const auto start = clip.samples.size();
    clip.samples.resize(required);
    for (std::size_t i = 0; i < count; ++i)
        for (unsigned c = 0; c < clip.channels; ++c)
            clip.samples[start + i * clip.channels + c] = channels[c][i] / 32768.f;
}
} // namespace

AudioBank decode_audio_bank(std::span<const std::uint8_t> source, bool omit_speech, bool defer_unsupported) {
    // [Trailmap: 260-bnk, 260-bnk-sound, 260-bnk-data] Entry offsets are
    // self-relative; channel offsets are absolute within this bank.
    Bytes b{source};
    b.range(0, 12);
    if (b.text(0, 4) != "BNKl")
        throw std::runtime_error("Invalid sound bank signature");
    const auto version = b.le(4, 1), count = b.le(6, 2);
    const std::size_t table = version == 2 ? 12 : version == 4 || version == 5 ? 20 : 0;
    if (!table || count > 4096)
        throw std::runtime_error("Unsupported sound bank version/count");
    b.range(table, count * 4);
    AudioBank result;
    result.slots.resize(count);
    std::size_t decoded_samples = 0;
    for (unsigned i = 0; i < count; ++i) {
        const auto entry = table + i * 4;
        const auto relative = b.le(entry);
        if (!relative)
            continue;
        std::size_t p = entry + relative;
        const auto fields = patches(b, p);
        auto clip = format(fields);
        const auto samples = fields.contains(0x85) ? fields.at(0x85) : 0;
        if (!samples)
            continue;
        if (samples > 16 * 1024 * 1024 || std::size_t(samples) * clip.channels > 32 * 1024 * 1024 - decoded_samples)
            throw std::runtime_error("Sound bank sample count exceeds its limit");
        decoded_samples += std::size_t(samples) * clip.channels;
        const auto codec = fields.contains(0xa0) ? fields.at(0xa0) : 5;
        if (omit_speech && codec == 4) {
            result.omitted_speech = true;
            continue;
        }
        if (defer_unsupported && codec != 5 && codec != 9 && codec != 10) {
            result.deferred_codecs.emplace_back(i, codec);
            continue;
        }
        std::array<std::vector<std::int16_t>, 2> channels;
        for (unsigned c = 0; c < clip.channels; ++c) {
            const auto key = c ? 0x89u : 0x88u;
            if (!fields.contains(key))
                throw std::runtime_error("Sound bank lacks a channel offset");
            const auto offset = fields.at(key);
            b.range(offset, 0);
            AdpcmState history;
            channels[c] = decode_audio_frames(source.subspan(offset), codec, samples, history);
        }
        interleave(clip, channels);
        if (fields.contains(0x86) && fields.contains(0x87)) {
            clip.loop_start = fields.at(0x86);
            clip.loop_end = fields.at(0x87);
            if (clip.loop_start >= clip.loop_end || clip.loop_end > clip.frames())
                throw std::runtime_error("Invalid sound bank loop range");
        }
        result.slots[i] = std::move(clip);
    }
    return result;
}

void write_audio_bank(const std::filesystem::path& output, const AudioBank& bank,
                      const std::function<void()>& checkpoint) {
    if (!std::filesystem::create_directory(output))
        throw std::runtime_error("Audio bank destination already exists");
    nlohmann::json rows = nlohmann::json::array();
    for (std::size_t i = 0; i < bank.slots.size(); ++i) {
        if (checkpoint)
            checkpoint();
        if (!bank.slots[i]) {
            rows.push_back(nullptr);
            continue;
        }
        const auto& clip = *bank.slots[i];
        auto number = std::to_string(i);
        while (number.size() < 3)
            number.insert(number.begin(), '0');
        const auto name = number + ".wav";
        write_wave(output / name, clip);
        rows.push_back({{"Clip", name},
                        {"Rate", clip.rate},
                        {"Channels", clip.channels},
                        {"Frames", clip.frames()},
                        {"LoopStart", clip.loop_start},
                        {"LoopEnd", clip.loop_end},
                        {"Priority", clip.priority}});
        if (clip.loop_end) {
            PcmClip loop;
            loop.rate = clip.rate;
            loop.channels = clip.channels;
            loop.samples = {clip.samples.begin() + clip.loop_start * clip.channels,
                            clip.samples.begin() + clip.loop_end * clip.channels};
            write_wave(output / (number + ".loop.wav"), loop);
        }
    }
    std::ofstream file(output / "bank.json");
    nlohmann::json deferred = nlohmann::json::array();
    for (const auto& [slot, codec] : bank.deferred_codecs)
        deferred.push_back({{"Slot", slot}, {"Codec", codec}, {"Reason", "unsupported-codec"}});
    file << nlohmann::json({{"Schema", "openslope-audio-bank/v1"}, {"Slots", rows}, {"DeferredSlots", deferred}}).dump()
         << '\n';
    if (!file)
        throw std::runtime_error("Cannot write audio bank metadata");
}

AudioStream decode_audio_stream(std::span<const std::uint8_t> source, std::size_t offset) {
    // [Trailmap: 260-schl-chunks, 260-pt, 260-scdl-eaxa] Histories are
    // channel-local and continue across the independently addressed blocks.
    Bytes b{source};
    b.range(offset, 8);
    if (b.text(offset, 4) != "SCHl")
        throw std::runtime_error("Missing streamed audio header");
    const auto header_size = b.le(offset + 4);
    if (header_size < 12)
        throw std::runtime_error("Invalid streamed audio header size");
    b.range(offset, header_size);
    std::size_t cursor = offset + 8;
    const auto fields = patches(Bytes{source.first(offset + header_size)}, cursor);
    AudioStream result;
    result.clip = format(fields);
    const auto codec = fields.contains(0xa0) ? fields.at(0xa0) : 5;
    std::array<AdpcmState, 2> histories;
    std::size_t p = offset + header_size, blocks = 0;
    std::optional<unsigned> expected;
    while (p < source.size()) {
        b.range(p, 8);
        const auto kind = b.text(p, 4);
        const auto size = b.le(p + 4);
        if (size < 8)
            throw std::runtime_error("Invalid streamed audio chunk");
        b.range(p, size);
        if (kind == "SCEl") {
            if (expected && blocks != *expected)
                throw std::runtime_error("Stream block count differs");
            if (result.clip.samples.empty())
                throw std::runtime_error("Stream has no audio samples");
            result.end = p + size;
            return result;
        }
        if (kind == "SCCl") {
            if (size < 12 || expected)
                throw std::runtime_error("Invalid stream block count chunk");
            expected = b.le(p + 8);
            if (*expected > 100000)
                throw std::runtime_error("Too many stream blocks");
        }
        if (kind == "SCDl") {
            if (++blocks > 100000 || size < 12 + result.clip.channels * 4)
                throw std::runtime_error("Invalid audio data block");
            const auto count = b.le(p + 8);
            const auto base = p + 12 + result.clip.channels * 4;
            std::array<std::vector<std::int16_t>, 2> channels;
            for (unsigned c = 0; c < result.clip.channels; ++c) {
                const auto relative = b.le(p + 12 + c * 4);
                const auto begin = base + relative + (codec == 10 ? 4 : 0);
                if (begin > p + size)
                    throw std::runtime_error("Stream channel offset exceeds its block");
                channels[c] = decode_audio_frames(source.subspan(begin, p + size - begin), codec, count, histories[c]);
            }
            interleave(result.clip, channels);
        } else if (kind != "SCCl" && kind != "SCLl")
            throw std::runtime_error("Unsupported streamed audio chunk");
        p += size;
    }
    throw std::runtime_error("Stream end chunk is missing");
}
} // namespace openslope
