# pi-tui-multiselect-list

Interactive multi-select list component for Pi terminal UI applications and extensions, featuring **ordered priority ranking** (ideal for multi-backend routers and failover pools) and standard **checkbox toggling**.

```text
┌─ Configure Flash Tier Backends ───────────────────────────────┐
│  ↑/↓ move  Space toggle/rank  Enter save  Esc cancel           │
│                                                               │
│  → [1] deepseek/deepseek-v4-flash     (Primary)               │
│    [2] openai/gpt-4o-mini             (Failover 1)            │
│    [3] cc-switch.../mimo-v2.6-flash   (Failover 2)            │
│    [ ] google/gemini-2.5-flash                                │
│    [ ] mistral/mistral-small-3                                │
│                                                               │
│  (3/5 backends selected)                                      │
└───────────────────────────────────────────────────────────────┘
```

## Features

- **Ordered Priority Mode (`mode: "ordered"`)**: Selections receive ordered rank numbers (`[1]`, `[2]`, `[3]`) and role labels (`Primary`, `Failover 1`, `Failover 2`). Deselecting an item automatically shifts and re-indexes subsequent ranks.
- **Checkbox Mode (`mode: "checkbox"`)**: Standard boolean selection (`[x]`, `[ ]`) with `'a'` key shortcut for select-all / deselect-all.
- **Pi Native Architecture**: Built on Pi's official `ctx.ui.custom()` API with zero modification to Pi's core source.
- **Smooth Scrolling & Layout**: Ported from Pi's built-in `SelectList` viewport algorithm (`getVisibleRange`) with ANSI-safe width calculation and multi-column alignment.
- **Keyboard & Mouse Support**: Arrow navigation (`↑`/`↓` or `k`/`j`), Space toggle, Enter confirm, Esc cancel, and mouse wheel scrolling.

## Installation

```bash
pnpm add pi-tui-multiselect-list
# or
npm install pi-tui-multiselect-list
```

## Quick Start (Async Dialog)

Use the high-level `promptMultiSelect()` helper in any Pi extension command:

```typescript
import { promptMultiSelect } from "pi-tui-multiselect-list";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pick-models", {
    description: "Configure failover models",
    handler: async (_args, ctx) => {
      const selected = await promptMultiSelect(ctx, {
        title: "Select Models for Flash Tier",
        items: [
          { value: "deepseek/deepseek-v4-flash", label: "deepseek/deepseek-v4-flash", description: "Fast & cheap" },
          { value: "openai/gpt-4o-mini", label: "openai/gpt-4o-mini", description: "OpenAI backup" },
          { value: "google/gemini-2.5-flash", label: "google/gemini-2.5-flash" },
        ],
        initialSelected: ["deepseek/deepseek-v4-flash"],
        mode: "ordered", // or "checkbox"
        maxVisible: 10,
      });

      if (selected) {
        ctx.ui.notify(`Selected in order: ${selected.join(" -> ")}`, "info");
      }
    },
  });
}
```

## Advanced Component Usage

You can embed `MultiSelectList` directly in custom overlays or dashboards:

```typescript
import { MultiSelectList } from "pi-tui-multiselect-list";

await ctx.ui.custom<string[] | undefined>((tui, theme, keybindings, done) => {
  const list = new MultiSelectList({
    items: candidates,
    initialSelected: ["model-a"],
    mode: "ordered",
    theme,
    keybindings,
    onConfirm: (selected) => done(selected),
    onCancel: () => done(undefined),
    onRequestRender: () => tui.requestRender(),
  });

  return list;
});
```

## API Reference

### `promptMultiSelect(ctx, options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `title` | `string` | `""` | Header title displayed above the list |
| `items` | `(string \| MultiSelectItem)[]` | *required* | Options to display |
| `initialSelected` | `string[]` | `[]` | Initially selected values in order |
| `mode` | `"ordered" \| "checkbox"` | `"ordered"` | Selection mode |
| `maxVisible` | `number` | `10` | Maximum number of visible items before scrolling |
| `hint` | `string` | auto | Custom keyboard navigation hint |

### `MultiSelectItem`

```typescript
interface MultiSelectItem {
  value: string;
  label?: string;
  description?: string;
  disabled?: boolean;
}
```

## License

MIT © [lrobot](https://github.com/lrobot)
