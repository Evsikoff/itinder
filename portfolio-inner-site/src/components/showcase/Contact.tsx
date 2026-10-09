import React from 'react';
import { useNavigate } from 'react-router-dom';
import HomeIcon from '../general/HomeIcon';
import ResumeButtons from './ResumeButtons';

export interface ContactProps {}

// Компонент иконки в стиле Windows 95
const TelegramWin95Icon = () => (
    <svg
        width="32"
        height="32"
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ marginRight: 8, shapeRendering: 'crispEdges' }} // crispEdges убирает сглаживание
    >
        {/* Тень иконки */}
        <path
            d="M4 14h2v-2h2v-2h2v-2h14v2h2v2h2v4l-4 10h-2v2h-2v-2h-2v-2h-2v2h-2v-2h-2v-2h-2v-2h-2v-2h-2v-2z"
            fill="#000000"
            opacity="0.5"
            transform="translate(2, 2)"
        />
        {/* Контур */}
        <path
            d="M4 14h2v-2h2v-2h2v-2h14v2h2v2h2v4l-4 10h-2v2h-2v-2h-2v-2h-2v2h-2v-2h-2v-2h-2v-2h-2v-2h-2v-2z"
            fill="#000000"
        />
        {/* Основной цвет (Windows Teal/Blue) */}
        <path
            d="M5 14h2v-2h2v-2h2v-2h12v2h2v2h2v2l-3 8h-1v-2h-2v-2h-2v2h-2v-2h-2v-2h-2v-2h-2v-2h-2z"
            fill="#008080"
        />
        {/* Блики (Pixel Highlight) */}
        <path
            d="M5 14h2v-2h2v-2h2v-2h12v1h-11v2h-2v2h-2v2h-1z"
            fill="#FFFFFF"
        />
        {/* Деталь "крыла" */}
        <rect x="15" y="16" width="2" height="2" fill="#FFFFFF" />
    </svg>
);

const Contact: React.FC<ContactProps> = (props) => {
    const navigate = useNavigate();

    const goHome = () => {
        navigate('/');
    };

    return (
        <div className="site-page-content">
            <h1 style={styles.header}>Контакты</h1>
            <div className="text-block">
                <p>
                    <b>Телефон и мессенджеры:</b> +7-916-820-81-50
                </p>
                
                {/* Блок Telegram */}
                <div style={styles.telegramContainer}>
                    <a 
                        href="https://t.me/evsikoff" 
                        target="_blank" 
                        rel="noreferrer"
                        style={styles.win95Link}
                        title="Написать в Telegram"
                    >
                        <TelegramWin95Icon />
                        <span style={styles.win95LinkText}>Telegram</span>
                    </a>
                </div>
                
                <br />
                <p>
                    <b>E-mail:</b>{' '}
                    <a href="mailto:gsmevsikov@gmail.com">
                        gsmevsikov@gmail.com
                    </a>
                </p>
            </div>
            <div style={styles.resumeContainer}>
                <ResumeButtons />
            </div>
            <div style={styles.homeButtonContainer}>
                <button
                    className="site-button"
                    style={styles.homeButton}
                    onClick={goHome}
                    title="На главную"
                >
                    <HomeIcon size={24} />
                </button>
            </div>
        </div>
    );
};

const styles: StyleSheetCSS = {
    header: {
        marginBottom: 32,
    },
    telegramContainer: {
        marginTop: 16,
        marginBottom: 16,
        display: 'flex',
        alignItems: 'center',
    },
    win95Link: {
        display: 'flex',
        alignItems: 'center',
        textDecoration: 'none',
        cursor: 'pointer',
        padding: '4px 8px',
        border: '1px dotted transparent', // Для фокуса, как в Win95
    },
    win95LinkText: {
        color: '#000080', // Классический синий цвет ссылок Win95/Web 1.0
        fontSize: 18,
        fontFamily: '"MS Sans Serif", "Tahoma", sans-serif', // Системные шрифты
        fontWeight: 'bold',
        textDecoration: 'underline',
    },
    resumeContainer: {
        marginTop: 48,
        textAlign: 'center',
    },
    homeButtonContainer: {
        marginTop: 32,
        display: 'flex',
        justifyContent: 'center',
    },
    homeButton: {
        padding: 12,
        minWidth: 64,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
    },
};

export default Contact;
