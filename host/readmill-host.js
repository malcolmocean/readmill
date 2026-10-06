#!/usr/bin/env node
// Readmill native messaging host. Chrome starts this on demand, sends one
// length-prefixed JSON message on stdin, and reads one reply from stdout.
//
// Comments live in READMILL_DIR (default ~/notes/web-comments), one page per pair of files:
//   <site>/<page-slug>.json   the source of truth (safe to edit by hand)
//   <site>/<page-slug>.md     a readable copy, rewritten on every change
// No dependencies.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const DIR = path.resolve((process.env.READMILL_DIR || "~/notes/web-comments").replace(/^~(?=$|\/)/, os.homedir()));

// ---------- native messaging framing ----------
function readMessage() {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    process.stdin.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      try { resolve(JSON.parse(buf.subarray(4, 4 + len).toString("utf8"))); } catch (e) { reject(e); }
    });
    process.stdin.on("end", () => reject(new Error("stdin closed before a full message arrived")));
  });
}

function writeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

// ---------- files ----------
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 8);

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
}

// Site folder + readable slug; a hash is added only if two urls would share a name.
function candidates(url) {
  const u = new URL(url);
  const site = slugify(u.hostname.replace(/^www\./, "")) || "local";
  const base = slugify(decodeURIComponent(u.pathname + u.search)) || "index";
  return [path.join(DIR, site, base), path.join(DIR, site, `${base}--${hash(url)}`)];
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`${file} is unreadable (${e.message}); fix it by hand`);
  }
}

// -> { file (without extension), page }
function locate(url) {
  const [plain, hashed] = candidates(url);
  const a = readJson(plain + ".json");
  if (!a || a.url === url) return { file: plain, page: a };
  return { file: hashed, page: readJson(hashed + ".json") };
}

function save(file, page) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!page.comments.length) {
    for (const ext of [".json", ".md"]) fs.rmSync(file + ext, { force: true });
    return;
  }
  const tmp = `${file}.json.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(page, null, 2) + "\n");
  fs.renameSync(tmp, file + ".json");
  fs.writeFileSync(file + ".md", toMarkdown(page));
}

function toMarkdown(page) {
  const sorted = [...page.comments].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.created.localeCompare(b.created));
  let out = `# ${page.title || page.url}\n\n<${page.url}>\n\n`;
  for (const c of sorted) {
    const quote = c.quote.replace(/\s*\n\s*/g, " ");
    out += `> ${quote}\n\n${c.text}\n\n<sub>${c.created}${c.edited ? ` · edited ${c.edited}` : ""}</sub>\n\n---\n\n`;
  }
  return out;
}

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".json")) yield p;
  }
}

// ---------- operations ----------
function handle(msg) {
  switch (msg.op) {
    case "ping":
      return { ok: true, dir: DIR };
    case "pages": {
      const pages = [];
      for (const f of walk(DIR)) {
        try {
          const p = JSON.parse(fs.readFileSync(f, "utf8"));
          if (p.url) pages.push({ url: p.url, title: p.title, count: (p.comments || []).length });
        } catch {} // skip broken files here; listing that page will report it
      }
      return { pages };
    }
    case "list": {
      const { page } = locate(msg.url);
      return { title: page?.title, comments: page?.comments || [] };
    }
    case "add": {
      const { file, page } = locate(msg.url);
      const p = page || { url: msg.url, title: msg.title || "", comments: [] };
      if (msg.title) p.title = msg.title;
      const c = msg.comment;
      if (!c?.id || !String(c.text || "").trim()) throw new Error("comment needs id and text");
      if (!p.comments.some((x) => x.id === c.id)) p.comments.push(c);
      save(file, p);
      return { ok: true };
    }
    case "update": {
      const { file, page } = locate(msg.url);
      const c = page?.comments.find((x) => x.id === msg.id);
      if (!c) return { ok: true, missing: true };
      c.text = String(msg.text || "").trim();
      c.edited = msg.edited || new Date().toISOString();
      save(file, page);
      return { ok: true };
    }
    case "delete": {
      const { file, page } = locate(msg.url);
      if (!page) return { ok: true };
      page.comments = page.comments.filter((x) => x.id !== msg.id);
      save(file, page);
      return { ok: true };
    }
    default:
      throw new Error(`unknown op ${msg.op}`);
  }
}

// Command-line use, for checking things without Chrome: readmill-host.js pages|list <url>
// (Chrome itself passes the calling extension's origin as the first argument.)
const arg = process.argv[2];
if (arg && !arg.startsWith("chrome-extension://")) {
  const [op, url] = process.argv.slice(2);
  console.log(JSON.stringify(handle({ op, url }), null, 2));
} else {
  readMessage()
    .then((msg) => {
      try { writeMessage(handle(msg)); } catch (e) { writeMessage({ error: String(e.message || e) }); }
    })
    .catch((e) => writeMessage({ error: String(e.message || e) }))
    .finally(() => process.stdout.end(() => process.exit(0)));
}
