import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { STATION, TRAINS } from '../config.js';
import { carInteriorTextures, liveryTextures } from './textures.js';
import { lit } from './lamps.js';

// Поезда на обоих путях. Состав бесконечный: вагоны одинаковые, поэтому
// движение — это сдвиг всей сцепки по модулю длины вагона. Двери нарисованы
// на борту; для посадки (boarding.js) одни двери становятся настоящими:
// борт вокруг них вырезается, створки разъезжаются, за ними — салон.

const HALF_WIDTH = 1.33;
const SKIN = HALF_WIDTH + 0.004; // картинка борта (окна, двери) чуть снаружи кузова
const BOTTOM = -0.3;
const SIDE_TOP = 2.2;
const ROOF = 2.64;
// Салон: от оси вагона до стены, от пола до потолка, вдоль вагона.
const CABIN = { halfWidth: 1.22, height: 2.28, length: 18.6 };
const LEAF_DEPTH = 0.03;
const POCKET = 0.04; // открытая створка уходит в стену дальше края проёма на столько

// Вырез в борту: материалы кузова и борта не рисуют то, что внутри коробки
// (clipIntersection — отсекается пересечение плоскостей, то есть внутренность
// коробки). Плоскости заданы с самого начала, коробка — далеко под платформой:
// шейдеры собираются при загрузке, а не в момент посадки.
const cut = [0, 1, 2, 3, 4, 5].map(() => new THREE.Plane());
function setCut(min, max) {
  cut[0].set(new THREE.Vector3(1, 0, 0), -max.x);
  cut[1].set(new THREE.Vector3(-1, 0, 0), min.x);
  cut[2].set(new THREE.Vector3(0, 1, 0), -max.y);
  cut[3].set(new THREE.Vector3(0, -1, 0), min.y);
  cut[4].set(new THREE.Vector3(0, 0, 1), -max.z);
  cut[5].set(new THREE.Vector3(0, 0, -1), min.z);
}
const noCut = () => setCut(new THREE.Vector3(0, -60, 0), new THREE.Vector3(0.1, -59.9, 0.1));
noCut();

function bodyGeometry(length) {
  const w = HALF_WIDTH;
  const shape = new THREE.Shape();
  shape.moveTo(-w, BOTTOM);
  shape.lineTo(w, BOTTOM);
  shape.lineTo(w, SIDE_TOP);
  shape.quadraticCurveTo(w, ROOF - 0.02, w - 0.55, ROOF);
  shape.lineTo(-w + 0.55, ROOF);
  shape.quadraticCurveTo(-w, ROOF - 0.02, -w, SIDE_TOP);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false, curveSegments: 10 });
  geometry.translate(0, 0, -length / 2);
  return geometry;
}

function sidesGeometry(length) {
  const height = SIDE_TOP - BOTTOM;
  const right = new THREE.PlaneGeometry(length, height).rotateY(Math.PI / 2);
  right.translate(SKIN, (SIDE_TOP + BOTTOM) / 2, 0);
  const left = new THREE.PlaneGeometry(length, height).rotateY(-Math.PI / 2);
  left.translate(-SKIN, (SIDE_TOP + BOTTOM) / 2, 0);
  return mergeGeometries([right, left]);
}

function runningGearGeometry(length, gap) {
  const parts = [];
  parts.push(new THREE.BoxGeometry(2.3, 0.5, length - 1).translate(0, -0.55, 0));
  for (const z of [-(length / 2 - 3.2), length / 2 - 3.2]) {
    parts.push(new THREE.BoxGeometry(2.25, 0.42, 2.6).translate(0, -0.82, z));
  }
  // Межвагонный переход.
  parts.push(new THREE.BoxGeometry(2.1, 2.3, gap + 0.1).translate(0, 1.0, (length + gap) / 2));
  // Крышевое оборудование: вентиляция и кондиционеры.
  for (const z of [-6.2, 0, 6.2]) {
    parts.push(new THREE.BoxGeometry(1.5, 0.16, 2.2).translate(0, ROOF + 0.06, z));
  }
  for (const z of [-3.1, 3.1]) {
    parts.push(new THREE.BoxGeometry(0.9, 0.08, 1.2).translate(0, ROOF + 0.02, z));
  }
  return mergeGeometries(parts);
}

export function buildTrains() {
  const { carLength, carGap, arrivalSpeed, arrivalTime } = TRAINS;
  const pitch = carLength + carGap;
  const count = Math.ceil(STATION.length / pitch) + 2;
  const livery = liveryTextures(carLength);

  const geometries = [bodyGeometry(carLength), sidesGeometry(carLength), runningGearGeometry(carLength, carGap)];
  const materials = [
    lit(new THREE.MeshStandardMaterial({ color: 0x8f949c, metalness: 0.55, roughness: 0.45 })),
    lit(new THREE.MeshStandardMaterial({
      map: livery.map,
      emissiveMap: livery.emissiveMap,
      emissive: 0xffffff,
      emissiveIntensity: 1.25,
      metalness: 0.35,
      roughness: 0.32,
    })),
    lit(new THREE.MeshStandardMaterial({ color: 0x1d1e22, metalness: 0.3, roughness: 0.7 })),
  ];
  // В кузове и борте прорезается проём настоящих дверей.
  for (const material of materials.slice(0, 2)) {
    material.clippingPlanes = cut;
    material.clipIntersection = true;
  }

  const group = new THREE.Group();
  group.name = 'trains';
  const sides = [];
  const matrix = new THREE.Matrix4();
  // Правостороннее движение: слева поезд едет к зрителю (+Z), справа — от него.
  for (const [x, direction] of [[-STATION.trackX, 1], [STATION.trackX, -1]]) {
    const train = new THREE.Group();
    train.position.x = x;
    geometries.forEach((geometry, index) => {
      const mesh = new THREE.InstancedMesh(geometry, materials[index], count);
      for (let i = 0; i < count; i++) {
        mesh.setMatrixAt(i, matrix.makeTranslation(0, 0, (i - count / 2) * pitch));
      }
      mesh.frustumCulled = false;
      train.add(mesh);
    });
    group.add(train);
    sides.push({ train, direction });
  }

  const deceleration = arrivalSpeed / arrivalTime;
  let doorway = null;
  return {
    group,
    // t — секунды с начала сцены; поезда подъезжают и останавливаются.
    update(t) {
      const time = Math.min(t, arrivalTime);
      const travel = arrivalSpeed * time - 0.5 * deceleration * time * time;
      for (const { train, direction } of sides) {
        train.position.z = THREE.MathUtils.euclideanModulo(direction * travel, pitch);
      }
    },
    // Двери вагонов, обращённые к платформе, с осью между zMin и zMax:
    // { x — поверхность борта, z — ось дверей, side — путь (−1 левый, 1 правый),
    //   track — x оси пути, car — середина вагона по z }.
    platformDoors(zMin, zMax) {
      const doors = [];
      for (const { train } of sides) {
        const side = Math.sign(train.position.x);
        for (let i = 0; i < count; i++) {
          const car = train.position.z + (i - count / 2) * pitch;
          for (const m of TRAINS.doors) {
            // К платформе обращены правый борт левого поезда и левый борт правого:
            // картинка борта идёт по ним в разные стороны.
            const z = car + (side < 0 ? carLength / 2 - m : m - carLength / 2);
            if (z >= zMin && z <= zMax) doors.push({ x: train.position.x - side * SKIN, z, side, track: train.position.x, car });
          }
        }
      }
      return doors;
    },
    // Сделать двери door настоящими: борт вокруг проёма вырезается, в проёме —
    // створки, за ними — салон. Возвращает { open(k) — насколько двери открыты,
    // 0…1; close() — снова нарисованные двери }. Настоящие двери одни на станции.
    doorway(door) {
      doorway?.close();
      const opened = buildDoorway(door, livery.leaf, () => {
        if (doorway === opened) doorway = null;
      });
      doorway = opened;
      group.add(opened.group);
      return opened;
    },
  };
}

// Проём дверей door со створками и салоном за ним; onClose — когда его убрали.
function buildDoorway(door, leafTextures, onClose) {
  const { doorHalf, doorBottom, doorTop } = TRAINS;
  const height = doorTop - doorBottom;
  const group = new THREE.Group();
  group.name = 'doorway';
  const disposables = [];
  const keep = (item) => {
    disposables.push(item);
    return item;
  };

  setCut(
    new THREE.Vector3(door.x - 0.03, doorBottom, door.z - doorHalf),
    new THREE.Vector3(door.x + 0.03, doorTop, door.z + doorHalf),
  );

  // Оси проёма: x — вдоль вагона (вправо для того, кто стоит на платформе),
  // z — наружу, к платформе; z = 0 — картинка борта.
  const frame = new THREE.Group();
  frame.position.set(door.x, 0, door.z);
  frame.rotation.y = (-door.side * Math.PI) / 2;
  group.add(frame);

  const edge = keep(lit(new THREE.MeshStandardMaterial({ color: 0x2a2b30, metalness: 0.5, roughness: 0.5 })));
  const face = keep(lit(new THREE.MeshStandardMaterial({
    map: leafTextures.map,
    emissiveMap: leafTextures.emissiveMap,
    emissive: 0xffffff,
    emissiveIntensity: 1.25,
    metalness: 0.35,
    roughness: 0.32,
  })));
  const sill = keep(lit(new THREE.MeshStandardMaterial({ color: 0x9a9da3, metalness: 0.8, roughness: 0.35 })));

  // Створки — от края проёма до середины щели — утоплены за кузов: открываясь,
  // уходят в стену. Правая — зеркало левой.
  const leafGeometry = keep(new THREE.BoxGeometry(doorHalf, height, LEAF_DEPTH));
  const leaves = [-1, 1].map((sign) => {
    const leaf = new THREE.Mesh(leafGeometry, [edge, edge, edge, edge, face, face]);
    leaf.scale.x = sign;
    leaf.position.set((sign * doorHalf) / 2, doorBottom + height / 2, -0.01 - LEAF_DEPTH / 2);
    frame.add(leaf);
    return leaf;
  });

  // Толщина стены по краям проёма и порог — за картинкой борта, видны только в проёме.
  const reveal = 0.114;
  const back = -0.006 - reveal / 2;
  const jambs = keep(mergeGeometries([
    new THREE.BoxGeometry(0.05, height + 0.05, reveal).translate(-doorHalf - 0.025, doorBottom + height / 2, back),
    new THREE.BoxGeometry(0.05, height + 0.05, reveal).translate(doorHalf + 0.025, doorBottom + height / 2, back),
    new THREE.BoxGeometry(doorHalf * 2 + 0.1, 0.05, reveal).translate(0, doorTop + 0.025, back),
  ]));
  frame.add(new THREE.Mesh(jambs, edge));
  frame.add(new THREE.Mesh(keep(new THREE.BoxGeometry(doorHalf * 2, 0.03, 0.2).translate(0, doorBottom - 0.015, -0.106)), sill));

  group.add(buildCabin(door, keep));

  return {
    group,
    open(k) {
      const shift = doorHalf / 2 + k * (doorHalf + POCKET);
      leaves[0].position.x = -shift;
      leaves[1].position.x = shift;
    },
    close() {
      noCut();
      group.removeFromParent();
      disposables.forEach((item) => item.dispose());
      onClose();
    },
  };
}

// Салон вагона дверей door: коробка изнутри (стены, пол, потолок), сиденья
// вдоль стен между дверями, поручни, светильники. Свет в салоне свой: стены
// и потолок светятся ровно, сиденья и поручни освещают ещё и лампы станции.
// keep(item) — освободить, когда салон уберут.
function buildCabin(door, keep) {
  const { halfWidth: w, height: h, length } = CABIN;
  const { doorBottom: floor, carLength } = TRAINS;
  const cabin = new THREE.Group();
  // Ось x салона — к платформе.
  cabin.position.set(door.track, 0, door.car);
  cabin.rotation.y = door.side < 0 ? 0 : Math.PI;

  const textures = carInteriorTextures(length, h);
  textures.floor.repeat.set(w * 4, length * 2);
  Object.values(textures).forEach(keep);
  const wall = keep(new THREE.MeshBasicMaterial({ map: textures.wall, side: THREE.BackSide }));
  const end = keep(new THREE.MeshBasicMaterial({ map: textures.end, side: THREE.BackSide }));
  const ceiling = keep(new THREE.MeshBasicMaterial({ color: 0xe6e1d6, side: THREE.BackSide }));
  const ground = keep(new THREE.MeshBasicMaterial({ map: textures.floor, side: THREE.BackSide }));
  const box = keep(new THREE.BoxGeometry(w * 2, h, length).translate(0, floor + h / 2, 0));
  cabin.add(new THREE.Mesh(box, [wall, wall, ceiling, ground, end, end]));

  // Оси дверей в салоне: на обоих путях z = L/2 − m (салон правого пути развёрнут).
  const doors = TRAINS.doors.map((m) => carLength / 2 - m).sort((a, b) => a - b);
  const clear = 0.85; // от оси дверей до сиденья и стойки
  const spans = [-length / 2, ...doors.flatMap((z) => [z - clear, z + clear]), length / 2];
  const seats = [];
  const bases = [];
  const chrome = [];
  for (let i = 0; i < spans.length; i += 2) {
    const [a, b] = [spans[i], spans[i + 1]];
    const z = (a + b) / 2;
    for (const x of [-1, 1]) {
      seats.push(new THREE.BoxGeometry(0.46, 0.1, b - a).translate(x * (w - 0.24), floor + 0.47, z));
      seats.push(new THREE.BoxGeometry(0.07, 0.42, b - a).translate(x * (w - 0.035), floor + 0.73, z));
      bases.push(new THREE.BoxGeometry(0.36, 0.42, b - a - 0.1).translate(x * (w - 0.2), floor + 0.21, z));
    }
  }
  for (const z of doors) {
    for (const x of [-1, 1]) {
      for (const dz of [-clear, clear]) {
        chrome.push(new THREE.CylinderGeometry(0.018, 0.018, h, 10).translate(x * (w - 0.5), floor + h / 2, z + dz));
      }
    }
  }
  for (const x of [-1, 1]) {
    chrome.push(new THREE.CylinderGeometry(0.016, 0.016, length - 0.4, 8).rotateX(Math.PI / 2).translate(x * (w - 0.45), floor + 1.88, 0));
  }
  const lights = [];
  for (let z = -length / 2 + 1.2; z < length / 2 - 1.6; z += 2) {
    for (const x of [-1, 1]) lights.push(new THREE.BoxGeometry(0.16, 0.03, 1.6).translate(x * 0.5, floor + h - 0.015, z + 0.8));
  }

  const parts = [
    [seats, lit(new THREE.MeshStandardMaterial({ color: 0x4b3fb8, emissive: 0x4b3fb8, emissiveIntensity: 0.25, roughness: 0.75 }))],
    [bases, lit(new THREE.MeshStandardMaterial({ color: 0x3a3836, roughness: 0.8 }))],
    [chrome, lit(new THREE.MeshStandardMaterial({ color: 0xd4d7dc, metalness: 0.9, roughness: 0.25 }))],
    [lights, new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.95, 0.86).multiplyScalar(2.4) })],
  ];
  for (const [geometries, material] of parts) {
    const merged = keep(mergeGeometries(geometries));
    geometries.forEach((geometry) => geometry.dispose());
    cabin.add(new THREE.Mesh(merged, keep(material)));
  }
  return cabin;
}
