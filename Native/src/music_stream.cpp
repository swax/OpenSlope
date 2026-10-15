#include "openslope/music_stream.hpp"
#include <atomic>
#include <iostream>
#include <mutex>
#include <random>

namespace openslope {
struct MusicStream::Data {
    AudioMixer& mixer;
    std::vector<std::filesystem::path> files;
    std::vector<std::shared_ptr<WaveReader>> readers;
    AudioRole role;
    bool loop;
    double loop_start, loop_end, volume;
    std::atomic<bool> wanted{false};
    std::atomic<std::uint64_t> revision{1};
    std::atomic<std::size_t> decoded{0};
    std::mutex control, service_mutex;
    std::uint64_t applied{}, voice{}, generation{};
    bool failed = false;
    std::shared_ptr<PcmClip> current, queued;
    std::mt19937 random{std::random_device{}()};

    struct Cursor {
        std::size_t file{};
        double frame{};
    } cursor;

    std::size_t window_file = std::size_t(-1), window_first{};
    PcmClip window;
    std::array<float, 2> loop_first{};
    bool have_loop_first = false;

    Data(AudioMixer& m, std::vector<std::filesystem::path> paths, AudioRole r, bool repeat, double start, double end,
         double gain)
        : mixer(m), files(std::move(paths)), readers(files.size()), role(r), loop(repeat), loop_start(start),
          loop_end(end), volume(gain) {
        if (files.empty() || files.size() > 64 || (loop && files.size() != 1) || !std::isfinite(start) ||
            !std::isfinite(end) || start < 0 || end < 0 || !std::isfinite(gain) || gain < 0 || gain > 1 ||
            role == AudioRole::Effect)
            throw std::runtime_error("Invalid music stream source");
    }

    std::size_t choose() { return std::uniform_int_distribution<std::size_t>(0, files.size() - 1)(random); }

    WaveReader& reader(std::size_t i) {
        if (!readers[i])
            readers[i] = std::make_shared<WaveReader>(files[i]);
        return *readers[i];
    }

    void stop() {
        if (voice)
            mixer.stop(voice);
        voice = generation = 0;
        current.reset();
        queued.reset();
        decoded = 0;
        cursor = {loop ? 0 : choose(), 0};
    }

    void account() {
        decoded = ((current ? current->samples.size() : 0) + (queued ? queued->samples.size() : 0)) * sizeof(float);
    }

    std::shared_ptr<PcmClip> block(Cursor& next) {
        auto output = std::make_shared<PcmClip>();
        output->rate = 48000;
        output->channels = 2;
        output->priority = 200;
        constexpr std::size_t frames = 24000;
        output->samples.reserve(frames * 2);
        std::size_t written = 0;
        while (written < frames) {
            auto& source = reader(next.file);
            const auto end = loop && loop_end > 0
                                 ? std::clamp(std::round(loop_end * source.rate()), 1., double(source.frames()))
                                 : double(source.frames());
            const auto begin = loop ? std::clamp(std::round(loop_start * source.rate()), 0., end - 1) : 0.;
            if (next.frame >= end - 1e-7) {
                const auto over = std::max(0., next.frame - end) / source.rate();
                next.file = loop ? 0 : choose();
                next.frame = (loop ? begin : 0) + over * reader(next.file).rate();
                continue;
            }
            const auto step = double(source.rate()) / output->rate;
            const auto take = std::min(
                frames - written, std::max(std::size_t(1), std::size_t(std::ceil((end - next.frame) / step - 1e-9))));
            for (std::size_t i = 0; i < take; ++i) {
                const auto phase = next.frame + double(i) * step;
                const auto first = std::size_t(std::floor(std::min(phase, end - 1e-7)));
                const auto needed = std::min(first + 1, source.frames() - 1);
                if (window_file != next.file || first < window_first || needed >= window_first + window.frames()) {
                    window = source.read(first, std::min(source.frames() - first, std::size_t(source.rate() / 2 + 2)));
                    window_file = next.file;
                    window_first = first;
                }
                const auto fraction = std::clamp(phase - double(first), 0., 1.);
                for (unsigned channel = 0; channel < 2; ++channel) {
                    const auto c = std::min(channel, source.channels() - 1);
                    const auto a = window.samples[(first - window_first) * source.channels() + c];
                    float b = a;
                    if (double(first + 1) < end)
                        b = window.samples[(first + 1 - window_first) * source.channels() + c];
                    else if (loop) {
                        if (!have_loop_first) {
                            const auto sample = source.read(std::size_t(begin), 1);
                            for (unsigned j = 0; j < 2; ++j)
                                loop_first[j] = sample.samples[std::min(j, source.channels() - 1)];
                            have_loop_first = true;
                        }
                        b = loop_first[channel];
                    }
                    output->samples.push_back(float(a * (1 - fraction) + b * fraction));
                }
            }
            written += take;
            next.frame += double(take) * step;
        }
        return output;
    }

    void service() {
        std::lock_guard serial(service_mutex);
        const auto rev = revision.load();
        if (applied != rev || !wanted) {
            std::lock_guard lock(control);
            stop();
            failed = false;
            applied = rev;
            if (!wanted)
                return;
        }
        if (failed)
            return;
        try {
            if (voice) {
                const auto status = mixer.status(voice);
                if (!status) {
                    std::lock_guard lock(control);
                    stop();
                } else if (status->generation != generation) {
                    current = std::move(queued);
                    generation = status->generation;
                    account();
                }
            }
            const auto valid = [&] { return revision == rev && wanted.load(); };
            VoiceParams params;
            params.role = role;
            params.gain = volume;
            if (!voice) {
                auto after = Cursor{loop ? 0 : choose(), 0};
                auto clip = block(after);
                std::lock_guard lock(control);
                if (!valid())
                    return;
                voice = mixer.play(clip, params);
                current = std::move(clip);
                cursor = after;
                account();
            }
            if (!queued) {
                auto after = cursor;
                auto clip = block(after);
                std::lock_guard lock(control);
                if (!valid())
                    return;
                if (mixer.queue(voice, clip, params, generation)) {
                    queued = std::move(clip);
                    cursor = after;
                    account();
                }
            }
        } catch (const std::exception& e) {
            std::lock_guard lock(control);
            stop();
            failed = true;
            std::cerr << "Music stream unavailable: " << e.what() << '\n';
        }
    }
};

MusicStream::MusicStream(AudioMixer& mixer, std::vector<std::filesystem::path> files, AudioRole role, bool loop,
                         double start, double end, double volume)
    : data_(std::make_unique<Data>(mixer, std::move(files), role, loop, start, end, volume)) {}

MusicStream::~MusicStream() { data_->mixer.stop(data_->voice); }

void MusicStream::playing(bool value) { data_->wanted = value; }

void MusicStream::restart() {
    std::lock_guard lock(data_->control);
    ++data_->revision;
    data_->mixer.stop(data_->voice);
}

void MusicStream::service() { data_->service(); }

std::size_t MusicStream::bytes() const { return data_->decoded; }
} // namespace openslope
