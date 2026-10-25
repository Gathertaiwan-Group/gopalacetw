-- WordPress 站內搜尋只比對 wp_posts 的原始 post_title / post_excerpt / post_content（LIKE），
-- 不比對渲染後的區塊或短代碼輸出。新站 content 是渲染後 HTML，因此另存原始文字供搜尋用。
-- 後台／MCP 修改標題、摘要或內文後，search_raw 自動清空，改以新站目前的欄位比對（新內容即為新的原始內容）。
alter table site_gopalacetw.posts add column if not exists search_raw text;
alter table site_gopalacetw.products add column if not exists search_raw text;

create or replace function site_gopalacetw.clear_search_raw_posts() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.search_raw is not distinct from old.search_raw
     and (new.title is distinct from old.title or new.excerpt is distinct from old.excerpt or new.content is distinct from old.content) then
    new.search_raw := null;
  end if;
  return new;
end $$;

create or replace function site_gopalacetw.clear_search_raw_products() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.search_raw is not distinct from old.search_raw
     and (new.name is distinct from old.name or new.short_description is distinct from old.short_description or new.description is distinct from old.description) then
    new.search_raw := null;
  end if;
  return new;
end $$;

drop trigger if exists clear_search_raw on site_gopalacetw.posts;
create trigger clear_search_raw before update on site_gopalacetw.posts
  for each row execute function site_gopalacetw.clear_search_raw_posts();
drop trigger if exists clear_search_raw on site_gopalacetw.products;
create trigger clear_search_raw before update on site_gopalacetw.products
  for each row execute function site_gopalacetw.clear_search_raw_products();
-- 資料填入由 scripts/import-search-raw.mjs 自私有備份 wp_posts 匯入（只存原始標題／摘要／內文，不含個資）
