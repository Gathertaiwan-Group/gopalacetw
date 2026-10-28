-- 庫存扣減改以「訂單目前是否已扣庫存」（meta.order_stock_reduced）判斷，不再看舊狀態（2026-10-29 最終複驗 Medium）。
-- 問題：取消／失敗／退款（已釋放）→ 保留 → 處理中，庫存永遠不補扣（舊版只在舊狀態為 cancelled/failed 時補扣）。
-- 規則（比照 WooCommerce wc_maybe_reduce_stock_levels / wc_maybe_increase_stock_levels）：
--   * processing / completed / on-hold：order_stock_reduced≠yes → 扣一次（不檢查庫存，負數寫備註），設 yes；
--     預留中（held）的庫存直接轉正式扣減（held→converted），不重複扣。
--   * cancelled / failed：預留中 → 釋放；已正式扣減（yes）→ 歸還一次，設 no。
--   * refunded / trash：只釋放「尚未付款的預留」（維持現有行為）；已付款訂單改成已退款不自動回補庫存——
--     WooCommerce 改成已退款時建立的全額退款 restock_items=false，回補庫存要在退款時手動勾選；退回的貨不一定能再賣。
--   * pending：不動庫存（維持現有行為）。
--   * 呼叫端在同一 UPDATE 自行設 order_stock_reduced=yes（綠界付款通知路徑已自行扣減）→ 觸發器不再扣。
-- 只動 site_gopalacetw schema。可重跑。

begin;

-- ---------- 不檢查庫存直接扣減：另回傳 plan（[{kind,id,qty,name}]），供日後歸還使用 ----------
create or replace function site_gopalacetw._deduct_order_stock_unchecked(p_order_id bigint)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  t record;
  cur_qty int; new_qty int;
  parts text[] := '{}';
  plan jsonb := '[]';
  neg boolean := false;
begin
  for t in
    with li as (
      select oi.name, oi.quantity,
             case when v.id is not null and v.manage_stock and v.stock_quantity is not null then 'variation' else 'product' end as kind,
             case when v.id is not null and v.manage_stock and v.stock_quantity is not null then v.id else coalesce(v.product_id, oi.product_id) end as target_id
        from site_gopalacetw.order_items oi
        left join site_gopalacetw.product_variations v on v.id = oi.variation_id
       where oi.order_id = p_order_id and oi.item_type = 'line_item'
    )
    select kind, target_id, sum(quantity)::int as qty, min(name) as name from li
     where target_id is not null group by kind, target_id order by kind, target_id
  loop
    if t.kind = 'variation' then
      select stock_quantity into cur_qty from site_gopalacetw.product_variations
       where id = t.target_id and manage_stock and stock_quantity is not null for update;
      if not found then continue; end if;
      new_qty := cur_qty - t.qty;
      update site_gopalacetw.product_variations
         set stock_quantity = new_qty,
             stock_status = case when new_qty > 0 then 'instock' when backorders <> 'no' then 'onbackorder' else 'outofstock' end
       where id = t.target_id;
    else
      select stock_quantity into cur_qty from site_gopalacetw.products
       where id = t.target_id and manage_stock and stock_quantity is not null for update;
      if not found then continue; end if;
      new_qty := cur_qty - t.qty;
      update site_gopalacetw.products
         set stock_quantity = new_qty,
             stock_status = case when new_qty > 0 then 'instock' when backorders <> 'no' then 'onbackorder' else 'outofstock' end
       where id = t.target_id;
    end if;
    parts := parts || format('%s %s→%s', t.name, cur_qty, new_qty);
    plan := plan || jsonb_build_object('kind', t.kind, 'id', t.target_id, 'qty', t.qty, 'name', t.name);
    if new_qty < 0 then neg := true; end if;
  end loop;
  return jsonb_build_object('lines', to_jsonb(parts), 'negative', neg, 'plan', plan);
end;
$$;

-- ---------- 歸還已正式扣減的庫存（order_stock_reduced=yes 時才呼叫）----------
-- 有 converted 預留紀錄 → 依紀錄的實際扣減列歸還；否則（搬遷舊單、綠界通知路徑自行扣減）依訂單明細計算。
create or replace function site_gopalacetw._restock_order(p_order_id bigint, p_reason text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  h site_gopalacetw.stock_holds%rowtype;
  has_h boolean;
  plan jsonb;
  e jsonb;
  cur_qty int; new_qty int;
  parts text[] := '{}';
begin
  select * into h from site_gopalacetw.stock_holds where order_id = p_order_id for update;
  has_h := found;
  if has_h and h.status = 'converted' then
    plan := h.lines;
  else
    select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'id', target_id, 'qty', qty, 'name', name)), '[]') into plan from (
      with li as (
        select oi.name, oi.quantity,
               case when v.id is not null and v.manage_stock and v.stock_quantity is not null then 'variation' else 'product' end as kind,
               case when v.id is not null and v.manage_stock and v.stock_quantity is not null then v.id else coalesce(v.product_id, oi.product_id) end as target_id
          from site_gopalacetw.order_items oi
          left join site_gopalacetw.product_variations v on v.id = oi.variation_id
         where oi.order_id = p_order_id and oi.item_type = 'line_item'
      )
      select kind, target_id, sum(quantity)::int as qty, min(name) as name from li
       where target_id is not null group by kind, target_id) x;
  end if;
  for e in select q.v from jsonb_array_elements(plan) as q(v) order by q.v->>'kind', (q.v->>'id')::bigint loop
    if e->>'kind' = 'variation' then
      select stock_quantity into cur_qty from site_gopalacetw.product_variations
       where id = (e->>'id')::bigint and manage_stock and stock_quantity is not null for update;
      if not found then continue; end if;
      new_qty := cur_qty + (e->>'qty')::int;
      update site_gopalacetw.product_variations
         set stock_quantity = new_qty,
             stock_status = case when new_qty > 0 then 'instock' when backorders <> 'no' then 'onbackorder' else 'outofstock' end
       where id = (e->>'id')::bigint;
    else
      select stock_quantity into cur_qty from site_gopalacetw.products
       where id = (e->>'id')::bigint and manage_stock and stock_quantity is not null for update;
      if not found then continue; end if;
      new_qty := cur_qty + (e->>'qty')::int;
      update site_gopalacetw.products
         set stock_quantity = new_qty,
             stock_status = case when new_qty > 0 then 'instock' when backorders <> 'no' then 'onbackorder' else 'outofstock' end
       where id = (e->>'id')::bigint;
    end if;
    parts := parts || format('%s %s→%s', e->>'name', cur_qty, new_qty);
  end loop;
  if has_h then
    update site_gopalacetw.stock_holds set status = 'released', release_reason = p_reason, released_at = now(), updated_at = now()
     where order_id = p_order_id;
  end if;
  insert into site_gopalacetw.order_notes(order_id, note, added_by)
  values (p_order_id, format('已歸還庫存（%s）%s', p_reason, coalesce('：' || array_to_string(parts, ', '), '（無需管理庫存的商品）')), 'system');
  insert into site_gopalacetw.audit_log(actor_type, actor_id, action, entity_type, entity_id, after)
  values ('system', 'stock_hold', 'stock_restore', 'order', p_order_id::text, jsonb_build_object('reason', p_reason, 'lines', plan));
  return plan;
end;
$$;

-- ---------- 訂單狀態觸發器（取代 20261029000002 版本）----------
create or replace function site_gopalacetw._orders_status_hold_trg()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  n int;
  d jsonb;
  txt text;
  flag text := coalesce(new.meta->>'order_stock_reduced', '');  -- 同一 UPDATE 未改 meta 時等於舊值
begin
  if new.status in ('cancelled', 'failed', 'refunded', 'trash') then
    if site_gopalacetw._release_order_stock(new.id, site_gopalacetw._order_status_label(new.status)) then
      new.meta := new.meta || jsonb_build_object('order_stock_reduced', 'no');
    elsif new.status in ('cancelled', 'failed') and flag = 'yes' then
      perform site_gopalacetw._restock_order(new.id, site_gopalacetw._order_status_label(new.status));
      new.meta := new.meta || jsonb_build_object('order_stock_reduced', 'no');
    end if;
  elsif new.status in ('processing', 'completed', 'on-hold') then
    update site_gopalacetw.stock_holds set status = 'converted', updated_at = now()
     where order_id = new.id and status = 'held';
    if flag <> 'yes' then
      -- 尚未扣庫存（取消／失敗後釋放、人工付款訂單首次確認）→ 扣一次。錢已收／人工確認，不檢查庫存是否足夠；扣成負數寫備註。
      d := site_gopalacetw._deduct_order_stock_unchecked(new.id);
      new.meta := new.meta || jsonb_build_object('order_stock_reduced', 'yes');
      insert into site_gopalacetw.stock_holds(order_id, status, lines, held_until)
      values (new.id, 'converted', d->'plan', now())
      on conflict (order_id) do update
         set status = 'converted', lines = excluded.lines, release_reason = null, released_at = null, updated_at = now();
      select string_agg(x, ', ') into txt from jsonb_array_elements_text(d->'lines') as q(x);
      insert into site_gopalacetw.order_notes(order_id, note, added_by)
      values (new.id, format('訂單由「%s」改為「%s」，%s%s', site_gopalacetw._order_status_label(old.status),
                             site_gopalacetw._order_status_label(new.status),
                             case when flag = 'no' then '已補扣庫存' else '庫存量已減少' end,
                             coalesce('： ' || txt, '（無需管理庫存的商品）')), 'system');
      if (d->>'negative')::boolean then
        insert into site_gopalacetw.order_notes(order_id, note, added_by)
        values (new.id, '⚠ 注意：扣減後庫存為負數（可能已被其他訂單買走），請確認是否有貨可出並調整庫存。', 'system');
      end if;
      insert into site_gopalacetw.audit_log(actor_type, actor_id, action, entity_type, entity_id, before, after)
      values ('system', 'stock_hold', case when flag = 'no' then 'stock_reduce_on_reopen' else 'stock_reduce' end, 'order', new.id::text,
              jsonb_build_object('status', old.status, 'order_stock_reduced', nullif(flag, '')),
              jsonb_build_object('status', new.status, 'stock', d));
    end if;
  end if;
  if new.status in ('cancelled', 'trash')
     and coalesce(new.meta->>'coupon_usage_counted', 'no') = 'yes'
     and coalesce(new.meta->>'coupon_usage_restored', 'no') <> 'yes' then
    n := site_gopalacetw._uncount_order_coupons(new.id, lower(new.billing_email));
    new.meta := new.meta || jsonb_build_object('coupon_usage_restored', 'yes');
    if n > 0 then
      insert into site_gopalacetw.order_notes(order_id, note, added_by)
      values (new.id, format('已回補優惠券使用次數（%s 張）', n), 'system');
    end if;
  end if;
  return new;
end;
$$;

-- ---------- 回填：已在佔庫存狀態但沒有旗標的訂單視為已扣（避免日後改狀態時突然扣庫存）----------
-- 搬遷舊單的旗標已直接取自 WP `_order_stock_reduced`（匯入時寫入 meta），此處不覆寫既有值。
update site_gopalacetw.orders
   set meta = meta || jsonb_build_object('order_stock_reduced', 'yes', 'order_stock_reduced_backfill', '20261029')
 where status in ('processing', 'completed', 'on-hold') and coalesce(meta->>'order_stock_reduced', '') = '';

-- ---------- 權限 ----------
do $$
declare f text;
begin
  foreach f in array array[
    'site_gopalacetw._deduct_order_stock_unchecked(bigint)',
    'site_gopalacetw._restock_order(bigint, text)',
    'site_gopalacetw._orders_status_hold_trg()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;
