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

    // 2. YAPAY ZEKA ARAMASI
    let aiError = null;
    if (organic.length === 0 && !sponsored) {
      try {
        // Artık sadece GROQ arıyoruz
        const groqApiKey = env.GROQ; 
        
        // Eğer anahtar yoksa VEYA anahtar çok kısaysa hata ver
        if (!groqApiKey || groqApiKey.length < 10) {
            throw new Error("GROQ anahtarı sistemde var ama içi boş veya hatalı! Lütfen Cloudflare'den değeri kontrol edin.");
        }

        const prompt = `Kullanıcı şunu arıyor: "${rawQuery}". Sen IPFS tabanlı bir arama asistanısın. Bu aramaya uygun 2 adet içerik öner. Yanıtını SADECE şu JSON formatında ver: [{"id": 9991, "cid": "QmYapayZekaHash", "title": "Başlık", "description": "Açıklama", "tags": "ai"}]`;

        const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${groqApiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "llama3-8b-8192",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.2,
            response_format: { type: "json_object" }
          })
        });

        if (!groqRes.ok) {
            const errorText = await groqRes.text();
            throw new Error(`Groq HTTP Hatası: ${groqRes.status} - ${errorText}`);
        }

        const groqData = await groqRes.json();
        const aiContent = groqData.choices[0].message.content;
        let parsed = JSON.parse(aiContent);
        if (!Array.isArray(parsed)) parsed = parsed.results || parsed.items || [parsed];
        
        organic = parsed.map(item => ({ ...item, is_sponsored: 0, clicks: 0 }));

      } catch (aiErr) {
        aiError = "AI Error: " + aiErr.message;
      }
    }

    if (dbError || aiError) {
       return new Response(
            JSON.stringify({ error: `Sistem Detayı -> ${dbError || ''} ${aiError || ''}`.trim(), organic: [], sponsored: null }),
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
