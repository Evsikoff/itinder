// Детерминированный шум для процедурных текстур. Все функции периодичны,
// чтобы текстуры бесшовно повторялись вдоль станции.

export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(x, y, seed) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);
const wrap = (i, period) => ((i % period) + period) % period;

// Значение шума в точке (x, y); решётка повторяется через periodX × periodY клеток.
export function valueNoise(x, y, periodX, periodY, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const ax = wrap(x0, periodX);
  const bx = wrap(x0 + 1, periodX);
  const ay = wrap(y0, periodY);
  const by = wrap(y0 + 1, periodY);
  const a = hash(ax, ay, seed);
  const b = hash(bx, ay, seed);
  const c = hash(ax, by, seed);
  const d = hash(bx, by, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// Фрактальный шум для u, v в [0, 1): базовая частота задаётся числом клеток.
export function fbm(u, v, cellsX, cellsY, octaves, seed) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const fx = cellsX << o;
    const fy = cellsY << o;
    sum += amp * valueNoise(u * fx, v * fy, fx, fy, seed + o * 31);
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}
