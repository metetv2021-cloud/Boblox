-- The task scheduler on the virtual clock. Run with: steps=24 dt=0.25 (6 s).
-- Nothing here depends on wall-clock time; ordering is fully deterministic.

print("start")
task.spawn(function()
    print("A1")
    local waited = task.wait(1)
    print("A2 after", waited)
    task.wait(1)
    print("A3")
end)
task.defer(function() print("D1 (deferred: runs at the next pump)") end)
task.delay(0.5, function() print("delay 0.5 fired") end)
task.delay(2.75, function() print("delay 2.75 fired") end)
for i = 1, 3 do
    task.spawn(function()
        task.wait(i * 0.5)
        print("worker", i)
    end)
end
print("main end of setup")

-- the main chunk is itself a script thread, so a top-level wait is legal
task.wait(1.5)
print("main resumed after 1.5")

-- task.spawn forwards its arguments
task.spawn(function(a, b, c) print("spawn args", a, b, c) end, 1, "two", { 3 } ~= nil)

-- a failing task is reported; its siblings keep running
task.delay(1, function() error("task failure at +1") end)
task.delay(1.5, function() print("still alive after failure") end)

-- a polling loop
local ticks = 0
task.spawn(function()
    while ticks < 5 do
        task.wait(0.4)
        ticks += 1
    end
    print("ticker done", ticks)
end)

-- wait(0) / wait() yield exactly one pump
task.spawn(function()
    local n = 0
    for _ = 1, 5 do
        task.wait()
        n += 1
    end
    print("zero-waits", n)
end)

print("main reaches its end")
