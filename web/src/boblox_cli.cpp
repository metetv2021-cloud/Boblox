// boblox_cli.cpp — native harness over the same boblox::Engine the browser
// build uses. It exists for differential testing: run a script natively, run
// the same script through the WASM module in Node, and compare transcripts
// (web/test/parity.test.mjs). Also handy for debugging without a browser.
//
//   boblox_cli [--steps N] [--dt SECONDS] [--limit-ms MS] [--tree] [--props]
//              script.luau
//
// Transcript format (stdout; one record per line, text escaped so that a
// record never spans lines: "\" -> "\\", LF -> "\n", CR -> "\r"):
//
//   == run <ok|fail>          result of run(); output lines follow
//   P <text> | W <text> | E <text>   print / warn / error output
//   == step <i> t=<now>       after each of the --steps step(dt) calls
//   == tree                   tree_json() (with --tree)
//   == props <id>             properties_json(id) for every instance (--props)
//
// web/test/transcript.mjs implements the identical format on the JS side.
#include "boblox.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

bool read_file(const char* path, std::string& out) {
    FILE* f = std::fopen(path, "rb");
    if (!f) return false;
    char buf[1 << 14];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0)
        out.append(buf, n);
    std::fclose(f);
    return true;
}

std::string escape(const std::string& s) {
    std::string o;
    for (char c : s) {
        if (c == '\\')
            o += "\\\\";
        else if (c == '\n')
            o += "\\n";
        else if (c == '\r')
            o += "\\r";
        else
            o.push_back(c);
    }
    return o;
}

void print_lines(boblox::Engine& e) {
    for (const boblox::Line& l : e.drain_output()) {
        const char tag = l.level == boblox::Level::Print  ? 'P'
                         : l.level == boblox::Level::Warn ? 'W'
                                                          : 'E';
        const std::string text = escape(l.text);
        std::printf("%c ", tag);
        std::fwrite(text.data(), 1, text.size(), stdout); // NUL-safe
        std::fputc('\n', stdout);
    }
}

} // namespace

int main(int argc, char** argv) {
    int steps = 0;
    double dt = 0.1;
    int limit_ms = 10000;
    bool want_tree = false, want_props = false;
    const char* path = nullptr;
    for (int i = 1; i < argc; i++) {
        const char* a = argv[i];
        if (!std::strcmp(a, "--steps") && i + 1 < argc)
            steps = std::atoi(argv[++i]);
        else if (!std::strcmp(a, "--dt") && i + 1 < argc)
            dt = std::atof(argv[++i]);
        else if (!std::strcmp(a, "--limit-ms") && i + 1 < argc)
            limit_ms = std::atoi(argv[++i]);
        else if (!std::strcmp(a, "--tree"))
            want_tree = true;
        else if (!std::strcmp(a, "--props"))
            want_props = true;
        else if (a[0] != '-')
            path = a;
        else {
            std::fprintf(stderr, "unknown option: %s\n", a);
            return 2;
        }
    }
    if (!path) {
        std::fprintf(stderr,
                     "usage: boblox_cli [--steps N] [--dt S] [--limit-ms MS] [--tree] [--props] "
                     "script.luau\n");
        return 2;
    }
    std::string src;
    if (!read_file(path, src)) {
        std::fprintf(stderr, "cannot read %s\n", path);
        return 2;
    }

    boblox::Engine e;
    e.set_time_limit_ms(limit_ms);

    const bool ok = e.run(src, "main");
    std::printf("== run %s\n", ok ? "ok" : "fail");
    print_lines(e);

    for (int i = 1; i <= steps; i++) {
        e.step(dt);
        std::printf("== step %d t=%.6f\n", i, e.now());
        print_lines(e);
    }

    if (want_tree || want_props) {
        const std::string tree = e.tree_json();
        if (want_tree) std::printf("== tree\n%s\n", tree.c_str());
        if (want_props) {
            // ids appear as "id":N in preorder; names are JSON-escaped so a
            // literal "id": inside a name cannot match.
            for (size_t pos = 0; (pos = tree.find("\"id\":", pos)) != std::string::npos;) {
                pos += 5;
                const unsigned id = (unsigned)std::strtoul(tree.c_str() + pos, nullptr, 10);
                std::printf("== props %u\n%s\n", id, e.properties_json(id).c_str());
            }
        }
    }
    return ok ? 0 : 1;
}
