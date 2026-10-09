import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Home from '../showcase/Home';
import About from '../showcase/About';
import Window from '../os/Window';
import Experience from '../showcase/Experience';
import Projects from '../showcase/Projects';
import Contact from '../showcase/Contact';
import Certificates from '../showcase/Certificates';
import Promsvyazbank from '../showcase/experience/Promsvyazbank';
import Ozon from '../showcase/experience/Ozon';
import Sber from '../showcase/experience/Sber';
import FreeLines from '../showcase/experience/FreeLines';
import CMP from '../showcase/experience/CMP';
import Transneft from '../showcase/experience/Transneft';
import Misis from '../showcase/experience/Misis';
import CeTK from '../showcase/experience/CeTK';
import useInitialWindowSize from '../../hooks/useInitialWindowSize';

export interface ShowcaseExplorerProps extends WindowAppProps {}

const ShowcaseExplorer: React.FC<ShowcaseExplorerProps> = (props) => {
    const { initWidth, initHeight } = useInitialWindowSize({ margin: 100 });

    return (
        <Window
            top={24}
            left={56}
            width={initWidth}
            height={initHeight}
            windowTitle="Евсиков Андрей - Резюме"
            windowBarIcon="windowExplorerIcon"
            closeWindow={props.onClose}
            onInteract={props.onInteract}
            minimizeWindow={props.onMinimize}
            bottomLeftText={'© Copyright 2025 Евсиков Андрей'}
        >
            <Router basename={process.env.PUBLIC_URL}>
                <div className="site-page showcase-font">
                    <Routes>
                        <Route path="/" element={<Home />} />
                        <Route path="/about" element={<About />} />
                        <Route path="/experience" element={<Experience />} />
                        <Route path="/experience/promsvyazbank" element={<Promsvyazbank />} />
                        <Route path="/experience/ozon" element={<Ozon />} />
                        <Route path="/experience/sber" element={<Sber />} />
                        <Route path="/experience/freelines" element={<FreeLines />} />
                        <Route path="/experience/cmp" element={<CMP />} />
                        <Route path="/experience/transneft" element={<Transneft />} />
                        <Route path="/experience/misis" element={<Misis />} />
                        <Route path="/experience/cetk" element={<CeTK />} />
                        <Route path="/projects" element={<Projects />} />
                        <Route path="/certificates" element={<Certificates />} />
                        <Route path="/contact" element={<Contact />} />
                    </Routes>
                </div>
            </Router>
        </Window>
    );
};

export default ShowcaseExplorer;
