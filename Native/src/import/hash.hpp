#pragma once
#include <array>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>

namespace openslope::import_detail {
class Sha256 {
public:
    void add(std::span<const std::uint8_t> data);

    void add(std::string_view data) { add({reinterpret_cast<const std::uint8_t*>(data.data()), data.size()}); }

    std::string finish();

private:
    void block();
    std::array<std::uint32_t, 8> state_{0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    std::array<std::uint8_t, 64> buffer_{};
    std::uint64_t bytes_{};
    unsigned used_{};
};
} // namespace openslope::import_detail
