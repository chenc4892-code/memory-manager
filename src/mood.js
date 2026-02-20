/**
 * Memory Manager — Lottie Mood System
 */

import { LOTTIE_CDN, MOOD_FILES } from './constants.js';
import { warn } from './utils.js';

let currentMood = 'idle';
let lottieInstance = null;
let moodResetTimer = null;

export function getCurrentMood() {
    return currentMood;
}

export async function loadLottieLib() {
    if (window.lottie) return;
    return new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = LOTTIE_CDN;
        script.onload = resolve;
        script.onerror = () => { warn('Failed to load Lottie library from CDN'); resolve(); };
        document.head.appendChild(script);
    });
}

/**
 * Set the robot's mood animation.
 * @param {string} mood - One of: idle, thinking, joyful, inlove, angry, sad
 * @param {number} autoResetMs - If > 0, auto-reset to idle after this many ms
 */
export function setMood(mood, autoResetMs = 0) {
    if (!MOOD_FILES[mood] || !window.lottie) return;
    if (mood === currentMood && lottieInstance) return;

    currentMood = mood;

    const container = document.getElementById('mm_lottie_container');
    if (!container) return;

    if (lottieInstance) {
        lottieInstance.destroy();
        lottieInstance = null;
    }

    // Navigate from src/ up to the extension root for lottie files
    const baseUrl = new URL('..', import.meta.url).pathname;
    lottieInstance = window.lottie.loadAnimation({
        container,
        renderer: 'svg',
        loop: true,
        autoplay: true,
        path: `${baseUrl}lottie/${MOOD_FILES[mood]}`,
    });

    if (moodResetTimer) clearTimeout(moodResetTimer);
    if (autoResetMs > 0) {
        moodResetTimer = setTimeout(() => setMood('idle'), autoResetMs);
    }
}
