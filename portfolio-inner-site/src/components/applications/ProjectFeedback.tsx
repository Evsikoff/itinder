import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api';
import {
    closeFeedbackVacancy, FeedbackInvitation, fetchProjectFeedback, ProjectFeedbackData, respondToApplication, reviewProjectInvitation,
} from '../../projectFeedback';
import { Relevance } from './ApplicantViews';
import CandidateProfile from './CandidateProfile';
import { formatDate, peopleWord } from './projectWidgets';
import './ProjectFeedback.css';

const STATUS_NAMES: { [key: string]: string } = {
    sent: 'Отправлено', read: 'Просмотрено', accepted: 'Принято', declined: 'Отклонено',
    task_sent_for_review: 'Задание отправлено на проверку', task_needs_review: 'Задание требует проверки',
    solution_rejected: 'Решение отклонено',
};
const kindName = (entry: FeedbackInvitation) => entry.kind === 'application' ? 'Отклик' : 'Приглашение';
const candidateName = (entry: FeedbackInvitation) => entry.name || `Соискатель · ${entry.applicant_id.slice(0, 8)}`;
const badge = (entry: FeedbackInvitation) => entry.status === 'accepted' ? 'gt-badge-good'
    : ['declined', 'solution_rejected'].includes(entry.status) ? 'gt-badge-bad' : 'gt-badge-half';
const message = (failure: unknown) => failure instanceof ApiError ? failure.message : 'Не удалось загрузить обратную связь';

interface Props {
    userId: string;
    projectId: string;
    onChanged: () => void;
}

const ProjectFeedback: React.FC<Props> = ({ userId, projectId, onChanged }) => {
    const [data, setData] = useState<ProjectFeedbackData | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
    const [loading, setLoading] = useState(true);
    const [pending, setPending] = useState(false);
    const [problem, setProblem] = useState('');
    const [notice, setNotice] = useState('');
    const [expertFor, setExpertFor] = useState<string | null>(null);
    const [email, setEmail] = useState('');
    const [profileId, setProfileId] = useState<string | null>(null);
    const operation = useRef(false);
    const version = useRef(0);
    const mounted = useRef(true);
    const selectedNode = useRef<HTMLButtonElement>(null);

    const reload = useCallback(async () => {
        const requestVersion = ++version.current;
        try {
            const next = await fetchProjectFeedback(userId, projectId);
            if (!mounted.current || requestVersion !== version.current) return;
            setData(next);
            const all = next.vacancies.flatMap(vacancy => vacancy.invitations);
            setSelectedId(current => all.some(entry => entry.id === current) ? current
                : all.find(entry => entry.can_send_to_expert || entry.can_decide)?.id
                    ?? all.find(entry => entry.can_respond_application)?.id ?? all[0]?.id ?? null);
            setProblem('');
        } catch (failure) {
            if (mounted.current && requestVersion === version.current) setProblem(message(failure));
        } finally {
            if (mounted.current && requestVersion === version.current) setLoading(false);
        }
    }, [userId, projectId]);

    useEffect(() => {
        mounted.current = true;
        reload();
        const update = () => { if (!operation.current) reload(); };
        const timer = window.setInterval(update, 15000);
        window.addEventListener('focus', update);
        return () => {
            mounted.current = false;
            window.clearInterval(timer);
            window.removeEventListener('focus', update);
        };
    }, [reload]);

    useEffect(() => { selectedNode.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [loading, selectedId]);

    const act = async (request: () => Promise<unknown>, success: string) => {
        if (operation.current) return;
        operation.current = true;
        ++version.current; // старый опрос не должен перезаписать результат действия
        setPending(true);
        setProblem('');
        setNotice('');
        try {
            await request();
            if (!mounted.current) { onChanged(); return; }
            setExpertFor(null);
            setNotice(success);
            await reload();
            onChanged();
        } catch (failure) {
            if (!mounted.current) return;
            setProblem(message(failure));
            if (failure instanceof ApiError && failure.status === 409) {
                const text = message(failure);
                await reload();
                setProblem(text);
            }
        } finally {
            operation.current = false;
            if (mounted.current) setPending(false);
        }
    };

    const selected = data?.vacancies.flatMap(vacancy => vacancy.invitations).find(entry => entry.id === selectedId);
    const toggle = (id: string) => setCollapsed(current => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    return <div className="project-feedback">
        <div className="pf-toolbar">
            <p className="gt-muted pv-small">Вакансии и связанные приглашения и отклики. Релевантность — по грейду и требованиям вакансии.</p>
            <button className="site-button" disabled={pending || loading} onClick={reload}>Обновить</button>
        </div>
        {problem && <div className="pv-notice pf-error" role="alert">
            <p>{problem}</p><button className="site-button" disabled={pending} onClick={reload}>Повторить загрузку</button>
        </div>}
        {notice && <p className="pv-notice" role="status">{notice}</p>}
        {loading ? <p>Загружаем обратную связь…</p> : !data ? null : !data.vacancies.length ? <p>У проекта пока нет утверждённых вакансий.</p> :
            <div className="pf-content">
                <ul className="pf-tree gt-field" role="tree" aria-label="Обратная связь по вакансиям">
                    {data.vacancies.map(vacancy => <li key={vacancy.id} role="treeitem" aria-level={1}
                        aria-expanded={!collapsed.has(vacancy.id)} aria-label={`${vacancy.title} — требуется ${vacancy.count} ${peopleWord(vacancy.count)}`}>
                        <div className="pf-vacancy">
                            <button className="pf-vacancy-toggle" onClick={() => toggle(vacancy.id)}>
                                <span aria-hidden="true">{collapsed.has(vacancy.id) ? '▸' : '▾'}</span>
                                <span><b>{vacancy.title}</b><span className="pf-vacancy-count">Требуется: {vacancy.count} {peopleWord(vacancy.count)} · Принято: {vacancy.accepted}</span></span>
                            </button>
                            {vacancy.closed_at ? <span className="gt-badge gt-badge-good">Закрыта наймом</span> : vacancy.can_close &&
                                <button className="site-button" disabled={pending} onClick={() => act(
                                    () => closeFeedbackVacancy(userId, projectId, vacancy.id), `Вакансия «${vacancy.title}» закрыта наймом.`
                                )}>Закрыть вакансию</button>}
                        </div>
                        {!collapsed.has(vacancy.id) && <ul role="group" className="pf-branches">
                            {vacancy.invitations.length ? vacancy.invitations.map(entry => <li key={entry.id} role="none">
                                <button role="treeitem" aria-level={2} aria-selected={selectedId === entry.id}
                                    ref={selectedId === entry.id ? selectedNode : null}
                                    className={`pf-invitation${selectedId === entry.id ? ' pf-selected' : ''}`} disabled={pending}
                                    onClick={() => { setSelectedId(entry.id); setExpertFor(null); setEmail(''); }}>
                                    <b>{candidateName(entry)}</b>
                                    <span>{kindName(entry)} <span className={`gt-badge ${badge(entry)}`}>{entry.status_name}</span></span>
                                    <span className="pf-score">Релевантность: {entry.relevance === null ? 'нет данных' : <Relevance value={entry.relevance} />}</span>
                                    {entry.status === 'accepted' && entry.email && <span className="pf-email">{entry.email}</span>}
                                </button>
                            </li>) : <li role="none" className="gt-muted pf-no-invitations">Приглашений и откликов пока нет.</li>}
                        </ul>}
                    </li>)}
                </ul>
                <section className="pf-detail gt-field" aria-label="Карточка приглашения">
                    {selected ? <>
                        <h2>{candidateName(selected)}</h2>
                        <button className="site-button" disabled={pending} onClick={() => setProfileId(selected.applicant_id)}>Профиль кандидата</button>
                        <p>{kindName(selected)} · <span className={`gt-badge ${badge(selected)}`}>{selected.status_name}</span></p>
                        <p className="pf-score">Релевантность: {selected.relevance === null ? 'нет данных' : <Relevance value={selected.relevance} wide />}</p>
                        {selected.status === 'accepted' && <p className="pf-email"><b>E-mail: </b>{selected.email || 'Не найден'}</p>}
                        {selected.kind === 'application' && selected.can_respond_application && <div className="pf-buttons">
                            <button className="site-button" disabled={pending} onClick={() => act(
                                () => respondToApplication(userId, projectId, selected, 'accept'), 'Отклик принят.'
                            )}>Принять отклик</button>
                            <button className="site-button" disabled={pending} onClick={() => act(
                                () => respondToApplication(userId, projectId, selected, 'decline'), 'Отклик отклонён.'
                            )}>Отклонить отклик</button>
                        </div>}
                        {selected.assignments.map((task, index) => <div key={index} className="pf-assignment">
                            <h3>Задание {index + 1}</h3><p className="pf-pre">{task}</p>
                            <h3>Решение кандидата</h3><p className="pf-pre">{selected.assignment_answers[index] || 'Решение ещё не отправлено.'}</p>
                        </div>)}
                        {selected.can_send_to_expert && (expertFor === selected.id ? <form className="pf-expert-form" onSubmit={event => {
                            event.preventDefault();
                            act(() => reviewProjectInvitation(userId, projectId, selected, 'send', email.trim()),
                                `Решение отправлено эксперту на проверку: ${email.trim()}.`);
                        }}>
                            <label>E-mail эксперта<input className="pv-input" type="email" required maxLength={254} autoFocus
                                value={email} disabled={pending} onChange={event => setEmail(event.target.value)} /></label>
                            <div className="pf-buttons">
                                <button className="site-button gt-default" type="submit" disabled={pending}>Отправить</button>
                                <button className="site-button" type="button" disabled={pending} onClick={() => setExpertFor(null)}>Отмена</button>
                            </div>
                        </form> : <button className="site-button" disabled={pending} onClick={() => {
                            setExpertFor(selected.id); setEmail('');
                        }}>Отправить эксперту на проверку</button>)}
                        {selected.expert_email && <p className="pf-email">Эксперт: {selected.expert_email}</p>}
                        {selected.can_decide && <div className="pf-buttons">
                            <button className="site-button" disabled={pending} onClick={() => act(
                                () => reviewProjectInvitation(userId, projectId, selected, 'reject'), 'Эксперт отклонил решение.'
                            )}>Эксперт отклонил решение</button>
                            <button className="site-button" disabled={pending} onClick={() => act(
                                () => reviewProjectInvitation(userId, projectId, selected, 'approve'), 'Эксперт утвердил решение. Приглашение принято.'
                            )}>Эксперт утвердил решение</button>
                        </div>}
                        <h3>История статусов</h3>
                        <ol className="pf-history">{selected.status_history.map((step, index) => <li key={index}>
                            {STATUS_NAMES[step.status] || step.status} · {formatDate(step.at)}
                        </li>)}</ol>
                    </> : <p className="gt-muted">Выберите приглашение или отклик в дереве.</p>}
                </section>
            </div>}
        {profileId && <CandidateProfile key={profileId} userId={userId} applicantId={profileId} onClose={() => setProfileId(null)} />}
    </div>;
};

export default ProjectFeedback;
