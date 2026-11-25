const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8"
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
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
      return new Response(JSON.stringify({ query: "", sponsored: null, organic: [] }), { headers: CORS_HEADERS });
    }

    let dbError = null;
    let dbResults = [];

    // 1. VERİTABANI ARAMASI
    try {
      const terms = rawQuery.toLowerCase().split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 0).slice(0, 5);
      const searchTerms = terms.length > 0 ? terms : [rawQuery];
      const whereClauses = searchTerms.map(() => "(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(tags) LIKE ? OR LOWER(cid) LIKE ?)").join(" OR ");
      const binds = [];
      for (const term of searchTerms) {
        binds.push(`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`);
      }

      const sql = `SELECT id, cid, title, description, tags, lang, is_sponsored, clicks FROM records WHERE status = 'active' AND (${whereClauses}) ORDER BY is_sponsored DESC, clicks DESC, id DESC LIMIT 20`;
      
      if (env.DB) {
        const rows = await env.DB.prepare(sql).bind(...binds).all();
        dbResults = rows.results || [];
      } else {
        dbError = "D1 Database (DB) binding is missing!";
      }
    } catch (dbErr) {
      dbError = "DB Error: " + dbErr.message;
      dbResults = [];
    }

    const sponsoredList = dbResults.filter((r) => Number(r.is_sponsored) === 1);
    let organic = dbResults.filter((r) => Number(r.is_sponsored) !== 1);
    const sponsored = sponsoredList[0] || null;

    // 2. YAPAY ZEKA ARAMASI (FALLBACK SİSTEMİ)
    let aiErrors = [];
    
    if (organic.length === 0 && !sponsored) {
      const prompt = `Kullanıcı şunu arıyor: "${rawQuery}". Sen IPFS tabanlı bir arama asistanısın. Bu aramaya uygun 2 adet içerik öner. Yanıtını SADECE şu JSON formatında ver: [{"id": 9991, "cid": "QmYapayZekaHash", "title": "Başlık", "description": "Açıklama", "tags": "ai"}]`;

      // --- DENEME 1: GROQ ---
      if (env.GROQ && organic.length === 0) {
        try {
          const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${env.GROQ}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "llama3-70b-8192", // Groq'un en güçlü stabil modeli
              messages: [{ role: "user", content: prompt }],
              temperature: 0.2,
              response_format: { type: "json_object" }
            })
          });
          if (groqRes.ok) {
            const data = await groqRes.json();
            let parsed = JSON.parse(data.choices[0].message.content);
            if (!Array.isArray(parsed)) parsed = parsed.results || [parsed];
            organic = parsed.map(item => ({ ...item, is_sponsored: 0, clicks: 0 }));
          } else {
            aiErrors.push(`Groq: ${groqRes.status}`);
          }
        } catch (e) { aiErrors.push("Groq: " + e.message); }
      }

      // --- DENEME 2: GEMINI (Eğer Groq başarısız olduysa) ---
      if (env.GEMINI && organic.length === 0) {
        try {
          const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
            })
          });
          if (geminiRes.ok) {
            const data = await geminiRes.json();
            let text = data.candidates[0].content.parts[0].text;
            text = text.replace(/```json/g, "").replace(/```/g, "").trim();
            let parsed = JSON.parse(text);
            if (!Array.isArray(parsed)) parsed = parsed.results || [parsed];
            organic = parsed.map(item => ({ ...item, is_sponsored: 0, clicks: 0 }));
          } else {
            aiErrors.push(`Gemini: ${geminiRes.status}`);
          }
        } catch (e) { aiErrors.push("Gemini: " + e.message); }
      }

      // --- DENEME 3: OPENROUTER (Eğer Groq ve Gemini başarısız olduysa) ---
      if (env.OPENR && organic.length === 0) {
        try {
          const openrRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: { 
              "Authorization": `Bearer ${env.OPENR}`, 
              "Content-Type": "application/json",
              "HTTP-Referer": "https://askweb.dpdns.org", // OpenRouter için gerekli
              "X-Title": "AskWeb"
            },
            body: JSON.stringify({
              model: "meta-llama/llama-3-8b-instruct", // Ücretsiz ve hızlı bir model
              messages: [{ role: "user", content: prompt }]
            })
          });
          if (openrRes.ok) {
            const data = await openrRes.json();
            let text = data.choices[0].message.content;
            text = text.replace(/```json/g, "").replace(/```/g, "").trim();
            let parsed = JSON.parse(text);
            if (!Array.isArray(parsed)) parsed = parsed.results || [parsed];
            organic = parsed.map(item => ({ ...item, is_sponsored: 0, clicks: 0 }));
          } else {
            aiErrors.push(`OpenRouter: ${openrRes.status}`);
          }
        } catch (e) { aiErrors.push("OpenRouter: " + e.message); }
      }
    }

    if (dbError && organic.length === 0) {
       return new Response(
            JSON.stringify({ error: `Sistem Detayı -> ${dbError} | AI Hataları: ${aiErrors.join(", ")}`, organic: [], sponsored: null }),
            { status: 500, headers: CORS_HEADERS }
       );
    }

    return new Response(JSON.stringify({ query: rawQuery, sponsored, organic }), { headers: CORS_HEADERS });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Genel Sunucu Hatası: " + err.message }), { status: 500, headers: CORS_HEADERS });
  }
}

export async function onRequestGet(context) { return handleResolve(context.request, context.env, false); }
export async function onRequestPost(context) { return handleResolve(context.request, context.env, true); }
