import React, { useMemo, useState } from 'react';
import { GRADES, Kind, KINDS, QuestionnaireEngine } from '../../projectQuestionnaire';
import { OpenQuestion, Project, Requirement, Vacancy } from '../../projects';
import { applicantsWord, Choice, Dialog, money, peopleWord, vacanciesWord } from './projectWidgets';

// Список вакансий проекта: правка и утверждение (VacancyEditor), просмотр (VacancyCard).
// Вакансия — позиция × грейд: сколько человек, вилка (обязательна), чем займётся,
// требования к стеку со степенью подтверждения в ФСП, задания, что ещё сказать.
// Рядом — сколько соискателей ITinder подходит под обязательные требования.

const MAX_SALARY = 10_000_000;
const MAX_ASSIGNMENTS = 20;
const IMPORTANCE_NAMES = { required: 'обязательно', plus: 'плюс' };
const ORIGIN_NAMES: { [origin: string]: string } = {
    fixed: 'задано',
    market: 'выбрано',
    legacy: 'старая система',
    rule: 'по правилу',
    manual: 'добавлено вручную',
};

// Рабочая копия вакансии: зарплата — строками полей ввода, у каждой — свой ключ.
export interface DraftVacancy extends Vacancy {
    key: string;
    salaryFrom: string;
    salaryTo: string;
}

let nextKey = 0;
export function toDraft(vacancy: Vacancy): DraftVacancy {
    nextKey += 1;
    return {
        ...vacancy,
        requirements: vacancy.requirements.map((row) => ({ ...row, ids: row.ids.slice(), reasons: row.reasons.slice() })),
        assignments: (vacancy.assignments ?? []).slice(),
        key: `v${nextKey}`,
        salaryFrom: vacancy.salary?.from != null ? String(vacancy.salary.from) : '',
        salaryTo: vacancy.salary?.to != null ? String(vacancy.salary.to) : '',
    };
}

function parseMoney(text: string): number | null {
    const digits = text.replace(/[\s ]/g, '');
    return /^\d+$/.test(digits) ? Number(digits) : null;
}

export function fromDraft(draft: DraftVacancy): Vacancy {
    const { key, salaryFrom, salaryTo, ...vacancy } = draft;
    return {
        ...vacancy,
        title: vacancy.title.trim(),
        task: (vacancy.task ?? '').trim(),
        notes: (vacancy.notes ?? '').trim() || null,
        assignments: vacancy.assignments.map((text) => text.trim()),
        salary: { from: parseMoney(salaryFrom), to: parseMoney(salaryTo), currency: 'RUB' },
    };
}

// Что не так с вакансией перед утверждением: строки для окна сообщения.
function problems(draft: DraftVacancy): string[] {
    const label = `«${draft.title.trim() || 'Без названия'}»`;
    const found: string[] = [];
    if (!draft.title.trim()) found.push(`${label}: нет названия`);
    const low = parseMoney(draft.salaryFrom);
    const high = parseMoney(draft.salaryTo);
    if (low === null || high === null) found.push(`${label}: укажите зарплатную вилку — «от» и «до»`);
    else if (low < 1 || high > MAX_SALARY) found.push(`${label}: зарплата — от 1 до 10 000 000 ₽`);
    else if (low > high) found.push(`${label}: зарплата «от» больше, чем «до»`);
    if (!(draft.task ?? '').trim()) found.push(`${label}: опишите, чем займётся`);
    if (!(draft.count >= 1 && draft.count <= 99)) found.push(`${label}: сколько человек — от 1 до 99`);
    draft.assignments.forEach((text, i) => {
        if (!text.trim()) found.push(`${label}: задание ${i + 1} пустое — заполните или удалите`);
    });
    return found;
}

function requirementName(engine: QuestionnaireEngine, row: Requirement): string {
    return row.ids.map((id) => engine.itemName(row.kind, id)).join(row.match === 'any' ? ' или ' : ' и ');
}

const Matches: React.FC<{ engine: QuestionnaireEngine; vacancy: Vacancy }> = ({ engine, vacancy }) => {
    const { confirmed, unconfirmed } = engine.vacancyMatches(vacancy);
    return (
        <p className={'pv-small pv-matches' + (confirmed < 3 ? ' pv-matches-few' : '')}>
            Подходят {confirmed} {applicantsWord(confirmed)} ITinder со стеком, подтверждённым в ФСП (грейд {vacancy.grade} и выше);
            ещё {unconfirmed} не связали профиль с ФСП.
        </p>
    );
};

// Вакансия только для чтения — в просмотре проекта.
export const VacancyCard: React.FC<{ engine: QuestionnaireEngine; vacancy: Vacancy }> = ({ engine, vacancy }) => (
    <div className="gt-group pv-vacancy">
        <span className="gt-group-label">
            {vacancy.title} × {vacancy.count}
        </span>
        <div className="gt-row pv-vacancy-facts">
            <span>
                <b>Позиция:</b> {vacancy.position_name}, {vacancy.grade}
            </span>
            <span>
                <b>Вилка:</b> {money(vacancy.salary?.from)} — {money(vacancy.salary?.to)}
            </span>
            {vacancy.status && (
                <span className={`gt-badge ${vacancy.status === 'ready' ? 'gt-badge-good' : 'gt-badge-half'}`}>
                    {vacancy.status === 'ready' ? 'готова' : 'черновик: есть открытые вопросы'}
                </span>
            )}
        </div>
        {vacancy.task && <p className="pv-pre">{vacancy.task}</p>}
        <p className="pv-subtitle">Требования к стеку</p>
        {vacancy.requirements.length ? (
            <div className="fsp-chips">
                {vacancy.requirements.map((row) => (
                    <span
                        key={`${row.kind}:${row.ids.join(',')}`}
                        className={'fsp-chip' + (row.importance === 'plus' ? ' pv-chip-plus' : '')}
                        title={`${engine.kindName(row.kind)} · ${IMPORTANCE_NAMES[row.importance]} · степень «${engine.degreeName(
                            row.min_degree
                        )}»${row.reasons.length ? ` · ${row.reasons.join('; ')}` : ''}`}
                    >
                        {requirementName(engine, row)}
                        {row.importance === 'plus' ? ' (плюс)' : ` · ${engine.degreeName(row.min_degree)}`}
                    </span>
                ))}
            </div>
        ) : (
            <p className="gt-muted pv-small">Требований к стеку нет.</p>
        )}
        {(vacancy.assignments ?? []).length > 0 && (
            <>
                <p className="pv-subtitle">Задания</p>
                <ol className="pv-assignments">
                    {vacancy.assignments.map((text, i) => (
                        <li key={i} className="pv-pre">
                            {text}
                        </li>
                    ))}
                </ol>
            </>
        )}
        {vacancy.notes && (
            <>
                <p className="pv-subtitle">Что ещё важно</p>
                <p className="pv-pre">{vacancy.notes}</p>
            </>
        )}
        <Matches engine={engine} vacancy={vacancy} />
    </div>
);

export interface VacancyEditorProps {
    engine: QuestionnaireEngine;
    project: Project;
    image?: string;
    showDialog: (dialog: Dialog) => void;
    closeDialog: () => void;
    onCancel: () => void;
    onApprove: (vacancies: Vacancy[], openQuestions: OpenQuestion[]) => void;
}

const VacancyEditor: React.FC<VacancyEditorProps> = (props) => {
    const { engine, project } = props;
    const [drafts, setDrafts] = useState<DraftVacancy[]>(() => project.vacancies_list.map(toDraft));
    const [questions, setQuestions] = useState<OpenQuestion[]>(() =>
        (project.summary.open_questions ?? []).map((q) => ({ ...q }))
    );
    const [highlight, setHighlight] = useState(false); // после неудачного «Утвердить» — подсветить пустые вилки
    const [adding, setAdding] = useState<{ position: string; grade: string } | null>(null);

    // Позиции: сначала те, что в проекте (из сводки анкеты), потом остальные из схемы.
    const positions = useMemo(() => {
        const own: { id: string; name: string; role: string }[] = project.summary.positions ?? [];
        const rest = engine.schema.rules.positions
            .filter((rule) => !own.some((p) => p.id === rule.id))
            .map((rule) => ({ id: rule.id, name: rule.name.replace(/\s*\(\{\w+\}\)/, ''), role: rule.role }));
        return [...own, ...rest];
    }, [engine, project]);

    const update = (key: string, change: Partial<DraftVacancy>) =>
        setDrafts((list) => list.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)));
    const updateRow = (draft: DraftVacancy, index: number, change: Partial<Requirement>) =>
        update(draft.key, { requirements: draft.requirements.map((row, i) => (i === index ? { ...row, ...change } : row)) });

    const askRemove = (draft: DraftVacancy) =>
        props.showDialog({
            sign: 'question',
            title: 'Удалить вакансию',
            text: `Убрать из списка вакансию «${draft.title}»? Окончательно — после «Утвердить вакансии».`,
            buttons: [
                {
                    text: 'Удалить',
                    primary: true,
                    onClick: () => {
                        setDrafts((list) => list.filter((d) => d.key !== draft.key));
                        props.closeDialog();
                    },
                },
                { text: 'Отмена', onClick: props.closeDialog },
            ],
        });

    const addVacancy = () => {
        if (!adding) return;
        const position = positions.find((p) => p.id === adding.position);
        if (!position) return;
        const role = engine.roles[position.role];
        // Требования — как у другой вакансии этой позиции, степень — по новому грейду.
        const sample = drafts.find((d) => d.position === position.id);
        const requirements: Requirement[] = (sample?.requirements ?? []).map((row) => ({
            ...row,
            ids: row.ids.slice(),
            reasons: row.reasons.slice(),
            min_degree: row.importance === 'required' && row.origin !== 'fixed' ? engine.defaultDegree(adding.grade) : row.min_degree,
        }));
        setDrafts((list) => [
            ...list,
            toDraft({
                id: null,
                title: `${position.name} (${adding.grade})`,
                position: position.id,
                position_name: position.name,
                role_id: position.role,
                specialization: role?.specialization ?? position.role,
                grade: adding.grade,
                count: 1,
                task: sample?.task ?? engine.positionTask(position.id),
                requirements,
                assignments: [],
                salary: null,
                notes: null,
            }),
        ]);
        setAdding(null);
    };

    const approve = () => {
        const found = drafts.flatMap(problems);
        if (!drafts.length) found.push('Добавьте хотя бы одну вакансию');
        if (found.length) {
            setHighlight(true);
            props.showDialog({
                sign: 'error',
                title: 'Вакансии не утверждены',
                text: 'Исправьте:',
                list: found.slice(0, 10).concat(found.length > 10 ? [`и ещё ${found.length - 10}`] : []),
                buttons: [{ text: 'OK', primary: true, onClick: props.closeDialog }],
            });
            return;
        }
        const blocking = questions.filter((q) => q.blocking && !q.resolved);
        const people = drafts.reduce((total, d) => total + d.count, 0);
        props.showDialog({
            sign: 'question',
            title: 'Утвердить вакансии',
            text:
                `Утвердить ${drafts.length} ${vacanciesWord(drafts.length)} на ${people} ${peopleWord(people)}?` +
                (blocking.length
                    ? ` Блокирующих открытых вопросов: ${blocking.length} — вакансии сохранятся черновиками, пока вопросы не решены.`
                    : ''),
            buttons: [
                {
                    text: 'Утвердить',
                    primary: true,
                    onClick: () => {
                        props.closeDialog();
                        props.onApprove(drafts.map(fromDraft), questions);
                    },
                },
                { text: 'Отмена', onClick: props.closeDialog },
            ],
        });
    };

    // Компетенции, которые можно добавить в требования вакансии: доступные роли, ещё не указанные.
    const addable = (draft: DraftVacancy) =>
        KINDS.flatMap((kind) =>
            (engine.stack[kind] ?? [])
                .filter((item) => engine.inScope(draft.role_id, kind, item.id))
                .filter((item) => !draft.requirements.some((row) => row.kind === kind && row.ids.includes(item.id)))
                .map((item) => ({ kind, id: item.id, name: item.name }))
        );

    const renderRequirements = (draft: DraftVacancy) => {
        const options = addable(draft);
        return (
            <div className="gt-column">
                <table className="pv-table pv-requirements">
                    <thead>
                        <tr>
                            <th>Компетенция</th>
                            <th>Обязательность</th>
                            <th>Степень в ФСП</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {draft.requirements.map((row, index) => (
                            <tr key={`${row.kind}:${row.ids.join(',')}`}>
                                <td>
                                    <div className="gt-column">
                                        <span>{requirementName(engine, row)}</span>
                                        <span className="gt-muted pv-small">
                                            {engine.kindName(row.kind)} · {ORIGIN_NAMES[row.origin] ?? row.origin}
                                            {row.reasons.length ? ` · ${row.reasons.join('; ')}` : ''}
                                        </span>
                                    </div>
                                </td>
                                <td>
                                    <select
                                        className="gt-select pv-select-small"
                                        value={row.importance}
                                        onChange={(event) => {
                                            const importance = event.target.value as Requirement['importance'];
                                            updateRow(draft, index, {
                                                importance,
                                                min_degree:
                                                    importance === 'plus'
                                                        ? engine.schema.rules.default_min_degree.plus
                                                        : engine.defaultDegree(draft.grade),
                                            });
                                        }}
                                    >
                                        <option value="required">обязательно</option>
                                        <option value="plus">плюс</option>
                                    </select>
                                </td>
                                <td>
                                    <select
                                        className="gt-select pv-select-small"
                                        value={row.min_degree}
                                        onChange={(event) => updateRow(draft, index, { min_degree: Number(event.target.value) })}
                                    >
                                        {[1, 2, 3].map((degree) => (
                                            <option key={degree} value={degree}>
                                                {engine.degreeName(degree)}
                                            </option>
                                        ))}
                                    </select>
                                </td>
                                <td>
                                    <button
                                        className="site-button pv-icon-button"
                                        title="Убрать требование"
                                        aria-label={`Убрать требование ${requirementName(engine, row)}`}
                                        onClick={() =>
                                            update(draft.key, { requirements: draft.requirements.filter((_, i) => i !== index) })
                                        }
                                    >
                                        ×
                                    </button>
                                </td>
                            </tr>
                        ))}
                        {!draft.requirements.length && (
                            <tr>
                                <td colSpan={4} className="gt-muted">
                                    Требований к стеку нет.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
                {options.length > 0 && (
                    <div className="gt-row" style={{ marginTop: 6 }}>
                        <select
                            className="gt-select"
                            value=""
                            aria-label="Добавить требование"
                            onChange={(event) => {
                                const [kind, id] = event.target.value.split(':');
                                if (!id) return;
                                update(draft.key, {
                                    requirements: [
                                        ...draft.requirements,
                                        {
                                            kind: kind as Kind,
                                            ids: [id],
                                            match: 'all',
                                            importance: 'required',
                                            min_degree: engine.defaultDegree(draft.grade),
                                            origin: 'manual',
                                            reasons: [],
                                        },
                                    ],
                                });
                            }}
                        >
                            <option value="">Добавить требование…</option>
                            {KINDS.filter((kind) => options.some((o) => o.kind === kind)).map((kind) => (
                                <optgroup key={kind} label={engine.kindName(kind)}>
                                    {options
                                        .filter((o) => o.kind === kind)
                                        .map((o) => (
                                            <option key={o.id} value={`${o.kind}:${o.id}`}>
                                                {o.name}
                                            </option>
                                        ))}
                                </optgroup>
                            ))}
                        </select>
                    </div>
                )}
            </div>
        );
    };

    const renderAssignments = (draft: DraftVacancy) => (
        <div className="gt-column">
            {draft.assignments.map((text, index) => (
                <div className="gt-row pv-assignment" key={index}>
                    <span className="pv-assignment-number">{index + 1}.</span>
                    <textarea
                        className={'pv-input pv-textarea pv-textarea-short' + (highlight && !text.trim() ? ' pv-warn' : '')}
                        value={text}
                        maxLength={4000}
                        placeholder="Суть задания"
                        aria-label={`Задание ${index + 1}`}
                        onChange={(event) =>
                            update(draft.key, {
                                assignments: draft.assignments.map((t, i) => (i === index ? event.target.value : t)),
                            })
                        }
                    />
                    <button
                        className="site-button pv-icon-button"
                        title="Удалить задание"
                        aria-label={`Удалить задание ${index + 1}`}
                        onClick={() => update(draft.key, { assignments: draft.assignments.filter((_, i) => i !== index) })}
                    >
                        ×
                    </button>
                </div>
            ))}
            {draft.assignments.length < MAX_ASSIGNMENTS && (
                <div className="gt-row" style={{ marginTop: 4 }}>
                    <button
                        className="site-button pv-button-left"
                        onClick={() => update(draft.key, { assignments: [...draft.assignments, ''] })}
                    >
                        Добавить задание
                    </button>
                </div>
            )}
        </div>
    );

    const renderDraft = (draft: DraftVacancy) => {
        const missingSalary = highlight && (parseMoney(draft.salaryFrom) === null || parseMoney(draft.salaryTo) === null);
        return (
            <div className="gt-group pv-vacancy" key={draft.key}>
                <span className="gt-group-label">
                    {draft.title || 'Без названия'} × {draft.count}
                </span>
                <div className="gt-row pv-fields">
                    <label className="gt-column pv-field pv-field-wide">
                        <span>Название</span>
                        <input
                            className={'pv-input' + (highlight && !draft.title.trim() ? ' pv-warn' : '')}
                            value={draft.title}
                            maxLength={120}
                            onChange={(event) => update(draft.key, { title: event.target.value })}
                        />
                    </label>
                    <label className="gt-column pv-field">
                        <span>Грейд</span>
                        <select
                            className="gt-select pv-select-small"
                            value={draft.grade}
                            onChange={(event) => {
                                // Степень по умолчанию следует за грейдом; заданную вручную не трогаем.
                                const grade = event.target.value;
                                const before = engine.defaultDegree(draft.grade);
                                update(draft.key, {
                                    grade,
                                    requirements: draft.requirements.map((row) =>
                                        row.importance === 'required' && row.min_degree === before
                                            ? { ...row, min_degree: engine.defaultDegree(grade) }
                                            : row
                                    ),
                                });
                            }}
                        >
                            {GRADES.map((grade) => (
                                <option key={grade}>{grade}</option>
                            ))}
                        </select>
                    </label>
                    <label className="gt-column pv-field">
                        <span>Сколько человек</span>
                        <input
                            className="pv-input pv-number"
                            type="number"
                            min={1}
                            max={99}
                            value={draft.count}
                            onChange={(event) =>
                                update(draft.key, { count: Math.max(1, Math.min(99, parseInt(event.target.value, 10) || 1)) })
                            }
                        />
                    </label>
                </div>
                <p className="gt-muted pv-small">
                    Позиция: {draft.position_name} · специализация {draft.specialization}
                </p>
                <div className="gt-row pv-fields">
                    <span className="pv-salary-label">
                        Зарплатная вилка, ₽ в месяц<span className="pv-required"> *</span>
                    </span>
                    <label className="gt-row pv-salary">
                        <span>от</span>
                        <input
                            className={'pv-input pv-money' + (missingSalary && parseMoney(draft.salaryFrom) === null ? ' pv-warn' : '')}
                            value={draft.salaryFrom}
                            inputMode="numeric"
                            maxLength={12}
                            placeholder="150 000"
                            onChange={(event) => update(draft.key, { salaryFrom: event.target.value })}
                        />
                    </label>
                    <label className="gt-row pv-salary">
                        <span>до</span>
                        <input
                            className={'pv-input pv-money' + (missingSalary && parseMoney(draft.salaryTo) === null ? ' pv-warn' : '')}
                            value={draft.salaryTo}
                            inputMode="numeric"
                            maxLength={12}
                            placeholder="220 000"
                            onChange={(event) => update(draft.key, { salaryTo: event.target.value })}
                        />
                    </label>
                </div>
                <p className="pv-subtitle">
                    Чем займётся<span className="pv-required"> *</span>
                </p>
                <textarea
                    className={'pv-input pv-textarea pv-textarea-short' + (highlight && !(draft.task ?? '').trim() ? ' pv-warn' : '')}
                    value={draft.task ?? ''}
                    maxLength={2000}
                    onChange={(event) => update(draft.key, { task: event.target.value })}
                />
                <p className="pv-subtitle">Требования к стеку</p>
                {renderRequirements(draft)}
                <p className="pv-subtitle">Задания</p>
                {renderAssignments(draft)}
                <p className="pv-subtitle">Что ещё важно сказать</p>
                <textarea
                    className="pv-input pv-textarea pv-textarea-short"
                    value={draft.notes ?? ''}
                    maxLength={2000}
                    onChange={(event) => update(draft.key, { notes: event.target.value })}
                />
                <div className="gt-row" style={{ marginTop: 8 }}>
                    <Matches engine={engine} vacancy={fromDraft(draft)} />
                    <button className="site-button" style={{ marginLeft: 'auto' }} onClick={() => askRemove(draft)}>
                        Удалить вакансию
                    </button>
                </div>
            </div>
        );
    };

    const people = drafts.reduce((total, d) => total + d.count, 0);
    return (
        <>
            <div className="gt-header">
                {props.image && <img src={props.image} alt="" />}
                <div className="gt-column">
                    <p className="gt-title">Вакансии проекта «{project.name}»</p>
                    <p className="gt-muted">
                        {project.company.name} · {drafts.length} {vacanciesWord(drafts.length)}, {people} {peopleWord(people)}
                    </p>
                </div>
            </div>
            <div className="gt-panel gt-scroll">
                {questions.length > 0 && (
                    <div className="gt-group" style={{ marginTop: 6 }}>
                        <span className="gt-group-label">Открытые вопросы</span>
                        {questions.map((q, i) => (
                            <Choice
                                key={q.text}
                                type="check"
                                checked={q.resolved}
                                onToggle={() => setQuestions((list) => list.map((x, j) => (j === i ? { ...x, resolved: !x.resolved } : x)))}
                                label={
                                    <span>
                                        {q.blocking && <span className="gt-badge gt-badge-bad">блокирует</span>}
                                        {q.text}
                                    </span>
                                }
                                hint={q.resolved ? 'Решён' : 'Отметьте, когда выясните ответ и поправите вакансии'}
                            />
                        ))}
                    </div>
                )}
                {drafts.map(renderDraft)}
                {!drafts.length && <p style={{ marginTop: 12 }}>Вакансий нет — добавьте хотя бы одну.</p>}
                <div className="gt-group" style={{ marginTop: 14 }}>
                    <span className="gt-group-label">Новая вакансия</span>
                    {adding ? (
                        <div className="gt-row pv-fields">
                            <label className="gt-column pv-field pv-field-wide">
                                <span>Позиция</span>
                                <select
                                    className="gt-select"
                                    value={adding.position}
                                    onChange={(event) => setAdding({ ...adding, position: event.target.value })}
                                >
                                    {positions.map((p) => (
                                        <option key={p.id} value={p.id}>
                                            {p.name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label className="gt-column pv-field">
                                <span>Грейд</span>
                                <select
                                    className="gt-select pv-select-small"
                                    value={adding.grade}
                                    onChange={(event) => setAdding({ ...adding, grade: event.target.value })}
                                >
                                    {GRADES.map((grade) => (
                                        <option key={grade}>{grade}</option>
                                    ))}
                                </select>
                            </label>
                            <button className="site-button gt-default pv-align-end" onClick={addVacancy}>
                                Добавить
                            </button>
                            <button className="site-button pv-align-end" onClick={() => setAdding(null)}>
                                Отмена
                            </button>
                        </div>
                    ) : (
                        <div className="gt-row">
                            <button
                                className="site-button pv-button-left"
                                onClick={() => setAdding({ position: positions[0]?.id ?? '', grade: 'Middle' })}
                            >
                                Добавить вакансию
                            </button>
                        </div>
                    )}
                </div>
            </div>
            <div className="gt-footer">
                <p className="gt-status">У каждой вакансии нужна зарплатная вилка.</p>
                <button className="site-button gt-default" onClick={approve}>
                    Утвердить вакансии
                </button>
                <button className="site-button" onClick={props.onCancel}>
                    Отмена
                </button>
            </div>
        </>
    );
};

export default VacancyEditor;
