import assert from "node:assert/strict";
import test from "node:test";
import { createClockTool } from "../dist/clock-tool.js";

test("current_time reports the local date, weekday, time zone and ISO date", async () => {
  const tool = createClockTool(() => new Date("2026-10-12T14:30:00Z"));
  assert.equal(tool.name, "current_time");
  const result = await tool.execute("call-1", {}, undefined, undefined);
  const text = result.content[0].text;
  assert.match(text, /2026/);
  assert.match(text, /UTC[+-]\d\d:\d\d/);
  assert.match(text, /ISO date: 2026-10-1[23]\./);
});
