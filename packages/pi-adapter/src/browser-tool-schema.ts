import { Type } from "typebox";
const targetKey = Type.Object(
  {
    clientInstanceId: Type.String({ format: "uuid" }),
    browserRunId: Type.String({ format: "uuid" }),
    tabId: Type.Integer({ minimum: 0 }),
    tabIncarnation: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);

const element = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("query"),
      by: Type.Union([
        Type.Literal("css"),
        Type.Literal("text"),
        Type.Literal("label"),
        Type.Literal("placeholder"),
      ]),
      value: Type.String({ minLength: 1, maxLength: 512 }),
      exact: Type.Optional(Type.Boolean()),
      scope: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: false },
  ),

  Type.Object(
    {
      kind: Type.Literal("ref"),
      snapshotId: Type.String({ format: "uuid" }),
      ref: Type.String({ pattern: "^e[0-9]{1,4}$" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("locator"),
      role: Type.String({ minLength: 1, maxLength: 80 }),
      name: Type.String({ maxLength: 256 }),
      exact: Type.Optional(Type.Boolean()),
      scope: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("point"),
      screenshotId: Type.String({ format: "uuid" }),
      x: Type.Number({ minimum: 0, maximum: 1 }),
      y: Type.Number({ minimum: 0, maximum: 1 }),
    },
    { additionalProperties: false },
  ),
]);

const semanticElement = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("query"),
      by: Type.Union([
        Type.Literal("css"),
        Type.Literal("text"),
        Type.Literal("label"),
        Type.Literal("placeholder"),
      ]),
      value: Type.String({ minLength: 1, maxLength: 512 }),
      exact: Type.Optional(Type.Boolean()),
      scope: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: false },
  ),

  Type.Object(
    {
      kind: Type.Literal("ref"),
      snapshotId: Type.String({ format: "uuid" }),
      ref: Type.String({ pattern: "^e[0-9]{1,4}$" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("locator"),
      role: Type.String({ minLength: 1, maxLength: 80 }),
      name: Type.String({ maxLength: 256 }),
      exact: Type.Optional(Type.Boolean()),
      scope: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: false },
  ),
]);

const step = Type.Union([
  Type.Object(
    {
      op: Type.Literal("press"),
      target: targetKey,
      element: semanticElement,
      key: Type.Union(
        [
          "Enter",
          "Tab",
          "Escape",
          "Backspace",
          "Delete",
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "Home",
          "End",
          "Space",
        ].map((key) => Type.Literal(key)),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      op: Type.Literal("read"),
      target: targetKey,
      selector: Type.String({ minLength: 1, maxLength: 512 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      textLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4000 })),
      attributes: Type.Optional(
        Type.Array(Type.String({ pattern: "^[\\w-]{1,80}$" }), { maxItems: 10 }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      op: Type.Literal("wait"),
      target: targetKey,
      selector: Type.String({ minLength: 1, maxLength: 512 }),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 8000 })),
      state: Type.Optional(
        Type.Union(
          ["attached", "visible", "hidden", "editable"].map((state) => Type.Literal(state)),
        ),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      op: Type.Literal("navigate"),
      target: targetKey,
      url: Type.String({ format: "uri", maxLength: 8192 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { op: Type.Literal("diagnostics"), target: targetKey, clear: Type.Optional(Type.Boolean()) },
    { additionalProperties: false },
  ),
  Type.Object({ op: Type.Literal("popups"), target: targetKey }, { additionalProperties: false }),

  Type.Object(
    { op: Type.Literal("listTabs"), query: Type.Optional(Type.String({ maxLength: 160 })) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      op: Type.Literal("openTab"),
      clientInstanceId: Type.String({ format: "uuid" }),
      url: Type.String({ format: "uri", maxLength: 8192 }),
      foreground: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { op: Type.Literal("attachTab"), target: targetKey },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      op: Type.Literal("observe"),
      target: targetKey,
      kind: Type.Union([Type.Literal("semantic"), Type.Literal("screenshot")]),
      query: Type.Optional(Type.String({ maxLength: 256 })),
      interactive: Type.Optional(Type.Boolean()),
      selector: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { op: Type.Literal("click"), target: targetKey, element },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      op: Type.Literal("fill"),
      target: targetKey,
      element: semanticElement,
      value: Type.String({ maxLength: 20000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      op: Type.Literal("scroll"),
      target: targetKey,
      element: Type.Optional(semanticElement),
      direction: Type.Union([
        Type.Literal("up"),
        Type.Literal("down"),
        Type.Literal("left"),
        Type.Literal("right"),
      ]),
      amount: Type.Integer({ minimum: 40, maximum: 1200 }),
    },
    { additionalProperties: false },
  ),
]);

export const browserParameters = Type.Object(
  { steps: Type.Array(step, { minItems: 1, maxItems: 8 }) },
  { additionalProperties: false },
);
