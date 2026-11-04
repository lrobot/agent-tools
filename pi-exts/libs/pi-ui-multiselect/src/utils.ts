const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b_.*?\x1b\\/g;

/** Check if character code represents wide character (CJK, emoji, fullwidth). */
function isWideChar(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x2fffd) ||
    (code >= 0x30000 && code <= 0x3fffd)
  );
}

/** Calculate visible width of terminal string, ignoring ANSI codes and counting wide chars as 2. */
export function visibleWidth(str: string): number {
  if (!str) return 0;
  const stripped = str.replace(ANSI_REGEX, "");
  let width = 0;
  for (let i = 0; i < stripped.length; i++) {
    const code = stripped.codePointAt(i) ?? 0;
    if (code > 0xffff) i++;
    width += isWideChar(code) ? 2 : 1;
  }
  return width;
}

/** Truncate string to maxWidth terminal columns, appending ellipsis if needed. */
export function truncateToWidth(str: string, maxWidth: number, ellipsis = "..."): string {
  if (maxWidth <= 0) return "";
  const currentWidth = visibleWidth(str);
  if (currentWidth <= maxWidth) return str;

  const ellipsisWidth = visibleWidth(ellipsis);
  const targetWidth = Math.max(0, maxWidth - ellipsisWidth);

  let accumulated = 0;
  let result = "";
  let i = 0;

  while (i < str.length) {
    if (str[i] === "\x1b") {
      // Keep ANSI escape sequences intact
      const match = str.slice(i).match(ANSI_REGEX);
      if (match && match.index === 0) {
        result += match[0];
        i += match[0].length;
        continue;
      }
    }

    const code = str.codePointAt(i) ?? 0;
    const charLen = code > 0xffff ? 2 : 1;
    const charWidth = isWideChar(code) ? 2 : 1;

    if (accumulated + charWidth > targetWidth) {
      break;
    }

    result += str.slice(i, i + charLen);
    accumulated += charWidth;
    i += charLen;
  }

  return `${result}${ellipsis}\x1b[0m`;
}
