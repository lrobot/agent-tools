import type {
  KeybindingsLike,
  MultiSelectItem,
  MultiSelectListOptions,
  MultiSelectMode,
  MultiSelectTheme,
  PaneFocus,
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
  private searchQuery = "";
  private focusPane: PaneFocus = "available";
  private cursorAvailable = 0;
  private cursorSelected = 0;
  private mode: MultiSelectMode;
  private maxVisible: number;
  private showSearch: boolean;
  private dualPane: boolean;
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
    this.maxVisible = Math.max(3, options.maxVisible ?? 10);
    this.showSearch = options.showSearch ?? true;
    this.dualPane = options.dualPane ?? true;
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
    if (this.cursorSelected >= this.selected.length) {
      this.cursorSelected = Math.max(0, this.selected.length - 1);
    }
    this.notifyChange();
    this.invalidate();
  }

  getFocusPane(): PaneFocus {
    return this.focusPane;
  }

  setFocusPane(pane: PaneFocus): void {
    if (pane === "selected" && this.selected.length === 0) return;
    this.focusPane = pane;
    this.invalidate();
  }

  getSearchQuery(): string {
    return this.searchQuery;
  }

  setSearchQuery(query: string): void {
    this.searchQuery = query;
    this.cursorAvailable = 0;
    this.invalidate();
  }

  getCursorAvailable(): number {
    return this.cursorAvailable;
  }

  getCursorSelected(): number {
    return this.cursorSelected;
  }

  invalidate(): void {
    this.onRequestRender?.();
  }

  /** Move a selected item to a new index, adjusting priority ranking. */
  moveSelectedItem(fromIndex: number, toIndex: number): boolean {
    if (
      fromIndex < 0 ||
      fromIndex >= this.selected.length ||
      toIndex < 0 ||
      toIndex >= this.selected.length ||
      fromIndex === toIndex
    ) {
      return false;
    }
    const [item] = this.selected.splice(fromIndex, 1);
    if (!item) return false;
    this.selected.splice(toIndex, 0, item);
    this.cursorSelected = toIndex;
    this.notifyChange();
    this.invalidate();
    return true;
  }

  /** Remove a selected item at the specified index. */
  removeSelectedItem(index: number): boolean {
    if (index < 0 || index >= this.selected.length) return false;
    this.selected.splice(index, 1);
    if (this.cursorSelected >= this.selected.length) {
      this.cursorSelected = Math.max(0, this.selected.length - 1);
    }
    if (this.selected.length === 0) {
      this.focusPane = "available";
    }
    this.notifyChange();
    this.invalidate();
    return true;
  }

  /** Get current candidates filtered by the search query. */
  getFilteredItems(): MultiSelectItem[] {
    const q = this.searchQuery.trim().toLowerCase();
    if (!q) return this.items;
    return this.items.filter(
      (item) => item.value.toLowerCase().includes(q) || (item.label && item.label.toLowerCase().includes(q)),
    );
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const totalWidth = Math.max(20, width);
    const dimFn = this.theme.dim ?? ((t: string) => this.theme.fg("dim", t));

    // 1. Header Title
    if (this.title) {
      lines.push(this.theme.bold(this.theme.fg("accent", this.title)));
    }

    // 2. Search Input bar
    if (this.showSearch) {
      const cursorMarker = this.focusPane === "available" ? "▏" : "";
      const searchDisplay = this.searchQuery ? `${this.searchQuery}${cursorMarker}` : `${dimFn("type to search...")}${cursorMarker}`;
      const searchBar = `${this.theme.bold("Search:")} [ ${searchDisplay} ]`;
      lines.push(truncateToWidth(searchBar, totalWidth, ""));
    }

    // 3. Navigation Controls Hint
    const isDual = this.dualPane && totalWidth >= 80;
    const defaultHint = isDual
      ? "[Tab] Switch Pane  │  [Space] Toggle/Remove  │  [/] Reorder  │  [Enter] Save  │  [Esc] Cancel"
      : "[Tab] Switch  │  [Space] Toggle  │  [Enter] Save  │  [Esc] Cancel";
    lines.push(dimFn(this.hint ?? defaultHint));

    // 4. Content Area
    const filtered = this.getFilteredItems();
    if (isDual) {
      lines.push(...this.renderDualPane(totalWidth, filtered));
    } else {
      lines.push(...this.renderStacked(totalWidth, filtered));
    }

    // 5. Active Pane Status Footer
    const activeText =
      this.focusPane === "available"
        ? `Pane: Available Candidates (${filtered.length}/${this.items.length}) - Space toggles, Tab switches to Selected`
        : `Pane: Selected Backends (${this.selected.length}) - [/] or Alt+↑/↓ reorders priority, Space/d removes`;
    lines.push(dimFn(`  ${activeText}`));

    return lines;
  }

  handleInput(data: string): void {
    // 1. Global Confirm (Enter)
    if (this.matchesAction(data, "tui.select.confirm") || data === "\r" || data === "\n") {
      const filtered = this.getFilteredItems();
      if (
        this.selected.length === 0 &&
        filtered[this.cursorAvailable] &&
        !filtered[this.cursorAvailable].disabled
      ) {
        this.selected.push(filtered[this.cursorAvailable].value);
      }
      this.onConfirm?.([...this.selected]);
      return;
    }

    // 2. Global Cancel (Esc / Ctrl+C)
    if (this.matchesAction(data, "tui.select.cancel") || data === "\x1b" || data === "\x03") {
      this.onCancel?.();
      return;
    }

    // 3. Tab: Switch Pane Focus
    if (data === "\t") {
      if (this.focusPane === "available") {
        if (this.selected.length > 0) {
          this.focusPane = "selected";
        }
      } else {
        this.focusPane = "available";
      }
      this.invalidate();
      return;
    }

    // 4. Input Routing per Focused Pane
    if (this.focusPane === "selected") {
      this.handleInputSelected(data);
    } else {
      this.handleInputAvailable(data);
    }
  }

  handleMouse(event: { type: string; wheelDelta?: number }): { handled: boolean } | undefined {
    if (event.type === "wheel" && event.wheelDelta) {
      const delta = event.wheelDelta < 0 ? -1 : 1;
      if (this.focusPane === "selected") {
        this.cursorSelected = Math.max(0, Math.min(this.selected.length - 1, this.cursorSelected + delta));
      } else {
        const filtered = this.getFilteredItems();
        this.cursorAvailable = Math.max(0, Math.min(filtered.length - 1, this.cursorAvailable + delta));
      }
      this.invalidate();
      return { handled: true };
    }
    return undefined;
  }

  private handleInputAvailable(data: string): void {
    const filtered = this.getFilteredItems();

    // Up arrow navigation
    if (this.matchesAction(data, "tui.select.up") || data === "\x1b[A") {
      if (filtered.length > 0) {
        this.cursorAvailable = this.cursorAvailable === 0 ? filtered.length - 1 : this.cursorAvailable - 1;
        this.invalidate();
      }
      return;
    }

    // Down arrow navigation
    if (this.matchesAction(data, "tui.select.down") || data === "\x1b[B") {
      if (filtered.length > 0) {
        this.cursorAvailable = this.cursorAvailable === filtered.length - 1 ? 0 : this.cursorAvailable + 1;
        this.invalidate();
      }
      return;
    }

    // Space: Toggle selection
    if (data === " ") {
      const current = filtered[this.cursorAvailable];
      if (current && !current.disabled) {
        this.toggleItem(current.value);
      }
      return;
    }

    // Ctrl+A (\x01) or 'a' (when search is disabled): Toggle all in checkbox mode
    if ((data === "\x01" || (!this.showSearch && (data === "a" || data === "A"))) && this.mode === "checkbox") {
      if (this.selected.length === this.items.length) {
        this.selected = [];
      } else {
        this.selected = this.items.filter((item) => !item.disabled).map((item) => item.value);
      }
      this.notifyChange();
      this.invalidate();
      return;
    }

    // Backspace: Delete character from search query
    if (data === "\x7f" || data === "\b") {
      if (this.searchQuery.length > 0) {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this.cursorAvailable = 0;
        this.invalidate();
      }
      return;
    }

    // Ctrl+U or Ctrl+K: Clear search query
    if (data === "\x15" || data === "\x0b") {
      this.searchQuery = "";
      this.cursorAvailable = 0;
      this.invalidate();
      return;
    }

    // Printable character: append to search query
    if (data.length === 1 && data >= " " && data !== "\x7f") {
      this.searchQuery += data;
      this.cursorAvailable = 0;
      this.invalidate();
    }
  }

  private handleInputSelected(data: string): void {
    if (this.selected.length === 0) {
      this.focusPane = "available";
      this.invalidate();
      return;
    }

    // Up navigation
    if (this.matchesAction(data, "tui.select.up") || data === "\x1b[A" || data === "k") {
      this.cursorSelected = this.cursorSelected === 0 ? this.selected.length - 1 : this.cursorSelected - 1;
      this.invalidate();
      return;
    }

    // Down navigation
    if (this.matchesAction(data, "tui.select.down") || data === "\x1b[B" || data === "j") {
      this.cursorSelected = this.cursorSelected === this.selected.length - 1 ? 0 : this.cursorSelected + 1;
      this.invalidate();
      return;
    }

    // Space / d / Delete / Backspace: Remove selected item
    if (data === " " || data === "d" || data === "D" || data === "\x7f" || data === "\x1b[3~") {
      this.removeSelectedItem(this.cursorSelected);
      return;
    }

    // Reorder UP: Alt+Up (\x1b\x1b[A or \x1b[1;3A) or '[' or 'K'
    if (data === "\x1b\x1b[A" || data === "\x1b[1;3A" || data === "[" || data === "K" || data === "-") {
      this.moveSelectedItem(this.cursorSelected, this.cursorSelected - 1);
      return;
    }

    // Reorder DOWN: Alt+Down (\x1b\x1b[B or \x1b[1;3B) or ']' or 'J'
    if (data === "\x1b\x1b[B" || data === "\x1b[1;3B" || data === "]" || data === "J" || data === "+") {
      this.moveSelectedItem(this.cursorSelected, this.cursorSelected + 1);
      return;
    }
  }

  private toggleItem(value: string): void {
    const idx = this.selected.indexOf(value);
    if (idx >= 0) {
      this.selected.splice(idx, 1);
    } else {
      this.selected.push(value);
    }
    if (this.cursorSelected >= this.selected.length) {
      this.cursorSelected = Math.max(0, this.selected.length - 1);
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

  /** Render side-by-side dual panes: Available on left, Selected on right. */
  private renderDualPane(totalWidth: number, filtered: MultiSelectItem[]): string[] {
    const leftWidth = Math.max(34, Math.floor((totalWidth - 3) * 0.54));
    const rightWidth = Math.max(26, totalWidth - leftWidth - 3);

    const leftLines = this.buildAvailablePaneLines(leftWidth, filtered);
    const rightLines = this.buildSelectedPaneLines(rightWidth);

    const rowCount = Math.max(leftLines.length, rightLines.length);
    const combined: string[] = [];

    // Divider header
    const leftHeader = this.padToWidth(
      `${this.theme.bold("AVAILABLE CANDIDATES")} (${filtered.length})${this.focusPane === "available" ? this.theme.fg("accent", " ●") : ""}`,
      leftWidth,
    );
    const rightHeader = this.padToWidth(
      `${this.theme.bold("SELECTED BACKENDS")} (${this.selected.length})${this.focusPane === "selected" ? this.theme.fg("accent", " ●") : ""}`,
      rightWidth,
    );
    combined.push(`${leftHeader} │ ${rightHeader}`);
    combined.push(`${"─".repeat(leftWidth)}─┼─${"─".repeat(rightWidth)}`);

    for (let i = 0; i < rowCount; i++) {
      const leftCol = this.padToWidth(leftLines[i] ?? "", leftWidth);
      const rightCol = this.padToWidth(rightLines[i] ?? "", rightWidth);
      combined.push(`${leftCol} │ ${rightCol}`);
    }

    return combined;
  }

  private buildAvailablePaneLines(paneWidth: number, filtered: MultiSelectItem[]): string[] {
    const lines: string[] = [];
    if (filtered.length === 0) {
      lines.push(this.theme.fg("dim", `  No matches for "${this.searchQuery}"`));
      return lines;
    }

    const { startIndex, endIndex } = this.getVisibleRange(filtered.length, this.cursorAvailable);
    const isFocused = this.focusPane === "available";

    for (let i = startIndex; i < endIndex; i++) {
      const item = filtered[i];
      if (!item) continue;
      const isCursor = isFocused && i === this.cursorAvailable;
      const orderIdx = this.selected.indexOf(item.value);
      const isSelected = orderIdx >= 0;

      lines.push(this.renderAvailableRow(item, isCursor, isSelected, orderIdx, paneWidth));
    }

    if (startIndex > 0 || endIndex < filtered.length) {
      lines.push(this.theme.fg("dim", `  (${this.cursorAvailable + 1}/${filtered.length})`));
    }

    return lines;
  }

  private buildSelectedPaneLines(paneWidth: number): string[] {
    const lines: string[] = [];
    if (this.selected.length === 0) {
      lines.push(this.theme.fg("dim", "  (No models selected yet)"));
      lines.push(this.theme.fg("dim", "  Space in left pane to select"));
      return lines;
    }

    const { startIndex, endIndex } = this.getVisibleRange(this.selected.length, this.cursorSelected);
    const isFocused = this.focusPane === "selected";

    for (let i = startIndex; i < endIndex; i++) {
      const val = this.selected[i];
      const isCursor = isFocused && i === this.cursorSelected;
      const item = this.items.find((it) => it.value === val);
      const label = item?.label ?? val;

      const pointer = isCursor ? this.theme.fg("accent", "→ ") : "  ";
      const rankNum = `${i + 1}. `;
      const role = i === 0 ? this.theme.fg("accent", " (Primary)") : this.theme.fg("dim", ` (Failover ${i})`);
      const rowText = `${pointer}${this.theme.bold(rankNum)}${label}${role}`;
      lines.push(truncateToWidth(rowText, paneWidth, ""));
    }

    if (startIndex > 0 || endIndex < this.selected.length) {
      lines.push(this.theme.fg("dim", `  (${this.cursorSelected + 1}/${this.selected.length})`));
    }

    return lines;
  }

  private renderStacked(width: number, filtered: MultiSelectItem[]): string[] {
    const lines: string[] = [];
    const isFocused = this.focusPane === "available";
    const dimFn = this.theme.dim ?? ((t: string) => this.theme.fg("dim", t));

    // Available Candidates Section
    lines.push(
      this.theme.bold(`Available (${filtered.length})`) +
        (isFocused ? this.theme.fg("accent", " ●") : ""),
    );

    if (filtered.length === 0) {
      lines.push(dimFn(`  No matches for "${this.searchQuery}"`));
    } else {
      const { startIndex, endIndex } = this.getVisibleRange(filtered.length, this.cursorAvailable);
      for (let i = startIndex; i < endIndex; i++) {
        const item = filtered[i];
        if (!item) continue;
        const isCursor = isFocused && i === this.cursorAvailable;
        const orderIdx = this.selected.indexOf(item.value);
        lines.push(this.renderAvailableRow(item, isCursor, orderIdx >= 0, orderIdx, width));
      }
    }

    // Divider
    lines.push("─".repeat(width));

    // Selected Summary Section
    lines.push(
      this.theme.bold(`Selected (${this.selected.length})`) +
        (!isFocused ? this.theme.fg("accent", " ●") : ""),
    );
    if (this.selected.length === 0) {
      lines.push(dimFn("  (None selected)"));
    } else {
      for (let i = 0; i < this.selected.length; i++) {
        const val = this.selected[i];
        const isCursor = !isFocused && i === this.cursorSelected;
        const pointer = isCursor ? this.theme.fg("accent", "→ ") : "  ";
        const role = i === 0 ? this.theme.fg("accent", " (Primary)") : dimFn(` (Failover ${i})`);
        lines.push(`${pointer}${i + 1}. ${val}${role}`);
      }
    }

    return lines;
  }

  private renderAvailableRow(
    item: MultiSelectItem,
    isCursor: boolean,
    isSelected: boolean,
    orderIdx: number,
    paneWidth: number,
  ): string {
    const pointer = isCursor ? this.theme.fg("accent", "→ ") : "  ";
    const dimFn = this.theme.dim ?? ((t: string) => this.theme.fg("dim", t));

    let checkMark = "";
    if (this.mode === "ordered") {
      checkMark = isSelected ? this.theme.fg("success", `[${orderIdx + 1}]`) : dimFn("[ ]");
    } else {
      checkMark = isSelected ? this.theme.fg("success", "[x]") : dimFn("[ ]");
    }

    const displayLabel = item.label || item.value;
    const labelText = isCursor ? this.theme.bold(displayLabel) : displayLabel;
    const row = `${pointer}${checkMark} ${labelText}`;

    return truncateToWidth(row, paneWidth, "");
  }

  private getVisibleRange(total: number, cursor: number): { startIndex: number; endIndex: number } {
    if (total <= this.maxVisible) return { startIndex: 0, endIndex: total };
    const half = Math.floor(this.maxVisible / 2);
    let start = Math.max(0, cursor - half);
    if (start + this.maxVisible > total) {
      start = total - this.maxVisible;
    }
    return {
      startIndex: start,
      endIndex: start + this.maxVisible,
    };
  }

  private padToWidth(str: string, targetWidth: number): string {
    const current = visibleWidth(str);
    if (current >= targetWidth) return truncateToWidth(str, targetWidth, "");
    return str + " ".repeat(targetWidth - current);
  }
}
