# web — browser build of the Engine profile (rbx_runtime) + native test CLI.
#
# One project, two toolchains:
#
#   WebAssembly (needs Emscripten on PATH; developed and tested on 4.0.23):
#       emcmake cmake -S web -B web/build-wasm -DCMAKE_BUILD_TYPE=Release
#       cmake --build web/build-wasm -j
#     -> web/dist/boblox_engine.mjs + boblox_engine.wasm
#
#   Native (any C++17 compiler) — the reference the WASM build is diffed against:
#       cmake -S web -B web/build-native -DCMAKE_BUILD_TYPE=Release
#       cmake --build web/build-native -j
#     -> web/build-native/boblox_cli
#
# or just run ./web/build.sh. Only the Engine profile is built: Luau + the
# Roblox API/Instance world (rbx_runtime). Nothing from client/ — no networking,
# session, or 0x9B challenge code — is part of this project, and rbx_runtime's
# challenge runner (runner.cpp) is not referenced, so the linker drops it.
cmake_minimum_required(VERSION 3.16)
project(boblox_web CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

get_filename_component(BOBLOX_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)

if(EMSCRIPTEN)
    # Luau reports errors by throwing C++ exceptions (luaL_error unwinds the
    # engine's RAII frames), so exceptions must be real. Two flavours:
    #   wasm (default): native WebAssembly exception handling. Fast and small;
    #                   supported by every engine since 2022 (Chrome 95,
    #                   Firefox 100, Safari 15.2, Node 17).
    #   js:             Emscripten's JS-based exceptions. Works anywhere WASM
    #                   does, at some cost per protected call.
    set(BOBLOX_WASM_EXCEPTIONS "wasm" CACHE STRING "Exception handling: wasm | js")
    set_property(CACHE BOBLOX_WASM_EXCEPTIONS PROPERTY STRINGS wasm js)
    if(BOBLOX_WASM_EXCEPTIONS STREQUAL "wasm")
        set(_eh_flag -fwasm-exceptions)
    elseif(BOBLOX_WASM_EXCEPTIONS STREQUAL "js")
        set(_eh_flag -fexceptions)
    else()
        message(FATAL_ERROR "BOBLOX_WASM_EXCEPTIONS must be 'wasm' or 'js'")
    endif()
    # Directory-wide, BEFORE add_subdirectory: Luau and the engine must agree.
    add_compile_options(${_eh_flag})
    add_link_options(${_eh_flag})
endif()

# The engine. EXCLUDE_FROM_ALL keeps rbx_runtime's CLI (challenge_runner) out
# of this build; only challenge_core's objects we actually reference are linked.
add_subdirectory("${BOBLOX_ROOT}/rbx_runtime" rbx_runtime EXCLUDE_FROM_ALL)

add_library(boblox_engine STATIC src/boblox.cpp)
target_include_directories(boblox_engine PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(boblox_engine PUBLIC challenge_core)
target_compile_options(boblox_engine PRIVATE -O2)

if(EMSCRIPTEN)
    set(BOBLOX_DIST "${CMAKE_CURRENT_SOURCE_DIR}/dist" CACHE PATH "Where the .mjs/.wasm land")

    add_executable(boblox_wasm src/boblox_wasm.cpp)
    target_link_libraries(boblox_wasm PRIVATE boblox_engine)
    set_target_properties(boblox_wasm PROPERTIES
        OUTPUT_NAME boblox_engine
        SUFFIX ".mjs"
        RUNTIME_OUTPUT_DIRECTORY "${BOBLOX_DIST}")

    target_link_options(boblox_wasm PRIVATE
        --no-entry
        -sMODULARIZE=1
        -sEXPORT_ES6=1
        -sEXPORT_NAME=createBobloxModule
        -sENVIRONMENT=web,worker,node
        -sALLOW_MEMORY_GROWTH=1
        -sINITIAL_MEMORY=33554432
        -sMAXIMUM_MEMORY=1073741824
        -sSTACK_SIZE=4194304
        -sFILESYSTEM=0
        "-sEXPORTED_FUNCTIONS=_malloc,_free"
        "-sEXPORTED_RUNTIME_METHODS=UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPF64"
        $<$<CONFIG:Debug>:-sASSERTIONS=2>
        $<$<CONFIG:Debug>:-sSAFE_HEAP=1>
        $<$<CONFIG:Debug>:-sSTACK_OVERFLOW_CHECK=2>
        $<$<NOT:$<CONFIG:Debug>>:-O2>)
else()
    add_executable(boblox_cli src/boblox_cli.cpp)
    target_link_libraries(boblox_cli PRIVATE boblox_engine)
endif()
