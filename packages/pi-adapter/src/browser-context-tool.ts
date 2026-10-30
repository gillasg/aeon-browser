import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { browserContextCode, browserContextDescription } from "@browserkit/tools/context";

// browser_context: the user's tabs, recent and most used sites, and history/bookmark matches in
// one call. The description and the cell come from browserkit; the cell runs through browser_code
// so the result reads the same as any other browser call.

type BrowserCodeTool = ReturnType<typeof defineTool>;

export function createBrowserContextTool(browserCode: BrowserCodeTool): BrowserCodeTool {
  return defineTool({
    name: "browser_context",
    label: "Browsing context",
    description: browserContextDescription,
    promptSnippet:
      "Use browser_context first when a request names a site, page or 'my / last / most' anything without a URL.",
    promptGuidelines: [
      "Requests that say where only vaguely ('open the opencode console', 'that article from yesterday', 'my usual subreddits') start with browser_context: it answers from the user's own tabs, history and bookmarks. Open the URL it finds instead of guessing one or asking.",
      "'My / most / last / usual' questions about the user's browsing are answered from history (browser_context, then browser.history.top or browser.history.search in browser_code), never from bash, local files or Chrome's History database.",
      "Use bash only for work that is clearly on this computer (files, local programs, the workspace).",
    ],
    parameters: Type.Object(
      {
        request: Type.Optional(Type.String({ maxLength: 300 })),
        days: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    execute: (toolCallId, input, signal, onUpdate, context) =>
      browserCode.execute(
        toolCallId,
        { code: browserContextCode(input) } as never,
        signal,
        onUpdate as never,
        context as never,
      ),
  });
}
