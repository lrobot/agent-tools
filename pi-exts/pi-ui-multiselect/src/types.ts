export type MultiSelectMode = "ordered" | "checkbox";

export interface MultiSelectItem {
  value: string;
  label?: string;
  description?: string;
  disabled?: boolean;
}

export interface MultiSelectTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  dim?(text: string): string;
}

export interface KeybindingsLike {
  matches(keyData: string, action: string): boolean;
}

export interface MultiSelectListOptions {
  items: (string | MultiSelectItem)[];
  initialSelected?: string[];
  mode?: MultiSelectMode;
  maxVisible?: number;
  theme?: MultiSelectTheme;
  keybindings?: KeybindingsLike;
  title?: string;
  hint?: string;
  onConfirm?: (selected: string[]) => void;
  onCancel?: () => void;
  onChange?: (selected: string[]) => void;
  onRequestRender?: () => void;
}

export interface MultiSelectPromptOptions {
  title?: string;
  items: (string | MultiSelectItem)[];
  initialSelected?: string[];
  mode?: MultiSelectMode;
  maxVisible?: number;
  hint?: string;
  overlay?: boolean;
}
