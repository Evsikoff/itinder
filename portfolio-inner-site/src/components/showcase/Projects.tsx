import React from 'react';
import { useNavigate } from 'react-router-dom';
import HomeIcon from '../general/HomeIcon';
import ResumeButtons from './ResumeButtons';

export interface ProjectsProps {}

const Projects: React.FC<ProjectsProps> = (props) => {
    const navigate = useNavigate();

    const goHome = () => {
        navigate('/');
    };

    return (
        <div className="site-page-content">
            <h1 style={styles.header}>Pet-проекты</h1>
            <div className="text-block">
                <p>
                    <a
                        href="https://www.rustore.ru/catalog/developer/sz14x0"
                        target="_blank"
                        rel="noreferrer"
                        style={styles.link}
                    >
                        Моя страница на RuStore
                    </a>
                </p>
                <br />
                <p>
                    <a
                        href="https://github.com/Evsikoff"
                        target="_blank"
                        rel="noreferrer"
                        style={styles.link}
                    >
                        Мой профиль на GitHub
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
    link: {
        fontSize: 18,
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

export default Projects;
