import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ApiError } from '../../api';
import { ProfileVisibility as Visibility, fetchProfileVisibility, saveProfileVisibility } from '../../candidateProfile';
import ProfileVisibility from './ProfileVisibility';

jest.mock('../../candidateProfile', () => ({ fetchProfileVisibility: jest.fn(), saveProfileVisibility: jest.fn() }));
const load = fetchProfileVisibility as jest.MockedFunction<typeof fetchProfileVisibility>;
const save = saveProfileVisibility as jest.MockedFunction<typeof saveProfileVisibility>;
const visible: Visibility = { hidden: false, hidden_at: null };
const hidden: Visibility = { hidden: true, hidden_at: '2026-10-09T10:00:00+00:00' };

beforeEach(() => { jest.resetAllMocks(); });
async function open(state: Visibility = visible) {
    load.mockResolvedValue(state);
    render(<ProfileVisibility userId="anna" />);
    const toggle = screen.getByRole('switch', { name: 'Скрыть профиль от рекрутёров' });
    await waitFor(() => expect(toggle).toBeEnabled());
    return toggle;
}

test('включение тумблера скрывает профиль от рекрутёров', async () => {
    const toggle = await open();
    expect(load).toHaveBeenCalledWith('anna');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveAccessibleDescription(/находят ваш профиль в поиске соискателей/);
    save.mockResolvedValue(hidden);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(save).toHaveBeenCalledWith('anna', true);
    expect(toggle).toHaveAccessibleDescription(/Профиль скрыт с 9 октября 2026: рекрутёры не найдут вас в поиске/);
});

test('выключение тумблера снова показывает профиль', async () => {
    const toggle = await open(hidden);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    save.mockResolvedValue(visible);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(save).toHaveBeenCalledWith('anna', false);
});

test('пока запрос идёт, повторное нажатие не отправляет второй; ошибка не меняет состояние', async () => {
    const toggle = await open();
    let reject: (error: Error) => void = () => {};
    save.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    fireEvent.click(toggle);
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAccessibleDescription('Скрываем профиль от рекрутёров…');
    fireEvent.click(toggle);
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new ApiError('Сервер не отвечает', 0)); });
    expect(screen.getByRole('alert')).toHaveTextContent('Сервер не отвечает');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument();
});

test('ошибку загрузки можно повторить, до загрузки тумблер недоступен', async () => {
    load.mockRejectedValueOnce(new ApiError('Пользователь не найден — войдите в профиль заново', 404));
    load.mockResolvedValueOnce(hidden);
    render(<ProfileVisibility userId="anna" />);
    const toggle = screen.getByRole('switch', { name: 'Скрыть профиль от рекрутёров' });
    expect(toggle).toBeDisabled();
    expect(await screen.findByRole('alert')).toHaveTextContent('Пользователь не найден');
    expect(toggle).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(toggle).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
});
