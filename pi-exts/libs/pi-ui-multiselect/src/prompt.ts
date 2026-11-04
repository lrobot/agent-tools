import { MultiSelectList } from "./multi-select-list.ts";
import type { MultiSelectPromptOptions } from "./types.ts";

/** Minimal interface of ExtensionContext needed by promptMultiSelect */
export interface PromptUiContext {
  hasUI?: boolean;
  mode?: string;
  ui?: {
    custom<T>(
      factory: (
        tui: { requestRender: () => void },
        theme: any,
        keybindings: any,
        done: (result: T) => void,
      ) => any,
      options?: { overlay?: boolean; overlayOptions?: any },
    ): Promise<T>;
    notify?(message: string, type?: "info" | "warning" | "error"): void;
  };
}

/**
 * Display an interactive multi-select list dialog in the Pi terminal UI.
 *
 * @param ctx The extension command context (ExtensionContext)
 * @param options Title, items, mode ("ordered" | "checkbox"), and initial selections
 * @returns Array of selected item values (in order of priority if mode is "ordered"),
 *          or undefined if cancelled.
 */
export async function promptMultiSelect(
  ctx: PromptUiContext,
  options: MultiSelectPromptOptions,
): Promise<string[] | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui" || !ctx.ui?.custom) {
    return undefined;
  }

  return ctx.ui.custom<string[] | undefined>(
    (tui, theme, keybindings, done) => {
      const list = new MultiSelectList({
        items: options.items,
        initialSelected: options.initialSelected,
        mode: options.mode ?? "ordered",
        maxVisible: options.maxVisible,
        showSearch: options.showSearch,
        dualPane: options.dualPane,
        title: options.title,
        hint: options.hint,
        theme,
        keybindings,
        onConfirm: (selected) => done(selected),
        onCancel: () => done(undefined),
        onRequestRender: () => tui.requestRender(),
      });

      return list;
    },
    options.overlay ? { overlay: true } : undefined,
  );
}
