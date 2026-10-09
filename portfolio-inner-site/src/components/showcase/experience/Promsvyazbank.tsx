import React from 'react';
import { useNavigate } from 'react-router-dom';
import BackIcon from '../../general/BackIcon';
import HomeIcon from '../../general/HomeIcon';
import ResumeButtons from '../ResumeButtons';

export interface PromsvyazbankProps {}

const Promsvyazbank: React.FC<PromsvyazbankProps> = (props) => {
    const navigate = useNavigate();

    const goHome = () => {
        navigate('/');
    };

    const goBack = () => {
        navigate('/experience');
    };

    return (
        <div className="site-page-content" style={styles.container}>
            <h2>Промсвязьбанк, ПАО</h2>
            <h3 style={styles.subtitle}>Главный системный аналитик (2 года)</h3>

            <div className="text-block">
                <p>Участие в ключевых разработках системы дистанционного банковского обслуживания в качестве системного аналитика и руководителя проектов.</p>

                <h3>Управление проектами</h3>
                <ul>
                    <li><p>Лидирование сложных интеграционных проектов, включающих взаимодействие 10+ сервисов и команд.</p></li>
                    <li><p>Планирование этапов разработки и внедрения, постановка задач, контроль сроков исполнения.</p></li>
                    <li><p>Взаимодействие со стейкхолдерами, управление ожиданиями и согласование изменений.</p></li>
                    <li><p>Подготовка отчетности о ходе проекта, работа с документацией.</p></li>
                    <li><p>Сопровождение разработки и тестирования продукта.</p></li>
                </ul>

                <h3>Аналитика и проектирование решений</h3>
                <ul>
                    <li><p>Проработка архитектурных и функциональных решений, оценка рисков и ограничений.</p></li>
                    <li><p>Подготовка макетов экранных форм (Figma, Balsamiq Mockups).</p></li>
                    <li><p>Нормализация и денормализация данных; проектирование структур данных (PostgreSQL, MS SQL, Yandex Database, файловые БД).</p></li>
                    <li><p>Использование аналитических артефактов для фиксации решений:</p>
                        <ul>
                            <li><p>BPMN, Use Case, Sequence Diagram;</p></li>
                            <li><p>ER-модели и схемы данных;</p></li>
                            <li><p>Схемы интеграционных взаимодействий.</p></li>
                        </ul>
                    </li>
                </ul>

                <h3>Интеграции и техническая экспертиза</h3>
                <ul>
                    <li><p>Проектирование и сопровождение интеграций:</p>
                        <ul>
                            <li><p>синхронные: REST, SOAP, gRPC, WebSocket, WebHook;</p></li>
                            <li><p>асинхронные: Kafka, RabbitMQ;</p></li>
                            <li><p>встраиваемые интерфейсы: iFrame, WebView.</p></li>
                        </ul>
                    </li>
                    <li><p>Анализ исходного кода и поиск причин дефектов (C#, JavaScript, TypeScript, SQL).</p></li>
                    <li><p>Создание экспресс-аналитики и быстрых ETL-прототипов на Python, SQL, TypeScript.</p></li>
                    <li><p>Проектирование алгоритмов репликации и шардирования.</p></li>
                    <li><p>Работа с базами данных: PostgreSQL, MS SQL, файловые БД.</p></li>
                    <li><p>Проектирование вложенных структур данных и схем для их описания:</p>
                        <ul>
                            <li><p>моделирование структур сообщений и конфигураций;</p></li>
                            <li><p>описание и валидация через JSON Schema, XSD, YAML-конфигурации.</p></li>
                        </ul>
                    </li>
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

export default Promsvyazbank;
