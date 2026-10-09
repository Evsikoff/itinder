import React from 'react';
import { Link } from '../general';
import ResumeButtons from './ResumeButtons';

export interface HomeProps {}

const Home: React.FC<HomeProps> = (props) => {
    return (
        <div style={styles.page}>
            <div style={styles.header}>
                <h1 style={styles.name}>Евсиков Андрей</h1>
                <h2>Системный аналитик и архитектор AI решений</h2>
            </div>
            <div style={styles.buttons}>
                <Link containerStyle={styles.link} to="about" text="1. Обо мне" />
                <Link
                    containerStyle={styles.link}
                    to="experience"
                    text="2. Опыт"
                />
                <Link
                    containerStyle={styles.link}
                    to="certificates"
                    text="3. Дипломы и сертификаты"
                />
                <Link
                    containerStyle={styles.link}
                    to="projects"
                    text="4. Pet-проекты"
                />
                <Link
                    containerStyle={styles.link}
                    to="contact"
                    text="5. Контакты"
                />
            </div>
            <div style={styles.resumeLink}>
                <ResumeButtons />
            </div>
        </div>
    );
};

const styles: StyleSheetCSS = {
    page: {
        left: 0,
        right: 0,
        top: 0,
        position: 'absolute',
        justifyContent: 'center',
        alignItems: 'center',
        flexDirection: 'column',
        height: '100%',
    },
    header: {
        textAlign: 'center',
        marginBottom: 64,
        marginTop: 64,

        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttons: {
        justifyContent: 'space-between',
        flexDirection: 'column',
        alignItems: 'center',
    },
    image: {
        width: 800,
    },
    link: {
        padding: 16,
    },
    resumeLink: {
        marginTop: 24,
        textAlign: 'center',
    },
    name: {
        fontSize: 72,
        marginBottom: 16,
        lineHeight: 0.9,
    },
};

export default Home;
