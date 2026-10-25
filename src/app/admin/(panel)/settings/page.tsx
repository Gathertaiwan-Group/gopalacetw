import { requireAdmin } from "@/lib/admin/guard";
import { getSettings } from "@/lib/admin/service";
import { fmtDate } from "@/lib/admin/format";
import { mediaMap, type SP } from "@/lib/admin/loaders";
import { Flash } from "@/components/admin/Fields";
import { MediaPicker } from "@/components/admin/MediaPicker";
import { saveSettingsAction } from "../../actions";

export default async function Settings({ searchParams }: { searchParams: Promise<SP> }) {
  await requireAdmin();
  const sp = await searchParams;
  const rows = await getSettings();
  const s: Record<string, any> = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const media = await mediaMap([s.site_logo?.media_id, s.site_icon?.media_id]);
  const logo = s.site_logo?.media_id ? media[s.site_logo.media_id] || null : null;
  const icon = s.site_icon?.media_id ? media[s.site_icon.media_id] || (s.site_icon?.url ? { id: s.site_icon.media_id, url: s.site_icon.url } : null) : null;
  const tIds = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v || ""));
  const text = (name: string, label: string, value: unknown, help?: string) => (
    <div className="adm-field">
      <label htmlFor={name}>{label}</label>
      <input id={name} name={name} defaultValue={String(value ?? "")} />
      {help ? <div className="adm-help">{help}</div> : null}
    </div>
  );
  return (
    <>
      <h1 className="adm-h1">網站設定</h1>
      <Flash sp={sp} />
      <form action={saveSettingsAction}>
        <div className="adm-cols2">
          <div className="adm-card">
            <h2 className="adm-h2">一般</h2>
            {text("site_name", "網站名稱", s.site?.name)}
            {text("site_description", "網站說明（標語）", s.site?.description)}
            <div className="adm-field">
              <label>網站 Logo</label>
              <MediaPicker name="logo_media_id" initial={logo} />
              <div className="adm-help">未設定時沿用舊站 Logo。</div>
            </div>
            <div className="adm-field">
              <label>網站圖示（favicon）</label>
              <MediaPicker name="icon_media_id" initial={icon} />
            </div>
            {text("footer_copyright", "頁尾版權文字", s.footer?.copyright)}
          </div>
          <div className="adm-card">
            <h2 className="adm-h2">聯絡資訊與社群</h2>
            {text("contact_phone", "電話", s.contact?.phone)}
            {text("contact_email", "Email", s.contact?.email)}
            {text("contact_address", "地址", s.contact?.address)}
            {text("contact_hours", "營業時間", s.contact?.hours)}
            {text("social_line", "LINE 網址", s.social?.line)}
            {text("social_facebook", "Facebook 粉專網址", s.social?.facebook)}
            {text("social_instagram", "Instagram 網址", s.social?.instagram)}
            <h2 className="adm-h2 adm-mt">追蹤碼</h2>
            {text("tracking_gtag", "Google 代碼（GA4／Google tag ID）", tIds(s.tracking?.google_tag), "例：GT-XXXXXXX 或 G-XXXXXXX；前台頁首載入第一個")}
            {text("tracking_pixel", "Facebook Pixel ID", tIds(s.tracking?.facebook_pixel?.pixel_ids))}
          </div>
        </div>
        <button className="adm-btn pri" type="submit">儲存設定</button>
      </form>
      <div className="adm-card adm-mt">
        <h2 className="adm-h2">所有設定值（進階）</h2>
        <p className="adm-muted">以下為資料庫中的原始設定（含運費、付款方式、閱讀設定等），可個別以 JSON 編輯。</p>
        <table className="adm-table">
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td style={{ width: 200 }}>
                  <a href={`/admin/e/settings/${r.key}/`}><b>{r.key}</b></a>
                  <div className="adm-muted">{r.is_public ? "公開" : "私有"}・{r.source}・{fmtDate(r.updated_at)}</div>
                </td>
                <td><pre className="adm-json" style={{ maxHeight: 120 }}>{JSON.stringify(r.value, null, 2)}</pre></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="adm-mt"><a className="adm-btn sm" href="/admin/e/settings/new/">新增設定鍵</a></p>
      </div>
    </>
  );
}
