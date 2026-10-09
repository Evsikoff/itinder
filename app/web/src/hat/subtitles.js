// Субтитры к репликам шляпы. Разметки по времени у реплик нет, поэтому текст
// режется на фразы, и каждая показывается столько, сколько в ней букв, — речь
// идёт примерно с постоянной скоростью. Конец предложения добавляет паузу.

const MAX_LENGTH = 90;     // символов в одном субтитре, это две строки
const SENTENCE_PAUSE = 8;  // пауза после предложения — как столько букв
const LEAD = 0.3;          // с: тишина в начале видео
const TAIL = 0.6;          // с: тишина в конце

// Предложения вместе с закрывающими кавычками и пробелами после них.
const SENTENCES = /[^.!?…]+(?:[.!?…]+[»"”]?|$)\s*/g;
// Где можно разрезать длинное предложение: после запятой, двоеточия, точки с запятой и перед тире.
const BREAKS = /(?<=[,:;])\s+|\s+(?=[—–]\s)/;

function packed(parts, joiner) {
  const chunks = [];
  for (const part of parts) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + joiner.length + part.length <= MAX_LENGTH) chunks[chunks.length - 1] = last + joiner + part;
    else chunks.push(part);
  }
  return chunks;
}

// Длинное предложение — по знакам препинания, а кусок без них — по словам.
function split(sentence) {
  if (sentence.length <= MAX_LENGTH) return [sentence];
  return packed(sentence.split(BREAKS), ' ').flatMap((chunk) => (chunk.length <= MAX_LENGTH ? [chunk] : packed(chunk.split(/\s+/), ' ')));
}

// Субтитры [{ start, end, text }] для текста на видео длительностью duration секунд.
export function buildCues(text, duration) {
  const phrases = [];
  for (const sentence of String(text ?? '').match(SENTENCES) ?? []) {
    const chunks = split(sentence.trim()).filter(Boolean);
    chunks.forEach((chunk, i) => phrases.push({ text: chunk, pause: i === chunks.length - 1 }));
  }
  if (!phrases.length || !Number.isFinite(duration) || duration <= 0) return [];
  const lead = Math.min(LEAD, duration * 0.05);
  const span = duration - lead - Math.min(TAIL, duration * 0.05);
  const weight = (phrase) => phrase.text.length + (phrase.pause ? SENTENCE_PAUSE : 0);
  const total = phrases.reduce((sum, phrase) => sum + weight(phrase), 0);
  let start = lead;
  return phrases.map((phrase) => {
    const end = start + (span * weight(phrase)) / total;
    const cue = { start, end, text: phrase.text };
    start = end;
    return cue;
  });
}

export const cueAt = (cues, time) => cues.find((cue) => time >= cue.start && time < cue.end) ?? null;
