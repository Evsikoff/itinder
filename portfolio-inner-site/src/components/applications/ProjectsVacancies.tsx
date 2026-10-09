import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Window from '../os/Window';
import { ApiError, currentUserId } from '../../api';
import { generateTestProjects } from '../../applicants';
import {
    approveVacancies,
    Company,
    completeProject,
    copyProject,
    createProject,
    deleteProject,
    fetchCatalog,
    fetchProject,
    fetchProjects,
    generateTestFeedback,
    markProjectNewsRead,
    OpenQuestion,
    Project,
    ProjectCatalog,
    ProjectStatus,
    ProjectSummary,
    Vacancy,
} from '../../projects';
import {
    Answers,
    Evaluation,
    format,
    GRADES,
    KINDS,
    NONE,
    Question,
    QuestionnaireEngine,
    Section,
    TemplateItem,
    UNKNOWN,
} from '../../projectQuestionnaire';
import { SignIcon } from './GradeTasks';
import ProjectQuestionnaire from './ProjectQuestionnaire';
import ProjectFeedback from './ProjectFeedback';
import VacancyEditor, { VacancyCard } from './VacancyEditor';
import { Choice, Dialog, DialogView, formatDate, peopleWord, vacanciesWord } from './projectWidgets';
import './GradeTasks.css';
import './FspAchievements.css';
import './ProjectsVacancies.css';

// «Проекты и вакансии» — окно значка id 8 на рабочем столе рекрутёра.
// Список проектов: создать, открыть, копировать, отметить «набор завершён», удалить.
// Новый проект: название и компания (из app/db/companies или новая), потом анкета
// (ProjectQuestionnaire, правила — app/db/project_questionnaire.json). Анкета
// заполнена — сервер записывает проект (app/db/user_project_company) с вакансиями,
// которые сформировала анкета; рекрутёр правит их, указывает вилки и утверждает —
// сервер пишет файлы вакансий (app/db/projects_jobopenings). Открытый проект —
// просмотр вакансий и ответов анкеты; вакансии можно править и утвердить заново.
//   loading — справочники и список; error — не загрузились; list — список проектов;
//   card — название и компания; questionnaire — анкета; editor — правка вакансий;
//   view — просмотр проекта; busy — ждём сервер (busyText).
type Stage = 'loading' | 'error' | 'list' | 'card' | 'questionnaire' | 'editor' | 'view' | 'busy';

export interface ProjectsVacanciesProps extends WindowAppProps {
    title: string;
    image?: string;
    onAlertsChange: () => void;
}

interface Card {
    name: string;
    mode: 'list' | 'new';
    companyId: string;
    companyName: string;
}

const NO_USER = 'Не удалось узнать, кто вы. Войдите в ITinder и откройте окно снова.';
const STATUS_NAMES: { [status in ProjectStatus]: string } = {
    draft: 'Вакансии не утверждены',
    open: 'Набор идёт',
    completed: 'Набор завершён',
};
const STATUS_BADGES: { [status in ProjectStatus]: string } = {
    draft: 'gt-badge-half',
    open: 'gt-badge-good',
    completed: 'pv-badge-done',
};

function errorOf(failure: unknown, fallback: string): { message: string; status: number } {
    return {
        message: failure instanceof ApiError ? failure.message : fallback,
        status: failure instanceof ApiError ? failure.status : 500,
    };
}

const ProjectsVacancies: React.FC<ProjectsVacanciesProps> = (props) => {
    const [userId] = useState(currentUserId);
    const [size] = useState(() => ({
        width: Math.max(720, Math.min(1180, window.innerWidth - 60)),
        height: Math.max(520, Math.min(840, window.innerHeight - 50)),
    }));
    const [stage, setStage] = useState<Stage>('loading');
    const [busyText, setBusyText] = useState('');
    const [error, setError] = useState<{ message: string; retry: (() => void) | null }>({ message: '', retry: null });
    const [catalog, setCatalog] = useState<ProjectCatalog | null>(null);
    const [projects, setProjects] = useState<ProjectSummary[]>([]);
    const [selected, setSelected] = useState<string | null>(null);
    const [card, setCard] = useState<Card>({ name: '', mode: 'list', companyId: '', companyName: '' });
    const [answers, setAnswers] = useState<Answers>({});
    const [project, setProject] = useState<Project | null>(null);
    const [viewTab, setViewTab] = useState<'vacancies' | 'answers' | 'feedback'>('vacancies');
    const [dialog, setDialog] = useState<Dialog | null>(null);
    // Окно «Копировать проект» с полем названия: собирается заново при каждом вводе.
    const [copyPrompt, setCopyPrompt] = useState<{ source: ProjectSummary; back: Stage; value: string } | null>(null);
    const [notice, setNotice] = useState('');
    const generationInFlight = useRef(false);
    const listVersion = useRef(0);

    const engine = useMemo(
        () =>
            catalog
                ? new QuestionnaireEngine({
                      schema: catalog.questionnaire,
                      stack: catalog.stack,
                      roles: catalog.roles,
                      market: catalog.market,
                  })
                : null,
        [catalog]
    );

    const closeDialog = useCallback(() => setDialog(null), []);
    const showDialog = useCallback((next: Dialog) => setDialog(next), []);

    // Ошибка действия, после которой окно остаётся на месте: сообщение поверх.
    const complain = (failure: unknown, fallback: string, back: Stage) => {
        setStage(back);
        setDialog({
            sign: 'error',
            title: 'Не получилось',
            text: errorOf(failure, fallback).message,
            buttons: [{ text: 'OK', primary: true, onClick: () => setDialog(null) }],
        });
    };

    const busy = (text: string) => {
        setBusyText(text);
        setStage('busy');
    };

    const load = useCallback(async () => {
        const version = ++listVersion.current;
        setStage('loading');
        if (!userId) {
            setError({ message: NO_USER, retry: null });
            setStage('error');
            return;
        }
        try {
            const [nextCatalog, list] = await Promise.all([fetchCatalog(userId), fetchProjects(userId)]);
            if (version !== listVersion.current) return;
            setCatalog(nextCatalog);
            setProjects(list);
            setStage('list');
        } catch (failure) {
            if (version !== listVersion.current) return;
            const { message, status } = errorOf(failure, 'Не удалось загрузить проекты');
            setError({ message, retry: status === 0 || status >= 500 ? () => load() : null });
            setStage('error');
        }
    }, [userId]);

    useEffect(() => {
        load();
    }, [load]);

    // Ответы соискателей появляются без действий в этом окне.
    useEffect(() => {
        if (!userId || stage !== 'list') return;
        let cancelled = false;
        const update = async () => {
            const version = ++listVersion.current;
            try {
                const list = await fetchProjects(userId);
                if (!cancelled && version === listVersion.current) setProjects(list);
            } catch {
                // Сохраняем последний список; следующий опрос повторит запрос.
            }
        };
        const timer = window.setInterval(update, 15000);
        window.addEventListener('focus', update);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
            window.removeEventListener('focus', update);
        };
    }, [stage, userId]);

    const refreshList = async (select?: string | null) => {
        if (!userId) return;
        const version = ++listVersion.current;
        try {
            const list = await fetchProjects(userId);
            if (version !== listVersion.current) return;
            setProjects(list);
            if (select !== undefined) setSelected(select);
        } catch {
            // Список обновится при следующем открытии окна; причину request уже написал в консоль.
        }
    };

    // --- Действия со списком -----------------------------------------------------

    const selectedSummary = projects.find((p) => p.id === selected) ?? null;
    const canGenerateFeedback = projects.some((item) => (item.valid_vacancies ?? 0) > 0);

    const generateProjects = async () => {
        if (!userId || stage !== 'list' || dialog || copyPrompt || generationInFlight.current) return;
        generationInFlight.current = true;
        const version = ++listVersion.current;
        setNotice('');
        busy('Генерируем проекты и вакансии…');
        let prepared = false;
        try {
            const result = await generateTestProjects(userId);
            prepared = true;
            setNotice(result.created_projects
                ? `Создано тестовых проектов: ${result.created_projects}, вакансий: ${result.created_vacancies}.`
                : 'Тестовые проекты и вакансии готовы.');
            const [nextCatalog, list] = await Promise.all([fetchCatalog(userId), fetchProjects(userId)]);
            if (version !== listVersion.current) return;
            setCatalog(nextCatalog);
            setProjects(list);
            setSelected((current) => list.some((item) => item.id === current) ? current
                : result.project_ids.find((id) => list.some((item) => item.id === id)) ?? null);
            setStage('list');
        } catch (failure) {
            if (version !== listVersion.current) return;
            if (prepared) {
                setStage('list');
                setDialog({
                    sign: 'error',
                    title: 'Не удалось обновить список',
                    text: 'Тестовые проекты и вакансии готовы, но список не удалось обновить. '
                        + errorOf(failure, 'Попробуйте обновить список ещё раз.').message,
                    buttons: [
                        { text: 'Обновить список', primary: true, onClick: () => { closeDialog(); load(); } },
                        { text: 'OK', onClick: closeDialog },
                    ],
                });
            } else {
                complain(failure, 'Не удалось сгенерировать тестовые проекты и вакансии', 'list');
            }
        } finally {
            generationInFlight.current = false;
        }
    };

    const generateFeedback = async () => {
        if (!userId || stage !== 'list' || dialog || copyPrompt || generationInFlight.current || !canGenerateFeedback) return;
        generationInFlight.current = true;
        const version = ++listVersion.current;
        setNotice('');
        busy('Генерируем тестовую обратную связь…');
        let generated = false;
        try {
            const result = await generateTestFeedback(userId);
            generated = true;
            setNotice(`Создано откликов: ${result.created_applications}; принятий приглашений: ${result.accepted_invitations}; `
                + `решений заданий: ${result.submitted_assignments}.`);
            const list = await fetchProjects(userId);
            if (version !== listVersion.current) return;
            setProjects(list);
            setSelected((current) => list.some((item) => item.id === current) ? current : null);
            setStage('list');
            props.onAlertsChange();
        } catch (failure) {
            if (version !== listVersion.current) return;
            if (generated) {
                setStage('list');
                setDialog({
                    sign: 'error', title: 'Не удалось обновить список',
                    text: 'Обратная связь создана, но новости и список проектов не удалось обновить. '
                        + errorOf(failure, 'Попробуйте обновить список ещё раз.').message,
                    buttons: [
                        { text: 'Обновить список', primary: true, onClick: () => { closeDialog(); load(); } },
                        { text: 'OK', onClick: closeDialog },
                    ],
                });
            } else {
                complain(failure, 'Не удалось сгенерировать тестовую обратную связь', 'list');
            }
        } finally {
            generationInFlight.current = false;
        }
    };

    const startCreate = () => {
        const companies = catalog?.companies ?? [];
        setCard({
            name: '',
            mode: companies.length ? 'list' : 'new',
            companyId: companies[0]?.id ?? '',
            companyName: '',
        });
        setNotice('');
        setStage('card');
    };

    const open = async (projectId: string) => {
        if (!userId) return;
        busy('Открываем проект…');
        try {
            const opened = await fetchProject(userId, projectId);
            setProject(opened);
            const news = projects.find(item => item.id === projectId)?.news;
            setViewTab([news, opened.news].some(item => item && Object.values(item).some(count => count > 0))
                ? 'feedback' : 'vacancies');
            setStage('view');
            if (opened.accepted_news?.length) {
                try {
                    const result = await markProjectNewsRead(userId, projectId, opened.accepted_news);
                    setProjects((current) => current.map((item) => item.id === projectId
                        ? { ...item, news: result.news } : item));
                } catch {
                    setNotice('Проект открыт, но просмотр принятых приглашений не удалось сохранить. '
                        + 'Отметка сохранится при следующем открытии проекта.');
                }
            }
        } catch (failure) {
            complain(failure, 'Не удалось открыть проект', 'list');
            refreshList();
        }
    };

    const askCopy = (source: ProjectSummary, back: Stage) =>
        setCopyPrompt({ source, back, value: `${source.name} (копия)`.slice(0, 120) });

    const copyDialog = (prompt: { source: ProjectSummary; back: Stage; value: string }): Dialog => ({
        sign: 'question',
        title: 'Копировать проект',
        text: 'Копия получит ту же компанию, ответы анкеты и вакансии. Вакансии копии нужно будет утвердить заново.',
        input: { label: 'Название копии:', value: prompt.value, maxLength: 120 },
        buttons: [
            { text: 'Копировать', primary: true, onClick: () => doCopy(prompt.source, prompt.value, prompt.back) },
            { text: 'Отмена', onClick: () => setCopyPrompt(null) },
        ],
    });

    const doCopy = async (source: ProjectSummary, name: string, back: Stage) => {
        if (!userId || !name.trim()) return;
        setCopyPrompt(null);
        busy('Копируем проект…');
        try {
            const copy = await copyProject(userId, source.id, name.trim());
            await refreshList(copy.id);
            setNotice(`Создана копия «${copy.name}».`);
            setStage('list');
        } catch (failure) {
            complain(failure, 'Не удалось скопировать проект', back);
        }
    };

    const toggleCompleted = async (target: ProjectSummary, back: Stage) => {
        if (!userId) return;
        const completed = target.status !== 'completed';
        busy(completed ? 'Отмечаем набор завершённым…' : 'Возобновляем набор…');
        try {
            const next = await completeProject(userId, target.id, completed);
            await refreshList(target.id);
            if (back === 'view') setProject(next);
            setNotice(completed ? `Набор по проекту «${next.name}» завершён.` : `Набор по проекту «${next.name}» возобновлён.`);
            setStage(back);
        } catch (failure) {
            complain(failure, 'Не удалось изменить проект', back);
        }
    };

    const askDelete = (target: ProjectSummary, back: Stage) =>
        setDialog({
            sign: 'question',
            title: 'Удалить проект',
            text: `Удалить проект «${target.name}»${
                target.vacancies ? ` и ${target.vacancies} ${vacanciesWord(target.vacancies)}` : ''
            }? Восстановить их не получится.`,
            buttons: [
                {
                    text: 'Удалить',
                    primary: true,
                    onClick: async () => {
                        if (!userId) return;
                        setDialog(null);
                        busy('Удаляем проект…');
                        try {
                            await deleteProject(userId, target.id);
                            await refreshList(null);
                            setProject(null);
                            setNotice(`Проект «${target.name}» удалён.`);
                            setStage('list');
                        } catch (failure) {
                            complain(failure, 'Не удалось удалить проект', back);
                        }
                    },
                },
                { text: 'Отмена', onClick: closeDialog },
            ],
        });

    // --- Новый проект ------------------------------------------------------------

    const companyOf = (): { id: string } | { name: string } | null => {
        if (card.mode === 'list') return card.companyId ? { id: card.companyId } : null;
        const name = card.companyName.trim();
        return name ? { name } : null;
    };

    const companyName = () =>
        card.mode === 'list'
            ? catalog?.companies.find((c) => c.id === card.companyId)?.name ?? ''
            : card.companyName.trim();

    const startQuestionnaire = () => {
        const missing: string[] = [];
        if (!card.name.trim()) missing.push('Название проекта');
        if (!companyOf()) missing.push(card.mode === 'list' ? 'Компания из списка' : 'Название новой компании');
        if (missing.length) {
            setDialog({
                sign: 'error',
                title: 'Не всё заполнено',
                text: 'Заполните:',
                list: missing,
                buttons: [{ text: 'OK', primary: true, onClick: closeDialog }],
            });
            return;
        }
        // Отрасль компании — ответом на «Отрасль» (prelude схемы).
        const company = catalog?.companies.find((c) => c.id === card.companyId);
        setAnswers(card.mode === 'list' && company?.industry ? { domain: company.industry } : {});
        setStage('questionnaire');
    };

    const cancelQuestionnaire = () =>
        setDialog({
            sign: 'question',
            title: 'Прервать анкету',
            text: 'Проект ещё не сохранён: ответы анкеты пропадут. Прервать?',
            buttons: [
                {
                    text: 'Прервать',
                    primary: true,
                    onClick: () => {
                        setDialog(null);
                        setAnswers({});
                        setStage('list');
                    },
                },
                { text: 'Продолжить анкету', onClick: closeDialog },
            ],
        });

    const saveProject = async (evaluation: Evaluation) => {
        if (!userId || !engine) return;
        const company = companyOf();
        if (!company) return;
        busy('Сохраняем проект…');
        try {
            const created = await createProject(userId, {
                name: card.name.trim(),
                company,
                answers: engine.cleanAnswers(answers, evaluation),
                summary: engine.summary(evaluation, answers),
                vacancies: evaluation.vacancies,
            });
            setProject(created);
            setAnswers({});
            refreshList(created.id);
            if ('name' in company && catalog) {
                // Новая компания появится в списке при следующем проекте.
                fetchCatalog(userId).then(setCatalog).catch(() => {});
            }
            setNotice('');
            setStage('editor');
        } catch (failure) {
            complain(failure, 'Не удалось сохранить проект', 'questionnaire');
        }
    };

    const approve = async (vacancies: Vacancy[], questions: OpenQuestion[]) => {
        if (!userId || !project) return;
        busy('Утверждаем вакансии…');
        try {
            const next = await approveVacancies(userId, project.id, vacancies, questions);
            setProject(next);
            refreshList(next.id);
            setNotice(`Вакансии утверждены: ${next.vacancies} ${vacanciesWord(next.vacancies)}, ${next.people} ${peopleWord(next.people)}.`);
            setViewTab('vacancies');
            setStage('view');
        } catch (failure) {
            complain(failure, 'Не удалось утвердить вакансии', 'editor');
        }
    };

    // --- Ответы анкеты в просмотре -------------------------------------------------

    const answerText = (question: Question, value: any, item?: TemplateItem): string => {
        if (!engine) return '';
        const optionText = (id: string) => {
            const option = [...(question.options ?? []), ...(question.extra_options ?? [])].find((o) => o.id === id);
            return option ? format(option.text, item?.vars) : id;
        };
        switch (question.type) {
            case 'single':
                return optionText(value);
            case 'multi':
                if (question.options_from && item) {
                    return (value as string[]).map((id) => project?.summary.positions?.find((p: any) => p.id === id)?.name ?? id).join(', ');
                }
                return (value as string[]).map(optionText).join('; ');
            case 'yes_no':
                return value === 'yes' ? 'Да' : 'Нет';
            case 'stack_pick': {
                const names = (kind: typeof KINDS[number], part: any) =>
                    part === NONE
                        ? 'нет'
                        : part === UNKNOWN
                        ? 'не знаю'
                        : (part as string[]).map((id) => (id === UNKNOWN ? 'не знаю' : engine.itemName(kind, id))).join(', ');
                if (question.per_kind) {
                    return (question.kinds ?? [])
                        .filter((kind) => value?.[kind] !== undefined)
                        .map((kind) => `${engine.kindName(kind)}: ${names(kind, value[kind])}`)
                        .join('; ');
                }
                const kinds = question.kinds ?? [];
                return (value as string[])
                    .map((id) => (id === UNKNOWN ? 'не знаю' : engine.itemName(kinds.find((k) => engine.items[k]?.[id]) ?? kinds[0], id)))
                    .join(', ');
            }
            case 'list':
                return (value as any[])
                    .map((entry) =>
                        (question.fields ?? [])
                            .filter((field) => entry[field.id] !== undefined)
                            .map((field) => answerText(field, entry[field.id]))
                            .join(' — ')
                    )
                    .join('; ');
            case 'team_matrix':
                return Object.keys(value ?? {})
                    .map((row) => {
                        const cells = GRADES.filter((g) => value[row]?.[g] > 0).map((g) => `${g} ${value[row][g]}`);
                        const name =
                            project?.summary.positions?.find((p: any) => p.id === row)?.name ?? engine.roles[row]?.name ?? row;
                        return cells.length ? `${name}: ${cells.join(', ')}` : '';
                    })
                    .filter(Boolean)
                    .join('; ');
            case 'market_choice': {
                const candidates: any[] = item?.vars.candidates ?? [];
                if ((value as string[]).includes(UNKNOWN)) return 'спросить техлида';
                return (value as string[]).map((key) => candidates.find((c) => c.key === key)?.name ?? key).join(' или ');
            }
            default:
                return String(value);
        }
    };

    const renderAnswers = (known: Project) => {
        if (!engine) return null;
        const evaluation = engine.evaluate(known.answers);
        const rows = (section: Section) =>
            section.questions
                .filter((q) => evaluation.visible[q.id] && known.answers[q.id] !== undefined && q.type !== 'summary')
                .map((q) => (
                    <div className="pv-answer" key={q.id}>
                        <span className="gt-muted pv-small">{q.text}</span>
                        <span className="pv-pre">{answerText(q, known.answers[q.id])}</span>
                    </div>
                ));
        // Блок шаблона одной строкой: ответы его вопросов через точку.
        const templateRow = (section: Section, item: TemplateItem) => {
            const parts = section.questions
                .filter((q) => engine.testIn(q.show_if, known.answers, { item, section }))
                .map((q) => {
                    const value = engine.templateValue(section, item, q, known.answers);
                    return value === undefined || value === null || value === '' ? '' : answerText(q, value, item);
                })
                .filter(Boolean);
            return (
                <div className="pv-answer" key={item.key}>
                    <span className="gt-muted pv-small">{format(section.title, item.vars)}</span>
                    <span className="pv-pre">{parts.join(' · ')}</span>
                </div>
            );
        };
        return (
            <div className="gt-column">
                {evaluation.sections
                    .filter((view) => view.section.id !== 'summary')
                    .map(({ section, items }) => (
                        <div className="gt-group" key={section.id} style={{ marginTop: 14 }}>
                            <span className="gt-group-label">{items ? section.title.replace(/:\s*\{\w+\}$/, '') : section.title}</span>
                            {items ? items.map((item) => templateRow(section, item)) : rows(section)}
                        </div>
                    ))}
            </div>
        );
    };

    // --- Экраны ------------------------------------------------------------------

    const renderHeader = (title: string, hint: string) => (
        <div className="gt-header">
            {props.image && <img src={props.image} alt="" />}
            <div className="gt-column">
                <p className="gt-title">{title}</p>
                <p className="gt-muted">{hint}</p>
            </div>
        </div>
    );

    const renderWaiting = (title: string) => (
        <div className="gt-center">
            <p className="gt-title">{title}</p>
            <div className="gt-progress fsp-busy" style={{ marginTop: 18, maxWidth: 440 }}>
                <div className="gt-progress-fill" />
            </div>
        </div>
    );

    const renderError = () => (
        <>
            <div className="gt-center">
                <div className="gt-row" style={{ maxWidth: 560 }}>
                    <SignIcon sign="error" />
                    <p style={{ marginLeft: 16, flex: 1 }}>{error.message}</p>
                </div>
            </div>
            <div className="gt-footer">
                <p className="gt-status" />
                {error.retry && (
                    <button className="site-button gt-default" onClick={() => error.retry?.()}>
                        Повторить
                    </button>
                )}
                <button className={'site-button' + (error.retry ? '' : ' gt-default')} onClick={props.onClose}>
                    Закрыть
                </button>
            </div>
        </>
    );

    const renderList = () => {
        const target = selectedSummary;
        return (
            <>
                {renderHeader(
                    'Проекты и вакансии',
                    'Заведите проект: анкета поможет понять, кто нужен и какой стек требовать, и сформирует вакансии.'
                )}
                <div className="gt-row pv-test-projects">
                    <p className="gt-muted pv-small">Тестовые проекты и вакансии для всех четырёх специализаций.</p>
                    <button className="site-button" disabled={!!dialog || !!copyPrompt} onClick={generateProjects}>
                        Сгенерировать тестовые проекты и вакансии
                    </button>
                    {canGenerateFeedback && (
                        <button className="site-button" disabled={!!dialog || !!copyPrompt} onClick={generateFeedback}>
                            Сгенерировать тестовую обратную связь
                        </button>
                    )}
                </div>
                <div className="gt-row pv-list-area">
                    <div className="gt-column gt-field pv-list">
                        <div className="gt-row pv-list-head">
                            <span className="pv-col-name">Проект</span>
                            <span className="pv-col-company">Компания</span>
                            <span className="pv-col-count">Вакансии</span>
                            <span className="pv-col-status">Статус</span>
                            <span className="pv-col-date">Создан</span>
                            <span className="pv-col-news">Новости</span>
                        </div>
                        <div className="gt-column gt-scroll pv-list-body" role="listbox" aria-label="Проекты">
                            {projects.map((item) => (
                                <div
                                    key={item.id}
                                    className={'gt-row pv-list-row' + (item.id === selected ? ' pv-list-row-active' : '')}
                                    role="option"
                                    aria-selected={item.id === selected}
                                    tabIndex={0}
                                    onClick={() => setSelected(item.id)}
                                    onDoubleClick={() => open(item.id)}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter') open(item.id);
                                        if (event.key === ' ') {
                                            event.preventDefault();
                                            setSelected(item.id);
                                        }
                                    }}
                                >
                                    <span className="pv-col-name" title={item.name}>{item.name}</span>
                                    <span className="pv-col-company" title={item.company.name}>{item.company.name}</span>
                                    <span
                                        className="pv-col-count"
                                        title={`${item.vacancies} ${vacanciesWord(item.vacancies)}, ${item.people} ${peopleWord(item.people)}`}
                                    >
                                        {item.vacancies} ({item.people} чел.)
                                    </span>
                                    <span className="pv-col-status">
                                        <span className={`gt-badge ${STATUS_BADGES[item.status]}`}>{STATUS_NAMES[item.status]}</span>
                                    </span>
                                    <span className="pv-col-date">{formatDate(item.created_at)}</span>
                                    <span className="pv-col-news" aria-label={`Новости проекта «${item.name}»`}>
                                        {!!item.news?.new_applications && (
                                            <span className="gt-badge pv-news-badge pv-news-applications"
                                                title={`Новых откликов: ${item.news.new_applications}`}>
                                                Есть новые отклики
                                            </span>
                                        )}
                                        {!!item.news?.accepted_invitations && (
                                            <span className="gt-badge pv-news-badge pv-news-accepted"
                                                title={`Принятых приглашений: ${item.news.accepted_invitations}. Откройте проект, чтобы отметить просмотр.`}>
                                                Есть принятие приглашения
                                            </span>
                                        )}
                                        {!!item.news?.assignments_to_review && (
                                            <span className="gt-badge pv-news-badge pv-news-review"
                                                title={`Приглашений с заданиями на проверке: ${item.news.assignments_to_review}`}>
                                                Есть задания требующие проверки
                                            </span>
                                        )}
                                        {!item.news?.new_applications && !item.news?.accepted_invitations
                                            && !item.news?.assignments_to_review && <span className="gt-muted">—</span>}
                                    </span>
                                </div>
                            ))}
                            {!projects.length && (
                                <div className="gt-center pv-empty">
                                    <p>Проектов пока нет.</p>
                                    <p className="gt-muted">Нажмите «Создать», чтобы завести первый.</p>
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="gt-column pv-actions">
                        <button className="site-button gt-default" onClick={startCreate}>
                            Создать…
                        </button>
                        <button className="site-button" disabled={!target} onClick={() => target && open(target.id)}>
                            Открыть
                        </button>
                        <button className="site-button" disabled={!target} onClick={() => target && askCopy(target, 'list')}>
                            Копировать…
                        </button>
                        <button
                            className="site-button"
                            disabled={!target || target.status === 'draft'}
                            title={target?.status === 'draft' ? 'Сначала утвердите вакансии проекта' : undefined}
                            onClick={() => target && toggleCompleted(target, 'list')}
                        >
                            {target?.status === 'completed' ? 'Возобновить набор' : 'Набор завершён'}
                        </button>
                        <button className="site-button" disabled={!target} onClick={() => target && askDelete(target, 'list')}>
                            Удалить…
                        </button>
                    </div>
                </div>
                <div className="gt-footer">
                    <p className="gt-status">
                        {notice ||
                            (projects.length
                                ? `Проектов: ${projects.length}. Двойной щелчок — открыть.`
                                : 'Список пуст.')}
                    </p>
                    <button className="site-button" onClick={props.onClose}>
                        Закрыть
                    </button>
                </div>
            </>
        );
    };

    const renderCard = () => {
        const companies: Company[] = catalog?.companies ?? [];
        const chosen = companies.find((c) => c.id === card.companyId);
        return (
            <form
                className="fsp-form"
                noValidate
                onSubmit={(event) => {
                    event.preventDefault();
                    startQuestionnaire();
                }}
            >
                {renderHeader('Новый проект', 'Название проекта и компания-заказчик. Потом — анкета.')}
                <div className="gt-panel gt-scroll">
                    <div className="gt-group" style={{ marginTop: 6 }}>
                        <span className="gt-group-label">Проект</span>
                        <label className="gt-column">
                            <span>
                                Название проекта<span className="pv-required"> *</span>
                            </span>
                            <input
                                className="pv-input"
                                value={card.name}
                                maxLength={120}
                                autoFocus
                                placeholder="Например: Приложение курьера"
                                onChange={(event) => setCard({ ...card, name: event.target.value })}
                            />
                        </label>
                    </div>
                    <div className="gt-group" style={{ marginTop: 18 }}>
                        <span className="gt-group-label">Компания</span>
                        <Choice
                            type="radio"
                            checked={card.mode === 'list'}
                            disabled={!companies.length}
                            onToggle={() => setCard({ ...card, mode: 'list' })}
                            label="Выбрать из списка"
                            hint={companies.length ? undefined : 'Компаний пока нет — заведите новую'}
                        />
                        {card.mode === 'list' && companies.length > 0 && (
                            <div className="gt-column pv-indent">
                                <select
                                    className="gt-select"
                                    value={card.companyId}
                                    aria-label="Компания"
                                    onChange={(event) => setCard({ ...card, companyId: event.target.value })}
                                >
                                    {companies.map((company) => (
                                        <option key={company.id} value={company.id}>
                                            {company.name}
                                        </option>
                                    ))}
                                </select>
                                {chosen && (
                                    <p className="gt-muted pv-small" style={{ marginTop: 4 }}>
                                        {[chosen.city, chosen.description].filter(Boolean).join(' · ')}
                                    </p>
                                )}
                            </div>
                        )}
                        <Choice
                            type="radio"
                            checked={card.mode === 'new'}
                            onToggle={() => setCard({ ...card, mode: 'new' })}
                            label="Новая компания"
                        />
                        {card.mode === 'new' && (
                            <div className="gt-column pv-indent">
                                <input
                                    className="pv-input"
                                    value={card.companyName}
                                    maxLength={120}
                                    aria-label="Название новой компании"
                                    placeholder="Название компании"
                                    onChange={(event) => setCard({ ...card, companyName: event.target.value })}
                                />
                                <p className="gt-muted pv-small" style={{ marginTop: 4 }}>
                                    Компания запишется вместе с проектом, когда анкета будет заполнена.
                                </p>
                            </div>
                        )}
                    </div>
                </div>
                <div className="gt-footer">
                    <p className="gt-status">Дальше — анкета: несколько шагов о продукте и команде.</p>
                    <button type="submit" className="site-button gt-default">
                        Далее: анкета
                    </button>
                    <button type="button" className="site-button" onClick={() => setStage('list')}>
                        Отмена
                    </button>
                </div>
            </form>
        );
    };

    const renderView = (known: Project) => {
        const completed = known.status === 'completed';
        const questions = (known.summary.open_questions ?? []).filter((q) => !q.resolved);
        return (
            <>
                {renderHeader(
                    known.name,
                    `${known.company.name} · ${STATUS_NAMES[known.status]} · создан ${formatDate(known.created_at)}${
                        known.approved_at ? ` · вакансии утверждены ${formatDate(known.approved_at)}` : ''
                    }`
                )}
                <div className="gt-tabs" role="tablist">
                    {(
                        [
                            ['vacancies', `Вакансии (${known.vacancies_list.length})`],
                            ['answers', 'Анкета'],
                            ['feedback', 'Обратная связь'],
                        ] as const
                    ).map(([id, label]) => (
                        <div
                            key={id}
                            className={'gt-tab' + (viewTab === id ? ' gt-tab-active' : '')}
                            role="tab"
                            aria-selected={viewTab === id}
                            tabIndex={0}
                            onClick={() => setViewTab(id)}
                            onKeyDown={(event) => event.key === 'Enter' && setViewTab(id)}
                        >
                            <span>{label}</span>
                        </div>
                    ))}
                </div>
                <div className={'gt-panel' + (viewTab === 'feedback' ? ' pf-panel' : ' gt-scroll')}>
                    {viewTab === 'vacancies' ? (
                        <>
                            {!known.approved && (
                                <p className="pv-notice">
                                    Вакансии ещё не утверждены: это черновик, который сформировала анкета. Нажмите «Править
                                    вакансии», укажите вилки и утвердите.
                                </p>
                            )}
                            {questions.length > 0 && (
                                <div className="gt-group" style={{ marginTop: 6 }}>
                                    <span className="gt-group-label">Открытые вопросы</span>
                                    <ul className="gt-facts">
                                        {questions.map((q) => (
                                            <li key={q.text}>
                                                {q.blocking && <span className="gt-badge gt-badge-bad">блокирует</span>}
                                                {q.text}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {engine && known.vacancies_list.map((vacancy, i) => <VacancyCard key={vacancy.id ?? i} engine={engine} vacancy={vacancy} />)}
                            {!known.vacancies_list.length && <p style={{ marginTop: 10 }}>Вакансий нет.</p>}
                        </>
                    ) : viewTab === 'feedback' ? (
                        userId && <ProjectFeedback userId={userId} projectId={known.id} onChanged={() => {
                            refreshList(); props.onAlertsChange();
                        }} />
                    ) : (
                        renderAnswers(known)
                    )}
                </div>
                <div className="gt-footer">
                    <p className="gt-status">{notice || (completed ? 'Набор завершён: чтобы править вакансии, возобновите набор.' : '')}</p>
                    <button
                        className="site-button gt-default"
                        disabled={completed}
                        onClick={() => {
                            setNotice('');
                            setStage('editor');
                        }}
                    >
                        Править вакансии
                    </button>
                    <button className="site-button" onClick={() => askCopy(known, 'view')}>
                        Копировать…
                    </button>
                    {known.approved && (
                        <button className="site-button" onClick={() => toggleCompleted(known, 'view')}>
                            {completed ? 'Возобновить набор' : 'Набор завершён'}
                        </button>
                    )}
                    <button
                        className="site-button"
                        onClick={() => {
                            setNotice('');
                            setSelected(known.id);
                            setStage('list');
                        }}
                    >
                        К списку
                    </button>
                </div>
            </>
        );
    };

    const renderStage = () => {
        switch (stage) {
            case 'loading':
                return renderWaiting('Загружаем проекты…');
            case 'busy':
                return renderWaiting(busyText);
            case 'error':
                return renderError();
            case 'list':
                return renderList();
            case 'card':
                return renderCard();
            case 'questionnaire':
                return (
                    engine && (
                        <ProjectQuestionnaire
                            engine={engine}
                            answers={answers}
                            onAnswers={setAnswers}
                            projectName={card.name.trim()}
                            companyName={companyName()}
                            image={props.image}
                            showDialog={showDialog}
                            closeDialog={closeDialog}
                            onCancel={cancelQuestionnaire}
                            onDone={saveProject}
                        />
                    )
                );
            case 'editor':
                return (
                    engine &&
                    project && (
                        <VacancyEditor
                            key={project.id + project.updated_at}
                            engine={engine}
                            project={project}
                            image={props.image}
                            showDialog={showDialog}
                            closeDialog={closeDialog}
                            onCancel={() => setStage('view')}
                            onApprove={approve}
                        />
                    )
                );
            case 'view':
                return project && renderView(project);
        }
    };

    return (
        <Window
            top={20}
            left={48}
            width={size.width}
            height={size.height}
            windowTitle={props.title}
            windowBarImage={props.image}
            windowBarIcon="windowExplorerIcon"
            closeWindow={props.onClose}
            onInteract={props.onInteract}
            minimizeWindow={props.onMinimize}
            bottomLeftText={stage === 'view' || stage === 'editor' ? project?.name ?? '' : `Проектов: ${projects.length}`}
        >
            <div className="grade-tasks projects-vacancies">
                {renderStage()}
                {copyPrompt && !dialog && (
                    <DialogView dialog={copyDialog(copyPrompt)} onInput={(value) => setCopyPrompt({ ...copyPrompt, value })} />
                )}
                {dialog && <DialogView dialog={dialog} />}
            </div>
        </Window>
    );
};

export default ProjectsVacancies;
