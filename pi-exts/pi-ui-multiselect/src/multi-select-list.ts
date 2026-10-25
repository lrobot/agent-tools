import type {
  KeybindingsLike,
  MultiSelectItem,
  MultiSelectListOptions,
  MultiSelectMode,
  MultiSelectTheme,
} from "./types.ts";
import { truncateToWidth, visibleWidth } from "./utils.ts";

const DEFAULT_THEME: MultiSelectTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  dim: (text) => text,
};

const DEFAULT_KEYBINDINGS: KeybindingsLike = {
  matches(keyData, action) {
    if (action === "tui.select.up") return keyData === "\x1b[A" || keyData === "k";
    if (action === "tui.select.down") return keyData === "\x1b[B" || keyData === "j";
    if (action === "tui.select.confirm") return keyData === "\r" || keyData === "\n";
    if (action === "tui.select.cancel") return keyData === "\x1b" || keyData === "\x03";
    return false;
  },
};

export class MultiSelectList {
  private items: MultiSelectItem[];
  private selected: string[];
  private cursor = 0;
  private mode: MultiSelectMode;
  private maxVisible: number;
  private theme: MultiSelectTheme;
  private keybindings: KeybindingsLike;
  private title?: string;
  private hint?: string;

  public onConfirm?: (selected: string[]) => void;
  public onCancel?: () => void;
  public onChange?: (selected: string[]) => void;
  public onRequestRender?: () => void;

  constructor(options: MultiSelectListOptions) {
    this.items = options.items.map((item) =>
      typeof item === "string" ? { value: item, label: item } : { ...item, label: item.label ?? item.value },
    );
    this.selected = [...(options.initialSelected ?? [])];
    this.mode = options.mode ?? "ordered";
    this.maxVisible = Math.max(1, options.maxVisible ?? 10);
    this.theme = options.theme ?? DEFAULT_THEME;
    this.keybindings = options.keybindings ?? DEFAULT_KEYBINDINGS;
    this.title = options.title;
    this.hint = options.hint;
    this.onConfirm = options.onConfirm;
    this.onCancel = options.onCancel;
    this.onChange = options.onChange;
    this.onRequestRender = options.onRequestRender;
  }

  getSelectedValues(): string[] {
    return [...this.selected];
  }

  setSelectedValues(values: string[]): void {
    this.selected = [...values];
    this.notifyChange();
  }

  getCursorIndex(): number {
    return this.cursor;
  }

  setCursorIndex(index: number): void {
    if (this.items.length === 0) return;
    this.cursor = Math.max(0, Math.min(index, this.items.length - 1));
    this.invalidate();
  }

  invalidate(): void {
    this.onRequestRender?.();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const effectiveWidth = Math.max(20, width);

    // 1. Title header
    if (this.title) {
      lines.push(this.theme.bold(this.theme.fg("accent", this.title)));
    }

    // 2. Navigation hint
    const defaultHint =
      this.mode === "ordered"
        ? "↑/↓ move  Space toggle/rank  Enter confirm  Esc cancel"
        : "↑/↓ move  Space toggle  'a' toggle-all  Enter confirm  Esc cancel";
    const hintText = this.hint ?? defaultHint;
    const dimFn = this.theme.dim ?? ((t: string) => this.theme.fg("dim", t));
    lines.push(dimFn(hintText));

    // 3. Empty state
    if (this.items.length === 0) {
      lines.push(this.theme.fg("warning", "  No items to select"));
      return lines;
    }

    // 4. Viewport calculation
    const { startIndex, endIndex } = this.getVisibleRange();
    const primaryColumnWidth = this.getPrimaryColumnWidth(effectiveWidth);

    // 5. Render visible items
    for (let i = startIndex; i < endIndex; i++) {
      const item = this.items[i];
      if (!item) continue;
      const isCursor = i === this.cursor;
      const isSelected = this.selected.includes(item.value);
      const orderIdx = this.selected.indexOf(item.value);

      lines.push(
        this.renderRow(item, isCursor, isSelected, orderIdx, effectiveWidth, primaryColumnWidth),
      );
    }

    // 6. Footer summary
    const countInfo =
      this.mode === "ordered"
        ? `  (${this.selected.length}/${this.items.length} backends selected, cursor ${this.cursor + 1}/${this.items.length})`
        : `  (${this.selected.length}/${this.items.length} selected, cursor ${this.cursor + 1}/${this.items.length})`
    lines.push(dimFn(countInfo));

    return lines;
  }

  handleInput(data: string): void {
    if (this.items.length === 0) {
      if (this.matchesAction(data, "tui.select.cancel")) this.onCancel?.();
      return;
    }

    // Up arrow navigation
    if (this.matchesAction(data, "tui.select.up") || data === "\x1b[A" || data === "k") {
      this.cursor = this.cursor === 0 ? this.items.length - 1 : this.cursor - 1;
      this.invalidate();
      return;
    }

    // Down arrow navigation
    if (this.matchesAction(data, "tui.select.down") || data === "\x1b[B" || data === "j") {
      this.cursor = this.cursor === this.items.length - 1 ? 0 : this.cursor + 1;
      this.invalidate();
      return;
    }

    // Space: toggle selection
    if (data === " ") {
      const current = this.items[this.cursor];
      if (current && !current.disabled) {
        this.toggleItem(current.value);
      }
      return;
    }

    // 'a' key: toggle all (in checkbox mode)
    if (data === "a" || data === "A") {
      if (this.mode === "checkbox") {
        if (this.selected.length === this.items.length) {
          this.selected = [];
        } else {
          this.selected = this.items.filter((item) => !item.disabled).map((item) => item.value);
        }
        this.notifyChange();
        this.invalidate();
      }
      return;
    }

    // Enter: confirm
    if (this.matchesAction(data, "tui.select.confirm") || data === "\r" || data === "\n") {
      // If nothing selected yet in ordered mode, auto-select current item
      if (this.selected.length === 0 && this.items[this.cursor] && !this.items[this.cursor].disabled) {
        this.selected.push(this.items[this.cursor].value);
      }
      this.onConfirm?.([...this.selected]);
      return;
    }

    // Esc: cancel
    if (this.matchesAction(data, "tui.select.cancel") || data === "\x1b" || data === "\x03") {
      this.onCancel?.();
      return;
    }
  }

  handleMouse(event: { type: string; wheelDelta?: number; button?: string }): { handled: boolean } | undefined {
    if (event.type === "wheel" && event.wheelDelta) {
      const delta = event.wheelDelta < 0 ? -1 : 1;
      this.cursor = Math.max(0, Math.min(this.items.length - 1, this.cursor + delta));
      this.invalidate();
      return { handled: true };
    }
    return undefined;
  }

  private toggleItem(value: string): void {
    const idx = this.selected.indexOf(value);
    if (idx >= 0) {
      this.selected.splice(idx, 1);
    } else {
      this.selected.push(value);
    }
    this.notifyChange();
    this.invalidate();
  }

  private notifyChange(): void {
    this.onChange?.([...this.selected]);
  }

  private matchesAction(data: string, action: string): boolean {
    try {
      return this.keybindings.matches(data, action);
    } catch {
      return false;
    }
  }

  private getVisibleRange(): { startIndex: number; endIndex: number } {
    const total = this.items.length;
    if (total <= this.maxVisible) {
      return { startIndex: 0, endIndex: total };
    }

    const half = Math.floor(this.maxVisible / 2);
    let start = Math.max(0, this.cursor - half);
    if (start + this.maxVisible > total) {
      start = total - this.maxVisible;
    }
    return {
      startIndex: start,
      endIndex: start + this.maxVisible,
    };
  }

  private getPrimaryColumnWidth(availableWidth: number): number {
    const maxItemWidth = this.items.reduce((max, item) => {
      const label = item.label || item.value;
      return Math.max(max, visibleWidth(label) + 2);
    }, 20);

    const cap = Math.floor(availableWidth * 0.55);
    return Math.min(Math.max(maxItemWidth, 24), Math.max(24, cap));
  }

  private renderRow(
    item: MultiSelectItem,
    isCursor: boolean,
    isSelected: boolean,
    orderIdx: number,
    totalWidth: number,
    primaryWidth: number,
  ): string {
    const pointer = isCursor ? this.theme.fg("accent", "→ ") : "  ";

    let checkMark = "";
    let roleBadge = "";
    const dimFn = this.theme.dim ?? ((t: string) => this.theme.fg("dim", t));

    if (this.mode === "ordered") {
      if (isSelected) {
        checkMark = this.theme.fg("success", `[${orderIdx + 1}]`);
        if (orderIdx === 0) roleBadge = this.theme.fg("accent", " (Primary)");
        else if (orderIdx > 0) roleBadge = dimFn(` (Failover ${orderIdx})`);
      } else {
        checkMark = dimFn("[ ]");
      }
    } else {
      checkMark = isSelected ? this.theme.fg("success", "[x]") : dimFn("[ ]");
    }

    const displayLabel = item.label || item.value;
    const labelText = isCursor ? this.theme.bold(displayLabel) : displayLabel;

    // Spacing between column and description
    const rawLabelWidth = visibleWidth(displayLabel);
    const spacingCount = Math.max(2, primaryWidth - rawLabelWidth);
    const spacing = " ".repeat(spacingCount);

    let row = `${pointer}${checkMark} ${labelText}${roleBadge}`;

    if (item.description && totalWidth > 60) {
      const prefixWidth = visibleWidth(`${pointer}${checkMark} `);
      const usedWidth = prefixWidth + rawLabelWidth + visibleWidth(roleBadge) + spacingCount;
      const remainingWidth = totalWidth - usedWidth - 2;

      if (remainingWidth > 10) {
        const descText = dimFn(truncateToWidth(item.description, remainingWidth, ""));
        row = `${pointer}${checkMark} ${labelText}${roleBadge}${spacing}${descText}`;
      }
    }

    return truncateToWidth(row, totalWidth, "");
  }
}
