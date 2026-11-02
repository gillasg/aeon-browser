import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "../dist/chat-markdown.js";
import { WorkspaceImageContext } from "../dist/tool-images.js";

test("an image saved in the workspace loads from the chat, a web image stays a link", () => {
  const html = renderToStaticMarkup(
    createElement(
      WorkspaceImageContext.Provider,
      { value: () => new Promise(() => {}) },
      createElement(ChatMarkdown, {
        text: "![apple](media/apple.jpg) ![logo](https://example.com/logo.png)",
      }),
    ),
  );
  assert.match(html, /Loading media\/apple\.jpg…/);
  assert.doesNotMatch(html, /src="media\/apple\.jpg"/);
  assert.match(html, /src="https:\/\/example\.com\/logo\.png"/);
});
