# Design: Reusable Multi-Select TUI Library for Pi (`pi-tui-multiselect-list`)

Status: draft, awaiting user confirmation
Scope: 
- Create new library at `/opt/ops/agent-tools/pi-exts/pi-ui-multiselect/`
- Target remote: `git@github.com:lrobot/pi-tui-multiselect-list.git`
- Integrated into `opt_ops` via `git subtree` workflow

---

## 1. Objectives

1. **Independent & Reusable**:
   Extract and formalize the multi-select TUI capability into a standalone, published-ready npm package that any Pi extension can reuse.
2. **Dual-mode Selection**:
   - **`ordered` mode**: Marks selections in click/toggle sequence (`[1]`, `[2]`, `[3]`, etc.), explicitly showing priority ranking (e.g. `Primary`, `Failover 1`, `Failover 2`). Designed specifically for multi-backend routers, model failover pools, and fallback chains.
   - **`checkbox` mode**: Traditional boolean selection (`[x]`, `[ ]`) for feature toggles, file selectors, etc.
3. **Zero Pi Modification**:
   Built cleanly on top of Pi's official `ctx.ui.custom()` extension API, referencing layout and scroll algorithms from `packages/tui/src/components/select-list.ts` and `config-selector.ts`.
4. **Git Subtree Workflow**:
   The package code lives inside the `/opt/ops` monorepo at `agent-tools/pi-exts/pi-ui-multiselect/`, while being pushable to the standalone GitHub repository `git@github.com:lrobot/pi-tui-multiselect-list.git` via `git subtree split`.

---

## 2. Directory Structure

```text
agent-tools/pi-exts/pi-ui-multiselect/
├── package.json                 # npm metadata (name: "pi-tui-multiselect-list", type: "module")
├── tsconfig.json                # TypeScript build / check config
├── README.md                    # Comprehensive documentation with ASCII mockups & API examples
├── LICENSE                      # MIT License
├── src/
│   ├── index.ts                 # Main entry point (exports component + prompt helper)
│   ├── types.ts                 # MultiSelectItem, MultiSelectOptions, Theme types
│   ├── multi-select-list.ts     # Core TUI Component (scrollable, keybindings, layout)
│   └── prompt.ts                # High-level async dialog wrapper (promptMultiSelect)
└── test/
    └── multi-select.test.ts     # Unit tests for toggle logic, ordered ranking, scrolling, rendering
```

---

## 3. API Design

### 3.1 High-Level Async Helper: `promptMultiSelect`

For typical extension commands, providing a one-line async function:

```typescript
import { promptMultiSelect } from "pi-tui-multiselect-list";

const selectedModels = await promptMultiSelect(ctx, {
  title: "Configure Pro Tier Models (Ordered by Failover Priority)",
  items: [
    { value: "deepseek/deepseek-v4-pro", label: "deepseek/deepseek-v4-pro", description: "Default Pro" },
    { value: "anthropic/claude-sonnet-4-5", label: "anthropic/claude-sonnet-4-5", description: "Backup 1" },
    { value: "openai/gpt-4o", label: "openai/gpt-4o", description: "Backup 2" },
    { value: "mimo/mimo-v2.6-pro", label: "mimo/mimo-v2.6-pro" },
  ],
  initialSelected: ["deepseek/deepseek-v4-pro"],
  mode: "ordered", // "ordered" | "checkbox"
  maxVisible: 10,
  hint: "Space: toggle/order | Enter: confirm | Esc: cancel",
});

if (selectedModels) {
  // selectedModels is string[] in priority order:
  // ["deepseek/deepseek-v4-pro", "anthropic/claude-sonnet-4-5"]
}
```

### 3.2 Low-Level Component: `MultiSelectList`

For custom extension screens, side panels, or overlays:

```typescript
export class MultiSelectList implements Component {
  constructor(options: MultiSelectListOptions);

  // Component interface methods
  render(width: number): string[];
  handleInput(data: string): void;
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  invalidate(): void;

  // State accessors
  getSelectedValues(): string[];
  setSelectedValues(values: string[]): void;
  getCursorIndex(): number;

  // Callbacks
  public onConfirm?: (selected: string[]) => void;
  public onCancel?: () => void;
  public onChange?: (selected: string[]) => void;
}
```

---

## 4. Interaction & Visual Design

### 4.1 Visual Representation (ASCII Mockup)

**In `ordered` mode (Failover Priority Routing):**
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

**In `checkbox` mode (General Multi-Select):**
```text
┌─ Select Enabled Extensions ───────────────────────────────────┐
│  ↑/↓ move  Space toggle  'a' toggle all  Enter save  Esc cancel│
│                                                               │
│  → [x] auto-router                    Routes prompts by diff  │
│    [x] todo                           Task list manager       │
│    [ ] web-search                     Antigravity grounding   │
│    [ ] usage                          Token usage monitor     │
│                                                               │
│  (2/4 enabled)                                                │
└───────────────────────────────────────────────────────────────┘
```

### 4.2 Keyboard Controls
- **`Up` / `Down`** (or `k` / `j`): Move cursor with automatic circular wrapping.
- **`Space`**:
  - `ordered` mode: If not selected, appends item to selection (gets next priority number `[N]`); if already selected, removes item and re-indexes subsequent selections.
  - `checkbox` mode: Toggles `[x]` / `[ ]`.
- **`Enter`**: Confirms and returns the selected values array. If nothing was toggled, defaults to selecting the currently focused item.
- **`Escape` / `Ctrl+C`**: Cancels and returns `undefined`.
- **`a`** (checkbox mode only): Toggle select all / clear all.

### 4.3 Viewport & Width Layout Algorithm
- Ported from `packages/tui/src/components/select-list.ts`:
  - `getVisibleRange()`: Centered scrolling window of `maxVisible` items around the active cursor.
  - Two-column automatic alignment: calculates widest label + gap, and dynamically allocates remaining width for item description.
  - ANSI-safe truncation using `truncateToWidth` and `visibleWidth`.

---

## 5. Subtree & Publishing Workflow

### 5.1 Monorepo Tracking
The directory `/opt/ops/agent-tools/pi-exts/pi-ui-multiselect/` will be committed into `/opt/ops`.

### 5.2 Subtree Split & Push Task
Add a task in `/opt/ops/mise.toml` matching the existing `serialmgr-publish` pattern:

```toml
[tasks.pi-ui-multiselect-publish]
description = "Publish agent-tools/pi-exts/pi-ui-multiselect to standalone repo (git subtree split + push to main)"
run = '''
#!/usr/bin/env bash
set -euo pipefail
remote="${PI_UI_MULTISELECT_REMOTE:-git@github.com:lrobot/pi-tui-multiselect-list.git}"
prefix="agent-tools/pi-exts/pi-ui-multiselect"
if [ -n "$(git status --porcelain -- "$prefix")" ]; then
  echo "$prefix has uncommitted changes; commit first" >&2
  exit 1
fi
sha=$(git subtree split --prefix="$prefix")
echo "==> push $sha -> $remote main"
git push "$remote" "$sha:refs/heads/main"
ver=$(node -p "require('./$prefix/package.json').version")
if git ls-remote --tags "$remote" "refs/tags/v$ver" | grep -q .; then
  echo "==> tag v$ver already on remote"
else
  git push "$remote" "$sha:refs/tags/v$ver"
  echo "==> tagged v$ver on remote"
fi
'''
```

---

## 6. Integration with `pi-tier-router`

Once `pi-tui-multiselect-list` is ready:
1. `pi-tier-router` can reference it (either via pnpm workspace / local file dependency or npm package).
2. Update `/auto-router` command:
   - When entering the wizard, users can directly use the multi-select screen to pick multiple flash models and multiple pro models in one shot.
   - Existing multi-backend lists will be pre-populated (with `initialSelected`), completely preventing accidental overwriting!
