import { createElement } from "react";
import type { Site } from "@/lib/data";
import { responsiveHtml } from "@/lib/images";

/** 以原生標籤輸出主題 HTML（innerHTML），保留 Blocksy CSS 依賴的 DOM 結構 */
/** 傳入 site 時，HTML 內的本站圖片會改寫成響應式 srcset（見 lib/images.ts） */
export function Raw({ as = "div", html, site, ...attrs }: { as?: string; html: string; site?: Site } & Record<string, unknown>) {
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === "class") props.className = v;
    else if (k === "itemscope") props.itemScope = true;
    else if (k === "itemtype") props.itemType = v;
    else if (k === "itemprop") props.itemProp = v;
    else props[k] = v;
  }
  props.dangerouslySetInnerHTML = { __html: site ? responsiveHtml(site, html) : html };
  props.suppressHydrationWarning = true;
  return createElement(as, props);
}
