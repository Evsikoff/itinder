// Схема экранов: app/db/ui_scheme.json (выгрузка таблицы itinder_ui_scheme).

const SCHEME_URL = new URL('../../../db/ui_scheme.json', import.meta.url);

export async function loadScheme() {
  const response = await fetch(SCHEME_URL);
  if (!response.ok) throw new Error(`Не удалось загрузить ${SCHEME_URL.pathname}: ${response.status}`);
  return response.json();
}

export const isEmpty = (value) => value === null || value === undefined || String(value).trim() === '';

// Строка с object_type «Page» — не элемент сцены, а настройки страницы.
export const PAGE_TYPE = 'Page';

// Строка настроек страницы или null. Таких строк на странице не больше одной.
export function pageSettings(scheme, page) {
  const rows = scheme.filter((row) => String(row.page) === String(page) && row.object_type === PAGE_TYPE);
  if (rows.length > 1) throw new Error(`На странице ${page} несколько строк «${PAGE_TYPE}»: ${rows.map((row) => row.id).join(', ')}`);
  return rows[0] ?? null;
}

// Элементы страницы и её корень — элемент без anchor_point_id. Пустая страница
// допустима (на неё уже ведёт ссылка, а элементы ещё не добавлены): root = null.
export function pageElements(scheme, page) {
  const elements = scheme.filter((row) => String(row.page) === String(page) && row.object_type !== PAGE_TYPE);
  const roots = elements.filter((row) => isEmpty(row.anchor_point_id));
  if (elements.length === 0) return { elements, root: null };
  if (roots.length !== 1) {
    throw new Error(`На странице ${page} должен быть ровно один корневой элемент (пустой anchor_point_id), найдено: ${roots.length}`);
  }
  return { elements, root: roots[0] };
}

// Все страницы, которые есть в схеме или на которые ведут ссылки.
export function knownPages(scheme) {
  const pages = new Set();
  for (const row of scheme) {
    if (!isEmpty(row.page)) pages.add(Number(row.page));
    if (!isEmpty(row.link_to_page)) pages.add(Number(row.link_to_page));
  }
  return [...pages].sort((a, b) => a - b);
}

// Элементы, привязанные к элементу id, в порядке их id.
export function childrenOf(elements, id) {
  return elements
    .filter((row) => !isEmpty(row.anchor_point_id) && String(row.anchor_point_id) === String(id))
    .sort((a, b) => a.id - b.id);
}

// «##RRGGBB» в background_hex — неоновый стиль объекта в цвете #RRGGBB.
// Возвращает элемент с обычной записью цвета и признак неона.
export function neonStyle(element) {
  const value = element.background_hex;
  if (typeof value !== 'string' || !value.startsWith('##')) return { element, neon: false };
  return { element: { ...element, background_hex: value.slice(1) }, neon: true };
}

// Пути в схеме записаны от корня проекта в стиле Windows: \app\assets\logo.png.
export function assetUrl(path) {
  const clean = String(path).replace(/\\/g, '/').replace(/^\/+/, '');
  return new URL(`/${clean}`, window.location.origin).href;
}
