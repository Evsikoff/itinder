import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    Answers,
    Candidate,
    Evaluation,
    format,
    GRADES,
    Kind,
    Matrix,
    NONE,
    Option,
    Question,
    QuestionnaireEngine,
    Section,
    SectionView,
    templateKey,
    TemplateItem,
    UNKNOWN,
} from '../../projectQuestionnaire';
import { Choice, Dialog, peopleWord, vacanciesWord } from './projectWidgets';

// Мастер анкеты проекта: шаги слева, вопросы шага справа. Какие шаги и вопросы
// показать, считает QuestionnaireEngine по ответам; шаблоны (заданный стек,
// выбор по рынку, дефицит) — по блоку на элемент, все блоки на одной странице.
// «Далее» не пускает, пока нет обязательных ответов шага.

export interface QuestionnaireProps {
    engine: QuestionnaireEngine;
    answers: Answers;
    onAnswers: (answers: Answers) => void;
    projectName: string;
    companyName: string;
    image?: string;
    showDialog: (dialog: Dialog) => void;
    closeDialog: () => void;
    onCancel: () => void;
    onDone: (evaluation: Evaluation) => void;
}

const STEP_TITLES: { [repeat: string]: string } = {
    fixed_stack: 'Заданный стек',
    market_choices: 'Выбор технологий',
    scarce_items: 'Мало кандидатов',
};
const STEP_HINTS: { [repeat: string]: string } = {
    fixed_stack: 'Эти компетенции заданы ответами выше. Уточните, кому и насколько глубоко их нужно знать.',
    market_choices:
        'Здесь стек не задан — выберите вариант. «Рекомендуем» — больше всего подходящих соискателей с учётом ваших ответов о продукте.',
    scarce_items: 'Под эти заданные компетенции на рынке мало людей. Решите, что делать с требованием.',
};
const SUMMARY = 'summary';
const STACK_MODE_TEXT: { [mode: string]: string } = {
    fixed: 'Стек проекта задан: вакансии требуют то, что уже есть в проекте.',
    free: 'Стек выбран под рынок: варианты, под которые проще найти людей.',
    mixed: 'Часть стека задана, остальное выбрано под рынок.',
};

function stepTitle(view: SectionView): string {
    return view.section.repeat ? STEP_TITLES[view.section.repeat] ?? view.section.title : view.section.title;
}

const ProjectQuestionnaire: React.FC<QuestionnaireProps> = (props) => {
    const { engine, answers, onAnswers } = props;
    const evaluation = useMemo(() => engine.evaluate(answers), [engine, answers]);
    const views = evaluation.sections;
    const [stepId, setStepId] = useState(views[0]?.section.id ?? SUMMARY);
    const index = Math.max(0, views.findIndex((view) => view.section.id === stepId));
    const view = views[index];
    const panel = useRef<HTMLDivElement>(null);

    const set = (key: string, value: any) => onAnswers({ ...answers, [key]: value });

    useEffect(() => {
        panel.current?.scrollTo?.(0, 0);
    }, [stepId]);

    // План команды по умолчанию — когда рекрутёр впервые открывает этот шаг.
    useEffect(() => {
        if (view?.section.questions.some((q) => q.id === 'team_plan') && answers.team_plan === undefined) {
            onAnswers({ ...answers, team_plan: engine.defaultPlan(evaluation) });
        }
    }, [view, answers, engine, evaluation, onAnswers]);

    const go = (next: number) => {
        const target = views[Math.max(0, Math.min(views.length - 1, next))];
        if (target) setStepId(target.section.id);
    };

    const goNext = () => {
        const missing = engine.missing(view, answers, evaluation);
        if (missing.length) {
            props.showDialog({
                sign: 'error',
                title: 'Не всё заполнено',
                text: 'Ответьте на вопросы шага:',
                list: missing.slice(0, 8).concat(missing.length > 8 ? [`и ещё ${missing.length - 8}`] : []),
                buttons: [{ text: 'OK', primary: true, onClick: props.closeDialog }],
            });
            return;
        }
        if (view.section.id === SUMMARY) {
            props.onDone(evaluation);
            return;
        }
        go(index + 1);
    };

    // --- Вопросы -------------------------------------------------------------------

    const optionList = (question: Question, scope: { listItem?: any; item?: TemplateItem; section?: Section }) =>
        (question.options ?? []).filter((option) => engine.testIn(option.show_if, answers, scope));

    const renderOptions = (
        question: Question,
        options: Option[],
        value: any,
        onChange: (value: any) => void,
        vars?: { [name: string]: any }
    ) => {
        const multi = question.type === 'multi';
        const selected: string[] = multi ? (Array.isArray(value) ? value : []) : value === undefined ? [] : [value];
        const toggle = (option: Option) => {
            if (!multi) return onChange(option.id);
            if (selected.includes(option.id)) return onChange(selected.filter((id) => id !== option.id));
            const exclusive = options.filter((o) => o.exclusive).map((o) => o.id);
            onChange(option.exclusive ? [option.id] : [...selected.filter((id) => !exclusive.includes(id)), option.id]);
        };
        return (
            <div className="gt-column pv-options">
                {options.map((option) => (
                    <Choice
                        key={option.id}
                        type={multi ? 'check' : 'radio'}
                        checked={selected.includes(option.id)}
                        onToggle={() => toggle(option)}
                        label={format(option.text, vars)}
                        hint={option.hint ? format(option.hint, vars) : undefined}
                    />
                ))}
            </div>
        );
    };

    const renderStackPick = (question: Question, value: any, onChange: (value: any) => void) => {
        const kinds = question.kinds ?? [];
        const renderItems = (kind: Kind, selected: string[], toggle: (id: string) => void) => (
            <div className="pv-grid">
                {(engine.stack[kind] ?? []).map((item) => (
                    <Choice
                        key={item.id}
                        type="check"
                        compact
                        checked={selected.includes(item.id)}
                        onToggle={() => toggle(item.id)}
                        label={item.name}
                        hint={kind === 'integrations' || kind === 'testing' ? item.description : undefined}
                    />
                ))}
            </div>
        );
        if (question.per_kind) {
            const current = value && typeof value === 'object' ? value : {};
            return (
                <div className="gt-column">
                    {kinds.map((kind) => {
                        const part = current[kind];
                        const selected: string[] = Array.isArray(part) ? part : [];
                        const setPart = (next: any) => onChange({ ...current, [kind]: next });
                        const toggle = (id: string) => {
                            const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
                            setPart(next.length ? next : undefined);
                        };
                        return (
                            <div className="gt-column pv-kind" key={kind}>
                                <p className="pv-kind-title">{engine.kindName(kind)}</p>
                                {renderItems(kind, selected, toggle)}
                                <div className="gt-row pv-kind-special">
                                    <Choice type="radio" compact checked={part === NONE} onToggle={() => setPart(NONE)} label="Нет" />
                                    {question.allow_unknown && (
                                        <Choice
                                            type="radio"
                                            compact
                                            checked={part === UNKNOWN}
                                            onToggle={() => setPart(UNKNOWN)}
                                            label="Не знаю — спросить техлида"
                                        />
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            );
        }
        const selected: string[] = Array.isArray(value) ? value : [];
        const toggle = (id: string) => {
            const clean = selected.filter((x) => x !== UNKNOWN);
            onChange(clean.includes(id) ? clean.filter((x) => x !== id) : [...clean, id]);
        };
        return (
            <div className="gt-column">
                {kinds.map((kind) => (
                    <div className="gt-column pv-kind" key={kind}>
                        {kinds.length > 1 && <p className="pv-kind-title">{engine.kindName(kind)}</p>}
                        {renderItems(kind, selected, toggle)}
                    </div>
                ))}
                {question.allow_unknown && (
                    <div className="gt-row pv-kind-special">
                        <Choice
                            type="check"
                            compact
                            checked={selected.includes(UNKNOWN)}
                            onToggle={() => onChange(selected.includes(UNKNOWN) ? [] : [UNKNOWN])}
                            label="Не знаю"
                        />
                    </div>
                )}
            </div>
        );
    };

    const renderMatrix = (question: Question, value: Matrix | undefined, onChange: (value: Matrix) => void) => {
        const matrix = value ?? {};
        const plan = question.rows === 'positions';
        const rows = plan
            ? evaluation.positions.map((p) => ({ id: p.id, name: p.name, hint: p.reasons.join('; '), role: p.role }))
            : Object.keys(engine.roles).map((id) => ({ id, name: engine.roles[id].name, hint: '', role: id }));
        const floorOf = (role: string) => {
            const floors = evaluation.gradeFloors.filter((f) => f.role === '*' || f.role === role);
            return Math.max(-1, ...floors.map((f) => GRADES.indexOf(f.grade)));
        };
        const setCell = (row: string, grade: string, text: string) => {
            const number = Math.max(0, Math.min(99, parseInt(text, 10) || 0));
            onChange({ ...matrix, [row]: { ...(matrix[row] ?? {}), [grade]: number } });
        };
        return (
            <table className="pv-table pv-matrix">
                <thead>
                    <tr>
                        <th>{plan ? 'Позиция' : 'Роль'}</th>
                        {GRADES.map((grade) => (
                            <th key={grade}>{grade}</th>
                        ))}
                        <th>Всего</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => (
                        <tr key={row.id}>
                            <td>
                                <div className="gt-column">
                                    <span>{row.name}</span>
                                    {row.hint && <span className="gt-muted pv-small">{row.hint}</span>}
                                </div>
                            </td>
                            {GRADES.map((grade, gradeIndex) => {
                                const cell = matrix[row.id]?.[grade] ?? 0;
                                const warn = plan && cell > 0 && gradeIndex < floorOf(row.role);
                                return (
                                    <td key={grade}>
                                        <input
                                            className={'pv-input pv-number' + (warn ? ' pv-warn' : '')}
                                            type="number"
                                            min={0}
                                            max={99}
                                            value={cell || ''}
                                            placeholder="0"
                                            aria-label={`${row.name}, ${grade}`}
                                            onChange={(event) => setCell(row.id, grade, event.target.value)}
                                        />
                                    </td>
                                );
                            })}
                            <td className="pv-total">{GRADES.reduce((total, grade) => total + (matrix[row.id]?.[grade] ?? 0), 0)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        );
    };

    const renderList = (question: Question, value: any, onChange: (value: any) => void) => {
        const entries: { [field: string]: any }[] = Array.isArray(value) ? value : [];
        const update = (index: number, field: string, fieldValue: any) =>
            onChange(entries.map((entry, i) => (i === index ? { ...entry, [field]: fieldValue } : entry)));
        return (
            <div className="gt-column">
                {entries.map((entry, index) => (
                    <div className="gt-group pv-entry" key={index}>
                        <span className="gt-group-label">
                            {question.item_name ?? 'Элемент'} {index + 1}
                            {entry.name ? `: ${entry.name}` : ''}
                        </span>
                        {(question.fields ?? [])
                            .filter((field) => engine.testIn(field.show_if, answers, { listItem: entry }))
                            .map((field) => (
                                <div className="gt-column pv-question pv-question-inner" key={field.id}>
                                    <p className="pv-question-text">
                                        {format(field.text, entry)}
                                        {field.required && <span className="pv-required"> *</span>}
                                    </p>
                                    {field.hint && <p className="gt-muted pv-small">{format(field.hint, entry)}</p>}
                                    {renderInput(field, entry[field.id], (next) => update(index, field.id, next), {
                                        listItem: entry,
                                        vars: entry,
                                    })}
                                </div>
                            ))}
                        <div className="gt-row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
                            <button className="site-button" onClick={() => onChange(entries.filter((_, i) => i !== index))}>
                                Удалить
                            </button>
                        </div>
                    </div>
                ))}
                {entries.length < (question.max_items ?? 10) && (
                    <div className="gt-row" style={{ marginTop: 8 }}>
                        <button className="site-button pv-button-left" onClick={() => onChange([...entries, {}])}>
                            Добавить: {(question.item_name ?? 'элемент').toLowerCase()}
                        </button>
                    </div>
                )}
            </div>
        );
    };

    const renderCandidates = (item: TemplateItem, question: Question, value: string[], onChange: (value: string[]) => void) => {
        const need = item.vars.need;
        const candidates: Candidate[] = item.vars.candidates;
        const unknown = value.includes(UNKNOWN);
        const toggle = (key: string) => {
            if (need.variants) return onChange([key]);
            const clean = value.filter((k) => k !== UNKNOWN);
            const next = clean.includes(key) ? clean.filter((k) => k !== key) : [...clean, key];
            onChange(next.length ? next : clean);
        };
        return (
            <div className="gt-column pv-options">
                {candidates.map((candidate) => (
                    <Choice
                        key={candidate.key}
                        type={need.variants ? 'radio' : 'check'}
                        checked={!unknown && value.includes(candidate.key)}
                        onToggle={() => toggle(candidate.key)}
                        label={
                            <span className="pv-candidate">
                                <b>{candidate.name}</b>
                                {candidate.key === need.recommended && <span className="gt-badge pv-badge-recommended">рекомендуем</span>}
                                <span className={`gt-badge pv-level pv-level-${candidate.level.id}`}>{candidate.level.name}</span>
                                <span className="gt-muted pv-small">
                                    {GRADES.map((grade) => `${grade} ${candidate.supplyByGrade[grade]}`).join(' · ')}
                                </span>
                            </span>
                        }
                        hint={[candidate.preferReasons.join('; '), candidate.note].filter(Boolean).join('. ') || undefined}
                    />
                ))}
                {(question.extra_options ?? []).map((option) => (
                    <Choice
                        key={option.id}
                        type="check"
                        checked={unknown}
                        onToggle={() => onChange(unknown ? [need.recommended] : [option.id])}
                        label={option.text}
                    />
                ))}
                <p className="gt-muted pv-small" style={{ marginTop: 4 }}>
                    Ещё {need.unconfirmed} {need.unconfirmed === 1 ? 'соискатель' : 'соискателей'} этой роли не связали профиль с ФСП —
                    их стек неизвестен.
                </p>
            </div>
        );
    };

    function renderInput(
        question: Question,
        value: any,
        onChange: (value: any) => void,
        context: { listItem?: any; item?: TemplateItem; section?: Section; vars?: { [name: string]: any } } = {}
    ): React.ReactNode {
        switch (question.type) {
            case 'text':
                return (
                    <input
                        className="pv-input"
                        value={value ?? ''}
                        maxLength={question.max_length ?? 200}
                        onChange={(event) => onChange(event.target.value)}
                    />
                );
            case 'textarea':
                return (
                    <textarea
                        className="pv-input pv-textarea"
                        value={value ?? ''}
                        maxLength={question.max_length ?? 2000}
                        onChange={(event) => onChange(event.target.value)}
                    />
                );
            case 'date':
                return (
                    <input
                        className="pv-input pv-date"
                        type="date"
                        value={value ?? ''}
                        onChange={(event) => onChange(event.target.value)}
                    />
                );
            case 'single':
            case 'multi': {
                if (question.options_from && context.item) {
                    const ids: string[] = context.item.vars.scope ?? [];
                    const selected: string[] = Array.isArray(value) ? value : [];
                    return (
                        <div className="gt-column pv-options">
                            {ids.map((id) => (
                                <Choice
                                    key={id}
                                    type="check"
                                    checked={selected.includes(id)}
                                    onToggle={() => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])}
                                    label={evaluation.positions.find((p) => p.id === id)?.name ?? id}
                                />
                            ))}
                        </div>
                    );
                }
                return renderOptions(question, optionList(question, context), value, onChange, context.vars);
            }
            case 'yes_no':
                return (
                    <div className="gt-row pv-yes-no">
                        <Choice type="radio" checked={value === 'yes'} onToggle={() => onChange('yes')} label="Да" />
                        <Choice type="radio" checked={value === 'no'} onToggle={() => onChange('no')} label="Нет" />
                    </div>
                );
            case 'stack_pick':
                return renderStackPick(question, value, onChange);
            case 'list':
                return renderList(question, value, onChange);
            case 'team_matrix':
                return renderMatrix(question, value, onChange);
            case 'market_choice':
                return context.item ? renderCandidates(context.item, question, Array.isArray(value) ? value : [], onChange) : null;
            case 'summary':
                return renderSummary();
            default:
                return null;
        }
    }

    const renderQuestion = (
        question: Question,
        value: any,
        onChange: (value: any) => void,
        context: { item?: TemplateItem; section?: Section; vars?: { [name: string]: any } } = {}
    ) => (
        <div className="gt-column pv-question" key={question.id}>
            {question.type !== 'summary' && (
                <p className="pv-question-text">
                    {format(question.text, context.vars)}
                    {question.required && <span className="pv-required"> *</span>}
                </p>
            )}
            {question.hint && <p className="gt-muted pv-small">{format(question.hint, context.vars)}</p>}
            {renderInput(question, value, onChange, context)}
        </div>
    );

    const renderSummary = () => {
        const people = evaluation.vacancies.reduce((total, v) => total + v.count, 0);
        return (
            <div className="gt-column">
                <p>{STACK_MODE_TEXT[evaluation.stackMode]}</p>
                <div className="gt-group" style={{ marginTop: 16 }}>
                    <span className="gt-group-label">
                        Вакансии: {evaluation.vacancies.length} {vacanciesWord(evaluation.vacancies.length)}, {people} {peopleWord(people)}
                    </span>
                    {evaluation.vacancies.map((vacancy) => (
                        <div className="pv-summary-line gt-column" key={`${vacancy.position}-${vacancy.grade}`}>
                            <b>
                                {vacancy.title} × {vacancy.count}
                            </b>
                            <span className="gt-muted pv-small">
                                {vacancy.requirements
                                    .map(
                                        (row) =>
                                            row.ids.map((id) => engine.itemName(row.kind, id)).join(' или ') +
                                            (row.importance === 'plus' ? ' (плюс)' : '')
                                    )
                                    .join(', ') || 'Требований к стеку нет'}
                            </span>
                        </div>
                    ))}
                    {!evaluation.vacancies.length && <p>В плане команды никого нет — вернитесь к шагу «Команда».</p>}
                </div>
                {evaluation.openQuestions.length > 0 && (
                    <div className="gt-group" style={{ marginTop: 16 }}>
                        <span className="gt-group-label">Открытые вопросы</span>
                        <ul className="gt-facts">
                            {evaluation.openQuestions.map((q) => (
                                <li key={q.text}>
                                    {q.blocking && <span className="gt-badge gt-badge-bad">блокирует</span>}
                                    {q.text}
                                </li>
                            ))}
                        </ul>
                        <p className="gt-muted pv-small" style={{ marginTop: 6 }}>
                            Пока блокирующий вопрос не решён, вакансии сохраняются черновиками. Отметить вопрос решённым можно в
                            списке вакансий.
                        </p>
                    </div>
                )}
                <p className="gt-muted pv-small" style={{ marginTop: 12 }}>
                    «Сохранить проект» запишет проект и откроет список вакансий: его можно поправить, у каждой вакансии нужно
                    указать зарплатную вилку, потом — утвердить.
                </p>
            </div>
        );
    };

    // --- Шаг ------------------------------------------------------------------------

    const renderStatic = (section: Section) => (
        <>
            {(section.notices ?? [])
                .filter((notice) => engine.testIn(notice.when, answers, {}))
                .map((notice) => (
                    <p className="pv-notice" key={notice.text}>
                        {notice.text}
                    </p>
                ))}
            {section.questions
                .filter((question) => evaluation.visible[question.id])
                .map((question) => renderQuestion(question, answers[question.id], (next) => set(question.id, next)))}
            {section.questions.some((q) => q.id === 'team_plan') && evaluation.advice.length > 0 && (
                <div className="gt-group" style={{ marginTop: 14 }}>
                    <span className="gt-group-label">Советы по составу</span>
                    <ul className="gt-facts">
                        {evaluation.advice.map((advice) => (
                            <li key={advice.text} className={advice.tone === 'warn' ? 'pv-advice-warn' : ''}>
                                {advice.text}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </>
    );

    const renderTemplate = (section: Section, items: TemplateItem[]) =>
        items.map((item) => (
            <div className="gt-group pv-item" key={item.key}>
                <span className="gt-group-label">{format(section.title, item.vars)}</span>
                {item.vars.reasons && section.repeat === 'fixed_stack' && (
                    <p className="gt-muted pv-small">Откуда: {item.vars.reasons}</p>
                )}
                {section.questions
                    .filter((question) => engine.testIn(question.show_if, answers, { item, section }))
                    .map((question) =>
                        renderQuestion(
                            question,
                            engine.templateValue(section, item, question, answers),
                            (next) => set(templateKey(section, item, question), next),
                            { item, section, vars: item.vars }
                        )
                    )}
            </div>
        ));

    if (!view) return null;
    const last = view.section.id === SUMMARY;
    return (
        <>
            <div className="gt-header">
                {props.image && <img src={props.image} alt="" />}
                <div className="gt-column">
                    <p className="gt-title">Анкета проекта «{props.projectName}»</p>
                    <p className="gt-muted">{props.companyName}</p>
                </div>
            </div>
            <div className="gt-row pv-wizard">
                <div className="gt-column pv-steps gt-field">
                    {views.map((step, i) => (
                        <div
                            key={step.section.id}
                            className={'pv-step' + (i === index ? ' pv-step-active' : '') + (i < index ? ' pv-step-done' : '')}
                            role="button"
                            tabIndex={0}
                            onClick={() => i < index && go(i)}
                            onKeyDown={(event) => event.key === 'Enter' && i < index && go(i)}
                            title={i < index ? 'Вернуться к шагу' : undefined}
                        >
                            <span className="pv-step-number">{i + 1}</span>
                            <span>{stepTitle(step)}</span>
                        </div>
                    ))}
                </div>
                <div className="gt-panel gt-scroll pv-step-panel" ref={panel}>
                    <p className="gt-title pv-step-title">{stepTitle(view)}</p>
                    {view.section.repeat && STEP_HINTS[view.section.repeat] && (
                        <p className="gt-muted pv-small" style={{ marginBottom: 6 }}>
                            {STEP_HINTS[view.section.repeat]}
                        </p>
                    )}
                    {!view.section.repeat && view.section.description && (
                        <p className="gt-muted pv-small" style={{ marginBottom: 6 }}>
                            {view.section.description}
                        </p>
                    )}
                    {view.items ? renderTemplate(view.section, view.items) : renderStatic(view.section)}
                </div>
            </div>
            <div className="gt-footer">
                <p className="gt-status">
                    Шаг {index + 1} из {views.length}. <span className="pv-required">*</span> — обязательный вопрос.
                </p>
                <button className="site-button" onClick={() => go(index - 1)} disabled={index === 0}>
                    Назад
                </button>
                <button className="site-button gt-default" onClick={goNext}>
                    {last ? 'Сохранить проект' : 'Далее'}
                </button>
                <button className="site-button" onClick={props.onCancel}>
                    Отмена
                </button>
            </div>
        </>
    );
};

export default ProjectQuestionnaire;
