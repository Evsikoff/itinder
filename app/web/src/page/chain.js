import * as THREE from 'three';
import { CHAIN } from '../config.js';
import { lit } from '../station/lamps.js';

// Цепь от точки подвеса до объекта (у широкой таблички — две цепи, к каждому
// верхнему ушку своя). Каждое звено — твёрдое тело Rapier,
// соседние звенья и груз связаны сферическими шарнирами (импульсными: многотельные
// для цепи из сорока звеньев слишком дорогие). Чтобы цепь не тянулась под грузом,
// звенья делаются потяжелее, решателю добавляются итерации, а груз держит ещё
// и невидимый трос длиной в цепь.

const NO_COLLISIONS = 0x00010000; // группа 1, фильтр пустой: тела ни с чем не сталкиваются
const LINK_MASS = 0.12;
const EXTRA_ITERATIONS = 12;
// Цепь сопротивляется закручиванию: без этого груз на одной точке подвеса
// медленно поворачивается от накопленных ошибок решателя.
const TWIST_PERIOD = 4;   // с, период крутильных колебаний груза
const TWIST_DAMPING = 0.6; // доля критического затухания

// Осевая линия звена: две прямые и два полукруга.
class StadiumCurve extends THREE.Curve {
  constructor(straight, radius) {
    super();
    this.straight = straight;
    this.radius = radius;
  }

  getPoint(t, target = new THREE.Vector3()) {
    const s = this.straight;
    const r = this.radius;
    let d = t * (2 * s + 2 * Math.PI * r);
    if (d < s) return target.set(r, -s / 2 + d, 0);
    d -= s;
    if (d < Math.PI * r) return target.set(r * Math.cos(d / r), s / 2 + r * Math.sin(d / r), 0);
    d -= Math.PI * r;
    if (d < s) return target.set(-r, s / 2 - d, 0);
    d -= s;
    return target.set(r * Math.cos(Math.PI + d / r), -s / 2 + r * Math.sin(Math.PI + d / r), 0);
  }
}

function linkGeometry() {
  const radius = CHAIN.innerWidth / 2 + CHAIN.wire;
  const straight = CHAIN.pitch - CHAIN.innerWidth;
  return new THREE.TubeGeometry(new StadiumCurve(straight, radius), 48, CHAIN.wire, 8, true);
}

const toVector = (v) => ({ x: v.x, y: v.y, z: v.z });

// parent: { body — тело, на котором висит подвеска (неподвижное у анкерной точки
// станции или другой объект), points — точки подвеса: [{ anchor — в локальных
// координатах тела, world — та же точка в мире }] }.
// load: { hooks (точки крепления в локальных координатах, по одной на точку
// подвеса; у объекта на одной цепи вместо них hook), halfExtents, mass }.
// К каждой точке подвеса идёт своя цепь длины length. scale — масштаб звеньев
// (страница, уменьшенная целиком). Подвеска создаётся висящей отвесно
// и раскачивается толчком (push).
export function hangOnChain(physics, { parent: from, length, load, scale = 1 }) {
  const { RAPIER, world } = physics;
  const pitch = CHAIN.pitch * scale;
  const count = Math.max(2, Math.round(length / pitch));
  const hooks = load.hooks ?? [load.hook];
  if (hooks.length !== from.points.length) throw new Error(`Точек подвеса ${from.points.length}, а точек крепления у груза ${hooks.length}`);

  const first = from.points[0].world;
  const loadBody = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(first.x - hooks[0].x, first.y - count * pitch - hooks[0].y, first.z)
    .setLinearDamping(0.3)
    .setAngularDamping(0.5)
    .setAdditionalSolverIterations(EXTRA_ITERATIONS)
    .setCanSleep(false));
  const { x: hx, y: hy, z: hz } = load.halfExtents;
  world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz)
    .setMass(load.mass)
    .setCollisionGroups(NO_COLLISIONS), loadBody);

  const links = [];
  from.points.forEach(({ anchor, world: point }, k) => {
    let parent = from.body;
    let parentAnchor = toVector(anchor);
    for (let i = 0; i < count; i++) {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(point.x, point.y - (i + 0.5) * pitch, point.z)
        .setLinearDamping(0.3)
        .setAngularDamping(0.6)
        .setAdditionalSolverIterations(EXTRA_ITERATIONS)
        .setCanSleep(false));
      world.createCollider(RAPIER.ColliderDesc.capsule(pitch / 2, CHAIN.wire * 2 * scale)
        .setMass(LINK_MASS)
        .setCollisionGroups(NO_COLLISIONS), body);
      world.createImpulseJoint(RAPIER.JointData.spherical(parentAnchor, { x: 0, y: pitch / 2, z: 0 }), parent, body, true);
      links.push(body);
      parent = body;
      parentAnchor = { x: 0, y: -pitch / 2, z: 0 };
    }
    world.createImpulseJoint(RAPIER.JointData.spherical(parentAnchor, toVector(hooks[k])), parent, loadBody, true);
    // Невидимый трос длиной в цепь: груз не уходит дальше её длины. Без него
    // импульсные шарниры под тяжёлой подвеской (страница под одной табличкой)
    // растягивают длинную цепь на десятки процентов.
    world.createImpulseJoint(RAPIER.JointData.rope(count * pitch, toVector(anchor), toVector(hooks[k])), from.body, loadBody, true);
  });

  // Силы на каждый шаг: крутильная пружина вокруг вертикали и толчки.
  const inertia = (load.mass * (hx * hx + hz * hz)) / 3;
  const omega = (2 * Math.PI) / TWIST_PERIOD;
  const stiffness = inertia * omega * omega;
  const damping = 2 * TWIST_DAMPING * inertia * omega;
  const forward = new THREE.Vector3();
  const pushes = [];
  const unsubscribe = physics.onStep(() => {
    loadBody.resetForces(false);
    loadBody.resetTorques(false);
    forward.set(0, 0, 1).applyQuaternion(loadBody.rotation());
    const yaw = Math.atan2(forward.x, forward.z);
    loadBody.addTorque({ x: 0, y: -stiffness * yaw - damping * loadBody.angvel().y, z: 0 }, false);
    for (const { force, point } of pushes.splice(0)) loadBody.addForceAtPoint(force, point, true);
  });

  const material = lit(new THREE.MeshStandardMaterial({ color: 0x9a9ca3, metalness: 1, roughness: 0.3 }));
  const mesh = new THREE.InstancedMesh(linkGeometry(), material, links.length);
  mesh.name = 'chain';
  mesh.frustumCulled = false;

  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const size = new THREE.Vector3(scale, scale, scale);
  const matrix = new THREE.Matrix4();
  // Вращение звена вокруг своей оси на физику не влияет, поэтому разворот
  // соседних звеньев на 90°, как в настоящей цепи, добавляется только при отрисовке.
  const quarterTurn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);

  return {
    mesh,
    links,
    load: loadBody,
    // Перенести положения тел из физики в сцену.
    sync(object) {
      links.forEach((body, i) => {
        position.copy(body.translation());
        quaternion.copy(body.rotation());
        if (i % 2) quaternion.multiply(quarterTurn);
        mesh.setMatrixAt(i, matrix.compose(position, quaternion, size));
      });
      mesh.instanceMatrix.needsUpdate = true;
      object.position.copy(loadBody.translation());
      object.quaternion.copy(loadBody.rotation());
    },
    // Толкнуть груз: impulse (Н·с) в точке point (мировые координаты), по умолчанию
    // в центр масс. Сила действует один шаг физики: импульс, делённый на шаг.
    push(impulse, point = loadBody.translation()) {
      pushes.push({ force: toVector(impulse.clone().divideScalar(world.timestep)), point: toVector(point) });
    },
    // Переставить всю подвеску на dy по вертикали (вместе с точкой подвеса).
    shift(dy) {
      for (const body of [...links, loadBody]) {
        const p = body.translation();
        body.setTranslation({ x: p.x, y: p.y + dy, z: p.z }, true);
      }
    },
    // Убрать тела из физики и освободить геометрию.
    dispose() {
      unsubscribe();
      for (const body of [...links, loadBody]) world.removeRigidBody(body);
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
