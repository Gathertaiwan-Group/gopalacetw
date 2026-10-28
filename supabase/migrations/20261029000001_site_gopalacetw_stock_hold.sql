-- 綠界審查修正：下單預留庫存（hold stock 60 分鐘）、逾期／失敗／取消釋放、付款成功轉扣減、
-- 灌單防護、重複付款防護、優惠券次數回補、測試金鑰上正式網域時拒絕標記已付款。
-- 只動 site_gopalacetw schema。

-- ---------- 庫存預留紀錄 ----------
create table if not exists site_gopalacetw.stock_holds (
  order_id bigint primary key references site_gopalacetw.orders(id) on delete cascade,
  status text not null default 'held' check (status in ('held','converted','released')),
  lines jsonb not null default '[]',        -- 實際扣下的庫存：[{kind:'product'|'variation', id, qty, name}]
  held_until timestamptz not null,
  release_reason text,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists stock_holds_status_until_idx on site_gopalacetw.stock_holds(status, held_until);
alter table site_gopalacetw.stock_holds enable row level security;
revoke all on site_gopalacetw.stock_holds from anon, authenticated;
grant all on site_gopalacetw.stock_holds to service_role;

-- 付款嘗試：新增 blocked（測試金鑰在正式網域的付款通知，被拒絕）
alter table site_gopalacetw.payment_attempts drop constraint if exists payment_attempts_status_check;
alter table site_gopalacetw.payment_attempts add constraint payment_attempts_status_check
  check (status in ('created','paid','failed','simulated','blocked'));
create index if not exists payment_attempts_order_status_idx on site_gopalacetw.payment_attempts(order_id, status, created_at desc);
create index if not exists orders_ip_idx on site_gopalacetw.orders(customer_ip, date_created desc);

-- ---------- 內部：鎖定並檢查／扣下訂單商品庫存 ----------
-- p_apply=false 只檢查；true 則扣下。所有庫存列依 (kind,id) 排序後 FOR UPDATE，避免併發死結；
-- 先全部檢查再扣，不足即回傳 'out_of_stock:<商品名>'，不會有部分扣減。成功回傳 jsonb 陣列（實際扣下的列）。
create or replace function site_gopalacetw._reserve_order_stock(p_order_id bigint, p_apply boolean)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  t record;
  cur_qty int; managed boolean; bo text; st text; found_row boolean;
  plan jsonb := '[]';
  e jsonb;
  new_qty int;
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
      select stock_quantity, manage_stock, backorders, stock_status into cur_qty, managed, bo, st
        from site_gopalacetw.product_variations where id = t.target_id for update;
    else
      select stock_quantity, manage_stock, backorders, stock_status into cur_qty, managed, bo, st
        from site_gopalacetw.products where id = t.target_id for update;
    end if;
    found_row := found;
    if not found_row then return to_jsonb('out_of_stock:' || t.name); end if;
    if managed and cur_qty is not null then
      if bo = 'no' and cur_qty < t.qty then return to_jsonb('out_of_stock:' || t.name); end if;
      plan := plan || jsonb_build_object('kind', t.kind, 'id', t.target_id, 'qty', t.qty, 'name', t.name, 'from', cur_qty);
    elsif st = 'outofstock' then
      return to_jsonb('out_of_stock:' || t.name);
    end if;
  end loop;
  if not p_apply then return plan; end if;
  for e in select q.v from jsonb_array_elements(plan) as q(v) loop
    new_qty := (e->>'from')::int - (e->>'qty')::int;
    if e->>'kind' = 'variation' then
      update site_gopalacetw.product_variations
         set stock_quantity = new_qty,
             stock_status = case when new_qty > 0 then 'instock' when backorders <> 'no' then 'onbackorder' else 'outofstock' end
       where id = (e->>'id')::bigint;
    else
      update site_gopalacetw.products
         set stock_quantity = new_qty,
             stock_status = case when new_qty > 0 then 'instock' when backorders <> 'no' then 'onbackorder' else 'outofstock' end
       where id = (e->>'id')::bigint;
    end if;
  end loop;
  return plan;
end;
$$;

-- 預留成功時寫 hold 列與備註；回傳 'ok' 或 'out_of_stock:<名>'
create or replace function site_gopalacetw._hold_order_stock(p_order_id bigint, p_hold_minutes int, p_note_prefix text)
returns text language plpgsql security invoker set search_path = '' as $$
declare
  plan jsonb;
  txt text;
begin
  plan := site_gopalacetw._reserve_order_stock(p_order_id, true);
  if jsonb_typeof(plan) = 'string' then return plan #>> '{}'; end if;
  insert into site_gopalacetw.stock_holds(order_id, status, lines, held_until)
  values (p_order_id, 'held', plan, now() + make_interval(mins => p_hold_minutes))
  on conflict (order_id) do update
     set status = 'held', lines = excluded.lines, held_until = excluded.held_until,
         release_reason = null, released_at = null, updated_at = now();
  update site_gopalacetw.orders
     set meta = meta || jsonb_build_object('order_stock_reduced', 'yes', 'stock_hold', 'yes')
   where id = p_order_id;
  select string_agg(format('%s %s→%s', q.v->>'name', q.v->>'from', (q.v->>'from')::int - (q.v->>'qty')::int), ', ')
    into txt from jsonb_array_elements(plan) as q(v);
  insert into site_gopalacetw.order_notes(order_id, note, added_by)
  values (p_order_id, format('%s（保留 %s 分鐘）%s', p_note_prefix, p_hold_minutes, coalesce('：' || txt, '')), 'system');
  return 'ok';
end;
$$;

-- 釋放預留（只在 hold 為 held 時生效，故只會釋放一次）
create or replace function site_gopalacetw._release_order_stock(p_order_id bigint, p_reason text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  h site_gopalacetw.stock_holds%rowtype;
  e jsonb;
  cur_qty int; new_qty int;
  parts text[] := '{}';
begin
  select * into h from site_gopalacetw.stock_holds where order_id = p_order_id and status = 'held' for update;
  if not found then return false; end if;
  for e in select q.v from jsonb_array_elements(h.lines) as q(v) order by q.v->>'kind', (q.v->>'id')::bigint loop
    if e->>'kind' = 'variation' then
      select stock_quantity into cur_qty from site_gopalacetw.product_variations
       where id = (e->>'id')::bigint and manage_stock and stock_quantity is not null for update;
      if found then
        new_qty := cur_qty + (e->>'qty')::int;
        update site_gopalacetw.product_variations
           set stock_quantity = new_qty,
               stock_status = case when new_qty > 0 then 'instock' when backorders <> 'no' then 'onbackorder' else 'outofstock' end
         where id = (e->>'id')::bigint;
        parts := parts || format('%s %s→%s', e->>'name', cur_qty, new_qty);
      end if;
    else
      select stock_quantity into cur_qty from site_gopalacetw.products
       where id = (e->>'id')::bigint and manage_stock and stock_quantity is not null for update;
      if found then
        new_qty := cur_qty + (e->>'qty')::int;
        update site_gopalacetw.products
           set stock_quantity = new_qty,
               stock_status = case when new_qty > 0 then 'instock' when backorders <> 'no' then 'onbackorder' else 'outofstock' end
         where id = (e->>'id')::bigint;
        parts := parts || format('%s %s→%s', e->>'name', cur_qty, new_qty);
      end if;
    end if;
  end loop;
  update site_gopalacetw.stock_holds set status = 'released', release_reason = p_reason, released_at = now(), updated_at = now()
   where order_id = p_order_id;
  insert into site_gopalacetw.order_notes(order_id, note, added_by)
  values (p_order_id, format('已釋放保留庫存（%s）%s', p_reason, coalesce('：' || array_to_string(parts, ', '), '')), 'system');
  insert into site_gopalacetw.audit_log(actor_type, actor_id, action, entity_type, entity_id, after)
  values ('system', 'stock_hold', 'stock_release', 'order', p_order_id::text, jsonb_build_object('reason', p_reason, 'lines', h.lines));
  return true;
end;
$$;

-- 優惠券使用次數：計入／回補（以訂單 meta 旗標保證各只做一次）
create or replace function site_gopalacetw._count_order_coupons(p_order_id bigint, p_email text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update site_gopalacetw.coupons c
     set usage_count = c.usage_count + 1,
         used_by = case when coalesce(p_email, '') <> '' then c.used_by || p_email else c.used_by end
    from (select distinct (meta->>'coupon_id')::bigint as cid from site_gopalacetw.order_items
           where order_id = p_order_id and item_type = 'coupon' and meta ? 'coupon_id') x
   where c.id = x.cid;
end;
$$;

create or replace function site_gopalacetw._uncount_order_coupons(p_order_id bigint, p_email text)
returns int language plpgsql security invoker set search_path = '' as $$
declare
  r record;
  n int := 0;
  pos int;
begin
  for r in select c.id, c.used_by from site_gopalacetw.coupons c
            where c.id in (select distinct (meta->>'coupon_id')::bigint from site_gopalacetw.order_items
                            where order_id = p_order_id and item_type = 'coupon' and meta ? 'coupon_id')
            order by c.id for update loop
    pos := case when coalesce(p_email, '') <> '' then array_position(r.used_by, p_email) end;
    update site_gopalacetw.coupons
       set usage_count = greatest(usage_count - 1, 0),
           used_by = case when pos is null then used_by else used_by[1:pos-1] || used_by[pos+1:] end
     where id = r.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---------- 訂單狀態觸發器：所有改狀態的路徑（綠界通知、逾期取消、後台、MCP）都一致 ----------
-- 取消／失敗／退款／垃圾桶 → 釋放仍在保留中的庫存；取消／垃圾桶 → 回補優惠券（只一次）；
-- 處理中／完成／保留 → 預留轉為正式扣減。
create or replace function site_gopalacetw._orders_status_hold_trg()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  n int;
begin
  if new.status in ('cancelled', 'failed', 'refunded', 'trash') then
    if site_gopalacetw._release_order_stock(new.id, site_gopalacetw._order_status_label(new.status)) then
      new.meta := new.meta || jsonb_build_object('order_stock_reduced', 'no');
    end if;
  elsif new.status in ('processing', 'completed', 'on-hold') then
    update site_gopalacetw.stock_holds set status = 'converted', updated_at = now()
     where order_id = new.id and status = 'held';
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
drop trigger if exists orders_status_hold on site_gopalacetw.orders;
create trigger orders_status_hold before update of status on site_gopalacetw.orders
  for each row when (old.status is distinct from new.status)
  execute function site_gopalacetw._orders_status_hold_trg();

-- ---------- 結帳：原子預留庫存＋計入優惠券＋灌單防護 ----------
-- 回傳：'ok' | 'out_of_stock:<商品名>' | 'coupon_limit:<代碼>' | 'too_many_unpaid' | 'not_found'
-- p_hold=true（綠界線上付款）才扣下庫存；人工付款訂單只在鎖內檢查庫存，不預留、不逾期取消（維持原行為）。
create or replace function site_gopalacetw.checkout_place_hold(
  p_order_id bigint, p_hold boolean, p_hold_minutes int default 60,
  p_max_unpaid_per_email int default 3, p_max_unpaid_per_ip int default 5
) returns text
language plpgsql security invoker set search_path = '' as $$
declare
  o site_gopalacetw.orders%rowtype;
  em text;
  n int;
  r text;
  plan jsonb;
  c record;
begin
  select * into o from site_gopalacetw.orders where id = p_order_id for update;
  if not found then return 'not_found'; end if;
  em := lower(coalesce(o.billing_email, ''));

  if p_hold then
    -- 同一 email／IP 序列化，計數不會因併發而失準
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

  -- 優惠券使用上限（鎖住優惠券列再檢查）
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

-- ---------- 建立付款嘗試（取代應用層直接 insert）----------
-- 回傳：'ok' | 'not_found' | 'not_ecpay' | 'cancelled' | 'not_payable' | 'in_progress' | 'too_many_attempts' | 'out_of_stock:<名>'
-- in_progress：最近 p_inflight_minutes 分鐘內已有尚未收到結果的付款嘗試 → 不再產生新的 MerchantTradeNo（避免重複刷卡）。
-- 失敗訂單重新付款前重新預留庫存並回到「等待付款中」；保留期限至少延到本次嘗試後 p_inflight_minutes 分鐘。
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
  elsif h.status = 'held' then
    update site_gopalacetw.stock_holds
       set held_until = greatest(held_until, now() + make_interval(mins => p_inflight_minutes)), updated_at = now()
     where order_id = o.id;
  end if;

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

-- ---------- 逾期未付款取消（取代舊版）----------
-- 納入：等待付款中／失敗、前台結帳、綠界付款的新站訂單（有 hold 紀錄或 meta.real_payment=true），
-- 不論是否有付款嘗試；不含人工付款（manual）與搬遷匯入的舊訂單。期限 = hold.held_until，無 hold 則建立後 p_minutes 分鐘。
drop function if exists site_gopalacetw.ecpay_cancel_unpaid(int);
create function site_gopalacetw.ecpay_cancel_unpaid(p_minutes int default 60) returns int
language plpgsql security invoker set search_path = '' as $$
declare
  o record;
  n int := 0;
begin
  for o in select x.id, x.status from site_gopalacetw.orders x
             left join site_gopalacetw.stock_holds h on h.order_id = x.id
            where x.status in ('pending', 'failed') and x.created_via = 'checkout' and x.payment_method = 'ry_ecpay_credit'
              and (h.order_id is not null or x.meta->>'real_payment' = 'true')
              and coalesce(h.held_until, x.date_created + make_interval(mins => p_minutes)) < now()
              and not exists (select 1 from site_gopalacetw.payment_attempts pa where pa.order_id = x.id and pa.status = 'paid')
            for update of x skip locked loop
    update site_gopalacetw.orders set status = 'cancelled', updated_at = now() where id = o.id and status in ('pending', 'failed');
    insert into site_gopalacetw.order_notes(order_id, note, added_by)
    values (o.id, format('未付款訂單已取消 - 付款期限已過。 訂單狀態由 %s 變更為 已取消.', site_gopalacetw._order_status_label(o.status)), 'system');
    insert into site_gopalacetw.audit_log(actor_type, actor_id, action, entity_type, entity_id, before, after)
    values ('system', 'ecpay', 'cancel_unpaid', 'order', o.id::text, jsonb_build_object('status', o.status), jsonb_build_object('status', 'cancelled'));
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---------- 綠界通知處理（取代舊版：新增 p_block_reason；取消後才到的付款重新計入優惠券）----------
drop function if exists site_gopalacetw.ecpay_apply_notification(text, int, text, text, text, text, text, boolean, boolean);
create or replace function site_gopalacetw.ecpay_apply_notification(
  p_trade_no text, p_amount int, p_rtn_code text, p_rtn_msg text, p_ecpay_trade_no text,
  p_payment_type text, p_payment_date text, p_simulate boolean, p_count_as_paid boolean,
  p_block_reason text default null
) returns text
language plpgsql security invoker set search_path = '' as $$
declare
  a site_gopalacetw.payment_attempts%rowtype;
  o site_gopalacetw.orders%rowtype;
  it record;
  cur_qty int;
  new_qty int;
  stock_lines text[] := '{}';
  paid_statuses text[] := array['processing','completed'];
  ptype text; psub text;
  extra jsonb := '{}';
begin
  select * into a from site_gopalacetw.payment_attempts where merchant_trade_no = p_trade_no for update;
  if not found then return 'unknown_trade_no'; end if;
  select * into o from site_gopalacetw.orders where id = a.order_id for update;
  if not found then return 'unknown_trade_no'; end if;

  update site_gopalacetw.payment_attempts
     set notify_count = notify_count + 1, last_notified_at = now(), updated_at = now()
   where id = a.id;

  if p_amount is distinct from a.amount or p_amount is distinct from ceil(o.total)::int then
    insert into site_gopalacetw.order_notes(order_id, note, added_by)
    values (o.id, format('綠界通知金額不符，未變更訂單（交易 %s：通知 %s 元／訂單 %s 元）', p_trade_no, p_amount, ceil(o.total)::int), 'ecpay');
    insert into site_gopalacetw.audit_log(actor_type, actor_id, action, entity_type, entity_id, after)
    values ('system', 'ecpay', 'payment_amount_mismatch', 'order', o.id::text,
            jsonb_build_object('merchant_trade_no', p_trade_no, 'notified_amount', p_amount, 'expected_amount', a.amount));
    return 'amount_mismatch';
  end if;

  ptype := split_part(coalesce(p_payment_type, ''), '_', 1);
  psub := split_part(coalesce(p_payment_type, ''), '_', 2);

  if p_rtn_code = '1' then
    if p_block_reason is not null then
      -- 防呆：測試環境／測試特店金鑰用在正式網域 → 一律不標記已付款，留後台警示
      if a.status = 'blocked' then return 'blocked_test_env'; end if;
      update site_gopalacetw.payment_attempts set status = 'blocked', rtn_code = p_rtn_code, rtn_msg = p_rtn_msg,
        trade_no = p_ecpay_trade_no, payment_type = p_payment_type, payment_date = p_payment_date, simulate_paid = p_simulate, updated_at = now()
       where id = a.id;
      insert into site_gopalacetw.order_notes(order_id, note, added_by)
      values (o.id, format('⚠ 警示：收到測試環境／測試特店的付款成功通知（交易 %s），網站為正式網域，已拒絕標記為已付款，請勿出貨並檢查綠界金鑰設定。原因：%s', p_trade_no, p_block_reason), 'ecpay');
      insert into site_gopalacetw.audit_log(actor_type, actor_id, action, entity_type, entity_id, after)
      values ('system', 'ecpay', 'payment_blocked_test_env', 'order', o.id::text,
              jsonb_build_object('merchant_trade_no', p_trade_no, 'trade_no', p_ecpay_trade_no, 'amount', p_amount, 'reason', p_block_reason, 'env', a.env));
      return 'blocked_test_env';
    end if;

    if not p_count_as_paid then
      -- 正式環境的「模擬付款」：不是真的付款，不可出貨
      if a.status = 'simulated' then return 'simulated'; end if;
      update site_gopalacetw.payment_attempts set status = 'simulated', rtn_code = p_rtn_code, rtn_msg = p_rtn_msg,
        trade_no = p_ecpay_trade_no, payment_type = p_payment_type, payment_date = p_payment_date, simulate_paid = p_simulate, updated_at = now()
       where id = a.id;
      insert into site_gopalacetw.order_notes(order_id, note, added_by)
      values (o.id, format('收到綠界模擬付款通知（SimulatePaid=1，交易 %s），未變更訂單狀態，請勿出貨。', p_trade_no), 'ecpay');
      return 'simulated';
    end if;

    if a.status = 'paid' then return 'already_paid'; end if;

    update site_gopalacetw.payment_attempts set status = 'paid', rtn_code = p_rtn_code, rtn_msg = p_rtn_msg,
      trade_no = p_ecpay_trade_no, payment_type = p_payment_type, payment_date = p_payment_date, simulate_paid = p_simulate, updated_at = now()
     where id = a.id;

    if o.status = any(paid_statuses) or o.date_paid is not null then
      insert into site_gopalacetw.order_notes(order_id, note, added_by)
      values (o.id, format('注意：此訂單已付款，又收到另一筆綠界付款成功通知（交易 %s，綠界編號 %s，%s 元），請至綠界後台確認並退款。', p_trade_no, p_ecpay_trade_no, p_amount), 'ecpay');
      insert into site_gopalacetw.audit_log(actor_type, actor_id, action, entity_type, entity_id, after)
      values ('system', 'ecpay', 'payment_duplicate', 'order', o.id::text,
              jsonb_build_object('merchant_trade_no', p_trade_no, 'trade_no', p_ecpay_trade_no, 'amount', p_amount));
      return 'duplicate_payment';
    end if;

    -- 付款完成：預留中的庫存（order_stock_reduced=yes）由觸發器轉為正式扣減，不重複扣；
    -- 已釋放（失敗／逾期取消後才付款）則在此重新扣減（可能低於 0，留備註請人工確認）。
    if coalesce(o.meta->>'order_stock_reduced', 'no') <> 'yes' then
      for it in select id, name, sku, product_id, variation_id, quantity from site_gopalacetw.order_items
                 where order_id = o.id and item_type = 'line_item' order by id loop
        cur_qty := null;
        if it.variation_id is not null then
          select stock_quantity into cur_qty from site_gopalacetw.product_variations
           where id = it.variation_id and manage_stock and stock_quantity is not null for update;
          if found then
            new_qty := cur_qty - it.quantity;
            update site_gopalacetw.product_variations
               set stock_quantity = new_qty,
                   stock_status = case when new_qty > 0 then 'instock' when backorders <> 'no' then 'onbackorder' else 'outofstock' end
             where id = it.variation_id;
            stock_lines := stock_lines || format('%s%s %s→%s', it.name, case when coalesce(it.sku, '') <> '' then ' (' || it.sku || ')' else '' end, cur_qty, new_qty);
            continue;
          end if;
        end if;
        if it.product_id is not null then
          select stock_quantity into cur_qty from site_gopalacetw.products
           where id = it.product_id and manage_stock and stock_quantity is not null for update;
          if found then
            new_qty := cur_qty - it.quantity;
            update site_gopalacetw.products
               set stock_quantity = new_qty,
                   stock_status = case when new_qty > 0 then 'instock' when backorders <> 'no' then 'onbackorder' else 'outofstock' end
             where id = it.product_id;
            stock_lines := stock_lines || format('%s%s %s→%s', it.name, case when coalesce(it.sku, '') <> '' then ' (' || it.sku || ')' else '' end, cur_qty, new_qty);
          end if;
        end if;
      end loop;
    end if;
    if coalesce(o.meta->>'recorded_sales', 'no') <> 'yes' then
      update site_gopalacetw.products p set total_sales = p.total_sales + s.q
        from (select product_id, sum(quantity)::int q from site_gopalacetw.order_items
               where order_id = o.id and item_type = 'line_item' and product_id is not null group by product_id) s
       where p.id = s.product_id;
    end if;
    -- 取消時已回補的優惠券，付款後重新計入
    if coalesce(o.meta->>'coupon_usage_restored', 'no') = 'yes' then
      perform site_gopalacetw._count_order_coupons(o.id, lower(o.billing_email));
      extra := jsonb_build_object('coupon_usage_restored', 'no', 'coupon_usage_counted', 'yes');
    end if;

    update site_gopalacetw.orders
       set status = 'processing', date_paid = now(), transaction_id = p_ecpay_trade_no, updated_at = now(),
           meta = meta || extra || jsonb_build_object(
             'order_stock_reduced', 'yes', 'recorded_sales', 'yes',
             'ecpay', coalesce(meta->'ecpay', '{}'::jsonb) || jsonb_build_object(
               'MerchantTradeNo', p_trade_no, 'TradeNo', p_ecpay_trade_no, 'payment_type', ptype, 'payment_subtype', psub,
               'PaymentDate', p_payment_date, 'env', a.env, 'SimulatePaid', p_simulate))
     where id = o.id;

    insert into site_gopalacetw.order_notes(order_id, note, added_by) values (o.id, '付款完成', 'ecpay');
    if array_length(stock_lines, 1) > 0 then
      insert into site_gopalacetw.order_notes(order_id, note, added_by) values (o.id, '庫存量已減少： ' || array_to_string(stock_lines, ', '), 'ecpay');
    end if;
    if o.status in ('cancelled', 'failed') then
      insert into site_gopalacetw.order_notes(order_id, note, added_by)
      values (o.id, format('⚠ 注意：訂單在「%s」狀態後才收到付款成功通知，已重新扣庫存，請確認庫存是否足夠出貨。', site_gopalacetw._order_status_label(o.status)), 'ecpay');
    end if;
    insert into site_gopalacetw.order_notes(order_id, note, added_by)
    values (o.id, format('訂單狀態由 %s 變更為 處理中.', site_gopalacetw._order_status_label(o.status)), 'ecpay');
    insert into site_gopalacetw.audit_log(actor_type, actor_id, action, entity_type, entity_id, before, after)
    values ('system', 'ecpay', 'payment_complete', 'order', o.id::text,
            jsonb_build_object('status', o.status),
            jsonb_build_object('status', 'processing', 'merchant_trade_no', p_trade_no, 'trade_no', p_ecpay_trade_no,
                               'amount', p_amount, 'payment_type', p_payment_type, 'env', a.env, 'simulate_paid', p_simulate,
                               'stock', to_jsonb(stock_lines)));
    return 'paid';
  end if;

  -- RtnCode ≠ 1：未付款 → 失敗（觸發器釋放保留庫存）；已付款 → 只記備註
  if a.status in ('failed', 'paid', 'blocked') then
    return case when a.status = 'paid' then 'already_paid' else 'already_failed' end;
  end if;
  update site_gopalacetw.payment_attempts set status = 'failed', rtn_code = p_rtn_code, rtn_msg = p_rtn_msg,
    trade_no = nullif(p_ecpay_trade_no, ''), payment_type = p_payment_type, payment_date = p_payment_date, updated_at = now()
   where id = a.id;
  insert into site_gopalacetw.order_notes(order_id, note, added_by)
  values (o.id, format('未知的付款狀態：%s（%s）', p_rtn_code, p_rtn_msg), 'ecpay');
  if o.status = any(paid_statuses) or o.date_paid is not null then
    insert into site_gopalacetw.order_notes(order_id, note, added_by) values (o.id, '已付款訂單收到付款失敗通知', 'ecpay');
    return 'failed_on_paid';
  end if;
  if o.status = 'pending' then
    update site_gopalacetw.orders set status = 'failed', updated_at = now() where id = o.id;
    insert into site_gopalacetw.order_notes(order_id, note, added_by)
    values (o.id, format('%s 訂單狀態由 %s 變更為 失敗.', p_rtn_msg, site_gopalacetw._order_status_label(o.status)), 'ecpay');
  end if;
  insert into site_gopalacetw.audit_log(actor_type, actor_id, action, entity_type, entity_id, before, after)
  values ('system', 'ecpay', 'payment_failed', 'order', o.id::text, jsonb_build_object('status', o.status),
          jsonb_build_object('status', 'failed', 'merchant_trade_no', p_trade_no, 'rtn_code', p_rtn_code, 'rtn_msg', p_rtn_msg));
  return 'failed';
end;
$$;

-- ---------- 權限：只給 service_role ----------
do $$
declare f text;
begin
  foreach f in array array[
    'site_gopalacetw._reserve_order_stock(bigint, boolean)',
    'site_gopalacetw._hold_order_stock(bigint, int, text)',
    'site_gopalacetw._release_order_stock(bigint, text)',
    'site_gopalacetw._count_order_coupons(bigint, text)',
    'site_gopalacetw._uncount_order_coupons(bigint, text)',
    'site_gopalacetw._orders_status_hold_trg()',
    'site_gopalacetw.checkout_place_hold(bigint, boolean, int, int, int)',
    'site_gopalacetw.ecpay_begin_attempt(bigint, text, text, int, text, int, int, int)',
    'site_gopalacetw.ecpay_cancel_unpaid(int)',
    'site_gopalacetw.ecpay_apply_notification(text, int, text, text, text, text, text, boolean, boolean, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
