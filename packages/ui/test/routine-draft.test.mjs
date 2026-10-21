import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readRoutineDraft } from "../dist/routine-draft-route.js";
import { RoutineEditor } from "../dist/management-routine-editor.js";

const search = (draft) =>
  "?view=routines&routineDraft=" + encodeURIComponent(JSON.stringify(draft));
const seed = {
  chatId: "chat-1",
  title: "Watch: price of the Soundcore Q20",
  instruction: "Check the price of the Soundcore Q20.",
  everyMinutes: 15,
};

test("a routine draft in the URL is read and validated", () => {
  assert.deepEqual(readRoutineDraft(search(seed)), seed);
  assert.equal(readRoutineDraft("?view=routines"), undefined);
  assert.equal(readRoutineDraft("?routineDraft=not-json"), undefined);
  assert.equal(readRoutineDraft(search({ ...seed, instruction: "  " })), undefined);
  assert.equal(readRoutineDraft(search({ ...seed, everyMinutes: 1 })).everyMinutes, 5);
  assert.equal(readRoutineDraft(search({ ...seed, everyMinutes: "x" })).everyMinutes, 15);
});

test("the routine editor opens prefilled from a draft", () => {
  const html = renderToStaticMarkup(
    createElement(RoutineEditor, {
      props: {
        snapshot: {
          chats: [
            { chatId: "chat-0", title: "Other" },
            { chatId: "chat-1", title: "Headphones" },
          ],
          routines: [],
        },
      },
      initial: seed,
      onCancel() {},
    }),
  );
  assert.match(html, /New watcher/);
  assert.match(html, /value="Watch: price of the Soundcore Q20"/);
  assert.match(html, /Check the price of the Soundcore Q20\./);
  assert.match(html, /value="15"/);
  assert.match(html, /<option value="chat-1" selected="">/);
});
