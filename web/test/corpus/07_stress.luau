-- Allocation and GC pressure: many instances, many tables, big strings.
-- Exercises WebAssembly memory growth (the module starts at 32 MiB).

local root = Instance.new("Model")
root.Name = "Stress"
root.Parent = workspace

for i = 1, 3000 do
    local p = Instance.new("Part")
    p.Name = "P" .. i
    p.Size = Vector3.new(i % 7 + 1, 1, 1)
    p.CFrame = CFrame.new(i, 0, 0)
    p.Parent = root
end
print(#root:GetChildren(), #root:GetDescendants(), root:FindFirstChild("P2999").Size.X)

local sum = 0
for _, p in ipairs(root:GetChildren()) do sum += p.Size.X * p.CFrame.X end
print("weighted sum", sum)

local parts = {}
for i = 1, 100000 do parts[#parts + 1] = tostring(i) end
print(#table.concat(parts), #parts)

local big = {}
for i = 1, 200000 do big[i] = { i, i * 2 } end
local acc = 0
for i = 1, #big do acc += big[i][2] end
print("acc", acc)

local s = string.rep("0123456789", 100000)
print(#s, s:sub(-5), #s:rep(3))
local words = {}
for w in ("the quick brown fox jumps over the lazy dog "):rep(2000):gmatch("%a+") do words[#words + 1] = w end
print(#words)

big, parts, s, words = nil, nil, nil, nil
print(gcinfo() > 0)

-- churn: create and destroy
for round = 1, 20 do
    local f = Instance.new("Folder")
    for i = 1, 200 do Instance.new("Part", f) end
    f:Destroy()
end
root:ClearAllChildren()
print(#root:GetChildren())
