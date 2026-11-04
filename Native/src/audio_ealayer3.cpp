#include "audio_ealayer3.hpp"
#include "import/shared.hpp"
#include <algorithm>
#include <optional>
#define MINIMP3_ONLY_MP3
#define MINIMP3_IMPLEMENTATION
#include <minimp3.h>

namespace openslope {
namespace {
using import_detail::Bytes;

void require(bool ok, const char* message) {
    if (!ok)
        throw std::runtime_error(message);
}

struct Bits {
    std::span<const std::uint8_t> bytes;
    std::size_t at = 0;

    unsigned get(unsigned count) {
        require(count <= 32 && at <= bytes.size() * 8 && count <= bytes.size() * 8 - at, "Truncated audio bits");
        unsigned value = 0;
        for (unsigned i = 0; i < count; ++i, ++at)
            value = (value << 1) | ((bytes[at / 8] >> (7 - at % 8)) & 1);
        return value;
    }

    void skip(std::size_t count) {
        require(at <= bytes.size() * 8 && count <= bytes.size() * 8 - at, "Truncated audio payload");
        at += count;
    }
};

struct OutBits {
    std::vector<std::uint8_t> bytes;
    std::size_t at = 0;

    void put(unsigned value, unsigned count) {
        for (unsigned i = count; i; --i, ++at) {
            if (at / 8 == bytes.size())
                bytes.push_back(0);
            bytes[at / 8] |= std::uint8_t(((value >> (i - 1)) & 1) << (7 - at % 8));
        }
    }

    void copy(Bits source, std::size_t count) {
        for (std::size_t i = 0; i < count; ++i)
            put(source.get(1), 1);
    }
};

struct Granule {
    unsigned rate{}, mode{}, extension{}, index{}, channels{};
    std::array<unsigned, 2> scfsi{};
    OutBits side, data;
};

struct Stream {
    struct Patch {
        std::size_t frame;
        std::vector<std::int16_t> samples;
    };

    static constexpr unsigned delay = 1105;
    mp3dec_t decoder{};
    std::optional<Granule> first;
    std::vector<std::int16_t> pcm;
    std::vector<Patch> patches;
    std::size_t granules = 0;
    unsigned channels = 0, rate = 0;

    Stream() { mp3dec_init(&decoder); }

    void submit(Granule gr) {
        ++granules;
        if (!gr.index) {
            require(!first, "Missing MPEG granule partner");
            first = std::move(gr);
            return;
        }
        require(first.has_value(), "Missing MPEG first granule");
        const auto& a = *first;
        require(a.channels == gr.channels && a.rate == gr.rate && a.mode == gr.mode && a.extension == gr.extension,
                "Inconsistent MPEG granules");
        constexpr unsigned frame_bytes = 2300;
        const unsigned header = 0xfffb0000u | (gr.rate << 10) | (gr.mode << 6) | (gr.extension << 4);
        OutBits frame;
        frame.put(header, 32);
        frame.put(0, 9);
        frame.put(0, gr.channels == 1 ? 5 : 3);
        for (unsigned ch = 0; ch < gr.channels; ++ch)
            frame.put(gr.scfsi[ch], 4);
        frame.copy(Bits{a.side.bytes}, a.side.at);
        frame.copy(Bits{gr.side.bytes}, gr.side.at);
        frame.copy(Bits{a.data.bytes}, a.data.at);
        frame.copy(Bits{gr.data.bytes}, gr.data.at);
        require(frame.bytes.size() <= frame_bytes, "Oversized reconstructed MPEG frame");
        frame.bytes.resize(frame_bytes * 3);
        for (unsigned p : {frame_bytes, frame_bytes * 2})
            for (unsigned i = 0; i < 4; ++i)
                frame.bytes[p + i] = std::uint8_t(header >> (24 - i * 8));
        decoder.free_format_bytes = frame_bytes;
        mp3dec_frame_info_t info{};
        std::array<mp3d_sample_t, MINIMP3_MAX_SAMPLES_PER_FRAME> decoded{};
        const auto samples =
            mp3dec_decode_frame(&decoder, frame.bytes.data(), int(frame.bytes.size()), decoded.data(), &info);
        require(samples == 1152 && info.channels == int(gr.channels), "Invalid reconstructed MPEG audio");
        require(pcm.size() + samples * gr.channels <= 64 * 1024 * 1024, "Decoded MPEG audio exceeds limit");
        pcm.insert(pcm.end(), decoded.begin(), decoded.begin() + samples * gr.channels);
        channels = gr.channels;
        rate = unsigned(info.hz);
        first.reset();
    }

    void block(std::span<const std::uint8_t> data) {
        std::size_t p = 0;
        while (p < data.size()) {
            if (data.size() - p <= 3 &&
                std::all_of(data.begin() + std::ptrdiff_t(p), data.end(), [](auto v) { return v == 0; }))
                break;
            Bits b{data.subspan(p)};
            const auto flag = b.get(8);
            if (flag == 238) {
                const auto offset = b.get(16), count = b.get(16);
                require(channels && offset <= 1152 && count <= 1152 && granules * 576 >= delay + offset,
                        "Invalid audio PCM splice");
                require(patches.size() < 8192, "Too many audio PCM splices");
                Patch patch{granules * 576 - delay - offset, {}};
                patch.samples.reserve(std::size_t(count) * channels);
                for (unsigned i = 0; i < count * channels; ++i)
                    patch.samples.push_back(std::int16_t(b.get(16)));
                patches.push_back(std::move(patch));
                p += (b.at + 7) / 8;
                continue;
            }
            require(flag == 0, "Unsupported EA Layer 3 granule variant");
            require(b.get(2) == 3, "Unsupported EA MPEG version");
            Granule gr;
            gr.rate = b.get(2);
            gr.mode = b.get(2);
            gr.extension = b.get(2);
            gr.index = b.get(1);
            gr.channels = gr.mode == 3 ? 1 : 2;
            require(gr.rate < 3, "Invalid MPEG audio rate");
            if (channels)
                require(channels == gr.channels, "Changing MPEG audio channels");
            channels = gr.channels;
            if (gr.index)
                for (unsigned ch = 0; ch < gr.channels; ++ch)
                    gr.scfsi[ch] = b.get(4);
            const auto side = b;
            unsigned length = 0;
            for (unsigned ch = 0; ch < gr.channels; ++ch) {
                length += b.get(12);
                b.skip(9 + 8 + 4);
                const auto switched = b.get(1);
                if (switched)
                    b.skip(2 + 1 + 10 + 9);
                else
                    b.skip(15 + 4 + 3);
                b.skip(3);
            }
            gr.side.copy(side, b.at - side.at);
            gr.data.copy(b, length);
            b.skip(length);
            p += (b.at + 7) / 8;
            submit(std::move(gr));
        }
    }
};
} // namespace

AudioStream decode_ealayer3_stream(std::span<const std::uint8_t> source, std::size_t p, unsigned channels,
                                   unsigned rate, unsigned frames, unsigned priority) {
    // [Trailmap: 550-ealayer3-audio] Independently framed MPEG granules;
    // minimp3 supplies only the standard Layer III decoding stage.
    require((channels == 1 || channels == 2 || channels == 4) && rate >= 32000 && rate <= 48000 && frames > 0 &&
                frames <= 16 * 1024 * 1024 && priority <= 255,
            "Unsupported EA Layer 3 format");
    Bytes b{source};
    std::vector<Stream> streams(channels);
    unsigned blocks = 0;
    std::size_t expected = 0;
    while (p < source.size()) {
        require(++blocks <= 100000, "Too many audio blocks");
        b.range(p, 8);
        const auto kind = b.text(p, 4);
        const auto size = b.le(p + 4);
        require(size >= 8, "Invalid audio block size");
        b.range(p, size);
        if (kind == "SCEl") {
            AudioStream out;
            out.end = p + size;
            out.clip.rate = rate;
            out.clip.channels = std::min(channels, 2u);
            out.clip.priority = priority;
            out.clip.samples.resize(std::size_t(frames) * out.clip.channels);
            unsigned input = 0;
            for (auto& stream : streams) {
                if (!stream.channels)
                    break;
                require(stream.rate == rate &&
                            stream.pcm.size() / stream.channels >= std::size_t(frames) + Stream::delay,
                        "EA Layer 3 duration mismatch");
                for (const auto& patch : stream.patches) {
                    require(patch.frame <= frames && patch.samples.size() / stream.channels <= frames - patch.frame,
                            "Audio PCM splice exceeds duration");
                    std::copy(patch.samples.begin(), patch.samples.end(),
                              stream.pcm.begin() + std::ptrdiff_t((patch.frame + Stream::delay) * stream.channels));
                }
                for (unsigned n = 0; n < frames; ++n)
                    for (unsigned ch = 0; ch < stream.channels; ++ch) {
                        const auto destination = (input + ch) % out.clip.channels;
                        out.clip.samples[std::size_t(n) * out.clip.channels + destination] +=
                            stream.pcm[(std::size_t(n) + Stream::delay) * stream.channels + ch] / 32768.f *
                            (channels == 4 ? .5f : 1.f);
                    }
                input += stream.channels;
            }
            require(input == channels && expected == frames, "Inconsistent EA Layer 3 stream length");
            return out;
        }
        if (kind == "SCDl") {
            require(size >= 12 + channels * 4, "Truncated EA Layer 3 block");
            expected += b.le(p + 8);
            require(expected <= frames, "EA Layer 3 block exceeds sample count");
            const auto base = p + 12 + channels * 4, end = p + size;
            unsigned channel = 0, index = 0;
            while (channel < channels) {
                const auto offset = b.le(p + 12 + channel * 4);
                require(offset <= end - base && end - base - offset >= 2, "Invalid EA Layer 3 stream offset");
                const auto begin = base + offset;
                const auto mode = (b.le(begin + 1, 1) >> 2) & 3, width = mode == 3 ? 1u : 2u;
                require(channel + width <= channels, "Invalid EA Layer 3 channel layout");
                const auto next = channel + width < channels ? b.le(p + 12 + (channel + width) * 4) : end - base;
                require(next > offset && next <= end - base, "Invalid EA Layer 3 channel extent");
                const auto finish = base + next;
                streams[index++].block(source.subspan(begin, finish - begin));
                channel += width;
            }
        } else
            require(kind == "SCCl" || kind == "SCLl", "Unsupported EA Layer 3 block");
        p += size;
    }
    throw std::runtime_error("Unterminated EA Layer 3 stream");
}
} // namespace openslope
