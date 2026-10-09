import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Link } from '../general';
import HomeIcon from '../general/HomeIcon';
import ResumeButtons from './ResumeButtons';

export interface ExperienceProps {}

const Experience: React.FC<ExperienceProps> = (props) => {
    const navigate = useNavigate();

    const goHome = () => {
        navigate('/');
    };

    return (
        <div className="site-page-content">
            <h1 style={styles.header}>Опыт</h1>
            <div style={styles.columnsContainer}>
                <div style={styles.column}>
                    <h3 style={styles.columnHeader}>Опыт в системном анализе</h3>
                    <div className="text-block" style={styles.menu}>
                        <Link
                            containerStyle={styles.link}
                            to="experience/promsvyazbank"
                            text="Промсвязьбанк, ПАО - Главный системный аналитик (2 года)"
                        />
                        <Link
                            containerStyle={styles.link}
                            to="experience/ozon"
                            text="OZON.ru, Интернет-магазин - Ведущий системный аналитик (2 года и 10 месяцев)"
                        />
                        <Link
                            containerStyle={styles.link}
                            to="experience/sber"
                            text="Сбер (аутстаф от Бэлл Интегратор, ООО) - Ведущий системный аналитик (1 год и 3 месяца)"
                        />
                        <Link
                            containerStyle={styles.link}
                            to="experience/freelines"
                            text="Free Lines Company - Ведущий системный аналитик (3 года и 10 месяцев)"
                        />
                        <Link
                            containerStyle={styles.link}
                            to="experience/cmp"
                            text="Центр Молодежного Парламентаризма - Аналитик и разработчик (6 месяцев)"
                        />
                        <Link
                            containerStyle={styles.link}
                            to="experience/transneft"
                            text="Транснефть (аутстаф от Ай-Теко) - Младший аналитик SAP PS / PM (1,5 года)"
                        />
                        <Link
                            containerStyle={styles.link}
                            to="experience/misis"
                            text="НИТУ «МИСиС» - Инженер-программист (1 год 11 месяцев)"
                        />
                        <Link
                            containerStyle={styles.link}
                            to="experience/cetk"
                            text="ЦеТК - Стажер-аналитик (4 месяца стажировки от ВУЗа)"
                        />
                    </div>
                </div>
                <div style={styles.column}>
                    <h3 style={styles.columnHeader}>Опыт в AI решениях</h3>
                    <div className="text-block">
                        <p>
                            Самостоятельное проектирование, разработка и поддержка инфраструктуры AI-решений для бизнеса. Специализируюсь на создании отказоустойчивых систем с минимальными операционными издержками, используя ИИ для умножения производительности.
                        </p>
                        <br />
                        <p><b>Ключевые достижения:</b></p>
                        <br />
                        <p><b>Автоматизация и Data Engineering:</b></p>
                        <ul>
                            <li>Лично спроектировал и внедрил 55+ интеграционных пайплайнов (40+ на n8n, 15 на Yandex Cloud Workflows).</li>
                            <li>Реализовал сложные сценарии: трансформация неструктурированных данных (NLP) в строгие типы данных, валидация JSON-схем, потоковая OCR-обработка документов.</li>
                            <li><b>Результат:</b> Созданные системы работают автономно, требуя минимального вмешательства.</li>
                        </ul>
                        <br />
                        <p><b>High-Volume Architecture:</b></p>
                        <ul>
                            <li>Развернул и администрирую экосистему из 100+ наносервисов на микро-виртуальных машинах.</li>
                            <li><b>Архитектурный подход:</b> Гибридная логика. ИИ-агенты используются исключительно для когнитивных задач (анализ смысла, принятие решений), а процедурный код (Python/Bash) — для детерминированных операций. Это обеспечивает промышленную надежность и предсказуемость, недостижимую при использовании только LLM.</li>
                        </ul>
                        <br />
                        <p><b>AI-Driven Development:</b></p>
                        <ul>
                            <li>Используя современные AI-инструменты кодинга, в одиночку разработал и запустил более ста web-приложений (Full-stack).</li>
                            <li>Весь цикл: от генерации UI и бизнес-логики до деплоя.</li>
                        </ul>
                    </div>
                </div>
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
    columnsContainer: {
        display: 'flex',
        flexDirection: 'row',
        gap: 32,
        flexWrap: 'wrap',
    },
    column: {
        flex: '1 1 400px',
        minWidth: 300,
        display: 'flex',
        flexDirection: 'column',
    },
    columnHeader: {
        marginBottom: 24,
        textDecoration: 'underline',
    },
    menu: {
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
    },
    link: {
        padding: 12,
        fontSize: 16,
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

export default Experience;
