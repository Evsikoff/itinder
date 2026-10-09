import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Window from '../os/Window';
import { ApiError, currentUserId } from '../../api';
import {
    Candidate,
    fetchOverview,
    fetchSearch,
    fetchTeam,
    fetchVacancyRanking,
    generateTestProjects,
    Invitation,
    InvitationSource,
    Overview,
    SearchRanking,
    sendInvitation,
    Team,
    VacancyRanking,
    VacancyView,
} from '../../applicants';
import { APPLICANTS_PRESENTATION, markPresentationSeen, presentationSeen } from '../../presentation';
import { SignIcon } from './GradeTasks';
import Presentation from './Presentation';
import TeamGraph from './TeamGraph';
import CandidateProfile from './CandidateProfile';
import {
    candidateName,
    CompetencyChips,
    degreeName,
    FspMark,
    gradeDetails,
    gradeLine,
    InviteControl,
    Relevance,
    RequirementsTable,
    StatusBadge,
    stackName,
} from './ApplicantViews';
import { applicantsWord, Choice, Dialog, DialogView, money, plural, vacanciesWord } from './projectWidgets';
import './GradeTasks.css';
import './FspAchievements.css';
import './ProjectsVacancies.css';
import './Applicants.css';

// «Соискатели» — окно значка id 9 на рабочем столе рекрутёра. При первом запуске —
// презентация о ранжировании (app/assets/presentation/applicants/slides.json),
// потом меню из четырёх кнопок:
//   «Найти команду для проекта» — выбор проекта, граф: к каждой открытой вакансии
//       два самых релевантных кандидата (TeamGraph.tsx);
//   «Найти сотрудника по вакансии» — выбор вакансии, подробный список кандидатов
//       с разбором требований, вверху — напоминание о вакансии;
//   «Найти сотрудника по специализации и грейду» — сразу все кандидаты, фильтры сверху;
//   «Воспроизвести презентацию заново».
// Приглашение отправляется после подтверждения; уже отправленное показывает статус.
// Сервер — app/tools/applicant_search.py, ранжирование — app/tools/ranking.py.
//   loading — обзор грузится; error — не загрузился; menu — меню; pick_project,
//   pick_vacancy — выбор; team, vacancy, search — экраны поиска; busy — ждём сервер.
type Stage = 'loading' | 'error' | 'menu' | 'pick_project' | 'team' | 'pick_vacancy' | 'vacancy' | 'search' | 'busy';

export interface ApplicantsProps extends WindowAppProps {
    title: string;
    image?: string;
    onAlertsChange: () => void;
}

interface Filters {
    specialization: string; // '' — все
    grade: string; // '' — любой
    fsp: 'all' | 'linked' | 'unconfirmed';
    tested: boolean; // только с грейдом, подтверждённым тестом
    text: string; // имя или компетенция
}

// Окно выбора вакансии для приглашения из общего поиска.
interface InvitePicker {
    candidate: Candidate;
    vacancyId: string;
}

const NO_USER = 'Не удалось узнать, кто вы. Войдите в ITinder и откройте окно снова.';
const PAGE = 20; // сколько кандидатов показывать за раз
const NO_PROJECTS =
    'Нет проектов, в которых можно искать: вакансии должны быть утверждены, а набор — не завершён. Заведите проект в «Проектах и вакансиях».';
const NO_VACANCIES =
    'Нет открытых вакансий: утверждённых, без нерешённых блокирующих вопросов, с незавершённым набором и не закрытых принятыми приглашениями.';

function errorOf(failure: unknown, fallback: string): { message: string; status: number } {
    return {
        message: failure instanceof ApiError ? failure.message : fallback,
        status: failure instanceof ApiError ? failure.status : 500,
    };
}

const percent = (share: number) => `${Math.round(share * 100)} %`;

const Applicants: React.FC<ApplicantsProps> = (props) => {
    const [userId] = useState(currentUserId);
    const [size] = useState(() => ({
        width: Math.max(760, Math.min(1180, window.innerWidth - 60)),
        height: Math.max(540, Math.min(840, window.innerHeight - 50)),
    }));
    const [presenting, setPresenting] = useState(() => !presentationSeen(APPLICANTS_PRESENTATION, userId));
    const [presentationPauses, setPresentationPauses] = useState(0);
    const [stage, setStage] = useState<Stage>('loading');
    const [busyText, setBusyText] = useState('');
    const [error, setError] = useState<{ message: string; retry: (() => void) | null }>({ message: '', retry: null });
    const [overview, setOverview] = useState<Overview | null>(null);
    const [projectId, setProjectId] = useState<string | null>(null);
    const [vacancyId, setVacancyId] = useState<string | null>(null);
    const [team, setTeam] = useState<Team | null>(null);
    const [ranking, setRanking] = useState<VacancyRanking | null>(null);
    const [search, setSearch] = useState<SearchRanking | null>(null);
    const [filters, setFilters] = useState<Filters>({ specialization: '', grade: '', fsp: 'all', tested: false, text: '' });
    const [shown, setShown] = useState({ linked: PAGE, unconfirmed: 0 });
    const [expanded, setExpanded] = useState<string | null>(null); // строка поиска: user_id:специализация
    const [sending, setSending] = useState<{ [key: string]: boolean }>({});
    const [dialog, setDialog] = useState<Dialog | null>(null);
    const [picker, setPicker] = useState<InvitePicker | null>(null);
    const [searching, setSearching] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [generationMessage, setGenerationMessage] = useState('');
    const [profileId, setProfileId] = useState<string | null>(null);

    // Отметка ставится, как только презентация открылась: «при первом запуске».
    useEffect(() => {
        if (presenting) markPresentationSeen(APPLICANTS_PRESENTATION, userId);
    }, [presenting, userId]);

    // Свёрнутое окно не должно говорить: презентацию — на паузу.
    const minimize = () => {
        if (presenting) setPresentationPauses((count) => count + 1);
        props.onMinimize();
    };

    const closeDialog = useCallback(() => setDialog(null), []);

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
        setStage('loading');
        if (!userId) {
            setError({ message: NO_USER, retry: null });
            setStage('error');
            return;
        }
        try {
            setOverview(await fetchOverview(userId));
            setStage('menu');
        } catch (failure) {
            const { message, status } = errorOf(failure, 'Не удалось загрузить соискателей');
            setError({ message, retry: status === 0 || status >= 500 ? () => load() : null });
            setStage('error');
        }
    }, [userId]);

    useEffect(() => {
        load();
    }, [load]);

    // Обзор после приглашения: счётчики приглашений и закрытые вакансии.
    const refreshOverview = () => {
        if (userId) fetchOverview(userId).then(setOverview).catch(() => {});
    };

    const projects = overview?.projects ?? [];
    const openVacancies = useMemo(
        () => (overview?.projects ?? []).flatMap((p) => p.vacancies.filter((v) => v.open)),
        [overview]
    );

    // --- Переходы ----------------------------------------------------------------

    const openTeam = async (id: string) => {
        if (!userId) return;
        setProjectId(id);
        busy('Подбираем команду…');
        try {
            setTeam(await fetchTeam(userId, id));
            setStage('team');
        } catch (failure) {
            complain(failure, 'Не удалось подобрать команду', 'pick_project');
        }
    };

    const openVacancy = async (id: string) => {
        if (!userId) return;
        setVacancyId(id);
        busy('Ранжируем соискателей…');
        try {
            setRanking(await fetchVacancyRanking(userId, id));
            setShown({ linked: PAGE, unconfirmed: 0 });
            setStage('vacancy');
        } catch (failure) {
            complain(failure, 'Не удалось найти соискателей', 'pick_vacancy');
        }
    };

    const runSearch = useCallback(
        async (specialization: string, grade: string, first: boolean) => {
            if (!userId) return;
            if (first) busy('Ранжируем соискателей…');
            else setSearching(true);
            try {
                setSearch(await fetchSearch(userId, specialization, grade));
                setShown({ linked: PAGE, unconfirmed: 0 });
                setExpanded(null);
                setStage('search');
            } catch (failure) {
                complain(failure, 'Не удалось найти соискателей', first ? 'menu' : 'search');
            } finally {
                setSearching(false);
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [userId]
    );

    const startSearch = () => runSearch(filters.specialization, filters.grade, true);

    const generateProjects = async () => {
        if (!userId || generating) return;
        setGenerating(true);
        setGenerationMessage('');
        try {
            const result = await generateTestProjects(userId);
            setOverview(await fetchOverview(userId));
            setGenerationMessage(
                result.created_projects
                    ? `Создано ${result.created_projects} ${plural(result.created_projects, 'тестовый проект', 'тестовых проекта', 'тестовых проектов')} и ${result.created_vacancies} ${vacanciesWord(result.created_vacancies)}. Теперь можно приглашать соискателей.`
                    : 'Тестовые проекты и вакансии готовы. Теперь можно приглашать соискателей.'
            );
        } catch (failure) {
            setDialog({
                sign: 'error',
                title: 'Не удалось подготовить тестовые проекты',
                text: errorOf(failure, 'Не удалось сгенерировать тестовые проекты и вакансии').message,
                buttons: [{ text: 'OK', primary: true, onClick: closeDialog }],
            });
        } finally {
            setGenerating(false);
        }
    };

    const changeQuery = (next: Filters) => {
        const changed = next.specialization !== filters.specialization || next.grade !== filters.grade;
        setFilters(next);
        if (changed) runSearch(next.specialization, next.grade, false);
    };

    // --- Приглашения ---------------------------------------------------------------

    // Новое приглашение — во все экраны, где этот кандидат виден.
    const remember = (invitation: Invitation) => {
        const apply = (candidate: Candidate): Candidate => {
            if (candidate.user_id !== invitation.applicant_id) return candidate;
            return {
                ...candidate,
                invitation: candidate.invitation !== undefined ? invitation : candidate.invitation,
                invitations: candidate.invitations ? [...candidate.invitations, invitation] : candidate.invitations,
            };
        };
        setTeam((current) =>
            current && {
                ...current,
                vacancies: current.vacancies.map((v) =>
                    v.id === invitation.vacancy_id ? { ...v, candidates: v.candidates.map(apply) } : v
                ),
            }
        );
        setRanking((current) =>
            current && current.vacancy.id === invitation.vacancy_id
                ? { ...current, candidates: current.candidates.map(apply), unconfirmed: current.unconfirmed.map(apply) }
                : current
        );
        setSearch((current) =>
            current && { ...current, candidates: current.candidates.map(apply), unconfirmed: current.unconfirmed.map(apply) }
        );
    };

    const send = async (vacancy: VacancyView, candidate: Candidate, source: InvitationSource) => {
        if (!userId) return;
        const key = `${vacancy.id}:${candidate.user_id}`;
        setSending((current) => ({ ...current, [key]: true }));
        try {
            remember(await sendInvitation(userId, vacancy.id, candidate.user_id, source));
            refreshOverview();
        } catch (failure) {
            setDialog({
                sign: 'error',
                title: 'Приглашение не отправлено',
                text: errorOf(failure, 'Не удалось отправить приглашение').message,
                buttons: [{ text: 'OK', primary: true, onClick: () => setDialog(null) }],
            });
            refreshOverview();
        } finally {
            setSending((current) => ({ ...current, [key]: false }));
        }
    };

    const confirmInvite = (vacancy: VacancyView, candidate: Candidate, source: InvitationSource) => {
        const tasks = vacancy.assignments.length;
        setDialog({
            sign: 'question',
            title: 'Отправить приглашение',
            text: `Кому: ${candidateName(candidate)}. Вакансия «${vacancy.title}», проект «${vacancy.project_name}». ${
                tasks
                    ? `Вместе с вакансией соискатель получит ${tasks} ${plural(tasks, 'задание', 'задания', 'заданий')}.`
                    : 'Заданий у вакансии нет.'
            } Отозвать приглашение нельзя.`,
            buttons: [
                {
                    text: 'Отправить',
                    primary: true,
                    onClick: () => {
                        setDialog(null);
                        send(vacancy, candidate, source);
                    },
                },
                { text: 'Отмена', onClick: closeDialog },
            ],
        });
    };

    // Открытые вакансии специализации кандидата, куда его ещё не звали, — для поиска.
    const invitableVacancies = (candidate: Candidate) => {
        const invited = new Set((candidate.invitations ?? []).map((i) => i.vacancy_id));
        return openVacancies.filter((v) => v.specialization === candidate.specialization && !invited.has(v.id));
    };

    const pickerReason = (candidate: Candidate): string | undefined => {
        if (!openVacancies.length) return NO_VACANCIES;
        if (!openVacancies.some((v) => v.specialization === candidate.specialization)) {
            return `Нет открытых вакансий ${candidate.specialization}`;
        }
        return invitableVacancies(candidate).length ? undefined : 'Уже приглашён на все открытые вакансии своей специализации';
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

    const toMenu = (
        <button className="site-button" onClick={() => setStage('menu')}>
            В меню
        </button>
    );

    const renderMenu = () => {
        const items: { title: string; hint: string; disabled?: string; onClick: () => void }[] = [
            {
                title: 'Найти команду для проекта',
                hint: 'Граф проекта: к каждой открытой вакансии — два самых релевантных кандидата, один человек — одно место.',
                disabled: projects.length ? undefined : NO_PROJECTS,
                onClick: () => {
                    setProjectId((current) => current ?? projects[0]?.id ?? null);
                    setStage('pick_project');
                },
            },
            {
                title: 'Найти сотрудника по вакансии',
                hint: 'Все кандидаты специализации вакансии по релевантности, с разбором каждого требования.',
                disabled: openVacancies.length ? undefined : NO_VACANCIES,
                onClick: () => {
                    setVacancyId((current) => (current && openVacancies.some((v) => v.id === current) ? current : openVacancies[0]?.id ?? null));
                    setStage('pick_vacancy');
                },
            },
            {
                title: 'Найти сотрудника по специализации и грейду',
                hint: 'Сразу все кандидаты: релевантность по грейду и всему профилю ФСП, фильтры сверху.',
                onClick: startSearch,
            },
            {
                title: 'Воспроизвести презентацию заново',
                hint: 'Как ITinder считает релевантность кандидатов и что хранит приглашение.',
                onClick: () => setPresenting(true),
            },
        ];
        return (
            <>
                {renderHeader('Соискатели', 'Кандидаты ITinder по релевантности: грейд подтверждён тестом, стек — соревнованиями ФСП.')}
                <div className="gt-column gt-scroll ap-menu">
                    {items.map((item, n) => (
                        <button
                            key={item.title}
                            className={'site-button ap-menu-button' + (n === 0 && !item.disabled ? ' gt-default' : '')}
                            disabled={!!item.disabled}
                            onClick={item.onClick}
                        >
                            <span className="ap-menu-number">{n + 1}</span>
                            <span className="gt-column ap-menu-text">
                                <b>{item.title}</b>
                                <span className={'ap-small' + (item.disabled ? '' : ' gt-muted')}>{item.disabled ?? item.hint}</span>
                            </span>
                        </button>
                    ))}
                    <div className="gt-column ap-test-projects" role="status" aria-busy={generating}>
                        <p className="ap-small">Можно создать тестовые проекты и вакансии для всех четырёх специализаций.</p>
                        <button className="site-button" disabled={generating} onClick={generateProjects}>
                            {generating ? 'Генерируем проекты и вакансии…' : 'Сгенерировать тестовые проекты и вакансии'}
                        </button>
                        {generationMessage && <p className="ap-small">{generationMessage}</p>}
                    </div>
                </div>
                <div className="gt-footer">
                    <p className="gt-status">
                        Проектов: {projects.length} · открытых вакансий: {openVacancies.length}
                    </p>
                    <button className="site-button" onClick={props.onClose}>
                        Закрыть
                    </button>
                </div>
            </>
        );
    };

    const renderPickProject = () => (
        <>
            {renderHeader('Найти команду для проекта', 'Выберите проект: граф покажет его открытые вакансии и кандидатов к ним.')}
            <div className="gt-column gt-field gt-grow ap-pick" role="listbox" aria-label="Проекты">
                {projects.map((project) => {
                    const open = project.vacancies.filter((v) => v.open).length;
                    return (
                        <div
                            key={project.id}
                            role="option"
                            aria-selected={project.id === projectId}
                            tabIndex={0}
                            className={'gt-row pv-list-row ap-pick-row' + (project.id === projectId ? ' pv-list-row-active' : '')}
                            onClick={() => setProjectId(project.id)}
                            onDoubleClick={() => openTeam(project.id)}
                            onKeyDown={(event) => event.key === 'Enter' && openTeam(project.id)}
                        >
                            <span className="ap-pick-name">{project.name}</span>
                            <span className="ap-pick-company">{project.company.name}</span>
                            <span className="ap-pick-count">
                                открытых {open} из {project.vacancies.length} {vacanciesWord(project.vacancies.length)}
                            </span>
                        </div>
                    );
                })}
            </div>
            <div className="gt-footer">
                <p className="gt-status">Двойной щелчок — построить граф.</p>
                <button className="site-button gt-default" disabled={!projectId} onClick={() => projectId && openTeam(projectId)}>
                    Построить команду
                </button>
                {toMenu}
            </div>
        </>
    );

    const renderTeam = (known: Team) => {
        const skipped = [
            known.skipped.draft ? `${known.skipped.draft} ${vacanciesWord(known.skipped.draft)} с нерешёнными вопросами` : '',
            known.skipped.closed ? `${known.skipped.closed} ${plural(known.skipped.closed, 'закрытая', 'закрытые', 'закрытых')}` : '',
        ].filter(Boolean);
        return (
            <>
                {renderHeader(`Команда для проекта «${known.project.name}»`, `${known.project.company.name} · к каждой открытой вакансии — два самых релевантных кандидата`)}
                {overview && (
                    <TeamGraph
                        team={known}
                        overview={overview}
                        sending={sending}
                        onInvite={(vacancy, candidate) => confirmInvite(vacancy, candidate, 'team')}
                        onProfile={candidate => setProfileId(candidate.user_id)}
                    />
                )}
                <div className="gt-footer">
                    <p className="gt-status ap-legend">
                        <span className="ap-legend-line ap-edge-offer" /> предложен
                        <span className="ap-legend-line ap-edge-invited" /> приглашён
                        <span className="ap-legend-line ap-edge-accepted" /> принял
                        {skipped.length > 0 && <span className="gt-muted"> · не показаны: {skipped.join(', ')}</span>}
                    </p>
                    <button className="site-button" onClick={() => openTeam(known.project.id)}>
                        Обновить
                    </button>
                    <button className="site-button" onClick={() => setStage('pick_project')}>
                        Другой проект
                    </button>
                    {toMenu}
                </div>
            </>
        );
    };

    const renderPickVacancy = () => (
        <>
            {renderHeader('Найти сотрудника по вакансии', 'Выберите открытую вакансию.')}
            <div className="gt-column gt-field gt-grow gt-scroll ap-pick" role="listbox" aria-label="Вакансии">
                {projects.map((project) => {
                    const open = project.vacancies.filter((v) => v.open);
                    if (!open.length) return null;
                    return (
                        <React.Fragment key={project.id}>
                            <div className="ap-pick-group">
                                {project.name} · {project.company.name}
                            </div>
                            {open.map((vacancy) => (
                                <div
                                    key={vacancy.id}
                                    role="option"
                                    aria-selected={vacancy.id === vacancyId}
                                    tabIndex={0}
                                    className={'gt-row pv-list-row ap-pick-row' + (vacancy.id === vacancyId ? ' pv-list-row-active' : '')}
                                    onClick={() => setVacancyId(vacancy.id)}
                                    onDoubleClick={() => openVacancy(vacancy.id)}
                                    onKeyDown={(event) => event.key === 'Enter' && openVacancy(vacancy.id)}
                                >
                                    <span className="ap-pick-name">{vacancy.title}</span>
                                    <span className="ap-pick-company">
                                        {vacancy.specialization} · {vacancy.grade} · нужно {vacancy.count}
                                    </span>
                                    <span className="ap-pick-count">
                                        {invitedTotal(vacancy) ? `приглашено ${invitedTotal(vacancy)}` : 'приглашений нет'}
                                    </span>
                                </div>
                            ))}
                        </React.Fragment>
                    );
                })}
            </div>
            <div className="gt-footer">
                <p className="gt-status">Двойной щелчок — искать.</p>
                <button className="site-button gt-default" disabled={!vacancyId} onClick={() => vacancyId && openVacancy(vacancyId)}>
                    Искать
                </button>
                {toMenu}
            </div>
        </>
    );

    const renderVacancyReminder = (vacancy: VacancyView) => (
        <div className="gt-group ap-reminder">
            <span className="gt-group-label">Ищем на вакансию</span>
            <div className="gt-row ap-reminder-head">
                <b>{vacancy.title}</b>
                <span className="gt-muted">
                    {' '}
                    · {vacancy.project_name}
                    {vacancy.company ? ` · ${vacancy.company.name}` : ''}
                </span>
            </div>
            <div className="gt-row ap-reminder-facts">
                <span className="gt-badge ap-badge-spec">
                    {vacancy.specialization} · {vacancy.grade}
                </span>
                <span>нужно: {vacancy.count}</span>
                {vacancy.salary && (
                    <span>
                        вилка: {money(vacancy.salary.from)} — {money(vacancy.salary.to)}
                    </span>
                )}
                <span>
                    {vacancy.assignments.length
                        ? `${vacancy.assignments.length} ${plural(vacancy.assignments.length, 'задание', 'задания', 'заданий')} в приглашении`
                        : 'без заданий'}
                </span>
            </div>
            {overview && vacancy.requirements.length > 0 && (
                <div className="ap-chips">
                    {vacancy.requirements.map((row) => (
                        <span
                            key={`${row.kind}:${row.ids.join(',')}`}
                            className={'ap-chip' + (row.importance === 'plus' ? ' ap-chip-plus' : '')}
                            title={`${overview.kind_names[row.kind] ?? row.kind} · ${row.importance === 'required' ? 'обязательно' : 'плюс'}`}
                        >
                            {row.ids.map((id) => stackName(overview, row.kind, id)).join(row.match === 'any' ? ' или ' : ' и ')}
                            {row.importance === 'plus' ? ' (плюс)' : ` · ${degreeName(overview, row.min_degree)}`}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );

    const renderDetail = (candidate: Candidate, vacancy: VacancyView) => {
        const weights = overview?.weights.vacancy;
        return (
            <div className={'ap-detail' + (candidate.invitation ? ' ap-card-invited' : '')} key={candidate.user_id}>
                <div className="gt-row ap-detail-head">
                    <span className="ap-rank">{candidate.rank}</span>
                    <Relevance value={candidate.relevance} wide />
                    <FspMark linked={candidate.fsp_linked} />
                    <div className="gt-column ap-detail-name">
                        <b>{candidateName(candidate)}</b>
                        <span className="gt-muted ap-small">{gradeLine(candidate.grade)}</span>
                    </div>
                    {overview && (
                        <InviteControl
                            overview={overview}
                            invitation={candidate.invitation}
                            sending={!!sending[`${vacancy.id}:${candidate.user_id}`]}
                            disabledReason={vacancy.open ? undefined : 'Вакансия закрыта'}
                            onInvite={() => confirmInvite(vacancy, candidate, 'vacancy')}
                        />
                    )}
                </div>
                <p className="ap-small ap-detail-why">
                    <b>Грейд</b> {candidate.grade.score.toFixed(2)}
                    {weights && ` × ${percent(weights.grade)}`}: {gradeDetails(candidate.grade)}.{' '}
                    {candidate.stack ? (
                        <>
                            <b>Стек</b> {candidate.stack.score.toFixed(2)}
                            {weights && ` × ${percent(weights.stack)}`}
                            {candidate.stack.basis === 'profile' && ' — по всему профилю ФСП: у вакансии нет требований'}
                            {candidate.profile && ` · профиль ФСП ${candidate.profile.score.toFixed(2)}`}
                            {candidate.fsp_points !== null && ` · баллов ФСП ${candidate.fsp_points}`}
                        </>
                    ) : (
                        'Стек не подтверждён: профиль не связан с ФСП.'
                    )}
                </p>
                <button className="site-button" onClick={() => setProfileId(candidate.user_id)}>Профиль кандидата</button>
                {overview && candidate.requirements && candidate.requirements.length > 0 && (
                    <RequirementsTable overview={overview} candidate={candidate} />
                )}
                {overview && candidate.stack?.basis === 'profile' && <CompetencyChips overview={overview} candidate={candidate} limit={8} />}
            </div>
        );
    };

    const renderVacancy = (known: VacancyRanking) => {
        const vacancy = known.vacancy;
        return (
            <>
                {renderVacancyReminder(vacancy)}
                <p className="ap-summary">
                    {known.found} {applicantsWord(known.found)} {vacancy.specialization}: со стеком, подтверждённым в ФСП, — {known.linked},
                    подходят по грейду и всем обязательным требованиям — {known.meet_all}.
                </p>
                <div className="gt-column gt-scroll gt-grow ap-list">
                    {known.candidates.slice(0, shown.linked).map((candidate) => renderDetail(candidate, vacancy))}
                    {known.candidates.length > shown.linked && (
                        <button className="site-button ap-more" onClick={() => setShown({ ...shown, linked: shown.linked + PAGE })}>
                            Показать ещё {Math.min(PAGE, known.candidates.length - shown.linked)}
                        </button>
                    )}
                    <div className="ap-list-group">
                        Без связки с ФСП — стек не подтверждён: {known.unconfirmed.length}
                        {shown.unconfirmed === 0 && known.unconfirmed.length > 0 && (
                            <button className="site-button ap-more-inline" onClick={() => setShown({ ...shown, unconfirmed: PAGE })}>
                                Показать
                            </button>
                        )}
                    </div>
                    {known.unconfirmed.slice(0, shown.unconfirmed).map((candidate) => renderDetail(candidate, vacancy))}
                    {shown.unconfirmed > 0 && known.unconfirmed.length > shown.unconfirmed && (
                        <button className="site-button ap-more" onClick={() => setShown({ ...shown, unconfirmed: shown.unconfirmed + PAGE })}>
                            Показать ещё {Math.min(PAGE, known.unconfirmed.length - shown.unconfirmed)}
                        </button>
                    )}
                </div>
                <div className="gt-footer">
                    <p className="gt-status">Наведите на статус приглашения — история его смены.</p>
                    <button className="site-button" onClick={() => setStage('pick_vacancy')}>
                        Другая вакансия
                    </button>
                    {toMenu}
                </div>
            </>
        );
    };

    // Строка общего поиска; щелчок раскрывает подробности.
    const renderRow = (candidate: Candidate) => {
        const key = `${candidate.user_id}:${candidate.specialization}`;
        const open = expanded === key;
        const reason = pickerReason(candidate);
        const invited = candidate.invitations ?? [];
        return (
            <div className={'ap-row' + (open ? ' ap-row-open' : '')} key={key}>
                <div
                    className="gt-row ap-row-head"
                    role="button"
                    tabIndex={0}
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : key)}
                    onKeyDown={(event) => event.key === 'Enter' && setExpanded(open ? null : key)}
                >
                    <span className="ap-rank">{candidate.rank}</span>
                    <Relevance value={candidate.relevance} />
                    <FspMark linked={candidate.fsp_linked} size={22} />
                    <span className="gt-column ap-row-name">
                        <b>{candidateName(candidate)}</b>
                        <span className="gt-muted ap-small">
                            {candidate.specialization} · {gradeLine(candidate.grade)}
                        </span>
                    </span>
                    <span className="ap-row-chips">{overview && <CompetencyChips overview={overview} candidate={candidate} limit={4} />}</span>
                    <span className="ap-row-invited">
                        {invited.length > 0 && <span className="gt-badge ap-status-sent">приглашён: {invited.length}</span>}
                    </span>
                    <button
                        className="site-button ap-invite"
                        disabled={!!reason}
                        title={reason}
                        onClick={(event) => {
                            event.stopPropagation();
                            const options = invitableVacancies(candidate);
                            if (options.length) setPicker({ candidate, vacancyId: options[0].id });
                        }}
                    >
                        Пригласить…
                    </button>
                </div>
                {open && overview && (
                    <div className="gt-column ap-row-body">
                        <p className="ap-small">
                            <b>Грейд</b> {candidate.grade.score.toFixed(2)}: {gradeDetails(candidate.grade)}.{' '}
                            {candidate.profile ? (
                                <>
                                    <b>Профиль ФСП</b> {candidate.profile.score.toFixed(2)}:{' '}
                                    {Object.entries(candidate.profile.kinds)
                                        .map(([kind, part]) => `${overview.kind_names[kind] ?? kind} ${part.score.toFixed(2)} (${part.count})`)
                                        .join(', ')}
                                    {candidate.fsp_points !== null && ` · баллов ФСП ${candidate.fsp_points}`}
                                </>
                            ) : (
                                'Профиль не связан с ФСП.'
                            )}
                        </p>
                        <CompetencyChips overview={overview} candidate={candidate} />
                        <button className="site-button" onClick={() => setProfileId(candidate.user_id)}>Профиль кандидата</button>
                        {invited.length > 0 && (
                            <div className="ap-chips">
                                {invited.map((invitation) => (
                                    <StatusBadge key={invitation.id} overview={overview} invitation={invitation} withTitle />
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    };

    const filtered = (list: Candidate[]) => {
        const text = filters.text.trim().toLowerCase();
        return list.filter((candidate) => {
            if (filters.tested && candidate.grade.basis !== 'test') return false;
            if (!text) return true;
            if (candidateName(candidate).toLowerCase().includes(text)) return true;
            return !!overview && candidate.competencies.some((c) => stackName(overview, c.kind, c.id).toLowerCase().includes(text));
        });
    };

    const renderSearch = (known: SearchRanking) => {
        const linked = filters.fsp === 'unconfirmed' ? [] : filtered(known.candidates);
        const unconfirmed = filters.fsp === 'linked' ? [] : filtered(known.unconfirmed);
        // Без связки с ФСП — свёрнуты, пока их не попросили; одни они — сразу видны.
        const unconfirmedShown = filters.fsp === 'unconfirmed' ? Math.max(shown.unconfirmed, PAGE) : shown.unconfirmed;
        const anyGrade = !filters.grade;
        return (
            <>
                {!openVacancies.length && (
                    <div className="gt-column ap-no-vacancies" role="status">
                        <p><b>У вас нет вакансий, на которые можно пригласить соискателя.</b></p>
                        <p className="gt-muted ap-small">{NO_VACANCIES}</p>
                        <p className="ap-small">Тестовые проекты и вакансии можно сгенерировать в стартовом меню приложения.</p>
                    </div>
                )}
                <div className="gt-group ap-filters">
                    <span className="gt-group-label">Фильтры</span>
                    <div className="gt-row ap-filter-row">
                        <label className="gt-row">
                            Специализация
                            <select
                                className="gt-select"
                                value={filters.specialization}
                                onChange={(event) => changeQuery({ ...filters, specialization: event.target.value })}
                            >
                                <option value="">Все</option>
                                {overview?.specializations.map((s) => (
                                    <option key={s} value={s}>
                                        {s}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className="gt-row">
                            Грейд
                            <select
                                className="gt-select"
                                value={filters.grade}
                                onChange={(event) => changeQuery({ ...filters, grade: event.target.value })}
                            >
                                <option value="">Любой</option>
                                {overview?.grades.map((g) => (
                                    <option key={g} value={g}>
                                        {g}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className="gt-row">
                            Стек
                            <select
                                className="gt-select"
                                value={filters.fsp}
                                onChange={(event) => setFilters({ ...filters, fsp: event.target.value as Filters['fsp'] })}
                            >
                                <option value="all">Любой</option>
                                <option value="linked">Подтверждён ФСП</option>
                                <option value="unconfirmed">Не подтверждён</option>
                            </select>
                        </label>
                        <Choice
                            type="check"
                            compact
                            checked={filters.tested}
                            onToggle={() => setFilters({ ...filters, tested: !filters.tested })}
                            label="Грейд подтверждён тестом"
                        />
                        <input
                            className="pv-input ap-filter-text"
                            value={filters.text}
                            placeholder="Имя или компетенция"
                            aria-label="Имя или компетенция"
                            onChange={(event) => setFilters({ ...filters, text: event.target.value })}
                        />
                    </div>
                </div>
                <p className="ap-summary">
                    {searching
                        ? 'Ранжируем заново…'
                        : `Найдено: ${linked.length + unconfirmed.length} из ${known.found}. ${
                              anyGrade
                                  ? 'Грейд любой: выше те, чей грейд подтверждён надёжнее.'
                                  : `Релевантность для ${filters.grade}: грейд × ${percent(known.weights.grade)} + профиль ФСП × ${percent(known.weights.stack)}.`
                          }`}
                </p>
                <div className={'gt-column gt-scroll gt-grow ap-list' + (searching ? ' ap-list-stale' : '')}>
                    {linked.slice(0, shown.linked).map(renderRow)}
                    {linked.length > shown.linked && (
                        <button className="site-button ap-more" onClick={() => setShown({ ...shown, linked: shown.linked + PAGE })}>
                            Показать ещё {Math.min(PAGE, linked.length - shown.linked)}
                        </button>
                    )}
                    {unconfirmed.length > 0 && (
                        <div className="ap-list-group">
                            Без связки с ФСП — стек не подтверждён: {unconfirmed.length}
                            {unconfirmedShown === 0 && (
                                <button className="site-button ap-more-inline" onClick={() => setShown({ ...shown, unconfirmed: PAGE })}>
                                    Показать
                                </button>
                            )}
                        </div>
                    )}
                    {unconfirmed.slice(0, unconfirmedShown).map(renderRow)}
                    {unconfirmedShown > 0 && unconfirmed.length > unconfirmedShown && (
                        <button
                            className="site-button ap-more"
                            onClick={() => setShown({ ...shown, unconfirmed: unconfirmedShown + PAGE })}
                        >
                            Показать ещё {Math.min(PAGE, unconfirmed.length - unconfirmedShown)}
                        </button>
                    )}
                    {!linked.length && !unconfirmed.length && <p className="ap-summary">Под фильтры никто не подходит.</p>}
                </div>
                <div className="gt-footer">
                    <p className="gt-status">Щелчок по строке — подробности.</p>
                    {toMenu}
                </div>
            </>
        );
    };

    const renderPicker = (current: InvitePicker) => {
        const options = invitableVacancies(current.candidate);
        const chosen = options.find((v) => v.id === current.vacancyId) ?? options[0];
        return (
            <div className="gt-modal">
                <div className="gt-dialog pv-dialog" role="alertdialog" aria-modal="true" aria-label="Пригласить на вакансию">
                    <div className="gt-dialog-title">
                        <span>Пригласить на вакансию</span>
                    </div>
                    <div className="gt-dialog-body">
                        <SignIcon sign="question" />
                        <div className="gt-column" style={{ marginLeft: 16, flex: 1, minWidth: 0 }}>
                            <p>
                                Кому: {candidateName(current.candidate)} ({current.candidate.specialization}). На какую вакансию
                                пригласить? Отозвать приглашение нельзя.
                            </p>
                            <select
                                className="gt-select"
                                style={{ marginTop: 10, width: '100%', minWidth: 0, maxWidth: '100%', boxSizing: 'border-box' }}
                                value={chosen?.id ?? ''}
                                autoFocus
                                aria-label="Вакансия"
                                onChange={(event) => setPicker({ ...current, vacancyId: event.target.value })}
                            >
                                {options.map((v) => (
                                    <option key={v.id} value={v.id}>
                                        {v.title} — {v.project_name} ·{' '}
                                        {v.assignments.length
                                            ? `с ${v.assignments.length === 1 ? 'заданием' : 'заданиями'} (${v.assignments.length})`
                                            : 'без заданий'}
                                    </option>
                                ))}
                            </select>
                            {chosen && (
                                <p className="gt-muted ap-small" style={{ marginTop: 6 }}>
                                    {chosen.grade} · нужно {chosen.count} ·{' '}
                                    {chosen.assignments.length
                                        ? `${chosen.assignments.length} ${plural(chosen.assignments.length, 'задание', 'задания', 'заданий')}`
                                        : 'без заданий'}
                                </p>
                            )}
                        </div>
                    </div>
                    <div className="gt-dialog-buttons">
                        <button
                            className="site-button gt-default"
                            disabled={!chosen}
                            onClick={() => {
                                setPicker(null);
                                if (chosen) send(chosen, current.candidate, 'search');
                            }}
                        >
                            Отправить
                        </button>
                        <button className="site-button" onClick={() => setPicker(null)}>
                            Отмена
                        </button>
                    </div>
                </div>
            </div>
        );
    };

    const renderStage = () => {
        switch (stage) {
            case 'loading':
                return renderWaiting('Загружаем проекты и вакансии…');
            case 'busy':
                return renderWaiting(busyText);
            case 'error':
                return renderError();
            case 'menu':
                return renderMenu();
            case 'pick_project':
                return renderPickProject();
            case 'team':
                return team && renderTeam(team);
            case 'pick_vacancy':
                return renderPickVacancy();
            case 'vacancy':
                return ranking && renderVacancy(ranking);
            case 'search':
                return search && renderSearch(search);
        }
    };

    const bottomText = presenting
        ? 'Презентация'
        : stage === 'team' && team
        ? team.project.name
        : stage === 'vacancy' && ranking
        ? ranking.vacancy.title
        : stage === 'search' && search
        ? `${search.query.specialization ?? 'Все специализации'} · ${search.query.grade ?? 'любой грейд'}`
        : '';

    return (
        <Window
            top={24}
            left={56}
            width={size.width}
            height={size.height}
            windowTitle={props.title}
            windowBarImage={props.image}
            windowBarIcon="windowExplorerIcon"
            closeWindow={props.onClose}
            onInteract={props.onInteract}
            minimizeWindow={minimize}
            bottomLeftText={bottomText}
        >
            <div className="grade-tasks projects-vacancies applicants">
                {presenting ? (
                    <Presentation
                        source={APPLICANTS_PRESENTATION}
                        onClose={() => setPresenting(false)}
                        pauseRequest={presentationPauses}
                    />
                ) : (
                    renderStage()
                )}
                {picker && !dialog && renderPicker(picker)}
                {dialog && <DialogView dialog={dialog} />}
                {profileId && userId && <CandidateProfile key={profileId} userId={userId} applicantId={profileId} onClose={() => setProfileId(null)} />}
            </div>
        </Window>
    );
};

function invitedTotal(vacancy: VacancyView): number {
    return Object.values(vacancy.invited).reduce((sum, count) => sum + count, 0);
}

export default Applicants;
