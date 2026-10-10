import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ApiError } from '../../api';
import { CandidateProfileData, downloadCandidateProfile, downloadSelfProfile, fetchCandidateProfile, fetchSelfProfile } from '../../candidateProfile';
import CandidateProfile from './CandidateProfile';

jest.mock('../../candidateProfile', () => ({ fetchCandidateProfile: jest.fn(), fetchSelfProfile: jest.fn(),
    downloadSelfProfile: jest.fn(), downloadCandidateProfile: jest.fn() }));
const request = fetchCandidateProfile as jest.MockedFunction<typeof fetchCandidateProfile>;
const ownRequest = fetchSelfProfile as jest.MockedFunction<typeof fetchSelfProfile>;
const download = downloadSelfProfile as jest.MockedFunction<typeof downloadSelfProfile>;
const candidateDownload = downloadCandidateProfile as jest.MockedFunction<typeof downloadCandidateProfile>;
const data: CandidateProfileData = {
    id: 'anna', name: 'Анна Разработчик', email: null,
    specializations: [
        { name: 'Backend', declared: 'Senior', source: 'LLM', confirmed: 'Middle', refuted: true, tests: 2, passed: 1 },
        { name: 'QA', declared: 'Junior', source: 'Manual', confirmed: null, refuted: false, tests: 0, passed: 0 },
    ],
    fsp: { linked: true, linked_at: '2026-10-09T10:00:00Z',
        competencies: [{ id: 'python', kind: 'languages', name: 'Python', degree: 3, degree_name: 'высокая', points: 8, competitions: ['hackathon'] }],
        competitions: [{ id: 'hackathon', name: 'Хакатон команды', start_date: '2026-01-01', end_date: '2026-01-03',
            level: 'national', role: 'Бэкендер', result: 'Победа', points: 5, task: 'Создать сервис', competencies: ['Python'] }],
    },
    tests: [
        { id: 'test1', specialization: 'Backend', grade: 'Middle', passed: true, created_at: '2026-10-09T10:00:00Z',
            language: 'Python', credited: true, procedural_check: false, llm_check: false, resource: 'API сервиса', symptoms: ['Событие доставлено дважды'] },
        { id: 'test2', specialization: 'QA', grade: 'Junior', passed: false, created_at: '2026-10-08T10:00:00Z',
            language: null, credited: false, procedural_check: true, llm_check: false, resource: null, symptoms: [] },
    ],
    assignments: [{ id: 'assignment', title: 'Backend-разработчик', project: 'Магазин', status: 'task_sent_for_review',
        status_name: 'Задание отправлено на проверку', created_at: '2026-10-09T10:00:00Z', updated_at: '2026-10-09T11:00:00Z',
        tasks: ['Обработать событие'], answers: ['Ключ идемпотентности'] }],
};
beforeEach(() => { jest.resetAllMocks(); request.mockResolvedValue(data); });
async function open() {
    const close = jest.fn();
    const view = render(<CandidateProfile userId="recruiter" applicantId="anna" onClose={close} />);
    await screen.findByRole('heading', { name: 'Анна Разработчик' });
    return { close, ...view };
}

test('показывает все специализации, отличает заявленный грейд от подтверждённого и скрывает контакт', async () => {
    await open();
    expect(request).toHaveBeenCalledWith('recruiter', 'anna');
    const grades = within(screen.getByLabelText('Специализации и грейды'));
    expect(grades.getByRole('heading', { name: 'Backend' })).toBeInTheDocument();
    expect(grades.getByRole('heading', { name: 'QA' })).toBeInTheDocument();
    expect(grades.getByText('Middle')).toBeInTheDocument();
    expect(grades.getByText('Senior')).toBeInTheDocument();
    expect(grades.getByText(/не подтверждается результатами/)).toBeInTheDocument();
    expect(screen.queryByText('E-mail:')).not.toBeInTheDocument();
    expect(screen.getByText(/Контакт доступен после/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Python.*высокая/ }));
    expect(within(screen.getByLabelText('Подтверждающие соревнования')).getByText('Хакатон команды')).toBeInTheDocument();
});

test('история содержит условие и способы проверки, фильтр, тестовые зачёты и сохранённые решения вакансий', async () => {
    await open();
    fireEvent.click(screen.getByRole('tab', { name: 'Тесты и задания' }));
    expect(screen.getByText('Засчитан в тестовой версии')).toBeInTheDocument();
    expect(screen.getByText('Не пройден')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Засчитан в тестовой версии'));
    expect(screen.getByText('Событие доставлено дважды')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Специализация' }), { target: { value: 'Backend' } });
    expect(screen.queryByText('Не пройден')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Backend-разработчик'));
    expect(screen.getByText('Ключ идемпотентности')).toBeInTheDocument();
    expect(screen.getByText('Задание отправлено на проверку')).toBeInTheDocument();
});

test('показывает роль, результат и технологии соревнования', async () => {
    await open();
    fireEvent.click(screen.getByRole('tab', { name: 'Соревнования' }));
    fireEvent.click(screen.getByText('Хакатон команды'));
    expect(screen.getByText('Победа')).toBeInTheDocument();
    expect(screen.getByText('Бэкендер')).toBeInTheDocument();
    expect(screen.getByText('Создать сервис')).toBeInTheDocument();
    expect(screen.getByText('Python')).toBeInTheDocument();
});

test('пустой профиль и контакт после принятия показываются без выдуманных данных', async () => {
    request.mockResolvedValue({ ...data, email: 'accepted@example.invalid', specializations: [], tests: [], assignments: [],
        fsp: { linked: false, linked_at: null, competencies: [], competitions: [] } });
    await open();
    expect(screen.getByText('accepted@example.invalid')).toBeInTheDocument();
    expect(screen.getByText(/Профиль ФСП ещё не связан/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Тесты и задания' }));
    expect(screen.getByText(/пока не проходил тесты/)).toBeInTheDocument();
    expect(screen.getByText(/с заданиями пока нет/)).toBeInTheDocument();
});

test('ошибку можно повторить, Escape закрывает профиль, фокус возвращается к открывающей кнопке', async () => {
    request.mockRejectedValueOnce(new ApiError('Профиль недоступен', 404));
    const opener = document.createElement('button'); document.body.appendChild(opener); opener.focus();
    const close = jest.fn();
    const view = render(<CandidateProfile userId="recruiter" applicantId="anna" onClose={close} />);
    await screen.findByText('Профиль недоступен');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку' }));
    await screen.findByRole('heading', { name: 'Анна Разработчик' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
    view.unmount(); expect(opener).toHaveFocus(); opener.remove();
});

test('поздний ответ по предыдущему кандидату не заменяет новый профиль', async () => {
    let finish: (value: CandidateProfileData) => void = () => {};
    request.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = render(<CandidateProfile userId="recruiter" applicantId="old" onClose={() => {}} />);
    view.rerender(<CandidateProfile userId="recruiter" applicantId="anna" onClose={() => {}} />);
    await screen.findByRole('heading', { name: 'Анна Разработчик' });
    await act(async () => { finish({ ...data, name: 'Старый кандидат' }); });
    await waitFor(() => expect(screen.queryByText('Старый кандидат')).not.toBeInTheDocument());
});

test('собственный профиль использует тот же интерфейс и загружает только текущего пользователя', async () => {
    ownRequest.mockResolvedValue({ ...data, email: 'anna@example.invalid' });
    const invitations = jest.fn();
    render(<CandidateProfile self embedded userId="anna" applicantId="ignored" onClose={() => {}} onInvitations={invitations} />);
    await screen.findByRole('heading', { name: 'Анна Разработчик' });
    expect(ownRequest).toHaveBeenCalledWith('anna');
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Мой профиль' })).toBeInTheDocument();
    expect(screen.getByText('anna@example.invalid')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Компетенции' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Приглашения и отклики' }));
    expect(invitations).toHaveBeenCalledTimes(1);
});

test('экспорт блокирует повторный запуск, ошибку можно повторить без потери профиля', async () => {
    ownRequest.mockResolvedValue(data);
    let reject: (error: Error) => void = () => {};
    download.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    render(<CandidateProfile self userId="anna" applicantId="anna" onClose={() => {}} />);
    await screen.findByRole('heading', { name: 'Анна Разработчик' });
    fireEvent.click(screen.getByRole('button', { name: 'Скачать PDF' }));
    expect(screen.getByRole('button', { name: 'Формируем PDF…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Формируем PDF…' }));
    expect(download).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new ApiError('Сервер недоступен', 503)); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Сервер недоступен');
    expect(screen.getByRole('heading', { name: 'Анна Разработчик' })).toBeInTheDocument();
    download.mockResolvedValue();
    fireEvent.click(screen.getByRole('button', { name: 'Скачать PDF' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Скачать PDF' })).toBeEnabled());
    expect(download).toHaveBeenLastCalledWith('anna');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('рекрутёр скачивает PDF профиля кандидата тем же механизмом, что и окно «PDF-профиль»', async () => {
    candidateDownload.mockResolvedValue();
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Скачать PDF' }));
    expect(screen.getByRole('button', { name: 'Формируем PDF…' })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Скачать PDF' })).toBeEnabled());
    expect(candidateDownload).toHaveBeenCalledWith('recruiter', 'anna', 'Анна Разработчик');
    expect(download).not.toHaveBeenCalled();
    candidateDownload.mockRejectedValueOnce(new ApiError('Профиль кандидата недоступен', 404));
    fireEvent.click(screen.getByRole('button', { name: 'Скачать PDF' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Профиль кандидата недоступен');
});
