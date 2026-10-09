import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LAMPS, PAGES, STATION } from '../config.js';
import * as textures from './textures.js';
import { lit } from './lamps.js';
import { buildTrains } from './trains.js';

// Процедурная станция-параллелепипед: островная платформа, по бокам пути
// с поездами, колонны, кессонный потолок с рядами светильников.

function scaleUV(geometry, su, sv) {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return geometry;
}

function instanced(geometry, material, positions) {
  const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
  const matrix = new THREE.Matrix4();
  positions.forEach(([x, y, z], i) => mesh.setMatrixAt(i, matrix.makeTranslation(x, y, z)));
  mesh.frustumCulled = false;
  return mesh;
}

// Плоскость вдоль станции. facing: 'up' | 'down' | '+x' | '-x'.
function strip(width, height, facing) {
  const geometry = new THREE.PlaneGeometry(width, height);
  if (facing === 'up') geometry.rotateX(-Math.PI / 2);
  if (facing === 'down') geometry.rotateX(Math.PI / 2);
  if (facing === '+x') geometry.rotateY(Math.PI / 2);
  if (facing === '-x') geometry.rotateY(-Math.PI / 2);
  return geometry;
}

// hatches — точки на потолке (Vector3), где над страницами нужны люки.
export function buildStation({ hatches = [] } = {}) {
  const S = STATION;
  const L = S.length;
  const group = new THREE.Group();
  group.name = 'station';

  const tex = {
    floor: textures.floorTexture(),
    wall: textures.wallTexture({ bottom: S.trackBed, top: S.ceiling }),
    column: textures.columnTexture(),
    plaster: textures.plasterTexture(),
    concrete: textures.concreteTexture(),
    darkGranite: textures.darkGraniteTexture(),
    edgeGranite: textures.edgeGraniteTexture(),
  };

  const mat = {
    floor: lit(new THREE.MeshStandardMaterial({ map: tex.floor, roughness: 0.14, metalness: 0 })),
    wall: lit(new THREE.MeshStandardMaterial({ map: tex.wall, roughness: 0.3 })),
    column: lit(new THREE.MeshStandardMaterial({ map: tex.column, roughness: 0.2 })),
    plaster: lit(new THREE.MeshStandardMaterial({ map: tex.plaster, roughness: 0.85 })),
    concrete: lit(new THREE.MeshStandardMaterial({ map: tex.concrete, roughness: 0.95 })),
    sleeper: lit(new THREE.MeshStandardMaterial({ map: tex.concrete, color: 0xb8b2aa, roughness: 0.9 })),
    darkGranite: lit(new THREE.MeshStandardMaterial({ map: tex.darkGranite, roughness: 0.25 })),
    edgeGranite: lit(new THREE.MeshStandardMaterial({ map: tex.edgeGranite, roughness: 0.3 })),
    rail: lit(new THREE.MeshStandardMaterial({ color: 0x8d8780, metalness: 0.85, roughness: 0.32 })),
    brass: lit(new THREE.MeshStandardMaterial({ color: 0xa8895a, metalness: 0.9, roughness: 0.33 })),
    fixture: lit(new THREE.MeshStandardMaterial({ color: 0x2a2a2d, metalness: 0.7, roughness: 0.4 })),
    cover: lit(new THREE.MeshStandardMaterial({ color: 0x3b3d38, roughness: 0.8 })),
    // Рассеиватель светильника: светится сам и уходит в bloom.
    diffuser: new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(...LAMPS.color).multiplyScalar(3.2) }),
  };

  const add = (geometry, material, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };

  // Шаг пролётов: светильники в серединах пролётов (z = k·bay), колонны и балки — на границах.
  const half = Math.floor(L / 2 / S.bay);
  const bayCenters = [];
  for (let k = -half; k <= half; k++) bayCenters.push(k * S.bay);
  const bayEdges = bayCenters.map((z) => z + S.bay / 2);

  // Платформа.
  add(scaleUV(strip(S.platformHalf * 2, L, 'up'), 1, L / S.bay), mat.floor);
  for (const side of [-1, 1]) {
    const facing = side > 0 ? '+x' : '-x';
    add(scaleUV(strip(L, 0.25, facing), L / 2, 1), mat.edgeGranite, side * S.platformHalf, -0.125, 0);
    // Ниша под краем платформы.
    add(scaleUV(strip(L, -0.25 - S.trackBed, facing), L / 3, 0.4), mat.concrete, side * (S.platformHalf - 0.4), (S.trackBed - 0.25) / 2, 0);
    add(scaleUV(strip(0.4, L, 'down'), 0.15, L / 3), mat.concrete, side * (S.platformHalf - 0.2), -0.25, 0);
  }

  // Пути.
  const bedWidth = S.wallX - S.platformHalf + 0.4;
  const sleeperPositions = [];
  for (const side of [-1, 1]) {
    const x = side * S.trackX;
    add(scaleUV(strip(bedWidth, L, 'up'), bedWidth / 3, L / 3), mat.concrete, side * (S.wallX - bedWidth / 2), S.trackBed, 0);
    for (let z = -L / 2; z < L / 2; z += 0.6) sleeperPositions.push([x, S.trackBed + 0.07, z]);
    for (const offset of [-0.7615, 0.7615]) {
      add(new THREE.BoxGeometry(0.07, 0.19, L), mat.rail, x + offset, S.railTop - 0.095, 0);
    }
    // Контактный рельс с защитным коробом — со стороны стены.
    add(new THREE.BoxGeometry(0.09, 0.12, L), mat.rail, x + side * 1.6, S.railTop + 0.02, 0);
    add(new THREE.BoxGeometry(0.3, 0.025, L), mat.cover, x + side * 1.62, S.railTop + 0.14, 0);
  }
  group.add(instanced(new THREE.BoxGeometry(2.6, 0.14, 0.26), mat.sleeper, sleeperPositions));

  // Путевые стены и потолок.
  const wallHeight = S.ceiling - S.trackBed;
  for (const side of [-1, 1]) {
    const facing = side > 0 ? '-x' : '+x';
    add(scaleUV(strip(L, wallHeight, facing), L / 3, 1), mat.wall, side * S.wallX, (S.ceiling + S.trackBed) / 2, 0);
  }
  add(scaleUV(strip(S.wallX * 2, L, 'down'), 7, L / 3), mat.plaster, 0, S.ceiling, 0);

  // Кессоны: поперечные балки на каждой границе пролёта и продольные над рядами колонн.
  const beamY = S.ceiling - S.beamDepth / 2;
  group.add(instanced(
    scaleUV(new THREE.BoxGeometry(S.wallX * 2, S.beamDepth, 0.45), 7, 0.2),
    mat.plaster,
    bayEdges.map((z) => [0, beamY, z]),
  ));
  for (const side of [-1, 1]) {
    add(scaleUV(new THREE.BoxGeometry(0.75, S.beamDepth, L), L / 3, 0.2), mat.plaster, side * S.columnX, beamY, 0);
  }

  // Колонны: гранитная база, мраморный ствол, латунная капитель.
  const bottomOfBeam = S.ceiling - S.beamDepth;
  const shaftBottom = 0.3;
  const shaftTop = bottomOfBeam - 0.4;
  const columnSpots = [];
  for (const side of [-1, 1]) for (const z of bayEdges) columnSpots.push([side * S.columnX, z]);
  group.add(instanced(new THREE.BoxGeometry(0.88, shaftBottom, 0.88), mat.darkGranite,
    columnSpots.map(([x, z]) => [x, shaftBottom / 2, z])));
  group.add(instanced(new THREE.BoxGeometry(S.columnSize, shaftTop - shaftBottom, S.columnSize), mat.column,
    columnSpots.map(([x, z]) => [x, (shaftTop + shaftBottom) / 2, z])));
  const capital = mergeGeometries([
    new THREE.BoxGeometry(0.8, 0.1, 0.8).translate(0, 0.05, 0),
    new THREE.CylinderGeometry(0.62 * Math.SQRT2, 0.4 * Math.SQRT2, 0.3, 4, 1).rotateY(Math.PI / 4).translate(0, 0.25, 0),
  ]);
  group.add(instanced(capital, mat.brass, columnSpots.map(([x, z]) => [x, shaftTop, z])));

  // Светильники: тёмный корпус и светящийся рассеиватель.
  const lampSpots = [];
  for (const x of LAMPS.xs) for (const z of bayCenters) lampSpots.push([x, z]);
  group.add(instanced(new THREE.CylinderGeometry(0.5, 0.5, 0.08, 40), mat.fixture,
    lampSpots.map(([x, z]) => [x, S.ceiling - 0.04, z])));
  group.add(instanced(new THREE.CylinderGeometry(0.42, 0.42, 0.04, 40), mat.diffuser,
    lampSpots.map(([x, z]) => [x, S.ceiling - 0.09, z])));

  const trains = buildTrains();
  group.add(trains.group);

  // Люки над страницами: через них страницы спускаются и уезжают за потолок.
  // Анкерная точка цепи — в центре люка. Под широкую страницу люк расширяется.
  const [hatchX, hatchZ] = PAGES.hatch;
  const opening = new THREE.MeshBasicMaterial({ color: 0x060504 });
  const hatchList = hatches.map((point) => {
    const hole = add(strip(1, hatchZ, 'down'), opening, point.x, S.ceiling - 0.004, point.z);
    const rails = [-1, 1].map((side) => add(new THREE.BoxGeometry(1, 0.05, 0.06), mat.fixture, point.x, S.ceiling - 0.025, point.z + side * (hatchZ / 2 + 0.03)));
    const ends = [-1, 1].map((side) => add(new THREE.BoxGeometry(0.06, 0.05, hatchZ), mat.fixture, point.x, S.ceiling - 0.025, point.z));
    const fit = (width) => {
      hole.scale.x = width;
      rails.forEach((rail) => { rail.scale.x = width + 0.12; });
      ends.forEach((end, i) => { end.position.x = point.x + (i ? 1 : -1) * (width / 2 + 0.03); });
    };
    fit(hatchX);
    return { point, fit };
  });

  return {
    group,
    trains,
    update(t) {
      trains.update(t);
    },
    // Люк над точкой point не уже, чем нужно странице шириной width.
    fitHatch(point, width) {
      hatchList.find((hatch) => hatch.point.distanceTo(point) < 1e-6)?.fit(Math.max(hatchX, width + PAGES.hatchMargin));
    },
  };
}
