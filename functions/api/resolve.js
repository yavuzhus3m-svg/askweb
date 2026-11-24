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

    if (isPost) {
      const body = await request.json().catch(() => ({}));
      rawQuery = String(body.query || body.q || "").trim().toLowerCase();
    } else {
      const url = new URL(request.url);
      rawQuery = String(url.searchParams.get("q") || url.searchParams.get("query") || "")
        .trim()
        .toLowerCase();
    }

    if (!rawQuery) {
      return new Response(
        JSON.stringify({ query: "", sponsored: null, organic: [] }),
        { headers: CORS_HEADERS }
      );
    }

    const terms = rawQuery
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .slice(0, 5);

    const searchTerms = terms.length > 0 ? terms : [rawQuery];

    const whereClauses = searchTerms
      .map(
        () =>
          "(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(tags) LIKE ? OR LOWER(cid) LIKE ?)"
      )
      .join(" OR ");

    const binds = [];
    for (const term of searchTerms) {
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

    const rows = await env.DB.prepare(sql).bind(...binds).all();
    const items = rows.results || [];

    const sponsoredList = items.filter((r) => Number(r.is_sponsored) === 1);
    const organic = items.filter((r) => Number(r.is_sponsored) !== 1);
    const sponsored = sponsoredList[0] || null;

    return new Response(
      JSON.stringify({ query: rawQuery, sponsored, organic }),
      { headers: CORS_HEADERS }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || "DB error" }),
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
