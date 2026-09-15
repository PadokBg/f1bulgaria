/** Keep native controls, dialogs and browser shortcuts independent of driving. */
export function shouldCaptureGameKey(event, started) {
    if (!started || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) {
        return false;
    }
    const target = event.target;
    if (target?.isContentEditable || target?.closest?.('input, textarea, select, [role="dialog"], [contenteditable=""], [contenteditable="true"]')) {
        return false;
    }
    if (event.repeat && ['KeyR', 'KeyC', 'KeyM'].includes(event.code)) {
        return false;
    }
    return true;
}
