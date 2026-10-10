// boblox.cpp — see boblox.h.
#include "boblox.h"

#include "api/api.h" // push_service: the workspace, independent of script-visible globals
#include "engine.h"
#include "instance/class_registry.h"
#include "instance/instance.h"
#include "instance/refcount.h"
#include "instance/scheduler.h"
#include "instance/value_types.h"
#include "instance/variant.h"

#include "lua.h"
#include "luacode.h"
#include "lualib.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <initializer_list>
#include <unordered_map>
#include <unordered_set>
#include <variant>

namespace boblox {

namespace {

constexpr int kDefaultTimeLimitMs = 10000;
// Collect before compiling a new script when the Lua heap is at least this big.
constexpr int kGcBeforeRunKb = 128 * 1024;
// Safety valve for tree_json(): a script can build millions of instances.
constexpr size_t kMaxTreeNodes = 20000;

int64_t steady_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

void json_string(std::string& out, const char* s, size_t n) {
    static const char* hex = "0123456789abcdef";
    out.push_back('"');
    for (size_t i = 0; i < n; i++) {
        const unsigned char c = (unsigned char)s[i];
        switch (c) {
        case '"':
            out += "\\\"";
            break;
        case '\\':
            out += "\\\\";
            break;
        case '\n':
            out += "\\n";
            break;
        case '\r':
            out += "\\r";
            break;
        case '\t':
            out += "\\t";
            break;
        default:
            if (c < 0x20) {
                out += "\\u00";
                out.push_back(hex[c >> 4]);
                out.push_back(hex[c & 15]);
            } else {
                out.push_back((char)c); // UTF-8 passes through untouched
            }
        }
    }
    out.push_back('"');
}

void json_string(std::string& out, const std::string& s) {
    json_string(out, s.data(), s.size());
}

const char* prop_type_name(rbx::PropType t) {
    switch (t) {
    case rbx::PropType::Bool:
        return "Bool";
    case rbx::PropType::Int:
        return "Int";
    case rbx::PropType::Double:
        return "Double";
    case rbx::PropType::String:
        return "String";
    case rbx::PropType::Vector3:
        return "Vector3";
    case rbx::PropType::Instance:
        return "Instance";
    case rbx::PropType::Color3:
        return "Color3";
    case rbx::PropType::CFrame:
        return "CFrame";
    case rbx::PropType::Vector2:
        return "Vector2";
    case rbx::PropType::BrickColor:
        return "BrickColor";
    case rbx::PropType::UDim:
        return "UDim";
    case rbx::PropType::UDim2:
        return "UDim2";
    case rbx::PropType::Rect:
        return "Rect";
    case rbx::PropType::NumberRange:
        return "NumberRange";
    case rbx::PropType::NumberSequence:
        return "NumberSequence";
    case rbx::PropType::ColorSequence:
        return "ColorSequence";
    case rbx::PropType::Content:
        return "Content";
    case rbx::PropType::PhysicalProperties:
        return "PhysicalProperties";
    case rbx::PropType::Ray:
        return "Ray";
    case rbx::PropType::Region3:
        return "Region3";
    case rbx::PropType::DateTime:
        return "DateTime";
    case rbx::PropType::Enum:
        return "Enum";
    }
    return "?";
}

// tostring() as a protected call: __tostring metamethods may raise, and a
// Luau error must never unwind through plain C++ frames of ours.
int tostring_thunk(lua_State* L) {
    luaL_tolstring(L, 1, nullptr);
    return 1;
}

// EnumItem -> its Name, read through the engine's own __index (the generated
// enum tables are private to rbx_runtime).
int enum_name_thunk(lua_State* L) {
    lua_getfield(L, 1, "Name");
    return 1;
}

// Numbers are rendered by the VM itself so the properties panel and print()
// always agree (Luau's shortest-round-trip number printing).
std::string fmt_num(lua_State* L, double d) {
    lua_pushnumber(L, d);
    size_t n = 0;
    const char* s = lua_tolstring(L, -1, &n);
    std::string out(s ? s : "", s ? n : 0);
    lua_pop(L, 1);
    return out;
}

std::string fmt_nums(lua_State* L, std::initializer_list<double> ds, const char* sep = ", ") {
    std::string out;
    for (double d : ds) {
        if (!out.empty()) out += sep;
        out += fmt_num(L, d);
    }
    return out;
}

std::string fmt_vec3(lua_State* L, const rbx::Vector3& v) {
    return fmt_nums(L, {v.x, v.y, v.z});
}

std::string fmt_datetime(int64_t millis) {
    int64_t secs = millis / 1000;
    int64_t ms = millis % 1000;
    if (ms < 0) {
        ms += 1000;
        secs -= 1;
    }
    const std::time_t t = (std::time_t)secs;
    std::tm tm{};
    gmtime_r(&t, &tm);
    char buf[48];
    std::snprintf(buf, sizeof buf, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", tm.tm_year + 1900,
                  tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec, (int)ms);
    return buf;
}

// Human-readable property value for the viewer. Types whose script-side
// tostring() already reads well go through it; the rest (which the engine
// currently stringifies as "Type: 0x<address>") are rendered here, in
// Roblox's formats where those are known.
std::string format_variant(lua_State* L, const rbx::Variant& v) {
    using namespace rbx;
    struct Fmt {
        lua_State* L;
        std::string operator()(bool b) const { return b ? "true" : "false"; }
        std::string operator()(int64_t i) const { return std::to_string(i); }
        std::string operator()(double d) const { return fmt_num(L, d); }
        std::string operator()(const std::string& s) const { return s; }
        std::string operator()(const Vector3& x) const { return fmt_vec3(L, x); }
        std::string operator()(Instance* i) const {
            return i ? i->name() + " (" + i->class_name() + ")" : "nil";
        }
        std::string operator()(const Color3& c) const { return fmt_nums(L, {c.r, c.g, c.b}); }
        std::string operator()(const CFrame& c) const {
            return fmt_nums(
                L, {c.x, c.y, c.z, c.r00, c.r01, c.r02, c.r10, c.r11, c.r12, c.r20, c.r21, c.r22});
        }
        std::string operator()(const Vector2& x) const { return fmt_nums(L, {x.x, x.y}); }
        std::string operator()(const BrickColor& b) const {
            // BrickColor's tostring is its palette name; reuse it
            push_brickcolor(L, b);
            lua_pushcfunction(L, tostring_thunk, "tostring");
            lua_insert(L, -2);
            std::string out = "BrickColor";
            if (lua_pcall(L, 1, 1, 0) == 0) {
                size_t n = 0;
                const char* s = lua_tolstring(L, -1, &n);
                out.assign(s ? s : "", s ? n : 0);
            }
            lua_pop(L, 1);
            return out;
        }
        std::string operator()(const UDim& u) const { return fmt_nums(L, {u.scale, u.offset}); }
        std::string operator()(const UDim2& u) const {
            return "{" + fmt_nums(L, {u.x.scale, u.x.offset}) + "}, {" +
                   fmt_nums(L, {u.y.scale, u.y.offset}) + "}";
        }
        std::string operator()(const Rect& r) const {
            return fmt_nums(L, {r.min.x, r.min.y, r.max.x, r.max.y});
        }
        std::string operator()(const NumberRange& r) const {
            return fmt_nums(L, {r.min, r.max}, " ");
        }
        std::string operator()(const NumberSequence& s) const {
            std::string out;
            for (const auto& k : s.keys) {
                if (!out.empty()) out += "; ";
                out += fmt_nums(L, {k.time, k.value, k.envelope}, " ");
            }
            return out.empty() ? "(empty)" : out;
        }
        std::string operator()(const ColorSequence& s) const {
            std::string out;
            for (const auto& k : s.keys) {
                if (!out.empty()) out += "; ";
                out += fmt_nums(L, {k.time, k.color.r, k.color.g, k.color.b, k.envelope}, " ");
            }
            return out.empty() ? "(empty)" : out;
        }
        std::string operator()(const Content& c) const {
            if (c.source == 1) return c.uri;
            if (c.source == 2)
                return c.object ? c.object->name() + " (" + c.object->class_name() + ")" : "nil";
            return "None";
        }
        std::string operator()(const PhysicalProperties& p) const {
            return fmt_nums(
                L, {p.density, p.friction, p.elasticity, p.friction_weight, p.elasticity_weight});
        }
        std::string operator()(const Ray& r) const {
            return "{" + fmt_vec3(L, r.origin) + "}, {" + fmt_vec3(L, r.direction) + "}";
        }
        std::string operator()(const Region3& r) const {
            return "{" + fmt_vec3(L, r.min) + "}, {" + fmt_vec3(L, r.max) + "}";
        }
        std::string operator()(const DateTime& d) const { return fmt_datetime(d.millis); }
        std::string operator()(const EnumItem& e) const {
            push_enumitem(L, e);
            lua_pushcfunction(L, enum_name_thunk, "enum_name");
            lua_insert(L, -2);
            std::string name = std::to_string(e.value);
            if (lua_pcall(L, 1, 1, 0) == 0) {
                size_t n = 0;
                const char* s = lua_tolstring(L, -1, &n);
                if (s && n) name.assign(s, n);
            }
            lua_pop(L, 1);
            return "Enum." + e.enum_name + "." + name;
        }
    };
    return std::visit(Fmt{L}, v);
}

} // namespace

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

struct Engine::Impl {
    rbxch::engine::Environment* env = nullptr;
    lua_State* L = nullptr;

    std::vector<Line> out;

    // execution budget (see set_time_limit_ms)
    int limit_ms = kDefaultTimeLimitMs;
    int64_t deadline = 0; // steady ms; 0 = disarmed
    uint32_t tick = 0;
    bool expired = false; // deadline passed: raise at every safepoint

    // viewer registry: stable small ids + strong refs for the latest walk
    std::unordered_map<rbx::Instance*, uint32_t> ids;
    std::unordered_map<uint32_t, rbx::Ref<rbx::Instance>> live;
    uint32_t next_id = 1;
    std::vector<double> part_buf;

    void error(const std::string& text) { out.push_back(Line{Level::Error, text}); }

    // ---- time limit ---------------------------------------------------------
    // Luau calls `interrupt` at loop back-edges and calls. The clock is read
    // only every 1024th safepoint (it is the hot path), but once the deadline
    // has passed EVERY safepoint raises. Sampling alone is not enough: in
    //     while true do pcall(function() while true do end end) end
    // the sampled check always lands inside the inner pcall, which would
    // swallow the error forever. Raising at every safepoint also kills the
    // outer loop's own call/back-edge, so the script cannot outlive its budget.
    static void on_interrupt(lua_State* L, int gc) {
        if (gc >= 0) return; // GC safepoint, not script progress
        auto* self = static_cast<Impl*>(lua_callbacks(L)->userdata);
        if (!self->deadline) return;
        if (!self->expired) {
            if ((++self->tick & 0x3ff) != 0) return;
            if (steady_ms() < self->deadline) return;
            self->expired = true;
        }
        luaL_error(L, "Script timeout: exhausted allowed execution time");
    }

    struct Guard {
        Impl& I;
        explicit Guard(Impl& i) : I(i) {
            if (I.limit_ms > 0) {
                I.deadline = steady_ms() + I.limit_ms;
                I.tick = 0;
                I.expired = false;
                lua_callbacks(I.L)->interrupt = &Impl::on_interrupt;
            }
        }
        ~Guard() {
            lua_callbacks(I.L)->interrupt = nullptr;
            I.deadline = 0;
            I.expired = false;
        }
    };

    // Task-thread errors are not Lua errors of the caller; the scheduler
    // collects the latest one. Surface and clear it. True if there was one.
    bool flush_scheduler_error() {
        rbx::Scheduler* s = rbx::scheduler(L);
        if (s->last_error.empty()) return false;
        error(s->last_error);
        s->last_error.clear();
        return true;
    }

    // ---- print / warn -------------------------------------------------------
    // Roblox joins arguments with a single space (Luau's stock print uses tabs).
    static int emit(lua_State* L, Level level) {
        auto* self = static_cast<Impl*>(lua_callbacks(L)->userdata);
        const int n = lua_gettop(L);
        std::string text;
        for (int i = 1; i <= n; i++) {
            size_t len = 0;
            const char* s = luaL_tolstring(L, i, &len); // may raise: __tostring
            if (i > 1) text.push_back(' ');
            text.append(s, len);
            lua_pop(L, 1);
        }
        self->out.push_back(Line{level, std::move(text)});
        return 0;
    }
    static int lua_print(lua_State* L) { return emit(L, Level::Print); }
    static int lua_warn(lua_State* L) { return emit(L, Level::Warn); }

    // ---- viewer walk ----------------------------------------------------------
    rbx::Instance* workspace() {
        // Via the service registry, not the `workspace` global: a script can
        // overwrite globals but cannot reach the registry.
        if (!rbxch::api::push_service(L, "workspace")) return nullptr;
        rbx::Instance* ws = rbx::Instance::get(L, -1);
        lua_pop(L, 1);
        return ws;
    }

    uint32_t id_of(rbx::Instance* inst) {
        auto it = ids.find(inst);
        if (it != ids.end()) return it->second;
        const uint32_t id = next_id++;
        ids.emplace(inst, id);
        live.emplace(id, rbx::Ref<rbx::Instance>(inst));
        return id;
    }

    // Preorder list of the Workspace subtree (capped); refreshes the registry
    // so ids of instances that left the tree are released.
    std::vector<rbx::Instance*> walk(bool* truncated) {
        std::vector<rbx::Instance*> order;
        *truncated = false;
        if (rbx::Instance* ws = workspace()) {
            std::vector<rbx::Instance*> stack{ws};
            while (!stack.empty()) {
                rbx::Instance* cur = stack.back();
                stack.pop_back();
                if (order.size() >= kMaxTreeNodes) {
                    *truncated = true;
                    break;
                }
                order.push_back(cur);
                const auto& kids = cur->children();
                for (size_t i = kids.size(); i-- > 0;) // reversed: pop yields child 0 first
                    stack.push_back(kids[i].get());
            }
        }
        for (rbx::Instance* inst : order)
            id_of(inst);
        std::unordered_set<rbx::Instance*> seen(order.begin(), order.end());
        for (auto it = ids.begin(); it != ids.end();) {
            if (seen.count(it->first)) {
                ++it;
            } else {
                live.erase(it->second);
                it = ids.erase(it);
            }
        }
        return order;
    }

    void drop_registry() {
        live.clear(); // release our refs BEFORE the environment force-deletes
        ids.clear();
    }
};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

Engine::Engine() : impl_(new Impl) {
    Impl& I = *impl_;
    rbxch::Options opts;
    opts.profile = rbxch::Profile::Engine;
    opts.usersettings = "ok"; // UserSettings() exists in Roblox ("error" hides the global)
    I.env = rbxch::engine::create(opts);
    I.L = rbxch::engine::state(*I.env);

    lua_callbacks(I.L)->userdata = &I;
    lua_pushcfunction(I.L, &Impl::lua_print, "print");
    lua_setglobal(I.L, "print");
    lua_pushcfunction(I.L, &Impl::lua_warn, "warn");
    lua_setglobal(I.L, "warn");

    // Keep task.spawn out of reach of scripts that reassign the `task` global.
    lua_getglobal(I.L, "task");
    lua_getfield(I.L, -1, "spawn");
    lua_setfield(I.L, LUA_REGISTRYINDEX, "boblox.spawn");
    lua_pop(I.L, 1);
}

Engine::~Engine() {
    if (!impl_) return;
    impl_->drop_registry();
    lua_callbacks(impl_->L)->userdata = nullptr;
    rbxch::engine::destroy(impl_->env);
}

bool Engine::run(const std::string& source, const std::string& chunk_name) {
    Impl& I = *impl_;
    lua_State* L = I.L;

    // A previous script may have left a large unreachable heap behind (typically
    // after "not enough memory"); reclaim it before we need memory to compile.
    if (lua_gc(L, LUA_GCCOUNT, 0) >= kGcBeforeRunKb) lua_gc(L, LUA_GCCOLLECT, 0);

    lua_CompileOptions co;
    std::memset(&co, 0, sizeof(co));
    co.optimizationLevel = 1;
    co.debugLevel = 1; // line numbers in error messages
    size_t bc_size = 0;
    char* bc = luau_compile(source.data(), source.size(), &co, &bc_size);
    if (!bc) {
        I.error("compile failed: out of memory");
        return false;
    }
    const std::string chunk = "=" + chunk_name;
    const int loaded = luau_load(L, chunk.c_str(), bc, bc_size, 0);
    std::free(bc); // luau_compile allocates with malloc
    if (loaded != 0) {
        const char* msg = lua_tostring(L, -1);
        I.error(msg ? msg : "load error");
        lua_pop(L, 1);
        return false;
    }

    // [fn] -> [spawn, fn]; task.spawn resumes the chunk immediately on its own
    // thread, so top-level task.wait() yields into the scheduler.
    lua_getfield(L, LUA_REGISTRYINDEX, "boblox.spawn");
    lua_insert(L, -2);

    bool ok = true;
    {
        Impl::Guard guard(I);
        if (lua_pcall(L, 1, 0, 0) != 0) {
            const char* msg = lua_tostring(L, -1);
            I.error(msg ? msg : "runtime error");
            lua_pop(L, 1);
            ok = false;
        }
    }
    if (I.flush_scheduler_error()) ok = false;
    return ok;
}

int Engine::step(double dt) {
    Impl& I = *impl_;
    int resumes = 0;
    {
        Impl::Guard guard(I);
        resumes = rbxch::engine::step(*I.env, dt);
    }
    I.flush_scheduler_error();
    return resumes;
}

double Engine::now() const {
    return rbxch::engine::now(*impl_->env);
}

std::vector<Line> Engine::drain_output() {
    std::vector<Line> lines;
    lines.swap(impl_->out);
    return lines;
}

size_t Engine::memory_kb() const {
    return (size_t)lua_gc(impl_->L, LUA_GCCOUNT, 0);
}

void Engine::collect_garbage() {
    lua_gc(impl_->L, LUA_GCCOLLECT, 0);
}

void Engine::set_time_limit_ms(int ms) {
    impl_->limit_ms = ms < 0 ? 0 : ms;
}

std::string Engine::tree_json() {
    Impl& I = *impl_;
    bool truncated = false;
    const std::vector<rbx::Instance*> order = I.walk(&truncated);

    std::string out;
    out.reserve(order.size() * 48 + 64);
    out += "{\"count\":" + std::to_string(order.size());
    out += truncated ? ",\"truncated\":true" : ",\"truncated\":false";
    out += ",\"root\":";
    if (order.empty()) {
        out += "null}";
        return out;
    }

    // Iterative preorder emit (a script can nest instances arbitrarily deep).
    struct Frame {
        rbx::Instance* inst;
        size_t next_child;
    };
    std::vector<Frame> stack;
    auto open = [&](rbx::Instance* inst) {
        out += "{\"id\":" + std::to_string(I.id_of(inst)) + ",\"c\":";
        json_string(out, inst->class_name());
        out += ",\"n\":";
        json_string(out, inst->name());
        out += ",\"ch\":[";
        stack.push_back(Frame{inst, 0});
    };
    const std::unordered_set<rbx::Instance*> included(order.begin(), order.end());
    open(order.front());
    while (!stack.empty()) {
        Frame& f = stack.back();
        const auto& kids = f.inst->children();
        if (f.next_child < kids.size()) {
            rbx::Instance* kid = kids[f.next_child++].get();
            if (!included.count(kid)) continue; // cut off by the node cap
            if (f.next_child > 1) out.push_back(',');
            open(kid); // NB: invalidates `f`
        } else {
            out += "]}";
            stack.pop_back();
        }
    }
    out += "}";
    return out;
}

std::string Engine::properties_json(uint32_t id) {
    Impl& I = *impl_;
    auto it = I.live.find(id);
    if (it == I.live.end()) return "null";
    rbx::Instance* inst = it->second.get();
    lua_State* L = I.L;

    // effective_properties() lists every declaration along the class chain,
    // base-most first, so a property re-declared by a subclass appears more
    // than once. The most-derived declaration wins; first-seen order is kept.
    std::vector<rbx::PropInfo> props;
    {
        std::unordered_map<std::string, size_t> at;
        for (rbx::PropInfo& p : rbx::effective_properties(inst->class_info())) {
            auto hit = at.find(p.name);
            if (hit == at.end()) {
                at.emplace(p.name, props.size());
                props.push_back(std::move(p));
            } else {
                props[hit->second] = std::move(p);
            }
        }
    }

    std::string out = "[";
    bool first = true;
    for (const rbx::PropInfo& p : props) {
        rbx::Variant v;
        if (!inst->get_prop(p.name, v)) continue;
        if (!first) out.push_back(',');
        first = false;
        out += "{\"n\":";
        json_string(out, p.name);
        out += ",\"t\":\"";
        out += prop_type_name(p.type);
        out += "\",\"v\":";
        json_string(out, format_variant(L, v));
        out += p.readonly ? ",\"ro\":true}" : ",\"ro\":false}";
    }
    out += "]";
    return out;
}

const std::vector<double>& Engine::parts() {
    Impl& I = *impl_;
    bool truncated = false;
    const std::vector<rbx::Instance*> order = I.walk(&truncated);

    std::vector<double>& buf = I.part_buf;
    buf.clear();
    for (rbx::Instance* inst : order) {
        if (!inst->is_a("BasePart")) continue;
        rbx::Variant v;

        rbx::CFrame cf; // identity unless the script moved the part
        if (inst->get_prop("CFrame", v)) {
            if (const auto* c = std::get_if<rbx::CFrame>(&v)) cf = *c;
        }
        // Position and CFrame are independent properties in this engine (no
        // cross-sync yet). Honor Position for parts whose CFrame was never set.
        if (cf == rbx::CFrame{} && inst->get_prop("Position", v)) {
            if (const auto* p = std::get_if<rbx::Vector3>(&v)) {
                cf.x = p->x;
                cf.y = p->y;
                cf.z = p->z;
            }
        }

        rbx::Vector3 size{4, 1, 2};
        if (inst->get_prop("Size", v)) {
            if (const auto* s = std::get_if<rbx::Vector3>(&v)) size = *s;
        }
        rbx::Color3 color{0.63, 0.64, 0.63}; // Medium stone grey
        if (inst->get_prop("Color", v)) {
            if (const auto* c = std::get_if<rbx::Color3>(&v)) color = *c;
        }
        double transparency = 0.0;
        if (inst->get_prop("Transparency", v)) {
            if (const auto* t = std::get_if<double>(&v)) transparency = *t;
        }
        double shape = 1; // block
        if (inst->is_a("WedgePart")) {
            shape = 3;
        } else if (inst->get_prop("Shape", v)) {
            if (const auto* e = std::get_if<rbx::EnumItem>(&v))
                shape = e->value; // PartType: 0 Ball, 1 Block, 2 Cylinder
        }

        buf.push_back((double)I.id_of(inst));
        buf.push_back(shape);
        buf.push_back(transparency);
        buf.push_back(color.r);
        buf.push_back(color.g);
        buf.push_back(color.b);
        buf.push_back(size.x);
        buf.push_back(size.y);
        buf.push_back(size.z);
        buf.push_back(cf.x);
        buf.push_back(cf.y);
        buf.push_back(cf.z);
        buf.push_back(cf.r00);
        buf.push_back(cf.r01);
        buf.push_back(cf.r02);
        buf.push_back(cf.r10);
        buf.push_back(cf.r11);
        buf.push_back(cf.r12);
        buf.push_back(cf.r20);
        buf.push_back(cf.r21);
        buf.push_back(cf.r22);
    }
    return buf;
}

std::string lines_to_json(const std::vector<Line>& lines) {
    std::string out = "[";
    for (size_t i = 0; i < lines.size(); i++) {
        if (i) out.push_back(',');
        out += "{\"l\":";
        out += std::to_string((int)lines[i].level);
        out += ",\"t\":";
        json_string(out, lines[i].text);
        out.push_back('}');
    }
    out.push_back(']');
    return out;
}

const char* profile_name() {
    return "Engine";
}

} // namespace boblox
