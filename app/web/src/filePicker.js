// Выбор файла в системном диалоге. Браузер показывает диалог только в ответ на
// жест пользователя, поэтому pickFile зовут прямо из обработчика клика.

let input = null;

// accept — типы файлов, как в <input accept>. Промис — выбранный файл
// или null, если диалог закрыли без выбора. Файл всегда один.
export function pickFile(accept) {
  if (!input) {
    input = document.createElement('input');
    input.type = 'file';
    input.hidden = true;
    document.body.append(input);
  }
  input.accept = accept;
  input.value = ''; // иначе тот же файл второй раз не придёт в change
  return new Promise((resolve) => {
    const done = (file) => {
      input.removeEventListener('change', chosen);
      input.removeEventListener('cancel', cancelled);
      resolve(file);
    };
    const chosen = () => done(input.files[0] ?? null);
    const cancelled = () => done(null);
    input.addEventListener('change', chosen);
    input.addEventListener('cancel', cancelled);
    input.click();
  });
}
