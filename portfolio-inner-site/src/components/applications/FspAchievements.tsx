import React, { useCallback, useEffect, useRef, useState } from 'react';
import Window from '../os/Window';
import { ApiError, currentUserId } from '../../api';
import {
    decideFsp,
    fetchFspState,
    FSP_ID_MASK,
    FspChange,
    FspCompetency,
    FspCompetition,
    FspDraft,
    FspState,
    linkFsp,
    normalizeFspId,
    saveFsp,
} from '../../fsp';
import FspSequence from './FspSequence';
import { SignIcon } from './GradeTasks';
import './GradeTasks.css';
import './FspAchievements.css';

// «Достижения в ФСП» — окно значка id 1 на рабочем столе: связка профиля
// ITinder с профилем участника ФСП (имитация, см. fsp.ts).
// Профиль не связан: пользователь вводит ФСП ID по маске FSP-0000-0000, окно
// показывает диаграмму последовательности — как это работало бы с настоящим
// ФСП через Keycloak (FspSequence.tsx, её можно пропустить и посмотреть снова
// кнопкой «Как это работает»), потом соревнования, которые «нашёл» реестр,
// и предлагает дополнить профиль подтверждёнными компетенциями.
// Профиль связан: компетенции со степенью подтверждения и соревнования.
// Через заданное время после связки «случаются» будущие соревнования — окно
// сообщает о них и предлагает добавить в профиль или отказаться.
// Каждое изменение записи окно сообщает рабочему столу (onAlertsChange):
// тот заново спрашивает значки, и тревога у значка снимается.
//   loading — сервер отдаёт состояние; error — не отдал; enter — ввод ФСП ID;
//   linking — сервер ищет соревнования; story — диаграмма при связке;
//   found — найденное и вопрос, дополнить ли профиль; saving — запись;
//   profile — связанный профиль; review — новые соревнования; deciding — запись решения.
type Stage = 'loading' | 'error' | 'enter' | 'linking' | 'story' | 'found' | 'saving' | 'profile' | 'review' | 'deciding';
type Sign = 'ok' | 'error' | 'info' | 'question';

export interface FspAchievementsProps extends WindowAppProps {
    title: string; // подпись значка
    image?: string; // картинка значка
    onAlertsChange: () => void; // запись изменилась — значки рабочего стола загрузить заново
}

interface Dialog {
    sign: Sign;
    title: string;
    text: string;
    buttons: { text: string; onClick: () => void; primary?: boolean }[];
}

const NO_USER = 'Не удалось узнать, кто вы. Войдите в ITinder и откройте окно снова.';
const MONTHS = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const FORMAT_NAMES: { [format in FspCompetition['format']]: string } = {
    hackathon: 'хакатон',
    championship: 'чемпионат',
    marathon: 'марафон',
};
const LEVEL_NAMES: { [level in FspCompetition['level']]: string } = {
    regional: 'региональный',
    interregional: 'межрегиональный',
    national: 'всероссийский',
    international: 'международный',
};
const KIND_TITLES: { [kind in FspCompetency['kind']]: string } = {
    languages: 'Языки',
    databases: 'СУБД',
    integrations: 'Способы интеграции',
    testing: 'Тестирование',
};
const KIND_ORDER: FspCompetency['kind'][] = ['languages', 'databases', 'integrations', 'testing'];

function plural(count: number, one: string, few: string, many: string): string {
    const tens = count % 100;
    const units = count % 10;
    if (units === 1 && tens !== 11) return one;
    if (units >= 2 && units <= 4 && (tens < 12 || tens > 14)) return few;
    return many;
}

const competitionsWord = (count: number) => plural(count, 'соревнование', 'соревнования', 'соревнований');
const pointsWord = (count: number) => plural(count, 'балл', 'балла', 'баллов');

// «12–14 апреля 2024», «2 сентября — 12 октября 2024».
function dateRange(start: string, end: string): string {
    const [y1, m1, d1] = start.split('-').map(Number);
    const [y2, m2, d2] = end.split('-').map(Number);
    if (y1 === y2 && m1 === m2) return `${d1}–${d2} ${MONTHS[m2 - 1]} ${y2}`;
    if (y1 === y2) return `${d1} ${MONTHS[m1 - 1]} — ${d2} ${MONTHS[m2 - 1]} ${y2}`;
    return `${d1} ${MONTHS[m1 - 1]} ${y1} — ${d2} ${MONTHS[m2 - 1]} ${y2}`;
}

function formatMoment(iso: string | null): string {
    const date = new Date(iso ?? '');
    if (Number.isNaN(date.getTime())) return '';
    const day = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    return `${day}, ${date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}

// Фраза из справочника — продолжением предложения: первая буква строчная,
// если это не аббревиатура («API рейсов» так и остаётся).
function continuing(text: string): string {
    return /^[A-ZА-ЯЁ]{2}/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

function venue(competition: FspCompetition): string {
    if (competition.venue === 'online') return 'онлайн';
    if (competition.venue === 'hybrid') return `онлайн и очно, ${competition.city}`;
    return competition.city ?? 'очно';
}

// «4 мин 05 с» до следующего соревнования имитации.
function countdown(seconds: number): string {
    const total = Math.max(0, Math.ceil(seconds));
    const minutes = Math.floor(total / 60);
    const rest = String(total % 60).padStart(2, '0');
    return minutes ? `${minutes} мин ${rest} с` : `${total % 60} с`;
}

// Что сказать об ошибке запроса и можно ли повторить: 4xx — повтор не поможет.
function errorOf(failure: unknown, fallback: string): { message: string; status: number } {
    return {
        message: failure instanceof ApiError ? failure.message : fallback,
        status: failure instanceof ApiError ? failure.status : 500,
    };
}

// Степень подтверждения: три деления, закрашено столько, какая степень.
const Meter: React.FC<{ degree: number; name: string }> = ({ degree, name }) => (
    <span className="fsp-meter" title={`Степень подтверждения: ${name}`}>
        {[1, 2, 3].map((step) => (
            <span key={step} className={'fsp-meter-cell' + (step <= degree ? ' fsp-meter-on' : '')} />
        ))}
    </span>
);

const FspAchievements: React.FC<FspAchievementsProps> = (props) => {
    const { onAlertsChange } = props;
    const [userId] = useState(currentUserId);
    const [size] = useState(() => ({
        width: Math.max(600, Math.min(1000, window.innerWidth - 80)),
        height: Math.max(460, Math.min(780, window.innerHeight - 70)),
    }));
    const [stage, setStage] = useState<Stage>('loading');
    const [error, setError] = useState<{ message: string; action: string | null }>({ message: '', action: null });
    const [state, setState] = useState<FspState | null>(null);
    const [fetchedAt, setFetchedAt] = useState(0); // когда получено state: от него считается recheck_after
    const [draft, setDraft] = useState<FspDraft | null>(null);
    const [input, setInput] = useState('');
    const [notice, setNotice] = useState('');
    const [dialog, setDialog] = useState<Dialog | null>(null);
    // Повтор диаграммы кнопкой «Как это работает»: на какой экран вернуться.
    const [replayFrom, setReplayFrom] = useState<Stage | null>(null);
    const [storyPauses, setStoryPauses] = useState(0);
    const [now, setNow] = useState(Date.now());
    const retry = useRef<() => void>(() => {});
    const inputRef = useRef<HTMLInputElement>(null);

    const closeDialog = () => setDialog(null);

    const fail = (failure: unknown, fallback: string, again: () => void, action = 'Повторить') => {
        const { message, status } = errorOf(failure, fallback);
        retry.current = again;
        setError({ message, action: status === 0 || status >= 500 ? action : null });
        setStage('error');
    };

    // Новые соревнования после связки: сообщить и предложить посмотреть.
    const announce = useCallback((next: FspState) => {
        const count = next.pending?.competitions.length ?? 0;
        if (!count) return;
        setDialog({
            sign: 'info',
            title: 'Новые соревнования',
            text: `Реестр ФСП сообщил: найдено ${count} ${count === 1 ? 'новое' : 'новых'} ${competitionsWord(
                count
            )} с вашим участием. Посмотреть и дополнить профиль новыми компетенциями?`,
            buttons: [
                {
                    text: 'Посмотреть',
                    primary: true,
                    onClick: () => {
                        setDialog(null);
                        setStage('review');
                    },
                },
                { text: 'Позже', onClick: () => setDialog(null) },
            ],
        });
    }, []);

    const show = useCallback(
        (next: FspState) => {
            setState(next);
            setFetchedAt(Date.now());
            setStage(next.linked ? 'profile' : 'enter');
            if (next.linked) announce(next);
        },
        [announce]
    );

    const load = useCallback(async () => {
        setDialog(null);
        setStage('loading');
        if (!userId) {
            setError({ message: NO_USER, action: null });
            setStage('error');
            return;
        }
        try {
            show(await fetchFspState(userId));
        } catch (failure) {
            const { message, status } = errorOf(failure, 'Не удалось узнать, связан ли профиль с ФСП');
            retry.current = () => load();
            setError({ message, action: status === 0 || status >= 500 ? 'Повторить' : null });
            setStage('error');
        }
    }, [userId, show]);

    useEffect(() => {
        load();
    }, [load]);

    // Обратный отсчёт до следующего соревнования имитации; дошёл — спросить сервер.
    const remaining = state?.recheck_after != null ? state.recheck_after - (now - fetchedAt) / 1000 : null;
    useEffect(() => {
        if (stage !== 'profile' || remaining === null) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [stage, remaining === null]); // eslint-disable-line react-hooks/exhaustive-deps

    const refreshing = useRef(false);
    useEffect(() => {
        if (stage !== 'profile' || remaining === null || remaining > 0 || refreshing.current || !userId) return;
        refreshing.current = true;
        fetchFspState(userId)
            .then((next) => {
                show(next);
                onAlertsChange();
            })
            // Не вышло — отсчёт стоит на нуле, тревогу у значка рабочий стол поставит сам.
            .catch(() => {})
            .finally(() => {
                refreshing.current = false;
            });
    }, [stage, remaining, userId, show, onAlertsChange]);

    const minimize = () => {
        setStoryPauses((count) => count + 1);
        props.onMinimize();
    };

    const submitId = async (event?: React.FormEvent) => {
        event?.preventDefault();
        if (!userId) return;
        const fspId = normalizeFspId(input);
        if (!fspId) {
            setDialog({
                sign: 'error',
                title: 'Неверный ФСП ID',
                text: input.trim()
                    ? `«${input.trim()}» не похоже на ФСП ID. Нужен вид ${FSP_ID_MASK}: латинские буквы FSP, дефис, четыре цифры, дефис и ещё четыре цифры.`
                    : `Введите ФСП ID в виде ${FSP_ID_MASK}.`,
                buttons: [
                    {
                        text: 'OK',
                        primary: true,
                        onClick: () => {
                            setDialog(null);
                            inputRef.current?.focus();
                        },
                    },
                ],
            });
            return;
        }
        setInput(fspId);
        setNotice('');
        setStage('linking');
        try {
            setDraft(await linkFsp(userId, fspId));
            setStage('story');
        } catch (failure) {
            const { message, status } = errorOf(failure, 'Не удалось связаться с реестром ФСП');
            if (status === 409 && /уже связан/.test(message)) {
                load();
                return;
            }
            setStage('enter');
            setDialog({
                sign: 'error',
                title: 'Связка не удалась',
                text: message,
                buttons: [{ text: 'OK', onClick: closeDialog, primary: true }],
            });
        }
    };

    const save = async () => {
        if (!userId || !draft) return;
        setStage('saving');
        try {
            const next = await saveFsp(userId, draft.draft_id);
            setDraft(null);
            show(next);
            onAlertsChange();
        } catch (failure) {
            const { message, status } = errorOf(failure, '');
            if (status === 410) {
                // Черновик пропал: сервер перезапускали или прошло много времени.
                retry.current = () => setStage('enter');
                setError({ message, action: 'Ввести ФСП ID заново' });
                setStage('error');
                return;
            }
            fail(failure, 'Не удалось дополнить профиль', save);
        }
    };

    const decline = () => {
        setDraft(null);
        setNotice('Профиль не дополнен. ФСП ID можно ввести снова в любой момент.');
        setStage('enter');
    };

    const decide = async (add: boolean) => {
        if (!userId || !state?.pending) return;
        setDialog(null);
        setStage('deciding');
        try {
            show(await decideFsp(userId, state.pending.competitions.map((item) => item.id), add));
            onAlertsChange();
        } catch (failure) {
            const { status } = errorOf(failure, '');
            if (status === 409) {
                // Пока окно было открыто, созрело ещё одно соревнование — покажем заново.
                load();
                return;
            }
            fail(failure, 'Не удалось записать решение', () => decide(add));
        }
    };

    const askDecline = () =>
        setDialog({
            sign: 'question',
            title: 'Не добавлять',
            text: 'Не добавлять эти соревнования в профиль? Предлагать их снова мы не будем.',
            buttons: [
                { text: 'Не добавлять', onClick: () => decide(false), primary: true },
                { text: 'Отмена', onClick: closeDialog },
            ],
        });

    const replay = () => {
        setDialog(null);
        setReplayFrom(stage);
        setStage('story');
    };

    // --- Части экранов -------------------------------------------------------

    const renderHeader = (title: string, hint: string) => (
        <div className="gt-header">
            {props.image && <img src={props.image} alt="" />}
            <div className="gt-column">
                <p className="gt-title">{title}</p>
                <p className="gt-muted">{hint}</p>
            </div>
        </div>
    );

    const renderCompetition = (item: FspCompetition) => (
        <div className="fsp-card" key={item.id}>
            <div className="gt-row fsp-card-title">
                <b>{item.name}</b>
                <span className={`gt-badge fsp-result fsp-result-${item.result.id}`}>{item.result.name}</span>
            </div>
            <p className="gt-muted fsp-small">
                {dateRange(item.start_date, item.end_date)} · {LEVEL_NAMES[item.level]} {FORMAT_NAMES[item.format]} ·{' '}
                {venue(item)}
                {item.teams ? ` · ${item.teams} ${plural(item.teams, 'команда', 'команды', 'команд')}` : ''}
            </p>
            <p className="fsp-small">
                <b>Кейс.</b> {item.case_partner} — {continuing(item.task)}.
            </p>
            <p className="fsp-small">
                <b>{item.role.name}:</b> {continuing(item.role.task)}.
            </p>
            <div className="fsp-chips">
                {item.competencies.map((competency) => (
                    <span className="fsp-chip" key={`${competency.kind}-${competency.id}`} title={competency.kind_name}>
                        {competency.name}
                    </span>
                ))}
            </div>
            <p className="gt-muted fsp-small">
                {item.points} {pointsWord(item.points)}: итог {item.result.points} + уровень соревнования {item.level_points}
            </p>
        </div>
    );

    const renderChange = (change: FspChange) => {
        const { before, after } = change;
        const what = !before
            ? `новая — ${after.degree_name}`
            : before.degree !== after.degree
            ? `${before.degree_name} → ${after.degree_name}`
            : `${after.degree_name}, +${after.points - before.points} ${pointsWord(after.points - before.points)}`;
        const badge = !before ? 'fsp-change-new' : before.degree !== after.degree ? 'fsp-change-up' : 'fsp-change-same';
        return (
            <div className="fsp-line" key={`${change.kind}-${change.id}`}>
                <span className="fsp-line-name">
                    {change.name} <span className="gt-muted fsp-small">· {change.kind_name.toLowerCase()}</span>
                </span>
                <Meter degree={after.degree} name={after.degree_name} />
                <span className={`gt-badge fsp-change ${badge}`}>{what}</span>
            </div>
        );
    };

    const renderCompetencies = (items: FspCompetency[]) =>
        KIND_ORDER.filter((kind) => items.some((item) => item.kind === kind)).map((kind) => (
            <div className="gt-column fsp-kind" key={kind}>
                <p className="fsp-kind-title">{KIND_TITLES[kind]}</p>
                {items
                    .filter((item) => item.kind === kind)
                    .map((item) => (
                        <div className="fsp-line" key={item.id}>
                            <span className="fsp-line-name">{item.name}</span>
                            <Meter degree={item.degree} name={item.degree_name} />
                            <span className="fsp-degree-name">{item.degree_name}</span>
                            <span className="gt-muted fsp-small fsp-line-points">
                                {item.points} {pointsWord(item.points)} · {item.competitions.length}{' '}
                                {competitionsWord(item.competitions.length)}
                            </span>
                        </div>
                    ))}
            </div>
        ));

    // --- Экраны --------------------------------------------------------------

    const renderWaiting = (title: string, hint: string) => (
        <div className="gt-center">
            <p className="gt-title">{title}</p>
            <p className="gt-muted" style={{ marginTop: 6, textAlign: 'center' }}>
                {hint}
            </p>
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

    const renderEnter = (known: FspState) => (
        <form className="fsp-form" onSubmit={submitId} noValidate>
            {renderHeader(
                'Связать профиль с ФСП',
                'Подтвердите компетенции результатами соревнований Федерации спортивного программирования.'
            )}
            <div className="gt-panel gt-scroll">
                <div className="gt-group" style={{ marginTop: 6 }}>
                    <span className="gt-group-label">ФСП ID</span>
                    <p>Идентификатор участника есть в личном кабинете ФСП.</p>
                    <div className="gt-row" style={{ marginTop: 10 }}>
                        <label htmlFor="fsp-id" style={{ marginRight: 10 }}>
                            ФСП ID:
                        </label>
                        <input
                            id="fsp-id"
                            ref={inputRef}
                            className="fsp-input"
                            value={input}
                            placeholder={known.mask}
                            maxLength={24}
                            spellCheck={false}
                            autoComplete="off"
                            autoFocus
                            onChange={(event) => setInput(event.target.value)}
                        />
                        <span className="gt-muted fsp-small" style={{ marginLeft: 12 }}>
                            Вид: <span className="fsp-mono">{known.mask}</span>
                        </span>
                    </div>
                    <p style={{ marginTop: 10 }}>
                        {known.role ? (
                            <>
                                Роль в команде — <b>{known.role.name}</b>: по вашей специализации{' '}
                                {known.role.specialization}. Искать будем соревнования, где была такая роль.
                            </>
                        ) : (
                            'Специализация соискателя не выбрана — связать профиль не получится.'
                        )}
                    </p>
                </div>
                <div className="gt-group" style={{ marginTop: 18 }}>
                    <span className="gt-group-label">Как это устроено</span>
                    <ul className="gt-facts">
                        <li>Вход через ФСП ID (Keycloak Федерации): пароль от ФСП ITinder не видит.</li>
                        <li>Из реестра ФСП приходят соревнования: ваша роль в команде, итог и стек кейса.</li>
                        <li>Стек становится компетенциями, итог и уровень соревнования — степенью их подтверждения.</li>
                        <li>Добавлять ли их в профиль, решаете вы. Новые соревнования ITinder найдёт сам.</li>
                    </ul>
                    <p className="gt-muted fsp-small" style={{ marginTop: 8 }}>
                        Прототип: настоящего ФСП ID ещё нет, поэтому проверяется только вид идентификатора, а реестр ФСП
                        имитируется — соревнования и итоги выбираются случайно.
                    </p>
                </div>
            </div>
            <div className="gt-footer">
                <p className="gt-status">{notice || 'Введите ФСП ID и нажмите «Связать».'}</p>
                <button type="submit" className="site-button gt-default">
                    Связать
                </button>
                <button type="button" className="site-button" onClick={props.onClose}>
                    Закрыть
                </button>
            </div>
        </form>
    );

    const renderFound = (found: FspDraft) => {
        const count = found.competitions.length;
        return (
            <>
                {renderHeader(
                    `Реестр ФСП: ${count} ${competitionsWord(count)} с вашим участием`,
                    `ФСП ID ${found.fsp_id} · роль в команде: ${found.role.name}`
                )}
                <div className="gt-panel gt-scroll">
                    <div className="gt-group" style={{ marginTop: 6 }}>
                        <span className="gt-group-label">Соревнования</span>
                        {found.competitions.map(renderCompetition)}
                    </div>
                    <div className="gt-group" style={{ marginTop: 18 }}>
                        <span className="gt-group-label">Компетенции, которые подтвердятся</span>
                        {found.changes.map(renderChange)}
                    </div>
                </div>
                <div className="gt-footer">
                    <p className="gt-status">Дополнить профиль подтверждёнными компетенциями?</p>
                    <button className="site-button" onClick={replay}>
                        Как это работает
                    </button>
                    <button className="site-button gt-default" onClick={save}>
                        Дополнить профиль
                    </button>
                    <button className="site-button" onClick={decline}>
                        Не сейчас
                    </button>
                </div>
            </>
        );
    };

    const renderProfile = (known: FspState) => {
        const pending = known.pending?.competitions.length ?? 0;
        return (
            <>
                {renderHeader(
                    'Профиль связан с ФСП',
                    `ФСП ID ${known.fsp_id} · связан ${formatMoment(known.linked_at)} · роль: ${known.role?.name ?? '—'}`
                )}
                <div className="gt-panel gt-scroll">
                    <div className="gt-group" style={{ marginTop: 6 }}>
                        <span className="gt-group-label">Подтверждённые компетенции</span>
                        {known.competencies.length ? (
                            renderCompetencies(known.competencies)
                        ) : (
                            <p>Подтверждённых компетенций пока нет.</p>
                        )}
                        <p className="gt-muted fsp-small" style={{ marginTop: 8 }}>
                            Степень подтверждения — по сумме баллов соревнований, где компетенция применялась: базовая от
                            1 балла, уверенная от 3, высокая от 6. Балл соревнования — итог (решение 1, призовое место 2,
                            победа 3) плюс уровень (межрегиональное 1, всероссийское и международное 2).
                        </p>
                    </div>
                    <div className="gt-group" style={{ marginTop: 18 }}>
                        <span className="gt-group-label">Соревнования в профиле</span>
                        {known.competitions.map(renderCompetition)}
                        {known.declined.length > 0 && (
                            <p className="gt-muted fsp-small" style={{ marginTop: 6 }}>
                                Не добавлены по вашему решению: {known.declined.map((item) => item.name).join(', ')}.
                            </p>
                        )}
                    </div>
                </div>
                <div className="gt-footer">
                    <p className="gt-status">
                        {pending
                            ? `Найдены новые соревнования с вашим участием: ${pending}.`
                            : remaining !== null
                            ? `Имитация: следующее соревнование с вашим участием — через ${countdown(remaining)}.`
                            : 'Имитация: все будущие соревнования уже прошли.'}
                    </p>
                    <button className="site-button" onClick={replay}>
                        Как это работает
                    </button>
                    {pending > 0 && (
                        <button className="site-button gt-default" onClick={() => setStage('review')}>
                            Посмотреть
                        </button>
                    )}
                    <button className={'site-button' + (pending ? '' : ' gt-default')} onClick={props.onClose}>
                        Закрыть
                    </button>
                </div>
            </>
        );
    };

    const renderReview = (known: FspState) => {
        const news = known.pending;
        if (!news) return null;
        const count = news.competitions.length;
        return (
            <>
                {renderHeader(
                    `Новые соревнования с вашим участием: ${count}`,
                    'Реестр ФСП сообщил об итогах после связки профилей. Добавить их в профиль?'
                )}
                <div className="gt-panel gt-scroll">
                    <div className="gt-group" style={{ marginTop: 6 }}>
                        <span className="gt-group-label">{count === 1 ? 'Новое соревнование' : 'Новые соревнования'}</span>
                        {news.competitions.map(renderCompetition)}
                    </div>
                    <div className="gt-group" style={{ marginTop: 18 }}>
                        <span className="gt-group-label">Что изменится в профиле</span>
                        {news.changes.map(renderChange)}
                    </div>
                </div>
                <div className="gt-footer">
                    <p className="gt-status">Новые компетенции и рост степени старых.</p>
                    <button className="site-button gt-default" onClick={() => decide(true)}>
                        Добавить в профиль
                    </button>
                    <button className="site-button" onClick={askDecline}>
                        Не добавлять
                    </button>
                    <button className="site-button" onClick={() => setStage('profile')}>
                        Позже
                    </button>
                </div>
            </>
        );
    };

    const storyId = draft?.fsp_id ?? state?.fsp_id ?? normalizeFspId(input) ?? FSP_ID_MASK;

    const renderStage = () => {
        switch (stage) {
            case 'loading':
                return renderWaiting('Проверяем связку с ФСП…', 'Сервер смотрит, связан ли ваш профиль.');
            case 'error':
                return renderError();
            case 'enter':
                return state && renderEnter(state);
            case 'linking':
                return renderWaiting('Связываемся с ФСП…', 'Реестр ФСП ищет соревнования с вашим участием.');
            case 'story':
                return (
                    <FspSequence
                        fspId={storyId}
                        mode={replayFrom ? 'replay' : 'link'}
                        pauseRequest={storyPauses}
                        onDone={() => {
                            setStage(replayFrom ?? 'found');
                            setReplayFrom(null);
                        }}
                    />
                );
            case 'found':
                return draft && renderFound(draft);
            case 'saving':
                return renderWaiting('Дополняем профиль…', 'Записываем соревнования и компетенции.');
            case 'profile':
                return state && renderProfile(state);
            case 'review':
                return state && renderReview(state);
            case 'deciding':
                return renderWaiting('Записываем решение…', 'Обновляем соревнования и компетенции в профиле.');
        }
    };

    return (
        <Window
            top={24}
            left={64}
            width={size.width}
            height={size.height}
            windowTitle={props.title}
            windowBarImage={props.image}
            windowBarIcon="windowExplorerIcon"
            closeWindow={props.onClose}
            onInteract={props.onInteract}
            minimizeWindow={minimize}
            bottomLeftText={stage === 'story' ? 'Как это работает' : state?.fsp_id ?? ''}
        >
            <div className="grade-tasks fsp-achievements">
                {renderStage()}
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

export default FspAchievements;
