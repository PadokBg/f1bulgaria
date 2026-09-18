/**
 * Phone on-screen controls: which buttons are held, and by which pointers.
 *
 * Each button keeps its own set of pointer ids, so lifting one thumb never
 * releases another thumb on the same button. The weak spot of any
 * down/up bookkeeping is a lost "up": iOS can swallow the pointerup (system
 * edge gestures, a capture target that left the DOM), and the id then stays
 * "held" forever — the car keeps steering with no finger on the glass.
 *
 * `reconcile()` closes that hole. Every TouchEvent carries the full list of
 * fingers that are on the screen right now; a touch-held button with no live
 * finger on it is stale and gets released. Mouse pointers are exempt: they
 * never appear in TouchEvent.touches.
 */

export const TOUCH_CONTROLS = Object.freeze(['left', 'right', 'throttle', 'brake']);

/**
 * The button a touch belongs to. `touch.target` is the element the finger
 * first landed on (it may be the icon inside the button, or a node Vue has
 * since detached), so the lookup goes through the data attribute.
 *
 * @param {EventTarget|null|undefined} target
 * @returns {string|null}
 */
export function touchControlOf(target) {
    const button = target?.closest?.('[data-touch-control]');
    const control = button?.dataset?.touchControl;

    return TOUCH_CONTROLS.includes(control) ? control : null;
}

/**
 * Buttons that have at least one finger on them, from TouchEvent.touches.
 *
 * @param {ArrayLike<{target: EventTarget|null}>} touches
 * @returns {Set<string>}
 */
export function liveTouchControls(touches) {
    const live = new Set();
    for (let i = 0; i < touches.length; i++) {
        const control = touchControlOf(touches[i]?.target);
        if (control !== null) {
            live.add(control);
        }
    }

    return live;
}

export function createTouchControls() {
    /** @type {Record<string, Map<number, string>>} control → (pointerId → pointerType) */
    const held = Object.fromEntries(TOUCH_CONTROLS.map((control) => [control, new Map()]));

    return {
        /**
         * @param {string} control
         * @param {number} pointerId
         * @param {string} pointerType
         */
        hold(control, pointerId, pointerType) {
            held[control]?.set(pointerId, pointerType);
        },

        /**
         * @param {string} control
         * @param {number} pointerId
         */
        release(control, pointerId) {
            held[control]?.delete(pointerId);
        },

        /**
         * A pointer ended somewhere other than its button (capture lost).
         *
         * @param {number} pointerId
         * @returns {boolean} Whether anything was released
         */
        releasePointer(pointerId) {
            let changed = false;
            for (const pointers of Object.values(held)) {
                changed = pointers.delete(pointerId) || changed;
            }

            return changed;
        },

        /**
         * Drops touch pointers on buttons that no live finger is touching.
         *
         * @param {Set<string>} liveControls From liveTouchControls(event.touches)
         * @returns {boolean} Whether anything was released
         */
        reconcile(liveControls) {
            let changed = false;
            for (const [control, pointers] of Object.entries(held)) {
                if (liveControls.has(control)) {
                    continue;
                }
                for (const [pointerId, pointerType] of pointers) {
                    if (pointerType !== 'mouse') {
                        pointers.delete(pointerId);
                        changed = true;
                    }
                }
            }

            return changed;
        },

        releaseAll() {
            for (const pointers of Object.values(held)) {
                pointers.clear();
            }
        },

        /**
         * @param {string} control
         * @returns {boolean}
         */
        isHeld(control) {
            return (held[control]?.size ?? 0) > 0;
        },
    };
}
