import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ApiError } from '../../api';
import {
    Candidate,
    fetchOverview,
    fetchSearch,
    generateTestProjects,
    Overview,
    SearchRanking,
    VacancyView,
} from '../../applicants';
import Applicants from './Applicants';

jest.mock('../os/Window', () => ({
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('./GradeTasks', () => ({ SignIcon: () => null }));
jest.mock('./Presentation', () => ({ __esModule: true, default: () => null }));
jest.mock('./TeamGraph', () => ({ __esModule: true, default: () => null }));
jest.mock('../../api', () => ({
    ...jest.requireActual('../../api'),
    currentUserId: () => 'recruiter-test',
}));
jest.mock('../../presentation', () => ({
    ...jest.requireActual('../../presentation'),
    presentationSeen: () => true,
    markPresentationSeen: jest.fn(),
}));
jest.mock('../../applicants', () => ({
    ...jest.requireActual('../../applicants'),
    fetchOverview: jest.fn(),
    fetchSearch: jest.fn(),
    fetchTeam: jest.fn(),
    fetchVacancyRanking: jest.fn(),
    sendInvitation: jest.fn(),
    generateTestProjects: jest.fn(),
}));

const overviewRequest = fetchOverview as jest.MockedFunction<typeof fetchOverview>;
const searchRequest = fetchSearch as jest.MockedFunction<typeof fetchSearch>;
const generationRequest = generateTestProjects as jest.MockedFunction<typeof generateTestProjects>;
const GENERATE = 'Сгенерировать тестовые проекты и вакансии';
const NO_VACANCIES_MESSAGE = 'У вас нет вакансий, на которые можно пригласить соискателя.';

const candidate: Candidate = {
    user_id: 'candidate-test',
    name: 'Алексей Тестов',
    specialization: 'Backend',
    rank: 1,
    relevance: 85,
    grade: {
        score: 1,
        basis: 'test',
        grade: 'Middle',
        declared: 'Middle',
        source: 'Manual',
        confirmed: 'Middle',
        refuted: false,
    },
    stack: null,
    profile: null,
    fsp_linked: true,
    fsp_points: 10,
    meets: { grade: true, required: null },
    competencies: [],
    requirements: null,
    invitations: [],
};

const vacancy: VacancyView = {
    id: 'vacancy-test',
    project_id: 'project-test',
    project_name: 'Тестовый проект',
    company: { id: 'company-test', name: 'Тестовая компания' },
    title: 'Backend для тестового проекта',
    position_name: 'Backend-разработчик',
    specialization: 'Backend',
    grade: 'Middle',
    count: 1,
    task: null,
    requirements: [],
    assignments: [],
    salary: null,
    status: 'ready',
    invited: {},
    closed: false,
    open: true,
};

function overview(vacancies: VacancyView[] = []): Overview {
    return {
        projects: vacancies.length
            ? [{
                  id: 'project-test',
                  name: 'Тестовый проект',
                  company: { id: 'company-test', name: 'Тестовая компания' },
                  approved_at: '2026-10-09T10:00:00+00:00',
                  vacancies,
              }]
            : [],
        stack: {},
        kind_names: {},
        degree_names: {},
        flows: { plain: { sent: 'Отправлено' }, assignment: { sent: 'Отправлено' } },
        specializations: ['Backend', 'QA'],
        grades: ['Junior', 'Middle', 'Senior'],
        weights: {
            vacancy: { grade: 0.5, stack: 0.5 },
            specialization: { grade: 0.5, stack: 0.5 },
        },
    };
}

function ranking(entry: Candidate = candidate): SearchRanking {
    return {
        query: { specialization: null, grade: null },
        found: 1,
        linked: 1,
        meet_all: 1,
        weights: { grade: 0.5, stack: 0.5 },
        candidates: [entry],
        unconfirmed: [],
    };
}

async function openMenu() {
    render(
        <Applicants
            title="Соискатели"
            onAlertsChange={jest.fn()}
            onClose={jest.fn()}
            onMinimize={jest.fn()}
            onInteract={jest.fn()}
        />
    );
    await screen.findByRole('button', { name: GENERATE });
}

async function enterFilterSearch() {
    fireEvent.click(screen.getByRole('button', { name: /Найти сотрудника по специализации и грейду/ }));
    await screen.findByText('Алексей Тестов');
}

async function openFilterSearch() {
    await openMenu();
    await enterFilterSearch();
}

beforeEach(() => {
    jest.clearAllMocks();
    overviewRequest.mockReset();
    searchRequest.mockReset().mockResolvedValue(ranking());
    generationRequest.mockReset();
});

test.each([
    ['нет проектов', overview()],
    ['есть только закрытая и черновая вакансии', overview([
        { ...vacancy, closed: true, open: false },
        { ...vacancy, id: 'vacancy-draft', status: 'draft', open: false },
    ])],
])('поиск по фильтрам: %s — приглашение заблокировано, генерация доступна в меню', async (_, state) => {
    overviewRequest.mockResolvedValue(state);
    await openFilterSearch();

    expect(screen.getByRole('button', { name: 'Пригласить…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(NO_VACANCIES_MESSAGE);
    expect(screen.getByRole('status')).toHaveTextContent('Тестовые проекты и вакансии можно сгенерировать в стартовом меню приложения.');
    expect(screen.queryByRole('button', { name: GENERATE })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'В меню' }));
    expect(screen.getByRole('button', { name: GENERATE })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Найти сотрудника по вакансии/ })).toBeDisabled();
});

test('генерация из меню разблокирует методы поиска и сохраняет фильтры при повторном входе', async () => {
    overviewRequest.mockResolvedValueOnce(overview()).mockResolvedValueOnce(overview([vacancy]));
    let completeGeneration!: (value: Awaited<ReturnType<typeof generateTestProjects>>) => void;
    generationRequest.mockReturnValue(new Promise((resolve) => { completeGeneration = resolve; }));
    await openFilterSearch();

    fireEvent.change(screen.getByLabelText('Специализация'), { target: { value: 'Backend' } });
    await waitFor(() => expect(searchRequest).toHaveBeenLastCalledWith('recruiter-test', 'Backend', ''));
    await screen.findByText('Алексей Тестов');
    fireEvent.change(screen.getByRole('textbox', { name: 'Имя или компетенция' }), { target: { value: 'Алексей' } });
    expect(screen.queryByRole('button', { name: GENERATE })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'В меню' }));
    expect(screen.getByText('Проектов: 0 · открытых вакансий: 0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Найти команду для проекта/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Найти сотрудника по вакансии/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: GENERATE }));

    const pending = screen.getByRole('button', { name: 'Генерируем проекты и вакансии…' });
    expect(pending).toBeDisabled();
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(pending);
    expect(generationRequest).toHaveBeenCalledTimes(1);
    expect(generationRequest).toHaveBeenCalledWith('recruiter-test');

    await act(async () => {
        completeGeneration({ created_projects: 1, created_vacancies: 1, project_ids: ['project-test'], vacancy_ids: ['vacancy-test'] });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /Найти сотрудника по вакансии/ })).toBeEnabled());
    expect(overviewRequest).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: /Найти команду для проекта/ })).toBeEnabled();
    expect(screen.getByText('Проектов: 1 · открытых вакансий: 1')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/Создано/);
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByRole('button', { name: GENERATE })).toBeEnabled();

    await enterFilterSearch();
    expect(screen.getByLabelText('Специализация')).toHaveValue('Backend');
    expect(screen.getByRole('textbox', { name: 'Имя или компетенция' })).toHaveValue('Алексей');
    expect(searchRequest).toHaveBeenLastCalledWith('recruiter-test', 'Backend', '');
    expect(screen.queryByText(NO_VACANCIES_MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: GENERATE })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Пригласить…' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Пригласить…' }));
    const picker = screen.getByRole('alertdialog', { name: 'Пригласить на вакансию' });
    expect(within(picker).getByRole('combobox', { name: 'Вакансия' })).toHaveValue('vacancy-test');
    expect(within(picker).getByRole('option')).toHaveTextContent('Backend для тестового проекта — Тестовый проект · без заданий');
    expect(within(picker).getByRole('button', { name: 'Отправить' })).toBeEnabled();
});

test('ошибка генерации объясняется пользователю и позволяет повторить создание', async () => {
    overviewRequest.mockResolvedValueOnce(overview()).mockResolvedValueOnce(overview([vacancy]));
    generationRequest
        .mockRejectedValueOnce(new ApiError('Не удалось сохранить тестовые проекты', 503))
        .mockResolvedValueOnce({ created_projects: 1, created_vacancies: 1, project_ids: ['project-test'], vacancy_ids: ['vacancy-test'] });
    await openMenu();
    fireEvent.click(screen.getByRole('button', { name: GENERATE }));

    const failure = await screen.findByRole('alertdialog');
    expect(failure).toHaveTextContent('Не удалось сохранить тестовые проекты');
    expect(screen.getByRole('button', { name: GENERATE })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Найти сотрудника по вакансии/ })).toBeDisabled();
    fireEvent.click(within(failure).getByRole('button', { name: 'OK' }));
    fireEvent.click(screen.getByRole('button', { name: GENERATE }));

    await waitFor(() => expect(screen.getByRole('button', { name: /Найти сотрудника по вакансии/ })).toBeEnabled());
    expect(generationRequest).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Проектов: 1 · открытых вакансий: 1')).toBeInTheDocument();
    await enterFilterSearch();
    expect(screen.getByRole('button', { name: 'Пригласить…' })).toBeEnabled();
});

test('генерация в стартовом меню доступна при существующей вакансии и пополняет выбор приглашения', async () => {
    const newVacancy = {
        ...vacancy,
        id: 'vacancy-generated',
        project_id: 'project-generated',
        project_name: 'Новый тестовый проект',
        title: 'Backend нового тестового проекта',
    };
    const refreshed = overview([vacancy]);
    refreshed.projects.push({
        ...refreshed.projects[0],
        id: newVacancy.project_id,
        name: newVacancy.project_name,
        vacancies: [newVacancy],
    });
    overviewRequest.mockResolvedValueOnce(overview([vacancy])).mockResolvedValueOnce(refreshed);
    let completeGeneration!: (value: Awaited<ReturnType<typeof generateTestProjects>>) => void;
    generationRequest.mockReturnValue(new Promise((resolve) => { completeGeneration = resolve; }));
    await openMenu();

    expect(screen.getByText('Проектов: 1 · открытых вакансий: 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Найти команду для проекта/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Найти сотрудника по вакансии/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: GENERATE }));
    expect(screen.getByRole('button', { name: 'Генерируем проекты и вакансии…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Найти сотрудника по вакансии/ })).toBeEnabled();

    await act(async () => {
        completeGeneration({ created_projects: 1, created_vacancies: 1, project_ids: [newVacancy.project_id], vacancy_ids: [newVacancy.id] });
    });
    await waitFor(() => expect(overviewRequest).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Проектов: 2 · открытых вакансий: 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: GENERATE })).toBeEnabled();
    await enterFilterSearch();
    expect(screen.queryByRole('button', { name: GENERATE })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Пригласить…' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Пригласить…' }));
    const picker = screen.getByRole('alertdialog', { name: 'Пригласить на вакансию' });
    expect(within(picker).getAllByRole('option')).toHaveLength(2);
    expect(within(picker).getByRole('option', { name: 'Backend нового тестового проекта — Новый тестовый проект · без заданий' })).toHaveValue(newVacancy.id);
});

test('после поиска с грейдом Middle выбор вакансии показывает задания у каждого варианта', async () => {
    const vacancies: VacancyView[] = [
        { ...vacancy, id: 'vacancy-plain', title: 'Backend без задания' },
        { ...vacancy, id: 'vacancy-one-task', title: 'Backend с одним заданием', assignments: ['assignment-one'] },
        { ...vacancy, id: 'vacancy-two-tasks', title: 'Backend с двумя заданиями', assignments: ['assignment-one', 'assignment-two'] },
    ];
    overviewRequest.mockResolvedValue(overview(vacancies));
    searchRequest.mockImplementation(async (_, specialization, grade) => ({
        ...ranking(),
        query: { specialization: specialization || null, grade: grade || null },
    }));
    await openFilterSearch();
    fireEvent.change(screen.getByLabelText('Специализация'), { target: { value: 'Backend' } });
    await waitFor(() => expect(searchRequest).toHaveBeenLastCalledWith('recruiter-test', 'Backend', ''));
    fireEvent.change(screen.getByLabelText('Грейд'), { target: { value: 'Middle' } });
    await waitFor(() => expect(searchRequest).toHaveBeenLastCalledWith('recruiter-test', 'Backend', 'Middle'));

    fireEvent.click(screen.getByRole('button', { name: 'Пригласить…' }));
    const picker = screen.getByRole('alertdialog', { name: 'Пригласить на вакансию' });
    expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual([
        'Backend без задания — Тестовый проект · без заданий',
        'Backend с одним заданием — Тестовый проект · с заданием (1)',
        'Backend с двумя заданиями — Тестовый проект · с заданиями (2)',
    ]);
    expect(within(picker).getByText('Middle · нужно 1 · без заданий')).toBeInTheDocument();
    const selection = within(picker).getByRole('combobox', { name: 'Вакансия' });
    fireEvent.change(selection, { target: { value: 'vacancy-one-task' } });
    expect(selection).toHaveValue('vacancy-one-task');
    expect(within(picker).getByText('Middle · нужно 1 · 1 задание')).toBeInTheDocument();
    expect(within(picker).getByRole('button', { name: 'Отправить' })).toBeEnabled();
    fireEvent.change(selection, { target: { value: 'vacancy-two-tasks' } });
    expect(selection).toHaveValue('vacancy-two-tasks');
    expect(within(picker).getByText('Middle · нужно 1 · 2 задания')).toBeInTheDocument();
    expect(within(picker).getByRole('button', { name: 'Отправить' })).toBeEnabled();
});

test('открытая вакансия другой специализации не позволяет пригласить кандидата', async () => {
    overviewRequest.mockResolvedValue(overview([{ ...vacancy, specialization: 'QA' }]));
    await openFilterSearch();

    const invite = screen.getByRole('button', { name: 'Пригласить…' });
    expect(invite).toBeDisabled();
    expect(invite).toHaveAttribute('title', 'Нет открытых вакансий Backend');
    expect(screen.queryByRole('button', { name: GENERATE })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'В меню' }));
    expect(screen.getByRole('button', { name: GENERATE })).toBeEnabled();
});

test('кандидата нельзя повторно пригласить на единственную доступную вакансию', async () => {
    overviewRequest.mockResolvedValue(overview([vacancy]));
    searchRequest.mockResolvedValue(ranking({
        ...candidate,
        invitations: [{
            id: 'invitation-test',
            type: 'От рекрутера кандидату',
            applicant_id: candidate.user_id,
            vacancy_id: vacancy.id,
            project_id: vacancy.project_id,
            title: vacancy.title,
            flow: 'plain',
            status: 'sent',
            status_history: [{ status: 'sent', at: '2026-10-09T10:00:00+00:00' }],
            relevance: 85,
            created_at: '2026-10-09T10:00:00+00:00',
        }],
    }));
    await openFilterSearch();

    expect(screen.getByRole('button', { name: 'Пригласить…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Пригласить…' })).toHaveAttribute(
        'title', 'Уже приглашён на все открытые вакансии своей специализации'
    );
    expect(screen.queryByRole('button', { name: GENERATE })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'В меню' }));
    expect(screen.getByRole('button', { name: GENERATE })).toBeEnabled();
});
