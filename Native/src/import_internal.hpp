#pragma once
#include "openslope/import.hpp"
#include <bit>
#include <cmath>
#include <map>
#include <stdexcept>

namespace openslope::import_detail {
struct Bytes {
    std::span<const std::uint8_t> data;

    void range(std::size_t offset, std::size_t length) const {
        if (offset > data.size() || length > data.size() - offset)
            throw std::runtime_error("Truncated course data: offset " + std::to_string(offset) + ", length " +
                                     std::to_string(length) + ", extent " + std::to_string(data.size()));
    }

    std::uint32_t le(std::size_t offset, unsigned width = 4) const {
        range(offset, width);
        std::uint32_t v = 0;
        for (unsigned i = 0; i < width; ++i)
            v |= std::uint32_t(data[offset + i]) << (8 * i);
        return v;
    }

    std::uint32_t be(std::size_t offset, unsigned width = 4) const {
        range(offset, width);
        std::uint32_t v = 0;
        for (unsigned i = 0; i < width; ++i)
            v = (v << 8) | data[offset + i];
        return v;
    }

    int signed16(std::size_t offset) const { return static_cast<std::int16_t>(le(offset, 2)); }

    float number(std::size_t offset) const {
        const auto v = std::bit_cast<float>(le(offset));
        if (!std::isfinite(v))
            throw std::runtime_error("Non-finite number in course data");
        return v;
    }

    std::string text(std::size_t offset, std::size_t length) const {
        range(offset, length);
        return {reinterpret_cast<const char*>(data.data() + offset), length};
    }
};

struct Image {
    std::string name;
    unsigned width{}, height{};
    std::vector<std::uint8_t> rgba;
};

void ssx_header(std::span<const std::uint8_t> index);
void write_ssx_course(const DiscInput& disc, const std::map<std::string, std::vector<std::uint8_t>>& files,
                      const std::string& course, const std::filesystem::path& output, const ImportProgress& progress,
                      const ImportCancel& cancel);
bool write_ssx_props(std::span<const std::uint8_t> index, std::span<const std::uint8_t> models,
                     std::span<const std::uint8_t> instances, const std::vector<Image>& textures,
                     const std::filesystem::path& output, const ImportCancel& cancel);
std::string patch_document(std::span<const std::uint8_t> records, const std::vector<std::string>& names,
                           const std::vector<Image>& images, bool original = false);

void write_crowd(std::span<const std::uint8_t> source, const std::filesystem::path& root,
                 const ImportCancel& cancel = {});
std::vector<Image> decode_ssh(std::span<const std::uint8_t> bytes, bool lightmap, const ImportCancel& cancelled,
                              bool particle = false, bool original = false);
void write_png(const std::filesystem::path& path, const Image& image);
std::string light_document(std::span<const std::uint8_t> geometry);
void write_paths(const std::vector<std::uint8_t>& bytes, const std::filesystem::path& output,
                 const ImportCancel& cancelled);
void write_collision(const std::vector<std::uint8_t>& bytes, const std::filesystem::path& output,
                     const ImportCancel& cancelled, bool original = false);
std::string logic_document(std::span<const std::uint8_t> bytes, const std::string& course,
                           const ImportCancel& cancelled = {});
void write_logic(const std::vector<std::uint8_t>& bytes, const std::filesystem::path& output, const std::string& course,
                 const ImportCancel& cancelled);
void write_rails(const std::vector<std::uint8_t>& geometry, const std::vector<std::uint8_t>& linker,
                 const std::vector<std::uint8_t>* behavior, const std::filesystem::path& output,
                 const ImportCancel& cancelled);
std::vector<std::vector<std::uint32_t>> material_frame_indices(std::span<const std::uint8_t> source);
void write_props(const std::vector<std::uint8_t>& pbd, const std::vector<std::uint8_t>& linker,
                 const std::vector<Image>& textures, const std::vector<std::uint8_t>* behavior,
                 const std::filesystem::path& output, const ImportCancel& cancelled, bool anonymous = false);
bool write_course_audio(const DiscInput& disc, const std::string& course,
                        const std::map<std::string, std::vector<std::uint8_t>>& files,
                        const std::filesystem::path& output, const ImportProgress& progress,
                        const ImportCancel& cancelled);

inline void check_cancel(const ImportCancel& cancelled) {
    if (cancelled && cancelled())
        throw std::runtime_error("Import cancelled");
}
} // namespace openslope::import_detail
