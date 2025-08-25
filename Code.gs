/* ================== 可調整參數 ================== */
const SHEET_ID = '<<你的 Google Sheet ID>>';          // 目標試算表
const SHEET_NAME = '表單';                             // 工作表名稱（不存在會自動建立）
const DRIVE_FOLDER_ID = '<<你的圖片上傳資料夾 ID>>';    // Google Drive 目的資料夾
const MAKE_WEBHOOK_URL = '<<你的 Make Webhook URL>>';  // 通知總部用
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
    // 若要公開可改：DriveApp.Access.ANYONE_WITH_LINK
    file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
    out.push({ name, url:file.getUrl(), id:file.getId(), mime, size: bytes.length });
  });
  return out;
}

/**
 * 建立多品項申請
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
  // 伺服器端再次驗證必填
  const commonReq = ['store','applicant','email'];
  commonReq.forEach(k=>{ if(!_s(data[k])) throw new Error('共同欄位缺少：'+k); });

  const products = Array.isArray(data.products)?data.products:[];
  if(!products.length) throw new Error('沒有任何品項');

  // 每個品項欄位必填 + 至少 1 張圖片
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

  // 寫入
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

  // 通知 Make（一次送共同+全部品項）
  try{
    UrlFetchApp.fetch(MAKE_WEBHOOK_URL, {
      method:'post',
      contentType:'application/json',
      payload: JSON.stringify({
        apply_no: applyNo,
        created_at: ts,
        store: _s(data.store),
        applicant: _s(data.applicant),
        email: _s(data.email),
        phone: _s(data.phone),
        remark: _s(data.remark),
        products
      }),
      muteHttpExceptions:true
    });
  }catch(e){
    return { ok:true, apply_no:applyNo, notice:'Make 通知失敗（已寫入表單）', error:String(e) };
  }

  return { ok:true, apply_no:applyNo, message:'已寫入多品項並通知總部' };
}
