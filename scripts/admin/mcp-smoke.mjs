// MCP 端對端測試：tools/list → 讀一篇文章 → 新增草稿 → 修改 → 刪除（垃圾桶後永久刪除）
// 用法：source ~/.config/gather-migrate/env && MCP_URL=http://localhost:3000/api/mcp node scripts/admin/mcp-smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL || "http://localhost:3000/api/mcp";
const token = process.env.MCP_TOKEN || process.env.MCP_TOKEN_GOPALACETW;
if (!token) throw new Error("缺少 MCP_TOKEN / MCP_TOKEN_GOPALACETW");

const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
const client = new Client({ name: "gopalacetw-smoke", version: "1.0.0" });
await client.connect(transport);
const parse = (r) => {
  const t = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(t);
  return JSON.parse(t);
};
const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));
const log = (label, v) => console.log(`\n== ${label} ==\n${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`);

log("server", client.getServerVersion());
const { tools } = await client.listTools();
log(`tools/list（${tools.length} 個）`, tools.map((t) => t.name).join(", "));

const list = await call("list_posts", { post_type: "page", status: "publish", limit: 3 });
log("list_posts(page, publish, limit 3)", { total: list.total, rows: list.rows.map((r) => ({ id: r.id, title: r.title, path: r.path })) });
const one = await call("get_post", { id: list.rows[0].id });
log(`get_post(${one.id})`, { id: one.id, post_type: one.post_type, title: one.title, status: one.status, path: one.path, content_chars: one.content.length });

const stamp = new Date().toISOString();
const created = await call("create_post", { post_type: "post", title: `MCP 測試草稿 ${stamp}`, content: "<p>由 MCP 用戶端建立的測試草稿。</p>" });
log("create_post", { id: created.id, title: created.title, status: created.status, slug: created.slug });

const updated = await call("update_post", { id: created.id, title: `MCP 測試草稿（已修改）${stamp}`, content: "<h2>修改後</h2><p>內容已更新。</p>", excerpt: "MCP 修改" });
log("update_post", { id: updated.id, title: updated.title, status: updated.status, excerpt: updated.excerpt, content: updated.content });

const reread = await call("get_post", { id: created.id });
log("get_post（修改後重讀）", { id: reread.id, title: reread.title, content: reread.content });

const trashed = await call("delete_post", { id: created.id });
log("delete_post（預設移到垃圾桶）", trashed);
const deleted = await call("delete_post", { id: created.id, force: true });
log("delete_post（force 永久刪除）", deleted);

const gone = await client.callTool({ name: "get_post", arguments: { id: created.id } });
log("get_post（刪除後）", gone.content[0].text);

const audit = await call("get_audit_log", { entity_type: "posts", entity_id: String(created.id), limit: 10 });
log("audit_log（此草稿）", audit.map((a) => ({ at: a.created_at, actor_type: a.actor_type, action: a.action, entity: `${a.entity_type}#${a.entity_id}` })));

await client.close();
