// Как зовут пользователя (кто он — api.ts). Имя хранит сервер:
// app/db/user_names/<user_id>.json (app/tools/user_names.py).
import { request } from './api';

export interface UserName {
    user_id: string;
    first_name: string;
    last_name: string;
    created_at: string;
}

// Запись с именем пользователя или null, если имя ещё не введено.
export async function fetchUserName(userId: string): Promise<UserName | null> {
    const data = await request('Проверка имени', `/api/user_names?user_id=${encodeURIComponent(userId)}`);
    return data.record ?? null;
}

export function saveUserName(userId: string, firstName: string, lastName: string): Promise<UserName> {
    return request('Запись имени', '/api/user_names', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, first_name: firstName, last_name: lastName }),
    });
}
