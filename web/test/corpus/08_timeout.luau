-- A runaway loop. Run with a small time limit (limit-ms=150): the interrupt
-- hook turns it into a normal Luau error. The loop sits on ONE line so the
-- reported position is the same no matter which safepoint trips the check.
print("before")
local n = 0
while true do n += 1 end
print("not reached")
