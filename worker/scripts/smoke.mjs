#!/usr/bin/env node
// 端到端冒烟测试: 拿真实的地图分享链接去打一个已部署的 Worker, 校验解析结果。
//
// 与 `npm test` 的分工:
//   npm test   纯函数单测, 不联网, 必须永远绿 —— CI 里跑这个
//   npm smoke  依赖第三方地图服务与线上部署, 会因外部变动而失败 —— 手动跑这个
//
// 用法:
//   npm run smoke                              打默认线上实例
//   npm run smoke -- http://127.0.0.1:8787     打本地 wrangler dev
//
// 期望值是 2026-08-07 在 fbd9a0a 上实测锁定的。TOL_M 取 10 米: 坐标系用错的症状
// 是几百米到几公里(GCJ-02 在深圳约 600 米, 百度墨卡托算错约 10 公里), 10 米足以
// 抓住所有这类回归, 又不会因为各家地图微调针脚位置而误报。

const DEFAULT_BASE = "https://wloc-spoofer.onebird.workers.dev";
const BASE = (process.argv[2] || process.env.WLOC_BASE || DEFAULT_BASE).replace(/\/+$/, "");
const TOL_M = 10;
const TIMEOUT_MS = 30000;

// expect: {lat, lon} 断言坐标; {err} 断言报错文案包含该子串
const CASES = [
  // —— 港澳台: 苹果直接给 WGS84, 不能再做 GCJ-02 反算 ——
  { name: "苹果 香港 ifc", url: "https://maps.apple/p/Bc17UWpXwruV_m", expect: { lat: 22.284774, lon: 114.159437 } },
  { name: "苹果 澳门 Galaxy", url: "https://maps.apple/p/38PG0BbqJGX2Wm", expect: { lat: 22.148148, lon: 113.555399 } },
  { name: "苹果 台北 101", url: "https://maps.apple/p/V_Q.uku8w7Nwys", expect: { lat: 25.033626, lon: 121.564215 } },

  // —— 中国大陆: 必须做 GCJ-02 → WGS84 ——
  { name: "Google 深圳", url: "https://maps.app.goo.gl/eyt9wyYcN3p3cpo88", expect: { lat: 22.544818, lon: 113.950818 } },
  { name: "高德 深圳", url: "https://surl.amap.com/j7NpZxc13AP", expect: { lat: 22.544865, lon: 113.951072 } },
  { name: "百度 深圳", url: "https://j.map.baidu.com/c1/Vg", expect: { lat: 22.544901, lon: 113.951079 } },

  // —— 境外: 原样透传, 任何转换都是 bug ——
  { name: "苹果 美国", url: "https://maps.apple/p/0mZU6qFyXAEYRe", expect: { lat: 37.334859, lon: -122.00904 } },
  { name: "Google 境外", url: "https://maps.app.goo.gl/5nBy6XiSoQsbLQuz5", expect: { lat: 37.334644, lon: -122.008972 } },

  // —— 百度网页版 URL 里的 BD09MC 米制坐标(浏览器地址栏复制而来) ——
  {
    name: "百度网页版 香港",
    url: "https://map.baidu.com/poi/苹果专卖店(国际金融中心商场店)/@12709535.375,2529761.45,19z?uid=a57be7fdfbe5fe527ec876a3",
    expect: { lat: 22.284737, lon: 114.158937 },
  },
  {
    name: "百度网页版 澳门",
    url: "https://map.baidu.com/poi/Apple澳门银河/@12642194.145,2513614.06,19z?uid=0837c040a87161f27e29bdde",
    expect: { lat: 22.149817, lon: 113.553929 },
  },
  {
    name: "百度网页版 台北",
    url: "https://map.baidu.com/poi/Apple台北101/@13533702.855,2862107.79,19z?uid=bcb26f432e2bce8cab059d8b",
    expect: { lat: 25.034124, lon: 121.563803 },
  },

  // —— 裸坐标 ——
  { name: "裸坐标", url: "22.544865,113.951072", expect: { lat: 22.544865, lon: 113.951072 } },

  // —— 必须失败的输入。给错坐标比解析失败严重得多, 所以这两条同样重要 ——
  { name: "百度短链 港澳台(应给出变通指引)", url: "https://j.map.baidu.com/4c/1yk", expect: { err: "复制整条地址再粘贴" } },
  { name: "越界坐标", url: "?q=999.1234,888.5678", expect: { err: "未能" } },
];

// padEnd 按 UTF-16 码元数, 中日韩字符在终端里占两格, 直接用会错位
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;
function padCols(s, cols) {
  let w = 0;
  for (const ch of s) w += WIDE.test(ch) ? 2 : 1;
  return s + " ".repeat(Math.max(0, cols - w));
}

// 打错了地址时对端可能回一整页 HTML, 原样打出来会淹没其他结果
function brief(v) {
  const s = (typeof v === "string" ? v : JSON.stringify(v)).replace(/\s+/g, " ").trim();
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function callApi(url) {
  const endpoint = `${BASE}/api/parse?format=json&u=${encodeURIComponent(url)}`;
  const resp = await fetch(endpoint, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.trim() };
  }
}

async function liveSha() {
  try {
    const resp = await fetch(`${BASE}/api/version`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return (await resp.json()).sha;
  } catch {
    return "<无法获取>";
  }
}

// 逐条串行: 短链解析服务对并发不友好, 而且失败时的输出顺序更好读
async function main() {
  console.log(`目标   ${BASE}`);
  console.log(`版本   ${await liveSha()}`);
  console.log(`容差   ${TOL_M} 米\n`);

  let failed = 0;
  for (const c of CASES) {
    const label = padCols(c.name, 34);
    let got;
    try {
      got = await callApi(c.url);
    } catch (e) {
      console.log(`✗ ${label} 请求失败: ${e.message}`);
      failed++;
      continue;
    }

    if (c.expect.err) {
      if (got.error && got.error.includes(c.expect.err)) {
        console.log(`✓ ${label} 如期报错`);
      } else {
        console.log(`✗ ${label} 本应报错并包含「${c.expect.err}」, 实得 ${brief(got)}`);
        failed++;
      }
      continue;
    }

    if (got.error || typeof got.lat !== "number") {
      console.log(`✗ ${label} 解析失败: ${brief(got.error || got)}`);
      failed++;
      continue;
    }

    const d = haversine(c.expect, got);
    if (d <= TOL_M) {
      console.log(`✓ ${label} ${got.lat}, ${got.lon}  (偏 ${d.toFixed(1)} 米)  ${got.name || ""}`);
    } else {
      console.log(`✗ ${label} 偏 ${d.toFixed(0)} 米`);
      console.log(`  ${" ".repeat(34)} 期望 ${c.expect.lat}, ${c.expect.lon}`);
      console.log(`  ${" ".repeat(34)} 实得 ${got.lat}, ${got.lon}`);
      failed++;
    }
  }

  console.log(`\n${CASES.length - failed}/${CASES.length} 通过`);
  if (failed) {
    console.log("提示: 刚 deploy 完就失败, 先核对上面的版本 SHA —— 新版本 rollout 有 POP 级滞后。");
    process.exit(1);
  }
}

main();
