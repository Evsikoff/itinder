import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ApiError } from '../../api';
import { closeFeedbackVacancy, FeedbackInvitation, fetchProjectFeedback, ProjectFeedbackData, respondToApplication, reviewProjectInvitation } from '../../projectFeedback';
import ProjectFeedback from './ProjectFeedback';
import { fetchCandidateProfile } from '../../candidateProfile';

jest.mock('../../candidateProfile', () => ({ fetchCandidateProfile: jest.fn() }));

jest.mock('../../projectFeedback', () => ({
    fetchProjectFeedback: jest.fn(), reviewProjectInvitation: jest.fn(), closeFeedbackVacancy: jest.fn(), respondToApplication: jest.fn(),
}));
const listRequest = fetchProjectFeedback as jest.MockedFunction<typeof fetchProjectFeedback>;
const reviewRequest = reviewProjectInvitation as jest.MockedFunction<typeof reviewProjectInvitation>;
const closeRequest = closeFeedbackVacancy as jest.MockedFunction<typeof closeFeedbackVacancy>;
const respondRequest = respondToApplication as jest.MockedFunction<typeof respondToApplication>;
const submitted: FeedbackInvitation = {
    id: 'submitted', applicant_id: 'candidate-1', name: 'Анна Разработчик', type: 'От рекрутера кандидату', kind: 'invitation',
    flow: 'assignment', status: 'task_sent_for_review', status_name: 'Задание отправлено на проверку', revision: 2,
    status_history: [{ status: 'sent', at: '2026-10-09T10:00:00Z' }, { status: 'task_sent_for_review', at: '2026-10-09T11:00:00Z' }],
    relevance: 87.5, created_at: '2026-10-09T10:00:00Z', email: null,
    assignments: ['Обработать повторную доставку события'], assignment_answers: ['Использовать ключ идемпотентности\nДобавить проверку дубликатов'],
    expert_email: null, can_send_to_expert: true, can_decide: false, can_respond_application: false,
};
const outgoing: FeedbackInvitation = { ...submitted, id: 'outgoing', applicant_id: 'candidate-2', name: 'Борис Тестировщик',
    kind: 'application', type: 'От кандидата рекрутеру', status: 'sent', status_name: 'Отправлено', revision: 1,
    status_history: [submitted.status_history[0]], assignments: [], assignment_answers: [], flow: 'plain',
    can_send_to_expert: false, can_respond_application: true, relevance: 63.1, email: 'hidden@example.invalid' };
const hired: FeedbackInvitation = { ...outgoing, id: 'hired', applicant_id: 'candidate-3', name: 'Вера Соискатель',
    kind: 'invitation', type: submitted.type, status: 'accepted', status_name: 'Принято', revision: 2,
    status_history: [...outgoing.status_history, { status: 'accepted', at: '2026-10-09T12:00:00Z' }], email: 'hired@example.invalid', can_respond_application: false };
const forwarded: FeedbackInvitation = { ...submitted, status: 'task_needs_review', status_name: 'Задание требует проверки',
    revision: 3, status_history: [...submitted.status_history, { status: 'task_needs_review', at: '2026-10-09T12:00:00Z' }],
    expert_email: 'expert@example.invalid', can_send_to_expert: false, can_decide: true };
const data: ProjectFeedbackData = { project_id: 'project-test', vacancies: [
    { id: 'backend', title: 'Backend-разработчик', count: 2, accepted: 0, closed_at: null, can_close: false, invitations: [submitted, outgoing] },
    { id: 'qa', title: 'QA-инженер', count: 1, accepted: 1, closed_at: null, can_close: true, invitations: [hired] },
] };
const withEntry = (entry: FeedbackInvitation): ProjectFeedbackData => ({ ...data, vacancies: [
    { ...data.vacancies[0], invitations: [entry, outgoing] }, data.vacancies[1],
] });

async function open(initial: ProjectFeedbackData = data) {
    listRequest.mockResolvedValue(initial);
    const changed = jest.fn();
    const view = render(<ProjectFeedback userId="user-test" projectId="project-test" onChanged={changed} />);
    await screen.findByRole('tree', { name: 'Обратная связь по вакансиям' });
    return { changed, ...view };
}
const detail = () => within(screen.getByRole('region', { name: 'Карточка приглашения' }));
const select = (name: string) => fireEvent.click(screen.getByRole('treeitem', { name: new RegExp(name) }));

beforeEach(() => {
    jest.resetAllMocks();
    reviewRequest.mockResolvedValue({ id: submitted.id, status: 'task_needs_review', revision: 3 });
    closeRequest.mockResolvedValue({ id: 'qa', closed_at: '2026-10-09T15:00:00Z' });
    respondRequest.mockResolvedValue({ id: outgoing.id, status: 'accepted', revision: 2 });
});

test('дерево содержит два уровня, нужное число людей, тип, статус и релевантность', async () => {
    await open();
    expect(screen.getByRole('treeitem', { name: 'Backend-разработчик — требуется 2 человека' })).toHaveAttribute('aria-level', '1');
    const invitation = screen.getByRole('treeitem', { name: /Анна Разработчик/ });
    expect(invitation).toHaveAttribute('aria-level', '2');
    expect(within(invitation).getByText('Приглашение')).toBeInTheDocument();
    expect(within(invitation).getByText('Задание отправлено на проверку')).toBeInTheDocument();
    expect(within(invitation).getByTitle('Релевантность 87.5 из 100')).toBeInTheDocument();
    const application = screen.getByRole('treeitem', { name: /Борис Тестировщик/ });
    expect(within(application).getByText('Отклик')).toBeInTheDocument();
    expect(within(application).getByText('Отправлено')).toBeInTheDocument();
    expect(screen.queryByText('hidden@example.invalid')).not.toBeInTheDocument();
    expect(within(screen.getByRole('treeitem', { name: /Вера Соискатель/ })).getByText('hired@example.invalid')).toBeInTheDocument();
    expect(detail().getByText(/ключ идемпотентности/)).toHaveClass('pf-pre');
    select('Вера Соискатель');
    expect(detail().getByText('hired@example.invalid')).toBeInTheDocument();
});

test('ветку вакансии можно свернуть и развернуть', async () => {
    await open();
    const toggle = screen.getByRole('button', { name: /Backend-разработчик/ });
    fireEvent.click(toggle);
    expect(screen.getByRole('treeitem', { name: /Backend-разработчик — требуется/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('treeitem', { name: /Анна Разработчик/ })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByRole('treeitem', { name: /Анна Разработчик/ })).toBeInTheDocument();
});

test.each(['Анна Разработчик', 'Борис Тестировщик'])('переход в профиль из приглашения или отклика: %s', async name => {
    const profileRequest = fetchCandidateProfile as jest.MockedFunction<typeof fetchCandidateProfile>;
    profileRequest.mockResolvedValue({ id: 'candidate', name, email: null, specializations: [], tests: [], assignments: [],
        fsp: { linked: false, linked_at: null, competencies: [], competitions: [] } });
    await open(); select(name);
    const opener = detail().getByRole('button', { name: 'Профиль кандидата' });
    opener.focus(); fireEvent.click(opener);
    const modal = await screen.findByRole('dialog', { name: 'Профиль кандидата' });
    await within(modal).findByRole('heading', { name });
    expect(profileRequest).toHaveBeenCalledWith('user-test', name === 'Анна Разработчик' ? submitted.applicant_id : outgoing.applicant_id);
    fireEvent.click(within(modal).getByRole('button', { name: 'Вернуться к кандидату' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: new RegExp(name) })).toHaveAttribute('aria-selected', 'true');
    expect(detail().getByRole('button', { name: 'Профиль кандидата' })).toHaveFocus();
});

test('отправка эксперту принимает адрес, обновляет статус и показывает обе кнопки решения', async () => {
    const { changed } = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Отправить эксперту на проверку' }));
    expect(screen.queryByRole('button', { name: 'Эксперт утвердил решение' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('E-mail эксперта'), { target: { value: 'expert@example.invalid' } });
    expect(screen.getByLabelText('E-mail эксперта')).toHaveAttribute('type', 'email');
    listRequest.mockResolvedValue(withEntry(forwarded));
    fireEvent.click(screen.getByRole('button', { name: 'Отправить', exact: true }));
    await screen.findByRole('button', { name: 'Эксперт утвердил решение' });
    expect(reviewRequest).toHaveBeenCalledWith('user-test', 'project-test', submitted, 'send', 'expert@example.invalid');
    expect(screen.getByRole('button', { name: 'Эксперт отклонил решение' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Решение отправлено эксперту на проверку: expert@example.invalid.');
    expect(screen.queryByLabelText('E-mail эксперта')).not.toBeInTheDocument();
    expect(changed).toHaveBeenCalledTimes(1);
});

test.each([['approve', 'Эксперт утвердил решение', 'accepted', 'Принято'],
    ['reject', 'Эксперт отклонил решение', 'solution_rejected', 'Решение отклонено']] as const)
('решение эксперта %s обновляет карточку и доступные действия', async (action, button, state, label) => {
    await open(withEntry(forwarded));
    const decided = { ...forwarded, status: state, status_name: label, can_decide: false, revision: 4,
        email: action === 'approve' ? 'anna@example.invalid' : null,
        status_history: [...forwarded.status_history, { status: state, at: '2026-10-09T15:00:00Z' }] };
    listRequest.mockResolvedValue(withEntry(decided));
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(screen.queryByRole('button', { name: button })).not.toBeInTheDocument());
    expect(reviewRequest).toHaveBeenCalledWith('user-test', 'project-test', forwarded, action);
    expect(detail().getByText(label)).toBeInTheDocument();
    if (action === 'approve') expect(detail().getByText('anna@example.invalid')).toBeInTheDocument();
    else expect(screen.queryByText('anna@example.invalid')).not.toBeInTheDocument();
});

test('вакансию можно закрыть только когда API разрешает это по числу принятий', async () => {
    const { changed } = await open();
    expect(screen.getAllByRole('button', { name: 'Закрыть вакансию' })).toHaveLength(1);
    listRequest.mockResolvedValue({ ...data, vacancies: [data.vacancies[0],
        { ...data.vacancies[1], can_close: false, closed_at: '2026-10-09T15:00:00Z' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть вакансию' }));
    await screen.findByText('Закрыта наймом');
    expect(closeRequest).toHaveBeenCalledWith('user-test', 'project-test', 'qa');
    expect(screen.queryByRole('button', { name: 'Закрыть вакансию' })).not.toBeInTheDocument();
    expect(changed).toHaveBeenCalledTimes(1);
});

test('изменённая версия приглашения обновляется после отказа сервера и сохраняет объяснение', async () => {
    await open(withEntry(forwarded));
    reviewRequest.mockRejectedValue(new ApiError('Статус приглашения изменился — обновите список', 409));
    listRequest.mockResolvedValue(withEntry({ ...forwarded, status: 'solution_rejected', status_name: 'Решение отклонено', can_decide: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Эксперт утвердил решение' }));
    await screen.findByRole('alert');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Эксперт утвердил решение' })).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('Статус приглашения изменился');
    expect(detail().getByText('Решение отклонено')).toBeInTheDocument();
});

test('ошибка обновления после решения повторяет только чтение', async () => {
    await open(withEntry(forwarded));
    listRequest.mockRejectedValueOnce(new ApiError('Нет связи', 0));
    fireEvent.click(screen.getByRole('button', { name: 'Эксперт отклонил решение' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('status')).toHaveTextContent('Эксперт отклонил решение');
    listRequest.mockResolvedValue(withEntry({ ...forwarded, status: 'solution_rejected', status_name: 'Решение отклонено', can_decide: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(reviewRequest).toHaveBeenCalledTimes(1);
});

test('сбой отправки сохраняет введённый адрес для повторного нажатия', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Отправить эксперту на проверку' }));
    fireEvent.change(screen.getByLabelText('E-mail эксперта'), { target: { value: 'expert@example.invalid' } });
    reviewRequest.mockRejectedValueOnce(new ApiError('Не удалось сохранить отправку', 500));
    fireEvent.click(screen.getByRole('button', { name: 'Отправить', exact: true }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('E-mail эксперта')).toHaveValue('expert@example.invalid');
    expect(screen.getByRole('button', { name: 'Отправить', exact: true })).toBeEnabled();
});

test('опрос при возвращении фокуса сохраняет выбранный отклик', async () => {
    await open();
    select('Борис Тестировщик');
    listRequest.mockResolvedValue(withEntry(forwarded));
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(listRequest).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('treeitem', { name: /Борис Тестировщик/ })).toHaveAttribute('aria-selected', 'true');
    expect(detail().getByRole('heading', { name: 'Борис Тестировщик' })).toBeInTheDocument();
});

test('повторное нажатие во время запроса не отправляет второй вердикт', async () => {
    let finish!: (result: { id: string; status: string; revision: number }) => void;
    await open(withEntry(forwarded));
    reviewRequest.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const button = screen.getByRole('button', { name: 'Эксперт утвердил решение' });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(reviewRequest).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    listRequest.mockResolvedValue(withEntry({ ...forwarded, status: 'accepted', status_name: 'Принято', can_decide: false, email: 'anna@example.invalid' }));
    await act(async () => { finish({ id: submitted.id, status: 'accepted', revision: 4 }); });
    expect(detail().getByText('anna@example.invalid')).toBeInTheDocument();
});

test('пустой проект и пустые ветки не скрывают причину отсутствия приглашений', async () => {
    const view = await open({ ...data, vacancies: [{ ...data.vacancies[0], invitations: [] }] });
    expect(screen.getByText('Приглашений и откликов пока нет.')).toBeInTheDocument();
    expect(detail().getByText('Выберите приглашение или отклик в дереве.')).toBeInTheDocument();
    view.unmount();
    listRequest.mockResolvedValue({ ...data, vacancies: [] });
    render(<ProjectFeedback userId="user-test" projectId="project-test" onChanged={jest.fn()} />);
    await screen.findByText('У проекта пока нет утверждённых вакансий.');
});

test('неудачная начальная загрузка предлагает повторить запрос', async () => {
    listRequest.mockRejectedValueOnce(new ApiError('Нет связи', 0)).mockResolvedValue(data);
    render(<ProjectFeedback userId="user-test" projectId="project-test" onChanged={jest.fn()} />);
    await screen.findByRole('alert');
    expect(screen.queryByText('У проекта пока нет утверждённых вакансий.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку' }));
    await screen.findByRole('tree');
});

test.each([['accept', 'Принять отклик', 'accepted', 'Принято'],
    ['decline', 'Отклонить отклик', 'declined', 'Отклонено']] as const)
('ответ на отклик %s обновляет его статус и сохраняет выбор', async (action, button, state, label) => {
    const { changed } = await open();
    expect(screen.queryByRole('button', { name: 'Принять отклик' })).not.toBeInTheDocument();
    select('Борис Тестировщик');
    expect(screen.getByRole('button', { name: 'Принять отклик' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Отклонить отклик' })).toBeEnabled();
    const answered = { ...outgoing, status: state, status_name: label, revision: 2, can_respond_application: false,
        email: action === 'accept' ? 'boris@example.invalid' : null,
        status_history: [...outgoing.status_history, { status: state, at: '2026-10-10T12:00:00Z' }] };
    listRequest.mockResolvedValue({ ...data, vacancies: [{ ...data.vacancies[0], invitations: [submitted, answered],
        accepted: action === 'accept' ? 1 : 0 }, data.vacancies[1]] });
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(screen.queryByRole('button', { name: button })).not.toBeInTheDocument());
    expect(respondRequest).toHaveBeenCalledWith('user-test', 'project-test', outgoing, action);
    expect(screen.getByRole('treeitem', { name: /Борис Тестировщик/ })).toHaveAttribute('aria-selected', 'true');
    expect(detail().getByText(label)).toBeInTheDocument();
    if (action === 'accept') expect(detail().getByText('boris@example.invalid')).toBeInTheDocument();
    else expect(screen.queryByText('boris@example.invalid')).not.toBeInTheDocument();
    expect(reviewRequest).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(1);
});

test('без решений на проверке по умолчанию выбирается новый отклик', async () => {
    await open({ ...data, vacancies: [{ ...data.vacancies[0], invitations: [hired, outgoing] }] });
    expect(detail().getByRole('heading', { name: 'Борис Тестировщик' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Принять отклик' })).toBeInTheDocument();
});

test('отклик с заданием на стадии проверки сохраняет действия эксперта', async () => {
    const assignment = { ...forwarded, kind: 'application' as const, type: outgoing.type };
    await open(withEntry(assignment));
    expect(screen.queryByRole('button', { name: 'Принять отклик' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отклонить отклик' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Эксперт утвердил решение' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Эксперт отклонил решение' })).toBeInTheDocument();
});

test('повторное нажатие и устаревшая версия отклика не дают второго ответа', async () => {
    let fail!: (reason: ApiError) => void;
    await open();
    select('Борис Тестировщик');
    respondRequest.mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    const button = screen.getByRole('button', { name: 'Принять отклик' });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(respondRequest).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Отклонить отклик' })).toBeDisabled();
    listRequest.mockResolvedValue({ ...data, vacancies: [{ ...data.vacancies[0], invitations: [submitted,
        { ...outgoing, status: 'declined', status_name: 'Отклонено', can_respond_application: false, email: null }] }] });
    await act(async () => { fail(new ApiError('Статус приглашения изменился — обновите список', 409)); });
    expect(screen.queryByRole('button', { name: 'Принять отклик' })).not.toBeInTheDocument();
    expect(detail().getByText('Отклонено')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Статус приглашения изменился');
});
