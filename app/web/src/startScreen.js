// Стартовая страница (#start в index.html): логотипы ITinder и команды, о чём
// проект и кнопка «Старт». Станция грузится за ней, а пролёт камеры начинается,
// только когда пользователь нажмёт «Старт». Это нажатие — и первый жест, после
// которого браузер разрешает звук (audio.js), поэтому гул станции начинается вместе
// с пролётом. Если станция ещё грузится, после нажатия виден экран загрузки (#veil).

const screen = document.getElementById('start');
const button = document.getElementById('start-button');

// Выполняется, когда пользователь нажал «Старт»: мышью, пальцем, Enter или пробелом.
export const started = new Promise((resolve) => {
  button.addEventListener('click', () => {
    button.disabled = true;
    button.blur();
    screen.classList.add('gone');
    resolve();
  }, { once: true });
});
