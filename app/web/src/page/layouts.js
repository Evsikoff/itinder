import * as THREE from 'three';
import { SIGN } from '../config.js';
import { assetUrl } from './scheme.js';
import { BRAND_FONT as FONT, loadBrandFonts as loadFonts } from './fonts.js';

// Компоновки содержимого (поле Layout). Каждая рисует плоский контейнер и
// возвращает его текстуру и пропорции; объект (табличка и т. п.) строится вокруг.
// Стиль style — обычный или неоновый (##RRGGBB в background_hex): у неона фон
// того же цвета, но почти погасший, а текст и картинки светятся этим цветом.

const MAX_SIDE = 2048;

function loadImageFrom(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

// Картинка элемента. Если файла с указанным расширением нет, пробуются другие
// (в схеме бывает .jpg, а файл лежит как .png) — с предупреждением в консоли.
const EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
async function loadImage(element) {
  const url = assetUrl(element.image);
  try {
    return await loadImageFrom(url);
  } catch {
    const base = url.replace(/\.[a-z0-9]+$/i, '');
    for (const extension of EXTENSIONS) {
      const candidate = base + extension;
      if (candidate === url) continue;
      try {
        const image = await loadImageFrom(candidate);
        console.warn(`Элемент ${element.id}: файла ${element.image} нет, взят ${new URL(candidate).pathname}. Поправьте путь в itinder_ui_scheme.`);
        return image;
      } catch {
        // пробуем следующее расширение
      }
    }
    throw new Error(`Элемент ${element.id}: не удалось загрузить картинку ${element.image}`);
  }
}

const NEON = {
  dim: 0.1,                  // яркость фона от цвета неона
  blur: [0.6, 0.3, 0.12],    // ореол текста в долях кегля, от широкого к узкому
  imageBlur: 0.04,           // ореол картинки в долях её большей стороны
};

function scaleHex(hex, k) {
  const value = parseInt(hex.slice(1).replace(/^(.)(.)(.)$/, '$1$1$2$2$3$3'), 16);
  const channel = (shift) => Math.round(((value >> shift) & 255) * k).toString(16).padStart(2, '0');
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

function styleOf(element, neon) {
  if (!neon) return { background: element.background_hex, glow: null };
  return { background: scaleHex(element.background_hex, NEON.dim), glow: element.background_hex };
}

// glow — цвет свечения неоновой таблички (null у обычной).
function toTexture(canvas, style) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return { texture, aspect: canvas.width / canvas.height, background: style.background, glow: style.glow };
}

function fillBackground(ctx, style) {
  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

// Картинка; у неона — со свечением по контуру непрозрачных пикселей.
function drawImage(ctx, image, x, y, w, h, style) {
  if (style.glow) {
    ctx.save();
    ctx.shadowColor = style.glow;
    ctx.shadowBlur = Math.max(w, h) * NEON.imageBlur;
    ctx.drawImage(image, x, y, w, h);
    ctx.restore();
  }
  ctx.drawImage(image, x, y, w, h);
}

// Контейнер с пропорциями картинки: картинка во весь объект поверх цвета фона.
async function fullObjectImage(element, width, style) {
  const image = await loadImage(element);
  const scale = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  const ctx = canvas.getContext('2d');
  fillBackground(ctx, style);
  drawImage(ctx, image, 0, 0, canvas.width, canvas.height, style);
  return toTexture(canvas, style);
}

// Размеры — доли ширины холста, поэтому текст масштабируется вместе с объектом.
const WIDTH = 2048;
const PADDING = 0.05;
const GAP = 0.03;
const TITLE = { size: 0.062, weight: 600, lineHeight: 1.15, minScale: 0.8 };
const TEXT = { size: 0.04, weight: 400, lineHeight: 1.45, minScale: 1 };

function wrap(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

// Набор строк: если чуть уменьшенный шрифт даёт меньше строк (заголовок не
// переносится из-за одного слова), берётся он, но не меньше minScale. Слово,
// которое не влезает и так, ужимает шрифт до ширины, чтобы не обрезаться.
function setBlock(ctx, text, style, maxWidth, canvasWidth = WIDTH) {
  let best = null;
  for (let scale = 1; scale >= style.minScale - 1e-6; scale -= 0.02) {
    const size = Math.round(style.size * canvasWidth * scale);
    ctx.font = `${style.weight} ${size}px "${FONT}"`;
    const lines = wrap(ctx, text, maxWidth);
    if (!best || lines.length < best.lines.length) best = { size, lines };
    if (lines.length === 1) break;
  }
  ctx.font = `${style.weight} ${best.size}px "${FONT}"`;
  const widest = Math.max(...best.lines.map((line) => ctx.measureText(line).width));
  if (widest > maxWidth) best.size = Math.floor((best.size * maxWidth) / widest);
  return { ...best, style, height: best.lines.length * best.size * style.lineHeight };
}

// Заголовок и текст под ним на цвете фона, выключка влево, как в брендбуке.
// Размеры заданы для таблички во всю строку. Табличка шире строки (так её
// растягивает Layout страницы) растягивается вширь: шрифт и поля те же.
const MAX_CANVAS = 4096;
async function titleAndText(element, width = SIGN.width, style) {
  await loadFonts();
  const stretch = Math.max(1, width / SIGN.width);
  const unit = Math.min(WIDTH, Math.floor(MAX_CANVAS / stretch));
  const pad = Math.round(PADDING * unit);
  const gap = Math.round(GAP * unit);
  const maxWidth = Math.round(unit * stretch) - 2 * pad;
  const measure = document.createElement('canvas').getContext('2d');
  const blocks = [];
  if (element.title) blocks.push({ ...setBlock(measure, element.title, TITLE, maxWidth, unit), color: element.title_color });
  if (element.text) blocks.push({ ...setBlock(measure, element.text, TEXT, maxWidth, unit), color: element.text_color });

  const contentHeight = blocks.reduce((sum, block) => sum + block.height, 0) + gap * Math.max(0, blocks.length - 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(unit * stretch);
  canvas.height = Math.round(contentHeight + 2 * pad);
  const ctx = canvas.getContext('2d');
  fillBackground(ctx, style);

  let y = pad;
  for (const block of blocks) {
    drawText(ctx, block, pad, y, style);
    y += block.height + gap;
  }
  return toTexture(canvas, style);
}

// Текст; у неона под ним несколько проходов ореола цвета неона.
function drawText(ctx, block, x, top, style) {
  ctx.font = `${block.style.weight} ${block.size}px "${FONT}"`;
  ctx.textBaseline = 'middle';
  const line = block.size * block.style.lineHeight;
  const draw = () => block.lines.forEach((text, i) => ctx.fillText(text, x, top + (i + 0.5) * line));
  if (style.glow) {
    ctx.save();
    ctx.fillStyle = style.glow;
    ctx.shadowColor = style.glow;
    for (const blur of NEON.blur) {
      ctx.shadowBlur = block.size * blur;
      draw();
    }
    ctx.restore();
  }
  ctx.fillStyle = block.color;
  draw();
}

// Кнопка: квадратная иконка слева, заголовок справа по центру высоты.
// Размеры заданы для кнопки в половину строки. Кнопка шире (одна в строке)
// растягивается вширь, а не ввысь: иконка и заголовок те же, но по центру.
const HALF_ROW = (SIGN.width - SIGN.rowGap) / 2;
const BUTTON = {
  width: 1024,
  padding: 0.07,
  gap: 0.06,
  icon: 0.3,
  header: { size: 0.1, weight: 600, lineHeight: 1.15, minScale: 0.8 },
};
async function headerAndIcon(element, width = HALF_ROW, style) {
  const [image] = await Promise.all([element.image ? loadImage(element) : null, loadFonts()]);
  const unit = BUTTON.width;
  const W = Math.round(unit * Math.max(1, width / HALF_ROW));
  const pad = Math.round(BUTTON.padding * unit);
  const gap = Math.round(BUTTON.gap * unit);
  const icon = image ? Math.round(BUTTON.icon * unit) : 0;
  const iconSpace = icon ? icon + gap : 0;
  const measure = document.createElement('canvas').getContext('2d');
  const header = { ...setBlock(measure, element.title ?? '', BUTTON.header, W - 2 * pad - iconSpace, unit), color: element.title_color };
  measure.font = `${BUTTON.header.weight} ${header.size}px "${FONT}"`;
  const textWidth = Math.max(...header.lines.map((line) => measure.measureText(line).width));
  const left = W > unit ? Math.max(pad, (W - iconSpace - textWidth) / 2) : pad;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = Math.round(Math.max(icon, header.height) + 2 * pad);
  const ctx = canvas.getContext('2d');
  fillBackground(ctx, style);
  if (image) {
    // Иконка вписывается в квадрат с сохранением пропорций.
    const k = Math.min(icon / image.naturalWidth, icon / image.naturalHeight);
    const w = image.naturalWidth * k;
    const h = image.naturalHeight * k;
    drawImage(ctx, image, left + (icon - w) / 2, (canvas.height - h) / 2, w, h, style);
  }
  drawText(ctx, header, left + iconSpace, (canvas.height - header.height) / 2, style);
  return toTexture(canvas, style);
}

// Только заголовок на цвете фона — подпись над полем ввода и т. п.
const headlineOnly = (element, width, style) => titleAndText({ ...element, text: null }, width, style);

// Портретная карточка: крупная картинка во всю ширину, под ней подпись слева.
// Место под картинку не ниже minImage ширины: с квадратной или альбомной
// картинкой карточка тоже остаётся вертикальной, картинка — по центру места.
const PORTRAIT = {
  width: 1024,
  minImage: 4 / 3,
  padding: 0.07,
  caption: { size: 0.12, weight: 600, lineHeight: 1.15, minScale: 0.8 },
};
async function portraitImage(element, width, style) {
  const [image] = await Promise.all([element.image ? loadImage(element) : null, loadFonts()]);
  const W = PORTRAIT.width;
  const pad = Math.round(PORTRAIT.padding * W);
  const area = Math.round(W * Math.max(image ? image.naturalHeight / image.naturalWidth : 0, PORTRAIT.minImage));
  const measure = document.createElement('canvas').getContext('2d');
  const caption = element.title ? { ...setBlock(measure, element.title, PORTRAIT.caption, W - 2 * pad, W), color: element.title_color } : null;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = area + (caption ? Math.round(caption.height + 2 * pad) : 0);
  const ctx = canvas.getContext('2d');
  fillBackground(ctx, style);
  if (image) {
    const k = Math.min(W / image.naturalWidth, area / image.naturalHeight);
    const w = image.naturalWidth * k;
    const h = image.naturalHeight * k;
    drawImage(ctx, image, (W - w) / 2, (area - h) / 2, w, h, style);
  }
  if (caption) drawText(ctx, caption, pad, area + pad, style);
  return toTexture(canvas, style);
}

const LAYOUTS = {
  'Full-object image': fullObjectImage,
  'Title and text': titleAndText,
  'Headline only': headlineOnly,
  'Header and icon on the left': headerAndIcon,
  'Portrait orientation. Large image with a caption underneath.': portraitImage,
};

// Как элемент встаёт в строку под родителем: block — во всю ширину,
// inline — делит строку с соседними inline-элементами (кнопки, карточки в ряд).
const INLINE = new Set(['Header and icon on the left', 'Portrait orientation. Large image with a caption underneath.']);
export function layoutFlow(element) {
  return INLINE.has(element.Layout) ? 'inline' : 'block';
}

// width — внешняя ширина объекта в строке, м; neon — неоновый стиль.
export function renderLayout(element, width, { neon = false } = {}) {
  const layout = LAYOUTS[element.Layout];
  if (!layout) throw new Error(`Неизвестный Layout «${element.Layout}» у элемента ${element.id}`);
  return layout(element, width, styleOf(element, neon));
}
