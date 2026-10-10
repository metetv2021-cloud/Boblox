-- Signals and connections. Run with: steps=4 dt=0.1

local p = Instance.new("Part")
local log = {}
local conn = p:GetPropertyChangedSignal("Name"):Connect(function() log[#log + 1] = "name->" .. p.Name end)
print(conn.Connected, typeof(conn), typeof(p:GetPropertyChangedSignal("Name")))
p.Name = "A"
p.Name = "B"
conn:Disconnect()
p.Name = "C"
print(table.concat(log, ","), conn.Connected)

-- Once fires a single time
local n = 0
p:GetPropertyChangedSignal("Anchored"):Once(function() n += 1 end)
p.Anchored = true
p.Anchored = false
print("once fired", n)

-- several handlers on one signal run in connection order
local order = {}
local sig = p:GetPropertyChangedSignal("Transparency")
sig:Connect(function() order[#order + 1] = "first" end)
sig:Connect(function() order[#order + 1] = "second" end)
sig:Connect(function() order[#order + 1] = "third" end)
p.Transparency = 0.5
print(table.concat(order, ">"))

-- a handler that errors does not stop the others
local survivors = 0
local sig2 = p:GetPropertyChangedSignal("Reflectance")
sig2:Connect(function() error("handler failure") end)
sig2:Connect(function() survivors += 1 end)
print(pcall(function() p.Reflectance = 0.25 end))
print("survivors", survivors)

-- Wait() resumes the waiting thread at the next pump
task.spawn(function()
    p:GetPropertyChangedSignal("Locked"):Wait()
    print("Locked changed; waiter resumed")
end)
p.Locked = true
print("setter returned before the waiter resumed")

-- attribute signals
local changes = 0
p:GetAttributeChangedSignal("level"):Connect(function() changes += 1 end)
p:SetAttribute("level", 1)
p:SetAttribute("level", 2)
p:SetAttribute("level", nil)
print("attribute changes", changes)

-- event members
local h = Instance.new("Humanoid")
h.MaxHealth = 50
h.Health = 50
h.Died:Connect(function() print("died!") end)
h:TakeDamage(20)
print(h.Health)
h:TakeDamage(40)
print(h.Health)
print(typeof(h.Died), typeof(Instance.new("Part").Touched))

-- WaitForChild: immediate, delayed, and timeout
local root = Instance.new("Folder")
local there = Instance.new("Part", root)
there.Name = "There"
print(root:WaitForChild("There") == there)
task.spawn(function()
    local late = root:WaitForChild("Late", 5)
    print("late child:", late and late.Name or "nil")
end)
task.spawn(function()
    task.wait(0.2)
    Instance.new("Part", root).Name = "Late"
end)
task.spawn(function()
    local ghost = root:WaitForChild("Ghost", 0.2)
    print("ghost:", ghost)
end)
print("setup done")
