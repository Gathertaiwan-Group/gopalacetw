import { getAdmin, adminActor } from "@/lib/admin/guard";
import { audit, listRecords } from "@/lib/admin/service";
import { csvResponse, toCsv } from "@/lib/admin/csv";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const a = await getAdmin();
  if (!a) return new Response("Unauthorized", { status: 401 });
  const sp = new URL(req.url).searchParams;
  const cols = ["id", "order_number", "status", "date_created", "date_paid", "total", "subtotal", "shipping_total", "discount_total", "payment_method_title", "shipping_method_title", "billing_last_name", "billing_first_name", "billing_email", "billing_phone", "billing_postcode", "billing_state", "billing_city", "billing_address_1", "shipping_last_name", "shipping_first_name", "shipping_phone", "shipping_postcode", "shipping_state", "shipping_city", "shipping_address_1", "customer_note"];
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 500) {
    const r = await listRecords("orders", { q: sp.get("q"), filters: { status: sp.get("status") || undefined }, limit: 500, offset, columns: cols.join(",") });
    rows.push(...r.rows);
    if (r.rows.length < 500) break;
  }
  await audit(await adminActor(a), "export", "orders", null, null, { count: rows.length, status: sp.get("status") || null });
  return csvResponse(`orders-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(cols, rows.map((r) => cols.map((c) => r[c]))));
}
