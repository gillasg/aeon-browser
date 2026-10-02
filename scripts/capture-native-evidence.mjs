export const nativeChromeCaptureEvidence = {
  newTab: {
    verified: true,
    trigger:
      "Clicked Chrome's New Tab button and then Keep it in Chrome's native notice, using a fresh disposable profile.",
    documentUrl: "chrome-extension://andklofheekibpgmfkabcpmbbodegiob/home.html",
    windowPx: { width: 1536, height: 817 },
    screenshot: "native-chrome-newtab-override-kept-after-react.jpg",
    noticeScreenshot: "native-chrome-newtab-override-after-react-notice.jpg",
    notice:
      "Chrome displayed its native Change back to Google? notice; Keep it was selected in the disposable profile.",
  },
  nativePanel: {
    verified: true,
    trigger: "Clicked the pinned Pippin toolbar action in Chrome; the native side panel opened.",
    profile: "Fresh disposable Chrome profile; no signed-in default profile used.",
    selectedChat: "New Chat draft restored after switching tabs and closing/reopening the panel.",
    viewportPx: { width: 1536, height: 817 },
    panelWidthPx: 300,
    screenshot: "native-chrome-sidepanel-selected-after-react.jpg",
    providerCalls: 0,
  },
  historicFullWindowScreenshots:
    "The vertical-tabs and empty-panel native Chrome screenshots predate the React migration.",
};
