import assert from "node:assert/strict";
import test from "node:test";
import { missMessage } from "../dist/attribute-hint.js";

const firstName = {
  tag: "input",
  role: "textbox",
  placeholder: "",
  label: "First name",
  text: "",
};

test("a placeholder miss names the input's aria-label", () => {
  const message = missMessage({ by: "placeholder", value: "First name" }, [firstName]);
  assert.equal(
    message,
    'no placeholder "First name"; an input has aria-label "First name": use getByLabel("First name")',
  );
});

test("a css placeholder selector miss names the same alternative", () => {
  const message = missMessage({ by: "css", value: "input[placeholder='First name']" }, [firstName]);
  assert.match(message, /^no placeholder "First name"/);
  assert.match(message, /use getByLabel\("First name"\)/);
});

test("a label miss points at the placeholder the field does have", () => {
  const message = missMessage({ by: "label", value: "Email" }, [
    { tag: "input", role: "textbox", placeholder: "Email", label: "", text: "" },
  ]);
  assert.equal(
    message,
    'no label "Email"; an input has placeholder "Email": use getByPlaceholder("Email")',
  );
});
