-- Limits: deep recursion, deep nesting, and text encodings. The point is that
-- both builds fail (or succeed) the same way and neither crashes.

local function depth(n) return n == 0 and 0 or 1 + depth(n - 1) end
print(pcall(depth, 100))
local ok, err = pcall(depth, 1e6)
print(ok, tostring(err):match("stack overflow") ~= nil)

local function nest(n)
    if n == 0 then return "bottom" end
    local _, v = pcall(nest, n - 1)
    return v
end
print(nest(100))

local ok2, e2 = pcall(function()
    local function rec(n)
        local ok3, v = pcall(rec, n + 1)
        if not ok3 then error(v, 0) end
        return v
    end
    return rec(1)
end)
print(ok2, type(e2))

-- deep instance nesting (engine recursion: Destroy / GetDescendants / teardown)
local top = Instance.new("Model")
local cur = top
for i = 1, 1500 do
    local m = Instance.new("Model")
    m.Parent = cur
    cur = m
end
top.Parent = workspace
print(#top:GetDescendants())
print(cur:IsDescendantOf(workspace), cur:FindFirstAncestorOfClass("Model") ~= nil)
top:Destroy()
print(#workspace:GetChildren())

-- UTF-8 across the JS <-> wasm boundary
local u = Instance.new("Part")
u.Name = "héllo wörld 🚀 日本語"
u.Parent = workspace
print(u.Name, #u.Name, utf8.len(u.Name))
print(("🚀"):byte(1, -1))
print(string.format("[%s|%5s|%-5s]", "é", "é", "é"))
print(utf8.char(72, 228, 8364, 128512), utf8.codepoint("€", 1))
for _, c in utf8.codes("aé€") do print(c) end

-- very long strings and a binary-safe round trip
local blob = string.rep("\0\1\2\255", 4096)
print(#blob, blob:byte(1, 4))
u.Name = blob:sub(1, 8)
print(#u.Name, u.Name:byte(1, 8))
