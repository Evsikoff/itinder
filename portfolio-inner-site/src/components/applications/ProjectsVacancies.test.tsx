import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ApiError } from '../../api';
import { fetchCatalog, fetchProject, fetchProjects, generateTestFeedback, markProjectNewsRead, Project, ProjectSummary } from '../../projects';
import ProjectsVacancies from './ProjectsVacancies';

jest.mock('../os/Window', () => ({
    __esModule: true, default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('./GradeTasks', () => ({ SignIcon: () => null }));
jest.mock('./ProjectQuestionnaire', () => ({ __esModule: true, default: () => null }));
jest.mock('./ProjectFeedback', () => ({ __esModule: true, default: () => <div>Дерево обратной связи</div> }));
jest.mock('./VacancyEditor', () => ({ __esModule: true, default: () => null, VacancyCard: () => null }));
jest.mock('../../api', () => ({ ...jest.requireActual('../../api'), currentUserId: () => 'recruiter-test' }));
jest.mock('../../projects', () => ({
    ...jest.requireActual('../../projects'), fetchCatalog: jest.fn(), fetchProjects: jest.fn(),
    fetchProject: jest.fn(), markProjectNewsRead: jest.fn(), generateTestFeedback: jest.fn(),
}));

const catalogRequest = fetchCatalog as jest.MockedFunction<typeof fetchCatalog>;
const projectsRequest = fetchProjects as jest.MockedFunction<typeof fetchProjects>;
const projectRequest = fetchProject as jest.MockedFunction<typeof fetchProject>;
const readRequest = markProjectNewsRead as jest.MockedFunction<typeof markProjectNewsRead>;
const feedbackRequest = generateTestFeedback as jest.MockedFunction<typeof generateTestFeedback>;
const FEEDBACK = 'Сгенерировать тестовую обратную связь';
const feedbackResult = {
    created_applications: 8, accepted_invitations: 6, submitted_assignments: 2, forwarded_assignments: 1,
    created_invitations: 16, updated_invitations: 0, invitation_ids: ['test-feedback-id'],
};
const ACCEPTED = 'Есть принятие приглашения';
const APPLICATIONS = 'Есть новые отклики';
const REVIEW = 'Есть задания требующие проверки';
const news = { new_applications: 2, accepted_invitations: 1, assignments_to_review: 3 };
const summary: ProjectSummary = {
    id: 'project-test', name: 'Тестовый проект', company: {
        id: 'company-test', name: 'Компания', industry: null, city: null, description: null,
    }, status: 'open', vacancies: 4, people: 4, valid_vacancies: 4,
    created_at: '2026-10-09T10:00:00+00:00', updated_at: '2026-10-09T10:00:00+00:00',
    approved_at: '2026-10-09T10:00:00+00:00', completed_at: null, copied_from: null, news,
};
const opened: Project = {
    ...summary, questionnaire: { id: 'test', version: 1 }, answers: {}, summary: { open_questions: [] },
    approved: true, vacancies_list: [], accepted_news: [{ id: 'invitation-test', revision: 3 }],
};

async function openList() {
    const alerts = jest.fn();
    render(<ProjectsVacancies title="Проекты и вакансии" onAlertsChange={alerts}
        onClose={jest.fn()} onMinimize={jest.fn()} onInteract={jest.fn()} />);
    await screen.findByRole('listbox', { name: 'Проекты' });
    return alerts;
}

beforeEach(() => {
    jest.clearAllMocks();
    // Анкета для этих проверок не нужна; список и открытый проект работают без неё.
    catalogRequest.mockResolvedValue(null as any);
    projectsRequest.mockResolvedValue([summary, { ...summary, id: 'quiet-project', name: 'Без новостей', news: undefined }]);
    projectRequest.mockResolvedValue(opened);
    readRequest.mockResolvedValue({ project_id: summary.id, news: { ...news, accepted_invitations: 0 } });
    feedbackRequest.mockResolvedValue(feedbackResult);
});

test('колонка показывает все плашки только в строке соответствующего проекта', async () => {
    await openList();
    expect(screen.getByText('Новости')).toBeInTheDocument();
    const active = within(screen.getByRole('option', { name: /Тестовый проект/ }));
    expect(active.getByText(APPLICATIONS)).toHaveAttribute('title', 'Новых откликов: 2');
    expect(active.getByText(ACCEPTED)).toBeInTheDocument();
    expect(active.getByText(REVIEW)).toHaveAttribute('title', 'Приглашений с заданиями на проверке: 3');
    const quiet = within(screen.getByRole('option', { name: /Без новостей/ }));
    expect(quiet.queryByText(APPLICATIONS)).not.toBeInTheDocument();
    expect(quiet.queryByText(ACCEPTED)).not.toBeInTheDocument();
    expect(quiet.queryByText(REVIEW)).not.toBeInTheDocument();
    expect(readRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: /Тестовый проект/ }));
    expect(readRequest).not.toHaveBeenCalled();
});

test('открытие проекта подтверждает показанные принятия и сохраняет остальные плашки', async () => {
    await openList();
    fireEvent.doubleClick(screen.getByRole('option', { name: /Тестовый проект/ }));
    await screen.findByRole('button', { name: 'К списку' });
    await waitFor(() => expect(readRequest).toHaveBeenCalledWith('recruiter-test', summary.id, opened.accepted_news));
    fireEvent.click(screen.getByRole('button', { name: 'К списку' }));
    expect(screen.queryByText(ACCEPTED)).not.toBeInTheDocument();
    expect(screen.getByText(APPLICATIONS)).toBeInTheDocument();
    expect(screen.getByText(REVIEW)).toBeInTheDocument();
});

test('при неудачном открытии проекта просмотр не отмечается', async () => {
    projectRequest.mockRejectedValue(new ApiError('Не удалось открыть проект', 500));
    await openList();
    fireEvent.doubleClick(screen.getByRole('option', { name: /Тестовый проект/ }));
    await screen.findByRole('alertdialog');
    expect(readRequest).not.toHaveBeenCalled();
    expect(screen.getByText(ACCEPTED)).toBeInTheDocument();
});

test('ошибка сохранения просмотра оставляет принятие в новостях', async () => {
    readRequest.mockRejectedValue(new ApiError('Нет связи', 0));
    await openList();
    fireEvent.doubleClick(screen.getByRole('option', { name: /Тестовый проект/ }));
    await screen.findByText(/просмотр принятых приглашений не удалось сохранить/);
    fireEvent.click(screen.getByRole('button', { name: 'К списку' }));
    expect(screen.getByText(ACCEPTED)).toBeInTheDocument();
});

test('после открытия проекта новые принятия из ответа сервера остаются в новостях', async () => {
    readRequest.mockResolvedValue({ project_id: summary.id, news: { ...news, accepted_invitations: 1 } });
    await openList();
    fireEvent.doubleClick(screen.getByRole('option', { name: /Тестовый проект/ }));
    await waitFor(() => expect(readRequest).toHaveBeenCalledTimes(1));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'К списку' }));
    expect(screen.getByText(ACCEPTED)).toBeInTheDocument();
});

test('возвращение фокуса обновляет новости без сброса выбранного проекта', async () => {
    await openList();
    const row = screen.getByRole('option', { name: /Тестовый проект/ });
    fireEvent.click(row);
    projectsRequest.mockResolvedValue([{ ...summary, news: { ...news, accepted_invitations: 0 } }]);
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(screen.queryByText(ACCEPTED)).not.toBeInTheDocument());
    expect(screen.getByRole('option', { name: /Тестовый проект/ })).toHaveAttribute('aria-selected', 'true');
    expect(readRequest).not.toHaveBeenCalled();
});

test.each([0, undefined])('кнопка обратной связи скрыта без валидных вакансий (%s)', async (valid) => {
    projectsRequest.mockResolvedValue([{ ...summary, valid_vacancies: valid }]);
    await openList();
    expect(screen.queryByRole('button', { name: FEEDBACK })).not.toBeInTheDocument();
});

test('кнопка есть и у завершённого проекта, если вакансия не закрыта наймом', async () => {
    projectsRequest.mockResolvedValue([{ ...summary, status: 'completed', completed_at: summary.created_at }]);
    await openList();
    expect(screen.getByRole('button', { name: FEEDBACK })).toBeEnabled();
});

test('генерация обновляет новости и выделение, повторное нажатие во время запроса не создаёт второй пакет', async () => {
    let finish!: (value: typeof feedbackResult) => void;
    feedbackRequest.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const alerts = await openList();
    fireEvent.click(screen.getByRole('option', { name: /Тестовый проект/ }));
    const button = screen.getByRole('button', { name: FEEDBACK });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(feedbackRequest).toHaveBeenCalledTimes(1);
    expect(feedbackRequest).toHaveBeenCalledWith('recruiter-test');
    expect(screen.getByText('Генерируем тестовую обратную связь…')).toBeInTheDocument();
    projectsRequest.mockResolvedValue([{ ...summary, news: { ...news, new_applications: 8 } }]);
    await act(async () => { finish(feedbackResult); });
    await screen.findByRole('button', { name: FEEDBACK });
    expect(screen.getByText(/Создано откликов: 8; принятий приглашений: 6; решений заданий: 2/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Тестовый проект/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(APPLICATIONS)).toHaveAttribute('title', 'Новых откликов: 8');
    expect(alerts).toHaveBeenCalledTimes(1);
    expect(readRequest).not.toHaveBeenCalled();
});

test('после закрытия всех вакансий наймом кнопка исчезает', async () => {
    await openList();
    projectsRequest.mockResolvedValue([{ ...summary, valid_vacancies: 0 }]);
    fireEvent.click(screen.getByRole('button', { name: FEEDBACK }));
    await screen.findByText(/Создано откликов/);
    await waitFor(() => expect(screen.queryByRole('button', { name: FEEDBACK })).not.toBeInTheDocument());
});

test('ошибка генерации оставляет список и позволяет повторить действие', async () => {
    feedbackRequest.mockRejectedValueOnce(new ApiError('Нет новых тестовых соискателей', 409));
    await openList();
    fireEvent.click(screen.getByRole('button', { name: FEEDBACK }));
    await screen.findByRole('alertdialog');
    expect(screen.getByText('Нет новых тестовых соискателей')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    fireEvent.click(screen.getByRole('button', { name: FEEDBACK }));
    await screen.findByText(/Создано откликов/);
    expect(feedbackRequest).toHaveBeenCalledTimes(2);
});

test('повтор загрузки после созданной обратной связи не генерирует её заново', async () => {
    await openList();
    projectsRequest.mockRejectedValueOnce(new ApiError('Нет связи', 0));
    fireEvent.click(screen.getByRole('button', { name: FEEDBACK }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Обратная связь создана/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Обновить список' }));
    await screen.findByRole('listbox', { name: 'Проекты' });
    expect(feedbackRequest).toHaveBeenCalledTimes(1);
    expect(projectsRequest).toHaveBeenCalledTimes(3);
});

test('обновление списка показывает кнопку при появлении валидной вакансии', async () => {
    projectsRequest.mockResolvedValue([{ ...summary, valid_vacancies: 0 }]);
    await openList();
    expect(screen.queryByRole('button', { name: FEEDBACK })).not.toBeInTheDocument();
    projectsRequest.mockResolvedValue([summary]);
    fireEvent(window, new Event('focus'));
    await screen.findByRole('button', { name: FEEDBACK });
});

test('проект с новостями открывает вкладку обратной связи до подтверждения просмотра', async () => {
    await openList();
    fireEvent.doubleClick(screen.getByRole('option', { name: /Тестовый проект/ }));
    await screen.findByText('Дерево обратной связи');
    expect(screen.getByRole('tab', { name: 'Обратная связь' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Вакансии/ })).toHaveAttribute('aria-selected', 'false');
    await waitFor(() => expect(readRequest).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('tab', { name: /Вакансии/ }));
    expect(screen.queryByText('Дерево обратной связи')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Обратная связь' }));
    expect(screen.getByText('Дерево обратной связи')).toBeInTheDocument();
});

test('проект без новостей открывается на вакансиях, но обратная связь доступна', async () => {
    const zeroNews = { new_applications: 0, accepted_invitations: 0, assignments_to_review: 0 };
    projectsRequest.mockResolvedValue([{ ...summary, news: zeroNews }]);
    projectRequest.mockResolvedValue({ ...opened, news: zeroNews, accepted_news: [] });
    await openList();
    fireEvent.doubleClick(screen.getByRole('option', { name: /Тестовый проект/ }));
    await screen.findByRole('button', { name: 'К списку' });
    expect(screen.getByRole('tab', { name: /Вакансии/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Обратная связь' })).toHaveAttribute('aria-selected', 'false');
    expect(readRequest).not.toHaveBeenCalled();
});

test('новость в списке открывает обратную связь, даже если актуальный ответ проекта уже без новостей', async () => {
    projectRequest.mockResolvedValue({ ...opened, news: undefined, accepted_news: [] });
    await openList();
    fireEvent.doubleClick(screen.getByRole('option', { name: /Тестовый проект/ }));
    await screen.findByText('Дерево обратной связи');
    expect(screen.getByRole('tab', { name: 'Обратная связь' })).toHaveAttribute('aria-selected', 'true');
});
