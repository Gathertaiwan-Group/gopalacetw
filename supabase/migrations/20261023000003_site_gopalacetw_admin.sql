-- 第二階段 Admin + MCP：後台排程發布、稽核查詢索引
-- 只動 site_gopalacetw schema。

-- 商品也支援排程發布（WordPress post_status = future）
alter table site_gopalacetw.products drop constraint if exists products_status_check;
alter table site_gopalacetw.products add constraint products_status_check
  check (status in ('publish','draft','pending','private','future','trash'));

-- 排程發布：讀取全站資料前把到期的 future 改為 publish（見 src/lib/data.ts promoteScheduled）
create index if not exists posts_future_idx on site_gopalacetw.posts(published_at) where status = 'future';
create index if not exists products_future_idx on site_gopalacetw.products(published_at) where status = 'future';

-- 稽核紀錄依操作者查詢
create index if not exists audit_log_actor_idx on site_gopalacetw.audit_log(actor_type, created_at desc);

-- 表單提交狀態（new / read / spam / archived）
create index if not exists form_submissions_status_idx on site_gopalacetw.form_submissions(status);
