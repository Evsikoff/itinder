import React from 'react';
import { useNavigate } from 'react-router-dom';
import BackIcon from '../../general/BackIcon';
import HomeIcon from '../../general/HomeIcon';
import ResumeButtons from '../ResumeButtons';

const CeTK: React.FC = () => {
    const navigate = useNavigate();
    const goHome = () => navigate('/');
    const goBack = () => navigate('/experience');

    return (
        <div className="site-page-content" style={styles.container}>
            <h2>ЦеТК</h2>
            <h3 style={styles.subtitle}>Стажер-аналитик (4 месяца стажировки от ВУЗа)</h3>

            <div className="text-block">
                <p>
                    <b>Внедрение системы "Электронный Бюджет"</b>
                </p>
                <br />
                <p>
                    Разрабатывал модель распределения информационных потоков. Написал на основе проделанной работы дипломную работу бакалавра.
                </p>
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
                <button className="site-button" style={styles.homeButton} onClick={goHome} title="На главную">
                    <HomeIcon size={24} />
                </button>
            </div>
        </div>
    );
};

const styles: StyleSheetCSS = {
    container: { maxHeight: '100%', overflowY: 'auto' },
    subtitle: { marginBottom: 32, marginTop: 8 },
    resumeContainer: { marginTop: 48, textAlign: 'center' },
    homeButtonContainer: { marginTop: 32, marginBottom: 32, display: 'flex', justifyContent: 'center', gap: 12 },
    homeButton: { padding: 12, minWidth: 64, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
};

export default CeTK;
