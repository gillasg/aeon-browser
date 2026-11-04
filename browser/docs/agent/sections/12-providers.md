## AI sites, images, video and X (built-in abilities)

These sites come with abilities, on the user's own accounts (their plan, their history; no API
key, no separate login). Run them like any ability, in browser code:

```js
await site.run(
  "ask",
  { prompt: "Which of these two laptops?", withPage: true },
  { site: "chatgpt.com" },
);
await site.run("ask", { prompt, effort: "pro", timeoutMs: 300000 }, { site: "chatgpt.com" }); // slowest, most careful
await site.run("ask", { prompt: "And the battery?", conversation }, { site: "chatgpt.com" }); // a follow-up
await site.run("ask", { prompt, mode: "research" }, { site: "perplexity.ai" });
await site.run("ask", { prompt, deepSearch: true }, { site: "grok.com" });
await site.run(
  "make_image",
  { prompt: "a fox in snow", aspectRatio: "16:9" },
  { site: "gemini.google.com" },
);
await site.run(
  "edit_image",
  { prompt: "make the sky pink", images: ["media/photo.png"] },
  { site: "gemini.google.com" },
);
await site.run("ask_about_video", { url, question }, { site: "gemini.google.com" });
await site.run("thread", { url: "https://x.com/user/status/123" }, { site: "x.com" });
await site.run(
  "research",
  { topic: "reactions to the launch", budget: 8, since: "2026-10-01" },
  { site: "x.com" },
);
```

- **`ask`** works on chatgpt.com, gemini.google.com, grok.com, perplexity.ai and kimi.com. Inputs:
  `prompt`, `model`, `files` (workspace files to attach), `withPage` (`true` for the current page or
  a tab id: its text goes with the prompt), `conversation` (the URL an earlier answer returned, for
  a follow-up), `timeoutMs`; plus `effort` on ChatGPT (`pro`, `thinking`, `instant`), `mode` on
  Perplexity (`research`) and Kimi (`researcher`), `deepSearch` on Grok. The answer is
  `{text, conversation, applied, skipped}`: `skipped` names any option the page did not offer, so
  say so instead of claiming it. Several sites at once: `Promise.all` of `site.run` calls.
- **A long ask** (`effort: "pro"`, deep research) takes minutes: run it inside `browser.job` so the
  chat goes on, and read `browser.job.result(id)` later.
- **`thread`** reads a post with its replies from X's own responses (the user's login), scrolling
  for more, and falls back to the posts on screen (`via: "page"`).
- **`research`** asks Grok to search X, opens every cited post to check it exists and says what
  Grok claims, and searches X itself when Grok has too little (`latest: true` for newest first).
  It returns `{posts, grok, unverified, notes}`. Write the answer from `posts` only: the answer in
  one paragraph, then claim, who, when, link; keep what the posts say apart from what you infer;
  drop `unverified` links; say when the evidence is thin.
- Signed out of a site fails with `SIGNED_OUT` or a clear `PROVIDER_*` error naming the site to sign
  in to. Never ask for an API key, and never print cookies.
- From the shell: `browserkit ask <provider> "<question>"`, `browserkit media image|youtube`.
- MCP clients that prefer single steps have `browser_action` (click, navigate, type, press, scroll,
  wait, extract, screenshot…); anything with several steps stays in `browser_code`.
