-- 第三階段：響應式圖片變體（v/<寬>/<路徑>.webp，寬 480/960/1440，q75，不放大）
-- 格式：[{ "w": 480, "h": 480, "path": "v/480/2021/04/a.webp", "url": "https://.../v/480/2021/04/a.webp", "bytes": 12345 }]
alter table site_gopalacetw.media add column if not exists variants jsonb not null default '[]'::jsonb;
