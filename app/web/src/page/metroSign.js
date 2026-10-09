import * as THREE from 'three';
import { SIGN } from '../config.js';
import { lit } from '../station/lamps.js';
import { addBridle, addHangerEye, addTopEyes } from './hardware.js';

// «A sign like the ones in the Moscow Metro»: двояковыпуклая стеклянная табличка.
// Внутри — плоский контейнер с содержимым (с обеих сторон), вокруг — металлический
// обод, спереди и сзади — выпуклые стёкла. Сверху два ушка и тросы к кольцу,
// за которое табличку держит цепь (или только ушки, если табличка висит на двух
// цепях). Снизу — ушки, на которых висят дочерние элементы.

// Суперэллипс |x/a|^n + |y/b|^n = 1: при n ≈ 6 — прямоугольник с мягкими углами.
function outline(a, b, n, segments) {
  const points = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    points.push(new THREE.Vector2(
      a * Math.sign(c) * Math.pow(Math.abs(c), 2 / n),
      b * Math.sign(s) * Math.pow(Math.abs(s), 2 / n),
    ));
  }
  return points;
}

const insideSuperellipse = (x, y, a, b, n) => Math.pow(x / a, n) + Math.pow(y / b, n) <= 1;

// Поле вокруг контейнера: наименьшее, при котором углы контейнера (с зазором)
// помещаются в контур стекла. Отсюда «табличка чуть больше контейнера».
function fitMargin(halfWidth, halfHeight, n) {
  const c = SIGN.clearance;
  let lo = SIGN.minMargin;
  let hi = Math.max(halfWidth, halfHeight);
  if (insideSuperellipse(halfWidth + c, halfHeight + c, halfWidth + lo, halfHeight + lo, n)) return lo;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (insideSuperellipse(halfWidth + c, halfHeight + c, halfWidth + mid, halfHeight + mid, n)) hi = mid;
    else lo = mid;
  }
  return hi;
}

// Выпуклое стекло: кольца суперэллипса, сжимающиеся к центру; высота растёт
// по параболе от края (edgeZ) к центру (edgeZ + bulge). side = 1 — лицо, −1 — оборот.
function lensGeometry(a, b, n, edgeZ, bulge, side, rings = 28, segments = 192) {
  const unit = outline(1, 1, n, segments);
  const positions = [];
  for (let r = 0; r < rings; r++) {
    const s = 1 - r / rings;
    const z = side * (edgeZ + bulge * (1 - s * s));
    for (const p of unit) positions.push(p.x * a * s, p.y * b * s, z);
  }
  const center = positions.length / 3;
  positions.push(0, 0, side * (edgeZ + bulge));

  const indices = [];
  const tri = (i, j, k) => (side > 0 ? indices.push(i, j, k) : indices.push(i, k, j));
  for (let r = 0; r < rings; r++) {
    for (let i = 0; i < segments; i++) {
      const a0 = r * segments + i;
      const a1 = r * segments + ((i + 1) % segments);
      if (r === rings - 1) {
        tri(a0, a1, center);
      } else {
        const b0 = a0 + segments;
        const b1 = a1 + segments;
        tri(a0, a1, b1);
        tri(a0, b1, b0);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function rimGeometry(outer, inner, depth) {
  const shape = new THREE.Shape(outer);
  shape.holes.push(new THREE.Path([...inner].reverse()));
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.005,
    bevelSize: 0.004,
    bevelSegments: 3,
  });
  geometry.translate(0, 0, -depth / 2);
  return geometry;
}

// Ширина контейнера, при которой табличка вместе с полями и ободом имеет
// внешнюю ширину width. Поле зависит от пропорций, поэтому подбирается.
function fitContentWidth(width, aspect, n) {
  const outer = (w) => w + 2 * fitMargin(w / 2, w / aspect / 2, n) + 2 * SIGN.lip;
  let lo = 0.05;
  let hi = width;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (outer(mid) > width) hi = mid;
    else lo = mid;
  }
  return lo;
}

// Неоновая табличка (content.glow — цвет неона): по контуру стекла светится
// трубка, раскалённая почти до белого в сердцевине, а содержимое ярче порога
// bloom, поэтому и трубка, и текст дают ореол.
const NEON = {
  inset: 0.022,       // от края стекла до оси трубки
  radius: 0.0055,     // радиус трубки
  core: 0.15,         // доля белого в цвете трубки
  intensity: 9,       // яркость трубки (HDR) — её подхватывает bloom
  face: 1.5,          // яркость содержимого
};

function neonTube(a, b, n, z, material) {
  const points = outline(a, b, n, 256).map((p) => new THREE.Vector3(p.x, p.y, z));
  const curve = new THREE.CatmullRomCurve3(points, true, 'centripetal');
  return new THREE.Mesh(new THREE.TubeGeometry(curve, 512, NEON.radius, 10, true), material);
}

// content — результат компоновки (layouts.js), width — внешняя ширина таблички,
// suspension — на скольких цепях она висит: 1 (за кольцо) или 2 (за ушки).
export function buildMetroSign({ content, width = SIGN.width, suspension = 1 }) {
  const n = SIGN.superellipse;
  const contentWidth = fitContentWidth(width, content.aspect, n);
  const contentHeight = contentWidth / content.aspect;
  const margin = fitMargin(contentWidth / 2, contentHeight / 2, n);

  // Контур стекла и внешний контур обода.
  const glassA = contentWidth / 2 + margin;
  const glassB = contentHeight / 2 + margin;
  const A = glassA + SIGN.lip;
  const B = glassB + SIGN.lip;
  const rimHalf = SIGN.rimDepth / 2;
  const glassEdgeZ = rimHalf - 0.008;

  const group = new THREE.Group();
  group.name = 'metro-sign';

  const metal = lit(new THREE.MeshStandardMaterial({ color: 0xd4d6db, metalness: 0.75, roughness: 0.3 }));
  const steel = lit(new THREE.MeshStandardMaterial({ color: 0x8e9096, metalness: 1, roughness: 0.35 }));
  // Стекло только отражает: тёмное само по себе, складывается с тем, что под ним.
  // Преломление (transmission) красивее, но перерисовывает всю сцену за стеклом
  // и на странице из нескольких табличек съедает больше всего времени кадра.
  const glass = lit(new THREE.MeshPhysicalMaterial({
    color: 0x000000,
    metalness: 0,
    roughness: 0.02,
    ior: 1.5,
    specularIntensity: 1,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  // Подсветка изнутри: фон и контейнер не зависят от освещения станции.
  const backing = new THREE.MeshBasicMaterial({ color: new THREE.Color(content.background) });
  const face = new THREE.MeshBasicMaterial({ map: content.texture });
  const backingColor = backing.color.clone();
  const faceLevel = content.glow ? NEON.face : 1;
  face.color.setScalar(faceLevel);
  const tubeColor = content.glow
    ? new THREE.Color(content.glow).lerp(new THREE.Color(1, 1, 1), NEON.core).multiplyScalar(NEON.intensity)
    : null;
  const tube = tubeColor && new THREE.MeshBasicMaterial({ color: tubeColor.clone() });

  const segments = 192;
  const rim = new THREE.Mesh(rimGeometry(outline(A, B, n, segments), outline(glassA, glassB, n, segments), SIGN.rimDepth), metal);
  group.add(rim);

  const panelShape = new THREE.Shape(outline(glassA, glassB, n, segments));
  for (const side of [1, -1]) {
    const lens = new THREE.Mesh(lensGeometry(glassA, glassB, n, glassEdgeZ, SIGN.bulge, side), glass);
    group.add(lens);

    const panel = new THREE.Mesh(new THREE.ShapeGeometry(panelShape), backing);
    panel.position.z = side * (glassEdgeZ - 0.014);
    if (side < 0) panel.rotation.y = Math.PI;
    group.add(panel);

    // Контейнер с содержимым; на обороте повёрнут, чтобы читался правильно.
    const container = new THREE.Mesh(new THREE.PlaneGeometry(contentWidth, contentHeight), face);
    container.position.z = side * (glassEdgeZ - 0.01);
    if (side < 0) container.rotation.y = Math.PI;
    group.add(container);

    if (tube) group.add(neonTube(glassA - NEON.inset, glassB - NEON.inset, n, side * (glassEdgeZ - 0.007), tube));
  }

  // Подвес: два ушка на ободе, тросы к кольцу над центром или по цепи на ушко.
  const eyeX = A * 0.62;
  const eyeY = B * Math.pow(1 - Math.pow(eyeX / A, n), 1 / n) + 0.016;
  const hooks = suspension === 2
    ? addTopEyes(group, steel, { eyeX, eyeY })
    : [addBridle(group, steel, { eyeX, eyeY, ringY: B + SIGN.bridleHeight })];

  const depth = SIGN.rimDepth + 2 * SIGN.bulge;
  return {
    group,
    hooks,
    halfExtents: new THREE.Vector3(A, B, depth / 2),
    mass: SIGN.mass,
    pickables: [...group.children],
    // Нижнее ушко в точке x (от центра таблички); возвращает точку подвеса
    // для того, что будет висеть ниже.
    addAnchor(x) {
      const edgeY = B * Math.pow(1 - Math.pow(Math.min(Math.abs(x) / A, 0.95), n), 1 / n);
      return addHangerEye(group, steel, x, -edgeY);
    },
    // Подсветка при наведении: табличка светится чуть ярче.
    highlight(on) {
      const k = on ? 1.18 : 1;
      face.color.setScalar(k * faceLevel);
      backing.color.copy(backingColor).multiplyScalar(k);
      tube?.color.copy(tubeColor).multiplyScalar(k);
    },
    dispose() {
      group.traverse((o) => o.geometry?.dispose());
      for (const material of [metal, steel, glass, backing, face, tube]) material?.dispose();
      content.texture.dispose();
    },
  };
}
