// Кто пользуется интерфейсом: { id, email } пользователя, который
// зарегистрировался в этой вкладке, или null. Лежит в sessionStorage — переживает
// перезагрузку страницы и забывается с закрытием вкладки.

const KEY = 'itinder.user';

let user = null;
try {
  user = JSON.parse(sessionStorage.getItem(KEY));
} catch {
  user = null;
}

export const currentUser = () => user;

export function signIn({ id, email }) {
  user = { id, email };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(user));
  } catch {
    // без хранилища пользователь живёт до перезагрузки
  }
}
