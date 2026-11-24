const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8"
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: CORS_HEADERS
  });
}

function normalizeTerms(raw) {
  const cleaned = String(raw || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
    .trim();

  if (!cleaned) return [];

  const stopWords = new Set([
    "the", "and", "or", "for", "in", "on", "to", "of", "a", "an", "is", "are", "with", "best",
    "ve", "veya", "ile", "icin", "için", "bir", "bu", "su", "şu", "en", "olan", "olarak", "nedir", "nerede"
  ]);

  const parts = cleaned.split(/\s+/).filter(Boolean);
  const filtered = parts.filter((w) => w.length > 1 && !stopWords.has(w));
  return (filtered.length > 0 ? filtered : parts).slice(0, 6);
}

async function searchRecords(db, terms) {
  if (!db || !Array.isArray(terms) || terms.length === 0) {
    return { sponsored: null, organic: [] };
  }

  const whereClauses = terms
    .map(
      () =>
        "(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(tags) LIKE ? OR LOWER(cid) LIKE ?)"
    )
    .join(" OR ");

  const binds = [];
  for (const term of terms) {
    const like = `%${term}%`;
    binds.push(like, like, like, like);
  }

  const sql = `
    SELECT id, cid, title, description, tags, lang, is_sponsored, clicks
    FROM records
    WHERE status = 'active'
      AND (${whereClauses})
    ORDER BY is_sponsored DESC, clicks DESC, id DESC
    LIMIT 20
  `;

  const rows = await db.prepare(sql).bind(...binds).all();
  const items = rows.results || [];

  const sponsoredList = items.filter((r) => Number(r.is_sponsored) === 1);
  const organic = items.filter((r) => Number(r.is_sponsored) !== 1);

  return {
    sponsored: sponsoredList[0] || null,
    organic
  };
}

function buildKeywordPrompt(query, lang) {
  return [
    "Extract 2 to 5 concise search keywords or topic terms from the user query for an IPFS directory search.",
    "Return ONLY comma-separated keywords, no markdown, no explanation.",
    `Language: ${lang || "en"}`,
    `Query: ${query}`
  ].join("\n");
}

async function callGemini(apiKey, prompt) {
  if (!apiKey) return "";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 80 }
    })
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function callGroq(apiKey, prompt) {
  if (!apiKey) return "";
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      temperature: 0.2,
      max_tokens: 80,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

async function callOpenRouter(apiKey, prompt) {
  if (!apiKey) return "";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://askweb.dpdns.org",
      "X-Title": "AskWeb"
    },
    body: JSON.stringify({
      model: "meta-llama/llama-3.2-3b-instruct:free",
      temperature: 0.2,
      max_tokens: 80,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

async function expandTermsWithAI(env, query, lang) {
  const prompt = buildKeywordPrompt(query, lang);
  const providers = [
    { name: "gemini", fn: () => callGemini(env.GEMINI_API_KEY, prompt) },
    { name: "groq", fn: () => callGroq(env.GROQ_API_KEY, prompt) },
    { name: "openrouter", fn: () => callOpenRouter(env.OPENROUTER_API_KEY, prompt) }
  ];

  for (const provider of providers) {
    try {
      const rawText = await provider.fn();
      const terms = normalizeTerms(rawText);
      if (terms.length > 0) {
        return { terms, provider: provider.name };
      }
    } catch (_) {}
  }

  return { terms: [], provider: null };
}

async function handleResolve(request, env, isPost) {
  let rawQuery = "";
  let lang = "en";

  if (isPost) {
    const body = await request.json().catch(() => ({}));
    rawQuery = String(body.query || body.q || "").trim();
    lang = String(body.lang || "en").trim();
  } else {
    const url = new URL(request.url);
    rawQuery = String(url.searchParams.get("q") || url.searchParams.get("query") || "").trim();
    lang = String(url.searchParams.get("lang") || "en").trim();
  }

  if (!rawQuery) {
    return jsonResponse({ query: "", sponsored: null, organic: [], source: "empty" });
  }

  const directTerms = normalizeTerms(rawQuery);
  const initialTerms = directTerms.length > 0 ? directTerms : [rawQuery.toLowerCase()];
  let found = await searchRecords(env.DB, initialTerms);

  if (found.sponsored || found.organic.length > 0) {
    return jsonResponse({
      query: rawQuery,
      sponsored: found.sponsored,
      organic: found.organic,
      source: "d1_direct",
      matched_terms: initialTerms
    });
  }

  const aiResult = await expandTermsWithAI(env, rawQuery, lang);
  if (aiResult.terms.length > 0) {
    found = await searchRecords(env.DB, aiResult.terms);
    return jsonResponse({
      query: rawQuery,
      sponsored: found.sponsored,
      organic: found.organic,
      source: `ai_${aiResult.provider || "fallback"}`,
      expanded_terms: aiResult.terms
    });
  }

  return jsonResponse({
    query: rawQuery,
    sponsored: null,
    organic: [],
    source: "none"
  });
}

async function handleSubmit(request, env) {
  const body = await request.json().catch(() => ({}));
  const cid = String(body.cid || "").trim();
  const title = String(body.title || "").trim();
  const description = String(body.description || "").trim();
  const tags = String(body.tags || "").trim();
  const plan = String(body.plan || "listing").trim();
  const contact = String(body.contact || "").trim();

  if (!cid || !title || !description) {
    return jsonResponse({ ok: false, error: "CID, title and description are required" }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO submissions (cid, title, description, tags, plan, contact, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`
  ).bind(cid, title, description, tags, plan, contact).run();

  return jsonResponse({ ok: true, status: "pending" }, 201);
}

async function handleClick(request, env) {
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);

  if (!Number.isInteger(id) || id <= 0) {
    return jsonResponse({ ok: false, error: "Invalid record id" }, 400);
  }

  await env.DB.prepare("UPDATE records SET clicks = clicks + 1 WHERE id = ?").bind(id).run();
  return jsonResponse({ ok: true, id });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/resolve" || path === "/resolve") {
        const isPost = request.method === "POST";
        if (!isPost && request.method !== "GET") {
          return jsonResponse({ error: "Method not allowed" }, 405);
        }
        return await handleResolve(request, env, isPost);
      }

      if (path === "/api/submit" || path === "/submit") {
        if (request.method !== "POST") {
          return jsonResponse({ error: "Method not allowed" }, 405);
        }
        return await handleSubmit(request, env);
      }

      if (path === "/api/click" || path === "/click") {
        if (request.method !== "POST") {
          return jsonResponse({ error: "Method not allowed" }, 405);
        }
        return await handleClick(request, env);
      }

      if (path === "/health") {
        return jsonResponse({
          ok: true,
          has_db: Boolean(env.DB),
          ai_keys: {
            gemini: Boolean(env.GEMINI_API_KEY),
            groq: Boolean(env.GROQ_API_KEY),
            openrouter: Boolean(env.OPENROUTER_API_KEY)
          }
        });
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
      return jsonResponse({ error: err?.message || "Worker error" }, 500);
    }
  }
};
