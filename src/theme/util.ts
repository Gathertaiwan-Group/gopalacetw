export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** WordPress 標題已含 HTML 實體（如 &#8211;），只轉換未編碼的 < > */
export function wpText(s: unknown): string {
  return String(s ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * WordPress wptexturize()（the_title 濾鏡）的文字替換子集：DB 存 WP 原始 post_title，前台輸出前才轉換，
 * 讓後台／MCP 看到的名稱與 WP 原值一致。輸出 Unicode 字元（等同 WP 的 &#8211; 等實體），HTML 標籤內不處理。
 */
const SP = "(?:[\\r\\n\\t ]|\\u00a0|&nbsp;)";
const TEXTURIZE: [RegExp, string][] = [
  [/\.\.\./g, "…"],
  [/``/g, "“"],
  [/''/g, "”"],
  [/ \(tm\)/gi, " ™"],
  [/---/g, "—"],
  [new RegExp(`(?<=^|${SP})--(?=$|${SP})`, "g"), "—"],
  [/(?<!xn)--/g, "–"],
  [new RegExp(`(?<=^|${SP})-(?=$|${SP})`, "g"), "–"],
  [/\b(\d[\d.,]*)x(\d[\d.,]*)\b/g, "$1×$2"],
  // 引號：前面是開頭／空白／開括號 → 左引號，其餘 → 右引號（撇號）
  [new RegExp(`(?<=^|${SP}|[(\\[{"\\-])'`, "g"), "‘"],
  [/'/g, "’"],
  [new RegExp(`(?<=^|${SP}|[(\\[{\\-])"`, "g"), "“"],
  [/"/g, "”"],
];
export function wptexturize(s: unknown): string {
  return String(s ?? "")
    .split(/(<[^>]*>)/)
    .map((part) => (part.startsWith("<") ? part : TEXTURIZE.reduce((acc, [re, to]) => acc.replace(re, to), part)))
    .join("");
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

export function stripTags(s: string): string {
  return decodeEntities(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export function money(n: number | string | null | undefined): string {
  const v = Math.round(Number(n || 0));
  return v.toLocaleString("en-US");
}

/** WooCommerce 價格 HTML（NT$ 前綴、無小數） */
export function priceHtml(n: number | string | null | undefined, encodedSymbol = true): string {
  const sym = encodedSymbol ? "&#78;&#84;&#36;" : "NT$";
  return `<span class="woocommerce-Price-amount amount"><bdi><span class="woocommerce-Price-currencySymbol">${sym}</span>${money(n)}</bdi></span>`;
}

/** 舊站 percent-encoded slug 需維持小寫編碼格式 */
export function encPath(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      let dec = seg;
      try {
        dec = decodeURIComponent(seg);
      } catch {}
      return encodeURIComponent(dec).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
    })
    .join("/");
}
