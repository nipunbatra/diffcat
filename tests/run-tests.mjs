// Diffcat end-to-end test suite.
// Serves the repo, drives the app in headless Chrome, and checks the diff
// results against fixtures with known differences. Run `node make-fixtures.mjs` first.
//
//   CHROME_PATH=/path/to/chrome node run-tests.mjs      (default: macOS Chrome)
//   BASE=https://... node run-tests.mjs                 (test a deployed copy)

import puppeteer from "puppeteer-core";
import { FIXTURE_PW } from "./make-fixtures.mjs";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FIX = path.join(HERE, "fixtures");
const DL = path.join(FIX, "downloads");
const PORT = 8644;
const BASE = process.env.BASE || `http://localhost:${PORT}/`;
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });

/* ---------- tiny static server ---------- */

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml",
  ".png": "image/png", ".woff2": "font/woff2", ".pdf": "application/pdf",
};
let server = null;
if (!process.env.BASE) {
  server = http.createServer((req, res) => {
    const clean = path.normalize(decodeURIComponent(new URL(req.url, BASE).pathname));
    let file = path.join(ROOT, clean);
    if (clean === "/" || clean === "\\") file = path.join(ROOT, "index.html");
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end("not found"); return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  }).listen(PORT);
}

/* ---------- harness ---------- */

let browser;

function assert(cond, msg) { if (!cond) throw new Error(`assert failed: ${msg}`); }
function assertEq(got, want, msg) {
  if (got !== want) throw new Error(`assert failed: ${msg} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

async function newPage(dialogPlan = []) {
  const page = await browser.newPage();
  const ctx = { page, errors: [], dialogs: [], requests: [] };
  page.on("console", (m) => { if (m.type() === "error") ctx.errors.push(m.text()); });
  page.on("pageerror", (e) => ctx.errors.push(String(e)));
  page.on("request", (r) => { if (/^https?:/.test(r.url())) ctx.requests.push(r.url()); });
  page.on("dialog", async (d) => {
    ctx.dialogs.push({ type: d.type(), message: d.message() });
    const plan = dialogPlan.shift();
    if (plan?.dismiss) await d.dismiss();
    else await d.accept(plan?.text);
  });
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL, eventsEnabled: true });
  await page.goto(BASE, { waitUntil: "networkidle0" });
  return ctx;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, timeoutMs = 15000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const waitDownload = (name, timeoutMs = 20000) => {
  const file = path.join(DL, name);
  return until(
    () => (fs.existsSync(file) && !fs.existsSync(file + ".crdownload") ? fs.readFileSync(file) : null),
    `download ${name}`, timeoutMs, 200,
  );
};

const dataUrlBytes = (u) => Buffer.from(u.split(",")[1], "base64");

async function uploadPaths(page, pathA, pathB) {
  await (await page.$("#fileA")).uploadFile(pathA);
  await page.waitForFunction(
    () => window.__diffcat?.state.A && document.getElementById("busy").hidden,
    { timeout: 120000 },
  );
  await (await page.$("#fileB")).uploadFile(pathB);
  await page.waitForFunction(
    () => window.__diffcat?.state.B && document.getElementById("busy").hidden,
    { timeout: 120000 },
  );
}
const uploadPair = (page, nameA, nameB) => uploadPaths(page, path.join(FIX, nameA), path.join(FIX, nameB));

const waitScan = (page) =>
  page.waitForFunction(() => window.__diffcat?.state.scanned, { timeout: 120000 });

const waitDocDiff = (page) => page.waitForFunction(
  () => window.__diffcat.state.docDiff && document.getElementById("busy").hidden,
  { timeout: 120000 },
);

// words of the whole-document diff by op type, as seen by the page
const docWords = (page) => page.evaluate(() => {
  const d = window.__diffcat.state.docDiff;
  const words = (t) => d.ops.filter((o) => o.t === t).flatMap((o) => o.words);
  return { del: words("-"), ins: words("+"), out: words("<"), into: words(">"),
           delCount: d.delCount, insCount: d.insCount, moved: d.movedCount };
});

/* ---------- image fixtures generated in-browser ---------- */

async function makeImageFixtures() {
  const { page } = await newPage();
  const urls = await page.evaluate(() => {
    const out = {};
    const c = document.createElement("canvas");
    c.width = 400; c.height = 300;
    const g = c.getContext("2d");
    g.fillStyle = "#cc2211"; g.fillRect(0, 0, 200, 300);
    g.fillStyle = "#1133cc"; g.fillRect(200, 0, 200, 300);
    out.plain = c.toDataURL("image/png");
    const a = document.createElement("canvas");
    a.width = 200; a.height = 200;
    const ga = a.getContext("2d");
    ga.fillStyle = "#22aa44";
    ga.fillRect(80, 80, 40, 40); // opaque center, transparent elsewhere
    out.alpha = a.toDataURL("image/png");
    return out;
  });
  fs.writeFileSync(path.join(FIX, "plain.png"), dataUrlBytes(urls.plain));
  fs.writeFileSync(path.join(FIX, "alpha.png"), dataUrlBytes(urls.alpha));
  await page.close();
}

/* ---------- tests ---------- */

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("landing loads clean, no console errors", async () => {
  const { page, errors } = await newPage();
  const h1 = await page.$eval("h1", (e) => e.textContent);
  assert(h1.includes("changed"), "h1 copy present");
  assert(await page.$eval("#compare", (e) => e.hidden), "compare view hidden until files are loaded");
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("pair scan classifies pages (changed/same/changed/added); same-layout pair stays side by side", async () => {
  const { page, errors } = await newPage();
  await uploadPair(page, "diffv1.pdf", "diffv2.pdf");
  await waitScan(page);
  const st = await page.evaluate(() => ({
    statuses: window.__diffcat.state.scan.map((s) => s.status),
    mode: window.__diffcat.state.mode,
    heroHidden: document.getElementById("hero").hidden,
  }));
  assertEq(JSON.stringify(st.statuses), JSON.stringify(["changed", "same", "changed", "added"]), "page statuses");
  assertEq(st.mode, "side", "no auto-switch to the text view for a same-layout pair");
  assert(st.heroHidden, "hero gives way to the comparison");
  const summary = await page.$eval("#csummary", (e) => e.textContent);
  assert(summary.includes("3 of 4 pages differ"), `summary: "${summary}"`);
  assert(/text −\d+ \+\d+/.test(summary), `summary carries the document text stats: "${summary}"`);
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("changed page has pixel regions and an exact word diff", async () => {
  const { page } = await newPage();
  await uploadPair(page, "diffv1.pdf", "diffv2.pdf");
  await waitScan(page);
  const info = await page.evaluate(() => {
    const e = window.__diffcat.state.cache.get(0);
    const words = (t) => e.text.ops
      .filter((o) => o.t === t)
      .flatMap((o) => (t === "-" ? e.text.wordsA.slice(o.ai, o.ai + o.n) : e.text.wordsB.slice(o.bi, o.bi + o.n)))
      .map((w) => w.s);
    return {
      regions: e.regions.length, del: e.text.delCount, ins: e.text.insCount,
      delWords: words("-"), insWords: words("+"),
      delRects: e.text.delRects.length, insRects: e.text.insRects.length,
      rectsInBounds: [...e.text.delRects, ...e.text.insRects]
        .every((r) => r.x > -5 && r.y > -5 && r.x + r.w < e.w + 5 && r.y + r.h < e.h + 5),
    };
  });
  assert(info.regions >= 1, `changed page has diff regions: ${info.regions}`);
  assert(info.delWords.includes("USD-250000"), `old amount marked removed: ${info.delWords}`);
  assert(info.insWords.includes("USD-275000"), `new amount marked added: ${info.insWords}`);
  assert(info.insWords.includes("ADDED-LINE-V2"), `added line detected: ${info.insWords}`);
  assert(info.delRects === info.del && info.insRects === info.ins, "one highlight rect per changed word");
  assert(info.rectsInBounds, "word highlight rects lie on the canvas");
  const panel = await page.$eval("#ctext", (e) => e.textContent);
  assert(panel.includes("USD-250000") && panel.includes("USD-275000"), `text panel shows both amounts: "${panel.slice(0, 200)}"`);
  await page.close();
});

test("identical page reports no differences", async () => {
  const { page } = await newPage();
  await uploadPair(page, "diffv1.pdf", "diffv2.pdf");
  await waitScan(page);
  await page.evaluate(() => window.__diffcat.gotoPage(1));
  const info = await page.evaluate(() => {
    const e = window.__diffcat.state.cache.get(1);
    return { regions: e.regions.length, del: e.text.delCount, ins: e.text.insCount };
  });
  assertEq(info.regions, 0, "zero regions on identical page");
  assertEq(info.del + info.ins, 0, "zero word changes on identical page");
  const status = await page.$eval("#cstatus", (e) => e.textContent);
  assert(status.includes("no differences"), `status says identical: "${status}"`);
  await page.close();
});

test("page present only in the new file is flagged", async () => {
  const { page } = await newPage();
  await uploadPair(page, "diffv1.pdf", "diffv2.pdf");
  await waitScan(page);
  await page.evaluate(() => window.__diffcat.gotoPage(3));
  const status = await page.$eval("#cstatus", (e) => e.textContent);
  assert(status.includes("only in the new file"), `status: "${status}"`);
  await page.close();
});

test("inserted cover page realigns pages instead of cascading diffs", async () => {
  const { page, errors } = await newPage();
  await uploadPair(page, "shiftv1.pdf", "shiftv2.pdf");
  await waitScan(page);
  const st = await page.evaluate(() => {
    const S = window.__diffcat.state;
    return { statuses: S.scan.map((s) => s.status), pairs: S.pairs.map((p) => ({ a: p.a, b: p.b })) };
  });
  assertEq(JSON.stringify(st.statuses), JSON.stringify(["added", "same", "changed", "same"]),
    "cover page is 'added'; shifted pages pair up");
  assertEq(JSON.stringify(st.pairs), JSON.stringify([
    { a: null, b: 0 }, { a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 },
  ]), "alignment pairs old i with new i+1");
  const summary = await page.$eval("#csummary", (e) => e.textContent);
  assert(summary.includes("pages realigned"), `summary notes realignment: "${summary}"`);
  await page.evaluate(() => window.__diffcat.gotoPage(2));
  const info = await page.evaluate(() => {
    const e = window.__diffcat.state.cache.get(2);
    const words = (t) => e.text.ops.filter((o) => o.t === t)
      .flatMap((o) => (t === "-" ? e.text.wordsA.slice(o.ai, o.ai + o.n) : e.text.wordsB.slice(o.bi, o.bi + o.n)))
      .map((w) => w.s);
    return { del: words("-"), ins: words("+"), status: document.getElementById("cstatus").textContent };
  });
  assertEq(JSON.stringify(info.del), JSON.stringify(["original"]), "exactly the changed word marked removed");
  assertEq(JSON.stringify(info.ins), JSON.stringify(["revised"]), "exactly the changed word marked added");
  assert(info.status.includes("old p2 ↔ new p3"), `status shows the mapping: "${info.status}"`);
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("sample pair: view modes, page image, and the HTML report", async () => {
  const { page, errors } = await newPage();
  await page.click("#csample");
  await page.waitForFunction(
    () => window.__diffcat?.state.A && window.__diffcat?.state.B && document.getElementById("busy").hidden,
    { timeout: 120000 },
  );
  await waitScan(page);
  const st = await page.evaluate(() => {
    const S = window.__diffcat.state;
    return { pages: S.pageMax, statuses: S.scan.map((s) => s.status) };
  });
  assertEq(st.pages, 3, "sample pair has 3 aligned pairs");
  assertEq(JSON.stringify(st.statuses), JSON.stringify(["added", "changed", "same"]),
    "sample: cover added, policy changed, appendix same");
  for (const mode of ["overlay", "swipe", "text", "side"]) {
    await page.click(`#cmodes [data-mode="${mode}"]`);
    await sleep(150);
  }
  await page.click("#chl"); // highlights off…
  await page.click("#chl"); // …and back on: both draws must survive
  await page.click("#cimage");
  const png = await waitDownload("policy-v1-vs-policy-v2.page1.png");
  assert(png.length > 5000, "page image downloaded");
  await page.click("#cdownload");
  const html = (await waitDownload("policy-v1-vs-policy-v2.report.html")).toString("utf8");
  assert(html.includes("<del>") && html.includes("<ins>"), "report carries the text diff");
  assert(html.includes("policy-v1.pdf") && html.includes("policy-v2.pdf"), "report names both files");
  assert(html.includes("only in new") && html.includes("changed"), "report has the page map");
  assert(!/<script/i.test(html), "report is static HTML");
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("encrypted old side opens with password; identical content = no differences", async () => {
  const { page, dialogs } = await newPage([{ text: FIXTURE_PW }]);
  await uploadPair(page, "protected.pdf", "basic.pdf");
  await waitScan(page);
  assertEq(dialogs.filter((d) => d.type === "prompt").length, 1, "one password prompt");
  const statuses = await page.evaluate(() => window.__diffcat.state.scan.map((s) => s.status));
  assertEq(JSON.stringify(statuses), JSON.stringify(["same", "same"]), "decrypted pages match their plain twin");
  const summary = await page.$eval("#csummary", (e) => e.textContent);
  assert(summary.includes("no differences found"), `summary: "${summary}"`);
  await page.close();
});

test("images of different sizes diff by pixels, note the missing text layer", async () => {
  const { page } = await newPage();
  await uploadPair(page, "plain.png", "alpha.png");
  await waitScan(page);
  const info = await page.evaluate(() => {
    const e = window.__diffcat.state.cache.get(0);
    return { regions: e.regions.length, none: !!e.text.none, w: e.w, h: e.h };
  });
  assert(info.regions >= 1, `different images produce regions: ${info.regions}`);
  assert(info.none, "no text layer flagged");
  assert(info.w >= 400 && info.h >= 300, `union canvas covers the larger image: ${info.w}x${info.h}`);
  await page.click('#cmodes [data-mode="text"]');
  await waitDocDiff(page);
  const panel = await page.$eval("#cdoctext", (e) => e.textContent);
  assert(panel.includes("no text layer"), `text view notes missing text: "${panel}"`);
  await page.close();
});

test("two-file drop entry point works", async () => {
  if (process.env.BASE) { console.log("     (skipped on a deployed copy — fixtures aren't served there)"); return; }
  const { page } = await newPage();
  await page.evaluate(async () => {
    const get = async (n) =>
      new File([await (await fetch(n)).arrayBuffer()], n.split("/").pop(), { type: "application/pdf" });
    await window.__diffcatOpen([await get("tests/fixtures/diffv1.pdf"), await get("tests/fixtures/diffv2.pdf")]);
  });
  await waitScan(page);
  assertEq(await page.evaluate(() => window.__diffcat.state.pageMax), 4, "compare opened from the drop entry point");
  await page.close();
});

test("text view sees through reflow — exactly one changed word", async () => {
  const { page, errors } = await newPage();
  await uploadPair(page, "reflowv1.pdf", "reflowv2.pdf");
  await waitScan(page);
  const statuses = await page.evaluate(() => window.__diffcat.state.scan.map((s) => s.status));
  assert(statuses.some((s) => s !== "same"), `per-page scan sees reflow: ${statuses}`);
  await page.click('#cmodes [data-mode="text"]');
  await waitDocDiff(page);
  const w = await docWords(page);
  assertEq(JSON.stringify(w.del), JSON.stringify(["efficiency"]), "only the real word removed");
  assertEq(JSON.stringify(w.ins), JSON.stringify(["throughput"]), "only the real word added");
  const ui = await page.evaluate(() => ({
    panel: document.getElementById("cdoctext").textContent,
    status: document.getElementById("cstatus").textContent,
    stripHidden: document.getElementById("cstrip").hidden,
    pagerHidden: document.getElementById("cpager").hidden,
    imageHidden: document.getElementById("cimage").hidden,
  }));
  assert(ui.status.includes("−1 +1 words"), `doc status: "${ui.status}"`);
  assert(!ui.panel.includes("REFLOW REPORT"), "running head stripped from the text view");
  assert(ui.panel.includes("information processing"), "hyphenated word rejoined");
  assert(ui.stripHidden && ui.pagerHidden && ui.imageHidden, "page-only controls hidden in the text view");
  await page.click("#cdownload");
  const html = (await waitDownload("reflowv1-vs-reflowv2.report.html")).toString("utf8");
  assert(html.includes("<del>efficiency</del>") && html.includes("<ins>throughput</ins>"), "report shows the one edit");
  await page.click('#cmodes [data-mode="side"]');
  await sleep(200);
  const back = await page.evaluate(() => ({
    strip: document.getElementById("cstrip").hidden,
    doctext: document.getElementById("cdoctext").hidden,
    pair: document.getElementById("cpair").hidden,
  }));
  assert(!back.strip && back.doctext && !back.pair, "side-by-side restored after the text view");
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("text view on the standard pair shows amount change and added line", async () => {
  const { page } = await newPage();
  await uploadPair(page, "diffv1.pdf", "diffv2.pdf");
  await waitScan(page);
  await page.click('#cmodes [data-mode="text"]');
  await waitDocDiff(page);
  const w = await docWords(page);
  assert(w.del.includes("USD-250000"), `old amount removed: ${w.del}`);
  assert(w.ins.includes("USD-275000"), `new amount added: ${w.ins}`);
  assert(w.ins.includes("ADDED-LINE-V2"), `added line present: ${w.ins}`);
  assert(w.ins.join(" ").includes("appendix page only in v2"), "added page's text shows as insertion");
  await page.close();
});

test("page ranges skip front matter, restrict the text view, and reset", async () => {
  const { page, errors } = await newPage();
  await uploadPair(page, "shiftv1.pdf", "shiftv2.pdf");
  await waitScan(page);
  await page.evaluate(() => {
    document.getElementById("rB0").value = "2";
    document.getElementById("rB1").value = "4";
  });
  await page.click("#crangeapply");
  await waitScan(page);
  const st = await page.evaluate(() => {
    const S = window.__diffcat.state;
    return {
      statuses: S.scan.map((s) => s.status), pairs: S.pairs.map((p) => ({ a: p.a, b: p.b })),
      info: document.getElementById("crangeinfo").textContent,
      labels: [...document.querySelectorAll("#cstrip .pnum")].map((e) => e.textContent),
    };
  });
  assertEq(JSON.stringify(st.statuses), JSON.stringify(["same", "changed", "same"]), "no 'added' page once the cover is excluded");
  assertEq(JSON.stringify(st.pairs), JSON.stringify([{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }]), "pairs carry absolute page numbers");
  assertEq(JSON.stringify(st.labels), JSON.stringify(["1→2", "2→3", "3→4"]), "strip shows the absolute mapping");
  assert(st.info.includes("old 1–3 with new 2–4"), `range info: "${st.info}"`);
  await page.click('#cmodes [data-mode="text"]');
  await waitDocDiff(page);
  const w = await docWords(page);
  assertEq(JSON.stringify(w.del), JSON.stringify(["original"]), "text view: only the real removal");
  assertEq(JSON.stringify(w.ins), JSON.stringify(["revised"]), "text view: cover-page text no longer counts as added");
  await page.click('#cmodes [data-mode="side"]');
  await page.click("#crangeall");
  await waitScan(page);
  const full = await page.evaluate(() => ({
    pairs: window.__diffcat.state.pairs.length,
    info: document.getElementById("crangeinfo").textContent,
    b0: document.getElementById("rB0").value, b1: document.getElementById("rB1").value,
  }));
  assertEq(full.pairs, 4, "all four pairs back");
  assertEq(full.info, "all pages", "range info reset");
  assert(full.b0 === "1" && full.b1 === "4", `inputs reset: ${full.b0}–${full.b1}`);
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("out-of-range page numbers are clamped, not rejected", async () => {
  const { page } = await newPage();
  await uploadPair(page, "diffv1.pdf", "diffv2.pdf");
  await waitScan(page);
  await page.evaluate(() => {
    document.getElementById("rA0").value = "0";
    document.getElementById("rA1").value = "99";
    document.getElementById("rB0").value = "3";
    document.getElementById("rB1").value = "2"; // end before start
  });
  await page.click("#crangeapply");
  await waitScan(page);
  const v = await page.evaluate(() => ({
    a0: document.getElementById("rA0").value, a1: document.getElementById("rA1").value,
    b0: document.getElementById("rB0").value, b1: document.getElementById("rB1").value,
    pairs: window.__diffcat.state.pairs.map((p) => ({ a: p.a, b: p.b })),
  }));
  assert(v.a0 === "1" && v.a1 === "3", `old range clamped to the file: ${v.a0}–${v.a1}`);
  assert(v.b0 === "3" && v.b1 === "3", `inverted new range collapses to a single page: ${v.b0}–${v.b1}`);
  assert(v.pairs.some((p) => p.a === 2 && p.b === 2), `old p3 pairs with new p3: ${JSON.stringify(v.pairs)}`);
  assertEq(v.pairs.filter((p) => p.b == null).length, 2, "old pages 1–2 have no counterpart in the window");
  await page.close();
});

test("text view reports a relocated paragraph as a move, not an edit", async () => {
  const { page, errors } = await newPage();
  await uploadPair(page, "movev1.pdf", "movev2.pdf");
  await waitScan(page);
  await page.click('#cmodes [data-mode="text"]');
  await waitDocDiff(page);
  const w = await docWords(page);
  assertEq(w.delCount + w.insCount, 0, `no words counted as edited: −${w.delCount} +${w.insCount}`);
  assertEq(w.moved, 12, `exactly the Bravo paragraph counts as moved: ${w.moved} words`);
  assert(w.out.join(" ").startsWith("Bravo paragraph") && w.into.join(" ").startsWith("Bravo paragraph"), "moved text identified");
  const ui = await page.evaluate(() => ({
    status: document.getElementById("cstatus").textContent,
    movSpans: document.querySelectorAll("#cdoctext .tmov").length,
  }));
  assert(ui.status.includes("no text differences") && ui.status.includes("words moved"), `status: "${ui.status}"`);
  assertEq(ui.movSpans, 2, "moved-away and moved-here spans rendered");
  await page.click("#cdownload");
  const html = (await waitDownload("movev1-vs-movev2.report.html")).toString("utf8");
  assert((html.match(/class="mov" title=/g) || []).length === 2 && html.includes("Bravo paragraph"), "report marks the move");
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("ranges follow a swap, apply on Enter, and reset when a file is replaced", async () => {
  const { page } = await newPage();
  await uploadPair(page, "shiftv1.pdf", "shiftv2.pdf");
  await waitScan(page);
  await page.focus("#rB0");
  await page.evaluate(() => { document.getElementById("rB0").value = "2"; });
  await page.keyboard.press("Enter");
  await waitScan(page);
  let info = await page.$eval("#crangeinfo", (e) => e.textContent);
  assert(info.includes("old 1–3 with new 2–4"), `Enter applied the range: "${info}"`);
  await page.click("#cswap");
  await waitScan(page);
  info = await page.$eval("#crangeinfo", (e) => e.textContent);
  assert(info.includes("old 2–4 with new 1–3"), `windows swapped with the files: "${info}"`);
  const swapped = await page.evaluate(() => ({
    a: document.getElementById("slotAname").textContent,
    labels: [...document.querySelectorAll("#cstrip .pnum")].map((e) => e.textContent),
  }));
  assert(swapped.a.startsWith("shiftv2.pdf"), `old side is now v2: "${swapped.a}"`);
  assertEq(JSON.stringify(swapped.labels), JSON.stringify(["2→1", "3→2", "4→3"]), "labels reflect the swapped mapping");
  await (await page.$("#fileA")).uploadFile(path.join(FIX, "diffv1.pdf"));
  await page.waitForFunction(
    () => window.__diffcat.state.A?.name === "diffv1.pdf" && window.__diffcat.state.scanned,
    { timeout: 120000 },
  );
  const after = await page.evaluate(() => ({
    a0: document.getElementById("rA0").value, a1: document.getElementById("rA1").value,
    b0: document.getElementById("rB0").value, b1: document.getElementById("rB1").value,
  }));
  assert(after.a0 === "1" && after.a1 === "3", `replaced side compares whole: ${after.a0}–${after.a1}`);
  assert(after.b0 === "1" && after.b1 === "3", `untouched side keeps its window: ${after.b0}–${after.b1}`);
  await page.close();
});

// A real preprint-vs-publisher-proof pair lives in tests/private/ (gitignored:
// it is someone's unpublished chapter). When present, the tool must reproduce
// the findings of the hand-checked comparison summary made for its author.
test("real proof pair (local only) — auto text view, page range, hand-checked findings", async () => {
  const OLD = path.join(HERE, "private", "proof-old.pdf");
  const NEW = path.join(HERE, "private", "proof-new.pdf");
  if (!fs.existsSync(OLD) || !fs.existsSync(NEW)) {
    console.log("     (skipped — tests/private/proof-old.pdf / proof-new.pdf not present)");
    return;
  }
  const { page, errors } = await newPage();
  await uploadPaths(page, OLD, NEW);
  await waitScan(page);
  // re-typeset pair: the tool must pick the text view by itself and say why
  let ui = await page.evaluate(() => ({
    mode: window.__diffcat.state.mode,
    note: document.getElementById("cnote").hidden ? "" : document.getElementById("cnote").textContent,
  }));
  assertEq(ui.mode, "text", "re-typeset pair opens in the text view");
  assert(ui.note.includes("re-typeset"), `the note explains the auto choice: "${ui.note}"`);
  // the proof wraps the chapter in a metadata sheet + stub (pp. 1–2) and
  // author queries + figure alt-text (pp. 21–23): compare the chapter body only
  await page.evaluate(() => {
    document.getElementById("rB0").value = "3";
    document.getElementById("rB1").value = "20";
  });
  await page.click("#crangeapply");
  await waitScan(page);
  const st = await page.evaluate(() => {
    const S = window.__diffcat.state;
    return { statuses: S.scan.map((s) => s.status), info: document.getElementById("crangeinfo").textContent };
  });
  assert(st.info.includes("old 1–19 with new 3–20"), `range applied: "${st.info}"`);
  console.log(`     real pair, page statuses: ${st.statuses.join(",")}`);
  const unmatched = st.statuses.filter((s) => s === "removed" || s === "added").length;
  const flows = st.statuses.filter((s) => s === "flow").length;
  assert(unmatched <= 1, `at most one page without a counterpart (got ${unmatched}): ${st.statuses}`);
  assert(flows >= 3, `pages merged/split by re-pagination read as text flow: ${st.statuses}`);
  // page views still work and explain the unmatched page
  await page.click('#cmodes [data-mode="side"]');
  await page.evaluate(() => window.__diffcat.gotoPage(0));
  const status0 = await page.$eval("#cstatus", (e) => e.textContent);
  assert(/only in the (old|new) file \(\d+% of its words appear on/.test(status0) || status0.includes("↝"),
    `unmatched/flow page explains where its text went: "${status0}"`);
  await page.click('#cmodes [data-mode="text"]');
  await waitDocDiff(page);
  const t = await docWords(page);
  console.log(`     real pair, chapter body only: −${t.delCount} +${t.insCount} words, ${t.moved} words moved`);
  assert(t.del.includes("organism") && t.ins.includes("organism's"), "verb→possessive change (organism functions → organism's functions)");
  assert(t.del.includes('"RP.".') && t.ins.includes('"RP.."'), "doubled period inside the RP quotation");
  assert(t.del.includes("Ewald,") && t.ins.includes("Weibel"), "reference 10 author corrected to Weibel");
  assert(t.del.includes("5th") && t.ins.includes("fifth") && t.del.includes("6th") && t.ins.includes("sixth"), "ordinals spelled out");
  assert(t.del.includes("section") && t.ins.some((w) => w.startsWith("Sect.")), "cross-reference restyle (section → Sect.)");
  assert(!t.ins.includes("Kindly"), "author-query text excluded");
  assert(!t.ins.includes("HolderName"), "metadata sheet excluded");
  assert(t.moved >= 100, `relocated footnotes recognized as moves: ${t.moved}`);
  assert(t.delCount + t.insCount < 1500, `edit volume stays at the known level: −${t.delCount} +${t.insCount}`);
  await page.click("#cdownload");
  const html = (await waitDownload("proof-old-vs-proof-new.report.html")).toString("utf8");
  assert(html.includes("<ins>organism&#39;s</ins>") || html.includes("<ins>organism's</ins>"), "report carries the possessive change");
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("tightly justified text without space glyphs still diffs word by word", async () => {
  const { page, errors } = await newPage();
  await uploadPair(page, "tightv1.pdf", "tightv2.pdf");
  await waitScan(page);
  await page.click('#cmodes [data-mode="text"]');
  await waitDocDiff(page);
  const w = await docWords(page);
  assertEq(JSON.stringify(w.del), JSON.stringify(["quick"]), "only the edited word removed — no welded tokens");
  assertEq(JSON.stringify(w.ins), JSON.stringify(["swift"]), "only the edited word added");
  const panel = await page.$eval("#cdoctext", (e) => e.textContent);
  assert(!/brownfox|overthe|withoutany|jumpsover/.test(panel), `no welded words in the text view: "${panel.slice(0, 120)}"`);
  // the per-page word boxes use the same word breaks
  await page.click('#cmodes [data-mode="side"]');
  const perPage = await page.evaluate(() => {
    const e = window.__diffcat.state.cache.get(0);
    return { words: e.text.wordsB.length, del: e.text.delCount, ins: e.text.insCount };
  });
  assertEq(perPage.words, 27, "every word on the tight page is its own box");
  assert(perPage.del === 1 && perPage.ins === 1, `page view sees one changed word: −${perPage.del} +${perPage.ins}`);
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("start over clears everything and a new pair loads cleanly", async () => {
  const { page } = await newPage();
  await uploadPair(page, "diffv1.pdf", "diffv2.pdf");
  await waitScan(page);
  await page.click("#cclose");
  const cleared = await page.evaluate(() => {
    const S = window.__diffcat.state;
    return !S.A && !S.B && S.cache.size === 0 && document.getElementById("compare").hidden
      && !document.getElementById("hero").hidden;
  });
  assert(cleared, "compare state fully cleared, landing restored");
  await uploadPair(page, "shiftv1.pdf", "shiftv2.pdf");
  await waitScan(page);
  assertEq(await page.evaluate(() => window.__diffcat.state.pageMax), 4, "second pair compared");
  await page.close();
});

test("privacy: a full session makes zero cross-origin requests", async () => {
  const ctx = await newPage();
  const { page } = ctx;
  await uploadPair(page, "diffv1.pdf", "diffv2.pdf");
  await waitScan(page);
  await page.click('#cmodes [data-mode="overlay"]');
  await page.click("#cimage");
  await waitDownload("diffv1-vs-diffv2.page1.png");
  await page.click("#cdownload");
  await waitDownload("diffv1-vs-diffv2.report.html");
  const origin = new URL(BASE).origin;
  const foreign = ctx.requests.filter((u) => new URL(u).origin !== origin);
  assertEq(foreign.length, 0, `cross-origin requests seen: ${foreign.join(", ")}`);
  assert(ctx.requests.length > 3, "sanity: same-origin asset requests were captured");
  await page.close();
});

/* ---------- run ---------- */

browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: [
    "--window-size=1440,1000",
    ...(process.env.CI ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
  ],
  defaultViewport: { width: 1440, height: 1000 },
});

await makeImageFixtures();

let failed = 0;
for (const { name, fn } of tests) {
  // each test gets a clean downloads dir so names never collide
  for (const f of fs.readdirSync(DL)) fs.rmSync(path.join(DL, f));
  const t0 = Date.now();
  try {
    await fn();
    console.log(`ok   ${name}  (${Date.now() - t0}ms)`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(e.message || e).replace(/\n/g, "\n     ")}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
await browser.close();
server?.close();
process.exit(failed ? 1 : 0);
