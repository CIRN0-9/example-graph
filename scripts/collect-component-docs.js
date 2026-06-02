import fs from "fs/promises";
import path from "path";

const BASE_URL =
  process.env.COMPONENT_DOC_BASE_URL || "http://192.168.1.200:5000";
const ENTRY_PATH = process.env.COMPONENT_DOC_ENTRY_PATH || "/component/";
const OUTPUT_DIR = path.resolve(process.cwd(), "data", "component-docs");
const OUTPUT_JSONL = path.join(OUTPUT_DIR, "docs.jsonl");
const OUTPUT_INDEX = path.join(OUTPUT_DIR, "index.json");
const MAX_PAGES = Number(process.env.COMPONENT_DOC_MAX_PAGES || 500);
const REQUEST_INTERVAL_MS = Number(
  process.env.COMPONENT_DOC_INTERVAL_MS || 120,
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(rawHref, currentUrl) {
  try {
    const url = new URL(rawHref, currentUrl);
    if (url.origin !== new URL(BASE_URL).origin) return null;
    if (!url.pathname.startsWith("/component/")) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function extractLinks(html, currentUrl) {
  const links = new Set();
  const re = /href\s*=\s*"'["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!href || href.startsWith("javascript:")) continue;
    const normalized = normalizeUrl(href, currentUrl);
    if (normalized) links.add(normalized);
  }
  return [...links];
}

function pickTitle(html, url) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return stripHtml(h1[1]).slice(0, 200);

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) return stripHtml(title[1]).slice(0, 200);

  return new URL(url).pathname;
}

function pickMainText(html) {
  const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const source = main ? main[1] : html;
  return stripHtml(source);
}

function toDocId(url) {
  return Buffer.from(url).toString("base64url");
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "component-doc-collector/1.0",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) {
    throw new Error("HTTP " + res.status + " at " + url);
  }
  return await res.text();
}

async function collect() {
  const entryUrl = new URL(ENTRY_PATH, BASE_URL).toString();
  const queue = [entryUrl];
  const visited = new Set();
  const docs = [];
  const errors = [];

  while (queue.length > 0 && visited.size < MAX_PAGES) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);

    try {
      const html = await fetchHtml(url);
      const title = pickTitle(html, url);
      const text = pickMainText(html);
      const pathname = new URL(url).pathname;

      if (text.length >= 40) {
        docs.push({
          id: toDocId(url),
          source: "lw-fe-component-docs",
          url,
          path: pathname,
          title,
          text,
          collectedAt: new Date().toISOString(),
        });
      }

      const links = extractLinks(html, url);
      for (const link of links) {
        if (!visited.has(link)) queue.push(link);
      }
    } catch (err) {
      errors.push({
        url,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    await sleep(REQUEST_INTERVAL_MS);
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const jsonl = docs.map((d) => JSON.stringify(d)).join("\n");
  await fs.writeFile(OUTPUT_JSONL, jsonl + (jsonl ? "\n" : ""), "utf8");

  const index = {
    baseUrl: BASE_URL,
    entryPath: ENTRY_PATH,
    totalVisited: visited.size,
    totalDocs: docs.length,
    totalErrors: errors.length,
    generatedAt: new Date().toISOString(),
    samplePaths: docs.slice(0, 20).map((d) => d.path),
    errors: errors.slice(0, 50),
  };
  await fs.writeFile(OUTPUT_INDEX, JSON.stringify(index, null, 2), "utf8");

  console.log("采集完成");
  console.log("visited =", visited.size);
  console.log("docs =", docs.length);
  console.log("errors =", errors.length);
  console.log("jsonl =", OUTPUT_JSONL);
  console.log("index =", OUTPUT_INDEX);
}

collect().catch((err) => {
  console.error("采集失败:", err);
  process.exit(1);
});
