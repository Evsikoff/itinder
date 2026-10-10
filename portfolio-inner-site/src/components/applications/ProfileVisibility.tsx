import React, { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api';
import { ProfileVisibility as Visibility, fetchProfileVisibility, saveProfileVisibility } from '../../candidateProfile';
import { formatDate } from './projectWidgets';
import './CandidateProfile.css';

// Тумблер окна «PDF-профиль»: включён — профиль скрыт от рекрутёров (сервер кладёт
// файл в app/db/user_blocks), окно «Соискатели» перестаёт показывать пользователя.

const ProfileVisibility: React.FC<{ userId: string }> = ({ userId }) => {
    const [state, setState] = useState<Visibility | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [problem, setProblem] = useState('');
    const [attempt, setAttempt] = useState(0);
    const busy = useRef(false);
    const mounted = useRef(true);

    useEffect(() => () => { mounted.current = false; }, []);

    useEffect(() => {
        let alive = true;
        setLoading(true); setProblem('');
        fetchProfileVisibility(userId).then(next => { if (alive) setState(next); })
            .catch(failure => { if (alive) setProblem(failure instanceof ApiError ? failure.message : 'Не удалось узнать видимость профиля'); })
            .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [userId, attempt]);

    const toggle = async () => {
        if (!state || busy.current) return;
        busy.current = true; setSaving(true); setProblem('');
        try {
            const next = await saveProfileVisibility(userId, !state.hidden);
            if (mounted.current) setState(next);
        } catch (failure) {
            if (mounted.current) setProblem(failure instanceof ApiError ? failure.message : 'Не удалось изменить видимость профиля');
        } finally {
            busy.current = false;
            if (mounted.current) setSaving(false);
        }
    };

    const hidden = state?.hidden ?? false;
    const since = state?.hidden_at ? formatDate(state.hidden_at) : '';
    const hint = loading ? 'Проверяем, видят ли вас рекрутёры…'
        : !state ? 'Видимость профиля не загрузилась.'
        : hidden ? `Профиль скрыт${since ? ` с ${since}` : ''}: рекрутёры не найдут вас в поиске соискателей и не пригласят. Профиль видят только рекрутёры, с которыми уже есть приглашение или отклик. Вакансии и отклики доступны как раньше.`
        : 'Рекрутёры находят ваш профиль в поиске соискателей и могут пригласить вас на вакансию.';

    return <div className="gt-group cp-visibility">
        <span className="gt-group-label">Видимость для рекрутёров</span>
        <div className="cp-visibility-row">
            <button type="button" role="switch" aria-checked={hidden} aria-describedby="cp-visibility-hint"
                className={`cp-switch${hidden ? ' cp-switch-on' : ''}`} disabled={!state || loading || saving} onClick={toggle}>
                <span className="cp-switch-track" aria-hidden="true"><span className="cp-switch-knob" /></span>
                <span className="cp-switch-label">Скрыть профиль от рекрутёров</span>
            </button>
            <span id="cp-visibility-hint" className="gt-muted cp-small cp-visibility-hint" role="status">
                {saving ? (hidden ? 'Открываем профиль рекрутёрам…' : 'Скрываем профиль от рекрутёров…') : hint}
            </span>
        </div>
        {problem && <div className="cp-visibility-error" role="alert">
            <span>{problem}</span>
            {!state && !loading && <button className="site-button" onClick={() => setAttempt(value => value + 1)}>Повторить</button>}
        </div>}
    </div>;
};

export default ProfileVisibility;
