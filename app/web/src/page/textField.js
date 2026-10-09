// Поле ввода для 3D-объекта (доска, клетка): настоящий <input>, невидимый.
// Он даёт всё, что положено полю: раскладки и IME, вставку, стрелки и выделение,
// Tab между полями, экранную клавиатуру на телефоне. Объект в сцене только
// показывает значение и курсор. Стили — #fields в index.html.

let form = null;
function fieldsForm() {
  if (!form) {
    form = document.createElement('form');
    form.id = 'fields';
    form.autocomplete = 'off';
    form.addEventListener('submit', (event) => event.preventDefault());
    document.body.append(form);
  }
  return form;
}

// Снять фокус с поля — клик мимо полей или переход на другую страницу.
export function blurFields() {
  if (form?.contains(document.activeElement)) document.activeElement.blur();
}

// label — подпись для экранного диктора (заголовок над полем).
export function createTextField({ type = 'text', label = '', maxLength, autocomplete = 'off', value = '' }) {
  const input = document.createElement('input');
  input.type = type;
  input.autocomplete = autocomplete;
  input.spellcheck = false;
  input.setAttribute('autocapitalize', 'none');
  input.setAttribute('autocorrect', 'off');
  if (label) input.setAttribute('aria-label', label);
  if (maxLength) input.maxLength = maxLength;
  input.value = value;
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') input.blur();
  });
  fieldsForm().append(input);

  return {
    get value() {
      return input.value;
    },
    get focused() {
      return document.activeElement === input;
    },
    get selectionStart() {
      return input.selectionStart ?? input.value.length;
    },
    get selectionEnd() {
      return input.selectionEnd ?? input.value.length;
    },
    // x, y — точка клика на экране: туда браузер выведет подсказки IME и
    // автозаполнения. caret — куда поставить курсор (по умолчанию в конец).
    focus({ x, y, caret = input.value.length } = {}) {
      if (x !== undefined) {
        input.style.left = `${Math.min(Math.max(x, 0), window.innerWidth - 1)}px`;
        input.style.top = `${Math.min(Math.max(y, 0), window.innerHeight - 1)}px`;
      }
      input.focus({ preventScroll: true });
      input.setSelectionRange(caret, caret);
    },
    blur() {
      input.blur();
    },
    dispose() {
      input.remove();
    },
  };
}
