import { assetUrl, isEmpty } from '../page/scheme.js';

// Реплики шляпы: app/db/hat_replicas.json (выгрузка таблицы itinder_hat_replicas).
// Реплика выбирается по полю case (start — вступление), по паре specialization
// и grade или по ошибке error.

const REPLICAS_URL = new URL('../../../db/hat_replicas.json', import.meta.url);

// Итог распознавания (поле result ответа /api/resume, technical — сервер или
// нейросеть не ответили) → значение error у реплики.
const ERRORS = {
  not_resume: 'Not a résumé',
  no_match: 'It is impossible to match the resume with the available positions and grade levels.',
  technical: 'Technical error',
};

let loading = null;
export function loadReplicas() {
  loading ??= fetch(REPLICAS_URL).then((response) => {
    if (!response.ok) throw new Error(`Не удалось загрузить ${REPLICAS_URL.pathname}: ${response.status}`);
    return response.json();
  });
  // Неудачную загрузку можно повторить со следующим резюме.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

export const startReplica = (replicas) => replicas.find((row) => same(row.case, 'start')) ?? null;

// Реплика на итог: { result, specialization, grade } — пара; иначе ошибка.
// Нет реплики на ошибку — реплика технической ошибки.
export function resultReplica(replicas, { result, specialization, grade }) {
  if (result === 'match') {
    const pair = replicas.find((row) => isEmpty(row.case) && same(row.specialization, specialization) && same(row.grade, grade));
    if (pair) return pair;
  }
  const error = ERRORS[result] ?? ERRORS.technical;
  return replicas.find((row) => same(row.error, error)) ?? replicas.find((row) => same(row.error, ERRORS.technical)) ?? null;
}

// Путь к видео в реплике: от папки app (assets\video\16.mp4) или,
// как в схеме экранов, от корня проекта (\app\assets\...).
export function mediaUrl(path) {
  if (isEmpty(path)) return null;
  const clean = String(path).trim().replace(/\\/g, '/').replace(/^\/+/, '');
  return clean.startsWith('app/') ? assetUrl(clean) : new URL(`../../../${clean}`, import.meta.url).href;
}
