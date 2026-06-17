/**
 * Cloudflare Worker — kling-proxy
 * ----------------------------------------------------------------------------
 * Routes used by The Insiders Factory:
 *
 *   POST /upload-audio    Receives the generated MP3 (multipart "file"),
 *                         stores it in R2, returns { url } pointing at the
 *                         public /audio/:key route below.
 *
 *   GET  /audio/:key      Streams a stored MP3 back. MUST stay public and
 *                         exempt from any host/origin allowlist, because
 *                         Kling's servers fetch this URL to do lip-sync.
 *
 *   *    /v1/videos/*      Transparent proxy to the Kling API, forwarding the
 *                         caller's JWT Authorization header.
 *
 * Requires an R2 bucket bound as AUDIO_BUCKET (see wrangler.toml).
 * ----------------------------------------------------------------------------
 */

const KLING_API = 'https://api.klingai.com';

// Origins allowed to call the browser-facing routes (/upload-audio, /v1/*).
// Add wherever the app is served from. The /audio/:key route ignores this so
// Kling can fetch the audio.
const ALLOWED_ORIGINS = [
  'https://luapk.github.io',
  'http://localhost:8000',
  'http://localhost:3000',
  'http://127.0.0.1:8000',
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const path = url.pathname;

    // ── CORS preflight ──────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    // ── Public audio serving (no allowlist — Kling fetches this) ────────────
    if (path.startsWith('/audio/')) {
      const key = decodeURIComponent(path.slice('/audio/'.length));
      const obj = await env.AUDIO_BUCKET.get(key);
      if (!obj) return new Response('Audio not found', { status: 404 });
      return new Response(obj.body, {
        headers: {
          'Content-Type': obj.httpMetadata?.contentType || 'audio/mpeg',
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // ── Audio upload: store MP3 in R2, return its public URL ─────────────────
    if (path === '/upload-audio' && request.method === 'POST') {
      try {
        const form = await request.formData();
        const file = form.get('file');
        if (!file || typeof file === 'string') {
          return json({ error: 'no file field in form data' }, 400, origin);
        }
        const key = `${crypto.randomUUID()}.mp3`;
        await env.AUDIO_BUCKET.put(key, file.stream(), {
          httpMetadata: { contentType: 'audio/mpeg' },
        });
        return json({ url: `${url.origin}/audio/${key}` }, 200, origin);
      } catch (e) {
        return json({ error: `upload failed: ${e}` }, 500, origin);
      }
    }

    // ── Kling API proxy ─────────────────────────────────────────────────────
    if (path.startsWith('/v1/')) {
      const target = KLING_API + path + url.search;
      const init = {
        method: request.method,
        headers: {
          'Authorization': request.headers.get('Authorization') || '',
          'Content-Type': 'application/json',
        },
      };
      if (!['GET', 'HEAD'].includes(request.method)) {
        init.body = await request.text();
      }
      const upstream = await fetch(target, init);
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
