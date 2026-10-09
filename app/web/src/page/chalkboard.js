import * as THREE from 'three';
import { CHALKBOARD } from '../config.js';
import { lit } from '../station/lamps.js';
import { fbm, random } from '../station/noise.js';
import { HAND_FONT, loadHandwriting } from './fonts.js';
import { addBridle, addHangerEye } from './hardware.js';
import { isEmpty } from './scheme.js';
import { createTextField } from './textField.js';

// «Chalkboard»: школьная доска в деревянной раме, с полочкой, мелками и тряпкой.
// Это поле ввода: по клику доска получает фокус, и набранное на клавиатуре
// появляется на ней мелом, рукописным шрифтом. Layout «Headline only» — на доске
// только текст: title (если задан) написан заранее, цвет мела — title_color,
// цвет доски — background_hex.

const TEX_WIDTH = 2048;
const WEIGHT = 600;
const LINE_HEIGHT = 1.05;      // высота строки в размерах шрифта
const BASELINE = 0.76;         // базовая линия от верха строки, в размерах шрифта
const PADDING = [0.045, 0.1];  // поля надписи: доли ширины и высоты поля для письма
const SLOPE = -0.01;           // строка чуть уходит вверх, как у руки на доске
const STAGGER = 0.05;          // задержка между буквами, вставленными разом
const BLINK = 0.53;            // полупериод мигания курсора, с
const GHOST = 0.05;            // насколько видны стёртые буквы
const GLOW = 0.22;             // доска немного светится сама, чтобы мел читался издалека
const FOCUS_GLOW = 0.3;
const DEFAULT_BOARD = '#2f3533';
const DEFAULT_CHALK = '#f2f1ea';
const canFilter = 'filter' in CanvasRenderingContext2D.prototype;

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function srgb(color) {
  const { r, g, b } = new THREE.Color(color).getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  return [r * 255, g * 255, b * 255];
}

function rgba(color, alpha) {
  const [r, g, b] = srgb(color).map(Math.round);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Зерно мела: пятнистая маска, которая выбивает часть штриха. Пятна покрупнее —
// там, где мел лёг слабее.
let grain = null;
function chalkGrain() {
  if (grain) return grain;
  const size = 256;
  grain = makeCanvas(size, size);
  const ctx = grain.getContext('2d');
  const image = ctx.createImageData(size, size);
  const rnd = random(23);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const pressure = fbm(x / size, y / size, 8, 8, 3, 41);
      const n = rnd();
      const speck = n < 0.2 ? 255 : n < 0.38 ? 120 : 0;
      image.data[(y * size + x) * 4 + 3] = Math.min(255, Math.max(speck, (pressure - 0.45) * 400));
    }
  }
  ctx.putImageData(image, 0, 0);
  return grain;
}

// Дерево рамы: волокна вдоль u, годовые кольца изогнуты шумом.
let woodCanvas = null;
function woodTexture() {
  if (!woodCanvas) {
    const width = 1024;
    const height = 64;
    woodCanvas = makeCanvas(width, height);
    const ctx = woodCanvas.getContext('2d');
    const image = ctx.createImageData(width, height);
    const rnd = random(7);
    const dark = [84, 52, 30];
    const light = [150, 104, 62];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const u = (x + 0.5) / width;
        const v = (y + 0.5) / height;
        const warp = fbm(u, v, 4, 1, 4, 3);
        const ring = 0.5 + 0.5 * Math.sin((v * 3 + warp * 5) * Math.PI * 2);
        const fiber = fbm(u, v, 64, 4, 2, 9);
        const t = Math.min(1, Math.max(0, ring * 0.55 + fiber * 0.45 + (rnd() - 0.5) * 0.08));
        const i = (y * width + x) * 4;
        for (let c = 0; c < 3; c++) image.data[i + c] = dark[c] + (light[c] - dark[c]) * t;
        image.data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  }
  const texture = new THREE.CanvasTexture(woodCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

// Чистая доска: сланец с пятнами и зерном, разводы от тряпки, пыль у полочки.
function paintBoard(width, height, board, chalk, seed) {
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const low = makeCanvas(256, Math.max(8, Math.round((256 * height) / width)));
  const lowCtx = low.getContext('2d');
  const image = lowCtx.createImageData(low.width, low.height);
  const base = srgb(board);
  for (let y = 0; y < low.height; y++) {
    for (let x = 0; x < low.width; x++) {
      const k = 1 + (fbm(x / low.width, y / low.height, 6, 2, 4, seed) - 0.5) * 0.18;
      const i = (y * low.width + x) * 4;
      for (let c = 0; c < 3; c++) image.data[i + c] = base[c] * k;
      image.data[i + 3] = 255;
    }
  }
  lowCtx.putImageData(image, 0, 0);
  ctx.drawImage(low, 0, 0, width, height);

  const rnd = random(seed);
  const speckle = makeCanvas(128, 128);
  const speckleCtx = speckle.getContext('2d');
  const dots = speckleCtx.createImageData(128, 128);
  for (let i = 0; i < dots.data.length; i += 4) {
    const v = rnd() < 0.5 ? 0 : 255;
    dots.data[i] = dots.data[i + 1] = dots.data[i + 2] = v;
    dots.data[i + 3] = rnd() * 16;
  }
  speckleCtx.putImageData(dots, 0, 0);
  ctx.fillStyle = ctx.createPattern(speckle, 'repeat');
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.strokeStyle = chalk;
  ctx.lineCap = 'round';
  if (canFilter) ctx.filter = `blur(${Math.round(height * 0.03)}px)`;
  for (let i = 0; i < 10; i++) {
    ctx.globalAlpha = (canFilter ? 0.035 : 0.02) + rnd() * 0.035;
    ctx.lineWidth = height * (0.1 + rnd() * 0.2);
    const y = height * (0.12 + rnd() * 0.76);
    const x0 = width * (rnd() * 0.5 - 0.15);
    const x1 = x0 + width * (0.3 + rnd() * 0.5);
    const bend = () => (rnd() - 0.5) * height * 0.5;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.bezierCurveTo(x0 + (x1 - x0) / 3, y + bend(), x0 + (2 * (x1 - x0)) / 3, y + bend(), x1, y + bend() * 0.5);
    ctx.stroke();
  }
  ctx.restore();

  const dust = ctx.createLinearGradient(0, height, 0, height * 0.8);
  dust.addColorStop(0, rgba(chalk, 0.14));
  dust.addColorStop(1, rgba(chalk, 0));
  ctx.fillStyle = dust;
  ctx.fillRect(0, height * 0.8, width, height * 0.2);
  return canvas;
}

export async function buildChalkboard({ element, width, label = '' }) {
  if (element.Layout !== 'Headline only') {
    throw new Error(`Chalkboard умеет только Layout «Headline only», у элемента ${element.id} — «${element.Layout}»`);
  }
  await loadHandwriting();
  const boardColor = isEmpty(element.background_hex) ? DEFAULT_BOARD : element.background_hex;
  const chalk = isEmpty(element.title_color) ? DEFAULT_CHALK : element.title_color;

  const F = CHALKBOARD.frame;
  const D = CHALKBOARD.depth;
  const [trayOut, trayThick] = CHALKBOARD.tray;
  const surfaceWidth = width - 2 * F;
  const surfaceHeight = CHALKBOARD.height;
  const outerHeight = surfaceHeight + 2 * F;
  const texWidth = TEX_WIDTH;
  const texHeight = Math.round((TEX_WIDTH * surfaceHeight) / surfaceWidth);

  // Слои надписи: чистая доска (на ней же копятся следы стёртого), мел и итог.
  const board = paintBoard(texWidth, texHeight, boardColor, chalk, 5 + Number(element.id));
  const boardCtx = board.getContext('2d');
  const ink = makeCanvas(texWidth, texHeight);
  const inkCtx = ink.getContext('2d');
  const grainPattern = inkCtx.createPattern(chalkGrain(), 'repeat');
  const out = makeCanvas(texWidth, texHeight);
  const outCtx = out.getContext('2d');
  const texture = new THREE.CanvasTexture(out);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;

  // ---- Надпись -------------------------------------------------------------

  const input = createTextField({
    label,
    maxLength: CHALKBOARD.maxLength,
    value: isEmpty(element.title) ? '' : String(element.title),
  });

  // У каждой буквы свой небольшой наклон, подскок и размер — как у руки.
  const jitter = random(1000 + Number(element.id));
  const glyphs = [];   // { ch, born, dy, turn, scale }
  let placed = [];     // положение каждой буквы на холсте: { x, w, baseline, size }
  let fit = null;      // { size, rows, left, baselines }
  let shown = '';
  let time = 0;

  const measure = document.createElement('canvas').getContext('2d');
  const advances = new Map();
  const advance = (ch) => {
    let a = advances.get(ch);
    if (a === undefined) {
      measure.font = `${WEIGHT} 100px "${HAND_FONT}"`;
      a = measure.measureText(ch).width / 100;
      advances.set(ch, a);
    }
    return a;
  };

  // Строки для шрифта size: перенос по пробелу, длинное слово (адрес почты) — по буквам.
  function wrap(size, maxWidth) {
    const rows = [];
    let start = 0;
    let x = 0;
    let space = -1;
    for (let i = 0; i < glyphs.length; i++) {
      const w = advance(glyphs[i].ch) * size;
      if (x + w > maxWidth && i > start) {
        const cut = space >= start ? space + 1 : i;
        rows.push([start, cut]);
        start = cut;
        x = 0;
        for (let j = start; j < i; j++) x += advance(glyphs[j].ch) * size;
        space = -1;
      }
      x += w;
      if (glyphs[i].ch === ' ') space = i;
    }
    rows.push([start, glyphs.length]);
    return rows;
  }

  // Самый крупный шрифт, при котором надпись помещается на доску.
  function layout() {
    const maxWidth = texWidth * (1 - 2 * PADDING[0]);
    const maxHeight = texHeight * (1 - 2 * PADDING[1]);
    const minLine = texHeight * CHALKBOARD.minLine;
    let line = texHeight * CHALKBOARD.maxLine;
    let rows;
    for (;;) {
      rows = wrap(line / LINE_HEIGHT, maxWidth);
      if (rows.length * line <= maxHeight || line <= minLine) break;
      line = Math.max(minLine, line * 0.96);
    }
    const size = line / LINE_HEIGHT;
    const left = texWidth * PADDING[0];
    const top = (texHeight - rows.length * line) / 2;
    const baselines = rows.map((_, r) => top + r * line + BASELINE * size);
    placed = new Array(glyphs.length);
    rows.forEach(([start, end], r) => {
      let x = left;
      for (let i = start; i < end; i++) {
        const w = advance(glyphs[i].ch) * size;
        placed[i] = { x, w, baseline: baselines[r] + (x - left) * SLOPE, size };
        x += w;
      }
    });
    fit = { size, rows, left, baselines };
  }

  // Курсор перед буквой index (index = длине текста — после последней).
  function caretPoint(index) {
    const { left, baselines, size } = fit;
    if (glyphs.length === 0) return { x: left, baseline: baselines[0], size };
    if (index < glyphs.length) return { ...placed[index] };
    const last = placed[glyphs.length - 1];
    return { x: last.x + last.w, baseline: last.baseline + last.w * SLOPE, size };
  }

  // Позиция курсора по точке клика на поле для письма.
  function caretFromUv(uv) {
    const px = uv.x * texWidth;
    const py = (1 - uv.y) * texHeight;
    const { rows, baselines, size, left } = fit;
    let row = 0;
    baselines.forEach((b, r) => {
      if (Math.abs(b - 0.3 * size - py) < Math.abs(baselines[row] - 0.3 * size - py)) row = r;
    });
    const [start, end] = rows[row];
    let index = start;
    let best = Infinity;
    for (let i = start; i <= end; i++) {
      let x = left;
      if (i < end) x = placed[i].x;
      else if (end > start) x = placed[end - 1].x + placed[end - 1].w;
      if (Math.abs(x - px) < best) {
        best = Math.abs(x - px);
        index = i;
      }
    }
    return index;
  }

  function drawGlyph(ctx, glyph, p, progress = 1) {
    ctx.save();
    ctx.translate(p.x + p.w / 2, p.baseline + glyph.dy * p.size);
    ctx.rotate(glyph.turn);
    ctx.scale(glyph.scale, glyph.scale);
    if (progress < 1) {
      // Буква проявляется слева направо, будто её сейчас выводят мелом.
      ctx.beginPath();
      ctx.rect(-p.w / 2 - p.size * 0.3, -p.size * 1.5, (p.w + p.size * 0.6) * progress, p.size * 2.5);
      ctx.clip();
    }
    ctx.fillText(glyph.ch, -p.w / 2, 0);
    ctx.restore();
  }

  // Стёртые буквы оставляют на доске едва заметный след.
  function ghost(removed) {
    boardCtx.save();
    boardCtx.fillStyle = chalk;
    boardCtx.globalAlpha = GHOST;
    boardCtx.textBaseline = 'alphabetic';
    if (canFilter) boardCtx.filter = 'blur(2px)';
    for (const { glyph, p } of removed) {
      boardCtx.font = `${WEIGHT} ${p.size}px "${HAND_FONT}"`;
      drawGlyph(boardCtx, glyph, p);
    }
    boardCtx.restore();
  }

  // Привести буквы к значению поля: общее начало и конец остаются на месте,
  // середина стирается и пишется заново.
  function syncText(value, instant = false) {
    let p = 0;
    while (p < shown.length && p < value.length && shown[p] === value[p]) p++;
    let s = 0;
    while (s < shown.length - p && s < value.length - p && shown[shown.length - 1 - s] === value[value.length - 1 - s]) s++;
    const removedCount = shown.length - p - s;
    const removed = glyphs.slice(p, p + removedCount).map((glyph, k) => ({ glyph, p: placed[p + k] })).filter((r) => r.p);
    const inserted = value.slice(p, value.length - s).split('').map((ch, k) => ({
      ch,
      born: instant ? -Infinity : time + k * STAGGER,
      dy: (jitter() - 0.5) * 0.07,
      turn: (jitter() - 0.5) * 0.08,
      scale: 1 + (jitter() - 0.5) * 0.08,
    }));
    glyphs.splice(p, removedCount, ...inserted);
    shown = value;
    if (removed.length) ghost(removed);
    layout();
  }

  // Мел: буквы, потом зерно выбивает часть штриха. Возвращает true, пока
  // какая-то буква ещё пишется.
  function renderInk() {
    inkCtx.clearRect(0, 0, texWidth, texHeight);
    inkCtx.font = `${WEIGHT} ${fit.size}px "${HAND_FONT}"`;
    inkCtx.fillStyle = chalk;
    inkCtx.textBaseline = 'alphabetic';
    let writing = false;
    glyphs.forEach((glyph, i) => {
      const progress = (time - glyph.born) / CHALKBOARD.writeTime;
      if (progress < 1) writing = true;
      if (progress > 0) drawGlyph(inkCtx, glyph, placed[i], Math.min(progress, 1));
    });
    inkCtx.globalCompositeOperation = 'destination-out';
    inkCtx.fillStyle = grainPattern;
    inkCtx.fillRect(0, 0, texWidth, texHeight);
    inkCtx.globalCompositeOperation = 'source-over';
    return writing;
  }

  function compose({ focused, start, end, caret }) {
    outCtx.drawImage(board, 0, 0);
    if (focused && end > start) {
      outCtx.fillStyle = rgba(chalk, 0.16);
      for (let i = start; i < end && i < placed.length; i++) {
        const p = placed[i];
        outCtx.fillRect(p.x, p.baseline - 0.85 * p.size, p.w, 1.1 * p.size);
      }
    }
    // Пыльный ореол вокруг штрихов.
    if (canFilter) {
      outCtx.filter = 'blur(3px)';
      outCtx.globalAlpha = 0.45;
      outCtx.drawImage(ink, 0, 0);
      outCtx.filter = 'none';
      outCtx.globalAlpha = 1;
    }
    outCtx.drawImage(ink, 0, 0);
    if (caret) {
      const c = caretPoint(end);
      const w = Math.max(3, c.size * 0.05);
      outCtx.fillStyle = rgba(chalk, 0.85);
      outCtx.fillRect(c.x - w / 2, c.baseline - 0.78 * c.size, w, 0.95 * c.size);
    }
    texture.needsUpdate = true;
  }

  syncText(input.value, true);
  renderInk();
  compose({ focused: false, start: 0, end: 0, caret: false });

  // ---- Доска ---------------------------------------------------------------

  const group = new THREE.Group();
  group.name = 'chalkboard';

  const wood = woodTexture();
  const woodAcross = wood.clone();
  woodAcross.center.set(0.5, 0.5);
  woodAcross.rotation = Math.PI / 2;
  woodAcross.needsUpdate = true;
  const frameAlong = lit(new THREE.MeshStandardMaterial({ map: wood, roughness: 0.6 }));
  const frameAcross = lit(new THREE.MeshStandardMaterial({ map: woodAcross, roughness: 0.6 }));
  const backing = lit(new THREE.MeshStandardMaterial({ color: 0x3b2a1d, roughness: 0.85 }));
  const steel = lit(new THREE.MeshStandardMaterial({ color: 0x8e9096, metalness: 1, roughness: 0.35 }));
  const chalkStick = lit(new THREE.MeshStandardMaterial({ color: 0xf4f2ea, roughness: 1 }));
  const felt = lit(new THREE.MeshStandardMaterial({ color: 0x5a5b60, roughness: 1 }));
  const slate = lit(new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.9,
    metalness: 0,
    emissive: 0xffffff,
    emissiveMap: texture,
    emissiveIntensity: GLOW,
  }));

  const surface = new THREE.Mesh(new THREE.PlaneGeometry(surfaceWidth, surfaceHeight), slate);
  surface.position.z = D / 2 - 0.012;
  group.add(surface);

  const back = new THREE.Mesh(new THREE.BoxGeometry(width - 0.004, outerHeight - 0.004, D - 0.013), backing);
  back.position.z = -0.0065;
  group.add(back);

  const box = (w, h, d, material, x, y, z) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };
  box(width, F, D, frameAlong, 0, surfaceHeight / 2 + F / 2, 0);
  box(width, F, D, frameAlong, 0, -surfaceHeight / 2 - F / 2, 0);
  for (const side of [-1, 1]) box(F, surfaceHeight, D, frameAcross, side * (surfaceWidth / 2 + F / 2), 0, 0);

  // Полочка с бортиком, на ней мелок, обломок мелка и тряпка.
  const trayZ = D / 2 + trayOut / 2;
  const trayTop = -outerHeight / 2 + trayThick;
  box(surfaceWidth + F, trayThick, trayOut, frameAlong, 0, trayTop - trayThick / 2, trayZ);
  box(surfaceWidth + F, 0.014, 0.008, frameAlong, 0, trayTop + 0.007, D / 2 + trayOut - 0.004);
  const stick = (length, x, turn) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, length, 12), chalkStick);
    mesh.rotation.set(0, turn, Math.PI / 2);
    mesh.position.set(x, trayTop + 0.0055, trayZ - 0.004);
    group.add(mesh);
  };
  stick(0.075, surfaceWidth * 0.2, 0.25);
  stick(0.03, surfaceWidth * 0.27, -0.5);
  box(0.13, 0.012, 0.042, felt, -surfaceWidth * 0.3, trayTop + 0.006, trayZ - 0.004).rotation.y = 0.08;
  box(0.13, 0.02, 0.042, frameAlong, -surfaceWidth * 0.3, trayTop + 0.022, trayZ - 0.004).rotation.y = 0.08;

  const hook = addBridle(group, steel, {
    eyeX: (width / 2) * 0.62,
    eyeY: outerHeight / 2 + 0.016,
    ringY: outerHeight / 2 + CHALKBOARD.bridleHeight,
  });

  // ---- Состояние в кадре ---------------------------------------------------

  let writing = false;
  let drawn = '';
  let selection = [input.selectionStart, input.selectionEnd];
  let blinkFrom = 0;
  let boost = 0;

  return {
    group,
    hook,
    halfExtents: new THREE.Vector3(width / 2, outerHeight / 2, (D + trayOut) / 2),
    mass: CHALKBOARD.mass,
    pickables: [...group.children],
    addAnchor: (x) => addHangerEye(group, steel, x, -outerHeight / 2),
    highlight(on) {
      boost = on ? 0.1 : 0;
    },
    field: {
      // Клик по надписи ставит курсор туда, куда попали.
      focus(hit, x, y) {
        const caret = hit?.object === surface && hit.uv ? caretFromUv(hit.uv) : undefined;
        input.focus({ x, y, caret });
      },
      get focused() {
        return input.focused;
      },
      get value() {
        return input.value;
      },
    },
    update(dt) {
      time += dt;
      let dirty = writing;
      if (input.value !== shown) {
        syncText(input.value);
        dirty = true;
        blinkFrom = time;
      }
      const focused = input.focused;
      const start = input.selectionStart;
      const end = input.selectionEnd;
      if (start !== selection[0] || end !== selection[1]) {
        selection = [start, end];
        blinkFrom = time;
      }
      const caret = focused && start === end && Math.floor((time - blinkFrom) / BLINK) % 2 === 0;
      if (dirty) writing = renderInk();
      const state = `${focused}|${start}|${end}|${caret}`;
      if (dirty || state !== drawn) {
        compose({ focused, start, end, caret });
        drawn = state;
      }
      const glow = (focused ? FOCUS_GLOW : GLOW) + boost;
      slate.emissiveIntensity += (glow - slate.emissiveIntensity) * (1 - Math.exp(-dt * 8));
    },
    dispose() {
      input.dispose();
      group.traverse((o) => o.geometry?.dispose());
      for (const material of [frameAlong, frameAcross, backing, steel, chalkStick, felt, slate]) material.dispose();
      for (const map of [wood, woodAcross, texture]) map.dispose();
    },
  };
}
