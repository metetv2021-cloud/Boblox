-- A small scene covering many classes and property datatypes. Run with
-- --tree --props: the transcript includes the full properties dump of every
-- instance (types, values, read-only flags), which exercises the viewer's
-- value formatting for ~20 datatypes on both builds.

local function part(name, cls, size, cf, color, parent)
    local p = Instance.new(cls)
    p.Name = name
    p.Size = size
    p.CFrame = cf
    p.Color = color
    p.Anchored = true
    p.Parent = parent
    return p
end

local scene = Instance.new("Model")
scene.Name = "Scene"
scene.Parent = workspace

part("Floor", "Part", Vector3.new(40, 1, 40), CFrame.new(0, -0.5, 0), Color3.fromRGB(80, 160, 80), scene)
part("Tower", "Part", Vector3.new(2, 10, 2), CFrame.new(5, 5, -3), Color3.fromRGB(200, 200, 60), scene)
local ball = part("Ball", "Part", Vector3.new(3, 3, 3), CFrame.new(-4, 2, 2), Color3.fromRGB(220, 60, 60), scene)
ball.Shape = Enum.PartType.Ball
ball.Material = Enum.Material.Neon
ball.Transparency = 0.25
ball.CustomPhysicalProperties = PhysicalProperties.new(2, 0.5, 0.25, 1, 1)
local wedge = part("Ramp", "WedgePart", Vector3.new(6, 2, 8), CFrame.new(0, 1, -8), Color3.fromRGB(60, 120, 220), scene)
wedge:SetAttribute("Slope", 0.5)
part("Spawn", "SpawnLocation", Vector3.new(6, 1, 6), CFrame.new(10, 0.5, 10), Color3.fromRGB(250, 250, 250), scene)

local npc = Instance.new("Model")
npc.Name = "Guard"
npc.Parent = scene
local head = part("Head", "Part", Vector3.new(2, 1, 1), CFrame.new(0, 3, 0), Color3.fromRGB(255, 204, 153), npc)
npc.PrimaryPart = head
local hum = Instance.new("Humanoid", npc)
hum.MaxHealth = 120
hum.Health = 80

local emitter = Instance.new("ParticleEmitter")
emitter.Name = "Sparks"
emitter.Lifetime = NumberRange.new(0.5, 1.5)
emitter.Size = NumberSequence.new(1)
emitter.Color = ColorSequence.new(Color3.new(1, 0.5, 0))
emitter.Parent = ball

local label = Instance.new("Frame")
label.Name = "Hud"
label.Position = UDim2.new(0.5, -50, 0, 10)
label.Size = UDim2.fromOffset(100, 24)
label.BackgroundColor3 = Color3.fromRGB(10, 10, 30)
label.Parent = scene

local anim = Instance.new("Animation")
anim.Name = "Wave"
anim.AnimationId = "rbxassetid://507770239"
anim.Parent = npc

print(#scene:GetDescendants(), scene:GetFullName())
