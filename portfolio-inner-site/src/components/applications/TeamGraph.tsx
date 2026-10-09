import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Candidate, Overview, Team, TeamVacancy } from '../../applicants';
import { candidateName, FspMark, gradeLine, InviteControl, MatchedChips, Relevance } from './ApplicantViews';

// Граф команды проекта (окно «Соискатели», кнопка «Найти команду для проекта»):
// слева проект, от него — открытые вакансии (специализация и грейд), от каждой —
// по два самых релевантных кандидата. Узлы раскладывает CSS, линии рисует SVG
// поверх по их настоящим местам: пересчитываются, когда меняется размер графа.
// Линия к кандидату: пунктир — только предложен, сплошная — приглашён,
// зелёная — принял приглашение.

interface Edge {
    key: string;
    d: string;
    kind: 'project' | 'offer' | 'invited' | 'accepted';
}

export interface TeamGraphProps {
    team: Team;
    overview: Overview;
    sending: { [key: string]: boolean }; // vacancy_id:user_id — запрос идёт
    onInvite: (vacancy: TeamVacancy, candidate: Candidate) => void;
    onProfile?: (candidate: Candidate) => void;
}

const nodeKey = (vacancyId: string, userId?: string) => (userId ? `c:${vacancyId}:${userId}` : `v:${vacancyId}`);

// Точка выхода справа и входа слева у прямоугольника узла.
function anchor(element: HTMLElement, side: 'left' | 'right') {
    return {
        x: element.offsetLeft + (side === 'right' ? element.offsetWidth : 0),
        y: element.offsetTop + element.offsetHeight / 2,
    };
}

function curve(from: { x: number; y: number }, to: { x: number; y: number }): string {
    const middle = (from.x + to.x) / 2;
    return `M ${from.x} ${from.y} C ${middle} ${from.y}, ${middle} ${to.y}, ${to.x} ${to.y}`;
}

const TeamGraph: React.FC<TeamGraphProps> = ({ team, overview, sending, onInvite, onProfile }) => {
    const area = useRef<HTMLDivElement>(null);
    const content = useRef<HTMLDivElement>(null);
    const project = useRef<HTMLDivElement>(null);
    const nodes = useRef(new Map<string, HTMLElement>());
    const [edges, setEdges] = useState<Edge[]>([]);
    const [size, setSize] = useState({ width: 0, height: 0 });

    const bind = (key: string) => (element: HTMLElement | null) => {
        if (element) nodes.current.set(key, element);
        else nodes.current.delete(key);
    };

    const measure = useCallback(() => {
        const root = content.current;
        const start = project.current;
        if (!root || !start) return;
        const next: Edge[] = [];
        team.vacancies.forEach((vacancy) => {
            const node = nodes.current.get(nodeKey(vacancy.id));
            if (!node) return;
            next.push({ key: vacancy.id, d: curve(anchor(start, 'right'), anchor(node, 'left')), kind: 'project' });
            vacancy.candidates.forEach((candidate) => {
                const card = nodes.current.get(nodeKey(vacancy.id, candidate.user_id));
                if (!card) return;
                const status = candidate.invitation?.status;
                next.push({
                    key: `${vacancy.id}:${candidate.user_id}`,
                    d: curve(anchor(node, 'right'), anchor(card, 'left')),
                    kind: !status ? 'offer' : status === 'accepted' ? 'accepted' : 'invited',
                });
            });
        });
        setEdges(next);
        setSize({ width: root.scrollWidth, height: root.scrollHeight });
    }, [team]);

    useLayoutEffect(() => {
        measure();
        const observer = new ResizeObserver(() => measure());
        if (content.current) observer.observe(content.current);
        if (area.current) observer.observe(area.current);
        return () => observer.disconnect();
    }, [measure]);

    const open = team.vacancies.length;

    return (
        <div className="gt-field ap-graph" ref={area}>
            <div className="ap-graph-content" ref={content}>
                <svg className="ap-edges" width={size.width} height={size.height} aria-hidden="true">
                    {edges.map((edge) => (
                        <path key={edge.key} d={edge.d} className={`ap-edge ap-edge-${edge.kind}`} />
                    ))}
                </svg>
                <div className="ap-graph-project-column">
                    <div className="ap-node ap-node-project" ref={project}>
                        <div className="ap-node-title">
                            <span>Проект</span>
                        </div>
                        <div className="gt-column ap-node-body">
                            <b>{team.project.name}</b>
                            <span className="gt-muted ap-small">{team.project.company.name}</span>
                            <span className="ap-small" style={{ marginTop: 6 }}>
                                Открытых вакансий: {open}
                            </span>
                        </div>
                    </div>
                </div>
                <div className="gt-column ap-graph-groups">
                    {team.vacancies.map((vacancy) => (
                        <div className="ap-graph-group" key={vacancy.id}>
                            <div
                                className="ap-node ap-node-vacancy"
                                ref={bind(nodeKey(vacancy.id))}
                                title={`${vacancy.title} · нужно: ${vacancy.count}${
                                    vacancy.declined ? ` · отказались или не прошли задание: ${vacancy.declined}` : ''
                                }`}
                            >
                                <span className="ap-vacancy-specialization">{vacancy.specialization}</span>
                                <span className="ap-vacancy-grade">{vacancy.grade}</span>
                            </div>
                            <div className="gt-column ap-graph-candidates">
                                {vacancy.candidates.map((candidate) => (
                                    <div
                                        className={'ap-node ap-card' + (candidate.invitation ? ' ap-card-invited' : '')}
                                        key={candidate.user_id}
                                        ref={bind(nodeKey(vacancy.id, candidate.user_id))}
                                    >
                                        <FspMark linked={candidate.fsp_linked} />
                                        <div className="gt-column ap-card-main">
                                            <div className="gt-row ap-card-head">
                                                <b className="ap-card-name">{candidateName(candidate)}</b>
                                                <Relevance value={candidate.relevance} />
                                            </div>
                                            <span className="gt-muted ap-small">{gradeLine(candidate.grade)}</span>
                                            <MatchedChips overview={overview} candidate={candidate} />
                                        </div>
                                        <div className="gt-column ap-card-side">
                                            {onProfile && <button className="site-button" onClick={() => onProfile(candidate)}>Профиль</button>}
                                            <InviteControl
                                                overview={overview}
                                                invitation={candidate.invitation}
                                                sending={!!sending[`${vacancy.id}:${candidate.user_id}`]}
                                                onInvite={() => onInvite(vacancy, candidate)}
                                            />
                                        </div>
                                    </div>
                                ))}
                                {!vacancy.candidates.length && (
                                    <div className="ap-node ap-card ap-card-empty" ref={bind(nodeKey(vacancy.id, 'none'))}>
                                        <span className="gt-muted">Подходящих соискателей нет</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                    {!open && (
                        <div className="gt-center ap-graph-empty">
                            <p>Открытых вакансий нет: все закрыты или ждут решения открытых вопросов.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default TeamGraph;
