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
    // Cadence lock (see advanceCadence): one decision per window of this many
    // presented frames; a window is "flat" when this share of its intervals
    // sits within the tolerance of its median; this many consecutive dirty
    // windows release the lock; a scale change gets this many frames to
    // settle (buffer reallocation) before its window starts counting.
    cadenceWindow: 64,
    cadenceToleranceMs: 2,
    cadenceFlatShare: 0.85,
    cadenceStrikes: 2,
    cadenceSettleFrames: 8,
});

const UNCHANGED = Object.freeze({ scaleChanged: false, stageChanged: false });
const SCALE_CHANGED = Object.freeze({ scaleChanged: true, stageChanged: false });

/**
 * Cadence-lock bookkeeping, owned by the Game instance next to the classic
 * governor fields. A phone whose requestAnimationFrame is pinned to 30 Hz
 * (iOS Low Power Mode, WebKit thermal mitigation) or whose frame is CPU-bound
 * presents a dead-flat 33.3 ms cadence that no render scale can move; the
 * classic rules read that as permanent overload and park the picture at the
 * resolution floor for nothing. The lock notices a flat cadence that the
 * floor did not change, gives the pixels back one verified step at a time
 * and holds them until the cadence itself changes.
 *
 * Phases: idle → descent (a streak of step-downs; its first flat window is
 * remembered as the reference for a direct jump back) → probing (locked,
 * ascending one step per clean window) → held (ascent stopped; only the
 * release check runs). lockedCadenceMs > 0 ⇔ locked.
 */
export function createCadenceState() {
    return {
        frameRing: new Float32Array(GOVERNOR.cadenceWindow),
        frameRingIndex: 0,
        cadenceFrames: 0,
        cadenceWindowScale: 1,
        cadenceRacing: true,
        cadencePhase: 'idle',
        cadenceRefMs: 0,
        cadenceRefScale: 1,
        lockedCadenceMs: 0,
        cadenceStrikes: 0,
        cadenceRestoresDisabled: false,
    };
}

/**
 * A new run keeps what it learnt (a proven lock, a reference from a descent
 * the previous run did not finish) — a wrong reference is caught at the floor
 * and by the verification of the jump — but never decides on a window that
 * straddles the restart.
 */
export function resetCadenceForRun(state) {
    restartCadenceWindow(state);
}

/** Decisions are taken on whole windows: after a pause the window starts over. */
export function restartCadenceWindow(state) {
    state.cadenceFrames = 0;
    state.cadenceWindowScale = state.renderScale;
}

/**
 * A cadence-driven scale change reallocates the drawing buffer; the first
 * frames after it are not the new steady state and stay out of its window.
 */
function settleCadenceWindow(state) {
    state.cadenceFrames = -GOVERNOR.cadenceSettleFrames;
    state.cadenceWindowScale = state.renderScale;
}

const sorted = new Float32Array(GOVERNOR.cadenceWindow);

/**
 * Median, mean and flatness of the last window. Hitches stay in the ring on
 * purpose: a window with many of them is not a stable cadence.
 *
 * @returns {{median: number, mean: number, flat: boolean}}
 */
function cadenceStats(state) {
    const g = GOVERNOR;
    const count = g.cadenceWindow;
    sorted.set(state.frameRing);
    sorted.sort();
    const median = sorted[count >> 1];
    let within = 0;
    let sum = 0;
    for (let i = 0; i < count; i++) {
        sum += sorted[i];
        if (Math.abs(sorted[i] - median) <= g.cadenceToleranceMs) {
            within++;
        }
    }
    return { median, mean: sum / count, flat: within / count >= g.cadenceFlatShare };
}

/**
 * One cadence decision per full window.
 *
 * Above the floor a descent only learns: its first flat, overloaded window is
 * the reference (median + the scale its frames were rendered at) for a direct
 * jump back. At the floor, once a whole window has been rendered there and it
 * is flat: the same cadence as the reference means the pixels bought nothing
 * — jump back to the reference scale; any other flat, overloaded cadence
 * (no reference because the start was noisy, a knee between the top and the
 * floor, a reset at the floor) is probed instead — lock at the floor and
 * climb one step per clean window. The floor is never terminal.
 *
 * Locked (probing or held): every window is checked against the locked
 * cadence — a slower median, a mean overloaded relative to it, a window that
 * is not flat at all, or a FASTER median each count as a strike; two in a
 * row release the lock. Only the slow kind moves the scale: while probing, a
 * clean window earns one step up and a slow one steps back and holds (a slow
 * first window after the jump drops straight back to the floor); a faster
 * window (Low Power Mode switched off, cooler phone) just releases, and the
 * classic up-rules take over from where the scale is. A release caused by a
 * clearly WORSE cadence (≥ downRatio) disables further judged descents for
 * this Game: thermal throttling is not a cap to probe.
 *
 * Only racing frames move the scale; the reference may be captured on any
 * frame (the start lights or a replay on a pinned phone present the same
 * cadence, and a wrong reference is caught by the floor comparison and the
 * verification of the jump), and a faster cadence releases the lock on any
 * frame — a replay's different scene must not be read as a slower one.
 *
 * @returns {null|{scaleChanged: boolean, stageChanged: boolean}} Non-null when the scale changed.
 */
function advanceCadence(state, targetMs, racing) {
    const g = GOVERNOR;
    if (state.cadenceFrames < g.cadenceWindow) {
        return null;
    }
    const atFloor = state.renderScale <= g.floor + 1e-8;
    const windowAtFloor = atFloor && state.cadenceWindowScale <= g.floor + 1e-8;
    const locked = state.lockedCadenceMs > 0;
    if (!locked && state.cadencePhase === 'idle' && !windowAtFloor) {
        return null;
    }
    if (!racing && !locked && windowAtFloor) {
        return null;
    }
    const stats = cadenceStats(state);
    const windowScale = state.cadenceWindowScale;
    state.cadenceFrames = 0;
    state.cadenceWindowScale = state.renderScale;
    const overloaded = stats.median > targetMs * g.downRatio;

    if (!locked) {
        if (!windowAtFloor) {
            if (state.cadenceRefMs === 0 && stats.flat && overloaded) {
                state.cadenceRefMs = stats.median;
                state.cadenceRefScale = windowScale;
            }
            return null;
        }
        if (!stats.flat || state.cadenceRestoresDisabled) {
            return null;
        }
        if (state.cadenceRefMs > 0 && Math.abs(stats.median - state.cadenceRefMs) <= g.cadenceToleranceMs) {
            state.renderScale = state.cadenceRefScale;
        } else if (overloaded) {
            state.cadenceRefScale = g.floor;
        } else {
            return null;
        }
        state.lockedCadenceMs = stats.median;
        state.cadenceStrikes = 0;
        state.cadencePhase = 'probing';
        settleCadenceWindow(state);
        return state.renderScale > g.floor + 1e-8 ? SCALE_CHANGED : null;
    }

    const lockedMs = state.lockedCadenceMs;
    const faster = stats.median < lockedMs - g.cadenceToleranceMs;
    const worse = !faster && (stats.median > lockedMs * g.downRatio || stats.mean > lockedMs * g.downRatio);
    const slower = !faster && (stats.median > lockedMs + g.cadenceToleranceMs || worse || !stats.flat);
    if (!racing && !faster) {
        return null;
    }
    if (faster || slower) {
        state.cadenceStrikes++;
        if (state.cadenceStrikes >= g.cadenceStrikes) {
            state.cadenceRestoresDisabled = state.cadenceRestoresDisabled || worse;
            state.lockedCadenceMs = 0;
            state.cadenceStrikes = 0;
            state.cadenceRefMs = 0;
            state.cadencePhase = 'idle';
            return null;
        }
    } else {
        state.cadenceStrikes = 0;
    }
    if (state.cadencePhase !== 'probing' || faster) {
        return null;
    }
    if (!slower) {
        if (state.renderScale < 1 - 1e-8) {
            state.renderScale = Math.min(1, state.renderScale + g.step);
            settleCadenceWindow(state);
            return SCALE_CHANGED;
        }
        state.cadencePhase = 'held';
        return null;
    }
    const verifyingJump = state.renderScale <= state.cadenceRefScale + 1e-8;
    state.renderScale = verifyingJump ? g.floor : Math.max(g.floor, state.renderScale - g.step);
    state.cadencePhase = 'held';
    settleCadenceWindow(state);
    return atFloor ? null : SCALE_CHANGED;
}

/**
 * Advance the existing Game governor state by a visible frame interval.
 * Auto reduces effects at the clarity floor before using the last resolution
 * reserve. Manual and mobile preserve their configured effect profiles.
 *
 * @param {object} state Game's renderScale/frameAvgMs/cooldown, Auto and cadence fields
 * @param {number} rawDt Seconds, before the simulation frame-time clamp
 * @param {{adaptive?: boolean, lowPower?: boolean, racing?: boolean}} options
 *   racing: the frame showed the player driving (not the start lights or a
 *   replay) — cadence decisions that move the scale are taken only on such
 *   frames.
 * @returns {{scaleChanged: boolean, stageChanged: boolean}}
 */
export function advanceQualityGovernor(state, rawDt, { adaptive = false, lowPower = false, racing = true } = {}) {
    // An invalid interval or return from a hidden tab is not GPU pressure.
    if (!Number.isFinite(rawDt) || rawDt <= 0 || rawDt > 0.25) {
        return UNCHANGED;
    }

    const g = GOVERNOR;
    const ms = rawDt * 1000;
    // Every presented interval feeds the cadence ring, hitches included — the
    // outlier filter below protects the average, not the flatness test.
    state.frameRing[state.frameRingIndex] = ms;
    state.frameRingIndex = (state.frameRingIndex + 1) % g.cadenceWindow;
    if (racing !== state.cadenceRacing) {
        state.cadenceRacing = racing;
        restartCadenceWindow(state);
    }
    state.cadenceFrames++;

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

    const cadence = advanceCadence(state, targetMs, racing);
    if (cadence !== null) return cadence;
    // While locked the cadence check owns the scale: the classic rules would
    // only walk it straight back down to the floor.
    if (state.lockedCadenceMs > 0) return UNCHANGED;

    if (state.scaleCooldown > 0) return UNCHANGED;

    if (overloaded && state.renderScale > floor) {
        state.renderScale = Math.max(floor, state.renderScale - g.step);
        state.scaleCooldown = g.downCooldown;
        if (state.cadencePhase === 'idle' && !state.cadenceRestoresDisabled) {
            state.cadencePhase = 'descent';
            state.cadenceRefMs = 0;
            restartCadenceWindow(state);
        } else if (state.cadencePhase === 'descent' && state.cadenceRefMs > 0 && state.renderScale <= g.floor + 1e-8) {
            // With the reference in hand the judgement starts the moment the
            // floor is reached; a window still hunting for a reference runs on.
            restartCadenceWindow(state);
        } else if (state.cadenceFrames === 0) {
            // A window that opened on this very frame renders at the new scale.
            state.cadenceWindowScale = state.renderScale;
        }
        return SCALE_CHANGED;
    }

    if (state.frameAvgMs < targetMs * g.upRatio && state.renderScale < 1) {
        state.renderScale = Math.min(1, state.renderScale + g.step);
        state.scaleCooldown = g.upCooldown;
        // Frames came back on their own: nothing left to judge.
        if (state.cadencePhase === 'descent') {
            state.cadencePhase = 'idle';
            state.cadenceRefMs = 0;
        }
        return SCALE_CHANGED;
    }

    return UNCHANGED;
}
