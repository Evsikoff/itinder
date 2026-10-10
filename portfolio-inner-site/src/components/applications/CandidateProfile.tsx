import React, { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api';
import { CandidateProfileData, downloadCandidateProfile, downloadSelfProfile, fetchCandidateProfile, fetchSelfProfile } from '../../candidateProfile';
import { formatDate, plural } from './projectWidgets';
import './CandidateProfile.css';

const KINDS: { [key: string]: string } = {
    languages: 'Языки', databases: 'Базы данных', integrations: 'Интеграции', testing: 'Тестирование',
};
const LEVELS: { [key: string]: string } = {
    regional: 'Региональное', interregional: 'Межрегиональное', national: 'Всероссийское', international: 'Международное',
};
const date = (value: string | null) => value ? formatDate(value) : 'Дата не указана';
const resultClass = (passed: boolean) => passed ? 'gt-badge-good' : 'gt-badge-bad';

interface Props { userId: string; applicantId: string; onClose: () => void; self?: boolean; embedded?: boolean; onInvitations?: () => void; }

const CandidateProfile: React.FC<Props> = ({ userId, applicantId, onClose, self = false, embedded = false, onInvitations }) => {
    const [data, setData] = useState<CandidateProfileData | null>(null);
    const [tab, setTab] = useState('skills');
    const [problem, setProblem] = useState('');
    const [attempt, setAttempt] = useState(0);
    const [loading, setLoading] = useState(true);
    const [skill, setSkill] = useState<string | null>(null);
    const [specialization, setSpecialization] = useState('');
    const dialog = useRef<HTMLDivElement>(null);
    const closeButton = useRef<HTMLButtonElement>(null);
    const evidence = useRef<HTMLElement>(null);
    const [exporting, setExporting] = useState(false);
    const [exportProblem, setExportProblem] = useState('');
    const downloading = useRef(false);
    const mounted = useRef(true);

    useEffect(() => {
        let alive = true;
        setLoading(true); setProblem(''); setData(null);
        (self ? fetchSelfProfile(userId) : fetchCandidateProfile(userId, applicantId)).then(next => { if (alive) setData(next); })
            .catch(failure => { if (alive) setProblem(failure instanceof ApiError ? failure.message : 'Не удалось загрузить профиль кандидата'); })
            .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [userId, applicantId, attempt, self]);

    useEffect(() => {
        mounted.current = true;
        const previous = document.activeElement as HTMLElement | null;
        if (!embedded) closeButton.current?.focus();
        return () => { mounted.current = false; if (!embedded) previous?.focus(); };
    }, [embedded]);

    const exportPdf = async () => {
        if (downloading.current) return;
        downloading.current = true; setExporting(true); setExportProblem('');
        try { await (self ? downloadSelfProfile(userId) : downloadCandidateProfile(userId, applicantId, data?.name ?? null)); }
        catch (failure) { if (mounted.current) setExportProblem(failure instanceof ApiError ? failure.message : 'Не удалось скачать PDF'); }
        finally { downloading.current = false; if (mounted.current) setExporting(false); }
    };

    useEffect(() => { evidence.current?.scrollIntoView?.({ block: 'nearest' }); }, [skill]);

    const selectedSkill = data?.fsp.competencies.find(entry => `${entry.kind}:${entry.id}` === skill);
    const tabs = [
        ['skills', 'Компетенции'], ['tests', 'Тесты и задания'], ['competitions', 'Соревнования'],
    ];
    const focusKey = (event: React.KeyboardEvent) => {
        if (embedded) return;
        if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
        if (event.key !== 'Tab') return;
        const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), select, summary, [tabindex="0"]'
        ) || []).filter(element => element.getClientRects().length > 0);
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };

    return <div className={embedded ? 'cp-inline' : 'cp-overlay'} onKeyDown={focusKey}>
        <div className={`cp-dialog gt-dialog${embedded ? ' cp-embedded' : ''}`} ref={dialog} role={embedded ? 'region' : 'dialog'}
            aria-modal={embedded ? undefined : true} aria-label={embedded ? 'Мой профиль' : undefined}
            aria-labelledby={embedded ? undefined : 'candidate-profile-title'}>
            {!embedded && <div className="gt-dialog-title cp-titlebar">
                <span id="candidate-profile-title">{self ? 'Мой профиль' : 'Профиль кандидата'}</span>
                <button ref={closeButton} className="site-button cp-close" onClick={onClose} aria-label="Закрыть профиль">×</button>
            </div>}
            {loading ? <p className="cp-state" role="status">Загружаем профиль кандидата…</p> : problem ?
                <div className="cp-state" role="alert"><p>{problem}</p><button className="site-button" onClick={() => setAttempt(value => value + 1)}>Повторить загрузку</button></div> : data && <>
                <div className="cp-hero">
                    <div className="cp-avatar" aria-hidden="true">{(data.name || 'Кандидат').split(/\s+/).slice(0, 2).map(word => word[0]).join('')}</div>
                    <div className="cp-identity"><h1>{data.name || 'Имя не указано'}</h1>
                        <p>{data.specializations.map(entry => entry.name).join(' · ') || 'Специализация пока не указана'}</p>
                        {data.email ? <p className="cp-contact"><b>E-mail:</b> {data.email}</p> :
                            <p className="gt-muted cp-small">Контакт доступен после принятия приглашения или отклика.</p>}
                    </div>
                    <div className="cp-stats" aria-label="Сводка профиля">
                        <span><b>{data.fsp.competencies.length}</b> {plural(data.fsp.competencies.length, 'компетенция', 'компетенции', 'компетенций')} ФСП</span>
                        <span><b>{data.tests.filter(entry => entry.passed).length} / {data.tests.length}</b> тестов пройдено</span>
                        <span><b>{data.fsp.competitions.length}</b> {plural(data.fsp.competitions.length, 'соревнование', 'соревнования', 'соревнований')}</span>
                    </div>
                </div>
                <div className="cp-grades" aria-label="Специализации и грейды">
                    {data.specializations.map(entry => <section className="cp-grade gt-field" key={entry.name}>
                        <h2>{entry.name}</h2>
                        <p><span className="gt-muted">Подтверждён тестом:</span> <b className={entry.confirmed ? 'cp-confirmed' : ''}>{entry.confirmed || 'нет'}</b></p>
                        <p><span className="gt-muted">Заявлен:</span> <b>{entry.declared || 'не указан'}</b>
                            {entry.declared && <span className="cp-small"> · {entry.source === 'LLM' ? 'из резюме' : entry.source === 'Manual' ? 'выбран кандидатом' : 'источник не указан'}</span>}</p>
                        {entry.refuted && <p className="cp-small cp-refuted">Заявленный грейд не подтверждается результатами тестов.</p>}
                    </section>)}
                </div>
                <div className="gt-tabs cp-tabs" role="tablist" aria-label="Разделы профиля">
                    {tabs.map(([id, name], index) => <button key={id} id={`cp-tab-${id}`} role="tab" aria-selected={tab === id}
                        aria-controls="cp-panel" tabIndex={tab === id ? 0 : -1}
                        className={`gt-tab${tab === id ? ' gt-tab-active' : ''}`} onClick={() => setTab(id)}
                        onKeyDown={event => {
                            const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                            if (step) { event.preventDefault(); const next = tabs[(index + step + tabs.length) % tabs.length][0];
                                setTab(next); document.getElementById(`cp-tab-${next}`)?.focus(); }
                        }}>{name}</button>)}
                </div>
                <div id="cp-panel" className="cp-panel gt-field" role="tabpanel" aria-labelledby={`cp-tab-${tab}`} tabIndex={0}>
                    {tab === 'skills' && <>
                        <p className="cp-intro">Компетенции, которые кандидат добавил из достижений ФСП. Три деления показывают степень подтверждения.</p>
                        {!data.fsp.linked ? <p className="cp-empty">Профиль ФСП ещё не связан. Компетенции пока не подтверждены соревнованиями.</p> :
                            !data.fsp.competencies.length ? <p className="cp-empty">В профиле ФСП пока нет компетенций.</p> :
                            Object.entries(KINDS).map(([kind, name]) => {
                                const entries = data.fsp.competencies.filter(entry => entry.kind === kind);
                                return entries.length ? <section className="cp-skill-group" key={kind}>
                                    <h2>{name}</h2><div className="cp-skill-grid">{entries.map(entry => {
                                        const key = `${entry.kind}:${entry.id}`;
                                        return <button key={key} className={`cp-skill${skill === key ? ' cp-skill-selected' : ''}`} aria-pressed={skill === key}
                                            onClick={() => setSkill(skill === key ? null : key)}>
                                            <b>{entry.name}</b><span className="cp-meter" aria-label={`Подтверждение: ${entry.degree_name}`}>
                                                {[1, 2, 3].map(n => <i key={n} className={n <= entry.degree ? 'cp-meter-on' : ''} />)}</span>
                                            <span className="cp-small">{entry.degree_name} · {entry.points} {plural(entry.points, 'балл', 'балла', 'баллов')}</span>
                                        </button>;
                                    })}</div>
                                </section> : null;
                            })}
                        {selectedSkill && <section ref={evidence} className="cp-evidence" aria-label="Подтверждающие соревнования">
                            <h2>{selectedSkill.name}: подтверждение</h2>
                            {selectedSkill.competitions.length ? <ul>{selectedSkill.competitions.map(id => {
                                const entry = data.fsp.competitions.find(competition => competition.id === id);
                                return entry && <li key={id}><b>{entry.name}</b> · {date(entry.end_date)} · {entry.result} · {entry.points} {plural(entry.points, 'балл', 'балла', 'баллов')}</li>;
                            })}</ul> : <p>Подробности соревнований не сохранились.</p>}
                        </section>}
                    </>}
                    {tab === 'tests' && <>
                        <div className="cp-history-head"><h2>Тесты на грейд</h2><label>Специализация <select value={specialization}
                            onChange={event => setSpecialization(event.target.value)}><option value="">Все</option>
                            {Array.from(new Set(data.tests.map(entry => entry.specialization))).map(name => <option key={name}>{name}</option>)}
                        </select></label></div>
                        {!data.tests.length && <p className="cp-empty">Кандидат пока не проходил тесты на грейд.</p>}
                        {data.tests.filter(entry => !specialization || entry.specialization === specialization).map(entry => <details className="cp-history-item" key={entry.id}>
                            <summary><span className={`gt-badge ${resultClass(entry.passed)}`}>{entry.credited ? 'Засчитан в тестовой версии' : entry.passed ? 'Пройден' : 'Не пройден'}</span>
                                <b>{entry.specialization} · {entry.grade}</b><span className="gt-muted cp-small">{date(entry.created_at)}</span></summary>
                            <div className="cp-history-body">
                                {entry.resource && <h3>{entry.resource}</h3>}
                                {entry.symptoms.length ? <ol>{entry.symptoms.map((text, index) => <li key={index}>{text}</li>)}</ol> : <p>Условие задания недоступно.</p>}
                                <p className="cp-small">{entry.language && `Язык: ${entry.language}. `}Проверка: {entry.credited ? 'засчитано вручную в тестовой версии'
                                    : [entry.procedural_check && 'по правилам', entry.llm_check && 'нейросетью'].filter(Boolean).join(' и ') || 'способ не указан'}.</p>
                                <p className="gt-muted cp-small">В истории сохраняются итог и условие теста; текст ответа и код кандидата не сохраняются.</p>
                            </div>
                        </details>)}
                        <h2 className="cp-section-heading">{self ? 'Задания по приглашениям' : 'Задания по вашим вакансиям'}</h2>
                        {!data.assignments.length && <p className="cp-empty">Приглашений и откликов с заданиями пока нет.</p>}
                        {data.assignments.map(entry => <details className="cp-history-item" key={entry.id}>
                            <summary><span className={`gt-badge ${entry.status === 'accepted' ? 'gt-badge-good' : ['declined', 'solution_rejected'].includes(entry.status) ? 'gt-badge-bad' : 'gt-badge-half'}`}>{entry.status_name}</span>
                                <b>{entry.title}</b><span className="gt-muted cp-small">{date(entry.updated_at)}</span></summary>
                            <div className="cp-history-body"><p className="gt-muted">{entry.project}</p>{entry.tasks.map((task, index) => <section key={index}>
                                <h3>Задание {index + 1}</h3><p className="cp-pre">{task}</p>
                                <h3>Решение кандидата</h3><p className="cp-pre">{entry.answers[index] || 'Решение ещё не отправлено.'}</p>
                            </section>)}</div>
                        </details>)}
                    </>}
                    {tab === 'competitions' && <>
                        <p className="cp-intro">Принятые кандидатом достижения ФСП: роль в команде, результат и применённые технологии.</p>
                        {!data.fsp.competitions.length && <p className="cp-empty">Кандидат пока не добавил соревнования в профиль.</p>}
                        {data.fsp.competitions.map(entry => <details className="cp-history-item" key={entry.id}>
                            <summary><span className="cp-award" aria-hidden="true">{entry.points >= 3 ? '★' : '◆'}</span><b>{entry.name}</b>
                                <span className="gt-muted cp-small">{date(entry.end_date)}</span></summary>
                            <div className="cp-history-body"><p><span className="gt-badge gt-badge-good">{entry.result}</span> · {entry.points} {plural(entry.points, 'балл', 'балла', 'баллов')}</p>
                                <p>{LEVELS[entry.level] || entry.level} · {date(entry.start_date)} — {date(entry.end_date)}</p>
                                <p><b>Роль:</b> {entry.role}</p><p className="cp-pre">{entry.task}</p>
                                <div className="cp-used">{entry.competencies.map(name => <span className="cp-used-chip" key={name}>{name}</span>)}</div>
                            </div>
                        </details>)}
                    </>}
                </div>
            </>}
            {exportProblem && <p className="cp-export-error" role="alert">{exportProblem}</p>}
            <div className="cp-footer"><span className="gt-muted cp-small">{data?.fsp.linked && `ФСП связан ${date(data.fsp.linked_at)}`}</span>
                <div className="cp-actions">
                    <button className="site-button" disabled={!data || loading || exporting} onClick={exportPdf}>{exporting ? 'Формируем PDF…' : 'Скачать PDF'}</button>
                    {onInvitations && <button className="site-button" onClick={onInvitations}>Приглашения и отклики</button>}
                    <button className="site-button" onClick={onClose}>{self ? 'Закрыть профиль' : 'Вернуться к кандидату'}</button>
                </div></div>
        </div>
    </div>;
};

export default CandidateProfile;
