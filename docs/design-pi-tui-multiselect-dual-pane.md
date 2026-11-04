# Design: Dual-Pane Multi-Select with Search & Reordering for `pi-tui-multiselect-list`

Status: confirmed (features: search filtering + dual-pane layout + item reordering)
Target package: `agent-tools/pi-exts/pi-ui-multiselect/`
Target git: `git@github.com:lrobot/pi-tui-multiselect-list.git` (v0.2.0)

---

## 1. Overview & Architecture

Upgrade `pi-tui-multiselect-list` from a single-column list to a **full dual-pane Transfer component**:
1. **Real-time Search**: Search input at the top. Typing filters candidates instantly without dropping existing selections.
2. **Dual-Pane Layout**:
   - **Left Pane (Available)**: Shows candidates (filtered by search query), scrollable, with `[1]`, `[2]`, `[ ]` checkmarks.
   - **Right Pane (Selected)**: Shows selected backends in priority order (`1. Primary`, `2. Failover 1`, etc.).
3. **Tab Focus Switching**:
   - `Tab` switches focus between Left (Available) and Right (Selected).
4. **Selected Management & Reordering**:
   - In Right pane: `Space` / `d` / `Delete` removes an item.
   - In Right pane: `Alt+↑` / `Alt+↓` (and fallback keys `[` / `]` or `K` / `J`) reorders the item's priority.
5. **Responsive Fallback**:
   - `width >= 80`: Side-by-side columns (`Left │ Right`).
   - `width < 80`: Stacked layout (Top: search + candidates, Bottom: selected summary list).

---

## 2. Visual Layout (ASCII Mockup)

```text
┌─ Configure Pro Tier Backends ────────────────────────────────────────────────────────┐
│  Search: deep_                                                                        │
│  [Tab] Switch Pane  │  [Space] Toggle/Remove  │  [Enter] Save  │  [Esc] Cancel       │
├────────────────────────────────────────┬─────────────────────────────────────────────┤
│  AVAILABLE CANDIDATES (2 matches)  *   │  SELECTED BACKENDS (2 in priority order)    │
│                                        │                                             │
│  → [1] deepseek/deepseek-v4-pro        │    1. deepseek/deepseek-v4-pro  (Primary)   │
│    [ ] deepseek/deepseek-v4-flash      │    2. openai/gpt-4o             (Failover 1)│
│                                        │                                             │
│                                        │                                             │
│  (2/18 models matching "deep")         │  ([/]: reorder  Space/d: remove)            │
├────────────────────────────────────────┴─────────────────────────────────────────────┤
│  Active: Available Pane (Type to search, ↑/↓ to navigate, Space to toggle)           │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

When user presses `Tab`:
```text
├────────────────────────────────────────┬─────────────────────────────────────────────┤
│  AVAILABLE CANDIDATES (2 matches)      │  SELECTED BACKENDS (2 in priority order)  * │
│                                        │                                             │
│    [1] deepseek/deepseek-v4-pro        │  → 1. deepseek/deepseek-v4-pro  (Primary)   │
│    [ ] deepseek/deepseek-v4-flash      │    2. openai/gpt-4o             (Failover 1)│
│                                        │                                             │
│  (2/18 models matching "deep")         │  (Press Alt+↓ / ']' to swap priority down)  │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Keyboard Map

| Key | Left Pane (Available) | Right Pane (Selected) |
|---|---|---|
| `Tab` | Switch focus to Right Pane | Switch focus to Left Pane |
| `a-z`, `0-9`, `/`, `-`, `.` | Type search query (filters left list) | - |
| `Backspace` | Delete last search character | Remove currently highlighted item |
| `Ctrl+U` / `Ctrl+K` | Clear entire search query | - |
| `↑` / `↓` | Move cursor in available list | Move cursor in selected list |
| `Space` | Toggle select (append to right / remove) | Remove highlighted item |
| `d` / `Delete` | - | Remove highlighted item |
| `Alt+↑` / `[` / `K` | - | Move item up (higher priority) |
| `Alt+↓` / `]` / `J` | - | Move item down (lower priority) |
| `Enter` | Save & Confirm | Save & Confirm |
| `Esc` / `Ctrl+C` | Cancel & Exit | Cancel & Exit |

---

## 4. Implementation Steps

1. **State & Types**:
   - Add `focusPane: "available" | "selected"`.
   - Add `searchQuery: string`, `cursorAvailable: number`, `cursorSelected: number`.
2. **Filtering Logic**:
   - `getFilteredItems()` returns items matching `searchQuery` (substring match on `value` and `label`).
   - Selections (`selected: string[]`) remain decoupled from filtered candidates.
3. **Reordering Engine**:
   - `moveSelectedItem(fromIndex, toIndex)` swaps elements in `selected` array and updates cursor.
4. **Dual Column Renderer**:
   - Dynamic width split: `leftWidth = Math.floor((width - 3) * 0.55)`, `rightWidth = width - leftWidth - 3`.
   - Side-by-side string stitching: `padEnd(left, leftWidth) + " │ " + truncateToWidth(right, rightWidth)`.
   - Height equalization: align vertical length by padding empty lines.
5. **Unit Tests**:
   - Search filtering (positive match, no match, clearing).
   - Selection persistence through search queries.
   - Focus switching (`Tab`).
   - Reordering (`move up`, `move down`, boundary checks).
   - Responsive layout output checks.
6. **Publishing**:
   - Bump version to `0.2.0` in `package.json`.
   - Run `pnpm test` in `agent-tools/pi-exts/pi-ui-multiselect/`.
   - Git commit & subtree push to `git@github.com:lrobot/pi-tui-multiselect-list.git` tag `v0.2.0`.
