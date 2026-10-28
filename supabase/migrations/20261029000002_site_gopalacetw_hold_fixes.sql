-- 綠界複驗修正（2026-10-29）。只動 site_gopalacetw schema 與 cron job site_gopalacetw_expire_holds。可重跑。
-- 1. 逾期預留：pg_cron 每 5 分鐘取消逾期未付款訂單；checkout_place_hold 加單品數量上限（p_max_qty_per_item）。
-- 2. 付款鎖與逾期取消撞期：開始付款時把預留期限延到「付款鎖結束＋5 分鐘」以後。
-- 3. 取消／失敗（已釋放庫存）後被改回處理中／完成：補扣庫存一次（不檢查是否足夠，扣成負數寫備註）。

begin;

-- ---------- 3. 不檢查庫存、直接扣減訂單商品（只在「已收款／人工確認」時用）----------
-- 規則與 _reserve_order_stock 相同：規格有管理庫存扣規格，否則扣有管理庫存的商品。回傳 {lines:[文字], negative:bool}
create or replace function site_gopalacetw._deduct_order_stock_unchecked(p_order_id bigint)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  t record;
  cur_qty int; new_qty int;
  parts text[] := '{}';
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
    if new_qty < 0 then neg := true; end if;
  end loop;
  return jsonb_build_object('lines', to_jsonb(parts), 'negative', neg);
end;
$$;

-- ---------- 訂單狀態觸發器（取代 20261029000001 版本，新增 #3 補扣）----------
create or replace function site_gopalacetw._orders_status_hold_trg()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  n int;
  d jsonb;
  txt text;
begin
  if new.status in ('cancelled', 'failed', 'refunded', 'trash') then
    if site_gopalacetw._release_order_stock(new.id, site_gopalacetw._order_status_label(new.status)) then
      new.meta := new.meta || jsonb_build_object('order_stock_reduced', 'no');
    end if;
  elsif new.status in ('processing', 'completed', 'on-hold') then
    update site_gopalacetw.stock_holds set status = 'converted', updated_at = now()
     where order_id = new.id and status = 'held';
    -- 取消／失敗時已釋放庫存（order_stock_reduced=no），之後被改回處理中／完成（後台、MCP 人工確認收款）→ 補扣一次。
    -- 錢已收，不再檢查庫存是否足夠；扣成負數寫備註。綠界通知路徑已自行扣減並在同一 UPDATE 設 order_stock_reduced=yes，不會重複。
    if new.status in ('processing', 'completed') and old.status in ('cancelled', 'failed')
       and new.meta->>'order_stock_reduced' = 'no' then
      d := site_gopalacetw._deduct_order_stock_unchecked(new.id);
      new.meta := new.meta || jsonb_build_object('order_stock_reduced', 'yes');
      select string_agg(x, ', ') into txt from jsonb_array_elements_text(d->'lines') as q(x);
      insert into site_gopalacetw.order_notes(order_id, note, added_by)
      values (new.id, format('訂單由「%s」改為「%s」，已補扣庫存%s', site_gopalacetw._order_status_label(old.status),
                             site_gopalacetw._order_status_label(new.status), coalesce('： ' || txt, '（無需管理庫存的商品）')), 'system');
      if (d->>'negative')::boolean then
        insert into site_gopalacetw.order_notes(order_id, note, added_by)
        values (new.id, '⚠ 注意：補扣後庫存為負數（取消期間已被其他訂單買走），請確認是否有貨可出並調整庫存。', 'system');
      end if;
      insert into site_gopalacetw.audit_log(actor_type, actor_id, action, entity_type, entity_id, before, after)
      values ('system', 'stock_hold', 'stock_reduce_on_reopen', 'order', new.id::text,
              jsonb_build_object('status', old.status), jsonb_build_object('status', new.status, 'stock', d));
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

-- ---------- 1c. 結帳：加單品數量上限 ----------
-- 回傳：'ok' | 'qty_limit:<商品名>' | 'out_of_stock:<商品名>' | 'coupon_limit:<代碼>' | 'too_many_unpaid' | 'not_found'
drop function if exists site_gopalacetw.checkout_place_hold(bigint, boolean, int, int, int);
create or replace function site_gopalacetw.checkout_place_hold(
  p_order_id bigint, p_hold boolean, p_hold_minutes int default 60,
  p_max_unpaid_per_email int default 3, p_max_unpaid_per_ip int default 5,
  p_max_qty_per_item int default 5
) returns text
language plpgsql security invoker set search_path = '' as $$
declare
  o site_gopalacetw.orders%rowtype;
  em text;
  n int;
  r text;
  plan jsonb;
  c record;
  big text;
begin
  select * into o from site_gopalacetw.orders where id = p_order_id for update;
  if not found then return 'not_found'; end if;
  em := lower(coalesce(o.billing_email, ''));

  -- 單品（同商品／同規格）數量上限：限制單一未付款訂單能鎖住的庫存量
  if p_max_qty_per_item is not null and p_max_qty_per_item > 0 then
    select min(name) into big from (
      select min(oi.name) as name from site_gopalacetw.order_items oi
       where oi.order_id = o.id and oi.item_type = 'line_item'
       group by oi.product_id, oi.variation_id
      having sum(oi.quantity) > p_max_qty_per_item) x;
    if big is not null then return 'qty_limit:' || big; end if;
  end if;

  if p_hold then
    if em <> '' then perform pg_advisory_xact_lock(hashtextextended('gopalacetw:checkout:email:' || em, 0)); end if;
    if coalesce(o.customer_ip, '') <> '' then perform pg_advisory_xact_lock(hashtextextended('gopalacetw:checkout:ip:' || o.customer_ip, 0)); end if;
    if em <> '' then
      select count(*) into n from site_gopalacetw.orders x
       where x.id <> o.id and lower(x.billing_email) = em and x.payment_method = o.payment_method
         and x.created_via = 'checkout' and x.status in ('pending', 'failed')
         and x.date_created > now() - make_interval(mins => p_hold_minutes);
      if n >= p_max_unpaid_per_email then return 'too_many_unpaid'; end if;
    end if;
    if coalesce(o.customer_ip, '') <> '' then
      select count(*) into n from site_gopalacetw.orders x
       where x.id <> o.id and x.customer_ip = o.customer_ip and x.payment_method = o.payment_method
         and x.created_via = 'checkout' and x.status in ('pending', 'failed')
         and x.date_created > now() - make_interval(mins => p_hold_minutes);
      if n >= p_max_unpaid_per_ip then return 'too_many_unpaid'; end if;
    end if;
  end if;

  for c in select cp.id, cp.code, cp.usage_count, cp.usage_limit from site_gopalacetw.coupons cp
            where cp.id in (select distinct (meta->>'coupon_id')::bigint from site_gopalacetw.order_items
                             where order_id = o.id and item_type = 'coupon' and meta ? 'coupon_id')
            order by cp.id for update loop
    if c.usage_limit is not null and c.usage_limit > 0 and c.usage_count >= c.usage_limit then
      return 'coupon_limit:' || c.code;
    end if;
  end loop;

  if p_hold then
    r := site_gopalacetw._hold_order_stock(o.id, p_hold_minutes, '已保留庫存');
    if r <> 'ok' then return r; end if;
  else
    plan := site_gopalacetw._reserve_order_stock(o.id, false);
    if jsonb_typeof(plan) = 'string' then return plan #>> '{}'; end if;
  end if;

  perform site_gopalacetw._count_order_coupons(o.id, em);
  update site_gopalacetw.orders set meta = meta || jsonb_build_object('coupon_usage_counted', 'yes') where id = o.id;
  return 'ok';
end;
$$;

-- ---------- 2. 建立付款嘗試：預留期限 ≥ 付款鎖結束（p_inflight_minutes）＋5 分鐘 ----------
create or replace function site_gopalacetw.ecpay_begin_attempt(
  p_order_id bigint, p_order_key text, p_trade_no text, p_amount int, p_env text,
  p_inflight_minutes int default 15, p_hold_minutes int default 60, p_max_attempts int default 20
) returns text
language plpgsql security invoker set search_path = '' as $$
declare
  o site_gopalacetw.orders%rowtype;
  h site_gopalacetw.stock_holds%rowtype;
  n int;
  r text;
begin
  select * into o from site_gopalacetw.orders where id = p_order_id and order_key = p_order_key for update;
  if not found then return 'not_found'; end if;
  if o.payment_method is distinct from 'ry_ecpay_credit' then return 'not_ecpay'; end if;
  if o.status = 'cancelled' then return 'cancelled'; end if;
  if o.status not in ('pending', 'failed') then return 'not_payable'; end if;
  if exists (select 1 from site_gopalacetw.payment_attempts
              where order_id = o.id and status = 'created' and created_at > now() - make_interval(mins => p_inflight_minutes)) then
    return 'in_progress';
  end if;
  select count(*) into n from site_gopalacetw.payment_attempts where order_id = o.id;
  if n >= p_max_attempts then return 'too_many_attempts'; end if;

  select * into h from site_gopalacetw.stock_holds where order_id = o.id for update;
  if not found or h.status = 'released' then
    r := site_gopalacetw._hold_order_stock(o.id, p_hold_minutes, '重新付款：已重新保留庫存');
    if r <> 'ok' then return r; end if;
  end if;
  -- 付款鎖期間（p_inflight_minutes）內不會產生新付款；逾期取消至少等到鎖結束後 5 分鐘，
  -- 讓在鎖期間完成的付款通知有時間先到，不與逾期取消在同一時刻相撞。
  update site_gopalacetw.stock_holds
     set held_until = greatest(held_until, now() + make_interval(mins => p_inflight_minutes + 5)), updated_at = now()
   where order_id = o.id and status = 'held';

  if o.status = 'failed' then
    update site_gopalacetw.orders set status = 'pending', updated_at = now() where id = o.id;
    insert into site_gopalacetw.order_notes(order_id, note, added_by)
    values (o.id, '重新付款：訂單狀態由 失敗 變更為 等待付款中.', 'system');
  end if;

  insert into site_gopalacetw.payment_attempts(order_id, merchant_trade_no, amount, env)
  values (o.id, p_trade_no, p_amount, p_env);
  if n = 0 then
    insert into site_gopalacetw.order_notes(order_id, note, is_customer_note, added_by) values (o.id, '使用 綠界信用卡 付款', false, 'system');
  end if;
  insert into site_gopalacetw.audit_log(actor_type, actor_id, action, entity_type, entity_id, after)
  values ('system', 'ecpay', 'payment_start', 'order', o.id::text,
          jsonb_build_object('merchant_trade_no', p_trade_no, 'amount', p_amount, 'env', p_env));
  return 'ok';
end;
$$;

-- ---------- 權限 ----------
do $$
declare f text;
begin
  foreach f in array array[
    'site_gopalacetw._deduct_order_stock_unchecked(bigint)',
    'site_gopalacetw._orders_status_hold_trg()',
    'site_gopalacetw.checkout_place_hold(bigint, boolean, int, int, int, int)',
    'site_gopalacetw.ecpay_begin_attempt(bigint, text, text, int, text, int, int, int)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ---------- 1a. pg_cron：每 5 分鐘取消逾期未付款訂單（只呼叫本站函式；先移除同名 job 再建立，可重跑）----------
select cron.unschedule(j.jobid) from cron.job j where j.jobname = 'site_gopalacetw_expire_holds';
select cron.schedule('site_gopalacetw_expire_holds', '*/5 * * * *', $cron$select site_gopalacetw.ecpay_cancel_unpaid(60)$cron$);

commit;
