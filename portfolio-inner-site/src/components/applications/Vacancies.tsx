import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Window from '../os/Window';
import { ApiError, currentUserId } from '../../api';
import { applyToVacancy, fetchVacancies, OwnRecord, RankedVacancy, StrengthItem, VacanciesData } from '../../vacancies';
import { markPresentationSeen, presentationSeen, VACANCIES_PRESENTATION } from '../../presentation';
import { SignIcon } from './GradeTasks';
import Presentation from './Presentation';
import { degreeName, gradeDetails, Meter, Relevance, RequirementsTable, StatusBadge, stackName } from './ApplicantViews';
import { Choice, Dialog, DialogView, money, plural, vacanciesWord } from './projectWidgets';
import './GradeTasks.css';
import './FspAchievements.css';
import './ProjectsVacancies.css';
import './Applicants.css';
import './Vacancies.css';

// «Вакансии» — окно значка id 3 на рабочем столе соискателя. При первом запуске —
// презентация о ранжировании (app/assets/presentation/vacancies/slides.json), потом
// список открытых вакансий его специализаций по релевантности для него и карточка
// выбранной: почему она на этом месте (подхожу, подходит, очередь), чего не хватает,
// требования и сильные стороны, проект и задания. «Откликнуться…» отправляет отклик —
// приглашение с типом «От кандидата рекрутеру»: оно попадает во вкладку «Отклики»
// окна «Приглашения» (значок 4) и к рекрутёру. Задания вакансии решаются в отклике.
// Сервер — app/tools/vacancy_search.py, ранжирование — app/tools/vacancy_ranking.py.

export interface VacanciesProps extends WindowAppProps {
    title: string;
    image?: string;
    onAlertsChange: () => void;
}

type Sort = 'relevance' | 'salary' | 'queue';

interface Filters {
    specialization: string; // '' — все свои
    grade: string; // '' — любой
    open: boolean; // только те, где ещё нет отклика или приглашения
    text: string; // название, компания, проект или технология
}

// Окно отклика: вакансия и решения её заданий.
interface ApplyForm {
    vacancy: RankedVacancy;
    answers: string[];
}

const NO_USER = 'Не удалось узнать, кто вы. Войдите в ITinder и откройте окно снова.';
const OUTGOING = 'От кандидата рекрутеру';
const MAX_ANSWER = 5000; // как app/tools/applicant_invitations.py
const WORK_FORMATS: { [id: string]: string } = { office: 'офис', hybrid: 'гибрид', remote: 'удалённо' };
const DURATIONS: { [id: string]: string } = { lt3: 'до 3 месяцев', '3to6': '3–6 месяцев', '6to12': '6–12 месяцев', gt12: 'больше года' };
const STAGES: { [id: string]: string } = {
    new: 'новый, разработка с нуля',
    mvp: 'прототип или MVP',
    active: 'действующий, нужно усиление',
    support: 'действующий, на поддержке',
    rewrite: 'переписывание старой системы',
};
const SORTS: { [sort in Sort]: string } = { relevance: 'по релевантности', salary: 'по зарплате', queue: 'по очереди' };

function errorOf(failure: unknown, fallback: string): { message: string; status: number } {
    return {
        message: failure instanceof ApiError ? failure.message : fallback,
        status: failure instanceof ApiError ? failure.status : 500,
    };
}

const percent = (share: number) => `${Math.round(share * 100)} %`;
const tasksWord = (count: number) => plural(count, 'задание', 'задания', 'заданий');

function salaryText(vacancy: RankedVacancy): string {
    const salary = vacancy.salary;
    if (!salary) return 'вилка не указана';
    if (salary.currency && salary.currency !== 'RUB') return `${salary.from ?? '—'} — ${salary.to ?? '—'} ${salary.currency}`;
    return `${money(salary.from)} — ${money(salary.to)}`;
}

// Уровень вакансии относительно своего грейда.
function growthText(vacancy: RankedVacancy): string {
    const { own, step } = vacancy.appeal.growth;
    if (!own || step === null) return 'свой грейд не подтверждён — считаем серединой';
    if (step === 0) return `ваша ступень, ${own}`;
    if (step === 1) return `на ступень выше вашего ${own} — рост`;
    if (step === -1) return `на ступень ниже вашего ${own} — шаг назад`;
    return step > 0 ? `через ступень выше вашего ${own}` : `через ступень ниже вашего ${own}`;
}

function strengthsText(vacancy: RankedVacancy): string {
    const strengths = vacancy.appeal.strengths;
    if (strengths.basis === 'unknown') return 'профиль не связан с ФСП — считаем серединой';
    if (strengths.basis === 'free') return 'у вакансии нет требований к стеку — считаем серединой';
    return 'какая доля ваших сильных компетенций нужна вакансии';
}

function recordText(record: OwnRecord): string {
    return record.type === OUTGOING
        ? 'Ваш отклик. Статус меняет рекрутёр — следите во вкладке «Отклики» окна «Приглашения».'
        : 'Рекрутёр уже пригласил вас на эту вакансию — ответьте в окне «Приглашения».';
}

const Vacancies: React.FC<VacanciesProps> = (props) => {
    const [userId] = useState(currentUserId);
    const [size] = useState(() => ({
        width: Math.max(760, Math.min(1180, window.innerWidth - 60)),
        height: Math.max(540, Math.min(840, window.innerHeight - 50)),
    }));
    const [presenting, setPresenting] = useState(() => !presentationSeen(VACANCIES_PRESENTATION, userId));
    const [presentationPauses, setPresentationPauses] = useState(0);
    const [data, setData] = useState<VacanciesData | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<{ message: string; retry: boolean }>({ message: '', retry: false });
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [filters, setFilters] = useState<Filters>({ specialization: '', grade: '', open: false, text: '' });
    const [sort, setSort] = useState<Sort>('relevance');
    const [form, setForm] = useState<ApplyForm | null>(null);
    const [sending, setSending] = useState(false);
    const [dialog, setDialog] = useState<Dialog | null>(null);
    const detail = useRef<HTMLDivElement>(null);

    // Отметка ставится, как только презентация открылась: «при первом запуске».
    useEffect(() => {
        if (presenting) markPresentationSeen(VACANCIES_PRESENTATION, userId);
    }, [presenting, userId]);

    // Свёрнутое окно не должно говорить: презентацию — на паузу.
    const minimize = () => {
        if (presenting) setPresentationPauses((count) => count + 1);
        props.onMinimize();
    };

    const closeDialog = useCallback(() => setDialog(null), []);

    const load = useCallback(
        async (background = false) => {
            if (!userId) {
                setError({ message: NO_USER, retry: false });
                setLoading(false);
                return;
            }
            if (background) setRefreshing(true);
            else setLoading(true);
            try {
                const next = await fetchVacancies(userId);
                setData(next);
                setError({ message: '', retry: false });
                setSelectedId((current) =>
                    current && next.vacancies.some((v) => v.id === current) ? current : next.vacancies[0]?.id ?? null
                );
            } catch (failure) {
                const { message, status } = errorOf(failure, 'Не удалось загрузить вакансии');
                // Обновление списка, который уже на экране: список остаётся, ошибка — сообщением.
                if (background) {
                    setDialog({ sign: 'error', title: 'Список не обновлён', text: message, buttons: [{ text: 'OK', primary: true, onClick: closeDialog }] });
                } else {
                    setError({ message, retry: status === 0 || status >= 500 });
                }
            } finally {
                setLoading(false);
                setRefreshing(false);
            }
        },
        [userId, closeDialog]
    );

    useEffect(() => {
        load();
    }, [load]);

    // --- Список --------------------------------------------------------------------

    const visible = useMemo(() => {
        if (!data) return [];
        const text = filters.text.trim().toLowerCase();
        const shown = data.vacancies.filter((vacancy) => {
            if (filters.specialization && vacancy.specialization !== filters.specialization) return false;
            if (filters.grade && vacancy.grade !== filters.grade) return false;
            if (filters.open && !vacancy.can_apply) return false;
            if (!text) return true;
            const words = [
                vacancy.title,
                vacancy.company?.name ?? '',
                vacancy.project.name,
                ...vacancy.requirements.flatMap((row) => row.ids.map((id) => stackName(data, row.kind, id))),
            ];
            return words.some((word) => word.toLowerCase().includes(text));
        });
        const bySort: { [key in Sort]: (a: RankedVacancy, b: RankedVacancy) => number } = {
            relevance: (a, b) => a.rank - b.rank,
            salary: (a, b) => (b.salary?.to ?? 0) - (a.salary?.to ?? 0) || a.rank - b.rank,
            queue: (a, b) => b.queue.score - a.queue.score || a.queue.place - b.queue.place || a.rank - b.rank,
        };
        return [...shown].sort(bySort[sort]);
    }, [data, filters, sort]);

    const selected = visible.find((v) => v.id === selectedId) ?? null;

    const select = (id: string) => {
        setSelectedId(id);
        detail.current?.scrollTo?.({ top: 0 });
    };

    // Стрелки листают список, как в списках Windows.
    const onListKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const index = visible.findIndex((v) => v.id === selectedId);
        const next = visible[Math.min(visible.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))];
        if (next) select(next.id);
    };

    // --- Отклик ----------------------------------------------------------------------

    const openForm = (vacancy: RankedVacancy) => setForm({ vacancy, answers: vacancy.assignments.map(() => '') });

    const submit = async () => {
        if (!userId || !form) return;
        const { vacancy, answers } = form;
        setSending(true);
        try {
            const result = await applyToVacancy(userId, vacancy.id, vacancy.assignments.length ? answers : undefined);
            const record: OwnRecord = {
                id: result.id,
                type: result.type,
                flow: result.flow,
                status: result.status,
                status_history: result.status_history,
                created_at: result.created_at,
            };
            setData((current) =>
                current && {
                    ...current,
                    vacancies: current.vacancies.map((v) => (v.id === vacancy.id ? { ...v, record, can_apply: false } : v)),
                }
            );
            setForm(null);
            setDialog({
                sign: 'ok',
                title: 'Отклик отправлен',
                text: `Рекрутёр получил отклик на вакансию «${vacancy.title}»${
                    vacancy.assignments.length ? ' вместе с решениями заданий' : ''
                }. Статус — во вкладке «Отклики» окна «Приглашения».`,
                buttons: [{ text: 'OK', primary: true, onClick: closeDialog }],
            });
            props.onAlertsChange();
        } catch (failure) {
            const { message, status } = errorOf(failure, 'Не удалось отправить отклик');
            setDialog({ sign: 'error', title: 'Отклик не отправлен', text: message, buttons: [{ text: 'OK', primary: true, onClick: closeDialog }] });
            if (status === 404 || status === 409) {
                setForm(null);
                load(true);
            }
        } finally {
            setSending(false);
        }
    };

    // --- Экраны ----------------------------------------------------------------------

    const renderHeader = () => (
        <div className="gt-header">
            {props.image && <img src={props.image} alt="" />}
            <div className="gt-column">
                <p className="gt-title">Вакансии для вас</p>
                <p className="gt-muted">
                    {data
                        ? `${data.specializations.join(', ')} · выше — где подходите вы и где подходит вам, и где меньше очередь`
                        : 'Открытые вакансии ваших специализаций'}
                </p>
            </div>
        </div>
    );

    const renderWaiting = () => (
        <div className="gt-center">
            <p className="gt-title">Подбираем вакансии…</p>
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
                    <button className="site-button gt-default" onClick={() => load()}>
                        Повторить
                    </button>
                )}
                <button className={'site-button' + (error.retry ? '' : ' gt-default')} onClick={props.onClose}>
                    Закрыть
                </button>
            </div>
        </>
    );

    const renderFilters = (known: VacanciesData) => (
        <div className="gt-group ap-filters vc-filters">
            <span className="gt-group-label">Фильтры</span>
            <div className="gt-row ap-filter-row">
                {known.specializations.length > 1 && (
                    <label className="gt-row">
                        Специализация
                        <select
                            className="gt-select"
                            value={filters.specialization}
                            onChange={(event) => setFilters({ ...filters, specialization: event.target.value })}
                        >
                            <option value="">Все мои</option>
                            {known.specializations.map((s) => (
                                <option key={s} value={s}>
                                    {s}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
                <label className="gt-row">
                    Грейд
                    <select className="gt-select" value={filters.grade} onChange={(event) => setFilters({ ...filters, grade: event.target.value })}>
                        <option value="">Любой</option>
                        {known.grades.map((g) => (
                            <option key={g} value={g}>
                                {g}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="gt-row">
                    Порядок
                    <select className="gt-select" value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
                        {(Object.keys(SORTS) as Sort[]).map((key) => (
                            <option key={key} value={key}>
                                {SORTS[key]}
                            </option>
                        ))}
                    </select>
                </label>
                <Choice
                    type="check"
                    compact
                    checked={filters.open}
                    onToggle={() => setFilters({ ...filters, open: !filters.open })}
                    label="Ещё не откликался"
                />
                <input
                    className="pv-input ap-filter-text"
                    value={filters.text}
                    placeholder="Название, компания или технология"
                    aria-label="Название, компания или технология"
                    onChange={(event) => setFilters({ ...filters, text: event.target.value })}
                />
            </div>
        </div>
    );

    const renderRow = (vacancy: RankedVacancy) => {
        const active = vacancy.id === selectedId;
        return (
            <div
                key={vacancy.id}
                role="option"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                className={'gt-column vc-row' + (active ? ' vc-row-active' : '')}
                onClick={() => select(vacancy.id)}
            >
                <div className="gt-row vc-row-head">
                    <span className="ap-rank">{vacancy.rank}</span>
                    <Relevance value={vacancy.relevance} />
                    <b className="vc-row-title">{vacancy.title}</b>
                </div>
                <span className="ap-small vc-row-line">
                    {vacancy.company?.name ?? 'Компания не указана'} · {vacancy.project.name}
                </span>
                <div className="gt-row vc-row-line">
                    <span className="ap-small">{salaryText(vacancy)}</span>
                    {data && vacancy.record ? (
                        <StatusBadge overview={data} invitation={vacancy.record} />
                    ) : (
                        vacancy.assignments.length > 0 && (
                            <span className="ap-small gt-muted">
                                {vacancy.assignments.length} {tasksWord(vacancy.assignments.length)}
                            </span>
                        )
                    )}
                </div>
            </div>
        );
    };

    // Полоса 0…1 с числом — часть релевантности.
    const renderPart = (name: string, score: number, explanation: React.ReactNode) => (
        <div className="gt-row vc-part">
            <span className="vc-part-name">{name}</span>
            <span className="vc-part-bar" aria-hidden="true">
                <span className="ap-relevance-fill" style={{ width: `${Math.max(0, Math.min(1, score)) * 100}%` }} />
            </span>
            <b className="vc-part-score">{score.toFixed(2)}</b>
            <span className="ap-small vc-part-why">{explanation}</span>
        </div>
    );

    const gaps = (known: VacanciesData, vacancy: RankedVacancy): string[] => {
        const found: string[] = [];
        const grade = vacancy.fit.grade;
        if (!vacancy.fit.meets.grade) {
            found.push(
                `Грейд: нужен ${vacancy.grade}, ${grade.grade ? `у вас подтверждён ${grade.grade}` : 'ваш грейд не подтверждён'} — сдайте тест в «Задачах на грейд».`
            );
        }
        if (!vacancy.fit.linked) {
            found.push('Стек не подтверждён: свяжите профиль с ФСП в «Достижениях в ФСП».');
            return found;
        }
        (vacancy.fit.requirements ?? []).forEach((row) => {
            if (row.importance !== 'required' || row.meets) return;
            const names = row.ids.map((id) => stackName(known, row.kind, id)).join(row.match === 'any' ? ' или ' : ' и ');
            const best = row.items.reduce((a, b) => (b.score > a.score ? b : a), row.items[0]);
            const have =
                best?.relation === 'exact'
                    ? `у вас «${degreeName(known, best.degree)}», нужна «${degreeName(known, row.min_degree)}»`
                    : best?.relation && best.via
                    ? `есть только близкая — ${stackName(known, row.kind, best.via)}`
                    : 'в профиле ФСП нет';
            found.push(`${names}: ${have}.`);
        });
        return found;
    };

    const renderStrength = (known: VacanciesData, item: StrengthItem) => {
        const name = stackName(known, item.kind, item.id);
        const via = item.via && item.relation !== 'exact' ? stackName(known, item.kind, item.via) : '';
        const note = !item.relation
            ? 'вакансии не нужна'
            : item.relation === 'exact'
            ? item.importance === 'plus'
                ? 'в желательных требованиях'
                : 'в обязательных требованиях'
            : `закрывает «${via}» как ${item.relation === 'adjacent' ? 'близкая' : 'того же рода'}`;
        return (
            <span
                key={`${item.kind}:${item.id}`}
                className={
                    'ap-chip' +
                    (item.relation === 'exact' ? ' vc-chip-used' : item.relation ? ' ap-chip-close' : ' vc-chip-idle') +
                    (item.importance === 'plus' ? ' ap-chip-plus' : '')
                }
                title={`${name}: ${degreeName(known, item.degree)}, вес ${item.weight.toFixed(2)} — ${note}, засчитано ${percent(item.share)}`}
            >
                <span className="ap-chip-name">{via ? `${name} ≈ ${via}` : name}</span>
                <Meter degree={item.degree} />
            </span>
        );
    };

    const renderDetail = (known: VacanciesData, vacancy: RankedVacancy) => {
        const weights = known.weights;
        const missing = gaps(known, vacancy);
        const strengths = vacancy.appeal.strengths;
        const facts = [
            vacancy.project.work_format && (WORK_FORMATS[vacancy.project.work_format] ?? vacancy.project.work_format),
            vacancy.project.city,
            vacancy.project.duration && `проект на ${DURATIONS[vacancy.project.duration] ?? vacancy.project.duration}`,
            vacancy.project.stage && (STAGES[vacancy.project.stage] ?? vacancy.project.stage),
        ].filter(Boolean);
        return (
            <>
                <div className="gt-column vc-detail-head">
                    <b className="vc-detail-title">{vacancy.title}</b>
                    <span className="gt-muted">
                        {vacancy.company?.name ?? 'Компания не указана'} · проект «{vacancy.project.name}»
                        {vacancy.recruiter_name ? ` · рекрутёр ${vacancy.recruiter_name}` : ''}
                    </span>
                    <div className="gt-row ap-reminder-facts vc-facts">
                        <span className="gt-badge ap-badge-spec">
                            {vacancy.specialization} · {vacancy.grade}
                        </span>
                        <span>{salaryText(vacancy)}</span>
                        <span>
                            свободных мест: {vacancy.seats} из {vacancy.count}
                        </span>
                        <span>{vacancy.assignments.length ? `${vacancy.assignments.length} ${tasksWord(vacancy.assignments.length)} в отклике` : 'без заданий'}</span>
                    </div>
                </div>
                <div className="gt-row vc-action">
                    <Relevance value={vacancy.relevance} wide />
                    <span className="ap-small vc-action-text">
                        {vacancy.record ? recordText(vacancy.record) : `Место ${vacancy.rank} из ${known.found} в вашем списке.`}
                    </span>
                    {vacancy.record ? (
                        <StatusBadge overview={known} invitation={vacancy.record} />
                    ) : (
                        <button className="site-button gt-default" disabled={!vacancy.can_apply || sending} onClick={() => openForm(vacancy)}>
                            Откликнуться…
                        </button>
                    )}
                </div>
                <div className="gt-group vc-why">
                    <span className="gt-group-label">Почему вакансия на этом месте</span>
                    {renderPart(
                        'Подхожу',
                        vacancy.fit.score,
                        <>
                            Так вас видит рекрутёр. Грейд {vacancy.fit.grade.score.toFixed(2)} × {percent(weights.fit.grade)}: {gradeDetails(vacancy.fit.grade)}.{' '}
                            {vacancy.fit.stack
                                ? `Стек ${vacancy.fit.stack.score.toFixed(2)} × ${percent(weights.fit.stack)}${
                                      vacancy.fit.stack.basis === 'profile' ? ' — по всему профилю ФСП: у вакансии нет требований' : ''
                                  }.`
                                : 'Стек не подтверждён ФСП — 0.'}
                        </>
                    )}
                    {renderPart(
                        'Подходит',
                        vacancy.appeal.score,
                        <>
                            Сильные стороны {strengths.score.toFixed(2)} × {percent(weights.appeal.stack)}: {strengthsText(vacancy)}. Уровень{' '}
                            {vacancy.appeal.growth.score.toFixed(2)} × {percent(weights.appeal.grade)}: {growthText(vacancy)}.
                        </>
                    )}
                    {renderPart(
                        'Очередь',
                        vacancy.queue.score,
                        <>
                            Вы {vacancy.queue.place}-й из {vacancy.queue.of} в списке рекрутёра,{' '}
                            {vacancy.queue.place <= vacancy.queue.seats
                                ? 'в пределах свободных мест'
                                : `впереди ${vacancy.queue.place - 1} — обходите ${vacancy.queue.of - vacancy.queue.place}`}
                            .
                        </>
                    )}
                    <p className="ap-small vc-formula">
                        Релевантность {vacancy.relevance.toFixed(1)} = 100 × √(подхожу {vacancy.fit.score.toFixed(2)} × подходит{' '}
                        {vacancy.appeal.score.toFixed(2)}) × ({(1 - weights.queue).toFixed(1)} + {weights.queue.toFixed(1)} × очередь{' '}
                        {vacancy.queue.score.toFixed(2)})
                    </p>
                </div>
                <div className="gt-group">
                    <span className="gt-group-label">Чего не хватает</span>
                    {missing.length ? (
                        <ul className="gt-facts vc-gaps">
                            {missing.map((line) => (
                                <li key={line}>{line}</li>
                            ))}
                        </ul>
                    ) : (
                        <p className="ap-small">
                            <span className="vc-ok">✓</span> Грейд и все обязательные требования выполнены.
                        </p>
                    )}
                </div>
                <div className="gt-group">
                    <span className="gt-group-label">Требования вакансии и ваш стек</span>
                    {vacancy.fit.requirements && vacancy.fit.requirements.length ? (
                        <RequirementsTable overview={known} candidate={vacancy.fit} />
                    ) : vacancy.requirements.length ? (
                        <ul className="gt-facts vc-gaps">
                            {vacancy.requirements.map((row) => (
                                <li key={`${row.kind}:${row.ids.join(',')}`}>
                                    {row.ids.map((id) => stackName(known, row.kind, id)).join(row.match === 'any' ? ' или ' : ' и ')} ·{' '}
                                    {row.importance === 'required' ? 'обязательно' : 'плюс'}, нужна «{degreeName(known, row.min_degree)}»
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="ap-small gt-muted">Требований к стеку нет — его выберет команда.</p>
                    )}
                </div>
                <div className="gt-group">
                    <span className="gt-group-label">Ваши сильные стороны в деле</span>
                    {strengths.basis === 'unknown' ? (
                        <p className="ap-small gt-muted">Профиль не связан с ФСП — свяжите его в «Достижениях в ФСП», и здесь появятся ваши подтверждённые компетенции.</p>
                    ) : strengths.items.length ? (
                        <>
                            <div className="ap-chips">{strengths.items.map((item) => renderStrength(known, item))}</div>
                            <p className="ap-small gt-muted vc-legend">
                                Сильные первыми, каждая следующая весит на 30 % меньше. <span className="vc-key vc-chip-used" /> нужна вакансии{' '}
                                <span className="vc-key ap-chip-close" /> закрывает близкую <span className="vc-key vc-chip-idle" /> не нужна
                            </p>
                        </>
                    ) : (
                        <p className="ap-small gt-muted">В профиле ФСП нет компетенций, которые проверяются у этой роли.</p>
                    )}
                </div>
                <div className="gt-group">
                    <span className="gt-group-label">Проект и задача</span>
                    {vacancy.project.summary && <p className="ap-small pv-pre">{vacancy.project.summary}</p>}
                    {facts.length > 0 && <p className="ap-small gt-muted">{facts.join(' · ')}</p>}
                    {vacancy.task && (
                        <p className="ap-small pv-pre">
                            <b>Чем заниматься:</b> {vacancy.task}
                        </p>
                    )}
                    {vacancy.notes && <p className="ap-small pv-pre gt-muted">{vacancy.notes}</p>}
                    {vacancy.assignments.length > 0 && (
                        <>
                            <p className="ap-small">
                                <b>Задания</b> — решения прикладываются к отклику:
                            </p>
                            <ol className="vc-assignments">
                                {vacancy.assignments.map((task, index) => (
                                    <li key={index} className="ap-small pv-pre">
                                        {task}
                                    </li>
                                ))}
                            </ol>
                        </>
                    )}
                </div>
            </>
        );
    };

    const renderList = (known: VacanciesData) => (
        <>
            {renderHeader()}
            {!known.fsp_linked && (
                <div className="gt-row vc-notice" role="status">
                    <SignIcon sign="info" />
                    <p className="ap-small">
                        Профиль не связан с ФСП: стек не с чем сравнить, рекрутёр видит вас в списке «стек не подтверждён». Свяжите профиль
                        в «Достижениях в ФСП» — релевантность посчитается точнее.
                    </p>
                </div>
            )}
            {known.found > 0 && renderFilters(known)}
            {known.found === 0 ? (
                <div className="gt-center gt-field vc-empty">
                    <p className="gt-title">Открытых вакансий {known.specializations.join(', ')} пока нет</p>
                    <p className="gt-muted">
                        Они появятся, когда рекрутёры утвердят вакансии в «Проектах и вакансиях». Закрытые наймом и вакансии с завершённым
                        набором не показываются.
                    </p>
                </div>
            ) : (
                <div className="gt-row gt-grow vc-content">
                    <div className="gt-column gt-field gt-scroll vc-list" role="listbox" aria-label="Вакансии" tabIndex={0} onKeyDown={onListKey}>
                        {visible.length ? visible.map(renderRow) : <p className="ap-small vc-list-empty">Под фильтры ничего не подходит.</p>}
                    </div>
                    <div className="gt-column gt-field gt-scroll vc-detail" ref={detail} aria-label="Карточка вакансии">
                        {selected ? (
                            renderDetail(known, selected)
                        ) : (
                            <div className="gt-center">
                                <p className="gt-muted">Выберите вакансию в списке.</p>
                            </div>
                        )}
                    </div>
                </div>
            )}
            <div className="gt-footer">
                <p className="gt-status">
                    {refreshing
                        ? 'Обновляем список…'
                        : `Показано ${visible.length} из ${known.found} ${vacanciesWord(known.found)} · ↑↓ — выбор`}
                </p>
                <button className="site-button" onClick={() => setPresenting(true)}>
                    Как считается
                </button>
                <button className="site-button" disabled={refreshing} onClick={() => load(true)}>
                    Обновить
                </button>
                <button className="site-button" onClick={props.onClose}>
                    Закрыть
                </button>
            </div>
        </>
    );

    const renderForm = (current: ApplyForm) => {
        const { vacancy, answers } = current;
        const complete = answers.every((answer) => answer.trim().length > 0 && answer.length <= MAX_ANSWER);
        return (
            <div className="gt-modal">
                <div className="gt-dialog pv-dialog vc-apply" role="alertdialog" aria-modal="true" aria-label="Отклик на вакансию">
                    <div className="gt-dialog-title">
                        <span>Отклик на вакансию</span>
                    </div>
                    <div className="gt-dialog-body">
                        <SignIcon sign="question" />
                        <div className="gt-column vc-apply-body">
                            <p>
                                «{vacancy.title}» · {vacancy.company?.name ?? 'компания не указана'}, проект «{vacancy.project.name}». Рекрутёр
                                увидит ваш профиль и релевантность {Math.round(vacancy.fit.score * 100)} из 100. Отозвать отклик нельзя.
                            </p>
                            {vacancy.assignments.length > 0 && (
                                <div className="gt-column gt-scroll vc-apply-tasks">
                                    <p className="ap-small">
                                        У вакансии {vacancy.assignments.length} {tasksWord(vacancy.assignments.length)}: решения уходят вместе с откликом, и
                                        он сразу попадает на проверку.
                                    </p>
                                    {vacancy.assignments.map((task, index) => (
                                        <label className="gt-column vc-answer" key={index}>
                                            <span className="ap-small">
                                                <b>Задание {index + 1}.</b> {task}
                                            </span>
                                            <textarea
                                                className="gt-textarea"
                                                aria-label={`Решение задания ${index + 1}`}
                                                rows={4}
                                                maxLength={MAX_ANSWER}
                                                value={answers[index]}
                                                disabled={sending}
                                                onChange={(event) => {
                                                    const next = [...answers];
                                                    next[index] = event.target.value;
                                                    setForm({ ...current, answers: next });
                                                }}
                                            />
                                            <span className="ap-small gt-muted">
                                                {answers[index].length} / {MAX_ANSWER}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="gt-dialog-buttons">
                        <button className="site-button gt-default" disabled={sending || !complete} onClick={submit}>
                            {sending ? 'Отправляем…' : 'Отправить отклик'}
                        </button>
                        <button className="site-button" disabled={sending} onClick={() => setForm(null)}>
                            Отмена
                        </button>
                    </div>
                </div>
            </div>
        );
    };

    const renderStage = () => {
        if (loading) return renderWaiting();
        if (error.message || !data) return renderError();
        return renderList(data);
    };

    return (
        <Window
            top={30}
            left={64}
            width={size.width}
            height={size.height}
            windowTitle={props.title}
            windowBarImage={props.image}
            windowBarIcon="windowExplorerIcon"
            closeWindow={props.onClose}
            onInteract={props.onInteract}
            minimizeWindow={minimize}
            bottomLeftText={presenting ? 'Презентация' : data ? `Вакансий: ${data.found}` : ''}
        >
            <div className="grade-tasks projects-vacancies applicants vacancies">
                {presenting ? (
                    <Presentation source={VACANCIES_PRESENTATION} onClose={() => setPresenting(false)} pauseRequest={presentationPauses} />
                ) : (
                    renderStage()
                )}
                {form && !dialog && renderForm(form)}
                {dialog && <DialogView dialog={dialog} />}
            </div>
        </Window>
    );
};

export default Vacancies;
