#include "openslope/audio_opus.hpp"
#include <chrono>
#include <fstream>
#include <iostream>

using namespace openslope;

namespace {
void check(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(message);
}

std::vector<char> bytes(const std::filesystem::path& path) {
    std::ifstream file(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(file), {}};
}
} // namespace

int main() {
    const auto root = std::filesystem::temp_directory_path() /
                      ("openslope-opus-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directory(root);

    struct Cleanup {
        std::filesystem::path path;

        ~Cleanup() { std::filesystem::remove_all(path); }
    } cleanup{root};

    try {
        for (const auto rate : {22050u, 36000u, 48000u}) {
            for (const auto channels : {1u, 2u}) {
                PcmClip source;
                source.rate = rate;
                source.channels = channels;
                const std::size_t frames = rate + 127;
                for (std::size_t i = 0; i < frames; ++i)
                    for (unsigned c = 0; c < channels; ++c)
                        source.samples.push_back(
                            float(.3 * std::sin(double(i) * (440 + c * 220) * 6.283185307179586 / rate)));
                const auto wav = root / "clip.wav", opus = root / "clip.opus", second = root / "second.opus";
                write_wave(wav, source);
                write_reference_opus(wav, opus);
                write_reference_opus(wav, second);
                check(bytes(opus) == bytes(second), "Reference Opus encoding must be deterministic");
                check(std::filesystem::file_size(opus) < std::filesystem::file_size(wav) / 2, "Music should compress");
                const auto decoded = PcmClip::load(opus);
                check(decoded.rate == rate && decoded.channels == channels && decoded.frames() == frames,
                      "Opus pre-skip and end trimming must preserve original frame extent/rate");
                double error = 0;
                for (std::size_t i = 0; i < source.samples.size(); ++i)
                    error += std::pow(source.samples[i] - decoded.samples[i], 2);
                check(error / double(source.samples.size()) < .003,
                      "Decoded music must remain aligned with its source");
                WaveReader stream(opus);
                check(stream.frames() == frames && stream.rate() == rate, "Intro streaming preserves timing");
                check(stream.read(frames - 31, 31).frames() == 31, "Intro supports bounded tail reads");
                check(music_asset(wav) == wav, "Legacy WAV takes precedence");
                std::filesystem::remove(wav);
                check(music_asset(wav) == opus, "Music graph can resolve compressed sibling");
            }
        }
        auto corrupt = bytes(root / "clip.opus");
        corrupt.back() ^= 1;
        std::ofstream bad(root / "bad.opus", std::ios::binary);
        bad.write(corrupt.data(), std::streamsize(corrupt.size()));
        bad.close();
        bool rejected = false;
        try {
            static_cast<void>(PcmClip::load(root / "bad.opus"));
        } catch (const std::exception&) {
            rejected = true;
        }
        check(rejected, "Reject damaged Ogg pages");
        std::cout << "Opus timing, compression, deterministic encoding, streaming and corruption checks PASS\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
