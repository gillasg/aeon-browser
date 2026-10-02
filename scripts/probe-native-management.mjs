import assert from "node:assert/strict";
import {
  attachPage,
  installPageCommand,
  pageValue,
  waitUntil,
} from "./probe-browser-control-cft-browser.mjs";

export async function exerciseManagement(send, sourceSessionId) {
  const sourceUrl = await pageValue(send, sourceSessionId, "location.href");
  const home = new URL(sourceUrl);
  home.pathname = "/home.html";
  home.search = "";
  const page = await attachPage(send, home.href);
  try {
    await waitUntil(
      () => pageValue(send, page.sessionId, "document.querySelectorAll('.home-nav-button').length"),
      (count) => count > 0,
      30_000,
      "Management home did not load",
    );
    await installPageCommand(send, page.sessionId);
    const response = await pageValue(
      send,
      page.sessionId,
      'window.__pippinCommand({kind:"management"},"management.get",{})',
      60_000,
      "Management-scoped request",
    );
    assert.equal(response.result?.kind, "management.snapshot");
    await pageValue(
      send,
      page.sessionId,
      `(() => {const button=[...document.querySelectorAll('.home-nav-button')].find(node=>node.textContent.includes('Management')); if(!button) throw new Error('Management navigation unavailable'); button.click(); return true;})()`,
    );
    await waitUntil(
      () =>
        pageValue(
          send,
          page.sessionId,
          `({ready:document.querySelector('.management-heading button')?.textContent.trim()==='Refresh',error:document.querySelector('.management-error')?.textContent??''})`,
        ),
      (state) => state.ready || Boolean(state.error),
      60_000,
      "Management UI did not finish loading",
    );
    const state = await pageValue(
      send,
      page.sessionId,
      `({error:document.querySelector('.management-error')?.textContent??'',sections:[...document.querySelectorAll('.management-nav button')].map(button=>button.textContent.trim())})`,
    );
    assert.equal(state.error, "", `Management UI failed: ${state.error}`);
    assert.equal(state.sections.length, 4);
    return { scopedSnapshot: true, nativeManagementUiLoaded: true, sections: state.sections };
  } finally {
    await send("Target.closeTarget", { targetId: page.targetId });
  }
}
