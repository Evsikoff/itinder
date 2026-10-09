import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FOG, ZOOM } from './config.js';
import { buildStation } from './station/station.js';
import { createPhysics } from './physics/world.js';
import { isEmpty, knownPages, loadScheme } from './page/scheme.js';
import { pageAnchor } from './page/page.js';
import { createCameraRig } from './camera.js';
import { createNavigator } from './navigation.js';
import { createBoarding } from './boarding.js';
import { blurFields } from './page/textField.js';
import { OBJECT_SOUNDS, createSounds } from './audio.js';
import { ActionError, actionOf, hasAction } from './actions.js';
import { notify } from './notice.js';

const FIRST_PAGE = 1;
const PUSH_IMPULSE = 6; // Н·с — толчок по клику
const FOV = 52;        // вертикальный угол обзора
const MIN_HFOV = 44;   // на узких экранах обзор расширяется, чтобы табличка помещалась
const FRAME_FILL = 0.92; // доля угла обзора, которую занимает страница

const canvas = document.getElementById('scene');
const veil = document.getElementById('veil');
const errorBox = document.getElementById('error');

function showError(error) {
  console.error(error);
  errorBox.textContent = error?.message ?? String(error);
  errorBox.style.display = 'block';
  veil.classList.add('gone');
}

async function start() {
  // Гул станции — с самого начала, пока грузится сцена (звук включится с первым жестом).
  const sounds = createSounds();
  sounds.loop('rumble', true);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  const pixelRatio = Math.min(window.devicePixelRatio, 1.75);
  renderer.setPixelRatio(pixelRatio);
  // Neutral почти не трогает цвета ниже 0.8, поэтому фирменные цвета на табличке не плывут.
  renderer.toneMapping = THREE.NeutralToneMapping;
  // Проём настоящих дверей поезда вырезается в борту плоскостями отсечения (trains.js).
  renderer.localClippingEnabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(FOG.color);
  scene.fog = new THREE.FogExp2(FOG.color, FOG.density);

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 420);

  const [physics, scheme] = await Promise.all([createPhysics(), loadScheme()]);

  const station = buildStation({ hatches: knownPages(scheme).map(pageAnchor) });
  scene.add(station.group);

  // Отражения в граните, стекле и металле: окружение снимается со станции один раз.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(scene, 0.03, 0.1, 150, { position: new THREE.Vector3(0, 2.6, 2), size: 256 }).texture;
  scene.environmentIntensity = 0.7;
  pmrem.dispose();

  const pages = createNavigator({
    scheme,
    physics,
    scene,
    camera,
    fov: FOV * FRAME_FILL,
    hfov: () => THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect)) * FRAME_FILL,
    fitHatch: (page) => station.fitHatch(pageAnchor(page.number), page.restBounds.max.x - page.restBounds.min.x),
  });
  const firstPage = await pages.open(FIRST_PAGE);

  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
  composer.setPixelRatio(pixelRatio);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.35, 0.55, 0.86);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // Размер сверяется каждый кадр: окно могло поменяться, пока шла загрузка,
  // или страница открылась в скрытой вкладке с нулевым размером. С новым размером
  // камера заново встаёт перед страницей: широкую на узком экране видно издалека.
  const viewport = new THREE.Vector2();
  let rig = null;
  let boarding = null;
  const fitToCanvas = () => {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    if (viewport.x === width && viewport.y === height) return;
    viewport.set(width, height);
    camera.aspect = width / height;
    const narrowFov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(MIN_HFOV / 2)) / camera.aspect);
    camera.fov = Math.max(FOV, THREE.MathUtils.radToDeg(narrowFov));
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    composer.setSize(width, height);
    if (rig && !rig.moving && !pages.busy && !boarding?.active) rig.settle(pages.frameFor(pages.page));
  };
  fitToCanvas();

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  rig = createCameraRig(camera, {
    rest: pages.frameFor(firstPage),
    skip: reducedMotion,
    clearance: (point) => (pages.page ? pages.page.distanceTo(point) - ZOOM.closest * pages.page.scale : Infinity),
  });
  pages.attachCamera(rig);
  boarding = createBoarding({ station, camera, rig, pages, sounds, veil });
  const pointer = new THREE.Vector2();
  rig.update(0, pointer);
  station.update(0);

  // Наведение и клик. Элемент с additional action качается от толчка и выполняет
  // действие — по click: только из него браузер на телефоне откроет диалог выбора
  // файла. Элемент со ссылкой (link_to_page) открывает свою страницу — после
  // действия, если оно есть; поле ввода (доска, клетка) получает фокус, остальные
  // таблички качаются от толчка. Пока камера едет или идёт посадка в поезд,
  // клики не принимаются.
  const raycaster = new THREE.Raycaster();
  let hovered = null;
  const aim = (event) => {
    const box = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - box.left) / box.width) * 2 - 1, -((event.clientY - box.top) / box.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
  };
  const pick = (event) => {
    aim(event);
    if (pages.busy || rig.moving || boarding.active) return null;
    const hit = raycaster.intersectObjects(pages.page.pickables, false)[0];
    return hit ? { hit, node: pages.page.nodeOf(hit.object) } : null;
  };
  const linkOf = (node) => (isEmpty(node?.element.link_to_page) ? null : node.element.link_to_page);
  const isButton = (node) => linkOf(node) || hasAction(node?.element);
  const hover = (node) => {
    if (node === hovered) return;
    if (hovered && isButton(hovered)) hovered.object.highlight(false);
    hovered = node;
    if (hovered && isButton(hovered)) hovered.object.highlight(true);
  };
  // Одно действие за раз: повторные клики, пока сервер отвечает, не считаются.
  // Пока экран действия закрывает сцену (covered), сцена не рисуется.
  // Действие с room: true уводит в комнату через поезд, а не по ссылке,
  // с link — на страницу link вместо ссылки элемента. Ошибка действия может
  // предложить другую страницу (offer) — кнопкой в сообщении.
  let acting = false;
  let covered = false;
  const offerOf = (offer) => offer && {
    label: offer.label,
    run: () => {
      hover(null);
      pages.go(offer.link).catch(showError);
    },
  };
  const act = async (node) => {
    if (acting) return;
    acting = true;
    try {
      const result = await actionOf(node.element)({ page: pages.page, node, scheme, sounds, cover: (on) => (covered = on) });
      if (result.cancelled) return;
      notify(result.message);
      const link = result.link ?? linkOf(node);
      if (result.room) {
        hover(null);
        canvas.style.cursor = '';
        blurFields();
        await boarding.enter();
      } else if (link) await pages.go(link);
    } catch (error) {
      if (error instanceof ActionError) notify(error.message, { error: true, offer: offerOf(error.offer) });
      else showError(error);
    } finally {
      acting = false;
    }
  };
  // Колёсико: камера подлетает к точке объекта под указателем (мимо объектов —
  // к ближайшему месту страницы), пока та не встанет посередине кадра, и отлетает
  // обратно к стоянке. Пока указатель стоит на месте, камера летит к той же
  // точке: объект уже уплыл к середине кадра, и под указателем теперь другое.
  // Ctrl с колёсиком остаётся браузеру — масштаб страницы.
  let zoomFocus = null;
  const focusOf = (event) => {
    const page = pages.page;
    if (page.restBounds.isEmpty()) return null;
    aim(event);
    const hit = raycaster.intersectObjects(page.pickables, false)[0];
    if (hit) return hit.point.clone();
    const front = new THREE.Plane(new THREE.Vector3(0, 0, 1), -page.restBounds.max.z);
    const point = raycaster.ray.intersectPlane(front, new THREE.Vector3()) ?? page.restBounds.getCenter(new THREE.Vector3());
    return page.restBounds.clampPoint(point, point);
  };
  // Где камера встанет вплотную: прямо перед точкой, на пределе приближения.
  const closeTo = (point) => point && {
    position: point.clone().add(new THREE.Vector3(0, 0, ZOOM.closest * pages.page.scale)),
    target: point,
  };
  canvas.addEventListener('wheel', (event) => {
    if (event.ctrlKey) return;
    event.preventDefault();
    if (pages.busy || rig.moving || boarding.active || covered) {
      zoomFocus = null;
      return;
    }
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 3 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 1 : 100;
    const notches = THREE.MathUtils.clamp(-event.deltaY / unit, -3, 3);
    if (notches > 0 && !zoomFocus) zoomFocus = { point: focusOf(event), x: event.clientX, y: event.clientY };
    rig.zoom(notches, notches > 0 ? closeTo(zoomFocus.point) : null);
  }, { passive: false });

  canvas.addEventListener('pointermove', (event) => {
    if (zoomFocus && Math.hypot(event.clientX - zoomFocus.x, event.clientY - zoomFocus.y) > 4) zoomFocus = null;
    const picked = pick(event);
    hover(picked?.node ?? null);
    canvas.style.cursor = picked ? (picked.node?.object.field ? 'text' : 'pointer') : '';
  });
  // Фокусом полей управляет click ниже, браузер не должен уводить его на холст.
  canvas.addEventListener('mousedown', (event) => event.preventDefault());
  canvas.addEventListener('pointerdown', (event) => {
    zoomFocus = null;
    const picked = pick(event);
    if (!picked?.node) return;
    const sound = OBJECT_SOUNDS[picked.node.element.object_type]?.press;
    if (sound) sounds.play(sound);
    if (picked.node.object.field) return;
    const link = linkOf(picked.node);
    if (hasAction(picked.node.element)) {
      picked.node.rig.push(raycaster.ray.direction.clone().multiplyScalar(PUSH_IMPULSE * pages.page.scale), picked.hit.point);
    } else if (link) {
      hover(null);
      canvas.style.cursor = '';
      pages.go(link).catch(showError);
    } else {
      picked.node.rig.push(raycaster.ray.direction.clone().multiplyScalar(PUSH_IMPULSE * pages.page.scale), picked.hit.point);
    }
  });
  // Фокус — по click: на телефоне экранная клавиатура открывается только из него.
  canvas.addEventListener('click', (event) => {
    const picked = pick(event);
    const field = picked?.node?.object.field;
    if (field) field.focus(picked.hit, event.clientX, event.clientY);
    else blurFields();
    if (picked?.node && !field && hasAction(picked.node.element)) act(picked.node);
  });
  // Любая клавиша, пока поле в фокусе, звучит голосом его объекта. Перехват
  // до обработчиков поля: Esc и Tab уводят фокус, но тоже звучат. Зажатая
  // клавиша не перезапускает звук, а даёт ему доиграть и начинает заново.
  window.addEventListener('keydown', (event) => {
    const node = pages.page?.nodes.find((n) => n.object.field?.focused);
    const sound = node && OBJECT_SOUNDS[node.element.object_type]?.key;
    if (sound) sounds.play(sound, { restart: !event.repeat });
  }, true);

  // Компилируем шейдеры до старта, чтобы пролёт не дёргался на первых кадрах.
  await renderer.compileAsync(scene, camera);
  composer.render();

  // Время сцены копится из шагов кадров, а не берётся из часов: в фоновой
  // вкладке кадры не идут, и сцена продолжает с того места, где остановилась.
  let t = 0;
  const tick = (dt, render = true) => {
    t += dt;
    fitToCanvas();
    if (!debug.freeCamera) rig.update(dt, pointer);
    // Шаги — пока камера едет к другой странице; пролёт при старте идёт без них.
    sounds.loop('footsteps', rig.traveling);
    station.update(reducedMotion ? Infinity : t);
    physics.step(dt);
    pages.update(dt);
    boarding.update(dt);
    if (render && !covered) composer.render();
  };

  // Отладка из консоли: itinder.debug.advance(5) прокручивает сцену на 5 с,
  // itinder.debug.freeCamera = true отключает управление камерой,
  // itinder.pages.go(2) открывает страницу 2.
  const debug = {
    freeCamera: false,
    advance(seconds, step = 1 / 60) {
      for (let s = step; s < seconds; s += step) tick(step, false);
      tick(step);
      return t;
    },
  };
  window.itinder = { scene, camera, renderer, composer, physics, station, pages, rig, boarding, scheme, sounds, debug };

  let last = null;
  renderer.setAnimationLoop((now) => {
    if (last === null) {
      last = now;
      veil.classList.add('gone');
    }
    tick(Math.min((now - last) / 1000, 0.1));
    last = now;
  });
}

start().catch(showError);
