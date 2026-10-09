import React from 'react';
import { useNavigate } from 'react-router-dom';
import BackIcon from '../../general/BackIcon';
import HomeIcon from '../../general/HomeIcon';
import ResumeButtons from '../ResumeButtons';

const FreeLines: React.FC = () => {
    const navigate = useNavigate();

    const goHome = () => {
        navigate('/');
    };

    const goBack = () => {
        navigate('/experience');
    };

    return (
        <div className="site-page-content" style={styles.container}>
            <h2>Free Lines Company</h2>
            <h3 style={styles.subtitle}>Ведущий системный аналитик (3 года и 10 месяцев)</h3>

            <div className="text-block">
                <h3>Ключевые результаты</h3>
                <ul>
                    <li><p>Спроектировал и внедрил три полноценных корпоративных системы:</p>
                        <ul>
                            <li><p><b>ERP-систему</b> (модули CRP/SRM/логистика/бухгалтерские контуры);</p></li>
                            <li><p><b>BPM-систему</b> на более чем 500 задач и 40+ исполнимых процессов;</p></li>
                            <li><p><b>BI-систему</b> на базе QlikSense для управленческой отчётности.</p></li>
                        </ul>
                    </li>
                    <li><p>Организовал работу над системами полного цикла:</p>
                        <ul>
                            <li><p>анализ;</p></li>
                            <li><p>проектирование;</p></li>
                            <li><p>разработка;</p></li>
                            <li><p>тестирование;</p></li>
                            <li><p>внедрение;</p></li>
                            <li><p>поддержка.</p></li>
                        </ul>
                    </li>
                    <li><p>Обеспечил глубокую интеграцию созданных систем между собой и с внешними информационными продуктами компании.</p></li>
                </ul>

                <h3>BI-архитектура</h3>
                <ul>
                    <li><p>Создание BI-системы на базе QlikSense: модели данных, витрины, преобразование данных, визуализации.</p></li>
                    <li><p>Формирование KPI и аналитических панелей для руководства.</p></li>
                    <li><p>Оптимизация загрузки данных, проектирование связей, настройка инкрементальных обновлений.</p></li>
                </ul>

                <h3>Сопровождение разработки</h3>
                <ul>
                    <li><p>Поддержка самописной ERP/CRM на Delphi + SQL: анализ дефектов, доработка, оптимизация.</p></li>
                    <li><p>Экспертная поддержка пользователей, доработка алгоритмов, устранение ошибок.</p></li>
                    <li><p>Поддержка интеграций с продуктами Альта-Софт и смежными логистическими сервисами.</p></li>
                </ul>

                <h3>Технологии и инструменты</h3>
                <p>1С:Предприятие 8, Delphi, SQL, QlikSense, BPMN, JSON/XML, WMS Axelot, Альта-Софт, ERP/CRM-разработка, интеграционные события.</p>
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

export default FreeLines;
