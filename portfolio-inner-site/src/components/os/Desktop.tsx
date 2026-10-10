import React, { useCallback, useEffect, useState } from 'react';
import Colors from '../../constants/colors';
import ShowcaseExplorer from '../applications/ShowcaseExplorer';
import Doom from '../applications/Doom';
import OregonTrail from '../applications/OregonTrail';
import ShutdownSequence from './ShutdownSequence';
// import ThisComputer from '../applications/ThisComputer';
import Pole from '../applications/Pole';
import Toolbar from './Toolbar';
import DesktopShortcut, { DesktopShortcutProps } from './DesktopShortcut';
import Scrabble from '../applications/Scrabble';
import GradeTasks from '../applications/GradeTasks';
import FspAchievements from '../applications/FspAchievements';
import ProjectsVacancies from '../applications/ProjectsVacancies';
import Applicants from '../applications/Applicants';
import CandidateInvitations from '../applications/CandidateInvitations';
import Vacancies from '../applications/Vacancies';
import MyProfile from '../applications/MyProfile';
import { IconName } from '../../assets/icons';
import { useWindowSize } from 'usehooks-ts';
import { currentUserId } from '../../api';
import { AdditionalDesktopIcon, fetchDesktopIcons } from '../../desktopIcons';

export interface DesktopProps {}

// Значки стоят столбцами: сначала приложения, потом дополнительные значки
// (desktopIcons.ts) — у каждого режима свой столбец, соискателя левее рекрутера.
// Что не влезает по высоте, переносится в следующий столбец.
const SHORTCUT_STEP = 104; // px до соседнего значка по вертикали и по горизонтали
const SHORTCUTS_TOP = 16;
const TOOLBAR_HEIGHT = 32; // как в Toolbar.tsx

interface PlacedShortcut {
    shortcut: DesktopShortcutProps;
    top: number;
    left: number;
}

// Место каждого значка: группы по порядку, каждая с нового столбца.
function placeShortcuts(groups: DesktopShortcutProps[][], rows: number): PlacedShortcut[] {
    const placed: PlacedShortcut[] = [];
    let column = 0;
    groups.forEach((group) => {
        group.forEach((shortcut, i) => {
            placed.push({
                shortcut,
                top: (i % rows) * SHORTCUT_STEP,
                left: (column + Math.floor(i / rows)) * SHORTCUT_STEP,
            });
        });
        column += Math.ceil(group.length / rows);
    });
    return placed;
}

type ExtendedWindowAppProps<T> = T & WindowAppProps;

// Окна дополнительных значков: id значка в app/db/additional_desktop_icons.json →
// приложение. Оно получает ещё подпись значка (title), его картинку (image)
// и onAlertsChange — сказать, что у пользователя что-то записано (итог теста,
// связка с ФСП, просмотр приглашения): значки загружаются заново.
// У остальных значков окон пока нет.
const ADDITIONAL_APPLICATIONS: {
    [id: number]: React.FC<
        ExtendedWindowAppProps<{ title: string; image?: string; onAlertsChange: () => void }>
    >;
} = {
    1: FspAchievements, // «Достижения в ФСП»
    2: GradeTasks, // «Задачи на грейд»
    3: Vacancies, // «Вакансии» соискателя
    4: CandidateInvitations, // «Приглашения» соискателя
    6: MyProfile, // собственный профиль и экспорт PDF
    8: ProjectsVacancies, // «Проекты и вакансии» рекрутёра
    9: Applicants, // «Соискатели» рекрутёра
};
// Сервер говорит, через сколько секунд тревога может появиться сама (recheck_after):
// созреет соревнование ФСП или появится приглашение. Значки спрашиваются снова.
const RECHECK_MARGIN = 1000; // мс
const RETRY_ICONS_AFTER = 30000;

// Как окно выглядит на панели задач: название и значок.
interface WindowLabel {
    name: string;
    icon: IconName;
    image?: string;
}

const APPLICATIONS: {
    [key in string]: {
        key: string;
        name: string;
        shortcutIcon: IconName;
        component: React.FC<ExtendedWindowAppProps<any>>;
    };
} = {
    // computer: {
    //     key: 'computer',
    //     name: 'This Computer',
    //     shortcutIcon: 'computerBig',
    //     component: ThisComputer,
    // },
    showcase: {
        key: 'showcase',
        name: 'Об авторе',
        shortcutIcon: 'showcaseIcon',
        component: ShowcaseExplorer,
    },
    trail: {
        key: 'trail',
        name: 'The Oregon Trail',
        shortcutIcon: 'trailIcon',
        component: OregonTrail,
    },
    doom: {
        key: 'doom',
        name: 'Doom',
        shortcutIcon: 'doomIcon',
        component: Doom,
    },
    scrabble: {
        key: 'scrabble',
        name: 'Scrabble',
        shortcutIcon: 'scrabbleIcon',
        component: Scrabble,
    },
    pole: {
        key: 'pole',
        name: 'Поле чудес',
        shortcutIcon: 'poleIcon',
        component: Pole,
    },
};

const Desktop: React.FC<DesktopProps> = (props) => {
    const [windows, setWindows] = useState<DesktopWindows>({});

    const [shortcuts, setShortcuts] = useState<DesktopShortcutProps[]>([]);
    // По группе на режим пользователя: [значки соискателя], [значки рекрутера].
    const [additionalShortcuts, setAdditionalShortcuts] = useState<DesktopShortcutProps[][]>([]);
    // Каждое увеличение — загрузить дополнительные значки заново.
    const [iconsVersion, setIconsVersion] = useState(0);
    const reloadIcons = useCallback(() => setIconsVersion((version) => version + 1), []);
    const { height } = useWindowSize();
    const rows = Math.max(1, Math.floor((height - SHORTCUTS_TOP - TOOLBAR_HEIGHT) / SHORTCUT_STEP));

    const [shutdown, setShutdown] = useState(false);
    const [numShutdowns, setNumShutdowns] = useState(1);

    useEffect(() => {
        if (shutdown === true) {
            rebootDesktop();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shutdown]);

    useEffect(() => {
        const newShortcuts: DesktopShortcutProps[] = [];
        Object.keys(APPLICATIONS).forEach((key) => {
            const app = APPLICATIONS[key];
            newShortcuts.push({
                shortcutName: app.name,
                icon: app.shortcutIcon,
                onOpen: () => {
                    addWindow(
                        app.key,
                        <app.component
                            onInteract={() => onWindowInteract(app.key)}
                            onMinimize={() => minimizeWindow(app.key)}
                            onClose={() => removeWindow(app.key)}
                            key={app.key}
                        />
                    );
                },
            });
        });

        setShortcuts(newShortcuts);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const userId = currentUserId();
        if (!userId) return; // кто пользователь, неизвестно — об этом скажет UserNameDialog
        let active = true;
        let recheck = 0; // window.setTimeout: в сборке есть и типы Node
        fetchDesktopIcons(userId)
            .then(({ modes, icons, recheck_after }) => {
                if (!active) return;
                setAdditionalShortcuts(
                    modes.map((mode) => icons.filter((icon) => icon.mode === mode).map(additionalShortcut))
                );
                if (typeof recheck_after === 'number') {
                    recheck = window.setTimeout(reloadIcons, recheck_after * 1000 + RECHECK_MARGIN);
                }
            })
            .catch(() => {
                if (active) recheck = window.setTimeout(reloadIcons, RETRY_ICONS_AFTER);
            });
        return () => {
            active = false;
            window.clearTimeout(recheck);
        };
        // Как и у приложений выше: значки создаются заново только по reloadIcons, окна открывают через setWindows.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [iconsVersion]);

    useEffect(() => {
        const refreshVisible = () => {
            if (document.visibilityState === 'visible') reloadIcons();
        };
        window.addEventListener('focus', refreshVisible);
        document.addEventListener('visibilitychange', refreshVisible);
        return () => {
            window.removeEventListener('focus', refreshVisible);
            document.removeEventListener('visibilitychange', refreshVisible);
        };
    }, [reloadIcons]);

    const rebootDesktop = useCallback(() => {
        setWindows({});
    }, []);

    const removeWindow = useCallback((key: string) => {
        // Absolute hack and a half
        setTimeout(() => {
            setWindows((prevWindows) => {
                const newWindows = { ...prevWindows };
                delete newWindows[key];
                return newWindows;
            });
        }, 100);
    }, []);

    const minimizeWindow = useCallback((key: string) => {
        setWindows((prevWindows) => {
            const newWindows = { ...prevWindows };
            newWindows[key].minimized = true;
            return newWindows;
        });
    }, []);

    const getHighestZIndex = useCallback((): number => {
        let highestZIndex = 0;
        Object.keys(windows).forEach((key) => {
            const window = windows[key];
            if (window) {
                if (window.zIndex > highestZIndex)
                    highestZIndex = window.zIndex;
            }
        });
        return highestZIndex;
    }, [windows]);

    const toggleMinimize = useCallback(
        (key: string) => {
            const newWindows = { ...windows };
            const highestIndex = getHighestZIndex();
            if (
                newWindows[key].minimized ||
                newWindows[key].zIndex === highestIndex
            ) {
                newWindows[key].minimized = !newWindows[key].minimized;
            }
            newWindows[key].zIndex = getHighestZIndex() + 1;
            setWindows(newWindows);
        },
        [windows, getHighestZIndex]
    );

    const onWindowInteract = useCallback(
        (key: string) => {
            setWindows((prevWindows) => ({
                ...prevWindows,
                [key]: {
                    ...prevWindows[key],
                    zIndex: 1 + getHighestZIndex(),
                },
            }));
        },
        [setWindows, getHighestZIndex]
    );

    const startShutdown = useCallback(() => {
        setTimeout(() => {
            setShutdown(true);
            setNumShutdowns(numShutdowns + 1);
        }, 600);
    }, [numShutdowns]);

    // label — для окон не из APPLICATIONS (дополнительные значки).
    const addWindow = useCallback((key: string, element: JSX.Element, label?: WindowLabel) => {
        setWindows((prevState) => ({
            ...prevState,
            [key]: {
                // По окнам на момент открытия: замыкание значка помнит только первый рендер.
                zIndex: Math.max(0, ...Object.values(prevState).map((window) => window.zIndex)) + 1,
                minimized: false,
                component: element,
                ...(label ?? { name: APPLICATIONS[key].name, icon: APPLICATIONS[key].shortcutIcon }),
            },
        }));
    }, []);

    const additionalShortcut = (icon: AdditionalDesktopIcon): DesktopShortcutProps => {
        const App = ADDITIONAL_APPLICATIONS[icon.id];
        const key = `additional-${icon.id}`;
        const image = icon.image ?? undefined;
        return {
            // У соискателя и рекрутера есть значки с одним названием («Приглашения»).
            id: key,
            shortcutName: icon.name,
            icon: 'windowExplorerIcon', // если у значка нет картинки
            image,
            alert: icon.alert ?? undefined,
            onOpen: () => {
                if (!App) return;
                addWindow(
                    key,
                    <App
                        title={icon.name}
                        image={image}
                        onAlertsChange={reloadIcons}
                        onInteract={() => onWindowInteract(key)}
                        onMinimize={() => minimizeWindow(key)}
                        onClose={() => removeWindow(key)}
                        key={key}
                    />,
                    { name: icon.name, icon: 'windowExplorerIcon', image }
                );
            },
        };
    };

    return !shutdown ? (
        <div style={styles.desktop}>
            {/* For each window in windows, loop over and render  */}
            {Object.keys(windows).map((key) => {
                const element = windows[key].component;
                if (!element) return <div key={`win-${key}`}></div>;
                return (
                    <div
                        key={`win-${key}`}
                        style={Object.assign(
                            {},
                            { zIndex: windows[key].zIndex },
                            windows[key].minimized && styles.minimized
                        )}
                    >
                        {React.cloneElement(element, {
                            key,
                            onInteract: () => onWindowInteract(key),
                            onClose: () => removeWindow(key),
                        })}
                    </div>
                );
            })}
            <div style={styles.shortcuts}>
                {placeShortcuts([shortcuts, ...additionalShortcuts], rows).map(({ shortcut, top, left }) => {
                    return (
                        <div
                            style={Object.assign({}, styles.shortcutContainer, {
                                top,
                                left,
                            })}
                            key={shortcut.id ?? shortcut.shortcutName}
                        >
                            <DesktopShortcut
                                icon={shortcut.icon}
                                image={shortcut.image}
                                id={shortcut.id}
                                shortcutName={shortcut.shortcutName}
                                alert={shortcut.alert}
                                onOpen={shortcut.onOpen}
                            />
                        </div>
                    );
                })}
            </div>
            <Toolbar
                windows={windows}
                toggleMinimize={toggleMinimize}
                shutdown={startShutdown}
            />
        </div>
    ) : (
        <ShutdownSequence
            setShutdown={setShutdown}
            numShutdowns={numShutdowns}
        />
    );
};

const styles: StyleSheetCSS = {
    desktop: {
        minHeight: '100%',
        flex: 1,
        backgroundColor: Colors.turquoise,
    },
    shutdown: {
        minHeight: '100%',
        flex: 1,
        backgroundColor: '#1d2e2f',
    },
    shortcutContainer: {
        position: 'absolute',
    },
    shortcuts: {
        position: 'absolute',
        top: SHORTCUTS_TOP,
        left: 6,
    },
    minimized: {
        pointerEvents: 'none',
        opacity: 0,
    },
};

export default Desktop;
