const EMPTY = { version: 2, totals: {}, records: [], sessions: [], activeSessionId: null, updatedAt: null };
const MAX_RECORDS = 3000;
let operationQueue = Promise.resolve();

function storageGet(defaults) {
  return new Promise((resolve, reject) => chrome.storage.local.get(defaults, (result) => {
    const error = chrome.runtime.lastError;
    error ? reject(new Error(error.message)) : resolve(result);
  }));
}

function storageSet(value) {
  return new Promise((resolve, reject) => chrome.storage.local.set(value, () => {
    const error = chrome.runtime.lastError;
    error ? reject(new Error(error.message)) : resolve();
  }));
}

async function load() {
  const { sourceStats } = await storageGet({ sourceStats: EMPTY });
  const data = sourceStats && typeof sourceStats === "object" ? sourceStats : structuredClone(EMPTY);
  data.totals ||= {};
  data.records ||= [];
  data.sessions ||= [];
  data.activeSessionId ||= null;
  return data;
}

const save = (data) => storageSet({ sourceStats: data });
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const runExclusive = (task) => {
  const result = operationQueue.then(task, task);
  operationQueue = result.catch(() => {});
  return result;
};

function download(text, name, mime) {
  return new Promise((resolve, reject) => chrome.downloads.download({
    url: `data:${mime};charset=utf-8,${encodeURIComponent(text)}`,
    filename: name,
    conflictAction: "overwrite",
    saveAs: false,
  }, (downloadId) => {
    const error = chrome.runtime.lastError;
    error ? reject(new Error(error.message)) : resolve(downloadId);
  }));
}

async function badge(data) {
  const session = data.sessions.find((item) => item.id === data.activeSessionId);
  await chrome.action.setBadgeBackgroundColor({ color: session ? "#16A34A" : "#2563EB" });
  await chrome.action.setBadgeText({ text: session ? String(session.referenceCount || "ON") : "" });
}

function csv(data) {
  const names = { "douyin.com": "抖音", "sohu.com": "搜狐", "volcengine.com": "火山引擎", "100ec.cn": "网经社", "china.com": "中华网", "weixin.qq.com": "微信公众号", "qq.com": "腾讯网", "baidu.com": "百度", "zhihu.com": "知乎", "toutiao.com": "今日头条", "163.com": "网易", "sina.com.cn": "新浪", "thepaper.cn": "澎湃新闻", "ithome.com": "IT之家", "36kr.com": "36氪", "cnblogs.com": "博客园", "csdn.net": "CSDN", "bilibili.com": "哔哩哔哩", "xiaohongshu.com": "小红书", "taogaofen.com": "淘高分" };
  const rows = [["统计会话", "开始时间", "结束时间", "网站名称", "域名", "引用数量"]];
  for (const session of data.sessions) for (const [site, count] of Object.entries(session.counts || {})) rows.push([session.id, session.startedAt, session.endedAt || "统计中", names[site] || "其他网站", site, count]);
  return "\uFEFF" + rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
}

chrome.runtime.onInstalled.addListener(() => load().then(badge).catch(console.error));
chrome.runtime.onStartup.addListener(() => load().then(badge).catch(console.error));

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const execute = async () => {
    if (message.type === "GET_STATS") return { ok: true, data: await load() };
    if (message.type === "START_SESSION") {
      const data = await load();
      const old = data.sessions.find((item) => item.id === data.activeSessionId);
      if (old && !old.endedAt) old.endedAt = new Date().toISOString();
      const session = { id: uid(), tabId: sender.tab?.id, conversationId: message.conversationId, pageTitle: message.pageTitle, pageUrl: message.pageUrl, startedAt: new Date().toISOString(), endedAt: null, counts: {}, referenceCount: 0 };
      data.sessions.push(session);
      data.activeSessionId = session.id;
      data.updatedAt = new Date().toISOString();
      await save(data);
      await badge(data);
      return { ok: true, session };
    }
    if (message.type === "ADD_RECORD") {
      const data = await load();
      const session = data.sessions.find((item) => item.id === data.activeSessionId);
      if (!session || session.endedAt || session.conversationId !== message.record.conversationId || (session.tabId && sender.tab?.id && session.tabId !== sender.tab.id)) return { ok: true, added: false, reason: "not-active" };
      const id = `${session.id}:${message.record.sourceId}`;
      if (data.records.some((record) => record.id === id)) return { ok: true, added: false, reason: "duplicate" };
      data.records.push({ ...message.record, id, sessionId: session.id });
      if (data.records.length > MAX_RECORDS) data.records.splice(0, data.records.length - MAX_RECORDS);
      for (const [site, count] of Object.entries(message.record.counts || {})) {
        data.totals[site] = (data.totals[site] || 0) + count;
        session.counts[site] = (session.counts[site] || 0) + count;
      }
      session.referenceCount += message.record.referenceCount || 0;
      data.updatedAt = new Date().toISOString();
      await save(data);
      await badge(data);
      return { ok: true, added: true };
    }
    if (message.type === "STOP_SESSION") {
      const data = await load();
      const session = data.sessions.find((item) => item.id === data.activeSessionId);
      if (session && !session.endedAt) session.endedAt = new Date().toISOString();
      data.activeSessionId = null;
      data.updatedAt = new Date().toISOString();
      await save(data);
      await badge(data);
      return { ok: true, session, data };
    }
    if (message.type === "EXPORT_JSON") {
      const data = await load();
      await download(JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2), "豆包参考来源统计-doubao-source-stats.json", "application/json");
      return { ok: true };
    }
    if (message.type === "EXPORT_CSV") {
      await download(csv(await load()), "豆包参考来源统计-doubao-source-stats.csv", "text/csv");
      return { ok: true };
    }
    if (message.type === "CLEAR_STATS") {
      const data = structuredClone(EMPTY);
      data.updatedAt = new Date().toISOString();
      await save(data);
      await badge(data);
      return { ok: true, data };
    }
    return { ok: false, error: `Unknown message type: ${message.type}` };
  };
  runExclusive(execute).then(reply).catch((error) => {
    console.error("豆包来源统计：", error);
    reply({ ok: false, error: error?.message || String(error) });
  });
  return true;
});
