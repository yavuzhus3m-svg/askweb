const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8"
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// YAPAY ZEKA SORGU FONKSİYONU (Önce HuggingFace, sonra diğerleri)
async function askAI(prompt, env) {
  const errors = [];

  // 1. HUGGING FACE (İlk sıraya alındı)
  if (env.HUGGINGFACE) {
    try {
      // Mistral modeli JSON üretiminde oldukça başarılıdır
      const res = await fetch("https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.HUGGINGFACE}`, "Content-Type": "application/json" },
        body: JSON.stringify({ 
          inputs: prompt, 
          parameters: { return_full_text: false, max_new_tokens: 500 } 
        })
      });
      
      if (res.ok) {
        const data = await res.json();
        let text = Array.isArray(data) ? data[0].generated_text : data.generated_text;
        // Model bazen JSON dışında metinler üretebilir, sadece JSON kısmını çıkarmaya çalışalım
        return text.replace(/```json/g, "").replace(/```/g, "").trim();
      } else {
        errors.push(`HuggingFace: ${res.status}`);
      }
    } catch (e) { 
      errors.push(`HuggingFace: ${e.message}`); 
    }
  }

  // 2. GEMINI (Google)
  if (env.GEMINI) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
        })
      });
      if (res.ok) {
        const data = await res.json();
        let text = data.candidates[0].content.parts[0].text;
        return text.replace(/```json/g, "").replace(/```/g, "").trim();
      } else {
        errors.push(`Gemini: ${res.status}`);
      }
    } catch (e) { 
      errors.push(`Gemini: ${e.message}`); 
    }
  }

  // 3. GROQ (Llama 3)
  if (env.GROQ) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.GROQ}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile", // Groq'un güncel modeli
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          response_format: { type: "json_object" }
        })
      });
      if (res.ok) {
        const data = await res.json();
        return data.choices[0].message.content;
      } else {
        errors.push(`Groq: ${res.status}`);
      }
    } catch (e) { 
      errors.push(`Groq: ${e.message}`); 
    }
  }

  // 4. OPENROUTER
  if (env.OPENR) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.OPENR}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "meta-llama/llama-3-8b-instruct:free",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2
        })
      });
      if (res.ok) {
        const data = await res.json();
        return data.choices[0].message.content;
      } else {
        errors.push(`OpenRouter: ${res.status}`);
      }
    } catch (e) { 
      errors.push(`OpenRouter: ${e.message}`); 
    }
  }

  // Eğer hepsi başarısız olursa hatayı fırlat
  throw new Error(`Tüm yapay zeka servisleri başarısız oldu. [${errors.join(", ")}]`);
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

    // 1. VERİTABANI ARAMASI (D1)
    const terms = rawQuery.toLowerCase().split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 0).slice(0, 5);
    const searchTerms = terms.length > 0 ? terms : [rawQuery];
    const whereClauses = searchTerms.map(() => "(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(tags) LIKE ? OR LOWER(cid) LIKE ?)").join(" OR ");
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

    // 2. YAPAY ZEKA ARAMASI (Eğer veritabanında bulunamadıysa)
    if (organic.length === 0 && !sponsored) {
      const prompt = `Kullanıcı şunu arıyor: "${rawQuery}". Sen IPFS tabanlı bir arama asistanısın. Bu aramaya uygun 2 adet içerik öner. Yanıtını SADECE aşağıdaki JSON formatında ver, başka hiçbir açıklama yazma: [{"id": 9991, "cid": "QmYapayZekaHash", "title": "Başlık", "description": "Açıklama", "tags": "ai"}]`;
      
      try {
        // Sırayla API'leri deneyen fonksiyonu çağır
        const aiContent = await askAI(prompt, env);
        
        // Gelen metni JSON'a çevir
        let parsed = JSON.parse(aiContent);
        if (!Array.isArray(parsed)) {
          parsed = parsed.results || parsed.items || [parsed];
        }
        
        organic = parsed.map(item => ({ ...item, is_sponsored: 0, clicks: 0 }));
      } catch (aiErr) {
        // Eğer 4 API de patlarsa hatayı ekrana bas
        return new Response(
            JSON.stringify({ error: `Sistem Detayı -> ${aiErr.message}`, organic: [], sponsored: null }),
            { status: 500, headers: CORS_HEADERS }
        );
      }
    }

    // 3. SONUÇLARI DÖNDÜR
    return new Response(JSON.stringify({ query: rawQuery, sponsored, organic }), { headers: CORS_HEADERS });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Genel Sunucu Hatası: " + err.message }), { status: 500, headers: CORS_HEADERS });
  }
}

export async function onRequestGet(context) { return handleResolve(context.request, context.env, false); }
export async function onRequestPost(context) { return handleResolve(context.request, context.env, true); }
