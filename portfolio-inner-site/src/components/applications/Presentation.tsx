import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSlides, PresentationSlide, PresentationSource } from '../../presentation';

// Презентация внутри окна («Задачи на грейд», «Соискатели», «Вакансии», «Проекты и вакансии»): слайд, под ним текст
// докладчика (если он есть), кнопки «Назад», «Вперёд» и «Закрыть». Слайд — картинка или видео.
// Слайд ведёт речь докладчика, а у видео без речи — звук самого видео: кончилось —
// следующий слайд, после последнего презентация стоит. Видео при речи идёт без
// звука по кругу. Щелчок по слайду — пауза и продолжение, стрелки ← → листают,
// пробел — пауза. Браузер может не дать включить звук без щелчка по странице —
// тогда окно просит щёлкнуть по слайду. Не загрузилось — слайды листаются кнопками.
//   loading — грузится; playing — играет; paused — пауза; blocked — звук не
//   включён браузером; ended — последний слайд дослушан; error — речь или видео
//   к слайду не загрузились.
type Playback = 'loading' | 'playing' | 'paused' | 'blocked' | 'ended' | 'error';

export interface PresentationProps {
    source: PresentationSource;
    onClose: () => void;
    pauseRequest: number; // окно свернули — каждое увеличение ставит слайд на паузу
}

const Presentation: React.FC<PresentationProps> = ({ source, onClose, pauseRequest }) => {
    const [slides, setSlides] = useState<PresentationSlide[] | null>(null);
    const [failure, setFailure] = useState('');
    const [index, setIndex] = useState(0);
    const [playback, setPlayback] = useState<Playback>('loading');
    const [heard, setHeard] = useState(0); // доля слайда, 0…1
    const [broken, setBroken] = useState(''); // адрес картинки или видео, которые не загрузились
    // Речь слайда; нет её — слайд ведёт видео (оно же играет без звука под речью).
    const audio = useRef<HTMLAudioElement>(null);
    const video = useRef<HTMLVideoElement>(null);
    const root = useRef<HTMLDivElement>(null);
    // Номер последней попытки play(): ответ на устаревшую попытку не меняет состояние.
    const attempt = useRef(0);
    const pauses = useRef(pauseRequest); // сворачивания до открытия презентации не в счёт

    const load = useCallback(async () => {
        setFailure('');
        setSlides(null);
        try {
            const next = await fetchSlides(source);
            // Картинки по 2–4 МБ: пусть грузятся заранее, листать без ожидания.
            next.forEach((slide) => {
                if (slide.image) new Image().src = slide.image.url;
            });
            setSlides(next);
        } catch (error) {
            setFailure(error instanceof Error ? error.message : 'Не удалось загрузить презентацию');
        }
    }, [source]);

    useEffect(() => {
        load();
    }, [load]);

    const play = useCallback(() => {
        const player = audio.current ?? video.current;
        if (!player) return;
        const current = ++attempt.current;
        setPlayback('loading');
        // Видео под речью — фон: не запустилось, речь всё равно идёт.
        if (audio.current && video.current) video.current.play().catch(() => {});
        player.play().then(
            () => current === attempt.current && setPlayback('playing'),
            (error) => {
                if (current !== attempt.current) return;
                setPlayback(error?.name === 'NotAllowedError' ? 'blocked' : error?.name === 'AbortError' ? 'paused' : 'error');
            }
        );
    }, []);

    const pause = useCallback(() => {
        attempt.current++;
        audio.current?.pause();
        video.current?.pause();
        setPlayback('paused');
    }, []);

    // Новый слайд — с начала. src элементы уже получили при отрисовке.
    useEffect(() => {
        if (!slides) return;
        setHeard(0);
        play();
    }, [slides, index, play]);

    useEffect(() => {
        if (pauseRequest === pauses.current) return;
        pauses.current = pauseRequest;
        pause();
    }, [pauseRequest, pause]);

    // Фокус на презентации — чтобы стрелки и пробел работали сразу.
    useEffect(() => {
        if (slides) root.current?.focus();
    }, [slides]);

    // Окно закрыли посреди слайда: элементы уходят со страницы, но остановим явно.
    useEffect(() => {
        const speech = audio.current;
        const clip = video.current;
        return () => {
            speech?.pause();
            clip?.pause();
        };
    }, [slides, index]);

    const toggle = () => {
        if (playback === 'playing' || playback === 'loading') {
            pause();
            return;
        }
        if (playback === 'error') return;
        const player = audio.current ?? video.current;
        if (playback === 'ended' && player) player.currentTime = 0;
        play();
    };

    const go = (step: number) => {
        if (!slides) return;
        const next = Math.min(slides.length - 1, Math.max(0, index + step));
        if (next !== index) setIndex(next);
    };

    const onEnded = () => {
        if (!slides) return;
        if (index < slides.length - 1) setIndex(index + 1);
        else {
            video.current?.pause();
            setHeard(1);
            setPlayback('ended');
        }
    };

    const onTimeUpdate = (event: React.SyntheticEvent<HTMLMediaElement>) => {
        const { currentTime, duration } = event.currentTarget;
        if (duration > 0 && Number.isFinite(duration)) setHeard(currentTime / duration);
    };

    const failed = () => {
        attempt.current++;
        setPlayback('error');
    };

    // Пробел на кнопке нажимает саму кнопку, а не ставит паузу.
    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            go(event.key === 'ArrowLeft' ? -1 : 1);
        } else if (event.key === ' ' && !(event.target instanceof HTMLButtonElement)) {
            event.preventDefault();
            toggle();
        }
    };

    if (!slides) {
        return (
            <>
                <div className="gt-center">
                    <p className={failure ? '' : 'gt-title'}>{failure || 'Загружаем презентацию…'}</p>
                </div>
                <div className="gt-footer">
                    <p className="gt-status" />
                    {failure && (
                        <button className="site-button gt-default" onClick={load}>
                            Повторить
                        </button>
                    )}
                    <button className={'site-button' + (failure ? '' : ' gt-default')} onClick={onClose}>
                        Закрыть
                    </button>
                </div>
            </>
        );
    }

    const slide = slides[index];
    const last = index === slides.length - 1;
    const speech = !!slide.audio;
    const media = slide.video ?? slide.image;
    const status: { [state in Playback]: string } = {
        loading: speech ? 'загружаем речь…' : 'загружаем видео…',
        playing: speech ? 'говорит докладчик' : 'идёт видео',
        paused: 'пауза — щёлкните по слайду',
        blocked: 'включите звук щелчком по слайду',
        ended: 'презентация окончена',
        error: speech ? 'речь не загрузилась — листайте кнопками' : 'видео не загрузилось — листайте кнопками',
    };

    return (
        <div className="gt-presentation gt-grow" ref={root} tabIndex={-1} onKeyDown={onKeyDown}>
            <div
                className={'gt-field gt-slide' + (playback === 'error' ? '' : ' gt-slide-active')}
                onClick={toggle}
                title={playback === 'error' ? undefined : 'Щелчок — пауза или продолжить'}
            >
                {media && broken === media.url ? (
                    <p className="gt-slide-missing">
                        Слайд {slide.number}. {slide.title}
                        <br />
                        {slide.video ? 'Видео не загрузилось' : 'Картинка не загрузилась'}: {media.url}
                    </p>
                ) : slide.video ? (
                    <video
                        key={slide.video.url}
                        ref={video}
                        src={slide.video.url}
                        preload="auto"
                        playsInline
                        muted={speech}
                        loop={speech}
                        onEnded={speech ? undefined : onEnded}
                        onTimeUpdate={speech ? undefined : onTimeUpdate}
                        onError={() => {
                            setBroken(slide.video?.url ?? '');
                            if (!speech) failed();
                        }}
                    />
                ) : (
                    slide.image && (
                        <img src={slide.image.url} alt={slide.title} onError={() => setBroken(slide.image?.url ?? '')} />
                    )
                )}
            </div>
            <div className="gt-progress gt-speech-progress" aria-hidden="true">
                <div className="gt-progress-fill" style={{ width: `${heard * 100}%` }} />
            </div>
            {slide.speaker_text && (
                <div className="gt-group gt-speaker">
                    <span className="gt-group-label">Текст докладчика</span>
                    <div className="gt-scroll">
                        <p>{slide.speaker_text}</p>
                    </div>
                </div>
            )}
            {slide.audio && (
                <audio
                    key={slide.audio.url}
                    ref={audio}
                    src={slide.audio.url}
                    preload="auto"
                    onEnded={onEnded}
                    onTimeUpdate={onTimeUpdate}
                    onError={failed}
                />
            )}
            <div className="gt-footer">
                <p className="gt-status">
                    Слайд {index + 1} из {slides.length} · {status[playback]}
                </p>
                <button className="site-button" onClick={() => go(-1)} disabled={index === 0}>
                    &lt; Назад
                </button>
                <button className={'site-button' + (last ? '' : ' gt-default')} onClick={() => go(1)} disabled={last}>
                    Вперёд &gt;
                </button>
                <button className={'site-button' + (last ? ' gt-default' : '')} onClick={onClose}>
                    Закрыть
                </button>
            </div>
        </div>
    );
};

export default Presentation;
