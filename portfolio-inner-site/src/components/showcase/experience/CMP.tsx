import React from 'react';
import { useNavigate } from 'react-router-dom';
import BackIcon from '../../general/BackIcon';
import HomeIcon from '../../general/HomeIcon';
import ResumeButtons from '../ResumeButtons';

const CMP: React.FC = () => {
    const navigate = useNavigate();

    const goHome = () => {
        navigate('/');
    };

    const goBack = () => {
        navigate('/experience');
    };

    return (
        <div className="site-page-content" style={styles.container}>
            <h2>Центр Молодежного Парламентаризма</h2>
            <h3 style={styles.subtitle}>Аналитик и разработчик краудсорсинговой web-платформы «Движок» (6 месяцев под проект)</h3>

            <div className="text-block">
                <h3>Ключевые результаты</h3>
                <ul>
                    <li><p>Выступал на проекте одновременно в роли системного аналитика и Backend-разработчика, обеспечивая полный цикл создания краудсорсинговой платформы «Движок».</p></li>
                    <li><p>Спроектировал архитектуру серверной части, разработал модели данных и реализовал backend полностью с нуля.</p></li>
                    <li><p>Успешно довел систему до внедрения, включая тестирование, регрессию и приемку.</p></li>
                </ul>

                <h3>Backend-разработка</h3>
                <ul>
                    <li><p>Создание серверной части на <b>Nest.js</b>.</p></li>
                    <li><p>Создание базы данных на <b>PostgreSQL</b>.</p></li>
                    <li><p>Интеграция backend-части с фронтендом и внешними сервисами.</p></li>
                    <li><p>Оптимизация производительности и отказоустойчивости серверного приложения.</p></li>
                </ul>
            </div>

            <div style={styles.resumeContainer}>
                <ResumeButtons />
            </div>

            <div style={styles.homeButtonContainer}>
                <button
                    className="site-button"
                    style={styles.homeButton}
                    onClick={goBack}
                    title="Назад к опыту"
                >
                    <BackIcon size={24} />
                </button>
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
    container: {
        maxHeight: '100%',
        overflowY: 'auto',
    },
    subtitle: {
        marginBottom: 32,
        marginTop: 8,
    },
    resumeContainer: {
        marginTop: 48,
        textAlign: 'center',
    },
    homeButtonContainer: {
        marginTop: 32,
        marginBottom: 32,
        display: 'flex',
        justifyContent: 'center',
        gap: 12,
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

export default CMP;
