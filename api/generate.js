import { GoogleGenAI } from '@google/genai';

export const config = { maxDuration: 300 };

const BACKGROUNDS = {
  studio:      'background is a soft neutral light-grey studio void with clean diffused professional lighting and a subtle vignette',
  greenscreen: 'background is a perfectly flat chroma-key green (#00B400), evenly lit with no shadows, gradients, or reflections — compositing-ready',
  micro:       'background is a richly textured warm amber and rust bokeh field — glowing gut-microbiome bacteria and filaments photographed under an electron microscope, beautifully out-of-focus with extreme depth-of-field. The background glows with warm golden-amber light and fills the entire frame behind the character',
  '3d':        'background is a vibrant stylised 3D-rendered gut microbiome world — colourful glowing bacteria cells and rods, luminous science-visualisation colours of cyan, magenta, and gold, all beautifully soft and out-of-focus behind the character, filling the entire frame with depth',
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
  const fullPrompt = `Environment: ${bgPrompt}. ${prompt}`;
  const aspectRatio = format === '9:16' ? '9:16' : '16:9';

  try {
    const ai = new GoogleGenAI({ apiKey });

    let operation = await ai.models.generateVideos({
      model: 'veo-3.1-fast-generate-preview',
      prompt: fullPrompt,
      ...(imageBase64 ? { image: { imageBytes: imageBase64, mimeType: 'image/jpeg' } } : {}),
      config: {
        aspectRatio,
        durationSeconds: 8,
        resolution: '720p',
        numberOfVideos: 1,
      },
    });

    const started = Date.now();
    while (!operation.done) {
      if (Date.now() - started > 270000) throw new Error('Veo generation timed out');
      await new Promise(r => setTimeout(r, 10000));
      operation = await ai.operations.get({ operation });
    }

    if (operation.error) throw new Error(operation.error.message || 'Veo generation failed');

    const generated = operation.response?.generatedVideos?.[0];
    let uri = generated?.video?.uri;
    if (!uri) throw new Error('Veo returned no video URI');

    // Download MP4 bytes and stream them directly to the client.
    // No external storage needed — browser creates a local object URL.
    if (!uri.includes('alt=media')) uri += (uri.includes('?') ? '&' : '?') + 'alt=media';
    const dl = await fetch(uri, { headers: { 'x-goog-api-key': apiKey } });
    if (!dl.ok) throw new Error(`Video download failed (${dl.status})`);

    const videoBytes = Buffer.from(await dl.arrayBuffer());
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', videoBytes.length);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).end(videoBytes);

  } catch (e) {
    console.error('Video generation failed:', e);
    return res.status(500).json({ error: e.message || 'Video generation failed' });
  }
}
