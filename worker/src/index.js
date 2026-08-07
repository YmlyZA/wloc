import { Hono } from "hono/tiny";
import { getPageHtml } from "./page.js";
import { parseCoords, gcj02ToWgs84, toWgs84, round6, inRange } from "./parse.js";

const app = new Hono();

app.get("/", (c) => {
  return c.html(getPageHtml());
});

// 地图链接解析: 供快捷指令调用。
// GET /api/parse?u=<链接>&format=json&cs=<gcj|none>
//   返回 {lat, lon, name}; 高德/苹果地图(中国大陆均为 GCJ-02)自动转 WGS84; 境外坐标自动跳过(out_of_china)。cs=none 可强制不转换。
//   不带 format=json 时返回纯文本 "lat=..&lon=.." 片段。
app.get("/api/parse", async (c) => {
  const raw = c.req.query("u") || "";
  const cs = (c.req.query("cs") || "").toLowerCase();
  const fmt = (c.req.query("format") || "").toLowerCase();
  try {
    let { lat, lon, name, src } = await parseCoords(raw);
    // 默认按来源自动换算; cs=none 强制不转换, cs=gcj/bd 强制按指定坐标系转换。
    if (cs === "gcj") ({ lat, lon } = gcj02ToWgs84(lat, lon));
    else if (cs === "bd") ({ lat, lon } = toWgs84(lat, lon, "baidu"));
    else if (cs !== "none") ({ lat, lon } = toWgs84(lat, lon, src));
    // 出口再校验一次: cs= 是调用方指定的, 强行按错误坐标系换算也可能把值推出值域。
    // 宁可报错也不要返回一个能被当成坐标写进设备的数字。
    if (!inRange(lat, lon)) throw new Error("解析出的坐标超出合法范围");
    lat = round6(lat);
    lon = round6(lon);
    name = name || "";
    c.header("Access-Control-Allow-Origin", "*");
    if (fmt === "json") return c.json({ lat, lon, name });
    return c.text(`lat=${lat}&lon=${lon}`);
  } catch (e) {
    c.header("Access-Control-Allow-Origin", "*");
    return c.json({ error: String(e && e.message ? e.message : e) }, 422);
  }
});

// 报出当前实例跑的是哪个提交。存在的理由是 Cloudflare 的新版本在各 POP 上生效
// 有滞后: 部署返回成功之后, 一段时间内不同地区仍可能拿到旧代码。没有这个端点就
// 只能拿某个功能行为当探针, 而"这次改动改变了什么行为"每次都不一样, 上一次的探针
// 对下一次的改动往往不具区分性 —— 于是 CI 报绿, 实际测到的还是旧版本。
// GIT_SHA 由部署时的 --var 注入, 本地开发时为 dev。
app.get("/api/version", (c) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Cache-Control", "no-store");
  return c.json({ sha: (c.env && c.env.GIT_SHA) || "dev" });
});

// 兜底 500 也要带 CORS —— 否则快捷指令那边看到的是跨域错误, 而不是真正的原因。
app.onError((e, c) => {
  c.header("Access-Control-Allow-Origin", "*");
  return c.text(`${e && e.message ? e.message : e}`, 500);
});

export default app;
