import React from 'react';
import { Candidate, GradeView, Invitation, Overview, RequirementFit, RequirementItem } from '../../applicants';
import { formatDate } from './projectWidgets';

// Части окна «Соискатели» (Applicants.tsx): кандидат в графе команды и в списках,
// степень подтверждения, знак ФСП, статус приглашения. Названия, разбор требований
// и статус берёт и окно «Вакансии» соискателя (Vacancies.tsx) — ему хватает
// справочников (Names). Классы — Applicants.css, FspAchievements.css (fsp-meter)
// и GradeTasks.css (gt-*).

export const FSP_LOGO = '/app/assets/fsp.png';
// Справочники для подписей: названия компетенций, видов стека и степеней.
export type Names = Pick<Overview, 'stack' | 'kind_names' | 'degree_names'>;
type StatusOf = Pick<Invitation, 'flow' | 'status' | 'status_history'> & { title?: string };
const GRADE_SOURCES: { [basis: string]: string } = { test: 'тест сдан', LLM: 'по резюме', Manual: 'выбрал сам' };
const STATUS_CLASSES: { [status: string]: string } = {
    sent: 'ap-status-sent',
    read: 'ap-status-read',
    task_needs_review: 'ap-status-review',
    task_sent_for_review: 'ap-status-review',
    accepted: 'ap-status-accepted',
    declined: 'ap-status-rejected',
    solution_rejected: 'ap-status-rejected',
};

export function candidateName(candidate: Candidate): string {
    return candidate.name ?? `Без имени · ${candidate.user_id.slice(0, 8)}`;
}

export function stackName(overview: Names, kind: string, id: string): string {
    return overview.stack[kind]?.[id] ?? id;
}

export function degreeName(overview: Names, degree: number): string {
    return overview.degree_names[String(degree)] ?? String(degree);
}

// «Middle · тест сдан».
export function gradeLine(grade: GradeView): string {
    if (!grade.basis || !grade.grade) return 'грейд не подтверждён';
    return `${grade.grade} · ${GRADE_SOURCES[grade.basis] ?? grade.basis}`;
}

// Откуда грейд, подробно: что сдано, что заявлено, не опровергнуто ли.
export function gradeDetails(grade: GradeView): string {
    const parts: string[] = [];
    if (grade.confirmed) parts.push(`тест на ${grade.confirmed} сдан`);
    if (grade.declared) {
        const how = grade.source === 'LLM' ? 'распознан по резюме' : 'выбран самим';
        parts.push(`заявлен ${grade.declared} (${how})${grade.refuted ? ' — опровергнут: тест на этот грейд или ниже провален' : ''}`);
    }
    return parts.length ? parts.join('; ') : 'ни теста, ни заявленного грейда';
}

export const Meter: React.FC<{ degree: number; title?: string }> = ({ degree, title }) => (
    <span className="fsp-meter ap-meter" title={title}>
        {[1, 2, 3].map((step) => (
            <span key={step} className={'fsp-meter-cell' + (step <= degree ? ' fsp-meter-on' : '')} />
        ))}
    </span>
);

export const FspMark: React.FC<{ linked: boolean; size?: number }> = ({ linked, size = 28 }) =>
    linked ? (
        <img
            className="ap-fsp"
            src={FSP_LOGO}
            alt="ФСП"
            width={size}
            height={size}
            title="Компетенции подтверждены соревнованиями ФСП"
        />
    ) : (
        <span className="ap-fsp ap-fsp-none" style={{ width: size, height: size }} title="Профиль не связан с ФСП: стек не подтверждён">
            ?
        </span>
    );

// Релевантность: число и полоса 0…100.
export const Relevance: React.FC<{ value: number; wide?: boolean }> = ({ value, wide }) => (
    <span className={'ap-relevance' + (wide ? ' ap-relevance-wide' : '')} title={`Релевантность ${value} из 100`}>
        <span className="ap-relevance-number">{value.toFixed(1)}</span>
        <span className="ap-relevance-bar">
            <span className="ap-relevance-fill" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
        </span>
    </span>
);

function dateTime(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
        ? ''
        : `${formatDate(iso)}, ${date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}

export function statusName(overview: Pick<Overview, 'flows'>, invitation: StatusOf, status = invitation.status): string {
    return overview.flows[invitation.flow]?.[status] ?? status;
}

export const StatusBadge: React.FC<{ overview: Pick<Overview, 'flows'>; invitation: StatusOf; withTitle?: boolean }> = ({
    overview,
    invitation,
    withTitle,
}) => (
    <span
        className={`gt-badge ap-status ${STATUS_CLASSES[invitation.status] ?? ''}`}
        title={invitation.status_history.map((change) => `${statusName(overview, invitation, change.status)} — ${dateTime(change.at)}`).join('\n')}
    >
        {withTitle ? `«${invitation.title}»: ` : ''}
        {statusName(overview, invitation)}
    </span>
);

// Кнопка «Отправить приглашение» или статус уже отправленного.
export const InviteControl: React.FC<{
    overview: Overview;
    invitation: Invitation | null | undefined;
    sending: boolean;
    disabledReason?: string;
    onInvite: () => void;
}> = ({ overview, invitation, sending, disabledReason, onInvite }) =>
    invitation ? (
        <span className="gt-column ap-invite-status">
            <StatusBadge overview={overview} invitation={invitation} />
            <span className="gt-muted ap-small">{invitation.flow === 'assignment' ? 'с заданием' : 'без задания'}</span>
        </span>
    ) : (
        <button
            className="site-button ap-invite"
            disabled={sending || !!disabledReason}
            title={disabledReason}
            onClick={(event) => {
                event.stopPropagation();
                onInvite();
            }}
        >
            {sending ? 'Отправляем…' : 'Отправить приглашение'}
        </button>
    );

// Чем кандидат закрывает требование: сама компетенция, близкая или ничего.
// У «любой из» — лучшая из закрытых.
function shownItems(row: RequirementFit): RequirementItem[] {
    if (row.match !== 'any') return row.items;
    const best = row.items.reduce((a, b) => (b.score > a.score ? b : a), row.items[0]);
    return best ? [best] : [];
}

// Совпавшие с вакансией компетенции и их степень — для карточки в графе.
export const MatchedChips: React.FC<{ overview: Overview; candidate: Candidate; limit?: number }> = ({
    overview,
    candidate,
    limit = 6,
}) => {
    if (!candidate.fsp_linked) return <p className="gt-muted ap-small">Профиль не связан с ФСП — стек не подтверждён</p>;
    if (!candidate.requirements || !candidate.requirements.length) {
        const top = candidate.competencies.slice(0, limit);
        return (
            <div className="gt-column">
                <span className="gt-muted ap-small">У вакансии нет требований к стеку — сильные стороны профиля ФСП:</span>
                <div className="ap-chips">
                    {top.map((c) => (
                        <span className="ap-chip" key={`${c.kind}:${c.id}`} title={`${stackName(overview, c.kind, c.id)}: ${degreeName(overview, c.degree)}`}>
                            <span className="ap-chip-name">{stackName(overview, c.kind, c.id)}</span>
                            <Meter degree={c.degree} />
                        </span>
                    ))}
                </div>
            </div>
        );
    }
    const matched: React.ReactNode[] = [];
    const missing: string[] = [];
    candidate.requirements.forEach((row) => {
        shownItems(row).forEach((item) => {
            const name = stackName(overview, row.kind, item.id);
            if (!item.relation) {
                if (row.importance === 'required') missing.push(name);
                return;
            }
            const close = item.relation !== 'exact';
            const via = close && item.via ? stackName(overview, row.kind, item.via) : '';
            matched.push(
                <span
                    key={`${row.kind}:${item.id}`}
                    className={'ap-chip' + (row.importance === 'plus' ? ' ap-chip-plus' : '') + (close ? ' ap-chip-close' : '')}
                    title={
                        close
                            ? `${name}: нет, засчитана близкая — ${via}, степень «${degreeName(overview, item.degree)}»`
                            : `${name}: степень «${degreeName(overview, item.degree)}», нужна «${degreeName(overview, row.min_degree)}»`
                    }
                >
                    <span className="ap-chip-name">{close ? `≈ ${via}` : name}</span>
                    <Meter degree={item.degree} />
                </span>
            );
        });
    });
    return (
        <div className="gt-column">
            <div className="ap-chips">{matched.length ? matched.slice(0, limit) : <span className="gt-muted ap-small">Совпадений со стеком вакансии нет</span>}</div>
            {missing.length > 0 && <span className="gt-muted ap-small">Нет: {missing.join(', ')}</span>}
        </div>
    );
};

// Разбор требований вакансии у кандидата — для подробного списка.
export const RequirementsTable: React.FC<{ overview: Names; candidate: Pick<Candidate, 'requirements'> }> = ({ overview, candidate }) => {
    if (!candidate.requirements) return null;
    return (
        <div className="gt-column ap-requirements">
            {candidate.requirements.map((row) => {
                const names = row.ids.map((id) => stackName(overview, row.kind, id)).join(row.match === 'any' ? ' или ' : ', ');
                const sign = row.meets ? '✓' : row.importance === 'required' ? '✗' : '·';
                return (
                    <div className="ap-requirement" key={`${row.kind}:${row.ids.join(',')}`}>
                        <span className={'ap-requirement-sign' + (row.meets ? ' ap-ok' : row.importance === 'required' ? ' ap-bad' : '')}>
                            {sign}
                        </span>
                        <span className="ap-requirement-name">
                            <b>{names}</b>
                            <span className="gt-muted ap-small">
                                {' '}
                                · {overview.kind_names[row.kind] ?? row.kind} ·{' '}
                                {row.importance === 'required' ? 'обязательно' : 'плюс'}, нужна «{degreeName(overview, row.min_degree)}»
                            </span>
                        </span>
                        <span className="ap-requirement-have">
                            {shownItems(row).map((item) => (
                                <span key={item.id} className="ap-have">
                                    {item.relation === 'exact' ? (
                                        <>
                                            {row.ids.length > 1 && `${stackName(overview, row.kind, item.id)} `}
                                            <Meter degree={item.degree} />
                                            {degreeName(overview, item.degree)}
                                        </>
                                    ) : item.relation && item.via ? (
                                        <>
                                            ≈ {stackName(overview, row.kind, item.via)} <Meter degree={item.degree} />
                                            <span className="gt-muted ap-small">
                                                {item.relation === 'adjacent' ? 'близкая' : 'того же рода'}
                                            </span>
                                        </>
                                    ) : (
                                        <span className="gt-muted">{row.ids.length > 1 ? `${stackName(overview, row.kind, item.id)}: ` : ''}нет</span>
                                    )}
                                </span>
                            ))}
                        </span>
                        <span className="ap-requirement-score" title="Балл за требование, 0…1">
                            {row.score.toFixed(2)}
                        </span>
                    </div>
                );
            })}
        </div>
    );
};

// Сильные компетенции профиля ФСП — чипы со степенью.
export const CompetencyChips: React.FC<{ overview: Overview; candidate: Candidate; limit?: number }> = ({
    overview,
    candidate,
    limit,
}) => {
    const shown = limit ? candidate.competencies.slice(0, limit) : candidate.competencies;
    if (!candidate.fsp_linked) return <span className="gt-muted ap-small">стек не подтверждён ФСП</span>;
    return (
        <div className="ap-chips">
            {shown.map((c) => (
                <span className="ap-chip" key={`${c.kind}:${c.id}`} title={`${stackName(overview, c.kind, c.id)} · ${overview.kind_names[c.kind] ?? c.kind}: ${degreeName(overview, c.degree)}`}>
                    <span className="ap-chip-name">{stackName(overview, c.kind, c.id)}</span>
                    <Meter degree={c.degree} />
                </span>
            ))}
            {limit && candidate.competencies.length > limit && (
                <span className="gt-muted ap-small">ещё {candidate.competencies.length - limit}</span>
            )}
        </div>
    );
};
