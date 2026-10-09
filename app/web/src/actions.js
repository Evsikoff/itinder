import { isEmpty } from './page/scheme.js';
import { ApiError, postJson } from './api.js';
import { currentUser, signIn } from './session.js';
import { pickFile } from './filePicker.js';
import { resumeProblem, sortResume } from './hat/hat.js';

// Дополнительные действия элементов (поле «additional action» в ui_scheme.json).
// Действие запускается кликом по элементу и получает контекст: текущую страницу,
// нажатый элемент (node), схему экранов (scheme), звуки станции и cover(on) —
// экран действия закрыл сцену (её можно не рисовать). Если у элемента есть
// и ссылка (link_to_page), страница откроется после успешного действия. Действие
// возвращает { message } — что сказать пользователю, { message, link } — открыть
// страницу link вместо ссылки элемента, { message, room: true } — после него
// камера садится в поезд и уходит в комнату (boarding.js), ссылка не открывается,
// { cancelled: true } — пользователь передумал (ни сообщения, ни перехода),
// или бросает ActionError с объяснением для него.

// Ошибка для пользователя. status — код ответа сервера, если отказал он;
// offer — что предложить взамен: { label, link } — кнопка в сообщении об ошибке,
// открывает страницу link.
export class ActionError extends Error {
  constructor(message, { status, offer } = {}) {
    super(message);
    this.status = status;
    this.offer = offer;
  }
}

const RESUME_TYPES = 'application/pdf,.pdf';
const REGISTER_ACTION = 'Creating a user record';
const SELECT_ACTION = 'Save selection and enter the room';

// Поле ввода объекта этого типа: на странице оно должно быть ровно одно.
function fieldOf(page, action, objectType, purpose) {
  const nodes = page.nodes.filter((node) => node.element.object_type === objectType && node.object.field);
  if (nodes.length !== 1) {
    throw new Error(`«${action}» на странице ${page.number}: нужно ровно одно поле «${objectType}» (${purpose}), найдено ${nodes.length}`);
  }
  return nodes[0].object.field;
}

// Запрос к серверу: его отказ (неверные данные, сервер не отвечает) — ошибка для пользователя.
async function request(label, path, data) {
  try {
    return await postJson(label, path, data);
  } catch (error) {
    throw error instanceof ApiError ? new ActionError(error.message, { status: error.status }) : error;
  }
}

// Страница с элементом, у которого additional action — action, ближайшая
// по номеру к странице number; из двух одинаково близких — та, что дальше
// по станции. Такой страницы нет — null.
function nearestPageWith(scheme, action, number) {
  const pages = [...new Set(scheme.filter((row) => row['additional action'] === action).map((row) => Number(row.page)))];
  const distance = (page) => Math.abs(page - number);
  return pages.sort((a, b) => distance(a) - distance(b) || b - a)[0] ?? null;
}

// Страница, куда ведёт регистрация: link_to_page элемента с «Creating a user
// record» на ближайшей к number странице с ним. Такой ссылки нет — null.
function pageAfterRegistration(scheme, number) {
  const page = nearestPageWith(scheme, REGISTER_ACTION, number);
  const row = scheme.find((row) => Number(row.page) === page && row['additional action'] === REGISTER_ACTION && !isEmpty(row.link_to_page));
  return row ? Number(row.link_to_page) : null;
}

// Регистрация: почта с доски, пароль из клетки. Запись создаёт сервер
// (app/tools/serve.py → app/db/users/<id>.json). Зарегистрированный становится
// текущим пользователем вкладки (session.js).
async function createUserRecord({ page }) {
  const action = REGISTER_ACTION;
  const email = fieldOf(page, action, 'Chalkboard', 'e-mail').value;
  const password = fieldOf(page, action, 'Oblong birdcage', 'пароль').value;
  const answer = await request('Регистрация', '/api/users', { email, password });
  signIn(answer);
  return { message: 'Профиль создан', user: answer };
}

// Вход: почта с доски и пароль из клетки той же страницы сверяются с записями
// в app/db/users (POST /api/login), вошедший становится текущим пользователем
// вкладки. Специализация уже записана — посадка в поезд и комната, как после
// ручного выбора; нет — та же страница, куда ведёт регистрация (выбор роли).
// Почта или пароль не подошли — в сообщении об ошибке кнопка регистрации:
// ближайшая по номеру страница с «Creating a user record».
async function authorize({ page, scheme }) {
  const action = 'Authorization';
  const email = fieldOf(page, action, 'Chalkboard', 'e-mail').value;
  const password = fieldOf(page, action, 'Oblong birdcage', 'пароль').value;
  let answer;
  try {
    answer = await request('Вход', '/api/login', { email, password });
  } catch (error) {
    const register = nearestPageWith(scheme, REGISTER_ACTION, page.number);
    if (error.status === 401 && register !== null && register !== page.number) {
      error.offer = { label: 'Зарегистрироваться', link: register };
    }
    throw error;
  }
  signIn(answer);
  if (answer.has_specialization) return { message: 'Вход выполнен', user: answer, room: true };
  const next = pageAfterRegistration(scheme, page.number);
  if (next === null) throw new Error(`В схеме экранов нет элемента с «${REGISTER_ACTION}» и ссылкой: после входа некуда вести`);
  return { message: 'Вход выполнен: специализация ещё не выбрана', user: answer, link: next };
}

// Распознавание резюме: PDF из диалога выбора файла → экран распределительной
// шляпы (hat/hat.js). Согласие с нейросетью записывает специализацию и грейд
// в app/db/user_specializations и ведёт в комнату через поезд; возврат к ручному
// выбору — отказ от действия.
async function recognizeResume({ sounds, cover }) {
  const user = currentUser();
  if (!user) throw new ActionError('Шляпе нужно знать, кого распределять: сначала создайте профиль');
  // Диалог открывается в том же клике (до первого await), иначе браузер его не покажет.
  const file = await pickFile(RESUME_TYPES);
  if (!file) return { cancelled: true };
  const problem = resumeProblem(file);
  if (problem) throw new ActionError(problem);
  const record = await sortResume({ file, userId: user.id, pickResume: () => pickFile(RESUME_TYPES), sounds, cover });
  if (!record) return { cancelled: true };
  return { message: `Записано: ${record.specialization}, ${record.grade}`, record, room: true };
}

// Ручной выбор: кнопка грейда под карточкой специализации. Запись в
// app/db/user_specializations делает сервер по id нажатого элемента: грейд —
// заголовок кнопки, специализация — заголовок карточки, под которой она висит
// (app/tools/specializations.py). Потом камера садится в поезд и уходит в комнату.
async function saveSelection({ node }) {
  const user = currentUser();
  if (!user) throw new ActionError('Выбор записывается в профиль: сначала создайте его');
  const record = await request('Запись выбора', '/api/user_specializations', { user_id: user.id, element_id: node.element.id });
  return { message: `Записано: ${record.specialization}, ${record.grade}`, record, room: true };
}

const ACTIONS = {
  [REGISTER_ACTION]: createUserRecord,
  'Authorization': authorize,
  'User resume recognition': recognizeResume,
  [SELECT_ACTION]: saveSelection,
};

export const hasAction = (element) => !isEmpty(element?.['additional action']);

export function actionOf(element) {
  const name = element['additional action'];
  const action = ACTIONS[name];
  if (!action) throw new Error(`Неизвестное additional action «${name}» у элемента ${element.id}`);
  return action;
}
