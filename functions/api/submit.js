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
    const cid = String(body.cid || "").trim();
    const title = String(body.title || "").trim();
    const description = String(body.description || "").trim();
    const tags = String(body.tags || "").trim();
    const plan = String(body.plan || "listing").trim();
    const contact = String(body.contact || "").trim();

    if (!cid || !title || !description) {
      return new Response(
        JSON.stringify({ ok: false, error: "CID, title and description are required" }),
        { status: 400, headers: corsHeaders }
      );
    }

    await env.DB.prepare(
      `INSERT INTO submissions (cid, title, description, tags, plan, contact, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`
    ).bind(cid, title, description, tags, plan, contact).run();

    return new Response(JSON.stringify({ ok: true, status: "pending" }), {
      status: 201,
      headers: corsHeaders
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message || "Submit error" }), {
      status: 500,
      headers: corsHeaders
    });
  }
}
