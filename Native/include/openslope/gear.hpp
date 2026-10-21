#pragma once
#include "terrain.hpp"
#include <string_view>

namespace openslope {
inline constexpr unsigned stock_board_count = 4;

struct StockBoardInfo {
    std::string_view id, name;
    std::uint32_t edge;
};

const StockBoardInfo& stock_board_info(unsigned index);
unsigned random_stock_board(unsigned previous = stock_board_count);
struct RgbaImage;
RgbaImage stock_board_image(unsigned index);
// Baked first-party stock art; no authoring runtime is linked by the player.
const Mesh& snowboard_mesh();
const Mesh& touch_plus_mesh();
} // namespace openslope
