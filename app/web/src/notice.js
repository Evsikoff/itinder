// Короткое сообщение внизу экрана — итог действия элемента (регистрация и т. п.).
// Стили — #notice в index.html.

const SHOW_TIME = 4000;   // мс
const OFFER_TIME = 10000; // мс — сообщение с кнопкой: успеть прочитать и нажать

const box = document.getElementById('notice');
let timer = 0;

const hide = () => box.classList.remove('shown');

// offer — { label, run }: кнопка в сообщении; нажатие убирает сообщение и вызывает run().
export function notify(text, { error = false, offer = null } = {}) {
  const message = document.createElement('span');
  message.textContent = text;
  box.replaceChildren(message);
  if (offer) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = offer.label;
    button.addEventListener('click', () => {
      clearTimeout(timer);
      hide();
      offer.run();
    });
    box.append(button);
  }
  box.classList.toggle('error', error);
  box.classList.add('shown');
  clearTimeout(timer);
  timer = setTimeout(hide, offer ? OFFER_TIME : SHOW_TIME);
}
