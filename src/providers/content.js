'use strict';
/**
 * Multimodal content parts (v2.1.0).
 *
 * A message `content` is either a plain string (the common case) or an array of
 * parts so screenshots can actually reach the model instead of being described
 * in prose:
 *
 *   TextPart  { type: 'text',  text: string }
 *   ImagePart { type: 'image', mime: 'image/png', data: '<base64 without prefix>' }
 *
 * Every provider adapter translates this neutral shape into its own wire format
 * (OpenAI image_url / Responses input_image / Anthropic source.base64 / Ollama images[]).
 */

const DATA_URL_RE = /^data:([a-zA-Z0-9.+/-]+);base64,(.*)$/s;

function textPart(text) { return { type: 'text', text: String(text == null ? '' : text) }; }

/** Accepts a data: URL or raw base64 (+ mime). */
function imagePart(input, mime) {
  if (input && typeof input === 'object' && input.type === 'image') return input;
  const s = String(input || '');
  const m = DATA_URL_RE.exec(s);
  if (m) return { type: 'image', mime: m[1], data: m[2] };
  return { type: 'image', mime: mime || 'image/png', data: s.replace(/^data:[^,]*,/, '') };
}

function isMultipart(content) {
  return Array.isArray(content) && content.some(p => p && p.type === 'image');
}

/** Normalise any content value into an array of parts. */
function partsOf(content) {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [textPart(content)] : [];
  if (Array.isArray(content)) {
    return content.map(p => {
      if (typeof p === 'string') return textPart(p);
      if (p && p.type === 'image') return imagePart(p.data ? p : p.image_url || p.url, p.mime);
      if (p && p.type === 'text') return textPart(p.text);
      return textPart(JSON.stringify(p));
    }).filter(p => p.type === 'image' || p.text !== '');
  }
  return [textPart(String(content))];
}

/** Flatten to plain text (images become a short placeholder) — used for logs/DB. */
function plainText(content) {
  if (typeof content === 'string') return content;
  return partsOf(content).map(p => (p.type === 'image' ? `[图片 ${p.mime} ${Math.round((p.data || '').length * 0.75 / 1024)}KB]` : p.text)).join('\n');
}

function dataUrl(part) { return `data:${part.mime};base64,${part.data}`; }

function countImages(content) { return partsOf(content).filter(p => p.type === 'image').length; }

module.exports = { textPart, imagePart, isMultipart, partsOf, plainText, dataUrl, countImages };
