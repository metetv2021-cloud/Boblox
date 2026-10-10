-- The instance tree: construction, parenting, lookup, cloning, destruction,
-- attributes, typed properties and their error paths.

local function names(list)
    local out = {}
    for i, v in ipairs(list) do out[i] = v.Name end
    return table.concat(out, ",")
end

local model = Instance.new("Model")
model.Name = "Car"
local body = Instance.new("Part")
body.Name = "Body"
body.Size = Vector3.new(4, 1, 8)
body.Parent = model
local wheel1 = Instance.new("Part", model)
wheel1.Name = "Wheel"
local wheel2 = wheel1:Clone()
wheel2.Name = "Wheel"
wheel2.Parent = model -- duplicate names are legal

print(names(model:GetChildren()), #model:GetDescendants())
print(model:FindFirstChild("Wheel") == wheel1, model:FindFirstChild("Nope"), body:GetFullName(), body.Parent == model)
print(model.ClassName, body.ClassName, body:IsA("BasePart"), body:IsA("Model"), model:IsA("PVInstance"),
    body:IsA("Instance"))

model.Parent = workspace
print(body:GetFullName(), body:IsDescendantOf(workspace), workspace:IsAncestorOf(wheel2),
    body:FindFirstAncestor("Car") == model, body:FindFirstAncestorOfClass("Model") == model)
print(workspace:FindFirstChild("Wheel", true) == wheel1, workspace:FindFirstChildOfClass("Model") == model)

wheel1:Destroy()
print(names(model:GetChildren()), wheel1.Parent)
print(pcall(function() wheel1.Parent = model end))
wheel1:Destroy() -- idempotent

-- attributes
body:SetAttribute("Fuel", 0.75)
body:SetAttribute("Label", "x")
body:SetAttribute("Tag", true)
body:SetAttribute("Where", Vector3.new(1, 2, 3))
print(body:GetAttribute("Fuel"), body:GetAttribute("Label"), body:GetAttribute("Tag"), body:GetAttribute("missing"),
    body:GetAttribute("Where"))
local keys = {}
for k, v in pairs(body:GetAttributes()) do keys[#keys + 1] = k end
table.sort(keys)
print(table.concat(keys, ";"))
body:SetAttribute("Tag", nil)
print(body:GetAttribute("Tag"))

-- typed properties and their error paths
print(pcall(function() body.Size = "big" end))
print(pcall(function() body.Anchored = 1 end))
print(pcall(function() body.Nope = 1 end))
print(pcall(function() return body.Nope end))
print(pcall(function() body.ClassName = "X" end))

body.Shape = Enum.PartType.Cylinder
body.Material = Enum.Material.Neon
print(body.Shape.Name, body.Shape.Value, body.Material.Name, body.Material == Enum.Material.Neon,
    body.Material == Enum.Material.Plastic)
print(pcall(function() body.Shape = Enum.Material.Neon end))

-- reparenting and ordering
local folder = Instance.new("Folder")
folder.Name = "F"
folder.Parent = workspace
local a, b, c = Instance.new("Part"), Instance.new("Part"), Instance.new("Part")
a.Name, b.Name, c.Name = "a", "b", "c"
a.Parent, b.Parent, c.Parent = folder, folder, folder
print(names(folder:GetChildren()))
b.Parent = nil
print(names(folder:GetChildren()))
b.Parent = folder
print(names(folder:GetChildren()))
folder:ClearAllChildren()
print(#folder:GetChildren(), a.Parent, folder:GetFullName())

-- services are stable singletons
print(game:GetService("Players").ClassName, game:GetService("Lighting").ClassName,
    game:GetService("Workspace") == workspace, game:GetService("Players") == game:GetService("Players"))
print(typeof(game), typeof(workspace), typeof(Instance.new("Part")), game.JobId)
