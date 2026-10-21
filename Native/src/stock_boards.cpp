#include "stock_boards.hpp"
#include "openslope/appearance.hpp"
#include "openslope/gear.hpp"
#include <array>
#include <random>
#include <stdexcept>

namespace openslope {
static_assert(std::size(bundled::stock_boards) == stock_board_count);

const StockBoardInfo& stock_board_info(unsigned index) {
    static const auto info = [] {
        std::array<StockBoardInfo, stock_board_count> result{};
        for (unsigned i = 0; i < stock_board_count; ++i) {
            const auto& art = bundled::stock_boards[i];
            result[i] = {art.id, art.name, art.edge};
        }
        return result;
    }();
    return info.at(index);
}

unsigned random_stock_board(unsigned previous) {
    // Cosmetic entropy is independent of gameplay/replay random streams.
    static thread_local std::mt19937 random(std::random_device{}());
    const bool replacing = previous < stock_board_count;
    auto choice = std::uniform_int_distribution<unsigned>(0, stock_board_count - 1 - unsigned(replacing))(random);
    if (replacing && choice >= previous)
        ++choice;
    return choice;
}

RgbaImage stock_board_image(unsigned index) {
    if (index >= stock_board_count)
        throw std::out_of_range("Invalid stock board design");
    return read_png(bundled::stock_boards[index].bytes);
}
} // namespace openslope
