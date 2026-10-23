-- 前台階段：新增「註冊」表單定義（舊站無註冊表單；新站我的帳號以 Supabase Auth 提供註冊）
insert into site_gopalacetw.forms (slug, name, kind, fields, settings, source, is_active)
values ('register', '我的帳號註冊', 'register',
        '[{"name":"email","type":"email","required":true},{"name":"password","type":"password","required":true}]'::jsonb,
        '{"action":"/api/account/register/","method":"post","new_site_only":true}'::jsonb,
        'frontend', true)
on conflict (slug) do nothing;
