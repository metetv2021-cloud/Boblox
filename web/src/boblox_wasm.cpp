// boblox_wasm.cpp — the Emscripten C ABI over boblox::Engine.
//
// Deliberately tiny and stringly-typed: JS (web/js/boblox.mjs) owns all the
// ergonomics. Conventions:
//   * a handle is an opaque pointer; any number of engines may coexist;
//   * strings in: (pointer, byte length) — Lua source may contain NULs;
//   * strings out: NUL-terminated JSON owned by the handle, valid until the
//     next call that returns a string for that handle;
//   * nothing throws across the boundary — failures return null / 0.
#include "boblox.h"

#include <emscripten/emscripten.h>

#include <new>
#include <string>
#include <vector>

namespace {

struct Handle {
    boblox::Engine engine;
    std::string out;      // backing store for returned strings
    size_t parts_len = 0; // doubles produced by the latest boblox_parts()
};

Handle* H(void* h) {
    return static_cast<Handle*>(h);
}

const char* give(Handle* h, std::string s) {
    h->out = std::move(s);
    return h->out.c_str();
}

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE void* boblox_create() {
    try {
        return new Handle();
    } catch (...) {
        return nullptr;
    }
}

EMSCRIPTEN_KEEPALIVE void boblox_destroy(void* h) {
    try {
        delete H(h);
    } catch (...) {
    }
}

// 1 = script started cleanly, 0 = compile/runtime error (details via drain).
EMSCRIPTEN_KEEPALIVE int boblox_run(void* h, const char* src, int src_len, const char* chunk,
                                    int chunk_len) {
    try {
        return H(h)->engine.run(std::string(src, (size_t)src_len),
                                std::string(chunk, (size_t)chunk_len))
                   ? 1
                   : 0;
    } catch (...) {
        return 0;
    }
}

EMSCRIPTEN_KEEPALIVE int boblox_step(void* h, double dt) {
    try {
        return H(h)->engine.step(dt);
    } catch (...) {
        return -1;
    }
}

EMSCRIPTEN_KEEPALIVE double boblox_now(void* h) {
    return H(h)->engine.now();
}

EMSCRIPTEN_KEEPALIVE void boblox_set_time_limit_ms(void* h, int ms) {
    H(h)->engine.set_time_limit_ms(ms);
}

// Lua heap size in KiB / force a full collection.
EMSCRIPTEN_KEEPALIVE double boblox_memory_kb(void* h) {
    return (double)H(h)->engine.memory_kb();
}

EMSCRIPTEN_KEEPALIVE void boblox_gc(void* h) {
    try {
        H(h)->engine.collect_garbage();
    } catch (...) {
    }
}

EMSCRIPTEN_KEEPALIVE const char* boblox_drain(void* h) {
    try {
        return give(H(h), boblox::lines_to_json(H(h)->engine.drain_output()));
    } catch (...) {
        return nullptr;
    }
}

EMSCRIPTEN_KEEPALIVE const char* boblox_tree(void* h) {
    try {
        return give(H(h), H(h)->engine.tree_json());
    } catch (...) {
        return nullptr;
    }
}

EMSCRIPTEN_KEEPALIVE const char* boblox_props(void* h, unsigned id) {
    try {
        return give(H(h), H(h)->engine.properties_json(id));
    } catch (...) {
        return nullptr;
    }
}

// Refreshes the part buffer; read `boblox_parts_count() * boblox_part_stride()`
// doubles at the returned address before the next call into this handle.
EMSCRIPTEN_KEEPALIVE const double* boblox_parts(void* h) {
    try {
        const std::vector<double>& parts = H(h)->engine.parts();
        H(h)->parts_len = parts.size();
        return parts.data();
    } catch (...) {
        H(h)->parts_len = 0;
        return nullptr;
    }
}

// Part count of the LAST boblox_parts() call (does not walk the tree again).
EMSCRIPTEN_KEEPALIVE int boblox_parts_count(void* h) {
    return (int)(H(h)->parts_len / (size_t)boblox::kPartStride);
}

EMSCRIPTEN_KEEPALIVE int boblox_part_stride() {
    return boblox::kPartStride;
}

EMSCRIPTEN_KEEPALIVE const char* boblox_profile() {
    return boblox::profile_name();
}

} // extern "C"
