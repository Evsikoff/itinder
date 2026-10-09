import React from 'react';

const ResumeButtons: React.FC = () => {
    return (
        <div style={styles.container}>
            <a
                href="https://drive.google.com/file/d/1_k0-CzjtFo-6wZTFtNy8tK4UTZvVJ35d/view?usp=sharing"
                target="_blank"
                rel="noreferrer"
                className="site-button"
                style={styles.button}
            >
                Резюме системного аналитика
            </a>
            <a
                href="https://drive.google.com/file/d/1IKD4LSKEHrm7xTBLuBTwpqGanxW-6uyZ/view?usp=sharing"
                target="_blank"
                rel="noreferrer"
                className="site-button"
                style={styles.button}
            >
                Резюме архитектора AI решений
            </a>
        </div>
    );
};

const styles: StyleSheetCSS = {
    container: {
        display: 'flex',
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: 16,
        marginTop: 24,
        marginBottom: 24,
    },
    button: {
        textDecoration: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '12px 24px',
    },
};

export default ResumeButtons;
