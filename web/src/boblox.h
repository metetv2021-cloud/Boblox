// boblox.h — embedder facade over rbx_runtime's Engine profile, for hosts that
// should not touch Luau directly: the browser build (boblox_wasm.cpp) and the
// native CLI used for differential testing (boblox_cli.cpp). Both link this
// same file, so what the browser runs is exactly what the native suite checks.
//
// Scope: ENGINE profile only — the Roblox-flavored scripting environment
// (Instance tree, datatypes, signals, task scheduler on a virtual clock).
// Nothing here knows about networking, sessions, or the 0x9B challenge path.
//
// Threading: none. Every call must come from the thread that created the
// Engine (in the browser: one Worker or the main thread).
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace boblox {

// Where a line of output came from. The browser console colors by level.
enum class Level : int {
    Print = 0, // print(...)
    Warn = 1,  // warn(...)
    Error = 2, // uncaught script error / task error / timeout
};

struct Line {
    Level level = Level::Print;
    std::string text;
};

// Floats per part in Engine::parts() (see the layout comment there).
constexpr int kPartStride = 21;

class Engine {
  public:
    Engine();
    ~Engine();
    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    // Compile `source` (Luau; type annotations are accepted) and start it as a
    // script thread — task.spawn semantics, so a top-level task.wait() yields
    // into the scheduler instead of erroring. Returns false when the script
    // failed to compile or raised before its first yield; the error is also
    // queued as a Level::Error line. A script that yields and fails later
    // reports through step().
    bool run(const std::string& source, const std::string& chunk_name = "main");

    // Advance the virtual clock by `dt` seconds and resume everything due.
    // Returns the number of task resumes performed.
    int step(double dt);

    // Virtual time in seconds (sum of step() calls).
    double now() const;

    // Output produced since the previous call, in order.
    std::vector<Line> drain_output();

    // Size of the Lua heap in KiB (Luau's own allocations; C++-side instance
    // objects are not counted). collect_garbage() runs a full collection.
    // run() collects first when the heap is large, so an engine that just
    // survived an out-of-memory error can compile its next script.
    size_t memory_kb() const;
    void collect_garbage();

    // Wall-clock budget for ONE run()/step() call; the script is aborted with
    // "Script timeout: exhausted allowed execution time" once exceeded.
    // 0 disables the check (and its small interpreter overhead). Default 10000.
    void set_time_limit_ms(int ms);

    // ---- viewer support --------------------------------------------------
    // Both walks hold a strong reference to every instance they report so the
    // ids below stay valid (and dereferenceable) until the next walk.

    // The Workspace subtree as JSON:
    //   {"count":2,"truncated":false,"root":
    //       {"id":1,"c":"Workspace","n":"Workspace","ch":[{"id":2,"c":"Part","n":"Part","ch":[]}]}}
    // Ids are small integers, stable for the life of an instance. Very large
    // trees are cut off (truncated:true) after a fixed node budget.
    std::string tree_json();

    // Properties of one instance from the latest walk, as JSON:
    //   [{"n":"Anchored","t":"Bool","v":"false","ro":false}, ...]
    // Values are rendered with the engine's own tostring(). "null" for an id
    // that is not in the latest walk.
    std::string properties_json(uint32_t id);

    // Render data for every BasePart under Workspace, kPartStride doubles each:
    //   [0] id   [1] shape (0 ball, 1 block, 2 cylinder, 3 wedge)
    //   [2] transparency   [3..5] color r g b (0..1)   [6..8] size x y z
    //   [9..20] CFrame: x y z r00 r01 r02 r10 r11 r12 r20 r21 r22
    // The reference is valid until the next parts()/tree_json() call.
    const std::vector<double>& parts();

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

// Output lines as JSON: [{"l":0,"t":"hello"},{"l":2,"t":"main:1: boom"}]
// ("l" is the Level, "t" the text). This is what the browser module consumes.
std::string lines_to_json(const std::vector<Line>& lines);

// "Engine" — what profile this build exposes. The browser build is asserted
// against this by the JS test-suite.
const char* profile_name();

} // namespace boblox
