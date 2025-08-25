/* ================== 可調整參數 ================== */
const SHEET_ID = '<<你的 Google Sheet ID>>';          // 目標試算表
const SHEET_NAME = '表單';                             // 工作表名稱（不存在會自動建立）
const DRIVE_FOLDER_ID = '<<你的圖片上傳資料夾 ID>>';    // Google Drive 目的資料夾
const MAKE_WEBHOOK_URL = 'https://hook.eu2.make.com/mxd447qyeae62is1m1vsutndp3bqhudf'; // 你提供的 URL
/* ================================================= */

const ALLOWED_MIME = new Set(['image/jpeg','image/png','image/webp','image/gif']);

function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('新商品申請')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename){ return HtmlService.createHtmlOutputFromFile(filename).getContent(); }

function _sheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}
function _uuid(){ return Utilities.getUuid(); }
function _tz(){ return 'Asia/Taipei'; }
function _nowISO(){ return Utilities.formatDate(new Date(), _tz(), "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function _s(x){ return x==null ? '' : String(x).trim(); }

/* ========= 後端組 Email HTML（避免在模板迴圈相容性問題） ========= */
function buildEmailHTML(data){
  const esc = s => String(s||'').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
  let html = `
    <h2 style="margin:0 0 6px;">新商品申請</h2>
    <p style="margin:0 0 8px;">
      <b>分店：</b>${esc(data.store)}<br>
      <b>申請人：</b>${esc(data.applicant)}（${esc(data.email)} / ${esc(data.phone)}）<br>
      <b>申請編號：</b>${esc(data.apply_no)}<br>
      <b>備註：</b>${esc(data.remark)}
    </p>
    <hr style="border:none;border-top:1px solid #eee;margin:10px 0;">`;

  (data.products||[]).forEach((p, i)=>{
    html += `
      <h3 style="margin:10px 0 4px;">${i+1}. ${esc(p.product_name)}</h3>
      <p style="margin:0 0 8px;color:#444;line-height:1.6;">
        規格：${esc(p.spec)}｜建議售價：${esc(p.price_suggest)}｜成本：${esc(p.cost)}<br>
        素別：${esc(p.vegetarian)}｜過敏原：${esc(p.allergens)}<br>
        成分：${esc(p.ingredients)}<br>
        保存期限：${esc(p.shelf_life)}｜保存方式：${esc(p.storage)}<br>
        供應型態：${esc(p.supply_type)}｜預計上架日：${esc(p.launch_date)}
      </p>
      <div style="margin:6px 0 10px;">`;
    (p.images||[]).forEach(img=>{
      html += `<img src="${esc(img.url)}" alt="產品圖片"
                   style="width:140px;height:140px;object-fit:cover;border-radius:8px;margin:4px;border:1px solid #eee;">`;
    });
    html += `</div>`;
  });

  return html;
}

/**
 * 前端丟 base64 圖片陣列進來，這裡轉成 Drive 檔
 * @param {{items: Array<{name:string, mime:string, base64:string}>}} payload
 * @returns {Array<{name:string,url:string,id:string,mime:string,size:number}>}
 */
function saveImages(payload){
  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const out = [];
  (payload.items||[]).forEach((it, i)=>{
    const name = _s(it.name) || ('image_'+(i+1)+'.jpg');
    const mime = _s(it.mime) || 'image/jpeg';
    if(!ALLOWED_MIME.has(mime)) throw new Error('不支援的圖片格式：'+mime);
    const b64 = _s(it.base64);
    const bytes = Utilities.base64Decode(b64.split(',').pop());
    const blob = Utilities.newBlob(bytes, mime, name);
    const file = folder.createFile(blob);
    // 如需公開可改 ANYONE_WITH_LINK；目前設「公司網域知道連結者可看」
    file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
    out.push({ name, url:file.getUrl(), id:file.getId(), mime, size: bytes.length });
  });
  return out;
}

/**
 * 建立多品項申請：寫入 Sheet + 通知 Make（Make 再串 EmailJS）
 * data = {
 *   apply_no, store, applicant, email, phone, remark,
 *   products: [{
 *     product_name, spec, price_suggest, cost,
 *     vegetarian, allergens, ingredients,
 *     shelf_life, storage, supply_type, launch_date,
 *     images:[{name,url,id,mime,size}]
 *   }, ...]
 * }
 */
function createApplications(data){
  // 伺服器端再次驗證必填（所有欄位必填）
  const commonReq = ['store','applicant','email','phone','remark'];
  commonReq.forEach(k=>{ if(!_s(data[k])) throw new Error('共同欄位缺少：'+k); });

  const products = Array.isArray(data.products)?data.products:[];
  if(!products.length) throw new Error('沒有任何品項');

  products.forEach((p, idx)=>{
    const req = ['product_name','spec','price_suggest','cost','vegetarian','allergens','ingredients','shelf_life','storage','supply_type','launch_date'];
    req.forEach(k=>{ if(!_s(p[k])) throw new Error(`第 ${idx+1} 個品項缺少：${k}`); });
    if(!p.images || !p.images.length) throw new Error(`第 ${idx+1} 個品項需至少 1 張圖片`);
  });

  const sh = _sheet();
  const ts = _nowISO();
  const applyNo = _s(data.apply_no) || _uuid();

  // 表頭
  const headers = [
    '申請編號','建立時間',
    '分店','申請人','Email','電話','備註',
    '商品名稱','規格/包裝','建議售價','成本',
    '素別','過敏原','成分/原料',
    '保存期限','保存方式','供應型態','預計上架日',
    '圖片連結','品項序'
  ];
  if (sh.getLastRow()===0) sh.appendRow(headers);

  // 去重：同申請編號不重複
  if (sh.getLastRow()>=2){
    const exist = sh.getRange(2,1,sh.getLastRow()-1,1).getValues().flat();
    if (exist.includes(applyNo)){
      return { ok:true, dedup:true, apply_no:applyNo, message:'已存在相同申請編號，略過寫入與通知。' };
    }
  }

  // 寫入每個品項一列
  products.forEach((p, i)=>{
    const imgs = (p.images||[]).map(x=>x.url).join('\n');
    sh.appendRow([
      applyNo, ts,
      _s(data.store), _s(data.applicant), _s(data.email), _s(data.phone), _s(data.remark),
      _s(p.product_name), _s(p.spec), _s(p.price_suggest), _s(p.cost),
      _s(p.vegetarian), _s(p.allergens), _s(p.ingredients),
      _s(p.shelf_life), _s(p.storage), _s(p.supply_type), _s(p.launch_date),
      imgs, (i+1)
    ]);
  });

  // 準備寄信內容（交給 Make → EmailJS）
  const email_html = buildEmailHTML({ apply_no:applyNo, ...data });

  // 通知 Make（一次送共同 + 全部品項；附上 email_html 讓 EmailJS 直接帶入）
  try{
    const payload = {
      type: "new_product_application",      // 讓 Make 以 Router 分流
      apply_no: applyNo,
      created_at: ts,
      store: _s(data.store),
      applicant: _s(data.applicant),
      email: _s(data.email),
      phone: _s(data.phone),
      remark: _s(data.remark),
      products,                             // 全品項詳情（含 images）
      // ➜ EmailJS 專用欄位（Make 直接映射進 template）
      email_subject: `新商品申請｜${_s(data.store)}｜${applyNo}`,
      email_to: _s(data.email),            // 也可改成固定通知信箱
      email_html
    };

    UrlFetchApp.fetch(MAKE_WEBHOOK_URL, {
      method:'post',
      contentType:'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions:true
    });
  }catch(e){
    return { ok:true, apply_no:applyNo, notice:'Make 通知失敗（已寫入表單）', error:String(e) };
  }

  return { ok:true, apply_no:applyNo, message:'已寫入多品項並通知總部' };
}
