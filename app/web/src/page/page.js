import * as THREE from 'three';
import { CHAIN, PAGES, SIGN, STATION } from '../config.js';
import { childrenOf, neonStyle, pageElements, pageSettings } from './scheme.js';
import { layoutFlow, renderLayout } from './layouts.js';
import { parsePageLayout } from './pageLayout.js';
import { buildMetroSign } from './metroSign.js';
import { buildChalkboard } from './chalkboard.js';
import { buildBirdcage } from './birdcage.js';
import { hangOnChain } from './chain.js';

// Сборка страницы из ui_scheme.json. Корень висит на цепи в анкерной точке
// страницы. Элементы с anchor_point_id висят под элементом, на который ссылаются:
// его дочерние элементы раскладываются по строкам, как текст. Элемент с блочной
// компоновкой занимает строку целиком, соседние inline-элементы (кнопки) делят
// строку поровну. Первая строка висит на родителе, каждая следующая — на строке выше.
// Строка «Page» той же страницы может поправить эту сборку (pageLayout.js).

// Конструктор получает элемент, ширину в строке, подпись (заголовок элемента,
// под которым он висит, — для полей ввода), число цепей подвеса и признак
// неона (##RRGGBB в background_hex; в element цвет уже записан обычно). Табличка
// показывает содержимое по Layout, доска и клетка — поля ввода, которые рисуют
// текст сами; неон у них пока не предусмотрен, цвет берётся как обычный.
const OBJECT_TYPES = {
  'A sign like the ones in the Moscow Metro': async ({ element, width, suspension, neon }) => buildMetroSign({ content: await renderLayout(element, width, { neon }), width, suspension }),
  Chalkboard: buildChalkboard,
  'Oblong birdcage': buildBirdcage,
};

// Анкерная точка страницы: середина потолка, страницы идут вдоль станции вперёд (−Z).
export function pageAnchor(number) {
  return new THREE.Vector3(0, STATION.ceiling, -(Number(number) - 1) * PAGES.spacing);
}

// Объект в масштабе страницы: строится в размерах стандартной сборки, в сцене
// и в физике уменьшается в scale раз. Объекты с собственной физикой внутри
// (attach — клетка с шариками) так не уменьшить.
function scaleObject(object, scale, element) {
  if (scale === 1) return object;
  if (object.attach) throw new Error(`Элемент ${element.id}: «${element.object_type}» нельзя уменьшить (scale в Layout страницы)`);
  object.group.scale.setScalar(scale);
  const addAnchor = object.addAnchor;
  return Object.assign(object, {
    hooks: (object.hooks ?? [object.hook]).map((hook) => hook.clone().multiplyScalar(scale)),
    halfExtents: object.halfExtents.clone().multiplyScalar(scale),
    addAnchor: (x) => addAnchor(x / scale).multiplyScalar(scale),
  });
}

// Габариты объекта в его собственных координатах: по всем мешам, кроме
// инстансов (шарики внутри клетки), — и невидимым оболочкам для клика тоже.
function localBounds(group) {
  group.updateWorldMatrix(true, true);
  const inverse = group.matrixWorld.clone().invert();
  const relative = new THREE.Matrix4();
  const part = new THREE.Box3();
  const box = new THREE.Box3();
  group.traverse((mesh) => {
    if (!mesh.isMesh || mesh.isInstancedMesh) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    box.union(part.copy(mesh.geometry.boundingBox).applyMatrix4(relative.multiplyMatrices(inverse, mesh.matrixWorld)));
  });
  return box;
}

const easeIn = (t) => t * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

// hidden — собрать страницу поднятой над потолком, чтобы потом спустить (descend).
// gust — качнуть элементы сразу после сборки.
export async function buildPage(number, { scheme, physics, hidden = false, gust = false }) {
  const { RAPIER, world } = physics;
  const { elements, root } = pageElements(scheme, number);
  const layout = parsePageLayout(pageSettings(scheme, number), number, elements);
  const { scale } = layout;
  const home = pageAnchor(number);
  const group = new THREE.Group();
  group.name = `page-${number}`;
  // Точка подвеса кинематическая: её поднимают и опускают вместе со всей страницей.
  const anchorBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(home.x, home.y, home.z),
  );
  const nodes = [];

  // width — в метрах стандартной сборки, размеры готового объекта — уже в масштабе.
  const make = async (element, width, parent = null) => {
    const build = OBJECT_TYPES[element.object_type];
    if (!build) throw new Error(`Неизвестный object_type «${element.object_type}» у элемента ${element.id}`);
    const { suspension = 1 } = layout.element(element.id);
    const { element: plain, neon } = neonStyle(element);
    const object = await build({ element: plain, width, label: parent?.element.title ?? '', suspension, neon });
    if ((object.hooks ?? [object.hook]).length !== suspension) {
      throw new Error(`Элемент ${element.id}: «${element.object_type}» не умеет висеть на ${suspension} цепях (suspension в Layout страницы)`);
    }
    return scaleObject(object, scale, element);
  };

  // parent — { body, at(x) }: at возвращает точку подвеса { anchor, world }
  // на теле body в точке x (поперёк, от его центра). length — в метрах стандартной сборки.
  const hang = (element, object, parent, length) => {
    const points = (object.hooks ?? [object.hook]).map((hook) => parent.at(hook.x));
    const rig = hangOnChain(physics, { parent: { body: parent.body, points }, length: length * scale, load: object, scale });
    object.attach?.({ physics, body: rig.load });
    const node = { element, object, rig };
    object.group.userData.node = node;
    group.add(object.group, rig.mesh);
    rig.sync(object.group);
    nodes.push(node);
    return node;
  };

  // Строки дочерних элементов. flow: auto — блочные по одному в строке, inline
  // рядом; row — все в одну строку; column — каждый в своей строке.
  const placeChildren = async (parent) => {
    const children = childrenOf(elements, parent.element.id);
    const settings = layout.rows(parent.element.id);
    const flow = settings.flow ?? 'auto';
    const rows = [];
    if (flow === 'row') {
      if (children.length) rows.push(children);
    } else if (flow === 'column') {
      rows.push(...children.map((child) => [child]));
    } else {
      let inline = null;
      for (const child of children) {
        if (layoutFlow(child) === 'inline') {
          if (!inline) rows.push((inline = []));
          inline.push(child);
        } else {
          rows.push([child]);
          inline = null;
        }
      }
    }
    // Размеры строки в метрах стандартной сборки.
    const rowWidth = settings.width === 'parent' ? (parent.object.halfExtents.x * 2) / scale : settings.width ?? SIGN.width;
    const rowGap = settings.gap ?? SIGN.rowGap;
    const rowChain = settings.chain ?? CHAIN.childLength;

    // x — середина элемента относительно оси родителя, в метрах сцены.
    let above = [{ node: parent, x: 0 }];
    const placed = [];
    for (const row of rows) {
      const own = row.map((element) => layout.element(element.id));
      const gaps = own.map((o, i) => (i === 0 ? 0 : o.gap_before ?? rowGap));
      const share = (rowWidth - gaps.reduce((sum, g) => sum + g, 0)) / row.length;
      const objects = await Promise.all(row.map((element, i) => make(element, own[i].width ?? share, parent)));
      const widths = objects.map((object) => object.halfExtents.x * 2);
      let left = -(widths.reduce((sum, w) => sum + w, 0) + gaps.reduce((sum, g) => sum + g, 0) * scale) / 2;
      const current = row.map((element, i) => {
        left += gaps[i] * scale;
        const x = left + widths[i] / 2;
        left += widths[i];
        const holder = above.reduce((best, item) => (Math.abs(item.x - x) < Math.abs(best.x - x) ? item : best));
        const body = holder.node.rig.load;
        const at = (dx) => {
          const anchor = holder.node.object.addAnchor(x + dx - holder.x);
          return { anchor, world: new THREE.Vector3().copy(body.translation()).add(anchor) };
        };
        return { node: hang(element, objects[i], { body, at }, own[i].chain ?? rowChain), x };
      });
      placed.push(...current);
      above = current;
    }
    for (const { node } of placed) await placeChildren(node);
  };

  if (root) {
    const own = layout.element(root.id);
    const object = await make(root, own.width ?? SIGN.width);
    const at = (dx) => ({ anchor: new THREE.Vector3(dx, 0, 0), world: home.clone().add(new THREE.Vector3(dx, 0, 0)) });
    const node = hang(root, object, { body: anchorBody, at }, own.chain ?? CHAIN.rootLength);
    await placeChildren(node);
  }

  const shown = new Set(nodes.map((node) => node.element.id));
  for (const element of elements) {
    if (!shown.has(element.id)) {
      console.warn(`Элемент ${element.id} не показан: anchor_point_id ${element.anchor_point_id} не ведёт к корню страницы ${number}`);
    }
  }

  // Габариты страницы в покое (без цепей) — по ним ставится камера.
  const restBounds = nodes.reduce((box, node) => box.union(new THREE.Box3().setFromObject(node.object.group)), new THREE.Box3());
  // На сколько поднять точку подвеса, чтобы вся страница ушла за потолок.
  const clearance = restBounds.isEmpty() ? 0 : STATION.ceiling - restBounds.min.y + 0.3;

  const sync = () => nodes.forEach((node) => node.rig.sync(node.object.group));
  if (hidden) {
    nodes.forEach((node) => node.rig.shift(clearance));
    anchorBody.setTranslation({ x: home.x, y: home.y + clearance, z: home.z }, true);
    sync();
  }
  if (gust) nodes.forEach((node) => node.rig.push(new THREE.Vector3(...CHAIN.startImpulse).multiplyScalar(scale)));

  // Плавное движение точки подвеса по вертикали, в шагах физики.
  let motion = null;
  const unsubscribe = physics.onStep(() => {
    if (!motion) return;
    motion.time = Math.min(motion.time + world.timestep, motion.duration);
    const y = motion.from + (motion.to - motion.from) * motion.ease(motion.time / motion.duration);
    anchorBody.setNextKinematicTranslation({ x: home.x, y, z: home.z });
    if (motion.time >= motion.duration) {
      const { resolve } = motion;
      motion = null;
      resolve();
    }
  });
  const moveAnchor = (to, duration, ease) => new Promise((resolve) => {
    motion = { from: anchorBody.translation().y, to, duration, ease, time: 0, resolve };
  });

  // Для distanceTo: габариты каждого объекта, они качаются вместе с ним.
  const extents = nodes.map((node) => localBounds(node.object.group));
  const local = new THREE.Vector3();

  const nodeOf = (object) => {
    for (let o = object; o; o = o.parent) if (o.userData.node) return o.userData.node;
    return null;
  };

  return {
    number,
    group,
    nodes,
    scale,
    camera: layout.camera,
    restBounds,
    pickables: nodes.flatMap((node) => node.object.pickables),
    nodeOf,
    // Расстояние от точки до ближайшего объекта страницы — до его габаритов
    // в том положении, в каком он сейчас нарисован. Цепи не считаются.
    distanceTo(point) {
      let nearest = Infinity;
      nodes.forEach((node, i) => {
        const body = node.object.group;
        extents[i].clampPoint(body.worldToLocal(local.copy(point)), local);
        nearest = Math.min(nearest, body.localToWorld(local).distanceTo(point));
      });
      return nearest;
    },
    sync,
    // Каждый кадр: положения из физики и собственная жизнь объектов (надпись, шарики).
    update(dt) {
      sync();
      for (const node of nodes) node.object.update?.(dt);
    },
    // Спуститься из-под потолка на место и подняться за потолок.
    descend: (duration) => moveAnchor(home.y, duration, easeOut),
    ascend: (duration) => moveAnchor(home.y + clearance, duration, easeIn),
    dispose() {
      unsubscribe();
      for (const node of nodes) {
        node.rig.dispose();
        node.object.dispose();
      }
      world.removeRigidBody(anchorBody);
      group.removeFromParent();
    },
  };
}
