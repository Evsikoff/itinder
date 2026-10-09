import { assetUrl } from '../page/scheme.js';
import { ApiError, failureLines, postFile, postJson } from '../api.js';
import { buildCues, cueAt } from './subtitles.js';
import { loadReplicas, mediaUrl, resultReplica, startReplica } from './replicas.js';

// Экран распределительной шляпы — действие «User resume recognition» (actions.js).
//
// Фаза 1. Шляпа говорит вступление (реплика с case = start) с субтитрами, а
// резюме тем временем уходит на распознавание: POST /api/resume → нейросеть
// (app/tools/resume.py). Когда вступление кончилось и ответ есть, начинается
// реплика на итог. Видео играют в двух слоях: следующее загружается в нижний
// и подменяет верхнее в тот кадр, когда оно готово, а последний кадр одной
// реплики и первый другой у шляпы одинаковые — склейки не видно. Пока ответа
// нет, на экране последний кадр вступления.
//
// Фаза 2. Последний кадр размывается, поверх — вердикт: специализация и грейд
// картинками или почему шляпа не справилась, и что делать дальше.
// Подробности распознавания (какая нейросеть ответила, почему не справились
// другие, что сломалось) — в консоли браузера. Стили — hat.css.

export const MAX_RESUME = 5 * 1024 * 1024; // байт, как MAX_PDF в app/tools/resume.py

const FADE = 450;     // мс: экран появляется и исчезает
const UNBLUR = 600;   // мс: вердикт уходит, кадр становится резким
// Сторож видео: если время не идёт столько проверок подряд, реплика считается
// законченной, чтобы экран не завис (у самого конца браузер порой не шлёт ended).
const WATCH = 500;    // мс между проверками
const STALL = { end: 2, middle: 16 };

const SPECIALIZATION_IMAGES = {
  Backend: '\\app\\assets\\backend.png',
  Frontend: '\\app\\assets\\frontend.png',
  QA: '\\app\\assets\\qa.png',
  'Syst. Analyst': '\\app\\assets\\systanalyst.png',
};
// Цвета грейдов — как у кнопок грейдов на странице 5.
const GRADES = {
  Junior: { image: '\\app\\assets\\junior.png', color: '#C2BCFF' },
  Middle: { image: '\\app\\assets\\middle.png', color: '#A097FF' },
  Senior: { image: '\\app\\assets\\senior.png', color: '#7063FF' },
};
const FAILURES = {
  not_resume: 'Это не резюме',
  no_match: 'Ни одна специализация не подошла',
  technical: 'Что-то сломалось',
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function image(path) {
  const node = el('img');
  node.src = assetUrl(path);
  node.alt = '';
  node.decoding = 'async';
  return node;
}

// Картинки вердикта (по 1–3 МБ) грузятся, пока шляпа договаривает реплику на итог,
// и в вердикт идут те же элементы: сервер запрещает кэш, новый <img> грузил бы заново.
const preloaded = new Map();
function preload(...paths) {
  for (const path of paths) if (path && !preloaded.has(path)) preloaded.set(path, image(path));
}
function takeImage(path) {
  const node = preloaded.get(path) ?? image(path);
  preloaded.delete(path);
  return node;
}

// Что не так с файлом резюме, или null. Тип файла не проверяется: не PDF
// шляпа сама назовёт «не резюме».
export function resumeProblem(file) {
  if (file.size > MAX_RESUME) return `Файл больше ${MAX_RESUME / 1024 / 1024} МБ — резюме столько не весит`;
  return null;
}

// --- Сервер ---

const LABEL = 'Распознавание резюме';
// Дольше сервер не думает: Gemini и DeepSeek — максимум 15 с на подключение и
// 120 на ответ каждая, вторая начинает не позже чем через 20 с (app/tools/llm.py).
const RECOGNITION_TIMEOUT = 180_000;
const RESULTS = ['match', 'no_match', 'not_resume'];

// Итог распознавания: { result: match | no_match | not_resume, ... } от сервера
// или { result: technical, error }, если сервер или нейросеть не ответили
// (почему — api.js уже написал в консоль).
async function recognize(file) {
  let answer;
  try {
    answer = await postFile(LABEL, '/api/resume', file, 'application/pdf', RECOGNITION_TIMEOUT);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { result: 'technical', error: error.message };
  }
  if (!RESULTS.includes(answer.result)) {
    console.error(`${LABEL}: сервер ответил непонятно`, answer);
    return { result: 'technical', error: 'Сервер ответил непонятно' };
  }
  const who = answer.source ? `${answer.source.llm} (${answer.source.model})` : 'сервер, без нейросети';
  if (answer.failures?.length) {
    console.warn([`${LABEL}: ответила ${who}, а до неё не справились:`, ...failureLines(answer.failures)].join('\n'));
  }
  const verdict = answer.result === 'match' ? `${answer.specialization}, ${answer.grade}` : answer.result;
  console.info(`${LABEL}: ${verdict} — ${who}. ${answer.reason ?? ''}`.trim());
  return answer;
}

const saveSpecialization = (userId, recognitionId) =>
  postJson('Запись специализации', '/api/user_specializations', { user_id: userId, recognition_id: recognitionId });

// --- Видео в двух слоях ---

function createPlayer(stage, subtitle) {
  const layers = [0, 1].map(() => {
    const video = el('video', 'hat-video');
    video.playsInline = true;
    video.preload = 'auto';
    video.disablePictureInPicture = true;
    video.setAttribute('disableremoteplayback', '');
    // В меню по правой кнопке есть «Показать элементы управления».
    video.addEventListener('contextmenu', (event) => event.preventDefault());
    stage.append(video);
    return { video, cues: [] };
  });
  let front = null;
  let frame = 0;
  let shown = '';

  // Субтитр верхнего слоя — по его времени, каждый кадр.
  const follow = () => {
    const text = (front && cueAt(front.cues, front.video.currentTime)?.text) || '';
    if (text !== shown) {
      shown = text;
      if (text) subtitle.textContent = text;
      subtitle.classList.toggle('shown', Boolean(text));
    }
    frame = requestAnimationFrame(follow);
  };

  return {
    start() {
      frame ||= requestAnimationFrame(follow);
    },
    // Загрузить видео в нижний слой. Промис — слой, когда видео можно играть,
    // или null, если видео у реплики нет или оно не загрузилось.
    load(url, text) {
      const layer = layers.find((item) => item !== front);
      const { video } = layer;
      return new Promise((resolve) => {
        if (!url) {
          resolve(null);
          return;
        }
        const done = (ready) => {
          video.removeEventListener('canplay', playable);
          video.removeEventListener('error', failed);
          resolve(ready ? layer : null);
        };
        const playable = () => {
          layer.cues = buildCues(text, video.duration);
          done(true);
        };
        const failed = () => {
          console.warn(`Видео шляпы не загрузилось: ${url}`);
          done(false);
        };
        video.addEventListener('canplay', playable);
        video.addEventListener('error', failed);
        video.src = url;
      });
    },
    // Сразу показать слой вместо верхнего и запустить. Промис — когда видео
    // кончилось. Если браузер не дал звук без жеста, unlock() ждёт этого жеста.
    play(layer, unlock) {
      const { video } = layer;
      video.classList.add('front');
      if (front && front !== layer) {
        front.video.classList.remove('front');
        front.video.pause();
      }
      front = layer;
      return new Promise((resolve) => {
        let last = -1;
        let still = 0;
        const watch = setInterval(() => {
          if (video.paused) return; // ещё ждёт жеста
          still = video.currentTime === last ? still + 1 : 0;
          last = video.currentTime;
          const atEnd = video.currentTime >= video.duration - 0.25;
          if (still >= (atEnd ? STALL.end : STALL.middle)) {
            console.warn(`Видео шляпы застряло на ${last.toFixed(2)} с из ${video.duration.toFixed(2)}: ${video.currentSrc}`);
            finish();
          }
        }, WATCH);
        const finish = () => {
          clearInterval(watch);
          video.removeEventListener('ended', finish);
          video.removeEventListener('error', finish);
          resolve();
        };
        video.addEventListener('ended', finish);
        video.addEventListener('error', finish);
        video.play().catch(async (error) => {
          if (error.name !== 'NotAllowedError') {
            finish();
            return;
          }
          await unlock();
          video.play().catch(finish);
        });
      });
    },
    stop() {
      cancelAnimationFrame(frame);
      frame = 0;
      for (const layer of layers) {
        layer.video.pause();
        layer.video.classList.remove('front');
        layer.video.removeAttribute('src');
        layer.video.load();
        layer.cues = [];
      }
      front = null;
      shown = '';
      subtitle.classList.remove('shown');
    },
  };
}

// --- Экран ---

let view = null;
function screen() {
  if (view) return view;
  const root = el('div', 'hat');
  root.hidden = true;
  root.tabIndex = -1;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Распределительная шляпа');
  const frame = el('div', 'hat-frame');
  const stage = el('div', 'hat-stage');
  const subtitle = el('p', 'hat-subtitle');
  const player = createPlayer(stage, subtitle);
  const thinking = el('p', 'hat-thinking', 'Шляпа думает');
  thinking.append(el('span', 'hat-dots'));
  const unmute = el('button', 'hat-unmute', 'Слушать шляпу');
  unmute.type = 'button';
  stage.append(thinking, unmute);
  frame.append(stage, subtitle);
  const verdict = el('section', 'hat-verdict');
  verdict.setAttribute('aria-live', 'polite');
  verdict.inert = true; // скрытый вердикт: его кнопки не должны ловить Tab и клики
  root.append(frame, verdict);
  document.body.append(root);
  view = { root, verdict, thinking, unmute, player };
  return view;
}

function open() {
  view.root.hidden = false;
  view.root.getBoundingClientRect(); // чтобы переход прозрачности начался с нуля
  view.root.classList.add('open');
  view.root.focus({ preventScroll: true });
  view.player.start();
}

function close() {
  view.root.classList.remove('open');
  view.verdict.inert = true; // пока экран гаснет, его кнопки уже не нажать
  setTimeout(() => {
    if (view.root.classList.contains('open')) return; // открыли снова, пока гас
    view.root.hidden = true;
    view.root.classList.remove('judged');
    view.verdict.classList.remove('shown');
    view.verdict.replaceChildren();
    view.player.stop();
  }, FADE);
}

// Браузер не дал включить видео со звуком без жеста: кнопка поверх кадра.
function unlock() {
  return new Promise((resolve) => {
    view.unmute.classList.add('shown');
    view.unmute.focus({ preventScroll: true });
    view.unmute.onclick = () => {
      view.unmute.classList.remove('shown');
      view.unmute.onclick = null;
      resolve();
    };
  });
}

// Фаза 1: вступление, распознавание, реплика на итог. Промис — итог
// распознавания, когда реплика на него договорена.
async function listen(replicas, file) {
  const { player } = view;
  const request = recognize(file);
  if (view.root.classList.contains('judged')) {
    view.root.classList.remove('judged');
    view.verdict.classList.remove('shown');
    view.verdict.inert = true;
    view.root.focus({ preventScroll: true });
    await delay(UNBLUR);
  }
  const start = startReplica(replicas);
  // intro — когда вступление на экране; дальше нижний слой свободен для реплики на итог.
  const intro = player.load(mediaUrl(start?.video), start?.text)
    .then((layer) => ({ ended: layer ? player.play(layer, unlock) : Promise.resolve() }));
  const next = Promise.all([request, intro]).then(async ([outcome]) => {
    if (outcome.result === 'match') preload(SPECIALIZATION_IMAGES[outcome.specialization], GRADES[outcome.grade]?.image);
    const replica = resultReplica(replicas, outcome);
    return { outcome, layer: await player.load(mediaUrl(replica?.video), replica?.text) };
  });
  await (await intro).ended;
  view.thinking.classList.add('shown');
  const { outcome, layer } = await next;
  view.thinking.classList.remove('shown');
  if (layer) await player.play(layer, unlock);
  return outcome;
}

function button(text, kind, onClick) {
  const node = el('button', `hat-button ${kind}`.trim(), text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function sourceLine(source) {
  if (source?.type !== 'LLM') return null;
  return el('p', 'hat-source', `Распознала нейросеть ${source.llm}${source.model ? ` (${source.model})` : ''}`);
}

// Картинки вердикта: фигурка специализации и медаль грейда.
function figure({ specialization, grade }) {
  const node = el('div', 'hat-figure');
  const card = el('div', 'hat-specialization');
  const picture = el('div', 'hat-picture');
  if (SPECIALIZATION_IMAGES[specialization]) picture.append(takeImage(SPECIALIZATION_IMAGES[specialization]));
  card.append(picture, el('span', null, specialization));
  const medal = el('div', 'hat-grade');
  const style = GRADES[grade];
  if (style) {
    medal.style.setProperty('--grade', style.color);
    medal.append(takeImage(style.image));
  }
  medal.append(el('span', null, grade));
  node.append(card, medal);
  return node;
}

// Фаза 2. Промис — { record } (согласился, запись сохранена), { file }
// (выбрал другое резюме) или null (вернулся к ручному выбору).
function decide(outcome, { userId, pickResume }) {
  return new Promise((resolve) => {
    const match = outcome.result === 'match';
    const card = el('div', `hat-card ${match ? 'match' : 'failure'}`);
    const text = el('div', 'hat-text');
    const error = el('p', 'hat-error');
    error.setAttribute('role', 'alert');
    const actions = el('div', 'hat-actions');
    const fail = (message) => {
      error.textContent = message;
    };

    if (match) {
      text.append(el('p', 'hat-eyebrow', 'Шляпа решила'), el('h2', 'hat-title', `${outcome.specialization} · ${outcome.grade}`));
      card.append(figure(outcome));
    } else {
      text.append(el('p', 'hat-eyebrow', 'Шляпа не смогла распределить'), el('h2', 'hat-title', FAILURES[outcome.result] ?? FAILURES.technical));
    }
    const reason = outcome.reason || outcome.error;
    if (reason) text.append(el('p', 'hat-reason', reason));
    const source = sourceLine(outcome.source);
    if (source) text.append(source);
    text.append(error, actions);
    [...text.children].forEach((child, i) => child.style.setProperty('--i', i));
    card.append(text);

    const buttons = [];
    if (match) {
      buttons.push(button('Согласиться', 'primary', async () => {
        buttons.forEach((item) => (item.disabled = true));
        fail('');
        try {
          resolve({ record: await saveSpecialization(userId, outcome.id) });
        } catch (problem) {
          fail(problem.message);
          buttons.forEach((item) => (item.disabled = false));
        }
      }));
    }
    // Диалог выбора файла — прямо в клике, иначе браузер его не покажет.
    buttons.push(button('Загрузить другое резюме', match ? '' : 'primary', () => {
      fail('');
      pickResume().then((file) => {
        if (!file) return;
        const problem = resumeProblem(file);
        if (problem) fail(problem);
        else resolve({ file });
      });
    }));
    buttons.push(button('Вернуться к ручному выбору', 'quiet', () => resolve(null)));
    actions.append(...buttons);

    view.verdict.replaceChildren(card);
    view.root.classList.add('judged');
    view.verdict.classList.add('shown');
    view.verdict.inert = false;
    buttons[0].focus({ preventScroll: true });
  });
}

// Экран шляпы для выбранного файла. Промис — запись специализации
// ({ id, user_id, specialization, grade, created_at, source }), если пользователь
// согласился с нейросетью, или null — он вернулся к ручному выбору.
// pickResume() — открыть диалог выбора другого резюме; sounds — звуки станции,
// они затихают, пока говорит шляпа; cover(on) — экран закрыл сцену или открыл.
export async function sortResume({ file, userId, pickResume, sounds, cover }) {
  screen();
  const replicas = await loadReplicas().catch((error) => {
    console.warn('Реплики шляпы не загрузились, она будет молчать:', error);
    return [];
  });
  open();
  sounds?.duck(true);
  const covering = setTimeout(() => cover?.(true), FADE);
  try {
    for (let next = file; ;) {
      const outcome = await listen(replicas, next);
      const choice = await decide(outcome, { userId, pickResume });
      if (!choice?.file) return choice?.record ?? null;
      next = choice.file;
    }
  } finally {
    clearTimeout(covering);
    close();
    sounds?.duck(false);
    cover?.(false);
  }
}
