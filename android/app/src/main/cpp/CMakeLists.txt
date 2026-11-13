# Offline speech-to-text fallback (WhisperEngine.java): whisper.cpp, built into libhm_whisper.so for arm64 phones.
# Used only when Android's on-device recogniser has no pack for the language (Bangla on many phones). The audio and
# the text never leave the phone; the model file is downloaded once and checked against its SHA-256 (WhisperModels).
#
# whisper.cpp is fetched at build time, pinned to a release and its archive's SHA-256 (MIT licence).
cmake_minimum_required(VERSION 3.22)
project(hm_whisper C CXX)

set(CMAKE_CXX_STANDARD 17)
# Always optimised, also in the debug (lab) build: unoptimised whisper is many times slower and would skew timings.
set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
include(FetchContent)

set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(WHISPER_CURL OFF CACHE BOOL "" FORCE)
set(WHISPER_SDL2 OFF CACHE BOOL "" FORCE)
set(WHISPER_ALL_WARNINGS OFF CACHE BOOL "" FORCE)
# The math library is built once per ARM generation (v8.0 … v9.2: dot product, FP16, int8 matmul, SVE) as
# libggml-cpu-android_*.so; at run time ggml loads the best one this phone's CPU supports (WhisperEngine passes the
# app's native library folder). A plain v8.0 build runs everywhere but is several times slower on modern phones.
set(BUILD_SHARED_LIBS ON CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_BACKEND_DL ON CACHE BOOL "" FORCE)
set(GGML_CPU_ALL_VARIANTS ON CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_LLAMAFILE OFF CACHE BOOL "" FORCE)

FetchContent_Declare(
    whispercpp
    URL https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.5.tar.gz
    URL_HASH SHA256=ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720
)
FetchContent_MakeAvailable(whispercpp)

add_library(hm_whisper SHARED hm_whisper.cpp)
target_link_libraries(hm_whisper PRIVATE whisper ggml log)
target_compile_options(hm_whisper PRIVATE -O3 -fvisibility=hidden)
target_link_options(hm_whisper PRIVATE -Wl,--gc-sections -Wl,--exclude-libs,ALL)
