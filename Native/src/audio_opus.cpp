#include "openslope/audio_opus.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <fstream>
#include <memory>
#include <opus.h>
#include <string>

namespace openslope {
namespace {
using Bytes = std::vector<unsigned char>;
constexpr std::size_t max_samples = 32 * 1024 * 1024;

void require(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(message);
}

void le(Bytes& bytes, std::uint64_t value, unsigned width) {
    for (unsigned i = 0; i < width; ++i)
        bytes.push_back(static_cast<unsigned char>(value >> (i * 8)));
}

std::uint64_t number(std::span<const unsigned char> bytes, std::size_t offset, unsigned width) {
    require(offset <= bytes.size() && width <= bytes.size() - offset, "Truncated Opus metadata");
    std::uint64_t result = 0;
    for (unsigned i = 0; i < width; ++i)
        result |= std::uint64_t(bytes[offset + i]) << (8 * i);
    return result;
}

std::uint32_t crc(std::span<const unsigned char> bytes) {
    std::uint32_t value = 0;
    for (std::size_t i = 0; i < bytes.size(); ++i) {
        value ^= std::uint32_t(i >= 22 && i < 26 ? 0 : bytes[i]) << 24;
        for (unsigned bit = 0; bit < 8; ++bit)
            value = (value << 1) ^ (value & 0x80000000u ? 0x04c11db7u : 0);
    }
    return value;
}

void text(Bytes& bytes, const std::string& value) { bytes.insert(bytes.end(), value.begin(), value.end()); }

void page(std::ofstream& file, std::span<const unsigned char> packet, unsigned sequence, unsigned flags,
          std::uint64_t granule) {
    Bytes bytes;
    text(bytes, "OggS");
    bytes.push_back(0);
    bytes.push_back(static_cast<unsigned char>(flags));
    le(bytes, granule, 8);
    le(bytes, 1, 4); // Stable serial: identical input/profile produces identical bytes.
    le(bytes, sequence, 4);
    le(bytes, 0, 4);
    require(packet.size() < 255 * 255, "Opus packet exceeds its limit");
    bytes.push_back(static_cast<unsigned char>(packet.size() / 255 + 1));
    for (std::size_t i = 0; i < packet.size() / 255; ++i)
        bytes.push_back(255);
    bytes.push_back(static_cast<unsigned char>(packet.size() % 255));
    bytes.insert(bytes.end(), packet.begin(), packet.end());
    const auto checksum = crc(bytes);
    for (unsigned i = 0; i < 4; ++i)
        bytes[22 + i] = static_cast<unsigned char>(checksum >> (i * 8));
    file.write(reinterpret_cast<const char*>(bytes.data()), std::streamsize(bytes.size()));
    require(bool(file), "Cannot write Opus music");
}

PcmClip resample(const PcmClip& source, unsigned rate, std::size_t frames) {
    require(frames && frames <= max_samples / source.channels, "Opus sample extent exceeds its limit");
    PcmClip output;
    output.rate = rate;
    output.channels = source.channels;
    output.samples.resize(frames * source.channels);
    for (std::size_t i = 0; i < frames; ++i) {
        const auto position = std::min(double(i) * source.rate / rate, double(source.frames() - 1));
        const auto first = std::size_t(position), second = std::min(first + 1, source.frames() - 1);
        const auto fraction = float(position - double(first));
        for (unsigned c = 0; c < source.channels; ++c) {
            const auto a = source.samples[first * source.channels + c];
            output.samples[i * source.channels + c] = a + (source.samples[second * source.channels + c] - a) * fraction;
        }
    }
    return output;
}
} // namespace

std::filesystem::path music_asset(const std::filesystem::path& wav) {
    if (std::filesystem::is_regular_file(wav))
        return wav;
    auto compressed = wav;
    compressed.replace_extension(".opus");
    return std::filesystem::is_regular_file(compressed) ? compressed : wav;
}

void write_reference_opus(const std::filesystem::path& input, const std::filesystem::path& output) {
    const auto source = PcmClip::load(input);
    const auto frames = std::size_t((std::uint64_t(source.frames()) * 48000 + source.rate - 1) / source.rate);
    const auto pcm = resample(source, 48000, frames);
    int error = 0;
    std::unique_ptr<OpusEncoder, decltype(&opus_encoder_destroy)> encoder(
        opus_encoder_create(48000, int(source.channels), OPUS_APPLICATION_AUDIO, &error), opus_encoder_destroy);
    require(encoder && error == OPUS_OK, "Cannot create Opus encoder");
    require(opus_encoder_ctl(encoder.get(), OPUS_SET_BITRATE(128000)) == OPUS_OK &&
                opus_encoder_ctl(encoder.get(), OPUS_SET_VBR(0)) == OPUS_OK,
            "Cannot configure Opus encoder");
    int skip = 0;
    require(opus_encoder_ctl(encoder.get(), OPUS_GET_LOOKAHEAD(&skip)) == OPUS_OK, "Cannot read Opus pre-skip");
    std::ofstream file(output, std::ios::binary);
    require(bool(file), "Cannot open Opus destination");
    Bytes head;
    text(head, "OpusHead");
    head.push_back(1);
    head.push_back(static_cast<unsigned char>(source.channels));
    le(head, unsigned(skip), 2);
    le(head, source.rate, 4);
    le(head, 0, 2);
    head.push_back(0);
    page(file, head, 0, 2, 0);
    Bytes tags;
    text(tags, "OpusTags");
    const std::string vendor = "OpenSlope opus-128-v1", count = "OPENSLOPE_FRAMES=" + std::to_string(source.frames());
    le(tags, vendor.size(), 4);
    text(tags, vendor);
    le(tags, 1, 4);
    le(tags, count.size(), 4);
    text(tags, count);
    page(file, tags, 1, 0, 0);
    std::array<float, 960 * 2> block{};
    std::array<unsigned char, 4000> encoded{};
    unsigned sequence = 2;
    for (std::size_t position = 0; position < frames + unsigned(skip); position += 960) {
        block.fill(0);
        for (unsigned i = 0; i < 960 && position + i < frames; ++i)
            for (unsigned c = 0; c < source.channels; ++c)
                block[i * source.channels + c] = pcm.samples[(position + i) * source.channels + c];
        const int size = opus_encode_float(encoder.get(), block.data(), 960, encoded.data(), int(encoded.size()));
        require(size > 0, "Cannot encode Opus music");
        const bool last = position + 960 >= frames + unsigned(skip);
        page(file, std::span(encoded).first(std::size_t(size)), sequence++, last ? 4 : 0,
             last ? frames + unsigned(skip) : position + 960);
    }
}

PcmClip load_reference_opus(const std::filesystem::path& path) {
    const auto size = std::filesystem::file_size(path);
    require(size >= 64 && size <= 64 * 1024 * 1024, "Opus file extent exceeds its limits");
    std::ifstream file(path, std::ios::binary);
    Bytes bytes(static_cast<std::size_t>(size));
    file.read(reinterpret_cast<char*>(bytes.data()), std::streamsize(size));
    require(bool(file), "Cannot read Opus file");
    PcmClip decoded;
    decoded.rate = 48000;
    std::unique_ptr<OpusDecoder, decltype(&opus_decoder_destroy)> decoder(nullptr, opus_decoder_destroy);
    unsigned sequence = 0, packets = 0, skip = 0, original_rate = 48000;
    std::size_t original_frames = 0;
    std::uint64_t granule = 0, serial = 0;
    bool ended = false;
    Bytes packet;
    std::array<float, 5760 * 2> pcm{};
    for (std::size_t p = 0; p < bytes.size();) {
        require(!ended && bytes.size() - p >= 27 && std::string(bytes.begin() + p, bytes.begin() + p + 4) == "OggS" &&
                    bytes[p + 4] == 0,
                "Invalid Ogg music page");
        const auto segments = bytes[p + 26];
        require(bytes.size() - p >= 27u + segments, "Truncated Ogg segment table");
        std::size_t body = p + 27 + segments, extent = body;
        for (unsigned i = 0; i < segments; ++i)
            extent += bytes[p + 27 + i];
        require(extent <= bytes.size() && crc(std::span(bytes).subspan(p, extent - p)) == number(bytes, p + 22, 4),
                "Invalid Ogg checksum or extent");
        if (!sequence)
            serial = number(bytes, p + 14, 4);
        require(number(bytes, p + 14, 4) == serial && number(bytes, p + 18, 4) == sequence++ &&
                    bool(bytes[p + 5] & 1) == !packet.empty(),
                "Invalid Ogg sequence");
        for (unsigned i = 0; i < segments; ++i) {
            const auto length = bytes[p + 27 + i];
            packet.insert(packet.end(), bytes.begin() + body, bytes.begin() + body + length);
            body += length;
            require(packet.size() < 65536, "Opus packet exceeds its limit");
            if (length == 255)
                continue;
            if (!packets) {
                require(packet.size() == 19 && std::string(packet.begin(), packet.begin() + 8) == "OpusHead" &&
                            packet[8] == 1 && packet[9] >= 1 && packet[9] <= 2 && packet[18] == 0 &&
                            number(packet, 16, 2) == 0,
                        "Unsupported Opus channel layout or gain");
                decoded.channels = packet[9];
                skip = unsigned(number(packet, 10, 2));
                original_rate = unsigned(number(packet, 12, 4));
                require(original_rate >= 8000 && original_rate <= 192000, "Invalid original Opus rate");
                int error = 0;
                decoder.reset(opus_decoder_create(48000, int(decoded.channels), &error));
                require(decoder && error == OPUS_OK, "Cannot create Opus decoder");
            } else if (packets == 1) {
                require(packet.size() >= 16 && std::string(packet.begin(), packet.begin() + 8) == "OpusTags",
                        "Missing Opus tags");
                std::size_t at = 12 + std::size_t(number(packet, 8, 4));
                const auto count = number(packet, at, 4);
                at += 4;
                require(count <= 128, "Too many Opus tags");
                for (unsigned n = 0; n < count; ++n) {
                    const auto tag_length = number(packet, at, 4);
                    at += 4;
                    require(tag_length <= packet.size() && at <= packet.size() - tag_length, "Truncated Opus tag");
                    const std::string tag(packet.begin() + at, packet.begin() + at + tag_length);
                    if (tag.starts_with("OPENSLOPE_FRAMES=")) {
                        const auto value = tag.substr(17);
                        require(
                            !value.empty() && value.size() <= 10 &&
                                std::all_of(value.begin(), value.end(), [](char c) { return c >= '0' && c <= '9'; }),
                            "Invalid original Opus frame count");
                        original_frames = std::stoull(value);
                    }
                    at += std::size_t(tag_length);
                }
            } else {
                const int frames =
                    opus_decode_float(decoder.get(), packet.data(), int(packet.size()), pcm.data(), 5760, 0);
                require(frames > 0 && decoded.samples.size() + std::size_t(frames) * decoded.channels <= max_samples,
                        "Invalid Opus packet or decoded sample extent");
                decoded.samples.insert(decoded.samples.end(), pcm.begin(), pcm.begin() + frames * decoded.channels);
            }
            ++packets;
            packet.clear();
        }
        granule = number(bytes, p + 6, 8);
        ended = (bytes[p + 5] & 4) != 0;
        p = extent;
    }
    require(ended && packet.empty() && packets > 2 && granule > skip && granule <= decoded.frames(),
            "Incomplete Opus music or invalid trimming");
    decoded.samples.resize(std::size_t(granule) * decoded.channels);
    decoded.samples.erase(decoded.samples.begin(), decoded.samples.begin() + skip * decoded.channels);
    if (!original_frames)
        original_frames = std::size_t(std::llround(double(decoded.frames()) * original_rate / 48000));
    require(std::abs(double(original_frames) / original_rate - double(decoded.frames()) / 48000) < 1. / 8000,
            "Opus original timing differs from granule extent");
    return resample(decoded, original_rate, original_frames);
}
} // namespace openslope
