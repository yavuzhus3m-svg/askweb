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
    let lang = "tr"; // Varsayılan dil

    // Gelen isteği (GET veya POST) analiz et
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
        JSON.stringify({ query: "", sponsored: null, organic: [] }),
        { headers: CORS_HEADERS }
      );
    }

    // 1. ADIM: VERİTABANINDA ARA (Sponsorlu ve kayıtlı içerikler için)
    const terms = rawQuery.toLowerCase().split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 0).slice(0, 5);
    const searchTerms = terms.length > 0 ? terms : [rawQuery];

    const whereClauses = searchTerms.map(() => "(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(tags) LIKE ? OR LOWER(cid) LIKE ?)").join(" OR ");
    const binds = [];
    for (const term of searchTerms) {
      const like = `%${term}%`;
      binds.push(like, like, like, like);
    }

    const sql = `
      SELECT id, cid, title, description, tags, lang, is_sponsored, clicks
      FROM records
      WHERE status = 'active' AND (${whereClauses})
      ORDER BY is_sponsored DESC, clicks DESC, id DESC
      LIMIT 20
    `;

    const rows = await env.DB.prepare(sql).bind(...binds).all();
    const items = rows.results || [];

    const sponsoredList = items.filter((r) => Number(r.is_sponsored) === 1);
    let organic = items.filter((r) => Number(r.is_sponsored) !== 1);
    const sponsored = sponsoredList[0] || null;

    // 2. ADIM: VERİTABANINDA SONUÇ YOKSA YAPAY ZEKAYA SOR (Groq API)
    if (organic.length === 0 && !sponsored) {
      try {
        const groqApiKey = env.GROQ; // Cloudflare'deki gizli anahtarın
        
        if (groqApiKey) {
          const prompt = `Kullanıcı şunu arıyor: "${rawQuery}". 
          Sen AskWeb adında bir yapay zeka arama asistanısın. IPFS üzerinde barındırılan açık kaynak, rehber veya web içerikleri öneriyorsun.
          Lütfen bu aramaya uygun, gerçekçi ve konuyla alakalı 2 adet içerik öner.
          Yanıtını SADECE aşağıdaki gibi geçerli bir JSON dizisi olarak ver, başka hiçbir metin yazma:
          [
            {
              "id": 9991,
              "cid": "QmYapayZekaOrnekHash123",
              "title": "Önerilen İçerik Başlığı",
              "description": "Bu içeriğin kısa ve açıklayıcı bir özeti.",
              "tags": "ai, ipfs, rehber"
            }
          ]`;

          const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${groqApiKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: "llama3-8b-8192", // Hızlı ve ücretsiz model
              messages: [{ role: "user", content: prompt }],
              temperature: 0.3,
              response_format: { type: "json_object" }
            })
          });

          if (groqRes.ok) {
            const groqData = await groqRes.json();
            const aiContent = groqData.choices[0].message.content;
            let parsed = JSON.parse(aiContent);
            
            // Eğer JSON obje olarak dönerse diziye çevir
            if (!Array.isArray(parsed)) {
               parsed = parsed.results || parsed.items || [parsed];
            }
            
            // Yapay zekanın ürettiği sonuçları organik listeye ekle
            organic = parsed.map(item => ({
              ...item,
              is_sponsored: 0,
              clicks: 0
            }));
          }
        }
      } catch (aiErr) {
        console.error("AI Error:", aiErr);
        // Yapay zeka hata verirse sistem çökmesin, boş dönmeye devam etsin.
      }
    }

    // 3. ADIM: SONUÇLARI DÖNDÜR
    return new Response(
      JSON.stringify({ query: rawQuery, sponsored, organic }),
      { headers: CORS_HEADERS }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || "Server error" }),
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
