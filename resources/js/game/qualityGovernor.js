/** Presentation-only adaptation: no simulation timing or physics is changed. */
export const GOVERNOR = Object.freeze({
    downRatio: 1.22,
    upRatio: 1.04,
    outlierRatio: 4,
    outlierLimit: 3,
    outlierWindow: 1,
    minTargetMs: 1000 / 60,
    minVsyncMs: 4,
    maxVsyncMs: 1000 / 60,
    step: 0.05,
    floor: 0.65,
    clarityFloor: 0.8,
    downCooldown: 1,
    upCooldown: 3,
    featureDownDelay: 3,
});

const UNCHANGED = Object.freeze({ scaleChanged: false, stageChanged: false });

/**
 * Advance the existing Game governor state by a visible frame interval.
 * Auto reduces effects at the clarity floor before using the last resolution
 * reserve. Manual and mobile preserve their configured effect profiles.
 *
 * @param {object} state Game's renderScale/frameAvgMs/cooldown and Auto fields
 * @param {number} rawDt Seconds, before the simulation frame-time clamp
 * @param {{adaptive?: boolean, lowPower?: boolean}} options
 * @returns {{scaleChanged: boolean, stageChanged: boolean}}
 */
export function advanceQualityGovernor(state, rawDt, { adaptive = false, lowPower = false } = {}) {
    // An invalid interval or return from a hidden tab is not GPU pressure.
    if (!Number.isFinite(rawDt) || rawDt <= 0 || rawDt > 0.25) {
        return UNCHANGED;
    }

    const g = GOVERNOR;
    const ms = rawDt * 1000;
    const sample = Math.max(ms, state.prevFrameMs);
    state.prevFrameMs = ms;
    state.vsyncMs = Math.max(g.minVsyncMs, Math.min(g.maxVsyncMs, state.vsyncMs * 1.02, sample));
    const targetMs = Math.max(state.vsyncMs, g.minTargetMs);
    state.scaleCooldown = Math.max(0, state.scaleCooldown - rawDt);

    if (state.outlierTimer > 0) {
        state.outlierTimer = Math.max(0, state.outlierTimer - rawDt);
        if (state.outlierTimer === 0) state.outlierCount = 0;
    }

    if (ms > targetMs * g.outlierRatio) {
        if (state.outlierTimer === 0) state.outlierTimer = g.outlierWindow;
        state.outlierCount = Math.min(g.outlierLimit, state.outlierCount + 1);
        if (state.outlierCount < g.outlierLimit) return UNCHANGED;
        // Repeated slow frames are real pressure, including their time and
        // average. Keep the confirmation alive while the slow stream continues.
        state.outlierTimer = g.outlierWindow;
    }

    // Approximately the old 0.05 EMA at 60 Hz, with the same response time on
    // faster displays and during thermal slowdowns.
    const weight = 1 - Math.exp(-rawDt / 0.325);
    state.frameAvgMs = state.frameAvgMs === 0
        ? ms
        : state.frameAvgMs + (ms - state.frameAvgMs) * weight;

    const canReduceEffects = adaptive === true && !lowPower && state.autoQualityStage < 2;
    const floor = canReduceEffects ? g.clarityFloor : g.floor;
    const overloaded = state.frameAvgMs > targetMs * g.downRatio;

    if (canReduceEffects && state.renderScale <= g.clarityFloor + 1e-8 && overloaded) {
        state.autoQualitySlowSeconds += rawDt;
        if (state.autoQualitySlowSeconds >= g.featureDownDelay - 1e-8) {
            state.autoQualityStage += 1;
            state.autoQualitySlowSeconds = 0;
            // Let a rebuilt effects stack settle; do not increase resolution
            // in the same frame or immediately oscillate around the threshold.
            state.scaleCooldown = g.upCooldown;
            return { scaleChanged: false, stageChanged: true };
        }
    } else if (canReduceEffects) {
        state.autoQualitySlowSeconds = Math.max(0, state.autoQualitySlowSeconds - rawDt * 0.5);
    } else {
        state.autoQualitySlowSeconds = 0;
    }

    if (state.scaleCooldown > 0) return UNCHANGED;

    if (overloaded && state.renderScale > floor) {
        state.renderScale = Math.max(floor, state.renderScale - g.step);
        state.scaleCooldown = g.downCooldown;
        return { scaleChanged: true, stageChanged: false };
    }

    if (state.frameAvgMs < targetMs * g.upRatio && state.renderScale < 1) {
        state.renderScale = Math.min(1, state.renderScale + g.step);
        state.scaleCooldown = g.upCooldown;
        return { scaleChanged: true, stageChanged: false };
    }

    return UNCHANGED;
}
