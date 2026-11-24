export async function onRequestGet(context) {
  const { request, env } = context;
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json; charset=utf-8"
  };

  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();

    if (!q) {
      return new Response(JSON.stringify({ query: "", sponsored: [], results: [] }), {
        headers: corsHeaders
      });
    }

    const like = `%${q}%`;
    const rows = await env.DB.prepare(
      `SELECT id, cid, title, description, tags, lang, is_sponsored, clicks
       FROM records
       WHERE status = 'active'
         AND (LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(tags) LIKE ? OR LOWER(cid) LIKE ?)
       ORDER BY is_sponsored DESC, clicks DESC, id DESC
       LIMIT 20`
    ).bind(like, like, like, like).all();

    const items = rows.results || [];
    const sponsored = items.filter((r) => Number(r.is_sponsored) === 1);
    const results = items.filter((r) => Number(r.is_sponsored) !== 1);

    return new Response(JSON.stringify({ query: q, sponsored, results }), {
      headers: corsHeaders
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || "DB error" }), {
      status: 500,
      headers: corsHeaders
    });
  }
}
