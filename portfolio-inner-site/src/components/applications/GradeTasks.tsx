import React, { useCallback, useEffect, useRef, useState } from 'react';
import Window from '../os/Window';
import { ApiError, currentUserId } from '../../api';
import { GRADE_TASKS_PRESENTATION, markPresentationSeen, presentationSeen } from '../../presentation';
import Presentation from './Presentation';
import {
    CodeStatus,
    createTask,
    creditTest,
    fetchProfile,
    Grade,
    GradeAnswer,
    GradeCredit,
    GradeProfile,
    GradeResult,
    GradeTask,
    SolutionStatus,
    submitAnswer,
} from '../../gradeTests';
import './GradeTasks.css';

// «Задачи на грейд» — окно теста «проблемы» (значок id 2 на рабочем столе).
// Сначала окно показывает, какие специализацию и грейд сервер вычислил по
// записям пользователя, и предлагает тест — но выбрать можно любые, чтобы
// жюри было проще оценивать. Задание выдаёт сервер (gradeTests.ts): API-ресурс,
// интерфейс или систему и симптомы проблем; тестировщику — ещё документы
// (требования, логи, код автотестов), они на вкладке «Документы». Кандидат
// отмечает решения в списке (Junior, Middle) или описывает их текстом
// (Senior), бэкендер ещё пишет код. После проверки — итог и следующий тест:
// на грейд выше, если пройден, и ниже, если нет, или любой другой.
// В тестовой версии непройденный тест можно засчитать кнопкой на экране итога:
// сервер запишет итог «пройден» (creditTest). О новом пройденном тесте окно
// говорит рабочему столу (onAlertsChange) — тот снимает тревогу со значка.
// При первом запуске окно сначала показывает презентацию — как устроены
// задания (Presentation.tsx); со стартового экрана её можно открыть снова.
//   loading — сервер собирает профиль или задание; error — не собрал;
//   start — профиль и выбор теста; task — задание и ответ на вкладках;
//   checking — ответ проверяется; result — итог проверки.
type Stage = 'loading' | 'error' | 'start' | 'task' | 'checking' | 'result';
type Tab = 'incident' | 'docs' | 'answer' | 'code';
type Sign = 'ok' | 'error' | 'info' | 'question';

export interface GradeTasksProps extends WindowAppProps {
    title: string; // подпись значка
    image?: string; // картинка значка
    onAlertsChange: () => void; // записан пройденный или засчитанный тест — тревогу у значка проверить заново
}

interface Dialog {
    sign: Sign;
    title: string;
    text: string;
    buttons: { text: string; onClick: () => void; primary?: boolean }[];
}

const NO_USER = 'Не удалось узнать, кто вы. Войдите в ITinder и откройте окно снова.';
const TESTS_SHOWN = 5; // итогов прошлых тестов на стартовом экране
const TAB_SPACES = '    ';
const PROBLEM_COUNT: { [count: number]: string } = {
    1: 'Одна проблема',
    2: 'Две проблемы',
    3: 'Три проблемы',
    4: 'Четыре проблемы',
};
const SOLUTION_BADGES: { [status in SolutionStatus]: [string, string] } = {
    fixed: ['Решено', 'good'],
    mitigated: ['Решено частично', 'half'],
    missed: ['Не решено', 'bad'],
    crutch: ['Костыль', 'bad'],
};
const CRUTCH_RULE = 'Костыли — решения, которые прячут симптом, а причину оставляют, — не засчитываются.';
const CODE_BADGES: { [status in CodeStatus]: [string, string] } = {
    ok: ['Код работает', 'good'],
    weak: ['Код с ошибками', 'half'],
    missing: ['Кода нет', 'bad'],
};
const SIGNS: { [sign in Sign]: string } = { ok: '✓', error: '✕', info: 'i', question: '?' };

// Как ускоряется полоса ожидания: за tau мс заполняется на 60%, дальше 95% не идёт.
const LOADING_TAU = 1500;
const LLM_TAU = 45000;
const CODE_TAU = 1000;

// Значок окна сообщения; им пользуется и окно «Достижения в ФСП».
export const SignIcon: React.FC<{ sign: Sign }> = ({ sign }) => (
    <div className={`gt-sign gt-sign-${sign}`}>
        <span>{SIGNS[sign]}</span>
    </div>
);

const CheckMark: React.FC = () => (
    <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
        <polyline points="1.5,4 3.5,6.5 7.5,2" fill="none" stroke="#000" strokeWidth="2" />
    </svg>
);

function howToAnswer(task: GradeTask): string {
    const problems = PROBLEM_COUNT[task.symptoms.length] ?? `Проблем: ${task.symptoms.length}`;
    const code = task.answer.code ? ', и напишите код этих решений' : '';
    if (task.answer.text) return `${problems}. Опишите решения своими словами${code}.`;
    if (task.answer.max_select) {
        return `${problems}. Отметьте до ${task.answer.max_select} решений, которые её устранят${code}.`;
    }
    return `${problems}. Отметьте набор решений, который устранит их все${code}.`;
}

// Дата записи по-русски, без «г.» в конце: «8 октября 2026».
function formatDate(iso: string | null | undefined): string {
    const date = new Date(iso ?? '');
    return Number.isNaN(date.getTime())
        ? ''
        : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '');
}

// Как отвечают на грейде — подсказка под выбором теста.
function gradeRule(profile: GradeProfile, specialization: string, grade: Grade): string {
    const { rules } = profile;
    const count = rules.problem_count[grade];
    const problems = PROBLEM_COUNT[count] ?? `Проблем: ${count}`;
    let text =
        grade === 'Senior'
            ? `${problems}: описать решения своими словами, ответ проверяет нейросеть.`
            : grade === 'Junior'
            ? `${problems}: отметить до ${rules.junior_max_select} решений, хотя бы одно должно её устранить.`
            : `${problems}: отметить набор решений на весь инцидент, лишних — не больше ${rules.middle_max_extra}.`;
    if (rules.code.includes(specialization)) text += ' Ещё нужно написать код решений.';
    if (grade !== 'Junior' && rules.side_effects.includes(specialization)) {
        text += ' Учитываются побочные эффекты решений на экране.';
    }
    if (rules.crutches?.includes(specialization)) {
        text += ` К наблюдениям приложены документы: требования, тест-кейсы, логи, код автотестов. ${CRUTCH_RULE}`;
    }
    return text;
}

// Почему предложен именно этот тест.
function basisText(profile: GradeProfile): string {
    const { recommended, declared, tests } = profile;
    const last = tests[0];
    switch (recommended.basis) {
        case 'passed':
            return recommended.grade === last.grade
                ? `тест ${last.grade} пройден, выше грейда нет — можно пройти его снова`
                : `последний тест, ${last.grade}, пройден — следующий на грейд выше`;
        case 'failed':
            return recommended.grade === last.grade
                ? `тест ${last.grade} не пройден, ниже грейда нет — стоит попробовать снова`
                : `последний тест, ${last.grade}, не пройден — следующий на грейд ниже`;
        case 'declared':
            return 'тестов по этой специализации ещё не было — начнём с заявленного грейда';
        default:
            return declared
                ? `для ${declared.specialization} задач пока нет — выберите любую специализацию из списка`
                : 'специализация не выбрана — выберите любую из списка';
    }
}

// Что сказать об ошибке запроса и можно ли повторить: 4xx — повтор не поможет.
function errorOf(failure: unknown, fallback: string): { message: string; action: string | null } {
    const status = failure instanceof ApiError ? failure.status : 500;
    return {
        message: failure instanceof ApiError ? failure.message : fallback,
        action: status === 0 || status >= 500 ? 'Повторить' : null,
    };
}

const GradeTasks: React.FC<GradeTasksProps> = (props) => {
    const [userId] = useState(currentUserId);
    const [presenting, setPresenting] = useState(() => !presentationSeen(GRADE_TASKS_PRESENTATION, userId));
    const [presentationPauses, setPresentationPauses] = useState(0);
    const [size] = useState(() => ({
        width: Math.max(560, Math.min(980, window.innerWidth - 80)),
        height: Math.max(420, Math.min(760, window.innerHeight - 90)),
    }));
    const [stage, setStage] = useState<Stage>('loading');
    const [error, setError] = useState<{ message: string; action: string | null }>({ message: '', action: null });
    const [task, setTask] = useState<GradeTask | null>(null);
    const [result, setResult] = useState<GradeResult | null>(null);
    // Непройденный тест засчитан кнопкой тестовой версии; crediting — запрос идёт.
    const [credited, setCredited] = useState<GradeCredit | null>(null);
    const [crediting, setCrediting] = useState(false);
    const [tab, setTab] = useState<Tab>('incident');
    const [docId, setDocId] = useState<number | null>(null); // открытый документ на вкладке «Документы»
    const [picks, setPicks] = useState<string[]>([]);
    const [text, setText] = useState('');
    const [language, setLanguage] = useState('');
    const [code, setCode] = useState('');
    const [notice, setNotice] = useState('');
    const [dialog, setDialog] = useState<Dialog | null>(null);
    const [progress, setProgress] = useState(0);
    const [loading, setLoading] = useState<'profile' | 'task'>('profile');
    const [profile, setProfile] = useState<GradeProfile | null>(null);
    // Выбранный тест: сначала — рекомендованный по профилю.
    const [choice, setChoice] = useState<{ specialization: string; grade: Grade } | null>(null);
    // Что повторить кнопкой на экране ошибки.
    const retry = useRef<() => void>(() => {});

    const loadProfile = useCallback(async () => {
        setDialog(null);
        setLoading('profile');
        setStage('loading');
        if (!userId) {
            setError({ message: NO_USER, action: null });
            setStage('error');
            return;
        }
        try {
            const next = await fetchProfile(userId);
            setProfile(next);
            setChoice({ specialization: next.recommended.specialization, grade: next.recommended.grade });
            setStage('start');
        } catch (failure) {
            retry.current = () => loadProfile();
            setError(errorOf(failure, 'Не удалось узнать вашу специализацию'));
            setStage('error');
        }
    }, [userId]);

    const load = useCallback(
        async (specialization: string, grade: Grade) => {
            setDialog(null);
            setLoading('task');
            setStage('loading');
            if (!userId) {
                setError({ message: NO_USER, action: null });
                setStage('error');
                return;
            }
            try {
                const next = await createTask(userId, specialization, grade);
                setTask(next);
                setResult(null);
                setCredited(null);
                setTab('incident');
                setDocId(next.artifacts?.[0]?.id ?? null);
                setPicks([]);
                setText('');
                setLanguage('');
                setCode('');
                setNotice('');
                setStage('task');
            } catch (failure) {
                retry.current = () => load(specialization, grade);
                setError(errorOf(failure, 'Не удалось получить задание'));
                setStage('error');
            }
        },
        [userId]
    );

    useEffect(() => {
        loadProfile();
    }, [loadProfile]);

    // Отметка ставится, как только презентация открылась: «при первом запуске».
    useEffect(() => {
        if (presenting) markPresentationSeen(GRADE_TASKS_PRESENTATION, userId);
    }, [presenting, userId]);

    // Свёрнутое окно не должно говорить: речь докладчика — на паузу.
    const minimize = () => {
        if (presenting) setPresentationPauses((count) => count + 1);
        props.onMinimize();
    };

    const usesLlm = !!task && (task.answer.text || task.answer.code);

    // Полоса ожидания: сколько ждать, заранее неизвестно, поэтому она замедляется.
    useEffect(() => {
        if (stage !== 'loading' && stage !== 'checking') return;
        const tau = stage === 'loading' ? LOADING_TAU : usesLlm ? LLM_TAU : CODE_TAU;
        const start = Date.now();
        setProgress(0);
        const timer = setInterval(() => {
            setProgress(95 * (1 - Math.exp(-(Date.now() - start) / tau)));
        }, 250);
        return () => clearInterval(timer);
    }, [stage, usesLlm]);

    const tabs: { id: Tab; label: string; filled: boolean }[] = task
        ? [
              { id: 'incident', label: 'Инцидент', filled: false },
              ...(task.artifacts?.length ? [{ id: 'docs' as Tab, label: 'Документы', filled: false }] : []),
              { id: 'answer', label: 'Решения', filled: task.answer.select ? picks.length > 0 : !!text.trim() },
              ...(task.answer.code
                  ? [{ id: 'code' as Tab, label: 'Код', filled: !!language && !!code.trim() }]
                  : []),
          ]
        : [];
    const tabIndex = tabs.findIndex((item) => item.id === tab);

    const closeDialog = () => setDialog(null);

    const toggle = (id: string) => {
        if (!task) return;
        if (picks.includes(id)) {
            setPicks(picks.filter((pick) => pick !== id));
            setNotice('');
            return;
        }
        const max = task.answer.max_select;
        if (max && picks.length >= max) {
            setNotice(`Можно отметить не больше ${max} решений — снимите лишний флажок.`);
            return;
        }
        setPicks([...picks, id]);
        setNotice('');
    };

    // Табуляция в коде — отступ, а не переход к следующему полю.
    const onCodeKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key !== 'Tab') return;
        event.preventDefault();
        const area = event.currentTarget;
        const { selectionStart, selectionEnd } = area;
        setCode(code.slice(0, selectionStart) + TAB_SPACES + code.slice(selectionEnd));
        requestAnimationFrame(() => {
            area.selectionStart = area.selectionEnd = selectionStart + TAB_SPACES.length;
        });
    };

    // Чего не хватает в ответе: вкладка и что сказать. null — всё на месте.
    const missing = (): { tab: Tab; message: string } | null => {
        if (!task) return null;
        if (task.answer.select && picks.length === 0) return { tab: 'answer', message: 'Отметьте хотя бы одно решение.' };
        if (task.answer.text && !text.trim()) return { tab: 'answer', message: 'Опишите решения.' };
        if (task.answer.code && !language) return { tab: 'code', message: 'Выберите язык, на котором пишете код.' };
        if (task.answer.code && !code.trim()) return { tab: 'code', message: 'Напишите код решений.' };
        return null;
    };

    const send = async () => {
        if (!task || !userId) return;
        setDialog(null);
        setStage('checking');
        const answer: GradeAnswer = {};
        if (task.answer.select) answer.solutions = picks;
        if (task.answer.text) answer.text = text;
        if (task.answer.code) {
            answer.language = language;
            answer.code = code;
        }
        try {
            const checked = await submitAnswer(userId, task.task_id, answer);
            setResult(checked);
            setCredited(null);
            setStage('result');
            if (checked.passed) props.onAlertsChange();
        } catch (failure) {
            const status = failure instanceof ApiError ? failure.status : 500;
            const message = failure instanceof ApiError ? failure.message : 'Не удалось проверить решение';
            if (status === 410) {
                // Сервер перезапускали или задание пролежало слишком долго.
                retry.current = () => load(task.specialization, task.grade);
                setError({ message, action: 'Начать заново' });
                setStage('error');
                return;
            }
            setStage('task');
            const again = status === 0 || status >= 500;
            setDialog({
                sign: 'error',
                title: 'Проверка не удалась',
                text: again ? `${message}. Ответ остался в окне — его можно отправить ещё раз.` : message,
                buttons: again
                    ? [
                          { text: 'Повторить', onClick: send, primary: true },
                          { text: 'Отмена', onClick: closeDialog },
                      ]
                    : [{ text: 'OK', onClick: closeDialog, primary: true }],
            });
        }
    };

    const credit = async (checked: GradeResult) => {
        if (!userId || crediting) return;
        setCrediting(true);
        try {
            setCredited(await creditTest(userId, checked.id));
            props.onAlertsChange();
        } catch (failure) {
            setDialog({
                sign: 'error',
                title: 'Тест не засчитан',
                text: failure instanceof ApiError ? failure.message : 'Не удалось засчитать тест',
                buttons: [{ text: 'OK', onClick: closeDialog, primary: true }],
            });
        } finally {
            setCrediting(false);
        }
    };

    const askToSend = () => {
        const gap = missing();
        if (gap) {
            setTab(gap.tab);
            setDialog({
                sign: 'info',
                title: props.title,
                text: gap.message,
                buttons: [{ text: 'OK', onClick: closeDialog, primary: true }],
            });
            return;
        }
        setDialog({
            sign: 'question',
            title: 'Отправить на проверку',
            text: 'Отправить ответ на проверку? После этого изменить его будет нельзя.',
            buttons: [
                { text: 'Да', onClick: send, primary: true },
                { text: 'Нет', onClick: closeDialog },
            ],
        });
    };

    const openDoc = (id: number) => {
        setDocId(id);
        setTab('docs');
    };

    // Открытый документ — его номер в списке; по умолчанию первый.
    const docIndex = (current: GradeTask): number =>
        Math.max(0, (current.artifacts ?? []).findIndex((item) => item.id === docId));

    // К какому наблюдению приложен документ: номер с единицы.
    const docSymptom = (current: GradeTask, id: number): number =>
        (current.attachments ?? []).findIndex((ids) => ids.includes(id)) + 1;

    const renderIncident = (current: GradeTask) => (
        <div className="gt-column gt-grow">
            <div className="gt-group" style={{ marginTop: 6, flexShrink: 1, minHeight: 90 }}>
                <span className="gt-group-label">{current.resource.label}</span>
                <div className="gt-scroll">
                    <p>
                        <b>{current.resource.name}</b>
                    </p>
                    {current.resource.endpoint && <p className="gt-mono">{current.resource.endpoint}</p>}
                    <p>{current.resource.description}</p>
                    {current.resource.context && (
                        <p style={{ marginTop: 6 }}>
                            <b>Продукт:</b> {current.resource.context}. {current.resource.context_description}
                        </p>
                    )}
                    {!!current.resource.constraints?.length &&
                        (current.resource.kind === 'qa' ? (
                            // У системы особенностей много — одной строкой, чтобы осталось место наблюдениям.
                            <p className="gt-muted" style={{ marginTop: 4 }}>
                                {current.resource.constraints.join(' · ')}
                            </p>
                        ) : (
                            <ul className="gt-facts">
                                {current.resource.constraints.map((item) => (
                                    <li key={item}>{item}</li>
                                ))}
                            </ul>
                        ))}
                </div>
            </div>
            <div className="gt-group gt-grow" style={{ flexShrink: 1, marginTop: 18 }}>
                <span className="gt-group-label">Наблюдения</span>
                <div className="gt-field gt-scroll gt-grow">
                    {current.symptoms.map((symptom, i) => (
                        <div className="gt-symptom" key={i}>
                            <span className="gt-symptom-number">{i + 1}.</span>
                            <div className="gt-column" style={{ flex: 1, minWidth: 0 }}>
                                <p>{symptom}</p>
                                {!!current.attachments?.[i]?.length && (
                                    <div className="gt-attachments">
                                        <span className="gt-muted">Документы:</span>
                                        {current.attachments[i].map((id) => {
                                            const doc = current.artifacts?.find((item) => item.id === id);
                                            return (
                                                doc && (
                                                    <button key={id} className="gt-link" onClick={() => openDoc(id)}>
                                                        {doc.name} «{doc.title}»
                                                    </button>
                                                )
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );

    // Список документов слева, открытый документ справа — как в проводнике.
    const renderDocs = (current: GradeTask) => {
        const docs = current.artifacts ?? [];
        const index = docIndex(current);
        const doc = docs[index];
        const move = (event: React.KeyboardEvent<HTMLDivElement>) => {
            const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
            if (!step) return;
            event.preventDefault();
            const next = docs[Math.min(docs.length - 1, Math.max(0, index + step))];
            setDocId(next.id);
            document.getElementById(`grade-tasks-doc-${next.id}`)?.focus();
        };
        return (
            <div className="gt-docs gt-grow">
                <div className="gt-field gt-scroll gt-doc-list" role="listbox" aria-label="Документы" onKeyDown={move}>
                    {docs.map((item) => {
                        const active = item.id === doc?.id;
                        return (
                            <div
                                key={item.id}
                                id={`grade-tasks-doc-${item.id}`}
                                role="option"
                                aria-selected={active}
                                tabIndex={active ? 0 : -1}
                                className={'gt-doc-item' + (active ? ' gt-doc-item-active' : '')}
                                onClick={() => setDocId(item.id)}
                            >
                                <span className="gt-doc-kind">
                                    {item.name} · к наблюдению {docSymptom(current, item.id)}
                                </span>
                                <span className="gt-doc-title">{item.title}</span>
                            </div>
                        );
                    })}
                </div>
                {doc && (
                    <div className="gt-column gt-grow" style={{ minWidth: 0 }}>
                        <p className="gt-doc-heading">
                            <b>{doc.name}</b> · {doc.title}
                        </p>
                        <pre className={`gt-field gt-doc gt-doc-${doc.format}`} tabIndex={0} aria-label={doc.title}>
                            {doc.text}
                        </pre>
                    </div>
                )}
            </div>
        );
    };

    const renderSolutions = (current: GradeTask) => (
        <div className="gt-column gt-grow">
            <p>
                {current.answer.max_select
                    ? `Отметьте флажками решения, которые устранят проблему, — не больше ${current.answer.max_select}.`
                    : 'Отметьте флажками набор решений, который устранит все проблемы инцидента. Лишние решения считаются ошибкой.'}
                {current.answer.side_effects &&
                    ' Учтите побочные эффекты: если решение на этом экране создаёт новую проблему, отметьте и решение для неё.'}
                {current.answer.crutches && ` ${CRUTCH_RULE}`}
            </p>
            <div className="gt-field gt-scroll gt-list" role="group" aria-label="Решения">
                {(current.solutions ?? []).map((solution) => {
                    const checked = picks.includes(solution.id);
                    return (
                        <div
                            key={solution.id}
                            className={'gt-item' + (checked ? ' gt-item-checked' : '')}
                            role="checkbox"
                            aria-checked={checked}
                            aria-label={solution.name}
                            tabIndex={0}
                            onClick={() => toggle(solution.id)}
                            onKeyDown={(event) => {
                                if (event.key === ' ' || event.key === 'Enter') {
                                    event.preventDefault();
                                    toggle(solution.id);
                                }
                            }}
                        >
                            <div className="gt-check">{checked && <CheckMark />}</div>
                            <div className="gt-column gt-item-text">
                                <p>
                                    <b>{solution.name}</b>
                                </p>
                                <p>{solution.description}</p>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );

    const renderText = (current: GradeTask) => (
        <div className="gt-column gt-grow">
            <p>
                Опишите, какими решениями вы устраните проблемы инцидента и почему. Пишите по существу: что именно
                меняется и как это работает.
                {current.answer.side_effects &&
                    ' Учтите особенности продукта и то, как решения скажутся на соседних элементах экрана.'}
                {current.answer.crutches &&
                    ` Опирайтесь на документы к наблюдениям: причина видна в них. ${CRUTCH_RULE}`}
            </p>
            <textarea
                className="gt-textarea"
                style={{ marginTop: 8 }}
                value={text}
                maxLength={current.limits.text}
                onChange={(event) => setText(event.target.value)}
                aria-label="Описание решений"
            />
            <div className="gt-row" style={{ marginTop: 6 }}>
                <span className="gt-counter gt-muted">
                    {text.length} / {current.limits.text}
                </span>
            </div>
        </div>
    );

    const renderCode = (current: GradeTask) => (
        <div className="gt-column gt-grow">
            <p>
                {current.answer.select
                    ? 'Напишите код выбранных решений для этого эндпоинта.'
                    : 'Напишите код предложенных решений для этого эндпоинта.'}{' '}
                Фреймворк и хранилища — на ваш выбор, пользоваться нейросетью можно.
            </p>
            <div className="gt-row" style={{ marginTop: 8, marginBottom: 8 }}>
                <label htmlFor="grade-tasks-language" style={{ marginRight: 8 }}>
                    Язык:
                </label>
                <select
                    id="grade-tasks-language"
                    className="gt-select"
                    value={language}
                    onChange={(event) => setLanguage(event.target.value)}
                >
                    <option value="">— выберите —</option>
                    {(current.languages ?? []).map((name) => (
                        <option key={name} value={name}>
                            {name}
                        </option>
                    ))}
                </select>
                <span className="gt-counter gt-muted">
                    {code.length} / {current.limits.code}
                </span>
            </div>
            <textarea
                className="gt-textarea gt-code"
                value={code}
                maxLength={current.limits.code}
                spellCheck={false}
                wrap="off"
                onChange={(event) => setCode(event.target.value)}
                onKeyDown={onCodeKeyDown}
                aria-label="Код"
            />
        </div>
    );

    const statusLine = (current: GradeTask): string => {
        if (notice) return notice;
        if (tab === 'incident') {
            return current.artifacts?.length
                ? 'Прочитайте наблюдения и документы к ним, затем перейдите к решениям.'
                : 'Прочитайте наблюдения и перейдите к решениям.';
        }
        if (tab === 'docs') {
            return `Документ ${docIndex(current) + 1} из ${current.artifacts?.length ?? 0}. Стрелки ↑ ↓ — соседний документ.`;
        }
        if (tab === 'answer' && current.answer.select) {
            const max = current.answer.max_select;
            return `Отмечено решений: ${picks.length}${max ? ` из ${max}` : ''}`;
        }
        if (tab === 'code') return language ? `Язык: ${language}` : 'Язык не выбран';
        return '';
    };

    const renderTask = (current: GradeTask) => (
        <>
            <div className="gt-header">
                {props.image && <img src={props.image} alt="" />}
                <div className="gt-column">
                    <p className="gt-title">
                        Тест на грейд {current.grade} · {current.specialization}
                    </p>
                    <p className="gt-muted">{howToAnswer(current)}</p>
                </div>
            </div>
            <div className="gt-tabs" role="tablist">
                {tabs.map((item) => (
                    <div
                        key={item.id}
                        role="tab"
                        aria-selected={item.id === tab}
                        tabIndex={0}
                        onKeyDown={(event) => {
                            if (event.key === ' ' || event.key === 'Enter') {
                                event.preventDefault();
                                setTab(item.id);
                            }
                        }}
                        className={
                            'gt-tab' + (item.id === tab ? ' gt-tab-active' : '') + (item.filled ? ' gt-tab-filled' : '')
                        }
                        onMouseDown={() => setTab(item.id)}
                    >
                        <span>{item.label}</span>
                    </div>
                ))}
            </div>
            <div className="gt-panel">
                {tab === 'incident' && renderIncident(current)}
                {tab === 'docs' && renderDocs(current)}
                {tab === 'answer' && (current.answer.select ? renderSolutions(current) : renderText(current))}
                {tab === 'code' && renderCode(current)}
            </div>
            <div className="gt-footer">
                <p className="gt-status">{statusLine(current)}</p>
                {tabIndex > 0 && (
                    <button className="site-button" onClick={() => setTab(tabs[tabIndex - 1].id)}>
                        &lt; Назад
                    </button>
                )}
                {tabIndex < tabs.length - 1 ? (
                    <button className="site-button gt-default" onClick={() => setTab(tabs[tabIndex + 1].id)}>
                        Далее &gt;
                    </button>
                ) : (
                    <button className="site-button gt-default" onClick={askToSend}>
                        Отправить
                    </button>
                )}
            </div>
        </>
    );

    const renderWaiting = (title: string, hint: string) => (
        <div className="gt-center">
            <p className="gt-title">{title}</p>
            <p className="gt-muted" style={{ marginTop: 6, textAlign: 'center' }}>
                {hint}
            </p>
            <div className="gt-progress" style={{ marginTop: 18, maxWidth: 440 }}>
                <div className="gt-progress-fill" style={{ width: `${progress}%` }} />
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
                {error.action && (
                    <button className="site-button gt-default" onClick={() => retry.current()}>
                        {error.action}
                    </button>
                )}
                <button className={'site-button' + (error.action ? '' : ' gt-default')} onClick={props.onClose}>
                    Закрыть
                </button>
            </div>
        </>
    );

    const renderStart = (known: GradeProfile, picked: { specialization: string; grade: Grade }) => {
        const { declared, computed, recommended, tests } = known;
        const isRecommended =
            picked.specialization === recommended.specialization && picked.grade === recommended.grade;
        const declaredOn = formatDate(declared?.created_at);
        return (
            <>
                <div className="gt-header">
                    {props.image && <img src={props.image} alt="" />}
                    <div className="gt-column">
                        <p className="gt-title">Тест на грейд</p>
                        <p className="gt-muted">
                            Мы вычислили вашу специализацию и грейд, но решать можно задачи любой специализации и
                            любого грейда.
                        </p>
                    </div>
                </div>
                <div className="gt-panel gt-scroll">
                    <div className="gt-group" style={{ marginTop: 6 }}>
                        <span className="gt-group-label">Что мы о вас знаем</span>
                        {declared ? (
                            <>
                                <p>
                                    Специализация: <b>{declared.specialization}</b> —{' '}
                                    {declared.source === 'LLM' ? 'распознана по вашему резюме' : 'выбрана вами'}
                                    {declaredOn && `, ${declaredOn}`}.
                                </p>
                                <p>
                                    Заявленный грейд: <b>{declared.grade}</b>.
                                </p>
                                {tests.length > 0 ? (
                                    <>
                                        <p style={{ marginTop: 6 }}>
                                            Ваши тесты по {declared.specialization}, новые первыми:
                                        </p>
                                        <ul className="gt-facts">
                                            {tests.slice(0, TESTS_SHOWN).map((test, i) => (
                                                <li key={i}>
                                                    {test.grade} —{' '}
                                                    {test.passed
                                                        ? test.credited
                                                            ? 'засчитан в тестовой версии'
                                                            : 'пройден'
                                                        : 'не пройден'}
                                                    {formatDate(test.created_at) && `, ${formatDate(test.created_at)}`}
                                                </li>
                                            ))}
                                        </ul>
                                        {tests.length > TESTS_SHOWN && (
                                            <p className="gt-muted">И ещё {tests.length - TESTS_SHOWN} раньше.</p>
                                        )}
                                    </>
                                ) : (
                                    <p style={{ marginTop: 6 }}>Тестов по {declared.specialization} ещё не было.</p>
                                )}
                            </>
                        ) : (
                            <p>Специализации в профиле нет: вы не загружали резюме и не выбирали её сами.</p>
                        )}
                        {computed && (
                            <p style={{ marginTop: 6 }}>
                                Вычислено:{' '}
                                <b>
                                    {computed.specialization} · {computed.grade}
                                </b>{' '}
                                —{' '}
                                {computed.confirmed
                                    ? 'грейд подтверждён пройденным тестом'
                                    : 'грейд заявлен, пройденным тестом пока не подтверждён'}
                                .
                            </p>
                        )}
                        <p style={{ marginTop: 6 }}>
                            Рекомендуем тест{' '}
                            <b>
                                {recommended.specialization} · {recommended.grade}
                            </b>
                            : {basisText(known)}.
                        </p>
                    </div>
                    <div className="gt-group" style={{ marginTop: 18 }}>
                        <span className="gt-group-label">Какой тест решать</span>
                        <p>
                            Чтобы жюри хакатона было проще оценить задачи, можно выбрать любую специализацию и любой
                            грейд, а не только рекомендованные.
                        </p>
                        <div className="gt-row gt-choice">
                            <label htmlFor="grade-tasks-specialization">Специализация:</label>
                            <select
                                id="grade-tasks-specialization"
                                className="gt-select"
                                value={picked.specialization}
                                onChange={(event) => setChoice({ ...picked, specialization: event.target.value })}
                            >
                                {known.specializations.map((name) => (
                                    <option key={name} value={name}>
                                        {name}
                                    </option>
                                ))}
                            </select>
                            <label htmlFor="grade-tasks-grade">Грейд:</label>
                            <select
                                id="grade-tasks-grade"
                                className="gt-select gt-select-short"
                                value={picked.grade}
                                onChange={(event) => setChoice({ ...picked, grade: event.target.value as Grade })}
                            >
                                {known.grades.map((name) => (
                                    <option key={name} value={name}>
                                        {name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <p className="gt-muted" style={{ marginTop: 8 }}>
                            {gradeRule(known, picked.specialization, picked.grade)}
                        </p>
                    </div>
                </div>
                <div className="gt-footer">
                    <p className="gt-status">
                        {isRecommended
                            ? 'Выбран рекомендуемый тест.'
                            : `Рекомендуем ${recommended.specialization} · ${recommended.grade}, но выбор за вами.`}
                    </p>
                    <button className="site-button" onClick={() => setPresenting(true)}>
                        Презентация
                    </button>
                    <button
                        className="site-button gt-default"
                        onClick={() => load(picked.specialization, picked.grade)}
                    >
                        Начать тест
                    </button>
                    <button className="site-button" onClick={props.onClose}>
                        Закрыть
                    </button>
                </div>
            </>
        );
    };

    const renderResult = (current: GradeTask, checked: GradeResult) => {
        // Засчитанный тест — как пройденный, но вердикты по проблемам остаются настоящими.
        const passed = checked.passed || !!credited;
        const next = credited ? credited.next_grade : checked.next_grade;
        const nextIsSame = next === checked.grade;
        const offer = passed
            ? nextIsSame
                ? 'Это высший грейд. Можно пройти тест ещё раз.'
                : `Следующий шаг — тест на грейд ${next}.`
            : nextIsSame
            ? 'Это начальный грейд. Попробуйте пройти тест ещё раз.'
            : `Попробуйте тест на грейд ${next}.`;
        const checks = [
            checked.checks.procedural ? 'выбор сверен со справочником' : '',
            checked.checks.llm ? `нейросеть ${checked.checks.llm.llm} (${checked.checks.llm.model})` : '',
        ].filter(Boolean);
        return (
            <>
                <div className="gt-header">
                    <SignIcon sign={passed ? 'ok' : 'error'} />
                    <div className="gt-column" style={{ marginLeft: 12 }}>
                        <p className="gt-title">
                            {credited ? 'Решение засчитано' : checked.passed ? 'Тест пройден' : 'Тест не пройден'}
                        </p>
                        <p className="gt-muted">
                            {checked.specialization} · {checked.grade}
                            {credited && ' · засчитано в тестовой версии, грейд подтверждён'}
                        </p>
                    </div>
                </div>
                <div className="gt-panel">
                    <div className="gt-field gt-scroll gt-grow">
                        {checked.problems.map((problem) => {
                            const solution = problem.status ? SOLUTION_BADGES[problem.status] : null;
                            const codeBadge = problem.code ? CODE_BADGES[problem.code] : null;
                            return (
                                <div className="gt-result-row gt-column" key={problem.n}>
                                    <div className="gt-row">
                                        <span className="gt-symptom-number">{problem.n}.</span>
                                        {solution && (
                                            <span className={`gt-badge gt-badge-${solution[1]}`}>{solution[0]}</span>
                                        )}
                                        {codeBadge && (
                                            <span className={`gt-badge gt-badge-${codeBadge[1]}`}>{codeBadge[0]}</span>
                                        )}
                                    </div>
                                    <p className="gt-muted" style={{ fontSize: 14, marginTop: 4 }}>
                                        {current.symptoms[problem.n - 1]}
                                    </p>
                                    {problem.comment && <p style={{ marginTop: 4 }}>{problem.comment}</p>}
                                </div>
                            );
                        })}
                    </div>
                    {checked.extra !== null && checked.extra > 0 && (
                        <p style={{ marginTop: 8 }}>
                            Лишних решений в выборе: {checked.extra}
                            {checked.max_extra !== null ? ` (допускается не больше ${checked.max_extra})` : ''}.
                        </p>
                    )}
                    {checked.code_skipped && (
                        <p style={{ marginTop: 8 }}>Код не проверялся: выбор решений не прошёл.</p>
                    )}
                    {checked.summary && <p style={{ marginTop: 8 }}>{checked.summary}</p>}
                    <p className="gt-muted" style={{ marginTop: 8, fontSize: 14 }}>
                        Проверка: {checks.join('; ')}.
                    </p>
                    {checked.can_credit && !credited && (
                        <div className="gt-row" style={{ marginTop: 10 }}>
                            <button
                                className="site-button gt-credit"
                                onClick={() => credit(checked)}
                                disabled={crediting}
                            >
                                {crediting ? 'Засчитываем…' : 'Засчитать решение задачи (только для тестовой версии)'}
                            </button>
                        </div>
                    )}
                </div>
                <div className="gt-footer">
                    <p className="gt-status">{offer}</p>
                    <button className="site-button gt-default" onClick={() => load(checked.specialization, next)}>
                        Тест на {next}
                    </button>
                    <button className="site-button" onClick={loadProfile}>
                        Другой тест
                    </button>
                    <button className="site-button" onClick={props.onClose}>
                        Закрыть
                    </button>
                </div>
            </>
        );
    };

    // Экран окна по стадии теста. Пока открыта презентация, окно показывает её.
    const renderStage = () => (
        <>
            {stage === 'loading' &&
                (loading === 'profile'
                    ? renderWaiting('Узнаём, кто вы…', 'Сервер смотрит вашу специализацию и прошлые тесты.')
                    : renderWaiting('Подбираем задание…', 'Сервер собирает инцидент для выбранного грейда.'))}
            {stage === 'error' && renderError()}
            {stage === 'start' && profile && choice && renderStart(profile, choice)}
            {stage === 'task' && task && renderTask(task)}
            {stage === 'checking' &&
                renderWaiting(
                    'Проверяем ответ…',
                    usesLlm
                        ? 'Ответ проверяет нейросеть — это может занять до трёх минут. Не закрывайте окно.'
                        : 'Сверяем выбранные решения со справочником.'
                )}
            {stage === 'result' && task && result && renderResult(task, result)}
        </>
    );

    return (
        <Window
            top={16}
            left={40}
            width={size.width}
            height={size.height}
            windowTitle={props.title}
            windowBarImage={props.image}
            windowBarIcon="windowExplorerIcon"
            closeWindow={props.onClose}
            onInteract={props.onInteract}
            minimizeWindow={minimize}
            bottomLeftText={
                presenting
                    ? 'Презентация'
                    : task && (stage === 'task' || stage === 'checking' || stage === 'result')
                    ? `${task.specialization} · ${task.grade}`
                    : ''
            }
        >
            <div className="grade-tasks">
                {presenting ? (
                    <Presentation
                        source={GRADE_TASKS_PRESENTATION}
                        onClose={() => setPresenting(false)}
                        pauseRequest={presentationPauses}
                    />
                ) : (
                    renderStage()
                )}
                {dialog && (
                    <div className="gt-modal">
                        <div className="gt-dialog" role="alertdialog" aria-modal="true" aria-label={dialog.title}>
                            <div className="gt-dialog-title">
                                <span>{dialog.title}</span>
                            </div>
                            <div className="gt-dialog-body">
                                <SignIcon sign={dialog.sign} />
                                <p style={{ marginLeft: 16, flex: 1 }}>{dialog.text}</p>
                            </div>
                            <div className="gt-dialog-buttons">
                                {dialog.buttons.map((button) => (
                                    <button
                                        key={button.text}
                                        className={'site-button' + (button.primary ? ' gt-default' : '')}
                                        onClick={button.onClick}
                                        autoFocus={button.primary}
                                    >
                                        {button.text}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </Window>
    );
};

export default GradeTasks;
