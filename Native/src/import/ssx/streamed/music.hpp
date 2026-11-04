#pragma once
#include "import/shared.hpp"
#include "openslope/music.hpp"

namespace openslope::import_detail {
MusicGraph ssx3_main_music(Bytes source, const ImportCancel& cancel);

struct OnTourMusicSong {
    MusicGraph graph;
    std::size_t source_end{};
};

OnTourMusicSong ontour_jukebox_music(Bytes source, std::uint32_t stream_id, std::size_t stream_bytes, unsigned section,
                                     const ImportCancel& cancel);
} // namespace openslope::import_detail
