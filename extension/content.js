"use strict";
// Readmill page script: splits the page's main text into sentences, lets you step through
// them with Tab / Shift-Tab and comment with Enter, and shows comments in the right margin.
// It never edits the page's DOM: sentences are Ranges painted with CSS.highlights, and all
// of Readmill's own UI lives in one shadow root.
(() => {
  // A copy from before the extension was reloaded can't talk to it any more: replace it.
  if (window.__readmill?.alive()) return;
  window.__readmill?.off();
  window.__readmill = { alive: () => !!chrome.runtime?.id, off: () => deactivate() };

  const POS_KEY = "pos:";
  const DRAFT_KEY = "draft:";
  const CARD_W = 280;
  const GAP = 8;

  let active = false;
  let sentences = []; // { range, text, block }
  let byText = new Map(); // normalized text -> [sentence index]
  let byNode = new Map(); // text node -> [sentence index]
  let current = -1;
  let comments = [];
  let placed = new Map(); // sentence index -> [comment]
  let orphans = [];
  let offline = false;
  let editor = null; // { idx, key, el, textarea, save, cancel, existing, deleteButtons, top }
  let enterGuardUntil = 0;
  let userScrolledAt = 0; // last time the reader scrolled by hand
  let lastFocusAt = 0;
  let lastUrl = pageUrl();
  let lastSignature = 0;

  function pageUrl() {
    return location.href.split("#")[0];
  }
  const norm = (s) => s.replace(/\s+/g, " ").trim();

  // ---------- storage (never let it break the page) ----------
  const store = {
    async get(k) { try { return (await chrome.storage.local.get(k))[k]; } catch { return undefined; } },
    set(k, v) { try { chrome.storage.local.set({ [k]: v }); } catch {} },
    del(k) { try { chrome.storage.local.remove(k); } catch {} },
  };

  async function bg(msg) {
    const res = await chrome.runtime.sendMessage({ href: pageUrl(), ...msg });
    if (!res) throw new Error("no answer from Readmill (try reloading the page)");
    if (res.error) throw new Error(res.error);
    return res;
  }

  // ---------- finding sentences ----------
  const EXCLUDE = [
    "nav", "aside", "footer", "form", "menu", "dialog", "button", "select", "textarea", "input",
    "script", "style", "noscript", "template", "svg", "math", "iframe", "code", "[hidden]",
    "[aria-hidden=true]", "[contenteditable]:not([contenteditable=false])",
    "[role=navigation]", "[role=complementary]", "[role=contentinfo]", "[role=banner]",
    "[role=menu]", "[role=dialog]", "[role=toolbar]", "[role=button]",
  ].join(",");

  function pickRoot() {
    const big = (sel) => [...document.querySelectorAll(sel)].filter((el) => el.innerText.trim().length > 400);
    const articles = big("article");
    if (articles.length === 1) return articles[0];
    const mains = big("main, [role=main]");
    if (mains.length) return mains[0];
    return document.body;
  }

  function scan() {
    const root = pickRoot();
    const skip = new WeakMap();
    const block = new WeakMap();
    const isSkipped = (el) => {
      let v = skip.get(el);
      if (v === undefined) {
        v = !!el.closest(EXCLUDE) || !el.checkVisibility({ visibilityProperty: true });
        skip.set(el, v);
      }
      return v;
    };
    const isBlock = (el) => {
      let v = block.get(el);
      if (v === undefined) {
        v = !/^(inline|contents|ruby)/.test(getComputedStyle(el).display);
        block.set(el, v);
      }
      return v;
    };
    const blockFor = (node) => {
      let el = node.parentElement;
      while (el && el !== root && !isBlock(el)) el = el.parentElement;
      return el || root;
    };

    // Group the visible text nodes by the block element that lays them out.
    // A <br> also ends a group (some sites build paragraphs out of <br><br>).
    const groups = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => {
        if (n.nodeType === Node.TEXT_NODE) return n.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        if (n.tagName === "BR") return NodeFilter.FILTER_ACCEPT;
        return isSkipped(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      },
    });
    let lineBreak = false;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType !== Node.TEXT_NODE) { lineBreak = true; continue; }
      const b = blockFor(n);
      const g = groups[groups.length - 1];
      if (g && g.block === b && !lineBreak) g.nodes.push(n);
      else groups.push({ block: b, nodes: [n] });
      lineBreak = false;
    }

    const segmenter = new Intl.Segmenter(document.documentElement.lang || undefined, { granularity: "sentence" });
    sentences = [];
    byText = new Map();
    byNode = new Map();
    for (const g of groups) {
      // stray link lists (menus, tag clouds) that slipped past the filters
      if (g.nodes.every((n) => n.parentElement.closest("a")) && g.nodes.reduce((s, n) => s + n.data.length, 0) < 80) continue;
      let full = "";
      // source line wraps are just spaces on screen, but the segmenter would break sentences at them
      const starts = g.nodes.map((n) => { const s = full.length; full += n.data.replace(/[\n\r\t\f]/g, " "); return s; });
      const locate = (off, isEnd) => {
        for (let i = 0; i < g.nodes.length; i++) {
          const end = starts[i] + g.nodes[i].data.length;
          if (isEnd ? off <= end : off < end) return [g.nodes[i], off - starts[i], i];
        }
        const last = g.nodes.length - 1;
        return [g.nodes[last], g.nodes[last].data.length, last];
      };
      for (const seg of segmenter.segment(full)) {
        const raw = seg.segment;
        const body = raw.trim();
        if (!/[\p{L}\p{N}]/u.test(body)) continue;
        const s = seg.index + (raw.length - raw.trimStart().length);
        const [sn, so, si] = locate(s, false);
        const [en, eo, ei] = locate(s + body.length, true);
        const range = document.createRange();
        range.setStart(sn, so);
        range.setEnd(en, eo);
        const idx = sentences.length;
        const text = norm(body);
        sentences.push({ range, text, block: g.block });
        if (!byText.has(text)) byText.set(text, []);
        byText.get(text).push(idx);
        for (let i = si; i <= ei; i++) {
          if (!byNode.has(g.nodes[i])) byNode.set(g.nodes[i], []);
          byNode.get(g.nodes[i]).push(idx);
        }
      }
    }
    lastSignature = document.body.textContent.length;
  }

  // ---------- placing comments on sentences ----------
  const prefixOf = (i) => (i > 0 ? sentences[i - 1].text.slice(-40) : "");
  const suffixOf = (i) => (i < sentences.length - 1 ? sentences[i + 1].text.slice(0, 40) : "");

  function findSentence(c) {
    const q = norm(c.quote);
    let cands = byText.get(q) || [];
    if (!cands.length && q.length >= 15) {
      // the page changed a little: accept a sentence that contains the quote or is contained by it
      cands = sentences.map((s, i) => i).filter((i) => {
        const t = sentences[i].text;
        return t.length >= 15 && (t.includes(q) || q.includes(t));
      });
    }
    if (cands.length <= 1) return cands.length ? cands[0] : -1;
    const score = (i) => (prefixOf(i) === c.prefix ? 2 : 0) + (suffixOf(i) === c.suffix ? 2 : 0) - Math.abs(i - (c.order ?? i)) / 1e6;
    return cands.reduce((best, i) => (score(i) > score(best) ? i : best));
  }

  function place() {
    placed = new Map();
    orphans = [];
    for (const c of comments) {
      const i = findSentence(c);
      if (i === -1) { orphans.push(c); continue; }
      if (!placed.has(i)) placed.set(i, []);
      placed.get(i).push(c);
    }
  }

  // ---------- UI shell ----------
  const host = document.createElement("readmill-layer");
  host.id = "readmill-host";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${UI_CSS()}</style>
    <div class="root">
      <div class="layer"></div>
      <div class="orphans" hidden></div>
      <div class="pill">
        <span class="name">Readmill</span>
        <span class="count"></span>
        <button class="orphan-btn" hidden></button>
        <span class="msg"></span>
        <button class="close" title="Turn Readmill off on this page (Alt+Shift+R)">✕</button>
      </div>
    </div>`;
  const ui = shadow.querySelector(".root");
  const layer = shadow.querySelector(".layer");
  const pill = shadow.querySelector(".pill");
  const countEl = shadow.querySelector(".count");
  const msgEl = shadow.querySelector(".msg");
  const orphanBtn = shadow.querySelector(".orphan-btn");
  const orphanPanel = shadow.querySelector(".orphans");
  shadow.querySelector(".close").addEventListener("click", () => deactivate());
  orphanBtn.addEventListener("click", () => { orphanPanel.hidden = !orphanPanel.hidden; });

  const isLightPage = () => {
    for (const el of [document.body, document.documentElement]) {
      const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
      if (m && (m[3] === undefined || +m[3] > 0.5)) return 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2] > 140;
    }
    return true;
  };

  let msgTimer;
  function flash(msg, isErr = false) {
    msgEl.textContent = msg;
    pill.classList.toggle("err", isErr);
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { msgEl.textContent = ""; pill.classList.remove("err"); }, isErr ? 6000 : 1400);
  }

  // ---------- highlights ----------
  const HL = { commented: 0, linked: 1, current: 2, editing: 3 };
  function highlight(name, ranges) {
    const h = new Highlight(...ranges);
    h.priority = HL[name];
    CSS.highlights.set(`readmill-${name}`, h);
  }
  function clearHighlights() {
    for (const name of Object.keys(HL)) CSS.highlights.delete(`readmill-${name}`);
  }

  // ---------- comments display ----------
  function renderComments() {
    layer.querySelectorAll(":scope > .cmt, :scope > .badge").forEach((n) => n.remove());
    highlight("commented", [...placed.keys()].map((i) => sentences[i].range));
    for (const [i, list] of placed) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.dataset.sid = i;
      badge.textContent = list.length;
      badge.addEventListener("click", () => { focusSentence(i, { scroll: false }); openEditor(i); });
      layer.append(badge);
      for (const c of list) layer.append(commentCard(c, i));
    }
    if (editor) hideEditedCards();

    const n = comments.length;
    countEl.textContent = n ? `· ${n} comment${n === 1 ? "" : "s"}` : "";
    pill.classList.toggle("offline", offline);
    if (offline) countEl.textContent += n ? " · not saved to disk yet" : " · storage host not connected";
    countEl.title = offline ? "Comments are kept in the browser until the native host answers (see install.sh)" : "Saved to disk";
    orphanBtn.hidden = !orphans.length;
    orphanBtn.textContent = `${orphans.length} unplaced`;
    orphanBtn.title = "Comments whose sentence can't be found on the page any more";
    renderOrphans();
    layout();
  }

  function commentCard(c, i) {
    const card = document.createElement("div");
    card.className = "cmt";
    card.dataset.sid = i;
    card.textContent = c.text;
    card.addEventListener("click", () => { focusSentence(i, { scroll: false }); openEditor(i); });
    // hovering a margin note lights up its sentence
    card.addEventListener("mouseenter", () => highlight("linked", [sentences[i].range]));
    card.addEventListener("mouseleave", () => CSS.highlights.delete("readmill-linked"));
    return card;
  }

  function renderOrphans() {
    orphanPanel.replaceChildren();
    if (!orphans.length) { orphanPanel.hidden = true; return; }
    const head = document.createElement("div");
    head.className = "head";
    head.textContent = "Can't find these sentences on the page any more:";
    orphanPanel.append(head);
    for (const c of orphans) {
      const card = document.createElement("div");
      card.className = "cmt";
      const q = document.createElement("span");
      q.className = "q";
      q.textContent = c.quote;
      const t = document.createElement("span");
      t.textContent = c.text;
      card.append(q, t, deleteButton(c));
      orphanPanel.append(card);
    }
  }

  // Where the text column ends, so the margin sits just right of it.
  function columnLeft(ox) {
    const rights = [];
    const step = Math.max(1, Math.floor(sentences.length / 150));
    for (let i = 0; i < sentences.length; i += step) {
      const r = sentences[i].block.getBoundingClientRect();
      if (r.width > 200) rights.push(r.right);
    }
    rights.sort((a, b) => a - b);
    const right = rights.length ? rights[Math.floor(rights.length * 0.8)] : innerWidth * 0.66;
    return Math.max(8, Math.min(right + 32, document.documentElement.clientWidth - CARD_W - 36)) - ox;
  }

  // Align each margin item with its sentence, pushing items apart so none overlap.
  // The open editor is the anchor; notes before/after it move up/down to make room.
  function layout() {
    if (!active) return;
    const o = host.getBoundingClientRect();
    const left = columnLeft(o.left);
    for (const b of layer.querySelectorAll(".badge")) {
      const rects = sentences[+b.dataset.sid]?.range.getClientRects();
      const r = rects?.[rects.length - 1];
      b.hidden = !r;
      if (r) { b.style.left = `${r.right - o.left + 3}px`; b.style.top = `${r.top - o.top + (r.height - 16) / 2}px`; }
    }
    const items = [...layer.querySelectorAll(":scope > .cmt:not([hidden]), :scope > .editor")].map((n) => {
      const isEditor = n.classList.contains("editor");
      const idx = isEditor ? editor.idx : +n.dataset.sid;
      const r = idx >= 0 ? sentences[idx].range.getBoundingClientRect() : null;
      const want = r && r.height ? r.top - o.top - 6 : isEditor ? editor.top ?? 0 : -1e6;
      return { n, idx, isEditor, h: n.offsetHeight, want };
    }).sort((x, y) => x.want - y.want || x.isEditor - y.isEditor);
    const a = items.findIndex((it) => it.isEditor);
    if (a === -1) {
      let bottom = -Infinity;
      for (const it of items) { it.top = Math.max(it.want, bottom + GAP); bottom = it.top + it.h; }
    } else {
      items[a].top = items[a].want;
      let bottom = items[a].top + items[a].h;
      for (let i = a + 1; i < items.length; i++) { items[i].top = Math.max(items[i].want, bottom + GAP); bottom = items[i].top + items[i].h; }
      let top = items[a].top;
      for (let i = a - 1; i >= 0; i--) { items[i].top = Math.min(items[i].want, top - GAP - items[i].h); top = items[i].top; }
    }
    for (const it of items) {
      it.n.style.top = `${Math.round(it.top)}px`;
      it.n.style.left = `${Math.round(left)}px`;
      if (it.isEditor) editor.top = it.top;
    }
  }

  let layoutQueued = false;
  function queueLayout() {
    if (layoutQueued || !active) return;
    layoutQueued = true;
    requestAnimationFrame(() => { layoutQueued = false; layout(); });
  }

  // ---------- focus & navigation ----------
  function scrollerFor(el) {
    for (let p = el; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight + 4) return p;
    }
    return null;
  }

  function scrollToSentence(i, mode) {
    const s = sentences[i];
    const r = s.range.getBoundingClientRect();
    if (!r.height) return;
    const box = scrollerFor(s.block);
    const vt = box ? box.getBoundingClientRect().top : 0;
    const vh = box ? box.clientHeight : innerHeight;
    const top = r.top - vt;
    let delta;
    if (mode === "top") delta = top - vh * 0.15;
    // keep the focused sentence in a comfortable reading band
    else if (top < vh * 0.18 || top + r.height > vh * 0.72) delta = top - (r.height > vh * 0.45 ? vh * 0.08 : vh * 0.35);
    else return;
    const behavior = mode === "instant" || Math.abs(top) > vh * 2 || mode === "top" ? "instant" : "smooth";
    (box || window).scrollBy({ top: delta, behavior });
  }

  function inView(i) {
    const r = sentences[i]?.range.getBoundingClientRect();
    return r && r.height && r.bottom > 0 && r.top < innerHeight;
  }

  function focusSentence(i, { scroll = "smooth", blur = false } = {}) {
    if (!sentences[i]) return;
    current = i;
    lastFocusAt = performance.now();
    // so Enter means "comment", not "follow the link you clicked earlier"
    const ae = document.activeElement;
    if (blur && ae && ae !== document.body && ae !== host && !isEditable(ae)) ae.blur();
    highlight("current", [sentences[i].range]);
    if (scroll) scrollToSentence(i, scroll);
    store.set(POS_KEY + pageUrl(), sentences[i].text);
  }

  function firstVisibleSentence() {
    // binary search over reading order for the first sentence whose bottom is on screen
    let lo = 0, hi = sentences.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = sentences[mid].range.getBoundingClientRect();
      if (r.bottom < innerHeight * 0.1) lo = mid + 1;
      else { ans = mid; hi = mid - 1; }
    }
    return ans;
  }

  function move(delta) {
    if (!sentences.length) return;
    // Continue from the focused sentence unless the reader has scrolled away from it by hand.
    const scrolledAway = current >= 0 && userScrolledAt > lastFocusAt && !inView(current);
    let i = current >= 0 && !scrolledAway ? current + delta : firstVisibleSentence();
    i = Math.max(0, Math.min(sentences.length - 1, i));
    focusSentence(i, { blur: true });
  }

  // ---------- editor ----------
  function hideEditedCards() {
    // notes for the sentence being edited are shown inside the editor instead
    layer.querySelectorAll(":scope > .cmt").forEach((n) => { n.hidden = editor && +n.dataset.sid === editor.idx; });
  }

  async function openEditor(i) {
    if (editor) closeEditor({ refocus: false });
    const s = sentences[i];
    const el = document.createElement("div");
    el.className = "editor";

    const existing = document.createElement("div");
    existing.className = "existing";

    const textarea = document.createElement("textarea");
    textarea.placeholder = "Your comment…";
    const draftKey = DRAFT_KEY + pageUrl() + "|" + s.text.slice(0, 300);
    textarea.addEventListener("input", () => {
      if (textarea.value) store.set(draftKey, textarea.value);
      else store.del(draftKey);
    });

    const save = document.createElement("button");
    save.className = "save";
    save.textContent = "Save";
    save.addEventListener("click", () => submit());

    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => closeEditor());

    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "Tab → Save, Enter · Esc";

    const row = document.createElement("div");
    row.className = "row";
    row.append(save, cancel, hint);
    el.append(existing, textarea, row);

    editor = { idx: i, key: s.text, draftKey, el, textarea, save, cancel, existing, deleteButtons: [] };
    highlight("editing", [s.range]);
    fillExisting();
    hideEditedCards();
    layer.append(el);
    new ResizeObserver(queueLayout).observe(el);
    layout();
    textarea.focus({ preventScroll: true });
    const r = el.getBoundingClientRect();
    if (r.bottom > innerHeight - 20) window.scrollBy({ top: r.bottom - innerHeight + 40, behavior: "smooth" });

    const draft = await store.get(draftKey);
    if (draft && editor?.textarea === textarea && !textarea.value) {
      textarea.value = draft;
      textarea.setSelectionRange(draft.length, draft.length);
    }
  }

  function deleteButton(c) {
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "Delete";
    // two-step delete so a stray Tab+Enter can't remove a comment
    del.addEventListener("click", async () => {
      if (!del.dataset.armed) {
        del.dataset.armed = "1";
        del.textContent = "Really delete?";
        return;
      }
      try {
        const res = await bg({ type: "delete", id: c.id });
        setComments(res.comments, res.offline);
        editor?.textarea.focus();
        flash("Deleted");
      } catch (e) {
        flash(`Delete failed: ${e.message}`, true);
      }
    });
    del.addEventListener("blur", () => { delete del.dataset.armed; del.textContent = "Delete"; });
    return del;
  }

  function fillExisting() {
    if (!editor) return;
    editor.existing.replaceChildren();
    editor.deleteButtons = [];
    for (const c of placed.get(editor.idx) || []) {
      const card = document.createElement("div");
      card.className = "cmt";
      const text = document.createElement("span");
      text.textContent = c.text;
      const del = deleteButton(c);
      card.append(text, del);
      editor.existing.append(card);
      editor.deleteButtons.push(del);
    }
  }

  function closeEditor({ refocus = true } = {}) {
    if (!editor) return;
    const i = editor.idx;
    editor.el.remove();
    editor = null;
    CSS.highlights.delete("readmill-editing");
    hideEditedCards();
    layout();
    enterGuardUntil = performance.now() + 350;
    if (refocus && i >= 0) focusSentence(i, { scroll: "smooth" });
  }

  async function submit() {
    if (!editor) return;
    const { idx, key, draftKey } = editor;
    const text = editor.textarea.value.trim();
    if (!text) {
      store.del(draftKey);
      closeEditor();
      return;
    }
    const i = idx >= 0 ? idx : (byText.get(key) || [-1])[0];
    const comment = {
      id: crypto.randomUUID(),
      quote: key,
      prefix: i >= 0 ? prefixOf(i) : "",
      suffix: i >= 0 ? suffixOf(i) : "",
      order: i,
      text,
      created: new Date().toISOString(),
    };
    editor.save.disabled = true;
    try {
      const res = await bg({ type: "add", title: document.title, comment });
      store.del(draftKey);
      closeEditor();
      setComments(res.comments, res.offline);
      flash(res.offline ? "Saved in browser (host not reachable)" : "Saved", res.offline);
    } catch (e) {
      if (editor) editor.save.disabled = false;
      flash(`Save failed: ${e.message} (draft kept)`, true);
    }
  }

  function setComments(list, isOffline) {
    comments = list || [];
    offline = !!isOffline;
    place();
    renderComments();
    fillExisting();
  }

  // ---------- keyboard ----------
  const isEditable = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  const OURS = new Set(["Tab", "Enter", "Escape"]);

  // Runs first (window, capture phase) so page shortcuts don't fire while Readmill is driving.
  function onKeyDown(e) {
    if (!active) return;
    const inUs = e.composedPath().includes(host);

    if (editor && inUs) {
      e.stopImmediatePropagation(); // typing in our box must not trigger page shortcuts
      const focused = shadow.activeElement;
      if (e.key === "Escape") {
        e.preventDefault();
        closeEditor();
      } else if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // cycle inside the editor: textarea → Save → Cancel → delete buttons → textarea
        e.preventDefault();
        const stops = [editor.textarea, editor.save, editor.cancel, ...editor.deleteButtons];
        const i = stops.indexOf(focused);
        stops[(i + (e.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
      } else if (e.key === "Enter" && e.repeat && focused?.tagName === "BUTTON") {
        e.preventDefault(); // a held pedal shouldn't click twice
      }
      return; // Enter in the textarea is a newline; Enter on a button clicks it
    }
    if (inUs || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isEditable(document.activeElement)) return; // the page's own inputs
    if (!OURS.has(e.key)) return;

    if (e.key === "Tab") {
      e.preventDefault();
      e.stopImmediatePropagation();
      move(e.shiftKey ? -1 : 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat || performance.now() < enterGuardUntil) return;
      if (current < 0 || (userScrolledAt > lastFocusAt && !inView(current))) {
        focusSentence(firstVisibleSentence(), { blur: true });
        return;
      }
      openEditor(current);
    } else if (e.key === "Escape" && editor) {
      e.stopImmediatePropagation();
      closeEditor();
    }
  }

  // Swallow the matching keyup/keypress too, so the page doesn't act on half a keystroke.
  function onKeyOther(e) {
    if (!active) return;
    const inUs = e.composedPath().includes(host);
    if (inUs ? !!editor : OURS.has(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditable(document.activeElement)) {
      e.stopImmediatePropagation();
    }
  }

  function onScrollKeys(e) {
    if (["PageDown", "PageUp", "ArrowDown", "ArrowUp", " ", "Home", "End"].includes(e.key) && !e.composedPath().includes(host)) {
      userScrolledAt = performance.now();
    }
  }

  // ---------- mouse: click picks a sentence, double-click comments on it ----------
  function sentenceAt(x, y) {
    const cr = document.caretRangeFromPoint?.(x, y);
    const ids = cr && byNode.get(cr.startContainer);
    if (!ids) return -1;
    return ids.find((i) => sentences[i].range.comparePoint(cr.startContainer, cr.startOffset) === 0) ?? ids[0];
  }
  function onClick(e) {
    if (!active || e.composedPath().includes(host) || getSelection()?.toString()) return;
    const i = sentenceAt(e.clientX, e.clientY);
    if (i >= 0) focusSentence(i, { scroll: false });
  }
  function onDblClick(e) {
    if (!active || e.composedPath().includes(host)) return;
    const i = sentenceAt(e.clientX, e.clientY);
    if (i < 0) return;
    getSelection()?.removeAllRanges();
    focusSentence(i, { scroll: false });
    openEditor(i);
  }
  const onWheel = () => { userScrolledAt = performance.now(); };

  // ---------- keeping up with the page ----------
  // Re-split when the page's text changes (lazy loading, "read more", single-page-app navigation).
  let rescanTimer;
  const observer = new MutationObserver(() => {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(rescan, 700);
  });

  function rescan() {
    if (!active || document.body.textContent.length === lastSignature) return;
    const curText = sentences[current]?.text;
    const oldCur = current;
    scan();
    const near = (text, old) => {
      const c = byText.get(text) || [];
      return c.length ? c.reduce((b, i) => (Math.abs(i - old) < Math.abs(b - old) ? i : b)) : -1;
    };
    current = curText ? near(curText, oldCur) : -1;
    if (current >= 0) highlight("current", [sentences[current].range]);
    else CSS.highlights.delete("readmill-current");
    if (editor) {
      editor.idx = near(editor.key, editor.idx);
      if (editor.idx >= 0) highlight("editing", [sentences[editor.idx].range]);
    }
    place();
    renderComments();
    fillExisting();
  }

  function checkUrl() {
    if (pageUrl() === lastUrl) return;
    lastUrl = pageUrl();
    if (editor) closeEditor({ refocus: false });
    current = -1;
    CSS.highlights.delete("readmill-current");
    comments = [];
    loadComments();
  }

  async function loadComments() {
    try {
      const res = await bg({ type: "list" });
      setComments(res.comments, res.offline);
    } catch (e) {
      flash(`Couldn't load comments: ${e.message}`, true);
    }
  }

  // Pick up comment files edited by hand when you come back to the tab.
  function onVisible() {
    if (active && document.visibilityState === "visible") loadComments();
  }

  // ---------- on / off ----------
  let urlTimer;
  const resizeObs = new ResizeObserver(queueLayout);

  async function activate() {
    if (active) return;
    active = true;
    ui.classList.toggle("light", isLightPage());
    document.documentElement.append(host);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyOther, true);
    window.addEventListener("keypress", onKeyOther, true);
    window.addEventListener("keydown", onScrollKeys, true);
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchmove", onWheel, { passive: true });
    window.addEventListener("resize", queueLayout);
    document.addEventListener("scroll", queueLayout, { capture: true, passive: true }); // inner scrolling panes
    document.addEventListener("click", onClick);
    document.addEventListener("dblclick", onDblClick);
    document.addEventListener("visibilitychange", onVisible);
    resizeObs.observe(document.body);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    urlTimer = setInterval(checkUrl, 1000);
    lastUrl = pageUrl();

    scan();
    renderComments();
    if (!sentences.length) flash("No readable text found on this page", true);
    await loadComments();
    // Resume where you left off when arriving at the top of a page; otherwise start where you are.
    const saved = await store.get(POS_KEY + pageUrl());
    const savedIdx = scrollY < 50 && saved ? (byText.get(saved) || [])[0] : undefined;
    if (savedIdx !== undefined) focusSentence(savedIdx, { scroll: "instant" });
    else if (sentences.length) focusSentence(firstVisibleSentence(), { scroll: false });
  }

  function deactivate() {
    if (!active) return;
    if (editor) closeEditor({ refocus: false });
    active = false;
    host.remove();
    clearHighlights();
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyOther, true);
    window.removeEventListener("keypress", onKeyOther, true);
    window.removeEventListener("keydown", onScrollKeys, true);
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("touchmove", onWheel);
    window.removeEventListener("resize", queueLayout);
    document.removeEventListener("scroll", queueLayout, { capture: true });
    document.removeEventListener("click", onClick);
    document.removeEventListener("dblclick", onDblClick);
    document.removeEventListener("visibilitychange", onVisible);
    resizeObs.disconnect();
    observer.disconnect();
    clearInterval(urlTimer);
    clearTimeout(rescanTimer);
    current = -1;
    bg({ type: "deactivated" }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === "toggle") active ? deactivate() : activate();
    else if (msg.type === "activate") activate();
    else if (msg.type === "comments" && active) {
      setComments(msg.comments, msg.offline);
    }
    reply({ ok: true });
  });

  // ---------- styles for Readmill's own UI ----------
  function UI_CSS() {
    return `
    .root {
      --bg: #181b20; --bg-2: #20242b; --bg-3: #262b33; --text: #d9d4c7; --text-dim: #8b8a84;
      --accent: #7fb3d5; --focus-edge: #e9c46a; --commented: #c38d9e; --border: #2f353e;
      --shadow: 0 6px 24px rgba(0,0,0,.35);
      font: 14px/1.5 "Inter", -apple-system, system-ui, sans-serif;
      color: var(--text);
    }
    .root.light {
      --bg: #ffffff; --bg-2: #faf8f4; --bg-3: #ffffff; --text: #2b2a27; --text-dim: #7c7a73;
      --accent: #2f6f9a; --focus-edge: #d9a92b; --commented: #b0687f; --border: #e3ded4;
      --shadow: 0 6px 24px rgba(40,30,10,.14);
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .layer { position: absolute; top: 0; left: 0; width: 0; height: 0; }
    .layer > * { position: absolute; }

    .badge {
      font-size: 10px; font-weight: 600; line-height: 16px; height: 16px; min-width: 16px;
      text-align: center; padding: 0 4px; border-radius: 8px;
      color: #fff; background: var(--commented); cursor: pointer; user-select: none;
    }
    .cmt {
      width: ${CARD_W}px; background: var(--bg-2); color: var(--text);
      border: 1px solid var(--border); border-left: 3px solid var(--commented); border-radius: 8px;
      padding: 7px 11px; white-space: pre-wrap; overflow-wrap: anywhere; cursor: pointer;
      box-shadow: var(--shadow); transition: top .15s ease;
    }
    .layer > .cmt:hover { border-color: var(--commented); }

    .editor {
      width: ${CARD_W + 20}px; background: var(--bg-3); border: 1px solid var(--focus-edge); border-radius: 12px;
      padding: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.4);
    }
    .editor textarea {
      display: block; width: 100%; min-height: 120px; resize: vertical;
      background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 8px;
      padding: 9px 11px; font: inherit; font-size: 16px; line-height: 1.5;
    }
    .editor textarea:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
    .editor .row { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
    .editor .hint { color: var(--text-dim); font-size: 11px; margin-left: auto; }
    button {
      font: inherit; font-weight: 500; font-size: 13px; padding: 6px 14px; border-radius: 8px; cursor: pointer;
      border: 1px solid var(--border); background: var(--bg-2); color: var(--text);
    }
    button.save { background: #2d4a5f; border-color: #3c6580; color: #eaf4fb; }
    button:focus-visible, .editor button:focus { outline: 3px solid var(--focus-edge); outline-offset: 2px; }
    .existing { display: grid; gap: 6px; margin-bottom: 10px; }
    .existing .cmt, .orphans .cmt { width: auto; box-shadow: none; cursor: default; display: flex; gap: 10px; align-items: flex-start; }
    .existing .cmt span { flex: 1; }
    button.del { padding: 1px 9px; font-size: 11px; flex: none; }

    .pill {
      position: fixed; right: 16px; bottom: 16px; display: flex; gap: 8px; align-items: center;
      background: var(--bg-3); border: 1px solid var(--border); border-radius: 999px;
      padding: 4px 6px 4px 14px; box-shadow: var(--shadow); color: var(--text-dim); font-size: 12px;
    }
    .pill .name { color: var(--text); font-weight: 600; }
    .pill.offline .count { color: var(--focus-edge); }
    .pill .msg:empty { display: none; }
    .pill .msg { color: var(--accent); }
    .pill.err .msg { color: #e46f6f; }
    .pill button { padding: 1px 9px; font-size: 12px; border-radius: 999px; }
    .pill .close { border: 0; background: none; color: var(--text-dim); }
    .orphans {
      position: fixed; right: 16px; bottom: 56px; width: ${CARD_W + 60}px; max-height: 60vh; overflow: auto;
      display: grid; gap: 6px; padding: 10px; background: var(--bg-3); border: 1px solid var(--border);
      border-radius: 12px; box-shadow: var(--shadow);
    }
    .orphans .head { color: var(--text-dim); font-size: 12px; }
    .orphans .cmt { flex-direction: column; gap: 4px; }
    .orphans .q { color: var(--text-dim); font-style: italic; font-size: 12px; }
    `;
  }

  activate();
})();
