import assert from 'node:assert/strict';
import { TOUCH_CONTROLS, createTouchControls, liveTouchControls, touchControlOf } from '../../resources/js/game/touchControls.js';

// A DOM-ish node: `closest` finds the button carrying data-touch-control.
const button = (control) => ({ dataset: { touchControl: control }, closest: () => button(control) });
const iconIn = (control) => ({ dataset: {}, closest: (selector) => (selector === '[data-touch-control]' ? button(control) : null) });
const touchOn = (control) => ({ target: iconIn(control) });

// ── Lookup ───────────────────────────────────────────────────────────────
assert.equal(touchControlOf(iconIn('right')), 'right', 'A finger on the arrow icon belongs to its button');
assert.equal(touchControlOf(null), null);
assert.equal(touchControlOf({ closest: () => null }), null, 'A finger on the canvas holds nothing');
assert.equal(touchControlOf(button('horn')), null, 'Unknown controls are ignored');
assert.deepEqual([...liveTouchControls({ length: 2, 0: touchOn('left'), 1: { target: null } })], ['left']);

// ── Normal press/release, multi-touch on one button ──────────────────────
let controls = createTouchControls();
controls.hold('right', 1, 'touch');
assert.equal(controls.isHeld('right'), true);
controls.release('right', 1);
assert.equal(controls.isHeld('right'), false);

controls.hold('throttle', 2, 'touch');
controls.hold('throttle', 3, 'touch');
controls.release('throttle', 2);
assert.equal(controls.isHeld('throttle'), true, 'Lifting one thumb must not release the other');

// ── The reported bug: pointerup lost, no finger on the screen ────────────
controls = createTouchControls();
controls.hold('right', 7, 'touch');
assert.equal(controls.reconcile(liveTouchControls({ length: 0 })), true);
assert.equal(controls.isHeld('right'), false, 'No fingers on the glass means no steering');

// Stale right + a fresh press on left: left must win, not cancel out to zero.
controls = createTouchControls();
controls.hold('right', 7, 'touch');
controls.hold('left', 8, 'touch');
controls.reconcile(liveTouchControls({ length: 1, 0: touchOn('left') }));
assert.equal(controls.isHeld('right'), false, 'The stale right press is dropped');
assert.equal(controls.isHeld('left'), true, 'The live left press survives');

// Gas held with the right thumb while steering with the left stays held.
controls = createTouchControls();
controls.hold('throttle', 1, 'touch');
controls.hold('left', 2, 'touch');
assert.equal(controls.reconcile(liveTouchControls({ length: 2, 0: touchOn('throttle'), 1: touchOn('left') })), false);
assert.equal(controls.isHeld('throttle') && controls.isHeld('left'), true, 'Live presses are never touched');

// Mouse (iPad trackpad) never appears in TouchEvent.touches.
controls = createTouchControls();
controls.hold('brake', 1, 'mouse');
controls.reconcile(new Set());
assert.equal(controls.isHeld('brake'), true, 'A held mouse button is not a stale touch');

// ── Capture lost: pointerup lands elsewhere ──────────────────────────────
controls = createTouchControls();
controls.hold('right', 4, 'touch');
assert.equal(controls.releasePointer(4), true);
assert.equal(controls.isHeld('right'), false);
assert.equal(controls.releasePointer(4), false, 'Releasing twice reports no change');

controls.hold('left', 5, 'touch');
controls.hold('brake', 6, 'touch');
controls.releaseAll();
assert.equal(TOUCH_CONTROLS.some((control) => controls.isHeld(control)), false, 'releaseAll clears every button');

console.log('Touch controls: press/release, multi-touch, lost pointerup, stale steering and mouse passed.');
