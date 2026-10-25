import assert from "node:assert";
import test from "node:test";
import {
  MultiSelectList,
  promptMultiSelect,
  truncateToWidth,
  visibleWidth,
} from "../src/index.ts";

test("visibleWidth and truncateToWidth handling", () => {
  assert.equal(visibleWidth("hello"), 5);
  assert.equal(visibleWidth("你好"), 4);
  assert.equal(visibleWidth("\x1b[32mhello\x1b[0m"), 5);
  assert.equal(visibleWidth("\x1b[1;34m你好世界\x1b[0m"), 8);

  const truncated = truncateToWidth("hello world", 8);
  assert.equal(visibleWidth(truncated), 8);
  assert.ok(truncated.includes("..."));

  const cjkTruncated = truncateToWidth("你好世界测试", 7);
  assert.ok(visibleWidth(cjkTruncated) <= 7);
});

test("MultiSelectList ordered mode: toggle, ranking and re-indexing", () => {
  const items = ["model-a", "model-b", "model-c", "model-d"];
  let renderedCount = 0;
  const list = new MultiSelectList({
    items,
    mode: "ordered",
    onRequestRender: () => renderedCount++,
  });

  assert.deepEqual(list.getSelectedValues(), []);

  // Toggle item 0 (model-a)
  list.handleInput(" ");
  assert.deepEqual(list.getSelectedValues(), ["model-a"]);
  assert.equal(renderedCount, 1);

  // Move down to item 1 (model-b) and toggle
  list.handleInput("\x1b[B"); // Down
  list.handleInput(" ");
  assert.deepEqual(list.getSelectedValues(), ["model-a", "model-b"]);

  // Move down to item 2 (model-c) and toggle
  list.handleInput("\x1b[B"); // Down
  list.handleInput(" ");
  assert.deepEqual(list.getSelectedValues(), ["model-a", "model-b", "model-c"]);

  // Move back up to item 0 (model-a) and deselect it
  list.handleInput("\x1b[A"); // Up to model-b
  list.handleInput("\x1b[A"); // Up to model-a
  list.handleInput(" ");      // Deselect model-a

  // model-b should now be primary, model-c should be failover 1
  assert.deepEqual(list.getSelectedValues(), ["model-b", "model-c"]);

  // Render and check badges
  const lines = list.render(80);
  assert.ok(lines.some((l) => l.includes("[1]") && l.includes("model-b") && l.includes("Primary")));
  assert.ok(lines.some((l) => l.includes("[2]") && l.includes("model-c") && l.includes("Failover 1")));
  assert.ok(lines.some((l) => l.includes("[ ]") && l.includes("model-a")));
});

test("MultiSelectList navigation wrap-around and cursor bounds", () => {
  const items = ["first", "middle", "last"];
  const list = new MultiSelectList({ items });

  assert.equal(list.getCursorIndex(), 0);

  // Up from 0 wraps to last item
  list.handleInput("\x1b[A");
  assert.equal(list.getCursorIndex(), 2);

  // Down from last wraps to 0
  list.handleInput("\x1b[B");
  assert.equal(list.getCursorIndex(), 0);
});

test("MultiSelectList checkbox mode: select-all and toggle", () => {
  const items = ["feat1", "feat2", "feat3"];
  const list = new MultiSelectList({
    items,
    mode: "checkbox",
  });

  // 'a' selects all
  list.handleInput("a");
  assert.deepEqual(list.getSelectedValues(), ["feat1", "feat2", "feat3"]);

  // 'a' again clears all
  list.handleInput("a");
  assert.deepEqual(list.getSelectedValues(), []);

  // Space toggles single
  list.handleInput(" ");
  assert.deepEqual(list.getSelectedValues(), ["feat1"]);
});

test("MultiSelectList confirm and cancel callbacks", () => {
  let confirmed: string[] | undefined;
  let cancelled = false;

  const list = new MultiSelectList({
    items: ["m1", "m2"],
    onConfirm: (res) => (confirmed = res),
    onCancel: () => (cancelled = true),
  });

  // Nothing selected yet, pressing Enter auto-picks current cursor item
  list.handleInput("\r");
  assert.deepEqual(confirmed, ["m1"]);

  // Cancel with Esc
  list.handleInput("\x1b");
  assert.equal(cancelled, true);
});

test("promptMultiSelect async helper execution", async () => {
  let customFactoryCalled = false;
  const mockCtx = {
    hasUI: true,
    mode: "tui",
    ui: {
      custom: async <T>(factory: any) => {
        customFactoryCalled = true;
        const fakeTui = { requestRender: () => {} };
        const fakeTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
        const fakeKb = { matches: () => false };
        return new Promise<T>((resolve) => {
          const component = factory(fakeTui, fakeTheme, fakeKb, (val: T) => resolve(val));
          // simulate confirming selection
          component.handleInput(" ");
          component.handleInput("\r");
        });
      },
    },
  };

  const result = await promptMultiSelect(mockCtx as any, {
    title: "Test Title",
    items: ["item1", "item2"],
  });

  assert.ok(customFactoryCalled);
  assert.deepEqual(result, ["item1"]);
});
