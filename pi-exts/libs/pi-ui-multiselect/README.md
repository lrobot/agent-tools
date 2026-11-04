# pi-tui-multiselect-list

Interactive multi-select transfer component for Pi terminal UI applications and extensions, featuring **real-time search filtering**, **dual-pane side-by-side layout**, **priority ranking and reordering** (ideal for multi-backend routers and failover pools), and standard **checkbox toggling**.

```text
┌─ Configure Pro Tier Backends ────────────────────────────────────────────────────────┐
│  Search: deep_                                                                        │
│  [Tab] Switch Pane  │  [Space] Toggle/Remove  │  [/] Reorder  │  [Enter] Save        │
├────────────────────────────────────────┬─────────────────────────────────────────────┤
│  AVAILABLE CANDIDATES (2 matches)  *   │  SELECTED BACKENDS (2 in priority order)    │
│                                        │                                             │
│  → [1] deepseek/deepseek-v4-pro        │    1. deepseek/deepseek-v4-pro  (Primary)   │
│    [ ] deepseek/deepseek-v4-flash      │    2. openai/gpt-4o             (Failover 1)│
│                                        │                                             │
│  (2/18 models matching "deep")         │  (Press [/] or Alt+↑/↓ to adjust priority)  │
├────────────────────────────────────────┴─────────────────────────────────────────────┤
│  Active: Available Pane (Type to search, ↑/↓ to navigate, Space to toggle)           │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## Features

- **Real-Time Search Filtering**: Type characters at any time to instantly filter candidates. Backspace deletes; Ctrl+U clears. Previously selected items remain safely preserved even when filtered out of view.
- **Dual-Pane Transfer Layout**: Side-by-side dual columns on standard terminals (`width >= 80`), with seamless responsive fallback to stacked mode on narrow screens.
- **Tab Focus Switching**: Press `Tab` to switch focus between the Available Candidate pool (left) and the Selected Backends list (right).
- **Ordered Priority Mode & Reordering**:
  - In Available pane: `Space` appends to the selection list or removes it.
  - In Selected pane: `Space` / `d` / `Backspace` removes an item.
  - In Selected pane: `Alt+↑` / `Alt+↓` (or `[` / `]`) **reorders priority rank** (`Primary`, `Failover 1`, `Failover 2`...) in real time.
- **Checkbox Mode (`mode: "checkbox"`)**: Standard boolean selection (`[x]`, `[ ]`) with `Ctrl+A` shortcut to select-all or clear-all.
- **Pi Native Architecture**: Built on Pi's official `ctx.ui.custom()` API with zero modification to Pi's core source.
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
        dualPane: true,  // side-by-side transfer layout
        showSearch: true,// real-time search filtering
        maxVisible: 10,
      });

      if (selected) {
        ctx.ui.notify(`Selected in order: ${selected.join(" -> ")}`, "info");
      }
    },
  });
}
```

## Keyboard Controls

| Key | Left Pane (Available) | Right Pane (Selected) |
|---|---|---|
| `Tab` | Switch focus to Right Pane | Switch focus to Left Pane |
| `a-z`, `0-9`, `/`, `-`, `.` | Type search query (filters candidates) | - |
| `Backspace` | Delete last search character | Remove highlighted item |
| `Ctrl+U` / `Ctrl+K` | Clear search query | - |
| `↑` / `↓` | Move cursor in available list | Move cursor in selected list |
| `Space` | Toggle select (add/remove) | Remove highlighted item |
| `d` / `Delete` | - | Remove highlighted item |
| `Alt+↑` / `[` / `K` | - | Move item up (higher priority) |
| `Alt+↓` / `]` / `J` | - | Move item down (lower priority) |
| `Enter` | Save & Confirm | Save & Confirm |
| `Esc` / `Ctrl+C` | Cancel & Exit | Cancel & Exit |

## API Reference

### `promptMultiSelect(ctx, options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `title` | `string` | `""` | Header title displayed above the list |
| `items` | `(string \| MultiSelectItem)[]` | *required* | Options to display |
| `initialSelected` | `string[]` | `[]` | Initially selected values in order |
| `mode` | `"ordered" \| "checkbox"` | `"ordered"` | Selection mode |
| `dualPane` | `boolean` | `true` | Side-by-side dual-pane layout when width >= 80 |
| `showSearch` | `boolean` | `true` | Show real-time search filter input |
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
