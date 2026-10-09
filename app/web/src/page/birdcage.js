import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BIRDCAGE } from '../config.js';
import { lit } from '../station/lamps.js';
import { random } from '../station/noise.js';
import { addHangerEye, rodGeometry } from './hardware.js';
import { isEmpty } from './scheme.js';
import { createTextField } from './textField.js';

// «Oblong birdcage»: продолговатая латунная клетка со сводом на лакированном поддоне.
// Это поле для пароля: по клику клетка получает фокус, каждый набранный символ —
// белый шарик, который падает внутрь и катается по дну, Backspace — шарик исчезает.
// Шарики — тела Rapier, стенки клетки — коллайдеры на её теле, поэтому шарики
// перекатываются, когда клетка качается на цепи. Layout «Headline only»: текст
// в клетке — пароль, показанный шариками.

// Группы столкновений Rapier: старшие 16 бит — в каких группах коллайдер,
// младшие — с какими группами сталкивается. Цепи и корпуса объектов — в группе 1
// без фильтра, поэтому шарики их не замечают.
const CAGE = 0b0010;
const BALLS = 0b0100;
const CAGE_GROUPS = (CAGE << 16) | BALLS;
const BALL_GROUPS = (BALLS << 16) | (CAGE | BALLS);

const SPAWN_INTERVAL = 0.045; // вставленный пароль сыплется шариками по одному
const POP_IN = 0.14;
const POP_OUT = 0.2;
const WALL = 0.02;            // половина толщины стенок-коллайдеров

// Свод: полуэллипс поперёк клетки в плоскости x = const.
class RoofArc extends THREE.Curve {
  constructor(x, springY, halfDepth, rise) {
    super();
    Object.assign(this, { x, springY, halfDepth, rise });
  }

  getPoint(t, target = new THREE.Vector3()) {
    const a = Math.PI * t;
    return target.set(this.x, this.springY + this.rise * Math.sin(a), this.halfDepth * Math.cos(a));
  }
}

const easeOutBack = (t) => 1 + 2.4 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2);
const smooth = (t) => t * t * (3 - 2 * t);

export function buildBirdcage({ element, width, label = '' }) {
  if (element.Layout !== 'Headline only') {
    throw new Error(`Oblong birdcage умеет только Layout «Headline only», у элемента ${element.id} — «${element.Layout}»`);
  }
  const C = BIRDCAGE;
  const R = C.ball.radius;
  const L = Math.min(C.length, width);
  const hd = C.depth / 2;
  const height = C.base + C.wall + C.roof;
  const bottom = -height / 2;
  const floorY = bottom + C.base;
  const springY = floorY + C.wall;
  const topY = springY + C.roof;

  const group = new THREE.Group();
  group.name = 'birdcage';
  const brass = lit(new THREE.MeshStandardMaterial({ color: 0xc9a253, metalness: 1, roughness: 0.3 }));
  const lacquer = lit(new THREE.MeshStandardMaterial({ color: 0x1d1b1a, metalness: 0.15, roughness: 0.38 }));

  // ---- Прутья (одна геометрия) ----------------------------------------------

  const parts = [];
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  const rodLoop = (points, radius) => points.forEach((p, k) => parts.push(rodGeometry(p, points[(k + 1) % points.length], radius, 6)));

  // Дуги: прут поднимается спереди, перекидывается через свод и опускается сзади.
  const hoops = Math.max(2, Math.round(L / C.barSpacing));
  for (let i = 0; i <= hoops; i++) {
    const x = -L / 2 + (L * i) / hoops;
    const path = new THREE.CurvePath();
    path.add(new THREE.LineCurve3(v(x, floorY, hd), v(x, springY, hd)));
    path.add(new RoofArc(x, springY, hd, C.roof));
    path.add(new THREE.LineCurve3(v(x, springY, -hd), v(x, floorY, -hd)));
    parts.push(new THREE.TubeGeometry(path, 48, C.bar, 6, false));
  }
  // Торцы: прямые прутья до свода.
  const endBars = Math.max(2, Math.round(C.depth / C.barSpacing));
  for (const x of [-L / 2, L / 2]) {
    for (let j = 1; j < endBars; j++) {
      const z = -hd + (C.depth * j) / endBars;
      parts.push(rodGeometry(v(x, floorY, z), v(x, springY + C.roof * Math.sqrt(1 - (z / hd) ** 2), z), C.bar, 6));
    }
  }
  // Обручи по периметру и продольные прутья по своду.
  for (const y of [floorY + 0.012, floorY + 0.07, springY - C.wall * 0.42, springY]) {
    rodLoop([v(-L / 2, y, hd), v(L / 2, y, hd), v(L / 2, y, -hd), v(-L / 2, y, -hd)], C.bar * 1.35);
  }
  for (const a of [Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4]) {
    const y = springY + C.roof * Math.sin(a);
    const z = hd * Math.cos(a);
    parts.push(rodGeometry(v(-L / 2, y, z), v(L / 2, y, z), C.bar * 1.35, 6));
  }
  // Дверца спереди: рамка из прута потолще и колечко задвижки.
  const door = { half: 0.11, bottom: floorY + 0.07, top: springY - C.wall * 0.42, z: hd + C.bar * 2.4 };
  rodLoop([
    v(-door.half, door.bottom, door.z), v(door.half, door.bottom, door.z),
    v(door.half, door.top, door.z), v(-door.half, door.top, door.z),
  ], C.bar * 1.7);
  parts.push(new THREE.TorusGeometry(0.012, 0.0026, 8, 18).translate(door.half + 0.013, (door.bottom + door.top) / 2, door.z));
  // Навершие: шишечка на коньке, стержень и кольцо, за которое клетку держит цепь.
  parts.push(new THREE.SphereGeometry(0.024, 16, 10).scale(1, 0.75, 1).translate(0, topY + 0.008, 0));
  parts.push(rodGeometry(v(0, topY, 0), v(0, topY + 0.055, 0), 0.0055, 8));
  const ringY = topY + 0.055 + 0.03;
  parts.push(new THREE.TorusGeometry(0.03, 0.006, 10, 28).rotateY(Math.PI / 2).translate(0, ringY, 0));
  const hook = v(0, ringY + 0.03, 0);

  group.add(new THREE.Mesh(mergeGeometries(parts), brass));
  parts.forEach((geometry) => geometry.dispose());

  // Поддон с латунными кантами.
  const box = (w, h, d, material, y) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.y = y;
    group.add(mesh);
    return mesh;
  };
  const plinth = box(L + 0.05, C.base, C.depth + 0.05, lacquer, bottom + C.base / 2);
  box(L + 0.062, 0.014, C.depth + 0.062, brass, floorY - 0.007);
  box(L + 0.062, 0.01, C.depth + 0.062, brass, bottom + 0.005);

  // По тонким прутьям трудно попасть курсором: клик ловит невидимая оболочка.
  const hull = new THREE.Mesh(new THREE.BoxGeometry(L + 0.06, topY - bottom, C.depth + 0.06), new THREE.MeshBasicMaterial());
  hull.position.y = (topY + bottom) / 2;
  hull.visible = false;
  group.add(hull);

  // ---- Шарики ---------------------------------------------------------------

  const input = createTextField({
    type: 'password',
    autocomplete: 'new-password',
    label,
    maxLength: C.maxLength,
    value: isEmpty(element.title) ? '' : String(element.title),
  });

  const ballGeometry = new THREE.SphereGeometry(R, 24, 16);
  const ballMaterial = lit(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.28, emissive: 0xffffff, emissiveIntensity: 0.12 }));
  const capacity = C.maxLength * 2;
  const ballMesh = new THREE.InstancedMesh(ballGeometry, ballMaterial, capacity);
  ballMesh.count = 0;
  ballMesh.frustumCulled = false;
  group.add(ballMesh);

  // Пока клетка в фокусе, под сводом мерцает следующий шарик — как курсор.
  const ghostMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
  const ghost = new THREE.Mesh(ballGeometry, ghostMaterial);
  ghost.visible = false;
  group.add(ghost);

  // Внутренние стенки, в которые упираются шарики: чуть внутри прутьев.
  const inX = L / 2 - C.bar * 1.5;
  const inZ = hd - C.bar * 1.5;
  const inRise = C.roof - C.bar * 1.5;

  const rnd = random(77 + Number(element.id));
  const nextSpawn = new THREE.Vector3();
  const pickSpawn = () => {
    const z = (rnd() - 0.5) * 0.6 * inZ;
    nextSpawn.set((rnd() * 2 - 1) * (inX - R - 0.06), springY + inRise * Math.sqrt(1 - (z / inZ) ** 2) - R - 0.012, z);
  };
  pickSpawn();

  let physics = null;
  let body = null;
  const balls = [];   // { body, age, dying } — dying < 0, пока шарик жив
  let queued = 0;
  let cooldown = 0;
  let time = 0;

  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const inverse = new THREE.Quaternion();
  const local = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const still = new THREE.Quaternion();

  // Мировая точка и скорость клетки в ней для точки p в координатах клетки.
  const toWorld = (p) => {
    position.copy(body.translation());
    rotation.copy(body.rotation());
    const world = p.clone().applyQuaternion(rotation).add(position);
    const w = body.angvel();
    const u = body.linvel();
    const r = world.clone().sub(position);
    const velocity = new THREE.Vector3(w.x, w.y, w.z).cross(r).add(new THREE.Vector3(u.x, u.y, u.z));
    return { world, velocity };
  };

  function spawn() {
    const { RAPIER, world } = physics;
    const { world: p, velocity } = toWorld(nextSpawn);
    const ball = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(p.x, p.y, p.z)
      .setLinvel(velocity.x, velocity.y - 0.3, velocity.z)
      .setLinearDamping(0.05)
      .setAngularDamping(0.6)
      .setCcdEnabled(true));
    world.createCollider(RAPIER.ColliderDesc.ball(R)
      .setMass(C.ball.mass)
      .setRestitution(0.5)
      .setFriction(0.45)
      .setCollisionGroups(BALL_GROUPS), ball);
    balls.push({ body: ball, age: 0, dying: -1 });
    pickSpawn();
  }

  // Число живых шариков догоняет длину пароля: лишние исчезают с конца.
  function follow(length) {
    const alive = balls.reduce((n, ball) => n + (ball.dying < 0 ? 1 : 0), 0) + queued;
    if (length > alive) queued += length - alive;
    let extra = alive - length;
    const fromQueue = Math.min(queued, Math.max(0, extra));
    queued -= fromQueue;
    extra -= fromQueue;
    for (let i = balls.length - 1; i >= 0 && extra > 0; i--) {
      if (balls[i].dying < 0) {
        balls[i].dying = 0;
        extra--;
      }
    }
  }

  const escaped = (p) => Math.abs(p.x) > L / 2 + 0.2 || Math.abs(p.z) > hd + 0.2 || p.y < bottom - 0.2 || p.y > topY + 0.3;

  return {
    group,
    hook,
    halfExtents: new THREE.Vector3(L / 2 + 0.03, height / 2, hd + 0.03),
    mass: C.mass,
    pickables: [hull, plinth],
    addAnchor: (x) => addHangerEye(group, brass, x, bottom),
    highlight() {},
    field: {
      focus(hit, x, y) {
        input.focus({ x, y });
      },
      get focused() {
        return input.focused;
      },
      get value() {
        return input.value;
      },
    },
    // Тело клетки появляется, когда её повесили на цепь: к нему крепятся стенки.
    attach({ physics: p, body: b }) {
      physics = p;
      body = b;
      const { RAPIER, world } = physics;
      const wall = (hx, hy, hz, x, y, z, turn = 0) => {
        const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
          .setTranslation(x, y, z)
          .setDensity(0)
          .setFriction(0.5)
          .setRestitution(0.3)
          .setCollisionGroups(CAGE_GROUPS);
        if (turn) {
          const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), turn);
          desc.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
        }
        world.createCollider(desc, body);
      };
      const midY = (floorY + topY) / 2;
      const halfY = (topY - floorY) / 2;
      wall(inX, WALL, inZ, 0, floorY - WALL, 0);
      for (const side of [-1, 1]) {
        wall(inX, halfY, WALL, 0, midY, side * (inZ + WALL));
        wall(WALL, halfY, inZ, side * (inX + WALL), midY, 0);
      }
      // Свод — пластины по дуге.
      const segments = 10;
      for (let i = 0; i < segments; i++) {
        const a0 = (Math.PI * i) / segments;
        const a1 = (Math.PI * (i + 1)) / segments;
        const z0 = inZ * Math.cos(a0);
        const y0 = inRise * Math.sin(a0);
        const z1 = inZ * Math.cos(a1);
        const y1 = inRise * Math.sin(a1);
        const length = Math.hypot(z1 - z0, y1 - y0);
        const turn = Math.atan2(-(y1 - y0), z1 - z0);
        // Нормаль наружу — от середины основания свода.
        const nz = (z0 + z1) / 2;
        const ny = (y0 + y1) / 2;
        const n = Math.hypot(nz, ny) || 1;
        wall(inX, WALL, length / 2 + WALL, 0, springY + ny + (ny / n) * WALL, nz + (nz / n) * WALL, turn);
      }
      follow(input.value.length);
    },
    update(dt) {
      if (!body) return;
      time += dt;
      follow(input.value.length);
      cooldown = Math.max(0, cooldown - dt);
      if (queued > 0 && cooldown === 0) {
        spawn();
        queued--;
        cooldown = SPAWN_INTERVAL;
      }

      position.copy(body.translation());
      inverse.copy(body.rotation()).invert();
      let count = 0;
      for (const ball of [...balls]) {
        ball.age += dt;
        let size = easeOutBack(Math.min(ball.age / POP_IN, 1));
        if (ball.dying >= 0) {
          ball.dying += dt;
          size *= 1 - smooth(Math.min(ball.dying / POP_OUT, 1));
          if (ball.dying >= POP_OUT) {
            physics.world.removeRigidBody(ball.body);
            balls.splice(balls.indexOf(ball), 1);
            continue;
          }
        }
        local.copy(ball.body.translation()).sub(position).applyQuaternion(inverse);
        if (escaped(local)) {
          // Шарик вылетел сквозь стенку на рывке — возвращаем его под свод.
          const { world: p, velocity } = toWorld(nextSpawn);
          ball.body.setTranslation(p, true);
          ball.body.setLinvel(velocity, true);
          local.copy(nextSpawn);
        }
        if (count < capacity) ballMesh.setMatrixAt(count++, matrix.compose(local, still, scale.setScalar(Math.max(size, 1e-3))));
      }
      ballMesh.count = count;
      ballMesh.instanceMatrix.needsUpdate = true;

      ghost.visible = input.focused;
      if (ghost.visible) {
        const pulse = 0.5 + 0.5 * Math.sin(time * 5);
        ghost.position.copy(nextSpawn);
        ghost.scale.setScalar(0.82 + 0.12 * pulse);
        ghostMaterial.opacity = 0.12 + 0.3 * pulse;
      }
    },
    dispose() {
      input.dispose();
      if (physics) for (const ball of balls) physics.world.removeRigidBody(ball.body);
      balls.length = 0;
      group.traverse((o) => o.geometry?.dispose());
      for (const material of [brass, lacquer, ballMaterial, ghostMaterial, hull.material]) material.dispose();
    },
  };
}
