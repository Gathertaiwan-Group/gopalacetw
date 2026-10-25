-- 第三階段：私有資料匯入前的權限收斂（資料本身由 scripts/data-import/import_private.py 匯入，不進 repo）
-- 1) 顧客／訂單等私有表：除了 RLS 無 policy 之外，再撤銷 anon/authenticated 的表權限（雙重保險）
do $$
declare t text;
begin
  foreach t in array array['customers','carts','cart_items','orders','order_items','order_notes','coupons',
    'form_submissions','admins','audit_log'] loop
    execute format('revoke all on table site_gopalacetw.%I from anon, authenticated', t);
    execute format('alter table site_gopalacetw.%I enable row level security', t);
  end loop;
end $$;

-- 2) 留言：公開可讀已核准留言，但 author_email / author_ip 為個資 → 欄位層級授權
revoke select on table site_gopalacetw.comments from anon, authenticated;
grant select (id, post_id, product_id, parent_id, author_name, author_url, author_user_id, content, status, type,
  rating, verified, created_at, updated_at) on table site_gopalacetw.comments to anon, authenticated;

-- 3) 私有附件 metadata 不公開（media.status = 'private' 已被 public_read policy 排除）；文章密碼同理（posts.password is null 才公開）
