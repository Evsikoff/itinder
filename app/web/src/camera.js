import * as THREE from 'three';
import { INTRO, ZOOM } from './config.js';

// Камера: пролёт при старте (над крышей левого поезда, между колоннами в центральный
// зал, посадка на уровень глаз лицом вдоль станции), стоянка с лёгким параллаксом
// за указателем и приближением колёсиком, переезд вдоль станции к другой странице
// или к дверям поезда.

const PARALLAX = new THREE.Vector2(0.18, 0.08);

const smoothstep = (a, b, x) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);

// Положение камеры { position, target }: где она и куда смотрит.
const copyPose = (pose) => ({ position: pose.position.clone(), target: pose.target.clone() });
const lerpPose = (out, from, to, t) => {
  out.position.lerpVectors(from.position, to.position, t);
  out.target.lerpVectors(from.target, to.target, t);
  return out;
};
const reach = (pose) => pose.position.distanceTo(pose.target);

// Доля пути от from к to, на которой от камеры до точки взгляда будет distance
// (обе идут по прямым); 1 — если на этом пути так и не будет.
function shareAt(from, to, distance) {
  const a = new THREE.Vector3().subVectors(from.position, from.target);
  const d = new THREE.Vector3().subVectors(to.position, to.target).sub(a);
  const qa = d.lengthSq();
  const qb = 2 * a.dot(d);
  const qc = a.lengthSq() - distance * distance;
  const disc = qb * qb - 4 * qa * qc;
  if (qa < 1e-9 || disc < 0) return 1;
  const roots = [-1, 1].map((sign) => (-qb + sign * Math.sqrt(disc)) / (2 * qa)).filter((t) => t >= 0 && t <= 1);
  return roots.length ? Math.min(...roots) : 1;
}

// Влёт с заметной скоростью и мягкая остановка.
const introEase = (t) => THREE.MathUtils.lerp(smoothstep(0, 1, t), 1 - Math.pow(1 - t, 2.6), 0.6);

// Место стоянки для габаритов страницы box. Страница должна поместиться
// по высоте в угол обзора fov, по ширине — в горизонтальный угол hfov.
// mode — режим камеры из Layout строки «Page»:
//   eye — камера на уровне глаз отходит настолько, чтобы не задирать взгляд
//         выше maxPitch и не подходить ближе minDistance (к уменьшенной
//         странице, scale < 1, — соразмерно ближе);
//   close — камера подлетает на высоту середины страницы и смотрит на неё
//         прямо, с расстояния, на котором страница как раз помещается в кадр.
export function frameBounds(box, { fov, hfov = 180, scale = 1, mode = 'eye' }) {
  const center = box.getCenter(new THREE.Vector3());
  const halfWidth = (box.max.x - box.min.x) / 2 + INTRO.frameMargin;
  const wide = halfWidth / Math.tan(THREE.MathUtils.degToRad(Math.min(hfov, 170)) / 2) + (box.max.z - box.min.z) / 2;
  if (mode === 'close') {
    const halfHeight = (box.max.y - box.min.y) / 2 + INTRO.frameMargin;
    const tall = halfHeight / Math.tan(THREE.MathUtils.degToRad(fov) / 2) + (box.max.z - box.min.z) / 2;
    return {
      position: new THREE.Vector3(center.x, center.y, center.z + Math.max(tall, wide)),
      target: center,
    };
  }

  const eye = INTRO.eyeHeight;
  const top = box.max.y + INTRO.frameMargin;
  const bottom = box.min.y - INTRO.frameMargin;
  const half = THREE.MathUtils.degToRad(fov) / 2;
  const angles = (d) => [Math.atan((top - eye) / d), Math.atan((bottom - eye) / d)];
  let near = 0.5;
  let far = 50;
  for (let i = 0; i < 50; i++) {
    const d = (near + far) / 2;
    const [up, down] = angles(d);
    if (up - down > 2 * half) near = d;
    else far = d;
  }
  let distance = Math.max(far, wide, INTRO.minDistance * scale);
  const maxPitch = THREE.MathUtils.degToRad(INTRO.maxPitch);
  const pitch = (d) => {
    const [up, down] = angles(d);
    return (up + down) / 2;
  };
  if (pitch(distance) > maxPitch) {
    let lo = distance;
    let hi = 60;
    for (let i = 0; i < 50; i++) {
      const d = (lo + hi) / 2;
      if (pitch(d) > maxPitch) lo = d;
      else hi = d;
    }
    distance = hi;
  }
  const [up, down] = angles(distance);
  return {
    position: new THREE.Vector3(center.x, eye, center.z + distance),
    target: new THREE.Vector3(center.x, eye + Math.tan((up + down) / 2) * distance, center.z),
  };
}

// rest — { position, target } из frameBounds: где камера встанет после пролёта.
// clearance(point) — насколько точка дальше от объектов страницы, чем можно
// подойти камере; меньше нуля — слишком близко.
export function createCameraRig(camera, { rest: frame, skip = false, clearance = () => Infinity }) {
  const points = [...INTRO.path.map((p) => new THREE.Vector3(...p)), frame.position];
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const rest = { position: frame.position.clone(), target: frame.target.clone() };
  const look = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  const tangentNow = new THREE.Vector3();
  const tangentNext = new THREE.Vector3();
  const parallax = new THREE.Vector2();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const probe = new THREE.Vector3();
  const heading = (v) => Math.atan2(v.x, -v.z);

  let mode = skip ? 'rest' : 'intro';
  let time = 0;
  let travel = null;
  // Приближение колёсиком на стоянке: view — где камера сейчас, goal — куда
  // она летит; home — летит обратно на стоянку. null — камера на стоянке.
  let zoom = null;

  function fly(u) {
    curve.getPoint(u, camera.position);
    curve.getPoint(Math.min(u + 0.12, 1), ahead);
    ahead.y -= 0.4;
    look.lerpVectors(ahead, rest.target, smoothstep(0.4, 1, u));
    camera.up.set(0, 1, 0);
    camera.lookAt(look);
    // Крен в повороте: пропорционален скорости смены курса.
    curve.getTangent(u, tangentNow);
    curve.getTangent(Math.min(u + 0.02, 1), tangentNext);
    const turn = THREE.MathUtils.euclideanModulo(heading(tangentNext) - heading(tangentNow) + Math.PI, Math.PI * 2) - Math.PI;
    camera.rotateZ(THREE.MathUtils.clamp(-turn * 4, -0.22, 0.22) * (1 - smoothstep(0.7, 1, u)));
  }

  function drive(dt) {
    travel.time = Math.min(travel.time + dt, travel.duration);
    const k = smootherstep(travel.time / travel.duration);
    camera.position.lerpVectors(travel.from.position, travel.to.position, k);
    // По дороге взгляд уходит вдаль вдоль станции (glance) и снова находит цель.
    look.lerpVectors(travel.from.target, travel.to.target, k);
    ahead.copy(camera.position).add(new THREE.Vector3(0, 0.5, -25));
    look.lerp(ahead, Math.sin(Math.PI * k) * travel.glance);
    camera.up.set(0, 1, 0);
    camera.lookAt(look);
    if (travel.time >= travel.duration) {
      rest.position.copy(travel.to.position);
      rest.target.copy(travel.to.target);
      const { resolve } = travel;
      travel = null;
      mode = 'rest';
      parallax.set(0, 0);
      resolve();
    }
  }

  // Камера не подходит к объектам ближе предела. Подошла (объект качнулся
  // навстречу, рядом выступает соседний) — отступает к стоянке и там останавливается.
  function keepClear() {
    if (clearance(zoom.view.position) >= 0) return;
    let near = 0;
    let far = 1;
    for (let i = 0; i < 20; i++) {
      const t = (near + far) / 2;
      if (clearance(probe.lerpVectors(zoom.view.position, rest.position, t)) >= 0) far = t;
      else near = t;
    }
    lerpPose(zoom.view, zoom.view, rest, far);
    if (!zoom.home) zoom.goal = copyPose(zoom.view);
  }

  // Параллакс — вбок и вверх относительно взгляда: у дверей поезда камера смотрит
  // поперёк станции. Приближенная камера качается соразмерно меньше.
  function stand(pointer, dt) {
    let pose = rest;
    if (zoom) {
      lerpPose(zoom.view, zoom.view, zoom.home ? rest : zoom.goal, 1 - Math.exp(-dt * ZOOM.response));
      keepClear();
      const back = zoom.home && zoom.view.position.distanceTo(rest.position) + zoom.view.target.distanceTo(rest.target) < 1e-3;
      if (back) zoom = null;
      else pose = zoom.view;
    }
    const sway = Math.min(1, reach(pose) / reach(rest));
    const k = 1 - Math.exp(-dt * 2.5);
    parallax.x += (pointer.x * PARALLAX.x - parallax.x) * k;
    parallax.y += (pointer.y * PARALLAX.y - parallax.y) * k;
    right.subVectors(pose.target, pose.position).cross(up).setY(0).normalize();
    camera.position.copy(pose.position).addScaledVector(right, parallax.x * sway);
    camera.position.y += parallax.y * sway;
    camera.up.copy(up);
    camera.lookAt(pose.target);
  }

  return {
    get moving() {
      return mode !== 'rest';
    },
    // Едет к другой странице (не пролёт при старте).
    get traveling() {
      return mode === 'travel';
    },
    // pointer — положение указателя в [−1, 1].
    update(dt, pointer) {
      time += dt;
      if (mode === 'intro') {
        const progress = Math.min(time / INTRO.duration, 1);
        if (progress < 1) {
          fly(introEase(progress));
          return;
        }
        mode = 'rest';
      }
      if (mode === 'travel') drive(dt);
      else stand(pointer, dt);
    },
    // Встать на другую стоянку без переезда (поменялся размер окна).
    settle(frame) {
      rest.position.copy(frame.position);
      rest.target.copy(frame.target);
    },
    // Переехать к новой стоянке; промис выполняется, когда камера встала.
    // glance — насколько по дороге взгляд уходит вдаль вдоль станции, 0 — не уходит.
    travelTo(frame, duration, { glance = 0.6 } = {}) {
      return new Promise((resolve) => {
        travel = {
          from: { position: camera.position.clone(), target: mode === 'rest' ? (zoom?.view ?? rest).target.clone() : look.clone() },
          to: { position: frame.position.clone(), target: frame.target.clone() },
          duration,
          glance,
          time: 0,
          resolve,
        };
        mode = 'travel';
        zoom = null;
      });
    },
    // Приближена ли камера колёсиком.
    get zoomed() {
      return zoom !== null;
    },
    // Колёсико на стоянке: notches > 0 — ближе к close ({ position, target }, где
    // камера встала бы вплотную к объекту, глядя на него), < 0 — обратно к стоянке.
    // За щелчок расстояние до того, куда смотрит камера, меняется в 1 − ZOOM.step раз.
    zoom(notches, close = null) {
      if (mode !== 'rest' || notches === 0 || (notches > 0 && !close) || (notches < 0 && !zoom)) return;
      const from = zoom ? (zoom.home ? zoom.view : zoom.goal) : rest;
      const factor = Math.pow(1 - ZOOM.step, Math.abs(notches));
      if (notches > 0) {
        const t = shareAt(from, close, Math.max(reach(close), reach(from) * factor));
        zoom = { view: zoom?.view ?? copyPose(rest), goal: lerpPose(copyPose(from), from, close, t), home: false };
      } else {
        const t = shareAt(from, rest, reach(from) / factor);
        if (t >= 1) zoom.home = true;
        else zoom.goal = lerpPose(copyPose(from), from, rest, t);
      }
    },
  };
}
