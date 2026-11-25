import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "rss-parser";
import nodemailer from "nodemailer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SENT_LINKS_PATH = path.join(__dirname, "sent-links.json");

const LOOKBACK_HOURS = 36;
const LOOKBACK_MS = LOOKBACK_HOURS * 60 * 60 * 1000;
const PRUNE_DAYS = 14;
const PRUNE_MS = PRUNE_DAYS * 24 * 60 * 60 * 1000;
const FEED_TIMEOUT_MS = 15_000;
const GEMINI_TIMEOUT_MS = 120_000;
const FALLBACK_GEMINI_MODELS = [
  "gemini-flash-latest",
  "gemini-3.5-flash",
  "gemini-flash-lite-latest",
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.6-flash",
];

const TRACKING_PARAMS = new Set([
  "ref",
  "ref_src",
  "fbclid",
  "gclid",
  "yclid",
  "mc_cid",
  "mc_eid",
  "igshid",
]);

const RSS_FEEDS = [
  // AI & LLM
  {
    category: "AI & LLM",
    source: "Hacker News AI/LLM",
    url: "https://hnrss.org/newest?q=AI+OR+LLM+OR+OpenAI+OR+Claude+OR+Gemini&points=80",
  },
  {
    category: "AI & LLM",
    source: "OpenAI News",
    url: "https://openai.com/news/rss.xml",
  },
  {
    category: "AI & LLM",
    source: "Google AI Blog",
    url: "https://blog.google/technology/ai/rss/",
  },
  {
    category: "AI & LLM",
    source: "TechCrunch AI",
    url: "https://techcrunch.com/category/artificial-intelligence/feed/",
  },
  {
    category: "AI & LLM",
    source: "The Verge AI",
    url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",
  },
  {
    category: "AI & LLM",
    source: "Hugging Face Blog",
    url: "https://huggingface.co/blog/feed.xml",
  },
  {
    category: "AI & LLM",
    source: "Ars Technica Tech Lab",
    url: "https://feeds.arstechnica.com/arstechnica/technology-lab",
  },
  // Frontend (React & Next.js)
  {
    category: "Frontend: React & Next.js",
    source: "React Blog",
    url: "https://react.dev/rss.xml",
  },
  {
    category: "Frontend: React & Next.js",
    source: "Next.js Blog",
    url: "https://nextjs.org/feed.xml",
  },
  {
    category: "Frontend: React & Next.js",
    source: "Vercel Blog",
    url: "https://vercel.com/atom",
  },
  {
    category: "Frontend: React & Next.js",
    source: "Dev.to React",
    url: "https://dev.to/feed/tag/react",
  },
  {
    category: "Frontend: React & Next.js",
    source: "Dev.to Next.js",
    url: "https://dev.to/feed/tag/nextjs",
  },
  // Backend (Node.js & JS Ecosystem)
  {
    category: "Backend: Node.js & JS Ecosystem",
    source: "Node.js Blog",
    url: "https://nodejs.org/en/feed/blog.xml",
  },
  {
    category: "Backend: Node.js & JS Ecosystem",
    source: "Dev.to Node.js",
    url: "https://dev.to/feed/tag/node",
  },
  {
    category: "Backend: Node.js & JS Ecosystem",
    source: "HN JS/TS",
    url: "https://hnrss.org/newest?q=React+OR+Next.js+OR+Node.js+OR+TypeScript&points=50",
  },
  {
    category: "Backend: Node.js & JS Ecosystem",
    source: "Hacker News Frontpage",
    url: "https://hnrss.org/frontpage?points=100",
  },
];

/**
 * Normalize a URL by stripping hash fragments, tracking query parameters,
 * and redundant trailing slashes so comparisons and storage stay consistent.
 */
export function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    return "";
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";

    for (const key of [...parsed.searchParams.keys()]) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.startsWith("utm_") || TRACKING_PARAMS.has(lowerKey)) {
        parsed.searchParams.delete(key);
      }
    }

    parsed.searchParams.sort();

    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    }

    let normalized = parsed.toString();
    if (parsed.pathname === "/" && !parsed.search) {
      normalized = normalized.replace(/\/+$/, "");
    }
    return normalized;
  } catch {
    return trimmed.replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

function getRequiredConfig() {
  const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
  const geminiModel = process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest";
  const emailUser = process.env.EMAIL_USER?.trim();
  const emailAppPassword = process.env.EMAIL_APP_PASSWORD?.trim();
  const emailTo = process.env.EMAIL_TO?.trim();

  const missing = [];
  if (!geminiApiKey) missing.push("GEMINI_API_KEY");
  if (!emailUser) missing.push("EMAIL_USER");
  if (!emailAppPassword) missing.push("EMAIL_APP_PASSWORD");
  if (!emailTo) missing.push("EMAIL_TO");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}`
    );
  }

  return {
    geminiApiKey,
    geminiModel,
    emailUser,
    emailAppPassword,
    emailTo,
  };
}

async function loadSentLinks() {
  try {
    const raw = await fs.readFile(SENT_LINKS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const sanitized = {};
    for (const [url, ts] of Object.entries(parsed)) {
      const normalized = normalizeUrl(url);
      if (normalized && typeof ts === "number" && Number.isFinite(ts)) {
        sanitized[normalized] = ts;
      }
    }
    return sanitized;
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.warn(
        `Warning: could not parse sent-links.json (${err.message}); falling back to {}.`
      );
    }
    return {};
  }
}

async function saveSentLinks(state) {
  const json = `${JSON.stringify(state, null, 2)}\n`;
  await fs.writeFile(SENT_LINKS_PATH, json, "utf8");
}

function stripHtml(text = "") {
  return String(text)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchFeed(parser, feed) {
  const maxAttempts = 2;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(feed.url, {
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
        headers: {
          "User-Agent": "daily-tech-briefing/1.0 (+https://github.com)",
          Accept:
            "application/rss+xml, application/atom+xml, application/xml, text/xml",
        },
      });

      if (!response.ok) {
        const err = new Error(`HTTP ${response.status} ${response.statusText}`);
        if (![429, 500, 502, 503, 504].includes(response.status)) {
          throw err;
        }
        lastError = err;
      } else {
        const xml = await response.text();
        const parsed = await parser.parseString(xml);
        return {
          feed,
          items: parsed.items ?? [],
        };
      }
    } catch (err) {
      lastError = err;
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  throw lastError;
}

async function collectNewArticles(sentLinks) {
  const parser = new Parser();
  const now = Date.now();
  const cutoffMs = now - LOOKBACK_MS;

  const results = await Promise.allSettled(
    RSS_FEEDS.map((feed) => fetchFeed(parser, feed))
  );

  let totalRawItems = 0;
  let recentItemsCount = 0;
  const seenNormalized = new Set();
  const newArticles = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const feed = RSS_FEEDS[i];

    if (result.status === "rejected") {
      console.warn(
        `Warning: failed to fetch "${feed.source}" (${result.reason?.message || result.reason})`
      );
      continue;
    }

    const { items } = result.value;
    totalRawItems += items.length;

    for (const item of items) {
      const dateStr = item.isoDate || item.pubDate;
      const publishedMs = dateStr ? Date.parse(dateStr) : NaN;
      if (!Number.isFinite(publishedMs) || publishedMs < cutoffMs) {
        continue;
      }

      recentItemsCount += 1;

      const rawUrl = item.link?.trim();
      const normalized = normalizeUrl(rawUrl);
      if (!normalized) {
        continue;
      }

      if (sentLinks[normalized] !== undefined || seenNormalized.has(normalized)) {
        continue;
      }

      seenNormalized.add(normalized);

      const snippet = stripHtml(
        item.contentSnippet || item.content || item.summary || ""
      ).slice(0, 180);

      newArticles.push({
        title: stripHtml(item.title || "Untitled"),
        url: rawUrl,
        normalizedUrl: normalized,
        source: feed.source,
        categoryHint: feed.category,
        publishedAt: new Date(publishedMs).toISOString(),
        snippet,
      });
    }
  }

  // Sort newest first so Gemini sees freshest items at the top.
  newArticles.sort(
    (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
  );

  return {
    totalRawItems,
    recentItemsCount,
    newArticles,
  };
}

function selectBalancedCandidates(articles, maxTotal = 60) {
  const byCategory = new Map();
  for (const article of articles) {
    if (!byCategory.has(article.categoryHint)) {
      byCategory.set(article.categoryHint, []);
    }
    byCategory.get(article.categoryHint).push(article);
  }

  const selected = [];
  const selectedUrls = new Set();
  const perCategoryCap = Math.max(1, Math.floor(maxTotal / Math.max(1, byCategory.size)));

  for (const list of byCategory.values()) {
    for (const item of list.slice(0, perCategoryCap)) {
      selected.push(item);
      selectedUrls.add(item.normalizedUrl);
    }
  }

  if (selected.length < maxTotal) {
    for (const item of articles) {
      if (selected.length >= maxTotal) break;
      if (!selectedUrls.has(item.normalizedUrl)) {
        selected.push(item);
        selectedUrls.add(item.normalizedUrl);
      }
    }
  }

  return selected;
}

async function curateWithGemini({ apiKey, model, articles }) {
  const todayLabel = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());

  // Cap and balance payload across categories so prompt stays fast and avoids timeouts.
  const candidates = selectBalancedCandidates(articles, 30).map((a, idx) => ({
    index: idx + 1,
    title: a.title,
    url: a.url,
    source: a.source,
    categoryHint: a.categoryHint,
    publishedAt: a.publishedAt,
    snippet: a.snippet,
  }));

  const prompt = `Kamu adalah kurator berita teknologi senior untuk developer full-stack (AI/LLM, React/Next.js, Node.js).
Hari ini: ${todayLabel} (WIB).

Dari daftar artikel di bawah ini, lakukan kurasi dengan aturan ketat berikut:
1. Pilih **Top 3 berita paling berdampak per kategori** (maksimal 9 berita total, dan minimal 3 berita teratas secara keseluruhan selama tersedia ≥3 kandidat relevan — jangan hanya mengirim 1 berita!). Buang clickbait, tutorial dasar/pemula yang terlalu dangkal, promosi kosong, dan topik duplikat.
2. Kelompokkan berita terpilih ke dalam 3 kategori berikut (usahakan tiap kategori berisi 2–3 berita terbaik; jika satu kategori benar-benar minim kandidat layak, tetap tampilkan kategori lain dengan minimal total ≥3 berita):
   - 🤖 AI & LLM Radar
   - ⚛️ Frontend: React & Next.js
   - 🟢 Backend: Node.js & JS Ecosystem
3. Tulis dalam Bahasa Indonesia yang santai, padat, dan cerdas. Untuk setiap item wajib memuat:
   - Judul clickable yang mengarah langsung ke URL asli artikel (\`<a href="...">\`) + info sumber singkat.
   - 2 kalimat ringkasan inti yang jelas dan informatif.
   - 1 baris khusus berlabel "Kenapa ini penting buat kamu:" yang menjelaskan dampak praktisnya.
4. Hasilkan field "html" berisi markup HTML email yang bersih dengan inline CSS responsif:
   - Container utama max-width: 600px, margin: 0 auto, font-family sans-serif modern (-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif), line-height nyaman dibaca di HP maupun desktop.
   - Warna bersih, kontras tinggi, padding rapi, border-radius halus, dan header singkat "Daily Tech Briefing — ${todayLabel}".
   - Jangan gunakan external stylesheet atau script.
5. Pastikan SEMUA URL asli (persis seperti di input \`url\`) dari artikel yang tampil di HTML dimasukkan ke dalam array \`selectedUrls\`, dan hanya tampilkan di HTML artikel yang ada di \`selectedUrls\`. Jangan sertakan URL yang tidak ada di daftar input.

Kembalikan HANYA JSON valid dengan struktur persis:
{
  "selectedUrls": ["url1", "url2"],
  "html": "<div ...>...</div>"
}

Daftar artikel kandidat (${candidates.length} item):
${JSON.stringify(candidates, null, 2)}`;

  const requestBody = JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          selectedUrls: {
            type: "ARRAY",
            items: { type: "STRING" },
          },
          html: { type: "STRING" },
        },
        required: ["selectedUrls", "html"],
      },
      temperature: 0.4,
    },
  });

  const modelsToTry = [
    model,
    ...FALLBACK_GEMINI_MODELS.filter((m) => m !== model),
  ];

  let activeModel = model;
  let response;
  let lastError;

  for (const candidateModel of modelsToTry) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      candidateModel
    )}:generateContent`;

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: requestBody,
        });

        if (res.ok) {
          response = res;
          activeModel = candidateModel;
          break;
        }

        const errorText = await res.text();
        lastError = new Error(
          `Gemini API error (${res.status} on ${candidateModel}): ${errorText.slice(0, 500)}`
        );

        const isTransient = [429, 500, 502, 503, 504].includes(res.status);
        if (!isTransient) {
          throw lastError;
        }

        console.warn(
          `Warning: ${candidateModel} returned ${res.status} (attempt ${attempt}/${maxAttempts})`
        );
      } catch (err) {
        if (err === lastError) {
          throw err;
        }
        lastError = err;
        console.warn(
          `Warning: ${candidateModel} failed (attempt ${attempt}/${maxAttempts}): ${err?.message || err}`
        );
        if (err?.name === "TimeoutError") {
          break;
        }
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    if (response) {
      break;
    }

    console.warn(`Warning: switching away from ${candidateModel} to next fallback model...`);
  }

  if (!response) {
    throw lastError || new Error("All Gemini models failed.");
  }

  const data = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error(
      `Gemini (${activeModel}) returned an empty response: ${JSON.stringify(data).slice(0, 400)}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Gemini (${activeModel}) returned invalid JSON (${err.message}): ${rawText.slice(0, 300)}`
    );
  }

  if (!Array.isArray(parsed.selectedUrls) || typeof parsed.html !== "string") {
    throw new Error(
      "Gemini JSON response does not match expected { selectedUrls, html } schema."
    );
  }

  return {
    selectedUrls: parsed.selectedUrls
      .map((u) => (typeof u === "string" ? u.trim() : ""))
      .filter(Boolean),
    html: parsed.html.trim(),
    todayLabel,
    usedModel: activeModel,
  };
}

async function sendBriefingEmail({ emailUser, emailAppPassword, emailTo, html, todayLabel }) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: emailUser,
      pass: emailAppPassword,
    },
  });

  await transporter.sendMail({
    from: `"Daily Tech Briefing" <${emailUser}>`,
    to: emailTo,
    subject: `Daily Tech Briefing — ${todayLabel}`,
    html,
  });
}

function updateAndPruneState(currentState, selectedUrls, nowMs) {
  const nextState = {};
  const pruneCutoff = nowMs - PRUNE_MS;
  let prunedCount = 0;

  for (const [url, ts] of Object.entries(currentState)) {
    if (typeof ts === "number" && ts >= pruneCutoff) {
      nextState[url] = ts;
    } else {
      prunedCount += 1;
    }
  }

  let addedCount = 0;
  for (const rawUrl of selectedUrls) {
    const normalized = normalizeUrl(rawUrl);
    if (normalized) {
      if (nextState[normalized] === undefined) {
        addedCount += 1;
      }
      nextState[normalized] = nowMs;
    }
  }

  return { nextState, addedCount, prunedCount };
}

async function main() {
  const config = getRequiredConfig();
  const sentLinks = await loadSentLinks();

  const { totalRawItems, recentItemsCount, newArticles } =
    await collectNewArticles(sentLinks);

  console.log(`Gemini model : ${config.geminiModel}`);
  console.log(
    `Articles     : ${totalRawItems} raw fetched, ${recentItemsCount} within ${LOOKBACK_HOURS}h, ${newArticles.length} new (after deduplication)`
  );

  if (newArticles.length === 0) {
    console.log("No new articles found in the last 36 hours. Skipping email.");
    return;
  }

  const curated = await curateWithGemini({
    apiKey: config.geminiApiKey,
    model: config.geminiModel,
    articles: newArticles,
  });

  if (curated.selectedUrls.length === 0 || !curated.html) {
    console.log(
      "Gemini selected 0 articles after quality filtering. Skipping email."
    );
    return;
  }

  await sendBriefingEmail({
    emailUser: config.emailUser,
    emailAppPassword: config.emailAppPassword,
    emailTo: config.emailTo,
    html: curated.html,
    todayLabel: curated.todayLabel,
  });

  const nowMs = Date.now();
  const { nextState, addedCount, prunedCount } = updateAndPruneState(
    sentLinks,
    curated.selectedUrls,
    nowMs
  );

  await saveSentLinks(nextState);

  if (curated.usedModel !== config.geminiModel) {
    console.log(`Fallback used: ${curated.usedModel}`);
  }
  console.log(`Sent items   : ${curated.selectedUrls.length} article(s) emailed`);
  console.log(
    `State update : sent-links.json updated (+${addedCount} added, -${prunedCount} pruned > ${PRUNE_DAYS}d, ${Object.keys(nextState).length} total tracked)`
  );
}

main().catch((err) => {
  console.error(`Fatal error: ${err?.message || err}`);
  process.exitCode = 1;
});
