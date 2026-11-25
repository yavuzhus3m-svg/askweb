const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8"
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function parseJsonArray(rawText) {
  if (!rawText || typeof rawText !== "string") return [];
  const cleaned = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
  
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.results)) return parsed.results;
    if (parsed && Array.isArray(parsed.items)) return parsed.items;
    if (parsed && typeof parsed === "object") return [parsed];
  } catch (_) {
    // Doğrudan JSON parse başarısızsa metin içindeki ilk JSON dizisini dene
  }

  try {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (_) {
    // Bozuk dizi ifadesi durumunda güvenli boş diziye düş
  }

  return [];
}

async function callGeminiModel(geminiKey, prompt, model) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.2
        }
      })
    }
  );

  if (res.ok) {
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) return { ok: true, content: text };
    return { ok: false, error: `Gemini (${model}): boş yanıt` };
  }

  const errBody = await res.text().catch(() => "");
  return { ok: false, error: `Gemini (${model} - ${res.status}): ${errBody.slice(0, 120)}` };
}

async function callGroqModel(groqKey, prompt, model) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${groqKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 500
    })
  });

  if (res.ok) {
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (content) return { ok: true, content };
    return { ok: false, error: `Groq (${model}): boş yanıt` };
  }

  const errBody = await res.text().catch(() => "");
  return { ok: false, error: `Groq (${model} - ${res.status}): ${errBody.slice(0, 120)}` };
}

async function askAI(prompt, env) {
  const errors = [];

  // 1. GEMINI (Kasım 2026 güncel ücretsiz/aktif modeller)
  const geminiKey = env.GEMINI || env.GEMINI_API_KEY;
  if (!geminiKey) {
    errors.push("Gemini: Secret tanımlı değil");
  } else {
    const geminiModels = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];
    for (const model of geminiModels) {
      try {
        const result = await callGeminiModel(geminiKey, prompt, model);
        if (result.ok) return result.content;
        errors.push(result.error);
      } catch (e) {
        errors.push(`Gemini (${model}): ${e.message}`);
      }
    }
  }

  // 2. GROQ (Kasım 2026 güncel aktif modeller)
  const groqKey = env.GROQ || env.GROQ_API_KEY;
  if (!groqKey) {
    errors.push("Groq: Secret tanımlı değil");
  } else {
    const groqModels = [
      "openai/gpt-oss-20b",
      "qwen/qwen3.8-27b",
      "openai/gpt-oss-120b"
    ];
    for (const model of groqModels) {
      try {
        const result = await callGroqModel(groqKey, prompt, model);
        if (result.ok) return result.content;
        errors.push(result.error);
      } catch (e) {
        errors.push(`Groq (${model}): ${e.message}`);
      }
    }
  }

  // 3. HUGGING FACE (Yedek açık model)
  const hfKey = env.HUGGINGFACE || env.HF_TOKEN || env.HUGGINGFACE_API_KEY;
  if (!hfKey) {
    errors.push("HuggingFace: Secret tanımlı değil");
  } else {
    try {
      const res = await fetch("https://router.huggingface.co/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${hfKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "Qwen/Qwen2.5-7B-Instruct",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          max_tokens: 500
        })
      });

      if (res.ok) {
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (content) return content;
        errors.push("HuggingFace: boş yanıt");
      } else {
        const errBody = await res.text().catch(() => "");
        errors.push(`HuggingFace (${res.status}): ${errBody.slice(0, 120)}`);
      }
    } catch (e) {
      errors.push(`HuggingFace: ${e.message}`);
    }
  }

  throw new Error(errors.join(" | "));
}

async function handleResolve(request, env, isPost) {
  try {
    let rawQuery = "";
    let lang = "tr";

    if (isPost) {
      const body = await request.json().catch(() => ({}));
      rawQuery = String(body.query || body.q || "").trim();
      if (body.lang) lang = String(body.lang);
    } else {
      const url = new URL(request.url);
      rawQuery = String(url.searchParams.get("q") || url.searchParams.get("query") || "").trim();
      if (url.searchParams.get("lang")) lang = String(url.searchParams.get("lang"));
    }

    if (!rawQuery) {
      return new Response(
        JSON.stringify({ query: "", sponsored: null, organic: [], v: 4 }),
        { headers: CORS_HEADERS }
      );
    }

    const terms = rawQuery
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .slice(0, 5);

    const searchTerms = terms.length > 0 ? terms : [rawQuery.toLowerCase()];
    const whereClauses = searchTerms
      .map(() => "(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(tags) LIKE ? OR LOWER(cid) LIKE ?)")
      .join(" OR ");

    const binds = [];
    for (const term of searchTerms) {
      binds.push(`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`);
    }

    const sql = `SELECT id, cid, title, description, tags, lang, is_sponsored, clicks FROM records WHERE status = 'active' AND (${whereClauses}) ORDER BY is_sponsored DESC, clicks DESC, id DESC LIMIT 20`;
    const rows = await env.DB.prepare(sql).bind(...binds).all();
    const items = rows.results || [];

    const sponsoredList = items.filter((r) => Number(r.is_sponsored) === 1);
    let organic = items.filter((r) => Number(r.is_sponsored) !== 1);
    const sponsored = sponsoredList[0] || null;
    let debugNote = null;

    if (organic.length === 0 && !sponsored) {
      const prompt = `Kullanıcı şunu arıyor: "${rawQuery}" (dil: ${lang}). Sen IPFS tabanlı bir arama asistanısın. Bu aramaya uygun 2 adet içerik öner. Yanıtını SADECE aşağıdaki JSON dizisi formatında ver, başka hiçbir açıklama yazma: [{"id": 9991, "cid": "QmYapayZekaHash", "title": "Başlık", "description": "Açıklama", "tags": "ai"}]`;

      try {
        const aiContent = await askAI(prompt, env);
        const parsed = parseJsonArray(aiContent);
        if (parsed.length === 0) {
          organic = [];
          debugNote = `AI yanıtı JSON dizisine ayrıstırılamadı: ${String(aiContent).slice(0, 160)}`;
        } else {
          organic = parsed.slice(0, 2).map((item, idx) => ({
            id: item.id || 9991 + idx,
            cid: item.cid || "QmYapayZekaHash",
            title: item.title || rawQuery,
            description: item.description || "AI önerili IPFS içeriği",
            tags: item.tags || "ai,ipfs",
            lang,
            is_sponsored: 0,
            clicks: 0
          }));
        }
      } catch (aiErr) {
        organic = [];
        debugNote = aiErr.message;
      }
    }

    return new Response(
      JSON.stringify({ query: rawQuery, sponsored, organic, v: 4, debug: debugNote }),
      { headers: CORS_HEADERS }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Genel Sunucu Hatası: " + err.message }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

export async function onRequestGet(context) {
  return handleResolve(context.request, context.env, false);
}

export async function onRequestPost(context) {
  return handleResolve(context.request, context.env, true);
}
