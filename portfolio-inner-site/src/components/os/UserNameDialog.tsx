import React, { useCallback, useEffect, useRef, useState } from 'react';
import Colors from '../../constants/colors';
import { Icon } from '../general';
import { ApiError, currentUserId } from '../../api';
import { fetchUserName, saveUserName } from '../../userName';

// Окно входа, как в Windows 95: пока пользователь не ввёл имя и фамилию,
// оно закрывает рабочий стол, и с остальной системой ничего не сделать.
// Есть ли имя, знает сервер (userName.ts); после записи окно пропадает навсегда.
//   checking — спрашиваем сервер, окна ещё нет, но рабочий стол уже закрыт;
//   ask / saving — форма имени и её отправка;
//   no-user — неизвестно, кто пользователь: в ITinder он не входил;
//   offline — сервер не ответил, можно повторить.
type Stage = 'checking' | 'ask' | 'saving' | 'done' | 'no-user' | 'offline';

const MAX_NAME = 60; // как в app/tools/user_names.py
const ITINDER = '/app/web/';
const NO_USER = 'Не удалось узнать, кто вы. Создайте профиль в ITinder и войдите в эту комнату снова.';

const UserNameDialog: React.FC = () => {
    const [userId] = useState(currentUserId);
    const [stage, setStage] = useState<Stage>('checking');
    const [message, setMessage] = useState('');
    const [firstName, setFirstName] = useState('');
    const [lastName, setLastName] = useState('');
    const firstRef = useRef<HTMLInputElement>(null);
    const lastRef = useRef<HTMLInputElement>(null);

    const check = useCallback(async () => {
        if (!userId) {
            setStage('no-user');
            setMessage(NO_USER);
            return;
        }
        setStage('checking');
        try {
            const record = await fetchUserName(userId);
            setStage(record ? 'done' : 'ask');
            setMessage('');
        } catch (error) {
            const status = error instanceof ApiError ? error.status : 500;
            // 4xx — сервер не знает такого пользователя, 0 и 5xx — сервер не ответил или сломался.
            setStage(status >= 400 && status < 500 ? 'no-user' : 'offline');
            setMessage(error instanceof ApiError ? error.message : 'Не удалось проверить имя');
        }
    }, [userId]);

    useEffect(() => {
        check();
    }, [check]);

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (stage !== 'ask' || !userId) return;
        const empty = !firstName.trim() ? firstRef : !lastName.trim() ? lastRef : null;
        if (empty) {
            setMessage(empty === firstRef ? 'Введите имя' : 'Введите фамилию');
            empty.current?.focus();
            return;
        }
        setStage('saving');
        setMessage('');
        try {
            await saveUserName(userId, firstName, lastName);
            setStage('done');
        } catch (error) {
            // 409 — имя уже записано (например, из другой вкладки): пускаем.
            if (error instanceof ApiError && error.status === 409) {
                setStage('done');
                return;
            }
            setStage('ask');
            setMessage(error instanceof ApiError ? error.message : 'Не удалось записать имя');
        }
    };

    // Клик мимо окна не уводит фокус из полей ввода.
    const keepFocus = (event: React.MouseEvent) => {
        if (event.target === event.currentTarget) event.preventDefault();
    };

    if (stage === 'done') return null;

    const busy = stage === 'checking' || stage === 'saving';
    const overlay = Object.assign({}, styles.overlay, busy && { cursor: 'wait' });
    if (stage === 'checking') return <div style={overlay} onMouseDown={keepFocus} />;

    const asking = stage === 'ask' || stage === 'saving';
    const button = asking
        ? { text: 'OK', type: 'submit' as const, onClick: undefined }
        : stage === 'offline'
        ? { text: 'Повторить', type: 'button' as const, onClick: check }
        : {
              text: 'В ITinder',
              type: 'button' as const,
              onClick: () => {
                  (window.top ?? window).location.href = ITINDER;
              },
          };

    return (
        <div style={overlay} onMouseDown={keepFocus}>
            <div style={styles.outer} role="dialog" aria-modal="true" aria-labelledby="user-name-title">
                <div style={styles.inner}>
                    <div style={styles.titleBar}>
                        <p id="user-name-title" style={styles.title}>
                            Добро пожаловать
                        </p>
                    </div>
                    <form style={styles.body} onSubmit={submit} noValidate>
                        <Icon icon="computerBig" size={32} style={styles.icon} />
                        <div style={styles.main}>
                            {asking ? (
                                <>
                                    <p style={styles.text}>Введите имя и фамилию, чтобы начать работу.</p>
                                    <label style={styles.row}>
                                        <span style={styles.label}>Имя:</span>
                                        <input
                                            ref={firstRef}
                                            style={styles.input}
                                            value={firstName}
                                            maxLength={MAX_NAME}
                                            autoComplete="given-name"
                                            autoFocus
                                            onChange={(event) => setFirstName(event.target.value)}
                                        />
                                    </label>
                                    <label style={styles.row}>
                                        <span style={styles.label}>Фамилия:</span>
                                        <input
                                            ref={lastRef}
                                            style={styles.input}
                                            value={lastName}
                                            maxLength={MAX_NAME}
                                            autoComplete="family-name"
                                            onChange={(event) => setLastName(event.target.value)}
                                        />
                                    </label>
                                    {message && (
                                        <p style={styles.error} role="alert">
                                            {message}
                                        </p>
                                    )}
                                </>
                            ) : (
                                <p style={styles.text} role="alert">
                                    {message}
                                </p>
                            )}
                        </div>
                        <div style={styles.buttons}>
                            <button
                                className="site-button"
                                style={styles.button}
                                type={button.type}
                                onClick={button.onClick}
                                disabled={stage === 'saving'}
                            >
                                {button.text}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

const font: React.CSSProperties = {
    fontFamily: 'MSSerif, Arial, sans-serif',
    fontSize: 16,
};

const styles: StyleSheetCSS = {
    overlay: {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1000000,
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'default',
    },
    // Рамка — как у окон системы (Window.tsx): светлый край сверху-слева, тёмный снизу-справа.
    outer: {
        width: 560,
        border: `1px solid ${Colors.black}`,
        borderTopColor: Colors.lightGray,
        borderLeftColor: Colors.lightGray,
        backgroundColor: Colors.lightGray,
        boxShadow: '4px 4px 0 rgba(0, 0, 0, 0.35)',
    },
    inner: {
        flex: 1,
        flexDirection: 'column',
        border: `1px solid ${Colors.darkGray}`,
        borderTopColor: Colors.white,
        borderLeftColor: Colors.white,
        padding: 2,
    },
    titleBar: {
        height: 24,
        alignItems: 'center',
        paddingLeft: 6,
        backgroundColor: Colors.blue,
    },
    title: {
        ...font,
        color: Colors.white,
        fontWeight: 'bold',
    },
    body: {
        display: 'flex',
        alignItems: 'flex-start',
        padding: '20px 16px 16px',
    },
    icon: {
        flexShrink: 0,
        marginRight: 16,
    },
    main: {
        flex: 1,
        flexDirection: 'column',
        marginRight: 16,
    },
    text: {
        ...font,
        marginBottom: 16,
        lineHeight: 1.3,
    },
    row: {
        display: 'flex',
        alignItems: 'center',
        marginBottom: 10,
    },
    label: {
        ...font,
        width: 96,
        flexShrink: 0,
    },
    input: {
        ...font,
        padding: '4px 6px',
        // Без этого Safari не даёт печатать: в index.css user-select: none на всём.
        userSelect: 'text',
        WebkitUserSelect: 'text',
    },
    error: {
        ...font,
        color: '#800000',
        marginTop: 2,
    },
    buttons: {
        flexDirection: 'column',
    },
    // Кнопка по умолчанию в Windows 95 — с чёрной рамкой.
    button: {
        ...font,
        minWidth: 104,
        padding: '5px 12px',
        outline: `1px solid ${Colors.black}`,
    },
};

export default UserNameDialog;
