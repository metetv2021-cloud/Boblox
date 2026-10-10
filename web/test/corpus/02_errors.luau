-- Error handling. Luau raises errors by throwing C++ exceptions through the
-- VM and the engine's RAII frames, so this is the script most likely to expose
-- a WebAssembly exception-handling problem.

print(pcall(function() local x = nil; return x.y end))
print(pcall(function() return 1 + {} end))
print(pcall(function() return #5 end))
print(pcall(function() return nil .. "x" end))
print(pcall(function() local t = {} t[nil] = 1 end))
print(pcall(function() return ("x"):nope() end))
print(pcall(function() return undefinedGlobal.field end))

local ok2, e2 = pcall(error, { code = 7 })
print(ok2, typeof(e2), e2.code)
print(pcall(error, "plain", 0))
print(pcall(error))
print(xpcall(function() error("deep") end, function(m) return "handled: " .. m end))
print(pcall(assert, false, "assertion msg"))
print(pcall(assert, nil))
print(select("#", pcall(function() end)))

local function lvl2() error("from lvl2", 2) end
local function caller() lvl2() end
print(pcall(caller))
print(pcall(setmetatable, 1, {}))
print(pcall(function() for i = 1, "x" do end end))
print(pcall(function()
    local t = setmetatable({}, { __index = function() error("idx boom") end })
    return t.a
end))

-- errors crossing coroutine and pcall boundaries, repeatedly
local co = coroutine.wrap(function() error("in coroutine") end)
print(pcall(co))
local depth = 0
local function nest(n)
    if n == 0 then error("bottom") end
    local ok, e = pcall(nest, n - 1)
    depth += 1
    error(e, 0)
end
print(pcall(nest, 50))
print(depth)
for i = 1, 200 do pcall(error, "churn " .. i) end
print("churn ok")

-- errors raised by engine C++ code (RAII frames between the throw and the catch)
print(pcall(Instance.new, "NotAClass"))
print(pcall(Instance.new, "Workspace"))
print(pcall(function() Instance.new("Part").Size = "wide" end))
print(pcall(function() local p = Instance.new("Part") p.Parent = p end))
for i = 1, 200 do pcall(function() Instance.new("Part").Anchored = "no" end) end
print("engine churn ok")

-- an uncaught error ends the script: run() reports failure
local function boom() error("uncaught at end") end
boom()
print("not reached")
