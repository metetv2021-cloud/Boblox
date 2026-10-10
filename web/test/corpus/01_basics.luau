-- Language basics: number formatting, strings, tables, metatables, closures,
-- coroutines, bit ops, math. Everything printed here must be identical between
-- the native build and the WebAssembly build.

print("numbers", 1, -2, 3.5, 1 / 3, 2 ^ 53, 1e100, -0.0, 0 / 0 ~= 0 / 0, math.huge, -math.huge)
print("floats", 0.1 + 0.2, 100 / 3, 2 ^ 31, 2 ^ 32, 2 ^ 53 + 1, 1e15, 1e16, 123456789012, 5e-324)
print(string.format("%d|%5.2f|%s|%q|%x|%5s|%-5s|%e|%g", 42, 3.14159, "hi", 'a"b', 255, "r", "l", 12345.678, 0.0001))
print(#"héllo", utf8.len("héllo"), ("x"):rep(3, ","), ("Hello"):upper(), ("Hello"):sub(2, 4))
print(string.find("hello world", "o w"))
print(string.match("key=val", "(%w+)=(%w+)"))
print(string.gsub("aaa", "a", "b", 2))
print(table.concat(("a,b,,c"):split(","), "|"))

local t = { 5, 3, 8, 1 }
table.sort(t, function(a, b) return a > b end)
print(table.concat(t, ","), #t, select("#", 1, nil, nil), select(2, "a", "b", "c"))
print(table.unpack({ 1, 2, 3 }))
print(table.find({ "x", "y", "z" }, "y"), table.pack(1, 2, 3).n, #table.move({ 1, 2, 3 }, 1, 3, 2))

local mt = {
    __index = function(_, k) return k .. "!" end,
    __call = function(_, a) return a * 2 end,
    __tostring = function() return "OBJ" end,
    __add = function() return 99 end,
    __len = function() return 7 end,
    __eq = function() return true end,
}
local o = setmetatable({}, mt)
print(o.foo, o(21), tostring(o), o + 1, #o, o == setmetatable({}, mt))

local function counter()
    local n = 0
    return function() n += 1 return n end
end
local c = counter()
c()
c()
print(c())

local co = coroutine.create(function(a, b)
    local x = coroutine.yield(a + b)
    local y = coroutine.yield(x * 2)
    return "done", y
end)
print(coroutine.resume(co, 1, 2))
print(coroutine.resume(co, 10))
print(coroutine.resume(co, "last"))
print(coroutine.status(co), coroutine.resume(co))

print(bit32.band(0xFF00, 0x0FF0), bit32.bxor(5, 3), bit32.lshift(1, 31), bit32.rshift(0x80000000, 31),
    bit32.arshift(-1, 4), bit32.btest(8, 8), bit32.countlz(1), bit32.extract(0xABCD, 4, 8))
print(math.floor(-3.5), math.ceil(-3.5), math.max(1, 5, 3), math.min(2, -1), math.abs(-7), math.sqrt(144),
    math.fmod(7, 3), 7 % 3, -7 % 3, 7 // 2, -7 // 2, math.clamp(15, 0, 10), math.sign(-3), math.round(2.5))
print(string.format("%.4f %.4f %.4f", math.sin(1), math.cos(1), math.atan2(1, 2)))
print(string.format("%.6f %.5f %.5f %.5f", math.pi, math.exp(1.5), math.log(10), 2 ^ 0.5))
print(string.format("%.5f %.5f %.5f", math.tan(0.5), math.asin(0.5), math.sinh(1)))
print(tostring(nil), tostring(true), tonumber("0x10"), tonumber("  12  "), tonumber("1e2"), tonumber("abc"),
    tonumber("10", 2), tonumber("z", 36))
print(typeof(1), typeof("s"), typeof(nil), typeof({}), typeof(print), typeof(coroutine.create(print)))

-- generalized iteration and varargs
local function va(...)
    local n = select("#", ...)
    return n, ...
end
print(va(), va(nil), va(1, nil, 3))
local sum = 0
for i, v in ipairs({ 10, 20, 30 }) do sum += i * v end
for k, v in pairs({ a = 1 }) do sum += v end
print(sum)
local keys = {}
for k in pairs({ x = 1, y = 2, z = 3 }) do keys[#keys + 1] = k end
table.sort(keys)
print(table.concat(keys, ""))

-- Luau specifics: types are erased, if-expressions, string interpolation
local typed: number = 5
type Pair<T> = { first: T, second: T }
local pr: Pair<string> = { first = "a", second = "b" }
print(if typed > 3 then "big" else "small", `{pr.first}-{pr.second}-{typed + 1}`)
print(buffer ~= nil and buffer.create(8) ~= nil)
