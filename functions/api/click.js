export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json; charset=utf-8"
  };

  try {
    const body = await request.json();
    const id = Number(body.id);

    if (!Number.isInteger(id) || id <= 0) {
      return new Response(JSON.stringify({ ok: false, error: "Invalid record id" }), {
        status: 400,
        headers: corsHeaders
      });
    }

    await env.DB.prepare(
      `UPDATE records SET clicks = clicks + 1 WHERE id = ?`
    ).bind(id).run();

    return new Response(JSON.stringify({ ok: true, id }), {
      headers: corsHeaders
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message || "Click error" }), {
      status: 500,
      headers: corsHeaders
    });
  }
}
