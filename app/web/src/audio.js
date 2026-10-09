// Звуки сцены на Web Audio, файлы — app/assets/sfx. Гул пустой станции звучит
// всё время, шаги — пока камера едет от страницы к странице, остальное — по
// нажатию на объект и по клавишам, пока его поле ввода в фокусе.

const FOLDER = new URL('../../assets/sfx/', import.meta.url);
const RELEASE = 0.025; // с: постоянная затухания, когда звук обрывается, — чтобы не щёлкало
const DUCKED = 0.2;    // громкость станции, пока говорит шляпа (duck)
const DUCK_TIME = 0.25; // с: постоянная, с которой станция затихает и возвращается

// Из нескольких файлов звучит тот, что за сессию звучал реже всех, из равных —
// случайный. volume — громкость; mono — новое нажатие обрывает прежний звук,
// а не накладывается на него (запись мела длиннее паузы между клавишами);
// normalize — после загрузки файл усиливается так, чтобы его самый громкий
// момент был на полной шкале, и volume считается от неё (шлепки записаны
// на 35–40 дБ тише остальных звуков и ещё по-разному между собой).
const SOUNDS = {
  rumble: { files: ['rumble.mp3'], volume: 0.8 },
  footsteps: { files: ['footsteps.mp3'], volume: 1 },
  slap: { files: ['slap1.mp3', 'slap2.mp3', 'slap3.mp3'], volume: 0.9, normalize: true },
  writing: { files: ['writing.mp3'], volume: 1, mono: true },
  ball: { files: ['ball1.mp3', 'ball2.mp3', 'ball3.mp3', 'ball4.mp3'], volume: 1 },
};

// Звуки объектов по object_type: press — нажатие на объект, key — клавиша,
// пока поле объекта в фокусе.
export const OBJECT_SOUNDS = {
  'A sign like the ones in the Moscow Metro': { press: 'slap' },
  Chalkboard: { key: 'writing' },
  'Oblong birdcage': { key: 'ball' },
};

export function createSounds() {
  const context = new AudioContext();
  const master = context.createGain();
  master.connect(context.destination);
  const buffers = new Map(); // файл → AudioBuffer
  const plays = new Map();   // файл → сколько раз звучал за сессию
  const loops = new Map();   // имя → звучащая петля
  const wanted = new Set();  // петли, которые должны звучать
  const last = new Map();    // имя → последний звук, сыгранный play

  // Браузер включает звук только после первого жеста пользователя. В скрытой
  // вкладке сцена стоит, и звук тоже на паузе.
  let unlocked = false;
  const unlock = () => {
    unlocked = true;
    if (!document.hidden) context.resume();
  };
  for (const type of ['pointerdown', 'pointerup', 'keydown', 'touchend']) {
    window.addEventListener(type, unlock, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) context.suspend();
    else if (unlocked) context.resume();
  });

  // Реже всех звучавший из загруженных файлов, из равных — случайный.
  const pickFile = (name) => {
    const ready = SOUNDS[name].files.filter((file) => buffers.has(file));
    if (ready.length === 0) return null;
    const count = (file) => plays.get(file) ?? 0;
    const fewest = Math.min(...ready.map(count));
    const candidates = ready.filter((file) => count(file) === fewest);
    return candidates[Math.floor(Math.random() * candidates.length)];
  };

  const start = (name, loop = false) => {
    const file = pickFile(name);
    if (!file) return null;
    plays.set(file, (plays.get(file) ?? 0) + 1);
    const source = context.createBufferSource();
    source.buffer = buffers.get(file);
    source.loop = loop;
    const gain = context.createGain();
    gain.gain.value = SOUNDS[name].volume;
    source.connect(gain).connect(master);
    source.start();
    const voice = { source, gain, playing: true };
    source.onended = () => { voice.playing = false; };
    return voice;
  };

  const release = ({ source, gain }) => {
    const now = context.currentTime;
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.setTargetAtTime(0, now, RELEASE);
    source.stop(now + RELEASE * 6);
  };

  const sync = (name) => {
    const playing = loops.get(name);
    if (wanted.has(name) && !playing) {
      const voice = start(name, true);
      if (voice) loops.set(name, voice);
    } else if (!wanted.has(name) && playing) {
      loops.delete(name);
      release(playing);
    }
  };

  // Пик по всем каналам — на полную шкалу.
  const normalize = (buffer) => {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const peak = Math.max(...channels.map((data) => data.reduce((max, v) => Math.max(max, Math.abs(v)), 0)));
    if (peak > 0) for (const data of channels) for (let i = 0; i < data.length; i++) data[i] /= peak;
    return buffer;
  };

  const load = async (file) => {
    const response = await fetch(new URL(file, FOLDER));
    if (!response.ok) throw new Error(`${response.status} ${response.url}`);
    const buffer = await context.decodeAudioData(await response.arrayBuffer());
    const loud = Object.values(SOUNDS).some((sound) => sound.normalize && sound.files.includes(file));
    buffers.set(file, loud ? normalize(buffer) : buffer);
    // Петля, включённая до загрузки, начинает звучать сразу, как файл готов.
    for (const name of wanted) sync(name);
  };
  for (const file of new Set(Object.values(SOUNDS).flatMap((sound) => sound.files))) {
    load(file).catch((error) => console.warn(`Звук ${file} не загружен:`, error));
  }

  return {
    plays,
    // Включить или выключить петлю; можно звать каждый кадр.
    loop(name, on) {
      if (on) wanted.add(name);
      else wanted.delete(name);
      sync(name);
    },
    // Приглушить всю станцию (on) или вернуть громкость — пока звучит что-то поверх неё.
    duck(on) {
      master.gain.setTargetAtTime(on ? DUCKED : 1, context.currentTime, DUCK_TIME);
    },
    // Затихнуть совсем за seconds — сцена уходит (посадка в поезд).
    fadeOut(seconds) {
      master.gain.setTargetAtTime(0, context.currentTime, seconds / 4);
    },
    // Сыграть звук один раз. restart: false — ничего не делать, пока прошлый
    // ещё звучит (зажатая клавиша повторяется десятки раз в секунду).
    play(name, { restart = true } = {}) {
      const previous = last.get(name);
      if (!restart && previous?.playing) return;
      const voice = start(name);
      if (!voice) return;
      if (SOUNDS[name].mono && previous?.playing) release(previous);
      last.set(name, voice);
    },
  };
}
