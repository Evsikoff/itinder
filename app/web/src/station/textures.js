import * as THREE from 'three';
import { TRAINS } from '../config.js';
import { fbm, random } from './noise.js';

// Процедурные текстуры станции. Каждая рисуется на canvas один раз при загрузке.

function hex(color) {
  const c = new THREE.Color(color);
  return [c.r * 255, c.g * 255, c.b * 255];
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// shade(u, v, rnd) возвращает [r, g, b] 0..255; v = 0 — верх картинки.
function paint(width, height, shade, seed = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  const data = image.data;
  const rnd = random(seed);
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = shade((x + 0.5) / width, v, rnd);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function toTexture(canvas, { repeat = true, srgb = true } = {}) {
  const texture = new THREE.CanvasTexture(canvas);
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  if (repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

// Зернистость гранита: мелкие тёмные и светлые вкрапления поверх облачной основы.
function granite(base, rnd, cloud) {
  const n = rnd();
  let k = 0.9 + 0.2 * rnd() + (cloud - 0.5) * 0.16;
  if (n < 0.07) k *= 0.55;
  else if (n > 0.975) k *= 1.35;
  return [base[0] * k, base[1] * k, base[2] * k];
}

// Прожилки мрамора: тонкие линии, изогнутые фрактальным шумом. Целые a и b
// задают наклон и густоту и сохраняют бесшовность текстуры.
function veins(u, v, a, b, warp, seed, cellsX = 4, cellsY = 4) {
  const t = fbm(u, v, cellsX, cellsY, 5, seed);
  const s = Math.sin(Math.PI * (a * u + b * v) + t * warp);
  return Math.pow(1 - Math.abs(s), 9);
}

// Пол платформы: один пролёт (12 × 6 м), повторяется вдоль станции.
// По центру шахматка из светлого и тёмного гранита, у края — светлая полоса.
export function floorTexture() {
  const W = 12;
  const L = 6;
  const light = hex('#9b978f');
  const dark = hex('#514e4b');
  const border = hex('#2c2b2e');
  const side = hex('#8c8986');
  const edge = hex('#c2b9aa');
  return toTexture(paint(1024, 512, (u, v, rnd) => {
    const x = (u - 0.5) * W;
    const z = v * L;
    const ax = Math.abs(x);
    const cloud = fbm(u, v, 12, 6, 3, 11);
    let base;
    let joint = false;
    if (ax < 3) {
      base = (Math.floor(x + 3) + Math.floor(z)) % 2 === 0 ? light : dark;
      joint = Math.abs(x - Math.round(x)) < 0.012 || Math.abs(z - Math.round(z)) < 0.012;
    } else if (ax < 3.3) {
      base = border;
    } else if (ax < 5.4) {
      base = side;
      joint = Math.abs(z - Math.round(z)) < 0.012 || Math.abs(ax - 4.35) < 0.012;
    } else if (ax < 5.5) {
      base = border;
    } else {
      base = edge;
      joint = Math.abs(z * 2 - Math.round(z * 2)) < 0.024;
    }
    const c = granite(base, rnd, cloud);
    return joint ? [c[0] * 0.55, c[1] * 0.55, c[2] * 0.55] : c;
  }, 7));
}

// Путевая стена от дна путей до потолка (7.05 м), повторяется через 3 м.
export function wallTexture({ bottom, top }) {
  const H = top - bottom;
  const plinth = hex('#2b292a');
  const cream = hex('#d6c9b0');
  const creamVein = hex('#9c8f7c');
  const frieze = hex('#6a3125');
  const plaster = hex('#d5d0c7');
  return toTexture(paint(512, 1200, (u, v, rnd) => {
    const y = top - v * H;
    const z = u * 3;
    if (y < 0.5) {
      return granite(plinth, rnd, fbm(u, v, 4, 8, 3, 5));
    }
    if (y < 0.6) return [40, 38, 38];
    if (y < 4.8) {
      const vein = veins(u, v, 4, 3, 6, 21, 4, 8);
      const cloud = fbm(u, v, 6, 12, 4, 23);
      let c = mix(cream, creamVein, vein * 0.35 + (cloud - 0.5) * 0.5);
      const rowY = (y - 0.6) / 1.05;
      if (Math.abs(rowY - Math.round(rowY)) < 0.01 || Math.abs(z / 1.5 - Math.round(z / 1.5)) < 0.004) {
        c = mix(c, [60, 52, 45], 0.6);
      }
      return c;
    }
    if (y < 5.0) {
      const vein = veins(u, v, 8, 2, 6, 31, 4, 8);
      return mix(granite(frieze, rnd, 0.5), [176, 120, 96], vein * 0.7);
    }
    return granite(plaster, rnd, 0.5).map((c, i) => c * 0.4 + plaster[i] * 0.6);
  }, 3));
}

// Колонна: красно-коричневый мрамор, как на «Краснопресненской».
export function columnTexture() {
  const base = hex('#6e3529');
  const deep = hex('#45201a');
  const light = hex('#a8806e');
  return toTexture(paint(256, 1024, (u, v) => {
    const cloud = fbm(u, v, 3, 10, 5, 41);
    const vein = veins(u, v, 4, 14, 9, 43, 3, 10);
    const fine = veins(u, v, 26, 6, 5, 47, 3, 10);
    let c = mix(base, deep, Math.max(0, 0.6 - cloud) * 1.4);
    c = mix(c, light, vein * 0.45 + fine * 0.15);
    return c;
  }, 9), { repeat: false });
}

export function plasterTexture() {
  const base = hex('#d7d2c9');
  return toTexture(paint(256, 256, (u, v, rnd) => {
    const k = 0.95 + 0.06 * fbm(u, v, 8, 8, 4, 51) + 0.03 * rnd();
    return [base[0] * k, base[1] * k, base[2] * k];
  }, 13));
}

export function concreteTexture() {
  const base = hex('#4b4845');
  return toTexture(paint(256, 256, (u, v, rnd) => {
    const cloud = fbm(u, v, 6, 6, 5, 61);
    return granite(base, rnd, cloud).map((c) => c * (0.8 + cloud * 0.35));
  }, 17));
}

export function darkGraniteTexture() {
  const base = hex('#2e2c2e');
  return toTexture(paint(256, 256, (u, v, rnd) => granite(base, rnd, fbm(u, v, 4, 4, 3, 71)), 19));
}

export function edgeGraniteTexture() {
  const base = hex('#bdb4a5');
  return toTexture(paint(256, 64, (u, v, rnd) => granite(base, rnd, fbm(u, v, 8, 2, 3, 81)), 23));
}

// Борт вагона: цвет и карта свечения окон (салон освещён изнутри).
// Картинка — один борт длиной carLength от низа юбки (−0.3 м) до верха борта (2.2 м).
// leaf — левая створка дверей, вырезанная из той же картинки до середины щели:
// настоящие створки (trains.js) выглядят так же, как нарисованные. Правая — её
// зеркало: стекло отступает от обоих краёв створки одинаково.
export function liveryTextures(carLength) {
  const W = 2048;
  const H = 272;
  const bottom = -0.3;
  const top = 2.2;
  const px = (m) => (m / carLength) * W;
  const py = (y) => ((top - y) / (top - bottom)) * H;
  const rect = (ctx, x0, y0, x1, y1) => ctx.fillRect(px(x0), py(y1), px(x1) - px(x0), py(y0) - py(y1));

  const { doors, doorHalf, doorBottom, doorTop } = TRAINS;
  const windowBand = [0.95, 1.92];

  const color = document.createElement('canvas');
  color.width = W;
  color.height = H;
  const c = color.getContext('2d');
  const body = c.createLinearGradient(0, 0, 0, H);
  body.addColorStop(0, '#d3d6dc');
  body.addColorStop(1, '#a9adb5');
  c.fillStyle = body;
  c.fillRect(0, 0, W, H);
  c.fillStyle = '#26272c';
  rect(c, 0, bottom, carLength, 0.04);
  c.fillStyle = '#17181c';
  rect(c, 0, windowBand[0], carLength, windowBand[1]);
  c.fillStyle = '#402FFF';
  rect(c, 0, 0.7, carLength, 0.82);
  c.fillStyle = '#EC1D35';
  rect(c, 0, 0.63, carLength, 0.66);

  const glow = document.createElement('canvas');
  glow.width = W;
  glow.height = H;
  const g = glow.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  const light = g.createLinearGradient(0, py(windowBand[1]), 0, py(windowBand[0]));
  light.addColorStop(0, '#fff3dc');
  light.addColorStop(1, '#b49a78');

  const glass = (x0, y0, x1, y1) => {
    c.fillStyle = '#2a2c33';
    rect(c, x0, y0, x1, y1);
    g.fillStyle = light;
    rect(g, x0, y0, x1, y1);
  };

  // Окна между дверями: по три стекла со стойками.
  const gaps = [[0.25, doors[0] - doorHalf - 0.2]];
  for (let i = 0; i < doors.length - 1; i++) gaps.push([doors[i] + doorHalf + 0.2, doors[i + 1] - doorHalf - 0.2]);
  gaps.push([doors[doors.length - 1] + doorHalf + 0.2, carLength - 0.25]);
  for (const [a, b] of gaps) {
    const n = b - a > 3 ? 3 : 1;
    const w = (b - a - (n - 1) * 0.14) / n;
    for (let i = 0; i < n; i++) {
      const x0 = a + i * (w + 0.14);
      glass(x0, windowBand[0] + 0.06, x0 + w, windowBand[1] - 0.04);
    }
  }

  for (const d of doors) {
    c.fillStyle = '#1b1c21';
    rect(c, d - doorHalf - 0.04, 0.0, d + doorHalf + 0.04, 2.02);
    c.fillStyle = '#b9bcc3';
    rect(c, d - doorHalf, doorBottom, d - 0.01, doorTop);
    rect(c, d + 0.01, doorBottom, d + doorHalf, doorTop);
    glass(d - doorHalf + 0.12, 1.0, d - 0.13, 1.86);
    glass(d + 0.13, 1.0, d + doorHalf - 0.12, 1.86);
    c.fillStyle = '#402FFF';
    rect(c, d - doorHalf, 0.7, d + doorHalf, 0.82);
  }

  const crop = (source) => {
    const [x0, x1, y0, y1] = [px(doors[0] - doorHalf), px(doors[0]), py(doorTop), py(doorBottom)];
    const leaf = document.createElement('canvas');
    leaf.width = Math.round(x1 - x0);
    leaf.height = Math.round(y1 - y0);
    leaf.getContext('2d').drawImage(source, x0, y0, x1 - x0, y1 - y0, 0, 0, leaf.width, leaf.height);
    return toTexture(leaf, { repeat: false });
  };

  return {
    map: toTexture(color, { repeat: false }),
    emissiveMap: toTexture(glow, { repeat: false }),
    leaf: { map: crop(color), emissiveMap: crop(glow) },
  };
}

// Салон вагона длиной length (м) и высотой height от пола до потолка: стены,
// торцы и пол. Свет в салоне свой, ровный, поэтому он уже нарисован в картинках.
// wall — продольная стена: двери на тех же местах, что снаружи, окна, сиденья
// под ними — отдельные объекты (trains.js); end — торец с дверью в соседний
// вагон; floor — рифлёный пол, повторяется.
export function carInteriorTextures(length, height) {
  const { doors, doorHalf, doorTop, carLength } = TRAINS;
  const offset = (carLength - length) / 2; // салон короче вагона на толщину торцов
  const W = 2048;
  const H = 256;
  const px = (m) => ((m - offset) / length) * W;
  const py = (y) => ((height - y) / height) * H;
  const rect = (ctx, x0, y0, x1, y1) => ctx.fillRect(px(x0), py(y1), px(x1) - px(x0), py(y0) - py(y1));

  const wall = document.createElement('canvas');
  wall.width = W;
  wall.height = H;
  const c = wall.getContext('2d');
  const panel = c.createLinearGradient(0, 0, 0, H);
  panel.addColorStop(0, '#ebe4d3');
  panel.addColorStop(1, '#d6ccb6');
  c.fillStyle = panel;
  c.fillRect(0, 0, W, H);
  c.fillStyle = '#b9ad94';
  rect(c, 0, 0, carLength, 0.9);
  // Рекламная полоса над окнами.
  c.fillStyle = '#f6f3ec';
  rect(c, 0, 1.98, carLength, 2.2);
  const ads = ['#402FFF', '#EC1D35', '#7063FF', '#3B3C40'];
  for (let x = offset + 0.3, i = 0; x < carLength - offset - 0.9; x += 1.15, i++) {
    c.fillStyle = ads[i % ads.length];
    rect(c, x, 2.01, x + 0.75, 2.17);
  }
  // Окна: тёмный тоннель за стеклом и блик.
  const windowGlass = (x0, x1) => {
    c.fillStyle = '#8e897d';
    rect(c, x0 - 0.04, 0.93, x1 + 0.04, 1.94);
    const shine = c.createLinearGradient(px(x0), py(1.9), px(x1), py(0.97));
    shine.addColorStop(0, '#2b3038');
    shine.addColorStop(0.5, '#111318');
    shine.addColorStop(1, '#1c2027');
    c.fillStyle = shine;
    rect(c, x0, 0.97, x1, 1.9);
  };
  const gaps = [[offset, doors[0] - doorHalf - 0.25]];
  for (let i = 0; i < doors.length - 1; i++) gaps.push([doors[i] + doorHalf + 0.25, doors[i + 1] - doorHalf - 0.25]);
  gaps.push([doors[doors.length - 1] + doorHalf + 0.25, carLength - offset]);
  for (const [a, b] of gaps) {
    const n = b - a > 3 ? 3 : 1;
    const w = (b - a - 0.2 - (n - 1) * 0.14) / n;
    for (let i = 0; i < n; i++) windowGlass(a + 0.1 + i * (w + 0.14), a + 0.1 + i * (w + 0.14) + w);
  }
  // Двери изнутри: светлые створки со стёклами, тёмная щель между ними.
  for (const d of doors) {
    c.fillStyle = '#6d6a64';
    rect(c, d - doorHalf - 0.05, 0, d + doorHalf + 0.05, doorTop + 0.05);
    c.fillStyle = '#c4c6ca';
    rect(c, d - doorHalf, 0, d - 0.01, doorTop);
    rect(c, d + 0.01, 0, d + doorHalf, doorTop);
    windowGlass(d - doorHalf + 0.12, d - 0.13);
    windowGlass(d + 0.13, d + doorHalf - 0.12);
  }

  const end = document.createElement('canvas');
  end.width = 256;
  end.height = 256;
  const e = end.getContext('2d');
  e.fillStyle = panel;
  e.fillRect(0, 0, 256, 256);
  e.fillStyle = '#6d6a64';
  e.fillRect(80, 40, 96, 216);
  e.fillStyle = '#c4c6ca';
  e.fillRect(86, 46, 84, 210);
  e.fillStyle = '#15171c';
  e.fillRect(100, 62, 56, 80);

  const floor = document.createElement('canvas');
  floor.width = 64;
  floor.height = 64;
  const f = floor.getContext('2d');
  f.fillStyle = '#4a4440';
  f.fillRect(0, 0, 64, 64);
  f.fillStyle = '#3a3532';
  for (let x = 0; x < 64; x += 8) f.fillRect(x, 0, 3, 64);

  return {
    wall: toTexture(wall, { repeat: false }),
    end: toTexture(end, { repeat: false }),
    floor: toTexture(floor),
  };
}
