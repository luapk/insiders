import { GoogleGenAI } from '@google/genai';
import { put } from '@vercel/blob';

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY is not set. Add it to your Vercel project environment variables.',
    });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({
      error: 'BLOB_READ_WRITE_TOKEN is not set. Add it to your Vercel project environment variables.',
    });
  }

  // Client sends a fully compiled Veo 3.1 prompt plus the character art as an ASSET
  // reference image. This is NOT a first frame — Veo 3.1's `referenceImages` field with
  // referenceType 'asset' feeds the character in as an ingredient the model composites
  // into a freshly generated scene, preserving its look without freezing the opening frame.
  const { prompt, format, model, imageBase64, imageMimeType } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  // Map the client's mode toggle to a Veo model id. Quality honours kinetic camera
  // direction far better; Fast is quicker and cheaper. Default to Fast.
  const MODEL_IDS = {
    fast:    'veo-3.1-fast-generate-preview',
    quality: 'veo-3.1-generate-preview',
  };
  const modelId = MODEL_IDS[model] || MODEL_IDS.fast;

  const aspectRatio = format === '9:16' ? '9:16' : '16:9';

  const genConfig = {
    aspectRatio,
    durationSeconds: 8,
    resolution: '720p',
    numberOfVideos: 1,
  };
  if (imageBase64) {
    genConfig.referenceImages = [{
      image: { imageBytes: imageBase64, mimeType: imageMimeType || 'image/png' },
      referenceType: 'asset',
    }];
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    let operation = await ai.models.generateVideos({
      model: modelId,
      prompt,
      config: genConfig,
    });

    const started = Date.now();
    while (!operation.done) {
      if (Date.now() - started > 270000) throw new Error('Veo generation timed out');
      await new Promise(r => setTimeout(r, 10000));
      operation = await ai.operations.get({ operation });
    }

    if (operation.error) throw new Error(operation.error.message || 'Veo generation failed');

    const generated = operation.response?.generatedVideos?.[0];

    // Veo silently returns a blank video (no URI) when its safety filter fires.
    if (generated?.raiFilteredReason) {
      throw new Error(`Veo safety filter triggered: ${generated.raiFilteredReason}. Try a different prompt or action.`);
    }

    let uri = generated?.video?.uri;
    if (!uri) throw new Error('Veo returned no video URI');

    // Sanity-check: a valid 8-second MP4 is at minimum several hundred KB.
    // If the download is tiny it almost certainly came back blank.
    const MIN_BYTES = 50_000;

    if (!uri.includes('alt=media')) uri += (uri.includes('?') ? '&' : '?') + 'alt=media';
    const dl = await fetch(uri, { headers: { 'x-goog-api-key': apiKey } });
    if (!dl.ok) throw new Error(`Video download failed (${dl.status})`);

    const videoBytes = Buffer.from(await dl.arrayBuffer());
    if (videoBytes.length < MIN_BYTES) {
      throw new Error(`Veo returned a blank video (${videoBytes.length} bytes) — likely a safety filter. Try adjusting the prompt.`);
    }

    // Upload to Vercel Blob for persistent storage — survives tab refresh,
    // allows direct-link sharing, and keeps the browser memory footprint low.
    const filename = `insiders_${Date.now()}.mp4`;
    const { url } = await put(filename, videoBytes, {
      access: 'public',
      contentType: 'video/mp4',
    });

    return res.status(200).json({ url });

  } catch (e) {
    console.error('Video generation failed:', e);
    return res.status(500).json({ error: e.message || 'Video generation failed' });
  }
}
