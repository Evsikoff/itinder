import { isEmpty } from './scheme.js';

// Корректировки страницы — поле Layout строки «Page» той же страницы, JSON:
//
// {
//   "version": 1,
//   "scale": 0.58,                      // уменьшить собранную страницу целиком
//   "camera": { "mode": "close" },      // режим камеры у этой страницы
//   "rules": [                          // правила по id элементов, позднее перекрывает раннее
//     { "ids": [14], "width": 5.1, "chain": 2, "suspension": 2,
//       "rows": { "flow": "row", "width": "parent", "gap": 0.16, "chain": 0.15 } },
//     { "ids": [31], "gap_before": 0.4 }
//   ]
// }
//
// Всё, чего в правилах нет, собирается стандартно. Длины в метрах стандартной
// сборки (строка во всю ширину — SIGN.width), scale применяется к результату.
// Описание полей — в app/db/README.md.

const ELEMENT_KEYS = ['ids', 'width', 'chain', 'suspension', 'gap_before', 'rows'];
const ROW_KEYS = ['flow', 'width', 'gap', 'chain'];
const FLOWS = ['auto', 'row', 'column'];
const SUSPENSIONS = [1, 2];
const CAMERA_KEYS = ['mode'];
const CAMERA_MODES = ['eye', 'close'];

const STANDARD = { scale: 1, camera: { mode: 'eye' }, element: () => ({}), rows: () => ({}) };

export function parsePageLayout(settings, page, elements) {
  if (isEmpty(settings?.Layout)) return STANDARD;
  const where = `Layout страницы ${page} (строка ${settings.id})`;
  let spec = settings.Layout;
  if (typeof spec === 'string') {
    try {
      spec = JSON.parse(spec);
    } catch (error) {
      throw new Error(`${where}: не JSON — ${error.message}`);
    }
  }
  const fail = (message) => {
    throw new Error(`${where}: ${message}`);
  };
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const nonNegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const onlyKeys = (object, keys, path) => {
    for (const key of Object.keys(object)) if (!keys.includes(key)) fail(`неизвестное поле ${path}${key}, допустимы: ${keys.join(', ')}`);
  };

  if (!isObject(spec)) fail('ожидается объект');
  onlyKeys(spec, ['version', 'scale', 'camera', 'rules'], '');
  if (spec.version !== 1) fail(`version должна быть 1, сейчас ${JSON.stringify(spec.version)}`);
  const scale = spec.scale ?? 1;
  if (!positive(scale)) fail('scale — положительное число');
  const camera = spec.camera ?? {};
  if (!isObject(camera)) fail('camera — объект');
  onlyKeys(camera, CAMERA_KEYS, 'camera.');
  if (camera.mode !== undefined && !CAMERA_MODES.includes(camera.mode)) fail(`camera.mode — одно из: ${CAMERA_MODES.join(', ')}`);
  const rules = spec.rules ?? [];
  if (!Array.isArray(rules)) fail('rules — массив правил');

  const known = new Set(elements.map((element) => Number(element.id)));
  const byId = new Map();
  rules.forEach((rule, i) => {
    const path = `rules[${i}].`;
    if (!isObject(rule)) fail(`${path.slice(0, -1)} — объект`);
    onlyKeys(rule, ELEMENT_KEYS, path);
    if (!Array.isArray(rule.ids) || rule.ids.length === 0 || !rule.ids.every(Number.isInteger)) fail(`${path}ids — непустой массив id элементов`);
    if (rule.width !== undefined && !positive(rule.width)) fail(`${path}width — положительное число, м`);
    if (rule.chain !== undefined && !positive(rule.chain)) fail(`${path}chain — положительное число, м`);
    if (rule.suspension !== undefined && !SUSPENSIONS.includes(rule.suspension)) fail(`${path}suspension — 1 или 2`);
    if (rule.gap_before !== undefined && !nonNegative(rule.gap_before)) fail(`${path}gap_before — число не меньше 0, м`);
    if (rule.rows !== undefined) {
      const rows = rule.rows;
      if (!isObject(rows)) fail(`${path}rows — объект`);
      onlyKeys(rows, ROW_KEYS, `${path}rows.`);
      if (rows.flow !== undefined && !FLOWS.includes(rows.flow)) fail(`${path}rows.flow — одно из: ${FLOWS.join(', ')}`);
      if (rows.width !== undefined && rows.width !== 'parent' && !positive(rows.width)) fail(`${path}rows.width — положительное число, м, или "parent"`);
      if (rows.gap !== undefined && !nonNegative(rows.gap)) fail(`${path}rows.gap — число не меньше 0, м`);
      if (rows.chain !== undefined && !positive(rows.chain)) fail(`${path}rows.chain — положительное число, м`);
    }
    const { ids, rows, ...own } = rule;
    for (const id of ids) {
      if (!known.has(id)) console.warn(`${where}: элемента ${id} на странице нет, правило rules[${i}] для него не действует`);
      const merged = byId.get(id) ?? { rows: {} };
      Object.assign(merged, own);
      Object.assign(merged.rows, rows);
      byId.set(id, merged);
    }
  });

  return {
    scale,
    camera: { mode: camera.mode ?? 'eye' },
    // Свои поправки элемента: width, chain, suspension, gap_before.
    element: (id) => {
      const { rows, ...own } = byId.get(Number(id)) ?? {};
      return own;
    },
    // Поправки для строк его дочерних элементов: flow, width, gap, chain.
    rows: (id) => byId.get(Number(id))?.rows ?? {},
  };
}
