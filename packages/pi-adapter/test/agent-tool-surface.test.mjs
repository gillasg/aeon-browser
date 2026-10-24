import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { createCrawlTool } from "../dist/crawl-tool.js";
import { createSiteMapperTool } from "../dist/site-mapper-tool.js";

const surfacePath = new URL("./agent-tool-surface.json", import.meta.url);
const update = process.env.UPDATE_TOOL_SNAPSHOT === "1";

function surface(tool) {
  const parameters = JSON.parse(JSON.stringify(tool.parameters));
  return {
    name: tool.name,
    description: tool.description,
    actions: parameters.properties.action.enum,
    parameters,
  };
}

test("the agent's wrapped tool surface is deliberate", () => {
  const actual = [surface(createCrawlTool("snapshot")), surface(createSiteMapperTool("snapshot"))];
  if (update) writeFileSync(surfacePath, JSON.stringify(actual, null, 2) + "\n");
  assert.deepEqual(actual, JSON.parse(readFileSync(surfacePath, "utf8")));
});
