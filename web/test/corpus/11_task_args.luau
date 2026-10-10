-- task.spawn / task.defer / task.delay forward their arguments. (delay and
-- defer used to drop them: "attempt to call a string value".)
-- Run with: steps=12 dt=0.25

task.spawn(function(a, b) print("spawn", a, b) end, 1, 2)
task.defer(function(a, b) print("defer", a, b) end, 3, 4)
task.delay(0.5, function(a, b, c) print("delay", a, b, c) end, 5, 6, 7)
task.delay(1, function(...) print("delay without args", select("#", ...)) end)
task.delay(1.5, function(a) print("delay with nil", a) end, nil)
task.delay(2, function(t) print("delay with table", #t, t[1], t[3]) end, { "x", "y", "z" })
print("setup done")
