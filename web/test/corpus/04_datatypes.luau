-- Roblox datatypes (only what the engine implements today). Floating-point
-- results go through %.4f so that a 1-ulp difference between libm
-- implementations (glibc vs musl) cannot cause a false failure; everything
-- exact is printed exactly.

local function f(...)
    local out = {}
    for i, v in ipairs({ ... }) do out[i] = string.format("%.4f", v) end
    return table.concat(out, " ")
end

-- Vector3
local v = Vector3.new(1, 2, 3)
print(tostring(v), v.X, v.Y, v.Z, f(v.Magnitude), v:Dot(Vector3.new(4, 5, 6)))
print(v == Vector3.new(1, 2, 3), v == Vector3.zero, typeof(v), tostring(Vector3.zero))
print(tostring(Vector3.new(0.1, 0.25, 1 / 3)), tostring(Vector3.new(1e10, -1e-10, 123456789)))

-- CFrame
local cf = CFrame.new(1, 2, 3)
print(tostring(cf), cf.X, cf.Y, cf.Z, tostring(cf.Position))
print(tostring(cf * CFrame.new(0, 5, 0)), tostring(cf:Inverse()), tostring(cf * Vector3.new(0, 2, 0)))
print(tostring(cf + Vector3.new(1, 1, 1)), tostring(cf - Vector3.new(1, 1, 1)))
print(CFrame.new() == CFrame.identity, typeof(cf), select("#", cf:GetComponents()))
print(tostring(CFrame.lookAt(Vector3.new(0, 0, 0), Vector3.new(0, 0, -1)).LookVector))
local axis = CFrame.fromAxisAngle(Vector3.new(0, 1, 0), math.pi)
print(f(axis.RightVector.X, axis.UpVector.Y, axis.LookVector.Z))
local tilted = CFrame.fromAxisAngle(Vector3.new(1, 0, 0), 0.5)
print(f(select(4, tilted:GetComponents())))
print(f(select(4, (tilted * tilted:Inverse()):GetComponents())))
print(tilted:FuzzyEq(CFrame.fromAxisAngle(Vector3.new(1, 0, 0), 0.5)), tostring(cf:PointToWorldSpace(Vector3.new(1, 0, 0))))
print(tostring(CFrame.fromMatrix(Vector3.new(1, 2, 3), Vector3.new(1, 0, 0), Vector3.new(0, 1, 0), Vector3.new(0, 0, 1))))

-- Color3 / BrickColor
local c = Color3.fromRGB(255, 128, 0)
print(tostring(c), c.R, f(c.G), c.B, tostring(Color3.new(0.5, 0.25, 1)), tostring(Color3.fromHSV(0, 1, 1)))
local h, s, val = Color3.fromHSV(0.5, 0.5, 0.5):toHSV()
print(f(h, s, val), typeof(c), c == Color3.fromRGB(255, 128, 0))
local bc = BrickColor.new("Bright red")
print(bc.Number, bc.Name, tostring(bc), tostring(bc.Color), BrickColor.new(21) == bc, BrickColor.White().Name)
print(BrickColor.new(Color3.new(1, 1, 1)).Name, BrickColor.new(242, 243, 243).Name)

-- Random (exact PCG port: known-answer values)
local r = Random.new(42)
print(r:NextInteger(1, 100), r:NextInteger(1, 100), r:NextInteger(1, 100), f(r:NextNumber()))
local r2 = Random.new(7)
print(f(r2:NextNumber(5, 10)), r2:NextInteger(-5, 5))
local r3 = Random.new(123456789)
local draws = {}
for i = 1, 10 do draws[i] = r3:NextInteger(1, 1000) end
print(table.concat(draws, ","))
local r4 = Random.new(99)
local r5 = r4:Clone()
print(r4:NextInteger(1, 1e6) == r5:NextInteger(1, 1e6), r4:NextNumber() == r5:NextNumber())

-- UDim / UDim2 / Rect / NumberRange / sequences
local u = UDim2.new(0.5, 10, 1, 20)
print(u.X.Scale, u.X.Offset, u.Y.Scale, u.Y.Offset, u.Width, u.Height, typeof(u))
print(UDim2.fromScale(1, 2) == UDim2.new(1, 0, 2, 0), UDim2.fromOffset(3, 4) == UDim2.new(0, 3, 0, 4))
local rect = Rect.new(1, 2, 5, 8)
print(rect.Width, rect.Height, tostring(rect.Min), tostring(rect.Max))
local nr = NumberRange.new(2, 9)
print(nr.Min, nr.Max, typeof(nr))
local ns = NumberSequence.new({ NumberSequenceKeypoint.new(0, 1, 0), NumberSequenceKeypoint.new(1, 9, 0.5) })
print(#ns.Keypoints, ns.Keypoints[2].Value, ns.Keypoints[2].Envelope, typeof(ns))
local cs = ColorSequence.new(Color3.new(1, 0, 0))
print(#cs.Keypoints, tostring(cs.Keypoints[1].Color), typeof(cs))

-- Ray / Region3 / PhysicalProperties / Content / DateTime
local ray = Ray.new(Vector3.new(0, 0, 0), Vector3.new(1, 0, 0))
print(tostring(ray.Origin), tostring(ray.Direction), ray:Distance(Vector3.new(5, 1, 0)),
    tostring(ray:ClosestPoint(Vector3.new(5, 1, 0))))
local rg = Region3.new(Vector3.new(0, 0, 0), Vector3.new(4, 2, 0))
print(tostring(rg.Size), tostring(rg.CFrame.Position))
local pp = PhysicalProperties.new(1, 2, 3, 4, 5)
print(pp.Density, pp.Friction, pp.Elasticity, pp.FrictionWeight, pp.ElasticityWeight)
print(Content.fromUri("rbxassetid://123").Uri, Content.fromAssetId(7).Uri, Content.none.SourceType)
local dt = DateTime.fromUnixTimestamp(1700000000)
print(dt:ToIsoDate(), dt.UnixTimestamp, DateTime.fromUnixTimestampMillis(1700000000123).UnixTimestampMillis)
local ut = DateTime.fromUniversalTime(2024, 2, 29, 23, 59, 58, 7):ToUniversalTime()
print(ut.Year, ut.Month, ut.Day, ut.Hour, ut.Minute, ut.Second, ut.Millisecond)

-- Enum
print(Enum.Material.Plastic.Value, Enum.Material.Plastic.Name, #Enum.Material:GetEnumItems(), Enum.PartType.Block.Value)
print(Enum.Material.Plastic == Enum.Material.Plastic, Enum.Material.Plastic == Enum.PartType.Block, typeof(Enum.Material))

-- constructor errors
print(pcall(function() return Vector3.new("x") end))
print(pcall(function() return CFrame.new(1, 2) end))
print(pcall(function() return Color3.new({}) end))
print(pcall(function() return v:Dot(5) end))
