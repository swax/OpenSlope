# Native build dependencies

Dependencies are downloaded from pinned upstream source archives, verified by SHA-256, and
compiled locally. Their complete license texts are retained here and should accompany binaries.
Repository-authored GLSL is compiled to SPIR-V during the host build; glslang itself is a build tool,
not linked into the player. No upstream game-format decoder is linked into this prototype.

| Dependency | Pinned release | Terms | Use |
|---|---|---|---|
| [nlohmann/json](https://github.com/nlohmann/json) | 3.12.0 | MIT | Map JSON and shared ride contract. |
| [LodePNG](https://github.com/lvandeve/lodepng) | ed6fe5825c6a4fbb7f58ab35a4231c7543cd452a | zlib-style license; see lodepng.txt | Standalone bounded PNG decoding to RGBA8. Encoder, disk helpers and ancillary metadata processing are disabled. |
| [Vulkan-Headers](https://github.com/KhronosGroup/Vulkan-Headers) | 1.4.309 | Apache-2.0 / MIT | Vulkan API declarations. |
| [volk](https://github.com/zeux/volk) | vulkan-sdk-1.4.309.0 | MIT | Platform Vulkan function loading. |
| [OpenXR-SDK](https://github.com/KhronosGroup/OpenXR-SDK) | 1.1.53 | Apache-2.0 | Khronos OpenXR loader and API declarations. |
| JsonCpp, included by OpenXR-SDK | SDK-pinned copy | MIT / public domain | Loader JSON parsing. |
| Android JNI wrappers, included by OpenXR-SDK | SDK-pinned copy | BSL-1.0 | Android loader integration; copyright Collabora, Ltd. |
| jnipp, included by OpenXR-SDK | SDK-pinned copy | MIT | Android loader integration. |
| [glslang](https://github.com/KhronosGroup/glslang) | 15.1.0 | Upstream BSD / MIT-style terms | Build-time shader compiler; complete composite license is retained. |
| Android NDK runtime and NativeActivity glue | 28.1.13356709 | SDK composite notices; Apache-2.0 glue and LLVM C++ runtime terms | ARM64 C++ runtime and Android entry point. Complete NDK notices are retained under `android-ndk/`. |

The Vulkan implementation and OpenXR runtime are supplied by the operating system/device and are
not copied into OpenSlope releases. Android Gradle Plugin, Gradle, Android SDK/NDK, and JDK are
external build prerequisites. Their distributions are not vendored here.
The NDK's composite notices also describe tools and optional components not linked into this
player; including those notices does not change the repository-authored code's license.
