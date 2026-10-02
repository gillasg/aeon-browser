export async function captureSidePanel(context) {
  const { attachPage, browser, chatId, extensionId, newPage, waitForTarget } = context;
  const opened = await openSelectedPanel(newPage, extensionId, chatId);
  const selectedAfterReload = await reloadSelectedPanel(opened.panel, opened.chatSelector, chatId);
  const secondWindowStartedEmpty = await verifyWindowIsolation(
    browser,
    attachPage,
    extensionId,
    opened.primaryWindowId,
  );
  await capturePicker(opened.panel, opened.chatSelector);
  const selectedAfterTabSwitch = await verifyTabSwitch(opened.panel, chatId);
  const width320 = await captureCompactPanel(opened.panel, attachPage, waitForTarget);
  return {
    selectedAfterReload,
    selectedAfterTabSwitch,
    secondWindowStartedEmpty,
    width380: opened.width380,
    width320,
  };
}

async function openSelectedPanel(newPage, extensionId, chatId) {
  const panel = await newPage(`chrome-extension://${extensionId}/sidepanel.html`, 380, 900);
  const chatSelector = `#chat-picker-list [data-chat-id=${JSON.stringify(chatId)}]`;
  await panel.wait("Boolean(document.getElementById('chat-picker-trigger'))");
  await panel.evaluate("document.getElementById('chat-picker-trigger').click()");
  await panel.wait("Boolean(document.getElementById('chat-picker-menu'))");
  await panel.wait("document.getElementById('panel-status').textContent === ''");
  const pickerRows = await panel.evaluate(
    "[...document.querySelectorAll('#chat-picker-list [data-chat-id]')].map((row) => ({id: row.dataset.chatId, title: row.textContent}))",
  );
  if (!pickerRows.some((row) => row.id === chatId))
    throw new Error(`The Side Panel did not list the selected Chat: ${JSON.stringify(pickerRows)}`);
  await panel.evaluate(`document.querySelector('${chatSelector}').click()`);
  await panel.wait(
    "document.getElementById('chat-frame') && document.getElementById('chat-frame').contentDocument?.getElementById('connection-state')?.dataset.state === 'connected'",
    15_000,
  );
  const primaryWindowId = await panel.evaluate(
    "(async () => (await chrome.windows.getCurrent()).id)()",
  );
  const width380 = await readPanelLayout(panel);
  assertPanelFillsHeight(width380);
  await panel.capture("side-panel-380px-page-only.png");
  return { panel, chatSelector, primaryWindowId, width380 };
}

async function reloadSelectedPanel(panel, chatSelector, chatId) {
  await panel.evaluate("document.getElementById('chat-picker-trigger').click()");
  await panel.wait(
    `document.querySelector('${chatSelector}')?.getAttribute('aria-selected') === 'true'`,
  );
  await panel.evaluate("location.reload()");
  await panel.wait("document.getElementById('panel-status')?.textContent === ''", 15_000);
  await panel.evaluate("document.getElementById('chat-picker-trigger').click()");
  await panel.wait(
    `document.querySelector('${chatSelector}')?.getAttribute('aria-selected') === 'true'`,
  );
  const restored = await panel.evaluate(
    `(async () => { const selected = document.querySelector('${chatSelector}'); const frame = document.getElementById('chat-frame'); const window = await chrome.windows.getCurrent(); const key = 'pippin-selected-chat-' + window.id; return {savedChatId: (await chrome.storage.session.get(key))[key] ?? null, selected: selected?.getAttribute('aria-selected') === 'true', framePresent: Boolean(frame), frameConnection: frame?.contentDocument?.getElementById('connection-state')?.dataset.state ?? null, status: document.getElementById('panel-status')?.textContent}; })()`,
  );
  if (
    restored.savedChatId !== chatId ||
    !restored.selected ||
    restored.frameConnection !== "connected"
  )
    throw new Error(
      `The Side Panel did not restore its Chat after reload: ${JSON.stringify(restored)}`,
    );
  const savedChatId = await readWindowSelection(panel);
  if (savedChatId !== chatId)
    throw new Error("Side Panel Chat selection was not persisted after reload.");
  return true;
}

async function verifyWindowIsolation(browser, attachPage, extensionId, primaryWindowId) {
  const target = await browser.send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/sidepanel.html`,
    newWindow: true,
  });
  const panel = await attachPage(target.targetId, 380, 900);
  await panel.wait("Boolean(document.getElementById('panel-empty'))");
  const current = await panel.evaluate(
    `(async () => { const window = await chrome.windows.getCurrent(); const key = 'pippin-selected-chat-' + window.id; return {id: window.id, selected: (await chrome.storage.session.get(key))[key] ?? null}; })()`,
  );
  if (current.id === primaryWindowId || current.selected !== null)
    throw new Error("Side Panel selection leaked across browser windows.");
  panel.close();
  return true;
}

async function capturePicker(panel, chatSelector) {
  await panel.evaluate(
    "if (!document.getElementById('chat-picker-menu')) document.getElementById('chat-picker-trigger').click()",
  );
  await panel.wait("Boolean(document.getElementById('chat-picker-menu'))");
  await panel.wait(
    `document.querySelector('${chatSelector}')?.getAttribute('aria-selected') === 'true'`,
  );
  await panel.capture("side-panel-picker-open-page-only.png");
}

async function verifyTabSwitch(panel, chatId) {
  await panel.evaluate("chrome.tabs.create({url: 'about:blank'})");
  await panel.wait(
    `document.getElementById('selected-chat-title').textContent === ${JSON.stringify("Create a concise checklist for the local fixture")}`,
  );
  const selectedChatId = await readWindowSelection(panel);
  if (selectedChatId !== chatId)
    throw new Error("Side Panel Chat selection changed after a tab switch.");
  return true;
}

async function captureCompactPanel(panel, attachPage, waitForTarget) {
  await panel.evaluate("document.getElementById('picker-all-chats').click()");
  const target = await waitForTarget((item) => item.url.includes("/home.html?view=chats"));
  const catalog = await attachPage(target.targetId, 1100, 800);
  await catalog.wait("Boolean(document.getElementById('home-catalog'))");
  await panel.setViewport(320, 800);
  const layout = await readPanelLayout(panel);
  assertPanelFillsHeight(layout);
  await panel.capture("side-panel-320px-page-only.png");
  return layout;
}

async function readWindowSelection(panel) {
  return panel.evaluate(
    `(async () => { const window = await chrome.windows.getCurrent(); const key = 'pippin-selected-chat-' + window.id; return (await chrome.storage.session.get(key))[key]; })()`,
  );
}

async function readPanelLayout(panel) {
  return panel.evaluate(
    `(() => { const rect = (selector) => { const box = document.querySelector(selector).getBoundingClientRect(); return {left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height}; }; return {viewport: {width: innerWidth, height: innerHeight}, header: rect('.panel-header'), picker: rect('#chat-picker-trigger'), chatFrame: rect('#chat-frame')}; })()`,
  );
}

function assertPanelFillsHeight(layout) {
  if (layout.chatFrame.height < layout.viewport.height - layout.header.height - 1)
    throw new Error(
      `The side-panel Chat frame does not fill its viewport: ${JSON.stringify(layout)}`,
    );
}
