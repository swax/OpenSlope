# Native build dependencies

Source dependencies are downloaded from pinned upstream archives, verified by SHA-256, and
compiled locally. macOS also downloads the checksum-pinned official MoltenVK runtime binary.
Complete license texts are retained here and should accompany binaries.
Repository-authored GLSL is compiled to SPIR-V during the host build; glslang itself is a build tool,
not linked into the player. No upstream game-format decoder is linked into this prototype.

| Dependency | Pinned release | Terms | Use |
|---|---|---|---|
| [nlohmann/json](https://github.com/nlohmann/json) | 3.12.0 | MIT | Map JSON and shared ride contract. |
| [Zstandard](https://github.com/facebook/zstd) | 1.5.7 | BSD 3-Clause; see zstd.txt | Portable RVZ block decompression. |
| [Opus](https://opus-codec.org/) | 1.6.1 | BSD 3-Clause and patent grant; see opus.txt | Reference music encoding in the browser worker and portable music decoding. |
| [minimp3](https://github.com/lieff/minimp3) | ea99364f61c14656440e8d77e9c233ccf3124633 | CC0-1.0; see minimp3.txt | Standard MPEG Layer III decoding after independently authored audio framing. |
| [LodePNG](https://github.com/lvandeve/lodepng) | ed6fe5825c6a4fbb7f58ab35a4231c7543cd452a | zlib-style license; see lodepng.txt | Standalone bounded PNG decoding to RGBA8. Encoder, disk helpers and ancillary metadata processing are disabled. |
| [stb_image](https://github.com/nothings/stb) | f0569113c93ad095470c54bf34a17b36646bbbb5 | MIT / public domain; see stb.txt | Bounded memory-only JPEG decoding for embedded avatar textures. |
| [Vulkan-Headers](https://github.com/KhronosGroup/Vulkan-Headers) | 1.4.309 | Apache-2.0 / MIT | Vulkan API declarations. |
| [volk](https://github.com/zeux/volk) | vulkan-sdk-1.4.309.0 | MIT | Platform Vulkan function loading. |
| [OpenXR-SDK](https://github.com/KhronosGroup/OpenXR-SDK) | 1.1.53 | Apache-2.0 | Khronos OpenXR loader and API declarations. |
| [SDL3](https://github.com/libsdl-org/SDL) | 3.2.10 | zlib; see sdl3.txt | Shared desktop windows, input, file dialogs and Unix audio output. Statically linked. |
| [MoltenVK](https://github.com/KhronosGroup/MoltenVK) | 1.3.0 | Apache-2.0; see moltenvk.txt | Checksum-pinned official macOS runtime, bundled in the Mac application. |
| JsonCpp, included by OpenXR-SDK | SDK-pinned copy | MIT / public domain | Loader JSON parsing. |
| Android JNI wrappers, included by OpenXR-SDK | SDK-pinned copy | BSL-1.0 | Android loader integration; copyright Collabora, Ltd. |
| jnipp, included by OpenXR-SDK | SDK-pinned copy | MIT | Android loader integration. |
| [glslang](https://github.com/KhronosGroup/glslang) | 15.1.0 | Upstream BSD / MIT-style terms | Build-time shader compiler; complete composite license is retained. |
| Android NDK runtime and NativeActivity glue | 28.1.13356709 | SDK composite notices; Apache-2.0 glue and LLVM C++ runtime terms | ARM64 C++ runtime and Android entry point. Complete NDK notices are retained under `android-ndk/`. |

Windows/Linux/Android Vulkan implementations and OpenXR runtimes are supplied by the
operating system/device. The macOS package includes the official MoltenVK runtime.
Android Gradle Plugin, Gradle, Android SDK/NDK, and JDK are
external build prerequisites. Their distributions are not vendored here.
The NDK's composite notices also describe tools and optional components not linked into this
player; including those notices does not change the repository-authored code's license.
