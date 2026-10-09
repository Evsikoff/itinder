import * as THREE from 'three';
import { BOARDING, STATION, TRAINS } from './config.js';
import { pageAnchor } from './page/page.js';

// Посадка в поезд и переход в комнату — после выбора специализации и грейда
// (действие вернуло room: true, actions.js). Камера идёт от страницы к дверям
// вагона напротив неё, двери открываются, камера входит в вагон, экран гаснет
// (#veil, как при загрузке) и открывается комната BOARDING.room — внутреннее
// приложение resume3 с таким же экраном загрузки, поэтому переход не виден.

const easeInOut = (t) => t * t * (3 - 2 * t);

// Расстояние вдоль станции до ближайшей колонны: колонны стоят на границах
// пролётов, z = bay·k + bay/2.
function columnGap(z) {
  const offset = THREE.MathUtils.euclideanModulo(z - STATION.bay / 2, STATION.bay);
  return Math.min(offset, STATION.bay - offset);
}

// Где встать перед дверями: в standOff от борта, взгляд в середину проёма.
function frontOf(door) {
  return {
    position: new THREE.Vector3(door.x - door.side * BOARDING.standOff, BOARDING.eyeHeight, door.z),
    target: new THREE.Vector3(door.x, (TRAINS.doorBottom + TRAINS.doorTop) / 2, door.z),
  };
}

// В вагоне: на оси вагона, взгляд на двери напротив.
function insideOf(door) {
  return {
    position: new THREE.Vector3(door.track, 1.55, door.z),
    target: new THREE.Vector3(door.track + door.side * 1.2, 1.3, door.z),
  };
}

// veil — экран загрузки (#veil): гаснет вместе со сценой.
export function createBoarding({ station, camera, rig, pages, sounds, veil }) {
  let active = false;
  const tasks = [];

  // Пауза или плавное действие во времени сцены, как переходы страниц:
  // идут, только пока идут кадры. step(k) — каждый кадр, k от 0 до 1.
  const run = (duration, step) => new Promise((resolve) => tasks.push({ time: 0, duration, step, resolve }));

  // Двери между страницей и камерой, не за колонной, ближе всего к середине
  // между ними: камера не проходит сквозь страницу и видит проём целиком.
  function pickDoor() {
    const page = pageAnchor(pages.page.number).z;
    const eye = camera.position.z;
    const middle = (page + eye) / 2;
    const ahead = (door) => door.z > page + 1 && door.z < eye + 1;
    const score = (door) => Math.abs(door.z - middle) + (ahead(door) ? 0 : 100);
    const doors = station.trains.platformDoors(page - 30, eye + 30).filter((door) => columnGap(door.z) >= BOARDING.columnClear);
    if (doors.length === 0) throw new Error('У этой страницы не нашлось дверей поезда');
    return doors.sort((a, b) => score(a) - score(b))[0];
  }

  // Назад из комнаты: страница из кэша браузера осталась бы в вагоне за погасшим экраном.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && active) window.location.reload();
  });

  return {
    // Идёт посадка: клики по сцене не принимаются, камера не встаёт к странице.
    get active() {
      return active;
    },
    update(dt) {
      for (const task of [...tasks]) {
        task.time = Math.min(task.time + dt, task.duration);
        task.step?.(task.duration > 0 ? task.time / task.duration : 1);
        if (task.time >= task.duration) {
          tasks.splice(tasks.indexOf(task), 1);
          task.resolve();
        }
      }
    },
    // Пройти в комнату. Промис выполняется, когда браузер уже уходит со станции.
    async enter() {
      if (active) return;
      active = true;
      const door = pickDoor();
      const doorway = station.trains.doorway(door);
      await rig.travelTo(frontOf(door), BOARDING.approachTime, { glance: 0 });
      await run(BOARDING.pause);
      await run(BOARDING.openTime, (k) => doorway.open(easeInOut(k)));
      rig.travelTo(insideOf(door), BOARDING.enterTime, { glance: 0 });
      await run(BOARDING.enterTime * BOARDING.fadeAt);
      veil.classList.remove('gone');
      sounds.fadeOut(BOARDING.fadeTime);
      await run(BOARDING.fadeTime);
      window.location.assign(BOARDING.room);
    },
  };
}
