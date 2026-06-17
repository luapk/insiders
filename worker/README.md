# kling-proxy Worker

Cloudflare Worker that backs **The Insiders Factory**. It does two jobs:

1. **Proxies the Kling API** (`/v1/videos/*`) so the browser can call it without
   CORS/host issues, forwarding the JWT `Authorization` header.
2. **Hosts generated audio** so Kling can fetch it for lip-sync:
   - `POST /upload-audio` stores the MP3 in R2 and returns `{ url }`
   - `GET /audio/:key` streams it back publicly (this is the route that was
     missing and caused the `Audio upload failed (404)` error).

## One-time setup

```bash
cd worker
npm install -g wrangler            # if not already installed
wrangler login
wrangler r2 bucket create insiders-audio
```

## Deploy

```bash
cd worker
wrangler deploy
```

That publishes to `https://kling-proxy.<your-subdomain>.workers.dev`. Make sure
the app's `PROXY` constant in `index.html` matches the deployed URL (currently
`https://kling-proxy.paulknott.workers.dev`).

## Add the app's origin to the allowlist

Edit `ALLOWED_ORIGINS` in `src/index.js` to include wherever the app is served
from (e.g. your GitHub Pages URL), then redeploy. The `/audio/:key` route is
intentionally public so Kling's servers can fetch the clip.

## Keeping R2 tidy (optional)

Voice clips accumulate. Add a lifecycle rule to auto-delete after a day:

```bash
wrangler r2 bucket lifecycle add insiders-audio \
  --prefix "" --expire-days 1
```

---

## If you already have a working Worker

You chose to *add the route* rather than replace the Worker. If your existing
Worker already proxies `/v1/*` correctly, you only need to bolt on the two audio
routes. Drop this in **before** any host/origin allowlist check (the
`/audio/` route must stay public so Kling can fetch it), and add the
`AUDIO_BUCKET` R2 binding from `wrangler.toml`:

```js
// Serve stored audio — keep this PUBLIC (Kling fetches it). Must run before
// any allowlist/origin gate.
if (url.pathname.startsWith('/audio/')) {
  const key = decodeURIComponent(url.pathname.slice('/audio/'.length));
  const obj = await env.AUDIO_BUCKET.get(key);
  if (!obj) return new Response('Audio not found', { status: 404 });
  return new Response(obj.body, {
    headers: { 'Content-Type': 'audio/mpeg', 'Access-Control-Allow-Origin': '*' },
  });
}

// Store an uploaded MP3 and return its public URL.
if (url.pathname === '/upload-audio' && request.method === 'POST') {
  const form = await request.formData();
  const file = form.get('file');
  const key = `${crypto.randomUUID()}.mp3`;
  await env.AUDIO_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: 'audio/mpeg' },
  });
  return new Response(JSON.stringify({ url: `${url.origin}/audio/${key}` }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
```
