"use strict";
// Bridges the page script to the native host (host/readmill-host.js), which owns the
// comment files on disk. When the host can't be reached, changes are applied to a
// local cache and queued in chrome.storage until it can.

const HOST = "com.readmill.host";

// ---------- urls ----------
const TRACKING = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref_src|igshid)$/;
function normalizeUrl(href) {
  try {
    const u = new URL(href);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return href;
  }
}

// ---------- native host ----------
class Unreachable extends Error {}

function native(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(HOST, msg, (res) => {
      const err = chrome.runtime.lastError;
      if (err || !res) return reject(new Unreachable(err?.message || "no response from host"));
      if (res.error) return reject(new Error(res.error));
      resolve(res);
    });
  });
}

// ---------- storage ----------
const local = chrome.storage.local;
const cacheKey = (url) => `cache:${url}`;
async function getCache(url) {
  return (await local.get(cacheKey(url)))[cacheKey(url)] || { comments: [] };
}
async function setIndexCount(url, n) {
  const { idx = {} } = await local.get("idx");
  if (n) idx[url] = n;
  else delete idx[url];
  await local.set({ idx });
}

// Everything that touches the queue/cache runs one at a time.
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn, fn));

async function flush() {
  const { queue = [] } = await local.get("queue");
  while (queue.length) {
    try {
      await native(queue[0]);
    } catch (e) {
      if (e instanceof Unreachable) break;
      console.warn("Readmill: host rejected queued change, dropping it", queue[0], e);
    }
    queue.shift();
    await local.set({ queue });
  }
  return queue.length;
}

function applyLocally(cache, op) {
  const list = cache.comments;
  if (op.op === "add" && !list.some((c) => c.id === op.comment.id)) list.push(op.comment);
  if (op.op === "delete") cache.comments = list.filter((c) => c.id !== op.id);
  if (op.op === "update") {
    const c = list.find((c) => c.id === op.id);
    if (c) Object.assign(c, { text: op.text, edited: op.edited });
  }
  if (op.title) cache.title = op.title;
  return cache;
}

async function list(url) {
  const pending = await flush();
  try {
    const res = await native({ op: "list", url });
    await local.set({ [cacheKey(url)]: { title: res.title, comments: res.comments } });
    await setIndexCount(url, res.comments.length);
    return { comments: res.comments, offline: pending > 0 };
  } catch (e) {
    if (!(e instanceof Unreachable)) throw e;
    return { comments: (await getCache(url)).comments, offline: true, reason: e.message };
  }
}

async function mutate(op) {
  const cache = applyLocally(await getCache(op.url), op);
  await local.set({ [cacheKey(op.url)]: cache });
  await setIndexCount(op.url, cache.comments.length);
  const { queue = [] } = await local.get("queue");
  queue.push(op);
  await local.set({ queue });
  const pending = await flush();
  return { comments: cache.comments, offline: pending > 0 };
}

// Tell every tab showing this page (including the one that made the change).
async function broadcast(url, payload) {
  for (const tab of await chrome.tabs.query({})) {
    if (tab.url && normalizeUrl(tab.url) === url) {
      chrome.tabs.sendMessage(tab.id, { type: "comments", ...payload }).catch(() => {});
      setBadge(tab.id, payload.comments.length);
    }
  }
}

function setBadge(tabId, n) {
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#c38d9e" }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" }).catch(() => {});
}

// ---------- messages from the page script ----------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab?.id;
  const url = msg.href && normalizeUrl(msg.href);
  const run = async () => {
    switch (msg.type) {
      case "list": {
        const res = await list(url);
        if (tabId) setBadge(tabId, res.comments.length);
        return res;
      }
      case "add":
      case "delete":
      case "update": {
        const { type, href, ...rest } = msg;
        const res = await mutate({ op: type, url, ...rest });
        broadcast(url, res);
        return res;
      }
      case "deactivated":
        if (tabId) chrome.action.setBadgeText({ tabId, text: "" });
        return {};
    }
  };
  serial(run).then(reply, (e) => reply({ error: String(e.message || e) }));
  return true;
});

// ---------- activation ----------
async function inject(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

async function send(tabId, type) {
  try {
    await chrome.tabs.sendMessage(tabId, { type });
    return true;
  } catch {
    return false; // no page script yet
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (await send(tab.id, "toggle")) return;
  try {
    await inject(tab.id); // starts active
  } catch (e) {
    console.warn("Readmill can't run on this page:", e.message);
    chrome.action.setBadgeText({ tabId: tab.id, text: "✕" });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: "" }), 1500);
  }
});

// Pages you've commented on before switch Readmill on by themselves.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!(info.status === "complete" || info.url) || !tab.url?.startsWith("http")) return;
  const { idx = {} } = await local.get("idx");
  if (!idx[normalizeUrl(tab.url)]) return;
  if (await send(tabId, "activate")) return;
  if (info.status === "complete") inject(tabId).catch(() => {});
});

// Rebuild the list of commented pages from disk (picks up files added or edited by hand).
async function refreshIndex() {
  await serial(async () => {
    await flush();
    try {
      const { pages } = await native({ op: "pages" });
      const { queue = [] } = await local.get("queue");
      const idx = Object.fromEntries(pages.filter((p) => p.count).map((p) => [p.url, p.count]));
      for (const op of queue) if (op.op === "add") idx[op.url] ||= 1;
      await local.set({ idx });
    } catch (e) {
      if (!(e instanceof Unreachable)) console.warn("Readmill:", e);
    }
  });
}
chrome.runtime.onStartup.addListener(refreshIndex);
chrome.runtime.onInstalled.addListener(refreshIndex);
