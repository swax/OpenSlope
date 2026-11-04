#pragma once
#include "import/shared.hpp"
#include "openslope/music.hpp"

namespace openslope::import_detail {
MusicGraph ssx3_main_music(Bytes source, const ImportCancel& cancel);
}
