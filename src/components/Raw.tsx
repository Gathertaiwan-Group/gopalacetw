import { createElement } from "react";

/** 以原生標籤輸出主題 HTML（innerHTML），保留 Blocksy CSS 依賴的 DOM 結構 */
export function Raw({ as = "div", html, ...attrs }: { as?: string; html: string } & Record<string, unknown>) {
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === "class") props.className = v;
    else if (k === "itemscope") props.itemScope = true;
    else if (k === "itemtype") props.itemType = v;
    else if (k === "itemprop") props.itemProp = v;
    else props[k] = v;
  }
  props.dangerouslySetInnerHTML = { __html: html };
  props.suppressHydrationWarning = true;
  return createElement(as, props);
}
