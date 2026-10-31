#include "import/hash.hpp"
#include "import/music_cache.hpp"
#include "openslope/import.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <map>

namespace {
void check(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(message);
}

void write(const std::filesystem::path& path, const std::string& text) {
    std::filesystem::create_directories(path.parent_path());
    std::ofstream file(path, std::ios::binary);
    file << text;
}

std::map<std::string, std::string> files(const std::filesystem::path& root) {
    std::map<std::string, std::string> result;
    if (!std::filesystem::exists(root))
        return result;
    for (const auto& file : std::filesystem::recursive_directory_iterator(root))
        if (file.is_regular_file()) {
            std::ifstream input(file.path(), std::ios::binary);
            const std::string text{std::istreambuf_iterator<char>(input), {}};
            openslope::import_detail::Sha256 hash;
            hash.add(text);
            result[std::filesystem::relative(file.path(), root).generic_string()] = hash.finish();
        }
    return result;
}

void cache_checks(const std::filesystem::path& root) {
    using namespace openslope::import_detail;
    Sha256 empty;
    check(empty.finish() == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "SHA-256 empty vector");
    Sha256 abc;
    abc.add("a");
    abc.add("bc");
    check(abc.finish() == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
          "SHA-256 incremental vector");
    Sha256 large;
    for (unsigned i = 0; i < 100000; ++i)
        large.add("aaaaaaaaaa");
    check(large.finish() == "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
          "SHA-256 block boundaries");
    const auto key = music_key("codec-v1", "48000", {});
    check(key != music_key("codec-v2", "48000", {}) && key != music_key("codec-v1", "22050", {}),
          "Converter and settings must invalidate music");
    auto context = std::make_shared<ImportContext>();
    context->music_root = root / "cache";
    openslope::DiscInput disc{0, {}, context};
    unsigned decoded = 0;
    const auto convert = [&](const auto& out) {
        cached_music(disc, key, out,
                     [&] {
                         ++decoded;
                         write(out / "nested/clip.wav", "fixture audio");
                     },
                     {});
    };
    convert(root / "one");
    convert(root / "two");
    check(decoded == 1 && context->stats.music_hits == 1, "A second map must reuse converted music");
    check(files(root / "one") == files(root / "two"), "Cached files must equal freshly converted files");
    write(context->music_root / key / "files/nested/clip.wav", "corrupt audio");
    convert(root / "three");
    check(decoded == 2, "A damaged cache file must be decoded again");
    const auto escaped = root / "outside.wav";
    write(escaped, "keep me");
    write(context->music_root / key / "manifest.json",
          nlohmann::json{{"Version", 1},
                         {"Key", key},
                         {"Bytes", 7},
                         {"Files", {{{"Path", "../../outside.wav"}, {"Bytes", 7}, {"Hash", std::string(64, 'a')}}}}}
              .dump());
    convert(root / "four");
    check(decoded == 3 && std::filesystem::file_size(escaped) == 7, "Cache paths must stay inside their entry");
    const auto cancelled = music_key("cancelled", "", {});
    bool stop = false, failed = false;
    try {
        cached_music(
            disc, cancelled, root / "cancelled",
            [&] {
                write(root / "cancelled/a.wav", "unfinished");
                stop = true;
            },
            [&] { return stop; });
    } catch (const std::exception&) {
        failed = true;
    }
    check(failed && !std::filesystem::exists(context->music_root / cancelled), "Cancelled music must not be published");
    context->music_limit = 13;
    std::filesystem::last_write_time(context->music_root / key,
                                     std::filesystem::file_time_type::clock::now() - std::chrono::minutes(10));
    const auto other = music_key("another-track", "", {});
    cached_music(disc, other, root / "evicted", [&] { write(root / "evicted/clip.wav", "fixture audio"); }, {});
    check(!std::filesystem::exists(context->music_root / key) && std::filesystem::exists(context->music_root / other),
          "Old cache entries must be evicted within the byte budget");
    check(files(root / "one") == files(root / "two"), "Eviction must not change installed maps");
    write(root / "unavailable", "file");
    context->music_root = root / "unavailable";
    convert(root / "fallback");
    check(std::filesystem::is_regular_file(root / "fallback/nested/clip.wav"),
          "Unavailable caches must not prevent import");
}
} // namespace

int main(int argc, char** argv) {
    try {
        if (argc == 1) {
            const auto root = std::filesystem::temp_directory_path() /
                              ("openslope-cache-check-" +
                               std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
            check(std::filesystem::create_directory(root), "Cannot create isolated cache check");

            struct Cleanup {
                std::filesystem::path root;

                ~Cleanup() {
                    std::error_code ec;
                    std::filesystem::remove_all(root, ec);
                }
            } cleanup{root};

            cache_checks(root);
            std::cout << "PASS: music identity, corruption recovery, atomic cancellation and optional cache failures\n";
            return 0;
        }
        if (argc != 4)
            throw std::runtime_error("Expected image, output directory and music track count");
        const std::filesystem::path image = argv[1], root = argv[2];
        const auto count = std::stoul(argv[3]);
        std::filesystem::create_directories(root);
        openslope::ImportSession session(openslope::open_disc(image), root / "cache");
        const auto catalogue = session.courses();
        check(!catalogue.empty(), "Missing source courses");
        const auto reads = session.stats().source_reads;
        session.courses();
        check(session.stats().source_reads == reads && session.stats().scans == 1, "Course scans must be reused");
        const auto plan = nlohmann::json::parse(session.music_plan(catalogue[0].name));
        check(plan.size() == count && session.stats().music_misses == 0, "Planning must not decode music");
        session.extract(catalogue[0].name, root / "cold");
        const auto alternate = count && catalogue.size() > 1 ? catalogue[1].name : catalogue[0].name;
        session.extract(alternate, root / "warm");
        const auto stats = session.stats();
        check(stats.scans == 1 && stats.extractions == 2 && stats.read_hits > 0,
              "Disc reads and metadata must survive between maps");
        check(stats.music_misses == count && stats.music_hits == count,
              "Music must be converted once per source track");
        check(files(root / "cold/Audio/Music") == files(root / "warm/Audio/Music"),
              "Shared music must remain byte-identical between maps");
        openslope::ImportSession reopened(openslope::open_disc(image), root / "cache");
        reopened.extract(catalogue[0].name, root / "reopened");
        check(reopened.stats().music_hits == count && reopened.stats().music_misses == 0,
              "Music cache must survive closing the import session");
        check(files(root / "cold") == files(root / "reopened"), "Persistent reuse must preserve standalone map output");
        std::cout << nlohmann::json{{"courses", catalogue.size()},   {"scans", stats.scans},
                                    {"readHits", stats.read_hits},   {"musicMisses", stats.music_misses},
                                    {"musicHits", stats.music_hits}, {"persistentHits", reopened.stats().music_hits}}
                         .dump()
                  << '\n';
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
