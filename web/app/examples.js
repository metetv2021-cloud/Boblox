// Example scripts for the playground. Each one only uses what the engine
// implements today (see web/README.md, "What works"); test/examples.test.mjs
// runs every example headlessly and fails if one errors.
//
// Conventions used below:
//   * animation = a task.spawn loop with task.wait(1 / 60); the virtual clock
//     advances only while the playground is playing, so speed/pause just work;
//   * Vector3 has no arithmetic operators yet — positions are built from
//     numbers, and CFrame * CFrame does the vector math.

export const EXAMPLES = [
  {
    id: 'planets',
    title: 'Orbiting planets',
    note: 'One script thread per planet, driven by the virtual clock.',
    code: String.raw`-- Orbiting planets. One script thread per planet; the clock only advances
-- while the playground is playing, so Pause / speed / Step just work.
local function ball(name, size, color)
    local p = Instance.new("Part")
    p.Name = name
    p.Shape = Enum.PartType.Ball
    p.Size = Vector3.new(size, size, size)
    p.Color = color
    p.Anchored = true
    p.Parent = workspace
    return p
end

local origin = CFrame.new(0, 3, 0)
local up = Vector3.new(0, 1, 0)

local sun = ball("Sun", 6, Color3.fromRGB(255, 200, 40))
sun.CFrame = origin

local planets = {
    { name = "Mercury", size = 1.2, radius = 6,  speed = 2.4, color = Color3.fromRGB(180, 170, 160) },
    { name = "Venus",   size = 1.8, radius = 9,  speed = 1.7, color = Color3.fromRGB(230, 190, 120) },
    { name = "Earth",   size = 2.0, radius = 13, speed = 1.2, color = Color3.fromRGB(70, 130, 220) },
    { name = "Mars",    size = 1.5, radius = 17, speed = 0.9, color = Color3.fromRGB(210, 90, 60) },
}

for _, info in ipairs(planets) do
    local planet = ball(info.name, info.size, info.color)
    task.spawn(function()
        local angle = 0
        while true do
            angle += info.speed / 60
            planet.CFrame = origin * CFrame.fromAxisAngle(up, angle) * CFrame.new(info.radius, 0, 0)
            task.wait(1 / 60)
        end
    end)
end

print(#planets .. " planets orbiting. Drag in the viewport to look around.")
`,
  },
  {
    id: 'tower',
    title: 'Build a tower',
    note: 'A static scene: Parts, Models, Color3, CFrame, Random.',
    code: String.raw`-- A stack of colored blocks. Everything is created once; nothing animates.
local base = Instance.new("Part")
base.Name = "Baseplate"
base.Size = Vector3.new(60, 1, 60)
base.CFrame = CFrame.new(0, -0.5, 0)
base.Color = Color3.fromRGB(90, 140, 90)
base.Anchored = true
base.Parent = workspace

local tower = Instance.new("Model")
tower.Name = "Tower"
tower.Parent = workspace

local rng = Random.new(2024) -- same numbers on every run (exact PCG port)
for level = 1, 12 do
    local size = 8 - level * 0.4
    local block = Instance.new("Part")
    block.Name = "Level" .. level
    block.Size = Vector3.new(size, 1, size)
    block.CFrame = CFrame.new(0, level - 0.5, 0) * CFrame.fromAxisAngle(Vector3.new(0, 1, 0), level * 0.3)
    block.Color = Color3.fromHSV((level / 12 + rng:NextNumber() * 0.05) % 1, 0.7, 0.95)
    block.Anchored = true
    block.Parent = tower
end

print("built", #tower:GetChildren(), "blocks;", #workspace:GetDescendants(), "instances in Workspace")
`,
  },
  {
    id: 'bounce',
    title: 'Bouncing balls',
    note: 'A tiny physics loop written in Luau.',
    code: String.raw`-- Bouncing balls: gravity and restitution integrated by hand in Luau.
local rng = Random.new(7)
local gravity = -30
local dt = 1 / 60

local floor = Instance.new("Part")
floor.Name = "Floor"
floor.Size = Vector3.new(44, 1, 16)
floor.CFrame = CFrame.new(0, -0.5, 0)
floor.Color = Color3.fromRGB(60, 62, 70)
floor.Anchored = true
floor.Parent = workspace

for i = 1, 9 do
    local ball = Instance.new("Part")
    ball.Name = "Ball" .. i
    ball.Shape = Enum.PartType.Ball
    ball.Size = Vector3.new(2, 2, 2)
    ball.Color = Color3.fromHSV(i / 9, 0.8, 1)
    ball.Anchored = true
    ball.Parent = workspace

    local x = (i - 5) * 4
    local y = 6 + rng:NextNumber() * 12
    local vy = 0
    local bounciness = 0.72 + rng:NextNumber() * 0.22

    task.spawn(function()
        while true do
            vy += gravity * dt
            y += vy * dt
            if y < 1 then -- the floor
                y = 1
                vy = -vy * bounciness
                if vy < 2 then vy = 14 + rng:NextNumber() * 10 end -- give it a kick
            end
            ball.CFrame = CFrame.new(x, y, 0)
            task.wait(dt)
        end
    end)
end

print("9 balls, hand-rolled physics at 60 Hz of virtual time")
`,
  },
  {
    id: 'explorer',
    title: 'Scene graph & properties',
    note: 'Many classes and property types to browse in the Explorer.',
    code: String.raw`-- A small scene to explore: click things in the Explorer (or in the viewport)
-- and inspect their properties on the right.
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

local ramp = part("Ramp", "WedgePart", Vector3.new(6, 2, 8), CFrame.new(0, 1, -8), Color3.fromRGB(60, 120, 220), scene)
ramp:SetAttribute("Slope", 0.5)
ramp:SetAttribute("Label", "jump here")

part("Spawn", "SpawnLocation", Vector3.new(6, 1, 6), CFrame.new(10, 0.5, 10), Color3.fromRGB(250, 250, 250), scene)

local npc = Instance.new("Model")
npc.Name = "Guard"
npc.Parent = scene
local head = part("Head", "Part", Vector3.new(2, 1, 1), CFrame.new(0, 3, 0), Color3.fromRGB(255, 204, 153), npc)
npc.PrimaryPart = head
local humanoid = Instance.new("Humanoid", npc)
humanoid.MaxHealth = 120
humanoid.Health = 80

local sparks = Instance.new("ParticleEmitter")
sparks.Name = "Sparks"
sparks.Lifetime = NumberRange.new(0.5, 1.5)
sparks.Size = NumberSequence.new(1)
sparks.Color = ColorSequence.new(Color3.new(1, 0.5, 0))
sparks.Parent = ball

local hud = Instance.new("Frame")
hud.Name = "Hud"
hud.Position = UDim2.new(0.5, -50, 0, 10)
hud.Size = UDim2.fromOffset(100, 24)
hud.BackgroundColor3 = Color3.fromRGB(10, 10, 30)
hud.Parent = scene

print(#scene:GetDescendants() .. " instances under " .. scene:GetFullName())
`,
  },
  {
    id: 'events',
    title: 'Signals, attributes & tasks',
    note: 'Console demo: events fire in order on the virtual clock.',
    code: String.raw`-- Signals, attributes and the task scheduler. Watch the Console.
local part = Instance.new("Part")
part.Name = "Subject"
part.Parent = workspace

part:GetPropertyChangedSignal("Name"):Connect(function()
    print("Name changed to", part.Name)
end)
part:GetAttributeChangedSignal("Level"):Connect(function()
    print("Level attribute is now", part:GetAttribute("Level"))
end)

part.Name = "Renamed"
part:SetAttribute("Level", 1)

local humanoid = Instance.new("Humanoid")
humanoid.MaxHealth = 100
humanoid.Health = 100
humanoid.Died:Connect(function() warn("the humanoid died!") end)

local elapsed = 0
task.spawn(function()
    print("worker started")
    for i = 1, 4 do
        elapsed += task.wait(0.5)
        part:SetAttribute("Level", i + 1)
        humanoid:TakeDamage(30)
        print(string.format("t=%.1fs  health=%d", elapsed, humanoid.Health))
    end
    print("worker finished")
end)

task.delay(1.25, function() print("task.delay fired at about 1.25s") end)
task.defer(function() print("task.defer runs on the next pump, after the main chunk") end)

print("main chunk done; the rest happens as the clock advances")
`,
  },
  {
    id: 'datatypes',
    title: 'Datatypes tour',
    note: 'Console demo: Vector3, CFrame, Color3, Random, Enum, DateTime...',
    code: String.raw`-- Roblox datatypes as implemented by the engine. Watch the Console.
local v = Vector3.new(3, 4, 12)
print("Vector3", v, "magnitude", v.Magnitude, "dot", v:Dot(Vector3.new(1, 0, 0)))

local function round(x) return math.floor(x * 1000 + 0.5) / 1000 end -- hides float noise like -0.000

local cf = CFrame.new(1, 2, 3) * CFrame.fromAxisAngle(Vector3.new(0, 1, 0), math.pi / 2)
print("CFrame position", cf.Position)
print("  look vector", round(cf.LookVector.X), round(cf.LookVector.Y), round(cf.LookVector.Z))
print("  inverse * cf is identity:", (cf:Inverse() * cf):FuzzyEq(CFrame.new()))

local c = Color3.fromRGB(255, 128, 0)
local h, s, val = c:toHSV()
print("Color3", c, string.format("hsv = %.2f %.2f %.2f", h, s, val))
print("BrickColor", BrickColor.new("Bright red").Number, BrickColor.new(Color3.new(1, 1, 1)).Name)

local rng = Random.new(42)
print("Random(42):", rng:NextInteger(1, 100), rng:NextInteger(1, 100), rng:NextInteger(1, 100))

local u = UDim2.new(0.5, 10, 1, -20)
print("UDim2", u.X.Scale, u.X.Offset, u.Y.Scale, u.Y.Offset)
print("DateTime", DateTime.fromUnixTimestamp(1700000000):ToIsoDate())
print("Enum.Material has", #Enum.Material:GetEnumItems(), "items; Neon =", Enum.Material.Neon.Value)

local p = Instance.new("Part")
print("typeof:", typeof(p), typeof(v), typeof(cf), typeof(c), typeof(u), typeof(Enum.Material.Neon))
print("a Part defaults to", p.Size, "and is anchored?", p.Anchored)
`,
  },
  {
    id: 'spiral',
    title: 'Spiral of 1500 cubes',
    note: 'A rendering and engine stress test.',
    code: String.raw`-- 1500 anchored cubes in a spiral: exercises instance creation, property
-- marshalling and the viewport.
local n = 1500
local up = Vector3.new(0, 1, 0)
local folder = Instance.new("Folder")
folder.Name = "Spiral"
folder.Parent = workspace

for i = 1, n do
    local a = i * 0.25
    local r = 2 + i * 0.012
    local p = Instance.new("Part")
    p.Size = Vector3.new(0.8, 0.8, 0.8)
    p.CFrame = CFrame.new(math.cos(a) * r, i * 0.012, math.sin(a) * r) * CFrame.fromAxisAngle(up, a)
    p.Color = Color3.fromHSV((i / n * 3) % 1, 0.75, 1)
    p.Anchored = true
    p.Parent = folder
end
print(n .. " parts created;", #folder:GetChildren(), "children,", gcinfo(), "KiB of Lua heap")
`,
  },
  {
    id: 'hello',
    title: 'Hello, Luau',
    note: 'The language itself: strings, tables, closures, pcall.',
    code: String.raw`-- Luau running as WebAssembly inside this page.
print("Hello from Luau!")
print("2 + 2 =", 2 + 2, "| 7 // 2 =", 7 // 2, "| 2^10 =", 2 ^ 10)
print(string.format("%d bytes but %d characters", #"héllo", utf8.len("héllo")))
warn("warnings show up in amber")

local function fib(n) return n < 2 and n or fib(n - 1) + fib(n - 2) end
print("fib(25) =", fib(25))

local words = {}
for w in ("the quick brown fox"):gmatch("%a+") do words[#words + 1] = w:upper() end
print(table.concat(words, " "))

local ok, err = pcall(function() error("something went wrong") end)
print("pcall ->", ok, err)

task.wait(1)               -- scripts are threads: top-level waits are fine
print("one virtual second later")
error("an uncaught error ends the script (click the location to jump to it)")
`,
  },
];

export const DEFAULT_EXAMPLE = 'planets';
