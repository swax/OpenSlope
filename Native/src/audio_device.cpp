#include "audio_device.hpp"
#include <atomic>
#include <stdexcept>
#include <thread>
#if defined(_WIN32)
#include <windows.h>
#include <mmreg.h>
#include <mmsystem.h>
#elif defined(__ANDROID__)
#include <aaudio/AAudio.h>
#endif

namespace openslope {
struct AudioDevice::Data {
    AudioMixer& mixer;
    std::atomic<std::uint64_t> frames{0};
    std::atomic<bool> running{false};
#if defined(_WIN32)
    HWAVEOUT output{};
    HANDLE event{};
    std::thread worker;

    struct Buffer {
        std::array<float, 1024> pcm{};
        WAVEHDR header{};
        bool prepared = false;
    };

    std::array<Buffer, 4> buffers;

    explicit Data(AudioMixer& source) : mixer(source) {
        event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        if (!event)
            return;
        WAVEFORMATEX format{};
        format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
        format.nChannels = 2;
        format.nSamplesPerSec = mixer.rate();
        format.wBitsPerSample = 32;
        format.nBlockAlign = 8;
        format.nAvgBytesPerSec = format.nSamplesPerSec * 8;
        if (waveOutOpen(&output, WAVE_MAPPER, &format, reinterpret_cast<DWORD_PTR>(event), 0, CALLBACK_EVENT) !=
            MMSYSERR_NOERROR) {
            CloseHandle(event);
            event = nullptr;
            return;
        }
        for (auto& buffer : buffers) {
            buffer.header.lpData = reinterpret_cast<LPSTR>(buffer.pcm.data());
            buffer.header.dwBufferLength = DWORD(buffer.pcm.size() * sizeof(float));
            if (waveOutPrepareHeader(output, &buffer.header, sizeof(WAVEHDR)) != MMSYSERR_NOERROR) {
                close();
                return;
            }
            buffer.prepared = true;
        }
        running = true;
        worker = std::thread([this] {
            while (running) {
                bool wrote = false;
                for (auto& buffer : buffers)
                    if (!(buffer.header.dwFlags & WHDR_INQUEUE)) {
                        mixer.render(buffer.pcm);
                        if (waveOutWrite(output, &buffer.header, sizeof(WAVEHDR)) != MMSYSERR_NOERROR) {
                            running = false;
                            break;
                        }
                        frames += buffer.pcm.size() / 2;
                        wrote = true;
                    }
                if (!wrote)
                    WaitForSingleObject(event, 20);
            }
        });
    }

    void close() {
        running = false;
        if (event)
            SetEvent(event);
        if (worker.joinable())
            worker.join();
        if (output) {
            waveOutReset(output);
            for (auto& buffer : buffers)
                if (buffer.prepared)
                    waveOutUnprepareHeader(output, &buffer.header, sizeof(WAVEHDR));
            waveOutClose(output);
            output = nullptr;
        }
        if (event) {
            CloseHandle(event);
            event = nullptr;
        }
    }

    ~Data() { close(); }
#elif defined(__ANDROID__)
    AAudioStream* stream{};

    static aaudio_data_callback_result_t render(AAudioStream*, void* context, void* output, int32_t count) {
        auto& data = *static_cast<Data*>(context);
        if (!data.running)
            return AAUDIO_CALLBACK_RESULT_STOP;
        data.mixer.render(std::span(static_cast<float*>(output), std::size_t(count) * 2));
        data.frames += std::uint64_t(count);
        return AAUDIO_CALLBACK_RESULT_CONTINUE;
    }

    static void error(AAudioStream*, void* context, aaudio_result_t) { static_cast<Data*>(context)->running = false; }

    explicit Data(AudioMixer& source) : mixer(source) {
        AAudioStreamBuilder* builder{};
        if (AAudio_createStreamBuilder(&builder) != AAUDIO_OK)
            return;
        AAudioStreamBuilder_setDirection(builder, AAUDIO_DIRECTION_OUTPUT);
        AAudioStreamBuilder_setUsage(builder, AAUDIO_USAGE_GAME);
        AAudioStreamBuilder_setFormat(builder, AAUDIO_FORMAT_PCM_FLOAT);
        AAudioStreamBuilder_setChannelCount(builder, 2);
        AAudioStreamBuilder_setSampleRate(builder, int32_t(mixer.rate()));
        AAudioStreamBuilder_setPerformanceMode(builder, AAUDIO_PERFORMANCE_MODE_LOW_LATENCY);
        AAudioStreamBuilder_setSharingMode(builder, AAUDIO_SHARING_MODE_SHARED);
        AAudioStreamBuilder_setDataCallback(builder, render, this);
        AAudioStreamBuilder_setErrorCallback(builder, error, this);
        const auto result = AAudioStreamBuilder_openStream(builder, &stream);
        AAudioStreamBuilder_delete(builder);
        if (result != AAUDIO_OK || !stream)
            return;
        if (AAudioStream_getChannelCount(stream) != 2 || unsigned(AAudioStream_getSampleRate(stream)) != mixer.rate() ||
            AAudioStream_getFormat(stream) != AAUDIO_FORMAT_PCM_FLOAT) {
            AAudioStream_close(stream);
            stream = nullptr;
            return;
        }
        running = true;
        if (AAudioStream_requestStart(stream) != AAUDIO_OK)
            running = false;
    }

    ~Data() {
        running = false;
        if (stream) {
            AAudioStream_requestStop(stream);
            AAudioStream_close(stream);
        }
    }
#else
    explicit Data(AudioMixer& source) : mixer(source) {}
#endif
};

AudioDevice::AudioDevice(AudioMixer& mixer) : data_(std::make_unique<Data>(mixer)) {}

AudioDevice::~AudioDevice() = default;

bool AudioDevice::active() const { return data_->running; }

std::uint64_t AudioDevice::frames() const { return data_->frames; }

struct AudioService::Data {
    AudioScene& scene;
    std::atomic<bool> running{true};
    std::thread worker;

    explicit Data(AudioScene& value)
        : scene(value), worker([this] {
              while (running) {
                  scene.service();
                  std::this_thread::sleep_for(std::chrono::milliseconds(10));
              }
          }) {}

    ~Data() {
        running = false;
        if (worker.joinable())
            worker.join();
    }
};

AudioService::AudioService(AudioScene& scene) : data_(std::make_unique<Data>(scene)) {}

AudioService::~AudioService() = default;
} // namespace openslope
