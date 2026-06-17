import { GoogleGenAI } from '@google/genai';
import { put } from '@vercel/blob';

export const config = { maxDuration: 300 };

const BACKGROUNDS = {
  studio:      'soft neutral light grey studio background, clean professional lighting',
  greenscreen: 'flat chroma-key green (#00B400) background, perfectly even lighting, no shadows, compositing-ready',
  micro:       'blurred gut microbiome bacteria photographed under electron microscope in the background, warm amber and rust tones, extreme macro bokeh, soft out-of-focus depth-of-field',
  '3d':        'stylised 3D-rendered gut microbiome environment in the background, colourful bacteria cells and rods, vibrant science-visualisation backdrop, soft bokeh depth-of-field',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY is not set. Add it to your Vercel project environment variables.',
    });
  }

  const { prompt, imageBase64, format, background = 'studio' } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const bgPrompt = BACKGROUNDS[background] || BACKGROUNDS.studio;
  const fullPrompt = `${prompt} Background: ${bgPrompt}.`;
  // Veo on the Gemini API only supports 16:9 and 9:16 — clamp 1:1 (and anything
  // else) to the nearest valid ratio rather than letting the API reject it.
  const aspectRatio = format === '9:16' ? '9:16' : '16:9';

  try {
    const ai = new GoogleGenAI({ apiKey });

    // Kick off the long-running video generation. image-to-video when we have a
    // starting frame, text-to-video otherwise.
    let operation = await ai.models.generateVideos({
      model: 'veo-3.1-generate-preview',
      prompt: fullPrompt,
      ...(imageBase64 ? { image: { imageBytes: imageBase64, mimeType: 'image/jpeg' } } : {}),
      config: {
        aspectRatio,
        durationSeconds: 8,          // Veo 3.1 accepts 4, 6 or 8 only
        resolution: '720p',
        numberOfVideos: 1,
        // Note: the Gemini API always generates native audio for Veo 3.1 and
        // rejects a generateAudio toggle. Harmless here — the clip plays muted
        // with the ElevenLabs voiceover over the top.
      },
    });

    // Poll until done. Veo typically finishes in 1–3 min; the function caps at 300s.
    const started = Date.now();
    while (!operation.done) {
      if (Date.now() - started > 270000) throw new Error('Veo generation timed out');
      await new Promise(r => setTimeout(r, 10000));
      operation = await ai.operations.get({ operation });
    }

    if (operation.error) {
      throw new Error(operation.error.message || 'Veo generation failed');
    }

    const generated = operation.response?.generatedVideos?.[0];
    let uri = generated?.video?.uri;
    if (!uri) throw new Error('Veo returned no video URI');

    // Download the rendered MP4 bytes (the file endpoint needs the API key).
    if (!uri.includes('alt=media')) uri += (uri.includes('?') ? '&' : '?') + 'alt=media';
    const dl = await fetch(uri, { headers: { 'x-goog-api-key': apiKey } });
    if (!dl.ok) throw new Error(`Video download failed (${dl.status})`);
    const videoBytes = Buffer.from(await dl.arrayBuffer());

    const blob = await put(`insiders-${Date.now()}.mp4`, videoBytes, {
      access: 'public',
      contentType: 'video/mp4',
      addRandomSuffix: true,
    });

    return res.status(200).json({ url: blob.url });
  } catch (e) {
    console.error('Video generation failed:', e);
    return res.status(500).json({ error: e.message || 'Video generation failed' });
  }
}
