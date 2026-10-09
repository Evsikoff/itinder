import * as THREE from 'three';
import { TRANSITION } from './config.js';
import { buildPage, pageAnchor } from './page/page.js';
import { frameBounds } from './camera.js';
import { blurFields } from './page/textField.js';

// Переходы между страницами. По клику на элемент с link_to_page текущая страница
// уезжает вверх за потолок, камера едет вдоль станции к месту новой страницы,
// новая страница спускается из люка к моменту, когда камера встаёт.

// fov и hfov() — углы обзора (по вертикали и по горизонтали), в которые вписывается
// страница; fitHatch(page) — расширить люк над страницей, если она шире люка.
export function createNavigator({ scheme, physics, scene, camera, fov, hfov, fitHatch }) {
  let current = null;
  let rig = null;
  let busy = false;
  const live = new Set();   // страницы в сцене: текущая и те, что уезжают или приезжают
  const timers = [];

  // Пауза во времени сцены, а не по часам: идёт только пока идут кадры.
  const wait = (seconds) => new Promise((resolve) => timers.push({ left: seconds, resolve }));

  // Кадр для страницы. У пустой страницы — как у типичной страницы под её люком.
  const frameFor = (page) => {
    let box = page.restBounds;
    if (box.isEmpty()) {
      const anchor = pageAnchor(page.number);
      box = new THREE.Box3(new THREE.Vector3(-1, 1.2, anchor.z), new THREE.Vector3(1, anchor.y - 0.6, anchor.z));
    }
    return frameBounds(box, { fov, hfov: hfov(), scale: page.scale, mode: page.camera.mode });
  };

  const show = (page) => {
    scene.add(page.group);
    live.add(page);
  };

  return {
    get page() {
      return current;
    },
    get busy() {
      return busy;
    },
    frameFor,
    // Первая страница: висит на месте и качается от потока воздуха.
    async open(number) {
      current = await buildPage(number, { scheme, physics, gust: true });
      fitHatch(current);
      show(current);
      return current;
    },
    attachCamera(cameraRig) {
      rig = cameraRig;
    },
    update(dt) {
      for (const timer of [...timers]) {
        timer.left -= dt;
        if (timer.left <= 0) {
          timers.splice(timers.indexOf(timer), 1);
          timer.resolve();
        }
      }
      live.forEach((page) => page.update(dt));
    },
    async go(number) {
      if (busy || rig.moving || !current || Number(number) === current.number) return;
      busy = true;
      blurFields();
      try {
        const old = current;
        const loading = buildPage(number, { scheme, physics, hidden: true });
        old.ascend(TRANSITION.liftTime).then(() => {
          live.delete(old);
          old.dispose();
        });
        await wait(TRANSITION.cameraDelay);

        const next = await loading;
        fitHatch(next);
        show(next);
        const frame = frameFor(next);
        const distance = camera.position.distanceTo(frame.position);
        const duration = THREE.MathUtils.clamp(distance / TRANSITION.speed, TRANSITION.minTravel, TRANSITION.maxTravel);
        const arrived = rig.travelTo(frame, duration);
        await wait(Math.max(0, duration - TRANSITION.dropTime + TRANSITION.landingLag));
        await next.descend(TRANSITION.dropTime);
        await arrived;
        current = next;
      } finally {
        busy = false;
      }
    },
  };
}
