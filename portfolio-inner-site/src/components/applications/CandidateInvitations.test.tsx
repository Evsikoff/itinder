import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ApiError } from '../../api';
import {
    CandidateInvitation,
    CandidateInvitationsData,
    fetchCandidateInvitations,
    generateCandidateInvitations,
    markCandidateInvitationRead,
    respondToCandidateInvitation,
} from '../../candidateInvitations';
import CandidateInvitations from './CandidateInvitations';

jest.mock('../os/Window', () => ({
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('../../api', () => ({
    ...jest.requireActual('../../api'),
    currentUserId: () => 'candidate-test',
}));
jest.mock('../../candidateInvitations', () => ({
    ...jest.requireActual('../../candidateInvitations'),
    fetchCandidateInvitations: jest.fn(),
    generateCandidateInvitations: jest.fn(),
    markCandidateInvitationRead: jest.fn(),
    respondToCandidateInvitation: jest.fn(),
}));

const listRequest = fetchCandidateInvitations as jest.MockedFunction<typeof fetchCandidateInvitations>;
const readRequest = markCandidateInvitationRead as jest.MockedFunction<typeof markCandidateInvitationRead>;
const respondRequest = respondToCandidateInvitation as jest.MockedFunction<typeof respondToCandidateInvitation>;
const generationRequest = generateCandidateInvitations as jest.MockedFunction<typeof generateCandidateInvitations>;
const GENERATE = 'Сгенерировать тестовые приглашения';
const incomingType = 'От рекрутера кандидату';
const outgoingType = 'От кандидата рекрутеру';
const sentAt = '2026-10-09T09:00:00+00:00';

const flows: CandidateInvitationsData['flows'] = {
    plain: { sent: 'Отправлено', read: 'Просмотрено', accepted: 'Принято', declined: 'Отклонено' },
    assignment: {
        sent: 'Отправлено', declined: 'Отклонено', task_needs_review: 'Задание требует проверки',
        task_sent_for_review: 'Задание отправлено на проверку', solution_rejected: 'Решение отклонено', accepted: 'Принято',
    },
};

function invitation(id: string, overrides: Partial<CandidateInvitation> = {}): CandidateInvitation {
    return {
        id, type: incomingType, applicant_id: 'candidate-test', recruiter_id: 'recruiter-test',
        recruiter_name: 'Рекрутёр Тестов', flow: 'plain', status: 'sent', revision: 1,
        status_history: [{ status: 'sent', at: sentAt }], created_at: sentAt,
        assignment_answers: null, unseen: true, can_respond: true,
        vacancy: {
            id: `vacancy-${id}`, title: `Вакансия ${id}`, position_name: 'Разработчик',
            specialization: 'Backend', grade: 'Middle', count: 1,
            company: { id: 'company-test', name: 'Тестовая компания' },
            project: { name: 'Проект тестирования', summary: 'Описание проекта' },
            task: 'Разработать API', requirements: [], assignments: [], salary: { from: 100000, to: 150000 },
        },
        ...overrides,
    };
}

function changed(entry: CandidateInvitation, status: string): CandidateInvitation {
    return {
        ...entry, status, revision: entry.revision + 1,
        status_history: [...entry.status_history, { status, at: '2026-10-09T09:01:00+00:00' }],
        unseen: false, can_respond: ['sent', 'read'].includes(status) && entry.type === incomingType,
    };
}

function data(entries: CandidateInvitation[]): CandidateInvitationsData {
    return { invitations: entries, flows, stack: {}, kind_names: {}, degree_names: {} };
}

function renderApp() {
    const onAlertsChange = jest.fn();
    render(<CandidateInvitations title="Приглашения" onAlertsChange={onAlertsChange}
        onClose={jest.fn()} onMinimize={jest.fn()} onInteract={jest.fn()} />);
    return onAlertsChange;
}

function directionTab(label: string) {
    return within(screen.getByRole('tablist', { name: 'Направление приглашений' }))
        .getByRole('tab', { name: new RegExp(`^${label} \\(`) });
}

function statusTab(status: string) {
    const tab = within(screen.getByRole('tablist', { name: 'Статусы приглашений' }))
        .getAllByRole('tab').find((element) => element.id === `ci-status-${status}`);
    if (!tab) throw new Error(`Не найдена вкладка статуса ${status}`);
    return tab;
}

async function openEntry(entry: CandidateInvitation) {
    await screen.findByRole('button', { name: new RegExp(entry.vacancy.title) });
    fireEvent.click(screen.getByRole('button', { name: new RegExp(entry.vacancy.title) }));
    await screen.findByRole('heading', { name: entry.vacancy.title });
    await waitFor(() => expect(readRequest).toHaveBeenCalled());
}

beforeEach(() => {
    jest.clearAllMocks();
    listRequest.mockReset();
    readRequest.mockReset().mockImplementation(async (_, id) => {
        const entry = invitation(id);
        return changed(entry, 'read');
    });
    respondRequest.mockReset();
    generationRequest.mockReset();
});

test('оба уровня вкладок считают входящие приглашения и отклики отдельно, включая статусы с нулём', async () => {
    const sent = invitation('plain');
    const task = invitation('task', { flow: 'assignment' });
    const accepted = changed(invitation('accepted'), 'accepted');
    const outgoing = invitation('outgoing', { type: outgoingType, can_respond: false });
    listRequest.mockResolvedValue(data([sent, task, accepted, outgoing]));
    renderApp();

    expect(await screen.findByRole('tab', { name: 'Приглашения (3)' })).toHaveAttribute('aria-selected', 'true');
    expect(directionTab('Отклики')).toHaveTextContent('Отклики (1)');
    expect(statusTab('sent')).toHaveTextContent('Принято (2)');
    expect(statusTab('read')).toHaveTextContent('(0)');
    expect(statusTab('accepted')).toHaveTextContent('(1)');
    expect(statusTab('declined')).toHaveTextContent('(0)');
    expect(statusTab('task_needs_review')).toHaveTextContent('(0)');
    expect(statusTab('task_sent_for_review')).toHaveTextContent('(0)');
    expect(statusTab('solution_rejected')).toHaveTextContent('(0)');
    expect(screen.queryByRole('button', { name: /Вакансия outgoing/ })).not.toBeInTheDocument();
    expect(readRequest).not.toHaveBeenCalled();

    fireEvent.click(statusTab('accepted'));
    expect(screen.getByRole('button', { name: /Вакансия accepted/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Вакансия plain/ })).not.toBeInTheDocument();
    fireEvent.click(directionTab('Отклики'));
    fireEvent.click(statusTab('sent'));
    expect(screen.getByRole('button', { name: /Вакансия outgoing/ })).toBeInTheDocument();
    expect(statusTab('sent')).toHaveTextContent('Отправлено (1)');
    expect(statusTab('accepted')).toHaveTextContent('(0)');
});

test('просмотр обычного приглашения обновляет историю, счётчики и уведомление только после открытия записи', async () => {
    const entry = invitation('plain');
    listRequest.mockResolvedValue(data([entry]));
    readRequest.mockResolvedValue(changed(entry, 'read'));
    const alertsChanged = renderApp();
    await openEntry(entry);

    await waitFor(() => expect(statusTab('read')).toHaveTextContent('(1)'));
    expect(statusTab('sent')).toHaveTextContent('(0)');
    expect(readRequest).toHaveBeenCalledWith('candidate-test', 'plain', 1);
    expect(alertsChanged).toHaveBeenCalledTimes(2); // initial list and acknowledged view
    expect(screen.getByRole('button', { name: 'Принять' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Отклонить' })).toBeEnabled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getAllByText('Просмотрено').length).toBeGreaterThan(0);
});

test.each([['accept', 'Принять', 'accepted'], ['decline', 'Отклонить', 'declined']] as const)
    ('обычное приглашение: %s требует подтверждения, отправляет актуальную версию и показывает итог', async (action, label, status) => {
        const entry = invitation('plain');
        const read = changed(entry, 'read');
        listRequest.mockResolvedValue(data([entry]));
        readRequest.mockResolvedValue(read);
        respondRequest.mockResolvedValue(changed(read, status));
        renderApp();
        await openEntry(entry);
        await waitFor(() => expect(screen.getByRole('button', { name: label })).toBeEnabled());
        fireEvent.click(screen.getByRole('button', { name: label }));
        const confirm = screen.getByRole('alertdialog');
        expect(respondRequest).not.toHaveBeenCalled();
        fireEvent.click(within(confirm).getByRole('button', { name: label }));

        await waitFor(() => expect(statusTab(status)).toHaveTextContent('(1)'));
        expect(respondRequest).toHaveBeenCalledWith('candidate-test', 'plain', action, 2, undefined);
        expect(screen.queryByRole('button', { name: 'Принять' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Отклонить' })).not.toBeInTheDocument();
    });

test('приглашение с двумя заданиями требует два непустых многострочных ответа и отправляет их на проверку', async () => {
    const base = invitation('task');
    const entry = { ...base, flow: 'assignment' as const,
        vacancy: { ...base.vacancy, assignments: ['Опишите архитектуру API', 'Опишите стратегию тестирования'] } };
    listRequest.mockResolvedValue(data([entry]));
    readRequest.mockResolvedValue({ ...entry, unseen: false });
    let complete!: (value: CandidateInvitation) => void;
    respondRequest.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    renderApp();
    await openEntry(entry);
    await waitFor(() => expect(screen.getByLabelText('Решение задания 1')).toBeEnabled());

    const answers = screen.getAllByRole('textbox');
    expect(answers).toHaveLength(2);
    expect(answers[0].tagName).toBe('TEXTAREA');
    expect(answers[1].tagName).toBe('TEXTAREA');
    expect(answers[0]).toBeRequired();
    expect(answers[1]).toBeRequired();
    const submit = screen.getByRole('button', { name: 'Отправить решения' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Решение задания 1'), { target: { value: '  Слои и транзакции\nКонтроль ошибок  ' } });
    fireEvent.change(screen.getByLabelText('Решение задания 2'), { target: { value: '   ' } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Решение задания 2'), { target: { value: '  Контрактные тесты\nПроверка граничных значений  ' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    const confirm = screen.getByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Отправить решения' }));

    await waitFor(() => expect(respondRequest).toHaveBeenCalledWith('candidate-test', 'task', 'accept', 1,
        ['Слои и транзакции\nКонтроль ошибок', 'Контрактные тесты\nПроверка граничных значений']));
    expect(screen.getByRole('button', { name: 'Обновить' })).toBeDisabled();
    await act(async () => complete({ ...changed(entry, 'task_sent_for_review'), assignment_answers: ['Решение 1', 'Решение 2'] }));
    await waitFor(() => expect(statusTab('task_sent_for_review')).toHaveTextContent('(1)'));
    expect(statusTab('read')).toHaveTextContent('(0)');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Принять' })).not.toBeInTheDocument();
    expect(screen.getByText('Решение 1')).toBeInTheDocument();
    expect(screen.getByText('Решение 2')).toBeInTheDocument();
});

test('исходящий отклик подтверждает только просмотр, не предлагает принять, отклонить или решать задания', async () => {
    const base = invitation('outgoing');
    const entry = { ...base, type: outgoingType as CandidateInvitation['type'], flow: 'assignment' as const,
        can_respond: false, vacancy: { ...base.vacancy, assignments: ['Исходящее задание'] } };
    listRequest.mockResolvedValue(data([entry]));
    readRequest.mockResolvedValue({ ...entry, unseen: false });
    renderApp();
    await screen.findByRole('tab', { name: 'Отклики (1)' });
    fireEvent.click(directionTab('Отклики'));
    await openEntry(entry);
    await waitFor(() => expect(screen.getByRole('heading', { name: entry.vacancy.title })).toBeInTheDocument());

    expect(readRequest).toHaveBeenCalledWith('candidate-test', 'outgoing', 1);
    expect(screen.queryByRole('button', { name: 'Принять' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отклонить' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(respondRequest).not.toHaveBeenCalled();
});

test('после ошибки просмотра запись можно открыть повторно, действия не выполняются с неподтверждённой версией', async () => {
    const entry = invitation('plain');
    listRequest.mockResolvedValue(data([entry]));
    readRequest.mockRejectedValueOnce(new ApiError('Сервер не отвечает', 0)).mockResolvedValueOnce(changed(entry, 'read'));
    renderApp();
    await openEntry(entry);
    const retry = await screen.findByRole('button', { name: 'Повторить просмотр' });
    expect(screen.getByRole('button', { name: 'Принять' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Отклонить' })).toBeDisabled();
    expect(respondRequest).not.toHaveBeenCalled();
    fireEvent.click(retry);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Принять' })).toBeEnabled());
    expect(screen.queryByText('Сервер не отвечает')).not.toBeInTheDocument();
    expect(readRequest).toHaveBeenCalledTimes(2);
    expect(readRequest).toHaveBeenLastCalledWith('candidate-test', 'plain', 1);
});

test('обновление загружает новые приглашения и новые статусы, сохраняя разделы и правильные счётчики', async () => {
    const entry = invitation('plain');
    const accepted = { ...changed(entry, 'accepted'), unseen: true };
    listRequest.mockResolvedValueOnce(data([entry])).mockResolvedValueOnce(data([accepted, invitation('new')]));
    renderApp();
    await screen.findByRole('tab', { name: 'Приглашения (1)' });
    fireEvent.click(screen.getByRole('button', { name: 'Обновить' }));

    expect(await screen.findByRole('tab', { name: 'Приглашения (2)' })).toHaveAttribute('aria-selected', 'true');
    expect(statusTab('sent')).toHaveTextContent('(1)');
    expect(statusTab('accepted')).toHaveTextContent('(1)');
    expect(screen.getByRole('button', { name: /Вакансия new/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Вакансия plain/ })).not.toBeInTheDocument();
    expect(listRequest).toHaveBeenCalledTimes(2);
    expect(listRequest).toHaveBeenLastCalledWith('candidate-test');
    expect(readRequest).not.toHaveBeenCalled();
});

test('ошибка отправки сохраняет ответы кандидата для повторной попытки', async () => {
    const base = invitation('task');
    const entry = { ...base, flow: 'assignment' as const, vacancy: { ...base.vacancy, assignments: ['Опишите решение'] } };
    listRequest.mockResolvedValue(data([entry]));
    readRequest.mockResolvedValue({ ...entry, unseen: false });
    respondRequest.mockRejectedValue(new ApiError('Статус приглашения изменился — обновите список', 409));
    renderApp();
    await openEntry(entry);
    await waitFor(() => expect(screen.getByLabelText('Решение задания 1')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Решение задания 1'), { target: { value: 'Сохраняемое решение\nВторая строка' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить решения' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Отправить решения' }));

    await screen.findByText(/Статус приглашения изменился — обновите список/);
    expect(screen.getByLabelText('Решение задания 1')).toHaveValue('Сохраняемое решение\nВторая строка');
    expect(screen.getByRole('button', { name: 'Обновить' })).toBeEnabled();
    expect(respondRequest).toHaveBeenCalledTimes(1);
});

function generatedInvitations(): CandidateInvitation[] {
    const statuses = ['sent', 'read', 'accepted', 'declined', 'task_needs_review', 'task_sent_for_review', 'solution_rejected'];
    return Array.from({ length: 20 }, (_, index) => {
        const status = statuses[index % statuses.length];
        const entry = invitation(`generated-${index}`, { type: index < 10 ? incomingType : outgoingType });
        const assignment = status.startsWith('task_') || status === 'solution_rejected';
        return {
            ...entry, status, flow: assignment ? 'assignment' : 'plain',
            vacancy: { ...entry.vacancy, assignments: assignment ? ['Опишите тестовое решение'] : [] },
            status_history: status === 'sent' ? entry.status_history : [...entry.status_history, { status, at: sentAt }],
            revision: status === 'sent' ? 1 : 2,
            can_respond: index < 10 && ['sent', 'read'].includes(status),
        };
    });
}

test('генерация доступна при пустом списке, защищена от повторного нажатия и обновляет 20 записей и уведомления', async () => {
    const created = generatedInvitations();
    listRequest.mockResolvedValueOnce(data([])).mockResolvedValueOnce(data(created));
    let complete!: (result: Awaited<ReturnType<typeof generateCandidateInvitations>>) => void;
    generationRequest.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const alertsChanged = renderApp();
    const generate = await screen.findByRole('button', { name: GENERATE });
    await waitFor(() => expect(generate).toBeEnabled());
    alertsChanged.mockClear();
    fireEvent.click(generate);

    expect(await screen.findByRole('status')).toHaveTextContent('Генерируем тестовые приглашения…');
    const pending = screen.getByRole('button', { name: GENERATE });
    expect(pending).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Обновить' })).toBeDisabled();
    fireEvent.click(pending);
    await waitFor(() => expect(generationRequest).toHaveBeenCalledTimes(1));
    expect(generationRequest).toHaveBeenCalledWith('candidate-test');
    expect(listRequest).toHaveBeenCalledTimes(1);

    await act(async () => complete({ created_invitations: 20, invitation_ids: created.map((entry) => entry.id) }));
    await screen.findByRole('tab', { name: 'Приглашения (10)' });
    expect(directionTab('Отклики')).toHaveTextContent('(10)');
    expect(statusTab('sent')).toHaveTextContent('(2)');
    expect(statusTab('read')).toHaveTextContent('(2)');
    expect(statusTab('task_sent_for_review')).toHaveTextContent('(1)');
    expect(screen.getByRole('status')).toHaveTextContent('Создано 20 тестовых приглашений.');
    expect(screen.getByRole('button', { name: GENERATE })).toBeEnabled();
    expect(listRequest).toHaveBeenCalledTimes(2);
    expect(alertsChanged).toHaveBeenCalled();
    expect(readRequest).not.toHaveBeenCalled();
    expect(respondRequest).not.toHaveBeenCalled();
});

test('ошибка генерации объясняется кандидату и допускает повторную попытку без потери списка', async () => {
    const entry = invitation('existing');
    const created = generatedInvitations();
    listRequest.mockResolvedValueOnce(data([entry])).mockResolvedValueOnce(data([entry, ...created]));
    generationRequest.mockRejectedValueOnce(new ApiError('Не удалось сохранить тестовые приглашения', 503))
        .mockResolvedValueOnce({ created_invitations: 20, invitation_ids: created.map((record) => record.id) });
    renderApp();
    const generate = await screen.findByRole('button', { name: GENERATE });
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);

    await screen.findByText(/Не удалось сохранить тестовые приглашения/);
    expect(screen.getByRole('tab', { name: 'Приглашения (1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Вакансия existing/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: GENERATE })).toBeEnabled();
    expect(listRequest).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: GENERATE }));

    await screen.findByRole('tab', { name: 'Приглашения (11)' });
    expect(generationRequest).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Не удалось сохранить тестовые приглашения/)).not.toBeInTheDocument();
});

test.each(['success', 'failure'] as const)('генерация: %s сохраняет выбранную карточку и черновик решения', async (result) => {
    const base = invitation('existing-task');
    const entry = { ...base, flow: 'assignment' as const, vacancy: { ...base.vacancy, assignments: ['Опишите решение'] } };
    const acknowledged = { ...entry, unseen: false };
    const created = generatedInvitations();
    listRequest.mockResolvedValueOnce(data([entry])).mockResolvedValue(data([acknowledged, ...created]));
    readRequest.mockResolvedValue(acknowledged);
    if (result === 'success') generationRequest.mockResolvedValue({ created_invitations: 20, invitation_ids: created.map((record) => record.id) });
    else generationRequest.mockRejectedValue(new ApiError('Ошибка создания набора', 503));
    renderApp();
    await openEntry(entry);
    const answer = screen.getByLabelText('Решение задания 1');
    await waitFor(() => expect(answer).toBeEnabled());
    fireEvent.change(answer, { target: { value: 'Сохраняемый черновик\nВторая строка' } });
    fireEvent.click(screen.getByRole('button', { name: GENERATE }));

    if (result === 'success') await screen.findByRole('tab', { name: 'Приглашения (11)' });
    else await screen.findByText(/Ошибка создания набора/);
    expect(screen.getByRole('heading', { name: entry.vacancy.title })).toBeInTheDocument();
    expect(screen.getByLabelText('Решение задания 1')).toHaveValue('Сохраняемый черновик\nВторая строка');
    expect(statusTab('sent')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Отправить решения' })).toBeEnabled();
    expect(respondRequest).not.toHaveBeenCalled();
});

test('после успешного создания и ошибки загрузки списка повторное обновление не генерирует ещё 20 приглашений', async () => {
    const existing = invitation('existing');
    const created = generatedInvitations();
    listRequest.mockResolvedValueOnce(data([existing]))
        .mockRejectedValueOnce(new ApiError('Сервер не отвечает', 0))
        .mockResolvedValueOnce(data([existing, ...created]));
    generationRequest.mockResolvedValue({ created_invitations: 20, invitation_ids: created.map((record) => record.id) });
    const alertsChanged = renderApp();
    const generate = await screen.findByRole('button', { name: GENERATE });
    await waitFor(() => expect(generate).toBeEnabled());
    alertsChanged.mockClear();
    fireEvent.click(generate);

    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent('Приглашения созданы, но список не удалось обновить.');
    expect(screen.getByRole('status')).toHaveTextContent('Создано 20 тестовых приглашений.');
    expect(screen.getByRole('tab', { name: 'Приглашения (1)' })).toBeInTheDocument();
    expect(alertsChanged).toHaveBeenCalled();
    expect(generationRequest).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Обновить' }));

    await screen.findByRole('tab', { name: 'Приглашения (11)' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(listRequest).toHaveBeenCalledTimes(3);
    expect(generationRequest).toHaveBeenCalledTimes(1);
});
