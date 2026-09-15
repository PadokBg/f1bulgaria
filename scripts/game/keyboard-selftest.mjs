import assert from 'node:assert/strict';
import { shouldCaptureGameKey } from '../../resources/js/game/keyboard.js';

const key = (extra = {}) => ({ code: 'ArrowUp', target: null, ...extra });
assert.equal(shouldCaptureGameKey(key(), false), false, 'Prestart controls must keep native keyboard navigation');
for (const selector of ['input', 'textarea', 'select', '[role="dialog"]']) {
    const target = { closest: (selectors) => selectors.includes(selector) ? {} : null };
    assert.equal(shouldCaptureGameKey(key({ target }), true), false, `Do not steal arrows from ${selector}`);
}
assert.equal(shouldCaptureGameKey(key({ target: { isContentEditable: true } }), true), false);
for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'isComposing', 'defaultPrevented']) {
    assert.equal(shouldCaptureGameKey(key({ [modifier]: true }), true), false, modifier);
}
for (const code of ['KeyR', 'KeyC', 'KeyM']) {
    assert.equal(shouldCaptureGameKey(key({ code, repeat: true }), true), false, `Holding ${code} must not repeat its action`);
    assert.equal(shouldCaptureGameKey(key({ code }), true), true);
}
assert.equal(shouldCaptureGameKey(key({ repeat: true }), true), true, 'Held driving keys continue to work');
assert.equal(shouldCaptureGameKey(key(), true), true, 'Normal driving remains enabled');
console.log('Keyboard: native controls, shortcuts, repeats and driving passed.');
