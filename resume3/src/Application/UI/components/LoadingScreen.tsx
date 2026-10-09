import React, { useEffect } from 'react';
import eventBus from '../EventBus';

/**
 * Hides the loading screen (#veil in index.html, same as in the main ITinder
 * app) as soon as the room is loaded and drawn, then starts the scene.
 * There is no START button: sound is unlocked by the first click or key
 * (see Audio/AudioManager.ts).
 */
const LoadingScreen: React.FC = () => {
    useEffect(() => {
        const veil = document.getElementById('veil');

        const start = () => {
            veil?.classList.add('gone');
            eventBus.dispatch('loadingScreenDone', {});
            const ui = document.getElementById('ui');
            if (ui) {
                ui.style.pointerEvents = 'none';
            }
        };

        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('debug')) {
            start();
        } else if (!detectWebGLContext()) {
            veil?.classList.add('no-webgl');
        } else {
            // The world is built right after the last source is loaded
            // (Resources 'ready'), so two frames later it has been drawn once
            eventBus.on('loadedSource', (data) => {
                if (data.progress >= 1) {
                    requestAnimationFrame(() => requestAnimationFrame(start));
                }
            });
        }
    }, []);

    return null;
};

const detectWebGLContext = () => {
    var canvas = document.createElement('canvas');

    // Get WebGLRenderingContext from canvas element.
    var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    // Report the result.
    if (gl && gl instanceof WebGLRenderingContext) {
        return true;
    }
    return false;
};

export default LoadingScreen;
