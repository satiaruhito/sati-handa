// 開発用サーバー：ゲームを配信し、プレイログを logs/plays.jsonl に追記する。
// 起動: node server.js  →  http://localhost:8123/qr （スマホ用のQRコードが出る）
// 同じWi-Fi（家庭内LAN）の端末からもつながる。公開用ではない。
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8123;
const ROOT = __dirname;
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'plays.jsonl');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon' };

// ---------- ネットワーク ----------
function isPrivate(ip) {
  ip = (ip || '').replace(/^::ffff:/, '');
  if (ip === '::1' || ip.startsWith('127.')) return true;
  if (ip.startsWith('192.168.') || ip.startsWith('10.')) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  return !!m && +m[1] >= 16 && +m[1] <= 31;
}
// スマホから開くためのアドレス。家庭用ルーターで多い 192.168.* を優先する
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && isPrivate(a.address)) out.push(a.address);
    }
  }
  const rank = ip => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}

// ---------- QRコード（バージョン3・誤り訂正L・バイトモード固定、53バイトまで） ----------
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
  return z;
}
function rsRemainder(data, degree) {
  const div = new Array(degree).fill(0); div[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      div[j] = gfMul(div[j], root);
      if (j + 1 < degree) div[j] ^= div[j + 1];
    }
    root = gfMul(root, 2);
  }
  const res = new Array(degree).fill(0);
  for (const b of data) {
    const f = b ^ res.shift(); res.push(0);
    div.forEach((c, i) => { res[i] ^= gfMul(c, f); });
  }
  return res;
}
function makeQR(text) {
  const SIZE = 29, DATA = 55, ECC = 15;
  const bytes = Array.from(Buffer.from(text, 'utf8'));
  if (bytes.length > 53) return null;

  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4); put(bytes.length, 8);
  bytes.forEach(b => put(b, 8));
  put(0, Math.min(4, DATA * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  for (let pad = 0xEC; bits.length < DATA * 8; pad ^= 0xEC ^ 0x11) put(pad, 8);
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  const all = cw.concat(rsRemainder(cw, ECC));

  const m = [], fn = [];
  for (let y = 0; y < SIZE; y++) { m.push(new Array(SIZE).fill(false)); fn.push(new Array(SIZE).fill(false)); }
  const set = (x, y, dark) => { m[y][x] = !!dark; fn[y][x] = true; };

  for (let i = 0; i < SIZE; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }   // タイミング
  for (const [cx, cy] of [[3, 3], [SIZE - 4, 3], [3, SIZE - 4]]) {                      // 位置検出
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) set(x, y, d !== 2 && d !== 4);
    }
  }
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)                     // 位置合わせ
    set(22 + dx, 22 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);

  // 形式情報（誤り訂正L=01、マスク0）
  const fdata = (1 << 3) | 0;
  let rem = fdata;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const fb = ((fdata << 10) | rem) ^ 0x5412;
  const bit = i => ((fb >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(SIZE - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, SIZE - 15 + i, bit(i));
  set(8, SIZE - 8, true);

  // データをジグザグに配置
  let k = 0;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < SIZE; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? SIZE - 1 - vert : vert;
        if (!fn[y][x] && k < all.length * 8) { m[y][x] = ((all[k >>> 3] >>> (7 - (k & 7))) & 1) !== 0; k++; }
      }
    }
  }
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++)                          // マスク0
    if (!fn[y][x] && (x + y) % 2 === 0) m[y][x] = !m[y][x];
  return m;
}
function qrSvg(text) {
  const m = makeQR(text);
  if (!m) return '';
  const q = 4, n = m.length + q * 2;
  let d = '';
  m.forEach((row, y) => row.forEach((on, x) => { if (on) d += 'M' + (x + q) + ' ' + (y + q) + 'h1v1h-1z'; }));
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges">' +
    '<rect width="' + n + '" height="' + n + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
}
function qrPage() {
  const ips = lanAddresses();
  const urls = ips.map(ip => 'http://' + ip + ':' + PORT);
  const main = urls[0];
  const body = main
    ? '<p>スマホのカメラで読み取ってください（PCと同じWi-Fiにつないでおく）</p>' +
      '<div class="qr">' + qrSvg(main) + '</div><p class="url">' + main + '</p>' +
      (urls.length > 1 ? '<p class="sub">つながらないときはこちらも試してください：<br>' + urls.slice(1).join('<br>') + '</p>' : '')
    : '<p>Wi-Fiのアドレスが見つかりません。PCがWi-Fiにつながっているか確認してください。</p>';
  return '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>はんだ付けチャレンジ（開発用）</title>' +
    '<style>body{margin:0;background:#17181b;color:#e6eaee;font-family:"Yu Gothic","Meiryo",system-ui,sans-serif;text-align:center;padding:32px 16px}' +
    'h1{font-size:24px;margin:0 0 20px}.qr{width:min(320px,80vw);margin:16px auto;border-radius:12px;overflow:hidden}.qr svg{display:block;width:100%}' +
    '.url{font:bold 20px monospace;color:#ffd34d;word-break:break-all}.sub{color:#aab2ba;font-size:14px}' +
    'a.btn{display:inline-block;margin-top:24px;padding:14px 36px;border-radius:30px;background:#2f9d5c;color:#fff;font-weight:bold;font-size:18px;text-decoration:none}</style>' +
    '</head><body><h1>はんだ付けチャレンジ（開発用）</h1>' + body +
    '<a class="btn" href="/">このPCで遊ぶ</a>' +
    '<p class="sub">遊んだ結果は logs/plays.jsonl に記録されます</p></body></html>';
}

// ---------- サーバー ----------
function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

http.createServer((req, res) => {
  // 家庭内LANとこのPC以外からは受け付けない
  if (!isPrivate(req.socket.remoteAddress)) return send(res, 403, 'forbidden');
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/log') {
    let body = '', tooBig = false;
    req.on('data', c => { body += c; if (body.length > 100000) { tooBig = true; req.destroy(); } });
    req.on('end', () => {
      if (tooBig) return;
      let data;
      try { data = JSON.parse(body); } catch (e) { return send(res, 400, 'bad json'); }
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(LOG_FILE, JSON.stringify(data) + '\n');
      console.log('log: ' + data.total + '点 ' + data.rank + ' (' + (data.device || '?') + ')');
      send(res, 200, 'ok');
    });
    return;
  }

  if (req.method !== 'GET') return send(res, 405, 'method not allowed');
  if (url.pathname === '/qr') return send(res, 200, qrPage(), TYPES['.html']);
  let rel;
  try { rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); }
  catch (e) { return send(res, 400, 'bad request'); }
  const file = path.normalize(path.join(ROOT, rel));
  // フォルダの外と、ログ・設定類は配信しない
  if (!file.startsWith(ROOT + path.sep) || rel.startsWith('/logs') || rel.startsWith('/.')) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, buf, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log('PC用:     http://localhost:' + PORT);
  for (const ip of lanAddresses()) console.log('スマホ用: http://' + ip + ':' + PORT + '  （同じWi-Fiから）');
  console.log('QRコード: http://localhost:' + PORT + '/qr');
  console.log('ログ:     ' + LOG_FILE);
  console.log('止めるときは Ctrl+C');
});
