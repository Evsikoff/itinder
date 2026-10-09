import React from 'react';
import { useNavigate } from 'react-router-dom';
import BackIcon from '../../general/BackIcon';
import HomeIcon from '../../general/HomeIcon';
import ResumeButtons from '../ResumeButtons';

const Sber: React.FC = () => {
    const navigate = useNavigate();

    const goHome = () => {
        navigate('/');
    };

    const goBack = () => {
        navigate('/experience');
    };

    return (
        <div className="site-page-content" style={styles.container}>
            <h2>Сбер (аутстаф от Бэлл Интегратор, ООО)</h2>
            <h3 style={styles.subtitle}>Ведущий системный аналитик (1 год и 3 месяца)</h3>

            <div className="text-block">
                <h3>Ключевые результаты</h3>
                <ul>
                    <li><p>Участвовал в создании полноценной BPMN-системы на базе Siebel CRM, включающей моделирование процессов, исполнительный движок и комплекс интеграций со смежными системами Сбера.</p></li>
                    <li><p>Спроектировал и внедрил ряд решений в рамках крупной трансформации банковских процессов, повысив скорость обработки операций и прозрачность маршрутизации задач.</p></li>
                    <li><p>Лидировал интеграционные разработки, в которых были задействованы многочисленные команды и доменные области.</p></li>
                </ul>

                <h3>Технологии и инструменты</h3>
                <p>Siebel CRM, BPMN, SQL, REST/SOAP, XML, JSON, XSD, интеграционные шины Сбера, Confluence, Jira.</p>
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

export default Sber;
