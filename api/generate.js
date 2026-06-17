import { experimental_generateVideo as generateVideo } from 'ai';
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

  const { prompt, imageBase64, format, background = 'studio' } = req.body || {};

  if (!process.env.AI_GATEWAY_API_KEY) {
    return res.status(500).json({
      error: 'AI_GATEWAY_API_KEY is not set. Add it to your Vercel project environment variables.',
    });
  }
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const bgPrompt = BACKGROUNDS[background] || BACKGROUNDS.studio;
  const fullPrompt = `${prompt} Background: ${bgPrompt}.`;

  const aspectRatio = format === '9:16' ? '9:16' : format === '1:1' ? '1:1' : '16:9';

  try {
    const promptPayload = imageBase64
      ? { image: `data:image/jpeg;base64,${imageBase64}`, text: fullPrompt }
      : fullPrompt;

    const result = await generateVideo({
      model: 'google/veo-3.1-generate-001',
      prompt: promptPayload,
      duration: 5,
      aspectRatio,
      providerOptions: {
        google: { generateAudio: false },
        vertex: { generateAudio: false },
      },
    });

    const videoBytes = result.videos[0].uint8Array;

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
