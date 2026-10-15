let scanning = false;
let root = null;
const processedSourceIds = new Set();
let scanFeedback = { phase: "idle", text: "等待扫描", current: 0, total: 0 };

const SITE_NAMES = { "douyin.com": "抖音", "sohu.com": "搜狐", "volcengine.com": "火山引擎", "100ec.cn": "网经社", "china.com": "中华网", "weixin.qq.com": "微信公众号", "qq.com": "腾讯网", "baidu.com": "百度", "zhihu.com": "知乎", "toutiao.com": "今日头条", "163.com": "网易", "sina.com.cn": "新浪", "thepaper.cn": "澎湃新闻", "ithome.com": "IT之家", "36kr.com": "36氪", "cnblogs.com": "博客园", "csdn.net": "CSDN", "bilibili.com": "哔哩哔哩", "xiaohongshu.com": "小红书", "taogaofen.com": "淘高分" };
const siteLabel = (site) => SITE_NAMES[site] ? `${SITE_NAMES[site]} · ${site}` : site;

function handleContextError(error) {
  if (/Extension context invalidated/i.test(String(error?.message || error))) {
    scanning = false;
    root?.host?.remove();
    return;
  }
  console.error("豆包来源统计：", error);
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "扩展后台没有响应");
  return response;
}

function setScanFeedback(phase, text, current = 0, total = 0) {
  scanFeedback = { phase, text, current, total };
  if (!root) return;
  const status = root.querySelector(".status");
  const button = root.querySelector(".scan");
  if (status) {
    status.textContent = `${phase === "error" ? "●" : phase === "done" ? "✓" : "●"} ${text}`;
    status.className = `status ${scanning ? "on" : phase}`;
  }
  if (button) {
    button.disabled = scanning;
    button.textContent = scanning ? text : "重新扫描";
  }
}

function site(href) {
  try {
    const hostname = new URL(href).hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
    if (!hostname || hostname === "doubao.com" || hostname.endsWith(".doubao.com")) return null;
    if (hostname === "iesdouyin.com") return "douyin.com";
    if (hostname === "mp.weixin.qq.com") return "weixin.qq.com";
    const parts = hostname.split(".");
    const tail = parts.slice(-2).join(".");
    return new Set(["com.cn", "net.cn", "org.cn", "gov.cn", "co.uk", "com.hk", "com.tw"]).has(tail) && parts.length >= 3 ? parts.slice(-3).join(".") : tail;
  } catch {
    return null;
  }
}

function hash(value) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

const conversationId = () => location.pathname.match(/\/chat\/([^/?]+)/)?.[1] || `${location.pathname}${location.search}`;

function expandReferenceSections() {
  const elements = document.querySelectorAll("div");
  for (const element of elements) {
    const parent = element.parentElement;
    if (element.children.length !== 0 || !/参考\s*\d+\s*篇资料/.test((element.textContent || "").trim()) || !parent?.classList.contains("cursor-pointer")) continue;
    const transform = parent.lastElementChild?.style?.transform || "";
    if (!transform || transform === "none" || transform.includes("rotate(0")) parent.click();
  }
}

function groups() {
  const links = [...document.querySelectorAll("a[href]")].filter((link) => site(link.href) && /^\s*\d+[.、]\s*/.test((link.innerText || "").trim()));
  const output = [];
  let current = [];
  let next = 1;
  for (const link of links) {
    const number = Number((link.innerText || "").trim().match(/^(\d+)/)?.[1]);
    if (number === 1) {
      if (current.length) output.push(current);
      current = [link];
      next = 2;
    } else if (current.length && number === next) {
      current.push(link);
      next++;
    } else if (current.length) {
      output.push(current);
      current = [];
    }
  }
  if (current.length) output.push(current);
  return output;
}

async function performScan() {
  setScanFeedback("expanding", "正在展开参考资料…");
  expandReferenceSections();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const referenceGroups = groups();
  let referenceCount = 0;
  for (let index = 0; index < referenceGroups.length; index++) {
    const group = referenceGroups[index];
    setScanFeedback("counting", `正在统计 ${index + 1}/${referenceGroups.length} 组…`, index + 1, referenceGroups.length);
    const urls = group.map((link) => link.href);
    const sourceId = hash(`${conversationId()}|${urls.join("|")}`);
    if (processedSourceIds.has(sourceId)) continue;
    const items = group.map((link) => ({ title: (link.innerText || "").trim().replace(/^\d+[.、]\s*/, "").slice(0, 180), url: link.href, site: site(link.href) }));
    const counts = {};
    for (const url of urls) {
      const key = site(url);
      if (key) counts[key] = (counts[key] || 0) + 1;
    }
    const result = await send({ type: "ADD_RECORD", record: { sourceId, conversationId: conversationId(), pageTitle: document.title, pageUrl: location.href, referenceCount: urls.length, counts, urls, items, capturedAt: new Date().toISOString() } });
    if (result.added || result.reason === "duplicate") processedSourceIds.add(sourceId);
    if (result.added) referenceCount += urls.length;
  }
  return { groupCount: referenceGroups.length, referenceCount };
}

async function scanOnce() {
  if (scanning) return;
  scanning = true;
  let sessionStarted = false;
  let result = { groupCount: 0, referenceCount: 0 };
  try {
    setScanFeedback("clearing", "正在清空旧统计…");
    await send({ type: "CLEAR_STATS" });
    processedSourceIds.clear();
    setScanFeedback("starting", "正在准备扫描…");
    await send({ type: "START_SESSION", conversationId: conversationId(), pageTitle: document.title, pageUrl: location.href });
    sessionStarted = true;
    await render();
    result = await performScan();
    setScanFeedback("saving", "正在保存结果…");
  } catch (error) {
    setScanFeedback("error", `扫描失败：${error?.message || error}`);
    throw error;
  } finally {
    if (sessionStarted) {
      try { await send({ type: "STOP_SESSION" }); } catch (error) { handleContextError(error); }
    }
    scanning = false;
    await render();
  }
  const message = result.referenceCount ? `扫描完成：${result.referenceCount} 条参考资料` : "扫描完成：未找到参考资料";
  setScanFeedback("done", message, result.groupCount, result.groupCount);
  return result;
}

function escapeHtml(value) {
  const element = document.createElement("div");
  element.textContent = value ?? "";
  return element.innerHTML;
}

async function render() {
  if (!root) return;
  const { data } = await send({ type: "GET_STATS" });
  const sessions = data.sessions || [];
  const active = sessions.find((session) => session.id === data.activeSessionId);
  const last = active || sessions.at(-1);
  const records = last ? data.records.filter((record) => record.sessionId === last.id) : [];
  const rows = Object.entries(last?.counts || {}).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((sum, [, count]) => sum + count, 0);
  const busy = scanning || (Boolean(active) && active.conversationId === conversationId());
  const status = root.querySelector(".status");
  status.textContent = `${scanFeedback.phase === "done" ? "✓" : "●"} ${scanFeedback.text}`;
  status.className = `status ${busy ? "on" : scanFeedback.phase}`;
  root.querySelector(".nums").innerHTML = `<b>${total}<small>参考资料</small></b><b>${rows.length}<small>来源网站</small></b><b>${records.length}<small>回答</small></b>`;
  root.querySelector(".list").innerHTML = rows.length ? rows.slice(0, 8).map(([name, count]) => `<div title="${escapeHtml(name)}"><span>${escapeHtml(siteLabel(name))}</span><strong>${count}</strong></div>`).join("") : "<p>点击“开始统计”后等待回答完成</p>";
  root.querySelector(".scan").disabled = busy;
  root.querySelector(".scan").textContent = busy ? scanFeedback.text : (scanFeedback.phase === "idle" ? "扫描" : "重新扫描");
}

function mount() {
  if (document.getElementById("doubao-source-counter-panel")) return;
  const host = document.createElement("div");
  host.id = "doubao-source-counter-panel";
  host.style.cssText = "position:fixed;right:18px;top:90px;z-index:2147483647";
  document.documentElement.appendChild(host);
  root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>*{box-sizing:border-box}.box{width:288px;font-family:system-ui,'Microsoft YaHei';background:#f7f9fc;color:#253047;border:1px solid #dce3ef;border-radius:14px;box-shadow:0 12px 38px #14213d2c;overflow:hidden}.head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:linear-gradient(135deg,#1d4ed8,#4f46e5);color:#fff}.head strong{font-size:14px}.fold{border:0;background:#ffffff24;color:#fff;border-radius:6px;width:26px;height:25px;cursor:pointer}.body{padding:12px}.status{font-size:12px;color:#7b8496}.status.on{color:#16a34a}.nums{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:10px 0}.nums b{background:#fff;border:1px solid #e5eaf2;border-radius:9px;text-align:center;padding:8px 3px;font-size:19px;color:#1d4ed8}.nums small{display:block;font-size:10px;font-weight:400;color:#7b8496;margin-top:3px}.list{background:#fff;border:1px solid #e5eaf2;border-radius:9px;padding:4px 9px;max-height:190px;overflow:auto}.list div{display:flex;justify-content:space-between;gap:8px;padding:7px 2px;border-bottom:1px solid #eef1f6;font-size:12px}.list div:last-child{border:0}.list span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.list p{text-align:center;color:#8a94a6;font-size:11px}.actions{margin-top:10px}.actions button{width:100%;border:1px solid #2563eb;background:#2563eb;color:#fff;border-radius:8px;padding:9px;cursor:pointer}.actions button:disabled{opacity:.4;cursor:not-allowed}.collapsed .body{display:none}.collapsed{width:190px}</style><div class="box"><div class="head"><strong>参考来源统计</strong><button class="fold">−</button></div><div class="body"><div class="status">● 等待扫描</div><div class="nums"></div><div class="list"></div><div class="actions"><button class="scan">扫描</button></div></div></div>`;
  root.querySelector(".scan").onclick = () => scanOnce().catch(handleContextError);
  root.querySelector(".fold").onclick = () => {
    const box = root.querySelector(".box");
    const collapsed = box.classList.toggle("collapsed");
    root.querySelector(".fold").textContent = collapsed ? "+" : "−";
  };
  render().catch(handleContextError);
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.type === "SCAN_ONCE") {
    scanOnce().then((result) => reply({ ok: true, result })).catch((error) => reply({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "GET_SCAN_STATUS") {
    reply({ ok: true, scanning, ...scanFeedback });
    return true;
  }
});

mount();
