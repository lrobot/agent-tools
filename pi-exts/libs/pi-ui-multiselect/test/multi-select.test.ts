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

  // Render and check badges in left and right columns
  const lines = list.render(80);
  assert.ok(lines.some((l) => l.includes("[1]") && l.includes("model-b")), "left pane has [1] for model-b");
  assert.ok(lines.some((l) => l.includes("1.") && l.includes("model-b") && l.includes("Primary")), "right pane has 1. model-b (Primary)");
  assert.ok(lines.some((l) => l.includes("[2]") && l.includes("model-c")), "left pane has [2] for model-c");
  assert.ok(lines.some((l) => l.includes("2.") && l.includes("model-c") && l.includes("Failover 1")), "right pane has 2. model-c (Failover 1)");
  assert.ok(lines.some((l) => l.includes("[ ]") && l.includes("model-a")), "left pane has [ ] for model-a");
});

test("MultiSelectList navigation wrap-around and cursor bounds", () => {
  const items = ["first", "middle", "last"];
  const list = new MultiSelectList({ items });

  assert.equal(list.getCursorAvailable(), 0);

  // Up from 0 wraps to last item
  list.handleInput("\x1b[A");
  assert.equal(list.getCursorAvailable(), 2);

  // Down from last wraps to 0
  list.handleInput("\x1b[B");
  assert.equal(list.getCursorAvailable(), 0);
});

test("MultiSelectList search filtering and selection persistence", () => {
  const items = [
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro",
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "anthropic/claude-sonnet-4-5",
  ];
  const list = new MultiSelectList({ items });

  // 1. Select the first item (deepseek flash)
  list.handleInput(" ");
  assert.deepEqual(list.getSelectedValues(), ["deepseek/deepseek-v4-flash"]);

  // 2. Type "gpt" in search
  list.handleInput("g");
  list.handleInput("p");
  list.handleInput("t");
  assert.equal(list.getSearchQuery(), "gpt");

  const filtered = list.getFilteredItems();
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].value, "openai/gpt-4o");
  assert.equal(filtered[1].value, "openai/gpt-4o-mini");

  // Even though deepseek-v4-flash is filtered out of view, it is STILL selected!
  assert.deepEqual(list.getSelectedValues(), ["deepseek/deepseek-v4-flash"]);

  // 3. Select gpt-4o from filtered list
  list.handleInput(" ");
  assert.deepEqual(list.getSelectedValues(), ["deepseek/deepseek-v4-flash", "openai/gpt-4o"]);

  // 4. Backspace twice to "g"
  list.handleInput("\x7f");
  list.handleInput("\x7f");
  assert.equal(list.getSearchQuery(), "g");

  // 5. Ctrl+U clears search query
  list.handleInput("\x15");
  assert.equal(list.getSearchQuery(), "");
  assert.equal(list.getFilteredItems().length, 5);
  assert.deepEqual(list.getSelectedValues(), ["deepseek/deepseek-v4-flash", "openai/gpt-4o"]);
});

test("MultiSelectList Tab focus switching, remove, and reordering", () => {
  const items = ["model-1", "model-2", "model-3", "model-4"];
  const list = new MultiSelectList({
    items,
    initialSelected: ["model-1", "model-2", "model-3"],
  });

  assert.equal(list.getFocusPane(), "available");

  // Tab switches to selected pane
  list.handleInput("\t");
  assert.equal(list.getFocusPane(), "selected");
  assert.equal(list.getCursorSelected(), 0);

  // In selected pane, move down to model-2
  list.handleInput("\x1b[B");
  assert.equal(list.getCursorSelected(), 1);

  // Reorder: Move model-2 UP to index 0 using '['
  list.handleInput("[");
  assert.deepEqual(list.getSelectedValues(), ["model-2", "model-1", "model-3"]);
  assert.equal(list.getCursorSelected(), 0);

  // Reorder: Move model-2 DOWN to index 1 using ']'
  list.handleInput("]");
  assert.deepEqual(list.getSelectedValues(), ["model-1", "model-2", "model-3"]);
  assert.equal(list.getCursorSelected(), 1);

  // Reorder with Alt+Up / Alt+Down escape codes
  list.handleInput("\x1b\x1b[A"); // Alt+Up
  assert.deepEqual(list.getSelectedValues(), ["model-2", "model-1", "model-3"]);

  // Remove model-2 from selected list with Space or 'd'
  list.handleInput("d");
  assert.deepEqual(list.getSelectedValues(), ["model-1", "model-3"]);

  // Tab switches back to available pane
  list.handleInput("\t");
  assert.equal(list.getFocusPane(), "available");
});

test("MultiSelectList dual-pane rendering vs stacked rendering", () => {
  const items = ["alpha", "beta", "gamma"];
  const list = new MultiSelectList({
    items,
    initialSelected: ["alpha", "beta"],
    title: "Dual Pane Test",
  });

  // Wide terminal >= 80 renders side-by-side with '│' divider
  const wideLines = list.render(90);
  assert.ok(wideLines.some((l) => l.includes("AVAILABLE CANDIDATES") && l.includes("│") && l.includes("SELECTED BACKENDS")));
  assert.ok(wideLines.some((l) => l.includes("alpha") && l.includes("│")));

  // Narrow terminal < 80 renders stacked layout
  const narrowLines = list.render(60);
  assert.ok(narrowLines.some((l) => l.includes("Available (3)")));
  assert.ok(narrowLines.some((l) => l.includes("Selected (2)")));
});

test("MultiSelectList checkbox mode: select-all and toggle", () => {
  const items = ["feat1", "feat2", "feat3"];
  const list = new MultiSelectList({
    items,
    mode: "checkbox",
  });

  // Ctrl+A (\x01) selects all
  list.handleInput("\x01");
  assert.deepEqual(list.getSelectedValues(), ["feat1", "feat2", "feat3"]);

  // Ctrl+A again clears all
  list.handleInput("\x01");
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
