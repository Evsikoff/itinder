import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Window from '../os/Window';
import { ApiError, currentUserId } from '../../api';
import {
    CandidateInvitation,
    CandidateInvitationsData,
    dismissCandidateInvitationsAlert,
    fetchCandidateInvitations,
    generateCandidateInvitations,
    markCandidateInvitationRead,
    respondToCandidateInvitation,
} from '../../candidateInvitations';
import { Dialog, DialogView, money, plural } from './projectWidgets';
import './GradeTasks.css';
import './ProjectsVacancies.css';
import './CandidateInvitations.css';

export interface CandidateInvitationsProps extends WindowAppProps {
    title: string;
    image?: string;
    onAlertsChange: () => void;
    minimized?: boolean; // окно свёрнуто на панель задач (Desktop)
}

type Direction = 'incoming' | 'outgoing';
type Drafts = { [invitationId: string]: string[] };
const INCOMING = 'От рекрутера кандидату';
const NO_USER = 'Не удалось узнать, кто вы. Войдите в ITinder и откройте окно снова.';
const MAX_ANSWER = 5000;
const ALERT_BATCH = 1000; // как MAX_ALERT_BATCH в app/tools/applicant_invitations.py

function directionOf(invitation: CandidateInvitation): Direction {
    return invitation.type === INCOMING ? 'incoming' : 'outgoing';
}

function statusLabel(data: CandidateInvitationsData | null, status: string, flow?: 'plain' | 'assignment'): string {
    if (status === 'read') return 'Просмотрено';
    return (flow && data?.flows[flow]?.[status]) || data?.flows.plain[status] || data?.flows.assignment[status] || status;
}

function dateTime(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? 'Дата не указана' : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' });
}

function errorMessage(failure: unknown, fallback: string): string {
    return failure instanceof ApiError ? failure.message : fallback;
}

// Стрелки и Home/End переключают вкладки; Tab выходит в содержимое панели.
function navigateTabs(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button[role="tab"]') ?? []);
    const current = tabs.indexOf(event.currentTarget);
    if (current < 0 || !tabs.length) return;
    event.preventDefault();
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[target].focus();
    tabs[target].click();
}

const CandidateInvitations: React.FC<CandidateInvitationsProps> = (props) => {
    const [userId] = useState(currentUserId);
    const [size] = useState(() => ({
        width: Math.max(650, Math.min(1160, window.innerWidth - 60)),
        height: Math.max(510, Math.min(850, window.innerHeight - 50)),
    }));
    const [data, setData] = useState<CandidateInvitationsData | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [pending, setPending] = useState(false);
    const [pendingText, setPendingText] = useState('Сохраняем изменение приглашения…');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [direction, setDirection] = useState<Direction>('incoming');
    const [activeStatus, setActiveStatus] = useState('sent');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [drafts, setDrafts] = useState<Drafts>({});
    const [readProblem, setReadProblem] = useState<string | null>(null);
    const [dialog, setDialog] = useState<Dialog | null>(null);
    const mounted = useRef(false);
    const actionInFlight = useRef(false);
    const loadInFlight = useRef<Promise<void> | null>(null);
    const pollingFailed = useRef(false);
    const dataRef = useRef(data);
    const selectionRef = useRef(selectedId);
    const alertsRef = useRef(props.onAlertsChange);
    // Вход в окно (открытие или возврат из свёрнутого): следующий загруженный список гасит «!» у значка.
    const entered = useRef(true);
    const minimizedRef = useRef(props.minimized);
    alertsRef.current = props.onAlertsChange;
    selectionRef.current = selectedId;

    // Гасит восклицательный знак для показанных версий; «Новое» у записей остаётся до их просмотра.
    // Новое приглашение или новый статус после показа снова включают знак.
    const dismissAlert = useCallback(async (shown: CandidateInvitation[]) => {
        const versions = shown.filter((item) => item.unseen).map((item) => ({ id: item.id, revision: item.revision }));
        if (!userId || !versions.length) return;
        try {
            for (let start = 0; start < versions.length; start += ALERT_BATCH) {
                await dismissCandidateInvitationsAlert(userId, versions.slice(start, start + ALERT_BATCH));
            }
        } catch {
            // Знак останется до следующего входа в окно; работе с приглашениями это не мешает.
        }
        alertsRef.current();
    }, [userId]);

    const installRecord = useCallback((record: CandidateInvitation) => {
        const current = dataRef.current;
        if (!current) return;
        const updated = { ...current, invitations: current.invitations.map((item) => item.id === record.id ? record : item) };
        dataRef.current = updated;
        setData(updated);
        if (selectionRef.current === record.id) setActiveStatus(record.status);
        alertsRef.current();
    }, []);

    const load = useCallback((background = false, duringAction = false): Promise<void> => {
        if (loadInFlight.current) return loadInFlight.current;
        if (actionInFlight.current && !duringAction) return Promise.resolve();
        if (!userId) {
            setLoading(false);
            setError(NO_USER);
            return Promise.resolve();
        }
        if (!background) setRefreshing(true);
        const work = (async () => {
            try {
                const next = await fetchCandidateInvitations(userId);
                if (!mounted.current) return;
                const previousSelected = dataRef.current?.invitations.find((item) => item.id === selectionRef.current);
                const nextSelected = next.invitations.find((item) => item.id === selectionRef.current);
                const oldNotifications = dataRef.current?.invitations.map((item) => `${item.id}:${item.revision}:${item.unseen}`).join('|');
                const newNotifications = next.invitations.map((item) => `${item.id}:${item.revision}:${item.unseen}`).join('|');
                dataRef.current = next;
                setData(next);
                setError('');
                pollingFailed.current = false;
                if (previousSelected && nextSelected && previousSelected.status !== nextSelected.status) {
                    setActiveStatus((current) => current === previousSelected.status ? nextSelected.status : current);
                }
                if (selectionRef.current && !nextSelected) setSelectedId(null);
                if (oldNotifications !== newNotifications) alertsRef.current();
                if (entered.current) {
                    entered.current = false;
                    dismissAlert(next.invitations);
                }
            } catch (failure) {
                if (!mounted.current) return;
                pollingFailed.current = true;
                setError(errorMessage(failure, 'Не удалось загрузить приглашения и отклики.'));
            } finally {
                if (mounted.current) {
                    setLoading(false);
                    setRefreshing(false);
                }
            }
        })();
        loadInFlight.current = work;
        work.finally(() => { loadInFlight.current = null; });
        return work;
    }, [userId, dismissAlert]);

    useEffect(() => {
        mounted.current = true;
        load();
        const interval = window.setInterval(() => {
            if (!pollingFailed.current && !document.hidden) load(true);
        }, 15000);
        return () => {
            mounted.current = false;
            window.clearInterval(interval);
        };
    }, [load]);

    useEffect(() => {
        const restored = minimizedRef.current && !props.minimized;
        minimizedRef.current = props.minimized;
        if (!restored) return;
        entered.current = true;
        load(true);
    }, [props.minimized, load]);

    const generate = async () => {
        if (!userId || actionInFlight.current || loading || refreshing || dialog) return;
        actionInFlight.current = true;
        setPendingText('Генерируем тестовые приглашения…');
        setPending(true);
        setError('');
        setNotice('');
        try {
            // Дождаться фонового списка, чтобы он не затёр созданные записи.
            if (loadInFlight.current) await loadInFlight.current;
            const result = await generateCandidateInvitations(userId);
            if (!mounted.current) return;
            setNotice(`Создано ${result.created_invitations} ${plural(result.created_invitations, 'тестовое приглашение', 'тестовых приглашения', 'тестовых приглашений')}.`);
            setPendingText('Обновляем список приглашений…');
            await load(false, true);
            if (mounted.current && pollingFailed.current) {
                setError((message) => 'Приглашения созданы, но список не удалось обновить. Нажмите «Обновить», чтобы увидеть их.' + (message ? ` ${message}` : ''));
                alertsRef.current();
            }
        } catch (failure) {
            if (mounted.current) setError(errorMessage(failure, 'Не удалось сгенерировать тестовые приглашения.'));
        } finally {
            actionInFlight.current = false;
            if (mounted.current) setPending(false);
        }
    };

    const readInvitation = async (record: CandidateInvitation) => {
        if (!userId || actionInFlight.current) return;
        const needsRead = record.unseen || (directionOf(record) === 'incoming' && record.flow === 'plain' && record.status === 'sent');
        if (!needsRead) {
            if (readProblem === record.id) {
                setReadProblem(null);
                setError('');
            }
            return;
        }
        actionInFlight.current = true;
        setPendingText('Сохраняем изменение приглашения…');
        setPending(true);
        setReadProblem(null);
        try {
            // Старый запрос списка не должен затереть результат отметки о просмотре.
            await loadInFlight.current;
            const latest = dataRef.current?.invitations.find((item) => item.id === record.id) ?? record;
            const result = await markCandidateInvitationRead(userId, latest.id, latest.revision);
            if (mounted.current) {
                installRecord(result);
                setError('');
                pollingFailed.current = false;
            }
        } catch (failure) {
            if (!mounted.current) return;
            setReadProblem(record.id);
            setError(errorMessage(failure, 'Не удалось отметить приглашение просмотренным.'));
            // После конфликта показываем актуальный статус, а введённые решения сохраняем.
            if (failure instanceof ApiError && failure.status === 409) {
                await load(false, true);
                if (mounted.current) setError('Статус приглашения изменился. Проверьте его и повторите просмотр.');
            }
        } finally {
            actionInFlight.current = false;
            if (mounted.current) setPending(false);
        }
    };

    const selectInvitation = (record: CandidateInvitation) => {
        if (pending) return;
        setSelectedId(record.id);
        selectionRef.current = record.id;
        setNotice('');
        setReadProblem(null);
        readInvitation(record);
    };

    const respond = async (record: CandidateInvitation, action: 'accept' | 'decline') => {
        if (!userId || actionInFlight.current) return;
        setDialog(null);
        actionInFlight.current = true;
        setPendingText('Сохраняем изменение приглашения…');
        setPending(true);
        setNotice('');
        setError('');
        try {
            await loadInFlight.current;
            const answers = action === 'accept' && record.vacancy.assignments.length
                ? record.vacancy.assignments.map((_, index) => (drafts[record.id]?.[index] ?? '').trim()) : undefined;
            // Ревизия именно того приглашения, которое кандидат подтверждает в диалоге.
            const result = await respondToCandidateInvitation(userId, record.id, action, record.revision, answers);
            if (!mounted.current) return;
            installRecord(result);
            setNotice(action === 'decline' ? 'Приглашение отклонено.' : answers ? 'Решения отправлены рекрутёру на проверку.' : 'Приглашение принято.');
            setDrafts((current) => {
                const next = { ...current };
                delete next[record.id];
                return next;
            });
        } catch (failure) {
            if (!mounted.current) return;
            const message = errorMessage(failure, 'Не удалось отправить ответ на приглашение.');
            await load(false, true);
            if (mounted.current) setError(message + (record.vacancy.assignments.length ? ' Введённые решения сохранены.' : ''));
        } finally {
            actionInFlight.current = false;
            if (mounted.current) setPending(false);
        }
    };

    const confirmResponse = (record: CandidateInvitation, action: 'accept' | 'decline') => {
        const hasTasks = record.vacancy.assignments.length > 0;
        setDialog({
            sign: 'question',
            title: action === 'decline' ? 'Отклонить приглашение?' : hasTasks ? 'Отправить решения?' : 'Принять приглашение?',
            text: action === 'decline' ? `Отклонить приглашение на вакансию «${record.vacancy.title}»?`
                : hasTasks ? 'Решения всех заданий будут сохранены в приглашении и отправлены рекрутёру на проверку.'
                    : `Принять приглашение на вакансию «${record.vacancy.title}»?`,
            buttons: [
                { text: action === 'decline' ? 'Отклонить' : hasTasks ? 'Отправить решения' : 'Принять', primary: true, onClick: () => respond(record, action) },
                { text: 'Отмена', onClick: () => setDialog(null) },
            ],
        });
    };

    const records = data?.invitations ?? [];
    const directionRecords = records.filter((item) => directionOf(item) === direction);
    const visible = directionRecords.filter((item) => item.status === activeStatus);
    const selected = records.find((item) => item.id === selectedId) ?? null;
    const statuses = useMemo(() => {
        if (!data) return [];
        const union = Array.from(new Set([...Object.keys(data.flows.plain), ...Object.keys(data.flows.assignment), ...data.invitations.map((item) => item.status)]));
        return union.map((id) => ({ id, label: direction === 'incoming' && id === 'sent' ? 'Получено' : statusLabel(data, id), taskOnly: !(id in data.flows.plain) && id in data.flows.assignment }));
    }, [data, direction]);

    const switchDirection = (next: Direction) => {
        setDirection(next);
        setSelectedId(null);
        setReadProblem(null);
        setNotice('');
    };

    const switchStatus = (next: string) => {
        setActiveStatus(next);
        setSelectedId(null);
        setReadProblem(null);
        setNotice('');
    };

    const renderDetail = (record: CandidateInvitation) => {
        const vacancy = record.vacancy;
        const incoming = directionOf(record) === 'incoming';
        const tasks = vacancy.assignments ?? [];
        const actionable = incoming && record.can_respond && ['sent', 'read'].includes(record.status);
        const blocked = pending || refreshing || !!dialog || readProblem === record.id;
        const answers = tasks.map((_, index) => drafts[record.id]?.[index] ?? '');
        const answersComplete = answers.every((answer) => answer.trim().length > 0 && answer.length <= MAX_ANSWER);
        const salary = vacancy.salary;
        const currency = salary?.currency && salary.currency !== 'RUB' ? salary.currency : '';
        const pay = currency
            ? `${salary?.from ?? '—'} — ${salary?.to ?? '—'} ${currency}`
            : `${money(salary?.from)} — ${money(salary?.to)}`;
        return (
            <section className="ci-detail gt-column" aria-label="Карточка приглашения">
                <div className="ci-detail-heading gt-column">
                    <h2>{vacancy.title || 'Вакансия без названия'}</h2>
                    <p>{vacancy.company?.name || 'Компания не указана'}{vacancy.project?.name ? ` · ${vacancy.project.name}` : ''}</p>
                    <span className={`ci-status ci-status-${record.status}`}>{statusLabel(data, record.status, record.flow)}</span>
                    <p className="gt-muted ci-small">{incoming ? 'Приглашение от рекрутёра' : 'Отклик рекрутёру'} · {dateTime(record.created_at)}</p>
                    {record.recruiter_name && <p className="ci-small"><b>Рекрутёр:</b> {record.recruiter_name}</p>}
                </div>
                {record.unseen && !pending && <div className="ci-new-notice">
                    <span>Есть новое приглашение или изменение статуса.</span>
                    <button className="site-button" onClick={() => readInvitation(record)} disabled={blocked}>Отметить просмотренным</button>
                </div>}
                {readProblem === record.id && <div className="ci-read-error" role="alert">
                    <p>Просмотр не подтверждён сервером. Повторите его перед ответом.</p>
                    <button className="site-button" disabled={pending || refreshing} onClick={() => readInvitation(record)}>Повторить просмотр</button>
                </div>}
                <dl className="ci-facts">
                    <dt>Специализация и грейд</dt><dd>{vacancy.specialization} · {vacancy.grade}</dd>
                    {vacancy.position_name && <><dt>Позиция</dt><dd>{vacancy.position_name}</dd></>}
                    <dt>Зарплатная вилка</dt><dd>{pay}</dd>
                    <dt>Задания</dt><dd>{tasks.length ? `${tasks.length} ${plural(tasks.length, 'задание', 'задания', 'заданий')}` : 'Без заданий'}</dd>
                </dl>
                {vacancy.project?.summary && <div className="ci-section"><h3>О проекте</h3><p className="ci-pre">{vacancy.project.summary}</p></div>}
                {vacancy.task && <div className="ci-section"><h3>Чем предстоит заниматься</h3><p className="ci-pre">{vacancy.task}</p></div>}
                <div className="ci-section">
                    <h3>Требования к стеку</h3>
                    {(vacancy.requirements ?? []).length ? <ul className="ci-requirements">{vacancy.requirements.map((row, index) => (
                        <li key={index}>
                            <b>{row.ids.map((id) => data?.stack[row.kind]?.[id] ?? id).join(row.match === 'any' ? ' или ' : ' и ')}</b>
                            {' · '}{data?.kind_names[row.kind] ?? row.kind}{' · '}{row.importance === 'plus' ? 'Будет плюсом' : 'Обязательно'}
                            {' · '}{data?.degree_names[String(row.min_degree)] ?? `степень ${row.min_degree}`}
                        </li>
                    ))}</ul> : <p className="gt-muted">Не указаны.</p>}
                </div>
                {vacancy.notes && <div className="ci-section"><h3>Дополнительная информация</h3><p className="ci-pre">{vacancy.notes}</p></div>}
                {tasks.length > 0 && <div className="ci-section">
                    <h3>Задания</h3>
                    {actionable && <p className="ci-small">Чтобы принять приглашение, заполните решение каждого задания. Рекрутёр проверит ваши ответы.</p>}
                    {tasks.map((task, index) => <div className="ci-assignment" key={index}>
                        <h4>Задание {index + 1}</h4><p className="ci-pre">{task}</p>
                        {actionable ? <label className="gt-column ci-answer">
                            <span>Решение задания {index + 1}</span>
                            <textarea
                                aria-label={`Решение задания ${index + 1}`}
                                rows={5}
                                required
                                maxLength={MAX_ANSWER}
                                value={answers[index]}
                                disabled={blocked}
                                onChange={(event) => {
                                    const value = event.target.value;
                                    setDrafts((current) => {
                                        const nextAnswers = tasks.map((_, taskIndex) => current[record.id]?.[taskIndex] ?? '');
                                        nextAnswers[index] = value;
                                        return { ...current, [record.id]: nextAnswers };
                                    });
                                }}
                            />
                            <span className="gt-muted ci-small">{answers[index].length} / {MAX_ANSWER}</span>
                        </label> : record.assignment_answers?.[index] && <div className="ci-solution">
                            <h4>Отправленное решение</h4><p className="ci-pre">{record.assignment_answers[index]}</p>
                        </div>}
                    </div>)}
                </div>}
                <div className="ci-section">
                    <h3>История статусов</h3>
                    <ol className="ci-history">{record.status_history.map((entry, index) => <li key={`${entry.at}:${index}`}>
                        <span>{statusLabel(data, entry.status, record.flow)}</span><time dateTime={entry.at}>{dateTime(entry.at)}</time>
                    </li>)}</ol>
                    <p className="gt-muted ci-small">Статусы этого {tasks.length ? 'приглашения с заданиями' : 'приглашения без заданий'}: {Object.keys(data?.flows[record.flow] ?? {}).map((status) => statusLabel(data, status, record.flow)).join(' · ')}.</p>
                </div>
                {!incoming && <p className="ci-readonly">Здесь можно просматривать статус своего отклика и его историю.</p>}
                {actionable && <div className="ci-actions">
                    <p className="gt-muted ci-small">{tasks.length ? 'Для отправки нужны решения всех заданий.' : 'Вы можете принять или отклонить приглашение.'}</p>
                    <div>
                        <button className="site-button" disabled={blocked} onClick={() => confirmResponse(record, 'decline')}>Отклонить</button>
                        <button className="site-button gt-default" disabled={blocked || (tasks.length > 0 && !answersComplete)} onClick={() => confirmResponse(record, 'accept')}>{tasks.length ? 'Отправить решения' : 'Принять'}</button>
                    </div>
                </div>}
            </section>
        );
    };

    return (
        <Window top={24} left={50} width={size.width} height={size.height} windowTitle={props.title}
            windowBarImage={props.image} windowBarIcon="windowExplorerIcon" closeWindow={props.onClose}
            onInteract={props.onInteract} minimizeWindow={props.onMinimize}
            bottomLeftText={`Приглашения: ${records.filter((item) => directionOf(item) === 'incoming').length} · Отклики: ${records.filter((item) => directionOf(item) === 'outgoing').length}`}>
            <div className="grade-tasks projects-vacancies candidate-invitations">
                <header className="ci-toolbar">
                    <div className="gt-column"><h1>Приглашения и отклики</h1><p className="gt-muted ci-small">Предложения рекрутёров и статус ваших откликов</p></div>
                    <div className="ci-toolbar-actions">
                        <button className="site-button" disabled={loading || refreshing || pending || !!dialog || !userId} onClick={generate}>Сгенерировать тестовые приглашения</button>
                        <button className="site-button" disabled={loading || refreshing || pending || !!dialog || !userId} onClick={() => load()}>Обновить</button>
                    </div>
                </header>
                {error && <div className="ci-error" role="alert"><p>{error}</p>{userId && <button className="site-button" disabled={pending || refreshing} onClick={() => load()}>Повторить</button>}</div>}
                {notice && <p className="ci-notice" role="status">{notice}</p>}
                {(loading || refreshing || pending) && <p className="ci-loading" role="status">{pending ? pendingText : loading ? 'Загружаем приглашения и отклики…' : 'Обновляем список…'}</p>}
                {data && <>
                    <div className="ci-direction-tabs gt-tabs" role="tablist" aria-label="Направление приглашений">
                        {(['incoming', 'outgoing'] as Direction[]).map((item) => <button key={item} role="tab" id={`ci-direction-${item}`}
                            aria-selected={direction === item} aria-controls="ci-direction-panel" tabIndex={direction === item ? 0 : -1}
                            className={`gt-tab${direction === item ? ' gt-tab-active' : ''}`} disabled={pending || !!dialog}
                            onKeyDown={navigateTabs} onClick={() => switchDirection(item)}>
                            {item === 'incoming' ? 'Приглашения' : 'Отклики'} ({records.filter((record) => directionOf(record) === item).length})
                        </button>)}
                    </div>
                    <div className="gt-panel ci-main-panel" role="tabpanel" id="ci-direction-panel" aria-labelledby={`ci-direction-${direction}`}>
                        <div className="ci-status-tabs" role="tablist" aria-label="Статусы приглашений">
                            {statuses.map((status) => <button key={status.id} role="tab" id={`ci-status-${status.id}`}
                                aria-label={`${status.label} (${directionRecords.filter((record) => record.status === status.id).length})`}
                                aria-selected={activeStatus === status.id} aria-controls="ci-status-panel" tabIndex={activeStatus === status.id ? 0 : -1}
                                className={`ci-status-tab${activeStatus === status.id ? ' ci-status-tab-active' : ''}`}
                                title={status.taskOnly ? 'Статус приглашений с заданиями' : undefined} disabled={pending || !!dialog}
                                onKeyDown={navigateTabs} onClick={() => switchStatus(status.id)}>
                                {status.label} ({directionRecords.filter((record) => record.status === status.id).length})
                            </button>)}
                        </div>
                        <div className="ci-content" role="tabpanel" id="ci-status-panel" aria-labelledby={`ci-status-${activeStatus}`}>
                            <aside className="ci-list gt-field" aria-label={direction === 'incoming' ? 'Список приглашений' : 'Список откликов'}>
                                {visible.length ? visible.map((record) => <button key={record.id} className={`ci-list-item${selectedId === record.id ? ' ci-list-item-selected' : ''}`}
                                    aria-pressed={selectedId === record.id} disabled={pending || !!dialog} onClick={() => selectInvitation(record)}>
                                    <span className="ci-list-title">{record.vacancy.title || 'Вакансия без названия'}</span>
                                    <span>{record.vacancy.company?.name || 'Компания не указана'}</span>
                                    <span className="ci-small">{record.vacancy.grade} · {record.vacancy.assignments.length ? `${record.vacancy.assignments.length} ${plural(record.vacancy.assignments.length, 'задание', 'задания', 'заданий')}` : 'Без заданий'}</span>
                                    <span className="ci-small">{dateTime(record.created_at)}</span>
                                    {record.unseen && <span className="ci-unseen">Новое</span>}
                                </button>) : <p className="ci-list-empty">{direction === 'incoming' ? 'В этом статусе пока нет приглашений.' : 'В этом статусе пока нет откликов.'}</p>}
                            </aside>
                            <div className="ci-detail-area gt-field">{selected ? renderDetail(selected) : <div className="ci-empty gt-column">
                                <h2>{visible.length ? 'Выберите запись в списке' : direction === 'incoming' ? 'Приглашений в этом статусе нет' : 'Откликов в этом статусе нет'}</h2>
                                <p>{visible.length ? 'Здесь появятся вакансия, задания и история статусов.' : 'Выберите другую вкладку статуса. Новые записи появятся после обновления списка.'}</p>
                                <p className="gt-muted ci-small">{direction === 'incoming' ? 'Приглашения в статусах «Отправлено» и «Просмотрено» можно принять или отклонить.' : 'Отклики — ваши исходящие приглашения рекрутёрам. Здесь отображается их статус.'}</p>
                            </div>}</div>
                        </div>
                    </div>
                </>}
                {dialog && <DialogView dialog={dialog} />}
            </div>
        </Window>
    );
};

export default CandidateInvitations;
