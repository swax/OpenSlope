#include "import/shared.hpp"
#include "openslope/audio.hpp"
#include <bit>
#include <fstream>
#include <mutex>

namespace openslope {
using import_detail::Bytes;

struct WaveReader::Data {
    std::ifstream file;
    unsigned rate{}, channels{}, bits{}, format{}, align{};
    std::uint64_t offset{}, count{};
    std::mutex mutex;

    explicit Data(const std::filesystem::path& path) : file(path, std::ios::binary) {
        const auto size = std::filesystem::file_size(path);
        if (size < 44 || size > std::uint64_t(0xffffffffu) + 8 || !file)
            throw std::runtime_error("WAV extent exceeds its limits");
        const auto bytes = [&](std::uint64_t position, unsigned length) {
            if (position > size || length > size - position)
                throw std::runtime_error("Truncated WAV chunk");
            std::vector<std::uint8_t> value(length);
            file.seekg(std::streamoff(position));
            file.read(reinterpret_cast<char*>(value.data()), length);
            if (!file)
                throw std::runtime_error("Cannot read WAV header");
            return value;
        };
        const auto header = bytes(0, 12);
        const Bytes h{header};
        if (h.text(0, 4) != "RIFF" || h.text(8, 4) != "WAVE" || std::uint64_t(h.le(4)) + 8 != size)
            throw std::runtime_error("Invalid RIFF/WAVE extent");
        bool have_format = false, have_data = false;
        unsigned chunks = 0;
        for (std::uint64_t p = 12; p < size;) {
            if (++chunks > 4096)
                throw std::runtime_error("Too many WAV chunks");
            const auto chunk = bytes(p, 8);
            const Bytes c{chunk};
            const auto length = c.le(4);
            if (length > size - p - 8)
                throw std::runtime_error("Truncated WAV chunk");
            const auto kind = c.text(0, 4);
            if (kind == "fmt ") {
                if (have_format || length < 16)
                    throw std::runtime_error("Invalid WAV format chunk");
                have_format = true;
                const auto fields = bytes(p + 8, 16);
                const Bytes f{fields};
                format = f.le(0, 2);
                channels = f.le(2, 2);
                rate = f.le(4);
                align = f.le(12, 2);
                bits = f.le(14, 2);
                if (channels < 1 || channels > 2 || rate < 8000 || rate > 192000 ||
                    align != channels * ((bits + 7) / 8) || f.le(8) != rate * align)
                    throw std::runtime_error("Invalid WAV channel/rate layout");
            }
            if (kind == "data") {
                if (have_data)
                    throw std::runtime_error("Duplicate WAV data chunk");
                have_data = true;
                offset = p + 8;
                count = length;
            }
            p += 8 + std::uint64_t(length) + (length & 1);
            if (p > size)
                throw std::runtime_error("Truncated WAV chunk padding");
        }
        if (!have_format || !have_data || !align || !count || count % align || (format != 1 && format != 3) ||
            (format == 3 && bits != 32) || (format == 1 && bits != 8 && bits != 16 && bits != 24 && bits != 32))
            throw std::runtime_error("Unsupported or incomplete WAV sample format");
    }
};

WaveReader::WaveReader(const std::filesystem::path& path) : data_(std::make_unique<Data>(path)) {}

WaveReader::~WaveReader() = default;

unsigned WaveReader::rate() const { return data_->rate; }

unsigned WaveReader::channels() const { return data_->channels; }

std::size_t WaveReader::frames() const { return std::size_t(data_->count / data_->align); }

PcmClip WaveReader::read(std::size_t first, std::size_t count) {
    auto& d = *data_;
    if (first > frames() || count > frames() - first || count > (32 * 1024 * 1024) / d.channels)
        throw std::runtime_error("WAV frame read exceeds its limits");
    std::lock_guard lock(d.mutex);
    std::vector<std::uint8_t> bytes(count * d.align);
    d.file.clear();
    d.file.seekg(std::streamoff(d.offset + std::uint64_t(first) * d.align));
    d.file.read(reinterpret_cast<char*>(bytes.data()), std::streamsize(bytes.size()));
    if (!d.file)
        throw std::runtime_error("Cannot read WAV frames");
    const Bytes b{bytes};
    PcmClip clip;
    clip.rate = d.rate;
    clip.channels = d.channels;
    const auto values = count * d.channels;
    clip.samples.reserve(values);
    for (std::size_t i = 0; i < values; ++i) {
        const auto p = i * (d.bits / 8);
        double sample = 0;
        if (d.format == 3)
            sample = std::bit_cast<float>(b.le(p));
        else if (d.bits == 8)
            sample = (int(b.le(p, 1)) - 128) / 128.;
        else if (d.bits == 16)
            sample = static_cast<std::int16_t>(b.le(p, 2)) / 32768.;
        else if (d.bits == 24) {
            const auto v = b.le(p, 3);
            sample = (v & 0x800000 ? std::int64_t(v) - 0x1000000 : std::int64_t(v)) / 8388608.;
        } else
            sample = static_cast<std::int32_t>(b.le(p)) / 2147483648.;
        if (!std::isfinite(sample))
            throw std::runtime_error("Non-finite WAV sample");
        clip.samples.push_back(float(std::clamp(sample, -1., 1.)));
    }
    return clip;
}

PcmClip PcmClip::load(const std::filesystem::path& path) {
    if (std::filesystem::file_size(path) > 64 * 1024 * 1024)
        throw std::runtime_error("WAV extent exceeds its limits");
    WaveReader reader(path);
    return reader.read(0, reader.frames());
}

std::vector<std::int16_t> decode_audio_frames(std::span<const std::uint8_t> source, unsigned codec, std::size_t count,
                                              AdpcmState& h) {
    if (count > 16 * 1024 * 1024)
        throw std::runtime_error("Decoded audio channel exceeds its limit");
    std::vector<std::int16_t> output(count);
    if (codec == 9) {
        if (count > source.size())
            throw std::runtime_error("Truncated signed PCM audio");
        for (std::size_t i = 0; i < count; ++i)
            output[i] = std::int16_t(static_cast<std::int8_t>(source[i])) * 256;
        return output;
    }
    const unsigned stride = codec == 5 ? 16 : codec == 10 ? 15 : 0;
    if (!stride)
        throw std::runtime_error("Unsupported audio codec");
    const auto frames = (count + 27) / 28;
    if (frames > source.size() / stride)
        throw std::runtime_error("Truncated ADPCM frames");
    // [Trailmap: 260-eaxa, 260-psadpcm] Fixed-point recurrence, with explicit
    // nibble order and clamped/unclamped history according to the codec.
    constexpr std::array<std::array<int, 2>, 5> ps{{{0, 0}, {60, 0}, {115, -52}, {98, -55}, {122, -60}}};
    constexpr std::array<std::array<int, 2>, 4> ea{{{0, 0}, {240, 0}, {460, -208}, {392, -220}}};
    std::size_t p = 0;
    for (std::size_t f = 0; f < frames; ++f) {
        if (p > source.size() || stride > source.size() - p)
            throw std::runtime_error("Truncated ADPCM frame");
        // On Tour also stores literal EA-XA frames: an escape, two signed
        // big-endian history words and 28 signed big-endian PCM samples.
        if (codec == 10 && source[p] == 0xee) {
            if (source.size() - p < 61)
                throw std::runtime_error("Truncated EA-XA literal frame");
            const auto sample_at = [&](std::size_t q) {
                return static_cast<std::int16_t>((unsigned(source[q]) << 8) | source[q + 1]);
            };
            h.first = sample_at(p + 1);
            h.second = sample_at(p + 3);
            for (unsigned i = 0; i < 28; ++i) {
                const auto sample = sample_at(p + 5 + i * 2);
                h.second = h.first;
                h.first = sample;
                if (f * 28 + i < count)
                    output[f * 28 + i] = sample;
            }
            p += 61;
            continue;
        }
        const unsigned predictor = source[p] >> 4, shift = source[p] & 15;
        if (codec == 10 && predictor >= ea.size())
            throw std::runtime_error("Invalid EA-XA predictor");
        const auto coefficients = codec == 10 ? ea[predictor] : ps[predictor < ps.size() ? predictor : 0];
        for (unsigned i = 0; i < 28; ++i) {
            const auto byte = source[p + (codec == 5 ? 2 : 1) + i / 2];
            int nibble = codec == 5 ? (i & 1 ? byte >> 4 : byte & 15) : (i & 1 ? byte & 15 : byte >> 4);
            if (nibble >= 8)
                nibble -= 16;
            const auto sample = codec == 10 ? ((std::int64_t(nibble) * (std::int64_t(1) << (20 - shift)) +
                                                coefficients[0] * h.first + coefficients[1] * h.second + 128) >>
                                               8)
                                            : ((std::int64_t(nibble) * 4096) >> shift) +
                                                  ((coefficients[0] * h.first + coefficients[1] * h.second) >> 6);
            const auto clamped = std::clamp<std::int64_t>(sample, -32768, 32767);
            h.second = h.first;
            h.first = codec == 10 ? clamped : sample;
            if (f * 28 + i < count)
                output[f * 28 + i] = static_cast<std::int16_t>(clamped);
        }
        p += stride;
    }
    return output;
}

void write_wave(const std::filesystem::path& path, const PcmClip& clip) {
    if (clip.channels < 1 || clip.channels > 2 || clip.rate < 8000 || clip.rate > 192000 ||
        clip.samples.size() % clip.channels || clip.samples.size() > 32 * 1024 * 1024)
        throw std::runtime_error("Invalid output PCM");
    std::ofstream file(path, std::ios::binary);
    const auto le = [&](std::uint32_t value, unsigned width) {
        for (unsigned i = 0; i < width; ++i)
            file.put(char((value >> (8 * i)) & 255));
    };
    file << "RIFF";
    le(std::uint32_t(clip.samples.size() * 2 + 36), 4);
    file << "WAVEfmt ";
    le(16, 4);
    le(1, 2);
    le(clip.channels, 2);
    le(clip.rate, 4);
    le(clip.rate * clip.channels * 2, 4);
    le(clip.channels * 2, 2);
    le(16, 2);
    file << "data";
    le(std::uint32_t(clip.samples.size() * 2), 4);
    std::array<char, 65536> buffer{};
    std::size_t used = 0;
    for (const auto sample : clip.samples) {
        if (!std::isfinite(sample))
            throw std::runtime_error("Non-finite output audio sample");
        // Saturate before conversion, then round halfway away from zero. This
        // avoids a scalar lround library call for every imported PCM sample.
        const auto scaled = std::clamp(double(sample) * 32768, -32768., 32767.);
        const auto value = static_cast<std::uint16_t>(static_cast<std::int32_t>(scaled + (scaled < 0 ? -.5 : .5)));
        buffer[used++] = char(value & 255);
        buffer[used++] = char(value >> 8);
        if (used == buffer.size()) {
            file.write(buffer.data(), static_cast<std::streamsize>(used));
            used = 0;
        }
    }
    if (used)
        file.write(buffer.data(), static_cast<std::streamsize>(used));
    if (!file)
        throw std::runtime_error("Cannot write PCM WAV");
}
} // namespace openslope
