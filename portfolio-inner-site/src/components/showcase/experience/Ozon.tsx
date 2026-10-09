import React from 'react';
import { useNavigate } from 'react-router-dom';
import BackIcon from '../../general/BackIcon';
import HomeIcon from '../../general/HomeIcon';
import ResumeButtons from '../ResumeButtons';

export interface OzonProps {}

const Ozon: React.FC<OzonProps> = (props) => {
    const navigate = useNavigate();

    const goHome = () => {
        navigate('/');
    };

    const goBack = () => {
        navigate('/experience');
    };

    return (
        <div className="site-page-content" style={styles.container}>
            <h2>OZON.ru, Интернет-магазин</h2>
            <h3 style={styles.subtitle}>Ведущий системный аналитик (2 года и 10 месяцев)</h3>

            <div className="text-block">
                <h3>Ключевые результаты</h3>
                <ul>
                    <li><p>Спроектировал и довёл до внедрения <b>46 разработок</b> в высоконагруженной микросервисной архитектуре.</p></li>
                    <li><p>Участвовал в проектировании и развитии сервисов в экосистеме, включающей десятки команд и распределённые доменные области.</p></li>
                    <li><p>Участвовал в проектировании и запуске системы <b>BOS</b> — внутренней платформы OZON для сквозного отслеживания всех логистических объектов.</p></li>
                    <li><p>Являлся заместителем председателя комитета системной аналитики.</p></li>
                </ul>

                <h3>Аналитика и проектирование</h3>
                <ul>
                    <li><p>Разработка ролевых моделей и матриц доступа.</p></li>
                    <li><p>Проработка сложных сценариев поведения.</p></li>
                    <li><p>Определение нефункциональных требований (производительность, отказоустойчивость, согласованность данных, SLA).</p></li>
                    <li><p>Подготовка аналитических артефактов (BPMN, UML, ER-модели, IDEF0, EPC, интеграционные схемы).</p></li>
                </ul>

                <h3>Интеграции и техническая экспертиза</h3>
                <ul>
                    <li><p>Анализ API-контрактов, согласование схем данных между несколькими командами.</p></li>
                    <li><p>Проектирование процессов кэширования данных, включая использование Redis.</p></li>
                    <li><p>Применение архитектурного паттерна оркестрации при проектировании микросервисных решений.</p></li>
                    <li><p>Определение и анализ активных SQL-транзакций, идентификация блокировок, долгих запросов и конфликтов доступа.</p></li>
                </ul>

                <h3>Технологии и инструменты</h3>
                <p>BPMN, UML (Use Case, ER, Sequence), SQL, Python, Redis, REST, SOAP, JSON, XML, XSD, Kafka, gRPC, IDEF0, EPC, Jira, Redmine, Confluence.</p>
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

export default Ozon;
