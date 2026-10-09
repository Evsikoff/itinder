import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchStory, isNote, Story, StoryArrow, StoryMessage, StoryNote } from '../../fsp';

// Диаграмма последовательности в окне «Достижения в ФСП»: как ITinder
// связывался бы с настоящим ФСП через Keycloak и узнавал о новых итогах.
// Сценарий — app/assets/presentation/fsp_link/scenes.json (fsp.ts). Схема
// рисуется кодом: сверху участники, от них линии жизни, сцена за сценой
// вниз прорисовываются стрелки — под речь диктора, а пока записи нет, в темпе
// чтения текста. Прошлые сцены остаются серыми выше, схема прокручивается
// за последней стрелкой. Щелчок по схеме и пробел — пауза, ← → — соседняя
// сцена. После последней сцены диаграмма стоит.
//   loading — речь грузится; playing — идёт; paused — пауза; blocked — браузер
//   не дал включить звук без щелчка; ended — последняя сцена досмотрена.
type Playback = 'loading' | 'playing' | 'paused' | 'blocked' | 'ended';
// audio — сцену ведёт запись речи; silent — записи нет, сцену ведёт таймер.
type Voice = 'unknown' | 'audio' | 'silent';

export interface FspSequenceProps {
    fspId: string; // подставляется вместо {fsp_id} в подписи стрелок
    // link — показ при связке: «Пропустить», в конце «Далее»; replay — повтор: «Закрыть».
    mode: 'link' | 'replay';
    onDone: () => void;
    pauseRequest: number; // окно свернули — каждое увеличение ставит на паузу
}

const CHARS_PER_SECOND = 14; // темп речи диктора, пока записи нет
const MIN_SCENE = 6; // с — сцена без записи идёт не меньше
const DRAW = 0.7; // с — стрелка прорисовывается
const SIDE = 10; // px — поля схемы слева и справа
const HEADER = 52; // px — высота строки участников
const BOX_WIDTH = 168; // px — наибольшая ширина плашки участника
const LOOP = 34; // px — ширина петли вызова самого себя
const ROWS = { title: 34, arrow: 42, detail: 54, self: 62, note: 40 };
const COLORS = { line: '#000', event: '#0000a3', past: '#9a9da1', life: '#86898d', title: '#0000a3' };

interface Row {
    scene: number;
    message: StoryMessage | null; // null — заголовок сцены
    order: number; // номер сообщения в сцене
    y: number;
    height: number;
}

function rowHeight(message: StoryMessage | null): number {
    if (!message) return ROWS.title;
    if (isNote(message)) return ROWS.note;
    if (message.from === message.to) return ROWS.self;
    return message.detail ? ROWS.detail : ROWS.arrow;
}

// Строки схемы для сцен с первой по last включительно.
function layout(story: Story, last: number): { rows: Row[]; height: number } {
    const rows: Row[] = [];
    let y = 6;
    story.scenes.slice(0, last + 1).forEach((scene, index) => {
        [null, ...scene.messages].forEach((message, order) => {
            const height = rowHeight(message);
            rows.push({ scene: index, message, order: order - 1, y, height });
            y += height;
        });
    });
    return { rows, height: y + 16 };
}

// Когда появляется сообщение сцены, в секундах от её начала.
function messageTimes(messages: StoryMessage[], duration: number): number[] {
    const count = messages.length;
    return messages.map((message, i) => {
        const share = typeof message.at === 'number' ? message.at : count === 1 ? 0.03 : 0.03 + (0.82 * i) / (count - 1);
        return Math.max(0, Math.min(1, share)) * duration;
    });
}

function estimate(text: string): number {
    return Math.max(MIN_SCENE, text.length / CHARS_PER_SECOND);
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));

// Подпись поверх линий жизни: белая обводка вокруг букв.
const HALO: React.CSSProperties = { paintOrder: 'stroke', stroke: '#fff', strokeWidth: 4, strokeLinejoin: 'round' };

const FspSequence: React.FC<FspSequenceProps> = ({ fspId, mode, onDone, pauseRequest }) => {
    const [story, setStory] = useState<Story | null>(null);
    const [failure, setFailure] = useState('');
    const [index, setIndex] = useState(0);
    const [time, setTime] = useState(0); // с от начала сцены
    const [playback, setPlayback] = useState<Playback>('loading');
    const [voice, setVoice] = useState<Voice>('unknown');
    const [audioDuration, setAudioDuration] = useState<number | null>(null);
    const [width, setWidth] = useState(0);
    const [canvasHeight, setCanvasHeight] = useState(0); // линии жизни — до низа листа, даже если стрелок мало
    const audio = useRef<HTMLAudioElement>(null);
    const root = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLDivElement>(null);
    const body = useRef<HTMLDivElement>(null);
    const attempt = useRef(0); // ответ на устаревшую попытку play() ничего не меняет
    const pauses = useRef(pauseRequest);

    const load = useCallback(async () => {
        setFailure('');
        setStory(null);
        try {
            setStory(await fetchStory());
        } catch (error) {
            setFailure(error instanceof Error ? error.message : 'Не удалось загрузить схему');
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    // Ширина схемы — по окну: его можно растянуть.
    useEffect(() => {
        const element = canvas.current;
        if (!element) return;
        const observer = new ResizeObserver(([entry]) => {
            setWidth(entry.contentRect.width);
            setCanvasHeight(entry.contentRect.height);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [story]);

    const scene = story?.scenes[index];
    const duration = voice === 'audio' && audioDuration ? audioDuration : estimate(scene?.speaker_text ?? '');

    // Сцену ведёт запись, если она есть; нет записи — таймер по тексту.
    const start = useCallback(() => {
        const player = audio.current;
        const current = ++attempt.current;
        setPlayback('loading');
        if (!player) return;
        player.play().then(
            () => {
                if (current !== attempt.current) return;
                setVoice('audio');
                setPlayback('playing');
            },
            (error) => {
                if (current !== attempt.current) return;
                if (error?.name === 'NotAllowedError') {
                    setVoice('audio');
                    setPlayback('blocked');
                } else if (error?.name === 'AbortError') {
                    setPlayback('paused');
                } else {
                    setVoice('silent');
                    setPlayback('playing');
                }
            }
        );
    }, []);

    // Новая сцена — с начала: src у записи уже новый.
    useEffect(() => {
        if (!story) return;
        setTime(0);
        setVoice('unknown');
        setAudioDuration(null);
        start();
    }, [story, index, start]);

    const pause = useCallback(() => {
        attempt.current++;
        audio.current?.pause();
        setPlayback((state) => (state === 'ended' ? state : 'paused'));
    }, []);

    useEffect(() => {
        if (pauseRequest === pauses.current) return;
        pauses.current = pauseRequest;
        pause();
    }, [pauseRequest, pause]);

    // Часы сцены: время записи или таймер.
    useEffect(() => {
        if (playback !== 'playing') return;
        let frame = 0;
        let last = performance.now();
        const tick = (now: number) => {
            if (voice === 'audio' && audio.current) setTime(audio.current.currentTime);
            else setTime((value) => value + (now - last) / 1000);
            last = now;
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [playback, voice]);

    const sceneEnded = useCallback(() => {
        if (!story) return;
        if (index < story.scenes.length - 1) setIndex(index + 1);
        else {
            attempt.current++;
            setPlayback('ended');
        }
    }, [story, index]);

    useEffect(() => {
        if (voice === 'silent' && playback === 'playing' && time >= duration) sceneEnded();
    }, [voice, playback, time, duration, sceneEnded]);

    // Окно закрыли посреди речи — остановим явно.
    useEffect(() => {
        const player = audio.current;
        return () => player?.pause();
    }, [story]);

    useEffect(() => {
        if (story) root.current?.focus();
    }, [story]);

    const toggle = () => {
        if (playback === 'playing' || playback === 'loading') {
            pause();
            return;
        }
        if (playback === 'ended') {
            // Последнюю сцену — ещё раз.
            if (audio.current) audio.current.currentTime = 0;
            setTime(0);
            start();
            return;
        }
        if (voice === 'silent') setPlayback('playing');
        else start();
    };

    const go = (step: number) => {
        if (!story) return;
        const next = Math.min(story.scenes.length - 1, Math.max(0, index + step));
        if (next !== index) setIndex(next);
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            go(event.key === 'ArrowLeft' ? -1 : 1);
        } else if (event.key === ' ' && !(event.target instanceof HTMLButtonElement)) {
            event.preventDefault();
            toggle();
        }
    };

    // Сколько от каждого сообщения текущей сцены уже нарисовано, 0…1.
    const times = scene ? messageTimes(scene.messages, duration) : [];
    const shownTime = playback === 'ended' ? Infinity : time;
    const progress = (row: Row) => (row.scene < index ? 1 : clamp((shownTime - times[row.order]) / DRAW));

    const { rows, height: rowsHeight } = story ? layout(story, index) : { rows: [], height: 0 };
    const height = Math.max(rowsHeight, canvasHeight - HEADER - 1);
    // Нижний край последней начатой стрелки — за ней едет прокрутка.
    const visible = rows.filter((row) => !row.message || progress(row) > 0);
    const followY = visible.length ? visible[visible.length - 1].y + visible[visible.length - 1].height : 0;

    useEffect(() => {
        const element = body.current;
        if (!element) return;
        const bottom = followY + 12;
        if (bottom > element.scrollTop + element.clientHeight || bottom < element.scrollTop + 40) {
            element.scrollTo({ top: Math.max(0, bottom - element.clientHeight), behavior: 'smooth' });
        }
    }, [followY]);

    if (!story || !scene) {
        return (
            <>
                <div className="gt-center">
                    <p className={failure ? '' : 'gt-title'}>{failure || 'Загружаем схему…'}</p>
                </div>
                <div className="gt-footer">
                    <p className="gt-status" />
                    {failure && (
                        <button className="site-button gt-default" onClick={load}>
                            Повторить
                        </button>
                    )}
                    <button className={'site-button' + (failure ? '' : ' gt-default')} onClick={onDone}>
                        {mode === 'link' ? 'Пропустить' : 'Закрыть'}
                    </button>
                </div>
            </>
        );
    }

    const columns = story.participants.length;
    const columnWidth = Math.max(60, (width - 2 * SIDE) / columns);
    const xOf = (id: string) => SIDE + (story.participants.findIndex((item) => item.id === id) + 0.5) * columnWidth;
    const boxWidth = Math.min(BOX_WIDTH, columnWidth - 12);
    const withId = (text: string) => text.split('{fsp_id}').join(fspId);
    const last = index === story.scenes.length - 1;
    const ended = playback === 'ended';

    const renderTitle = (row: Row) => {
        const current = row.scene === index;
        const title = story.scenes[row.scene];
        const y = row.y + 21;
        return (
            <g key={`t${row.scene}`}>
                <line x1={SIDE} x2={width - SIDE} y1={y + 6} y2={y + 6} stroke={current ? COLORS.title : COLORS.past} strokeWidth={1} />
                <text x={SIDE + 6} y={y} fontSize={14} fontWeight="bold" fill={current ? COLORS.title : COLORS.past} style={HALO}>
                    {title.number}. {title.title}
                </text>
            </g>
        );
    };

    const renderNote = (row: Row, note: StoryNote, p: number) => {
        const xs = note.over.map(xOf);
        const left = Math.min(...xs) - Math.min(70, boxWidth / 2);
        const right = Math.max(...xs) + Math.min(70, boxWidth / 2);
        const top = row.y + 8;
        const color = row.scene === index ? '#000' : COLORS.past;
        return (
            <g key={`n${row.scene}-${row.order}`} opacity={p}>
                <path
                    d={`M${left},${top} H${right - 8} L${right},${top + 8} V${top + 24} H${left} Z`}
                    fill="#ffffe1"
                    stroke={color}
                />
                <path d={`M${right - 8},${top} V${top + 8} H${right}`} fill="none" stroke={color} />
                <text x={(left + right) / 2} y={top + 16.5} fontSize={13} textAnchor="middle" fill={color}>
                    {withId(note.note)}
                </text>
            </g>
        );
    };

    const renderArrow = (row: Row, arrow: StoryArrow, p: number) => {
        const current = row.scene === index;
        const color = !current ? COLORS.past : arrow.kind === 'event' ? COLORS.event : COLORS.line;
        const dash = arrow.kind === 'reply' ? '6 4' : undefined;
        const label = withId(arrow.label);
        const detail = arrow.detail ? withId(arrow.detail) : '';
        const key = `m${row.scene}-${row.order}`;
        const x1 = xOf(arrow.from);

        if (arrow.from === arrow.to) {
            // Петля вправо, у крайнего правого участника — влево.
            const side = x1 + LOOP + 160 > width ? -1 : 1;
            const top = row.y + 16;
            const bottom = top + 22;
            const end = x1 + side * LOOP;
            const anchor = side > 0 ? 'start' : 'end';
            return (
                <g key={key}>
                    <path
                        d={`M${x1},${top} H${end} V${bottom} H${x1 + side * 8}`}
                        fill="none"
                        stroke={color}
                        strokeWidth={1.4}
                        pathLength={1}
                        strokeDasharray={1}
                        strokeDashoffset={1 - p}
                    />
                    {p >= 0.98 && <Head x={x1} y={bottom} direction={-side} kind={arrow.kind} color={color} />}
                    <g opacity={clamp(p * 1.6)}>
                        <text x={end + side * 8} y={top + 6} fontSize={13} textAnchor={anchor} fill={color} style={HALO}>
                            {label}
                        </text>
                        {detail && (
                            <text x={end + side * 8} y={top + 22} fontSize={11} textAnchor={anchor} fill={current ? '#44474b' : COLORS.past} className="fsp-mono" style={HALO}>
                                {detail}
                            </text>
                        )}
                    </g>
                </g>
            );
        }

        const x2 = xOf(arrow.to);
        const direction = x2 > x1 ? 1 : -1;
        const lineY = row.y + 26;
        const reach = x1 + (x2 - x1) * p - (p >= 0.98 ? direction * 6 : 0);
        return (
            <g key={key}>
                <line x1={x1} x2={reach} y1={lineY} y2={lineY} stroke={color} strokeWidth={1.4} strokeDasharray={dash} />
                {p >= 0.98 && <Head x={x2} y={lineY} direction={direction} kind={arrow.kind} color={color} />}
                <g opacity={clamp(p * 1.6)}>
                    <text x={(x1 + x2) / 2} y={lineY - 7} fontSize={13} textAnchor="middle" fill={color} style={HALO}>
                        {label}
                    </text>
                    {detail && (
                        <text x={(x1 + x2) / 2} y={lineY + 16} fontSize={11} textAnchor="middle" fill={current ? '#44474b' : COLORS.past} className="fsp-mono" style={HALO}>
                            {detail}
                        </text>
                    )}
                </g>
            </g>
        );
    };

    const status = (() => {
        if (playback === 'loading') return 'загружаем речь…';
        if (playback === 'paused') return 'пауза — щёлкните по схеме';
        if (playback === 'blocked') return 'включите звук щелчком по схеме';
        if (ended) return mode === 'link' ? 'схема досмотрена — дальше ваши соревнования' : 'схема досмотрена';
        return voice === 'audio' ? 'говорит диктор' : 'озвучки пока нет — читайте текст';
    })();

    return (
        <div className="gt-presentation gt-grow" ref={root} tabIndex={-1} onKeyDown={onKeyDown}>
            <div
                className="gt-field fsp-diagram gt-grow"
                ref={canvas}
                onClick={toggle}
                title="Щелчок — пауза или продолжить"
            >
                {width > 0 && (
                    <>
                        <svg className="fsp-participants" width={width} height={HEADER} aria-hidden="true">
                            {story.participants.map((item) => {
                                const x = xOf(item.id);
                                return (
                                    <g key={item.id}>
                                        <rect x={x - boxWidth / 2} y={6} width={boxWidth} height={40} fill="#c3c6ca" />
                                        <path d={`M${x - boxWidth / 2},${45} V${6} H${x + boxWidth / 2}`} fill="none" stroke="#fff" strokeWidth={2} />
                                        <path d={`M${x + boxWidth / 2},${6} V${46} H${x - boxWidth / 2}`} fill="none" stroke="#000" strokeWidth={1.5} />
                                        <text x={x} y={23} fontSize={14} fontWeight="bold" textAnchor="middle">
                                            {item.name}
                                        </text>
                                        <text x={x} y={39} fontSize={11} textAnchor="middle" fill="#44474b">
                                            {item.note}
                                        </text>
                                    </g>
                                );
                            })}
                        </svg>
                        <div className="fsp-diagram-body" ref={body}>
                            <svg width={width} height={height} role="img" aria-label={`Схема: ${scene.title}`}>
                                {story.participants.map((item) => (
                                    <line key={item.id} x1={xOf(item.id)} x2={xOf(item.id)} y1={0} y2={height} stroke={COLORS.life} strokeDasharray="4 4" />
                                ))}
                                <g>
                                    {rows.map((row) => {
                                        if (!row.message) return renderTitle(row);
                                        const p = progress(row);
                                        if (p <= 0) return null;
                                        return isNote(row.message) ? renderNote(row, row.message, p) : renderArrow(row, row.message, p);
                                    })}
                                </g>
                            </svg>
                        </div>
                    </>
                )}
            </div>
            <div className="gt-progress gt-speech-progress" aria-hidden="true">
                <div className="gt-progress-fill" style={{ width: `${(ended ? 1 : clamp(time / duration)) * 100}%` }} />
            </div>
            <div className="gt-group gt-speaker">
                <span className="gt-group-label">Текст диктора</span>
                <div className="gt-scroll">
                    <p>
                        <b>{scene.title}.</b> {scene.speaker_text}
                    </p>
                </div>
            </div>
            <audio
                ref={audio}
                src={scene.audio.url}
                preload="auto"
                onLoadedMetadata={(event) => {
                    const value = event.currentTarget.duration;
                    if (Number.isFinite(value) && value > 0) setAudioDuration(value);
                }}
                onEnded={sceneEnded}
                onError={() => {
                    // Записи нет (её ещё не положили) — сцену ведёт таймер по тексту.
                    if (playback === 'loading' || voice === 'unknown') {
                        attempt.current++;
                        setVoice('silent');
                        setPlayback('playing');
                    }
                }}
            />
            <div className="gt-footer">
                <p className="gt-status">
                    Сцена {index + 1} из {story.scenes.length} · {status}
                </p>
                <button className="site-button" onClick={() => go(-1)} disabled={index === 0}>
                    &lt; Назад
                </button>
                <button className={'site-button' + (last ? '' : ' gt-default')} onClick={() => go(1)} disabled={last}>
                    Вперёд &gt;
                </button>
                <button className={'site-button' + (last && ended ? ' gt-default' : '')} onClick={onDone}>
                    {mode === 'replay' ? 'Закрыть' : ended ? 'Далее' : 'Пропустить'}
                </button>
            </div>
        </div>
    );
};

// Наконечник стрелки в точке (x, y), direction — куда смотрит: 1 вправо, -1 влево.
// Вызов — закрашенный треугольник, ответ и событие — открытая «галочка».
const Head: React.FC<{ x: number; y: number; direction: number; kind: StoryArrow['kind']; color: string }> = ({
    x,
    y,
    direction,
    kind,
    color,
}) => {
    const back = x - direction * 10;
    return kind === 'call' ? (
        <polygon points={`${x},${y} ${back},${y - 5} ${back},${y + 5}`} fill={color} />
    ) : (
        <polyline points={`${back},${y - 6} ${x},${y} ${back},${y + 6}`} fill="none" stroke={color} strokeWidth={1.4} />
    );
};

export default FspSequence;
