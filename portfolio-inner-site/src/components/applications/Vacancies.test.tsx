import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ApiError } from '../../api';
import { applyToVacancy, fetchVacancies, RankedVacancy, VacanciesData } from '../../vacancies';
import type { CandidateInvitation } from '../../candidateInvitations';
import Vacancies from './Vacancies';

jest.mock('../os/Window', () => ({
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('./GradeTasks', () => ({ SignIcon: () => null }));
jest.mock('./Presentation', () => ({ __esModule: true, default: () => <p>Презентация идёт</p> }));
jest.mock('../../api', () => ({
    ...jest.requireActual('../../api'),
    currentUserId: () => 'applicant-test',
}));
jest.mock('../../presentation', () => ({
    ...jest.requireActual('../../presentation'),
    presentationSeen: () => true,
    markPresentationSeen: jest.fn(),
}));
jest.mock('../../vacancies', () => ({
    ...jest.requireActual('../../vacancies'),
    fetchVacancies: jest.fn(),
    applyToVacancy: jest.fn(),
}));

const listRequest = fetchVacancies as jest.MockedFunction<typeof fetchVacancies>;
const applyRequest = applyToVacancy as jest.MockedFunction<typeof applyToVacancy>;

const plain: RankedVacancy = {
    id: 'vacancy-plain',
    rank: 1,
    relevance: 85,
    mutual: 0.86,
    title: 'Бэкенд-разработчик (Middle)',
    position_name: 'Бэкенд-разработчик',
    specialization: 'Backend',
    grade: 'Middle',
    count: 1,
    seats: 1,
    task: 'Разработать API каталога.',
    notes: null,
    requirements: [{ kind: 'languages', ids: ['python'], match: 'all', importance: 'required', min_degree: 2, origin: 'fixed', reasons: [] }],
    assignments: [],
    salary: { from: 160000, to: 220000, currency: 'RUB' },
    company: { id: 'company-test', name: 'Тестовая компания' },
    project: {
        id: 'project-test',
        name: 'Интернет-магазин',
        summary: 'Каталог и корзина.',
        domain: 'retail',
        stage: 'active',
        duration: '3to6',
        start_date: null,
        work_format: 'remote',
        city: null,
    },
    recruiter_name: 'Анна Петрова',
    approved_at: '2026-10-09T10:00:00+00:00',
    fit: {
        score: 0.91,
        grade: { score: 1, basis: 'test', grade: 'Middle', declared: 'Middle', source: 'Manual', confirmed: 'Middle', refuted: false },
        stack: { score: 0.86, basis: 'requirements' },
        meets: { grade: true, required: false },
        linked: true,
        requirements: [
            {
                kind: 'languages',
                ids: ['python'],
                match: 'all',
                importance: 'required',
                min_degree: 2,
                score: 0.6,
                meets: false,
                items: [{ id: 'python', via: 'python', relation: 'exact', degree: 1, score: 0.6 }],
            },
        ],
    },
    appeal: {
        score: 0.81,
        strengths: {
            score: 0.7,
            basis: 'requirements',
            items: [
                { kind: 'languages', id: 'python', degree: 1, weight: 0.33, share: 1, relation: 'exact', via: 'python', importance: 'required' },
                { kind: 'languages', id: 'go', degree: 3, weight: 1, share: 0, relation: null, via: null, importance: null },
            ],
        },
        growth: { score: 1, own: 'Middle', step: 0 },
    },
    queue: { score: 0.96, place: 8, of: 162, seats: 1 },
    record: null,
    can_apply: true,
};

const withTask: RankedVacancy = {
    ...plain,
    id: 'vacancy-task',
    rank: 2,
    relevance: 61.4,
    title: 'Бэкенд-разработчик (Senior)',
    grade: 'Senior',
    assignments: ['Опишите повторную доставку события.'],
    appeal: { ...plain.appeal, growth: { score: 0.8, own: 'Middle', step: 1 } },
};

function data(vacancies: RankedVacancy[] = [plain, withTask], linked = true): VacanciesData {
    return {
        specializations: ['Backend'],
        fsp_linked: linked,
        found: vacancies.length,
        weights: { appeal: { grade: 0.35, stack: 0.65 }, queue: 0.2, fit: { grade: 0.35, stack: 0.65 } },
        growth: { '0': 1, '1': 0.8, '-1': 0.3, '2': 0.2, '-2': 0 },
        vacancies,
        stack: { languages: { python: 'Python', go: 'Go' } },
        kind_names: { languages: 'Языки' },
        degree_names: { '1': 'базовая', '2': 'уверенная', '3': 'высокая' },
        flows: {
            plain: { sent: 'Отправлено', read: 'Просмотрено', accepted: 'Принято', declined: 'Отклонено' },
            assignment: { sent: 'Отправлено', task_sent_for_review: 'Задание отправлено на проверку' },
        },
        grades: ['Junior', 'Middle', 'Senior'],
    };
}

function sent(vacancy: RankedVacancy, status: string, flow: 'plain' | 'assignment'): CandidateInvitation {
    return {
        id: `application-${vacancy.id}`,
        type: 'От кандидата рекрутеру',
        recruiter_id: 'recruiter-test',
        recruiter_name: 'Анна Петрова',
        vacancy: {
            id: vacancy.id,
            title: vacancy.title,
            specialization: vacancy.specialization,
            grade: vacancy.grade,
            company: vacancy.company,
            task: vacancy.task,
            requirements: vacancy.requirements,
            assignments: vacancy.assignments,
            salary: vacancy.salary,
        },
        flow,
        status,
        status_history: [{ status, at: '2026-10-09T10:00:00+00:00' }],
        revision: 1,
        created_at: '2026-10-09T10:00:00+00:00',
        assignment_answers: null,
        unseen: false,
        can_respond: false,
    };
}

async function open(state = data()) {
    listRequest.mockResolvedValue(state);
    const alerts = jest.fn();
    render(<Vacancies title="Вакансии" onAlertsChange={alerts} onClose={jest.fn()} onMinimize={jest.fn()} onInteract={jest.fn()} />);
    await screen.findByText('Вакансии для вас');
    return alerts;
}

const list = () => screen.getByRole('listbox', { name: 'Вакансии' });

beforeEach(() => {
    jest.clearAllMocks();
    listRequest.mockReset();
    applyRequest.mockReset();
});

test('список по релевантности и карточка объясняет место вакансии', async () => {
    await open();
    const options = within(list()).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
        expect.stringContaining('Бэкенд-разработчик (Middle)'),
        expect.stringContaining('Бэкенд-разработчик (Senior)'),
    ]);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Почему вакансия на этом месте')).toBeInTheDocument();
    expect(screen.getByText(/Так вас видит рекрутёр/)).toBeInTheDocument();
    expect(screen.getByText(/Вы 8-й из 162 в списке рекрутёра/)).toBeInTheDocument();
    expect(screen.getByText('Python: у вас «базовая», нужна «уверенная».')).toBeInTheDocument();

    fireEvent.click(options[1]);
    expect(within(list()).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/на ступень выше вашего Middle — рост/)).toBeInTheDocument();
    fireEvent.keyDown(list(), { key: 'ArrowUp' });
    expect(within(list()).getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
});

test('отклик без заданий уходит после подтверждения и показывает статус', async () => {
    const alerts = await open();
    applyRequest.mockResolvedValue(sent(plain, 'sent', 'plain'));
    fireEvent.click(screen.getByRole('button', { name: 'Откликнуться…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Отклик на вакансию' });
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Отправить отклик' }));

    await screen.findByRole('alertdialog', { name: 'Отклик отправлен' });
    expect(applyRequest).toHaveBeenCalledWith('applicant-test', 'vacancy-plain', undefined);
    expect(alerts).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.queryByRole('button', { name: 'Откликнуться…' })).not.toBeInTheDocument();
    expect(screen.getByText(/Ваш отклик\. Статус меняет рекрутёр/)).toBeInTheDocument();
    expect(within(list()).getAllByRole('option')[0]).toHaveTextContent('Отправлено');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Ещё не откликался' }));
    expect(within(list()).getAllByRole('option')).toHaveLength(1);
    expect(within(list()).getByRole('option')).toHaveTextContent('Бэкенд-разработчик (Senior)');
});

test('отклик с заданиями требует решения каждого', async () => {
    await open();
    applyRequest.mockResolvedValue(sent(withTask, 'task_sent_for_review', 'assignment'));
    fireEvent.click(within(list()).getAllByRole('option')[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Откликнуться…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Отклик на вакансию' });
    const submit = within(dialog).getByRole('button', { name: 'Отправить отклик' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Решение задания 1' }), { target: { value: 'Ключ идемпотентности.' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await screen.findByRole('alertdialog', { name: 'Отклик отправлен' });
    expect(applyRequest).toHaveBeenCalledWith('applicant-test', 'vacancy-task', ['Ключ идемпотентности.']);
});

test('приглашение на вакансию — без кнопки отклика; отказ сервера обновляет список', async () => {
    const invited: RankedVacancy = {
        ...plain,
        record: { id: 'invitation', type: 'От рекрутера кандидату', flow: 'plain', status: 'read', status_history: [], created_at: null },
        can_apply: false,
    };
    await open(data([invited, withTask]));
    expect(screen.queryByRole('button', { name: 'Откликнуться…' })).not.toBeInTheDocument();
    expect(screen.getByText(/Рекрутёр уже пригласил вас/)).toBeInTheDocument();

    applyRequest.mockRejectedValue(new ApiError('Вакансия закрыта: все места уже заняты', 409));
    fireEvent.click(within(list()).getAllByRole('option')[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Откликнуться…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Решение задания 1' }), { target: { value: 'Решение' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить отклик' }));
    await screen.findByText('Вакансия закрыта: все места уже заняты');
    await waitFor(() => expect(listRequest).toHaveBeenCalledTimes(2));
});

test('без связки с ФСП — подсказка о связке', async () => {
    await open(data([plain], false));
    expect(screen.getByText(/Профиль не связан с ФСП: стек не с чем сравнить/)).toBeInTheDocument();
});

test('нет открытых вакансий своей специализации', async () => {
    await open(data([]));
    expect(screen.getByText('Открытых вакансий Backend пока нет')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});

test('не соискатель видит причину без повтора', async () => {
    listRequest.mockRejectedValue(new ApiError('Вакансии подбираются соискателю: у вас нет специализации соискателя', 403));
    render(<Vacancies title="Вакансии" onAlertsChange={jest.fn()} onClose={jest.fn()} onMinimize={jest.fn()} onInteract={jest.fn()} />);
    await screen.findByText('Вакансии подбираются соискателю: у вас нет специализации соискателя');
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument();
});

test('«Как считается» снова показывает презентацию', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Как считается' }));
    expect(screen.getByText('Презентация идёт')).toBeInTheDocument();
});
