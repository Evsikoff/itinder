import React from 'react';
import { useNavigate } from 'react-router-dom';
import HomeIcon from '../general/HomeIcon';
import ResumeButtons from './ResumeButtons';

// --- Статические импорты ---
import img_395488 from '../../assets/pictures/evsikov/395488.png';
import img_39554 from '../../assets/pictures/evsikov/39554.png';
import img_4848 from '../../assets/pictures/evsikov/4848.png';
import img_48851 from '../../assets/pictures/evsikov/48851.png';
import img_5895959 from '../../assets/pictures/evsikov/5895959.png';
import img_5958 from '../../assets/pictures/evsikov/5958.png';
import img_595848 from '../../assets/pictures/evsikov/595848.png';
import img_59632 from '../../assets/pictures/evsikov/59632.jpg';
import img_596552 from '../../assets/pictures/evsikov/596552.jpg';
import img_59846 from '../../assets/pictures/evsikov/59846.jpg';
import img_63214 from '../../assets/pictures/evsikov/63214.jpg';
import img_6559 from '../../assets/pictures/evsikov/6559.png';
import img_66994587 from '../../assets/pictures/evsikov/66994587.jpg';
import img_695417 from '../../assets/pictures/evsikov/695417.jpg';
import img_84848 from '../../assets/pictures/evsikov/84848.png';
import img_84848521 from '../../assets/pictures/evsikov/84848521.png';
import img_88846 from '../../assets/pictures/evsikov/88846.png';
import img_9558477 from '../../assets/pictures/evsikov/9558477.jpg';
import img_956954 from '../../assets/pictures/evsikov/956954.jpg';
import img_959559 from '../../assets/pictures/evsikov/959559.png';
import img_9655 from '../../assets/pictures/evsikov/9655.jpg';
import img_966654 from '../../assets/pictures/evsikov/966654.png';

export interface CertificatesProps {}

// Размеры для превью
const RATIO_LANDSCAPE = { w: 300, h: 212 };
const RATIO_PORTRAIT = { w: 212, h: 300 };

// Данные изображений
const CERTIFICATES_DATA = [
    { src: img_395488, ...RATIO_LANDSCAPE },
    { src: img_39554, ...RATIO_LANDSCAPE },
    { src: img_4848, ...RATIO_LANDSCAPE },
    { src: img_48851, ...RATIO_LANDSCAPE },
    { src: img_5895959, ...RATIO_LANDSCAPE },
    { src: img_5958, ...RATIO_LANDSCAPE },
    { src: img_595848, ...RATIO_LANDSCAPE },
    { src: img_59632, ...RATIO_LANDSCAPE },
    { src: img_596552, ...RATIO_LANDSCAPE },
    { src: img_59846, ...RATIO_LANDSCAPE },
    { src: img_63214, ...RATIO_LANDSCAPE },
    { src: img_6559, ...RATIO_LANDSCAPE },
    { src: img_66994587, ...RATIO_PORTRAIT },
    { src: img_695417, ...RATIO_LANDSCAPE },
    { src: img_84848, ...RATIO_LANDSCAPE },
    { src: img_84848521, ...RATIO_PORTRAIT },
    { src: img_88846, ...RATIO_LANDSCAPE },
    { src: img_9558477, ...RATIO_PORTRAIT },
    { src: img_956954, ...RATIO_PORTRAIT },
    { src: img_959559, ...RATIO_PORTRAIT },
    { src: img_9655, ...RATIO_LANDSCAPE },
    { src: img_966654, ...RATIO_LANDSCAPE },
].map((item, index) => {
    // Расчет угла поворота
    const rotate = (index % 2 === 0 ? 1 : -1) * ((index * 7) % 6 + 2);
    const translateY = (index % 3) * 10; 
    return { ...item, rotate, translateY };
});

const Certificates: React.FC<CertificatesProps> = () => {
    const navigate = useNavigate();

    const goHome = () => {
        navigate('/');
    };

    return (
        <div className="site-page-content" style={styles.pageBackground}>
            <style>{`
                .album-card {
                    transition: all 0.4s cubic-bezier(0.25, 0.8, 0.25, 1);
                    box-shadow: 5px 5px 15px rgba(0,0,0,0.2);
                    position: relative;
                    z-index: 1;
                    cursor: pointer;
                    background: #fff;
                }
                .album-card::before {
                    content: '';
                    position: absolute;
                    top: -15px;
                    left: 50%;
                    transform: translateX(-50%);
                    width: 100px;
                    height: 30px;
                    background-color: rgba(255, 255, 255, 0.6);
                    border-left: 1px dashed rgba(0,0,0,0.1);
                    border-right: 1px dashed rgba(0,0,0,0.1);
                    box-shadow: 0px 2px 4px rgba(0,0,0,0.1);
                    opacity: 0.7;
                    z-index: 2;
                    pointer-events: none;
                }
                .album-card:hover {
                    transform: scale(1.2) rotate(0deg) translateY(0) !important;
                    z-index: 100;
                    box-shadow: 20px 20px 40px rgba(0,0,0,0.4);
                }
                .album-card img {
                    filter: sepia(15%);
                    transition: filter 0.3s;
                }
                .album-card:hover img {
                    filter: sepia(0%);
                }
            `}</style>

            <h1 style={styles.header}>Дипломы и сертификаты</h1>

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

            <div style={styles.albumContainer}>
                {CERTIFICATES_DATA.map((img, index) => (
                    <div 
                        key={index} 
                        className="album-card"
                        style={{
                            ...styles.cardWrapper,
                            width: img.w,
                            height: img.h + 35,
                            transform: `rotate(${img.rotate}deg) translateY(${img.translateY}px)`,
                        }}
                        onClick={() => window.open(img.src, '_blank', 'noopener,noreferrer')}
                        title="Нажмите, чтобы открыть оригинал"
                    >
                        <div style={{ width: img.w - 20, height: img.h - 20, margin: '10px auto 0' }}>
                            <img
                                src={img.src}
                                alt={`Сертификат ${index + 1}`}
                                loading="lazy"
                                style={styles.image}
                            />
                        </div>
                    </div>
                ))}
            </div>

            <div style={styles.resumeContainer}>
                <ResumeButtons />
            </div>
        </div>
    );
};

const styles: Record<string, React.CSSProperties> = {
    pageBackground: {
        backgroundColor: '#f4f1ea',
        minHeight: '100vh',
        paddingBottom: 60,
    },
    header: {
        marginBottom: 48,
        marginTop: 32,
        textAlign: 'center',
        color: '#222',
    },
    albumContainer: {
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: '60px',
        padding: '20px 40px',
        maxWidth: '1400px',
        margin: '0 auto',
    },
    cardWrapper: {
        padding: 0,
        boxSizing: 'content-box',
        backgroundColor: '#fff',
        border: '1px solid #e0e0e0', 
    },
    image: {
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        display: 'block',
        border: '1px solid #eee',
    },
    resumeContainer: {
        marginTop: 80,
        textAlign: 'center',
    },
    homeButtonContainer: {
        marginTop: 0,
        marginBottom: 32,
        display: 'flex',
        justifyContent: 'center',
        position: 'relative',
        zIndex: 1000,
    },
    homeButton: {
        padding: 12,
        minWidth: 64,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#e9e9e9',
        border: '2px solid #000',
    },
};

export default Certificates;
