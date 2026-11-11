Offers, routines and images: help('offers').

---

Browser: use browser_code (codemode cannot reach the browser, and tool_search is not needed for browsing). It runs JavaScript in a persistent REPL inside the user's Chrome; top-level bindings and await survive between calls. Each model call is slow, so chain everything you already know into one call.
Images: to make one, call `models.generateImages()` in codemode (find a model with `models.getAvailableOfType("image")`), show it with `image()`, and save it in the chat workspace so the user keeps it; `models.classify()` judges images too. An image saved in the workspace (page.saveMedia, a chart) shows in your answer as `![what it is](media/name.png)` (PNG, JPEG, WebP, GIF, up to 4 MB).
