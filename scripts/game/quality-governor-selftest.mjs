/**
 * Time-series regressions for sharpness, thermal pressure, transient stalls
 * and the cadence lock (a 30 Hz-capped or CPU-bound phone must not be parked
 * at the resolution floor for nothing).
 */
import assert from 'node:assert/strict';
import { advanceQualityGovernor, createCadenceState, GOVERNOR, resetCadenceForRun } from '../../resources/js/game/qualityGovernor.js';
import { mulberry32 } from '../../resources/js/game/random.js';

const automatic = { adaptive: true, lowPower: false };
const manual = { adaptive: false, lowPower: false };
const mobile = { adaptive: true, lowPower: true };

const VSYNC = 1000 / 60;
const FLOOR = GOVERNOR.floor;
const near = (a, b, eps = 1e-8) => Math.abs(a - b) < eps;

function initial(overrides = {}) {
    return {
        renderScale: 1, frameAvgMs: 0, scaleCooldown: 1,
        vsyncMs: VSYNC, prevFrameMs: VSYNC,
        outlierCount: 0, outlierTimer: 0,
        autoQualityStage: 0, autoQualitySlowSeconds: 0,
        ...createCadenceState(),
        ...overrides,
    };
}

function frame(state, dt, options = automatic) {
    const scale = state.renderScale;
    const stage = state.autoQualityStage;
    const changed = advanceQualityGovernor(state, dt, options);
    assert.equal(changed.scaleChanged, state.renderScale !== scale);
    assert.equal(changed.stageChanged, state.autoQualityStage !== stage);
    return changed;
}

function drive(state, seconds, dt, options = automatic) {
    const changes = [];
    for (let i = 0; i < Math.round(seconds / dt); i++) {
        const result = frame(state, dt, options);
        if (result.scaleChanged || result.stageChanged) {
            changes.push({ time: (i + 1) * dt, scale: state.renderScale, stage: state.autoQualityStage, ...result });
        }
    }
    return changes;
}

/**
 * Generator-driven run: `generate(state, t, rnd)` returns the next presented
 * interval in ms (it may depend on the current renderScale — a fill-bound
 * device gets faster as the governor sheds pixels). Time advances by each
 * interval, exactly like requestAnimationFrame timestamps.
 */
function simulate(state, seconds, generate, options = mobile, { seed = 1, from = 0, racing } = {}) {
    const rnd = mulberry32(seed);
    const changes = [];
    let t = from;
    while (t < from + seconds) {
        const ms = generate(state, t, rnd);
        t += ms / 1000;
        const result = frame(state, ms / 1000, racing === undefined ? options : { ...options, racing: racing(t) });
        if (result.scaleChanged || result.stageChanged) {
            changes.push({ time: t, scale: state.renderScale, stage: state.autoQualityStage, phase: state.cadencePhase, ...result });
        }
    }
    return changes;
}

const flat = (ms, jitter = 0.3) => (state, t, rnd) => ms + (rnd() * 2 - 1) * jitter;
/** Vsync-quantised presentation: a frame shows at the next refresh after its work is done (iOS Safari). */
const quantised = (workMs) => (state) => Math.ceil(workMs(state.renderScale) / VSYNC - 1e-9) * VSYNC;
/** Bimodal mix: share `p` of the frames at `slowMs`, the rest at `fastMs`. */
const mix = (p, slowMs, fastMs) => (state, t, rnd) => (rnd() < p ? slowMs : fastMs);
const after = (seconds, before, then) => (state, t, rnd) => (t < seconds ? before(state, t, rnd) : then(state, t, rnd));
/** Genuinely GPU-bound Android: fixed cost + fill that scales with pixels, wide jitter. */
const gpuBound = (state, t, rnd) => 12 + 40 * state.renderScale ** 2 + (rnd() * 2 - 1) * 6;

const steps = (changes) => changes.filter((change) => change.scaleChanged);
const locked = (state) => state.lockedCadenceMs > 0;

function assertClassicDescent(changes, { floor = FLOOR, from = 1 } = {}) {
    let previous = from;
    for (const change of changes) {
        assert(change.scale >= floor - 1e-8, `scale ${change.scale} below floor`);
        assert(previous - change.scale <= GOVERNOR.step + 1e-8, `step larger than 0.05 (${previous} → ${change.scale})`);
        previous = change.scale;
    }
    for (let i = 1; i < changes.length; i++) {
        assert(changes[i].time - changes[i - 1].time >= GOVERNOR.downCooldown - 0.011, 'descent faster than the cooldown');
    }
}

let checks = 0;
function check(name, test) {
    test();
    checks++;
    console.log(`✓ ${name}`);
}

// ── Classic governor ────────────────────────────────────────────────────────

for (const hz of [60, 120, 144]) {
    check(`a stable ${hz} Hz display retains full resolution and effects`, () => {
        const state = initial();
        const changes = drive(state, 30, 1 / hz);
        assert.equal(changes.length, 0);
        assert.equal(state.renderScale, 1);
        assert.equal(state.autoQualityStage, 0);
        assert.equal(state.cadencePhase, 'idle');
    });
}

check('sustained flat 30 fps sheds effects before deeper blur, then the unmoved cadence gives the pixels back', () => {
    const state = initial();
    const changes = drive(state, 25, 1 / 30);
    assert.deepEqual(changes.filter((change) => change.stageChanged).map((change) => change.stage), [1, 2]);
    assert(changes.filter((change) => change.stage < 2).every((change) => change.scale >= 0.8));
    const floorAt = changes.find((change) => near(change.scale, FLOOR));
    assert(floorAt, 'the floor is still reached first');
    // A synthetic stream that ignores the scale is by construction a device
    // whose frame the resolution cannot move: locked and sharp again.
    assert(locked(state));
    assert.equal(state.autoQualityStage, 2);
    assert.equal(state.renderScale, 1);
    assert(near(state.lockedCadenceMs, 1000 / 30, 0.01));
});

check('Auto waits three seconds at the clarity floor before reducing effects', () => {
    const state = initial({ renderScale: 0.8, frameAvgMs: 30, scaleCooldown: 0 });
    drive(state, 2.9, 1 / 30);
    assert.equal(state.autoQualityStage, 0);
    assert.equal(state.renderScale, 0.8);
    drive(state, 0.2, 1 / 30);
    assert.equal(state.autoQualityStage, 1);
    assert.equal(state.renderScale, 0.8);
});

check('isolated GC hitches do not lower clarity or contaminate the frame average', () => {
    const state = initial();
    drive(state, 4, 1 / 60);
    const average = state.frameAvgMs;
    for (const duration of [0.1, 0.2]) {
        frame(state, duration);
        assert.equal(state.frameAvgMs, average);
        assert.equal(state.renderScale, 1);
        drive(state, 2, 1 / 60);
    }
    assert.equal(state.autoQualityStage, 0);
});

check('a sustained flat 100 ms stream reaches the feature fallback, then the resolution is returned', () => {
    const state = initial();
    drive(state, 2, 1 / 60);
    const changes = drive(state, 40, 0.1);
    assert.equal(state.autoQualityStage, 2);
    assert(state.frameAvgMs > 90);
    assert(changes.filter((change) => change.stage < 2).every((change) => change.scale >= 0.8));
    assert(changes.some((change) => near(change.scale, FLOOR)));
    assert(locked(state));
    assert.equal(state.renderScale, 1);
});

check('tab pauses and invalid intervals cannot alter governor state', () => {
    for (const start of [
        initial({ renderScale: 0.85, frameAvgMs: 23, autoQualitySlowSeconds: 1.5 }),
        initial({ renderScale: 0.9, frameAvgMs: 33, cadencePhase: 'probing', lockedCadenceMs: 33.3, cadenceRefMs: 33.3, cadenceRefScale: 0.85 }),
    ]) {
        const state = start;
        const before = structuredClone(state);
        for (const dt of [0, -1, NaN, Infinity, 0.251, 30]) {
            frame(state, dt);
            assert.deepEqual(state, before);
        }
    }
});

check('a newly reduced effects tier has time to settle before raising resolution', () => {
    const state = initial({ renderScale: 0.8, frameAvgMs: 30, scaleCooldown: 0 });
    while (state.autoQualityStage === 0) frame(state, 1 / 30);
    drive(state, 2.8, 1 / 120);
    assert.equal(state.renderScale, 0.8);
    drive(state, 0.4, 1 / 120);
    assert(state.renderScale > 0.8);
    assert.equal(state.autoQualityStage, 1);
});

check('recovery restores resolution gradually without re-enabling heavy effects', () => {
    const state = initial({ renderScale: 0.65, autoQualityStage: 2, frameAvgMs: 100, scaleCooldown: 3 });
    const changes = drive(state, 35, 1 / 60);
    assert.equal(state.renderScale, 1);
    assert.equal(state.autoQualityStage, 2);
    assert(changes.every((change) => !change.stageChanged));
    const recoveries = steps(changes);
    for (let i = 1; i < recoveries.length; i++) {
        assert(recoveries[i].time - recoveries[i - 1].time >= 2.99);
        assert(recoveries[i].scale - recoveries[i - 1].scale <= 0.050001);
    }
    assert(!locked(state));
});

for (const [name, options] of [['manual', manual], ['mobile', mobile]]) {
    check(`${name} quality retains its chosen effects, protects its resolution floor and returns unbought pixels`, () => {
        const state = initial();
        const changes = drive(state, 25, 0.1, options);
        assert.equal(state.autoQualityStage, 0);
        assert.equal(state.autoQualitySlowSeconds, 0);
        assert(changes.every((change) => change.scale >= 0.65 && !change.stageChanged));
        const restoreIndex = changes.findIndex((change, i) => i > 0 && change.scale > changes[i - 1].scale);
        const descent = restoreIndex === -1 ? changes : changes.slice(0, restoreIndex);
        assertClassicDescent(descent);
        assert(near(descent.at(-1).scale, FLOOR));
        assert(locked(state));
        assert.equal(state.renderScale, 1);
    });
}

check('short overload bursts cannot accumulate a quality downgrade across long good stretches', () => {
    const state = initial({ renderScale: 0.8, frameAvgMs: 30, scaleCooldown: 0 });
    for (let i = 0; i < 5; i++) {
        drive(state, 1, 1 / 30);
        drive(state, 8, 1 / 60);
    }
    assert.equal(state.autoQualityStage, 0);
    assert(!locked(state));
    assert.equal(state.cadencePhase, 'idle');
    assert.equal(state.cadenceRefMs, 0);
});

// ── Cadence lock ────────────────────────────────────────────────────────────

for (const [name, options] of [['mobile', mobile], ['Auto', automatic]]) {
    check(`${name}: a phone pinned to 30 Hz descends, is judged at the floor, gets its pixels back and holds`, () => {
        const state = initial();
        const changes = simulate(state, 60, flat(1000 / 30), options);
        const scaleChanges = steps(changes);
        const restore = scaleChanges.findIndex((change, i) => i > 0 && change.scale > scaleChanges[i - 1].scale);
        assert(restore > 0, 'a restore happened');
        const descent = scaleChanges.slice(0, restore);
        assertClassicDescent(descent, { floor: FLOOR });
        assert(near(descent.at(-1).scale, FLOOR), 'the floor was reached before judging');
        // Restore lands on the reference scale (the window after the first step),
        // then climbs one step per verified window, never more.
        assert(near(scaleChanges[restore].scale, 0.95), `restored to ${scaleChanges[restore].scale}`);
        for (let i = restore + 1; i < scaleChanges.length; i++) {
            assert(near(scaleChanges[i].scale - scaleChanges[i - 1].scale, GOVERNOR.step));
        }
        assert.equal(state.renderScale, 1);
        assert.equal(state.cadencePhase, 'held');
        assert(near(state.lockedCadenceMs, 1000 / 30, 0.5));
        assert(!state.cadenceRestoresDisabled);
        const lastChange = changes.at(-1).time;
        if (name === 'mobile') {
            assert(near(scaleChanges[restore].time, 9.5, 0.3), `restore at ${scaleChanges[restore].time}`);
            assert(lastChange < 12.5, `sharp again by ${lastChange}`);
            assert.equal(state.autoQualityStage, 0);
        } else {
            assert.deepEqual(changes.filter((change) => change.stageChanged).map((change) => change.stage), [1, 2]);
            assert.equal(state.autoQualityStage, 2);
            assert(lastChange < 22, `sharp again by ${lastChange}`);
        }
        // Zero changes for the rest of the minute: no churn while locked.
        assert(lastChange < 25);
    });
}

check('a genuinely GPU-bound phone is never judged: it descends to the floor and stays there', () => {
    const state = initial();
    const changes = simulate(state, 60, gpuBound, mobile, { seed: 7 });
    assertClassicDescent(steps(changes));
    assert(near(state.renderScale, FLOOR));
    assert(!locked(state));
    assert.equal(state.cadenceRefMs, 0);
    assert(steps(changes).every((change, i, all) => i === 0 || change.scale < all[i - 1].scale), 'scale never increased');
});

check('quantised fill-bound iPhone (8 + 16·s² ms): hunts between 0.70 and 0.75, never locked, every change one step', () => {
    const state = initial();
    const changes = simulate(state, 60, quantised((s) => 8 + 16 * s * s), mobile);
    const scales = steps(changes).map((change) => change.scale);
    assert(!locked(state));
    assert(scales.every((scale, i) => i === 0 || near(Math.abs(scale - scales[i - 1]), GOVERNOR.step)));
    assert(Math.min(...scales) >= 0.7 - 1e-8);
    assert(scales.slice(-4).every((scale) => scale <= 0.75 + 1e-8));
});

check('quantised fill-bound iPhone that crosses to 60 Hz exactly at the floor: normal up-steps, never locked', () => {
    const state = initial();
    const changes = simulate(state, 60, quantised((s) => 9.5 + 16 * s * s), mobile);
    assert(steps(changes).some((change) => near(change.scale, FLOOR)));
    assert(!locked(state));
    assert.equal(state.lockedCadenceMs, 0);
});

check('quantised CPU-heavy iPhone (14 + 8·s² ms): no scale crosses a vsync — restored and sharp again', () => {
    const state = initial();
    const changes = simulate(state, 60, quantised((s) => 14 + 8 * s * s), mobile);
    assert(steps(changes).some((change) => near(change.scale, FLOOR)));
    assert(locked(state));
    assert.equal(state.renderScale, 1);
    assert(near(state.lockedCadenceMs, 2 * VSYNC, 0.01));
});

check('capped phone that later throttles to 50 ms: lock released after two strikes, no further judged descents', () => {
    const state = initial();
    const changes = simulate(state, 60, after(30, flat(1000 / 30), flat(50)), mobile);
    const lockAt = steps(changes).find((change) => change.phase === 'probing');
    assert(lockAt && lockAt.time < 10);
    assert(!locked(state));
    assert(state.cadenceRestoresDisabled, 'a worse cadence disables restores');
    assert(near(state.renderScale, FLOOR));
    const afterThrottle = steps(changes).filter((change) => change.time > 30);
    assert(afterThrottle.length > 0);
    // The partial window (mixed 33/50: not flat) is the first strike, the
    // first whole 64-frame window at 50 ms the second: 30 + ~1 + 3.2 s. One
    // strike would release at ~31 s, three at ~38 s.
    assert(afterThrottle[0].time > 33.5 && afterThrottle[0].time < 37, `re-descent began at ${afterThrottle[0].time}`);
    assert(afterThrottle.every((change, i) => i === 0 || change.scale < afterThrottle[i - 1].scale), 'no re-lock');
});

check('Low Power Mode switched off mid-lock: released without penalty, governor idle at full resolution', () => {
    const state = initial();
    simulate(state, 60, after(30, flat(1000 / 30), flat(VSYNC, 0.1)), mobile);
    assert(!locked(state));
    assert(!state.cadenceRestoresDisabled);
    assert.equal(state.renderScale, 1);
    assert.equal(state.cadencePhase, 'idle');
});

check('lock followed by a noisy GPU-bound regime: released, descends to the floor, never re-locks', () => {
    const state = initial();
    const changes = simulate(state, 70, after(30, flat(1000 / 30), gpuBound), mobile, { seed: 3 });
    assert(!locked(state));
    assert(state.cadenceRestoresDisabled);
    assert(near(state.renderScale, FLOOR));
    assert(steps(changes).filter((change) => change.time > 30).every((change) => change.phase !== 'probing'));
});

check('Low Power Mode switched on mid-run: baseline is the new cadence, not the 60 Hz history', () => {
    const state = initial();
    const changes = simulate(state, 60, after(20, flat(VSYNC, 0.1), flat(1000 / 30)), mobile);
    const first = steps(changes)[0];
    assert(first.time > 20 && first.time < 20.3, `first step at ${first.time}`);
    assert(near(state.cadenceRefMs, 1000 / 30, 0.5), `reference at ${state.cadenceRefMs}`);
    assert(locked(state));
    assert.equal(state.renderScale, 1);
    const restore = steps(changes).find((change) => change.phase === 'probing');
    assert(restore.time > 27 && restore.time < 31, `restore at ${restore.time}`);
});

check('capped phone with 10 % hitches: still recognised, pixels returned', () => {
    const state = initial();
    simulate(state, 60, mix(0.1, 50, 1000 / 30), mobile, { seed: 11 });
    assert(locked(state));
    assert(state.renderScale >= 0.95 - 1e-8, `held at ${state.renderScale}`);
});

check('a hitchy stretch at the floor after the reference was taken only delays the jump; the first clean window locks', () => {
    const state = initial();
    simulate(state, 4, flat(1000 / 30), mobile, { seed: 5 });
    assert(near(state.cadenceRefMs, 1000 / 30, 0.5), 'reference captured before the hitches');
    const hitchy = (s, t, rnd) => (t < 16 ? mix(0.26, 50, 1000 / 30)(s, t, rnd) : flat(1000 / 30)(s, t, rnd));
    const changes = simulate(state, 56, hitchy, mobile, { seed: 5, from: 4 });
    const restore = steps(changes).find((change) => change.phase === 'probing');
    assert(restore, 'locked eventually');
    assert(restore.time > 16, `no lock while hitchy (locked at ${restore.time})`);
    assert(restore.time < 21, `first clean floor window locks (${restore.time})`);
    assert(near(restore.scale, 0.95), 'the reference was used for a direct jump');
    assert.equal(state.renderScale, 1);
});

check('a noisy start (no reference) is not terminal: a clean floor window probes upward from the floor', () => {
    const state = initial();
    // 30 % stalls of 100 ms for the first 7.5 s break every reference window.
    const noisyStart = (s, t, rnd) => (t < 7.5 ? mix(0.3, 100, 1000 / 30)(s, t, rnd) : flat(1000 / 30)(s, t, rnd));
    const changes = simulate(state, 60, noisyStart, mobile, { seed: 4 });
    assert.equal(state.cadenceRefMs, 0, 'no reference was available');
    const climb = steps(changes).filter((change) => change.phase === 'probing');
    assert(climb.length >= 7, `climbed from the floor in ${climb.length} steps`);
    assert(climb.every((change, i) => i === 0 ? near(change.scale, 0.7) : near(change.scale - climb[i - 1].scale, GOVERNOR.step)));
    // Lock at the floor after the first clean floor window (~9.5 s, no scale
    // change), first step up one settled window later.
    assert(climb[0].time > 11 && climb[0].time < 14, `probe began at ${climb[0].time}`);
    assert(locked(state));
    assert.equal(state.renderScale, 1);
    assert.equal(state.cadencePhase, 'held');
});

check('a permanently hitchy floor never locks and never changes anything else', () => {
    const state = initial();
    const changes = simulate(state, 60, after(4, flat(1000 / 30), mix(0.26, 50, 1000 / 30)), mobile, { seed: 5 });
    assert(!locked(state));
    assert(near(state.renderScale, FLOOR));
    assert(steps(changes).every((change) => change.time < 8));
});

check('a cadence knee between the top and the floor: the jump is refused, the probe climbs to the knee', () => {
    const state = initial();
    // CPU-bound with a small fill share: 36.6 ms at 0.95, flat 33.0 ms from 0.80 down.
    const knee = (s, t, rnd) => Math.max(33, 24 + 14 * s.renderScale ** 2) + (rnd() * 2 - 1) * 0.3;
    simulate(state, 90, knee, mobile, { seed: 2 });
    assert(state.cadenceRefMs > 35, `reference from the top: ${state.cadenceRefMs}`);
    assert(locked(state));
    assert.equal(state.cadencePhase, 'held');
    assert(near(state.renderScale, 0.85), `held at ${state.renderScale}`);
});

check('pipelined presenter that only holds 33 ms below 0.95: restored, ascent stops at 0.90, no churn', () => {
    const state = initial();
    const edge = (s, t, rnd) => (s.renderScale >= 0.95 - 1e-8 ? mix(0.62, 50, 1000 / 30)(s, t, rnd) : flat(1000 / 30)(s, t, rnd));
    const changes = simulate(state, 90, edge, mobile, { seed: 2 });
    assert(locked(state));
    assert.equal(state.cadencePhase, 'held');
    assert(near(state.renderScale, 0.9), `held at ${state.renderScale}`);
    const lastChange = changes.at(-1).time;
    assert(lastChange < 30, `no churn after ${lastChange}`);
    assert(steps(changes).filter((change) => change.time > 20).length <= 2);
});

check('regime change that keeps the median but overloads the mean releases the lock and disables restores', () => {
    const state = initial();
    // 30 % of frames at 65 ms: the median stays at 33.3 (P(move) ~ 2e-4 per
    // window), the mean is 42.8 > 33.3 x 1.22, and 65 < 4x target so the
    // outlier filter never hides it.
    simulate(state, 60, after(30, flat(1000 / 30), mix(0.3, 65, 1000 / 30)), mobile, { seed: 9 });
    assert(!locked(state));
    assert(state.cadenceRestoresDisabled);
});

check('late-onset partial drops while held (median and mean unchanged) still release the lock via flatness', () => {
    const state = initial();
    // 30 % of frames slip to 50 ms at scale >= 0.8, flat 33.3 below it:
    // median 33.3, mean 38.3 < 40.6 — only the flat share notices.
    const drops = (s, t, rnd) => (t > 30 && s.renderScale >= 0.8 - 1e-8 ? mix(0.3, 50, 1000 / 30)(s, t, rnd) : flat(1000 / 30)(s, t, rnd));
    const changes = simulate(state, 120, drops, mobile, { seed: 4 });
    assert(state.renderScale <= 0.75 + 1e-8, `settled at ${state.renderScale}`);
    assert(!state.cadenceRestoresDisabled, 'a release for flatness alone carries no penalty');
    const tail = steps(changes).filter((change) => change.time > 30);
    assert(tail.length > 0 && tail[0].time < 40, `reacted at ${tail[0]?.time}`);
});

check('isolated dirty windows separated by clean ones never add up to a release', () => {
    const state = initial();
    let dirty = false;
    let windows = 0;
    const sporadic = (s, t, rnd) => {
        if (t > 20 && s.cadenceFrames === 0) {
            windows++;
            dirty = windows % 4 === 1;
        }
        return dirty && t > 20 ? 50 : flat(1000 / 30)(s, t, rnd);
    };
    const changes = simulate(state, 80, sporadic, mobile, { seed: 3 });
    assert(windows >= 12);
    assert(locked(state));
    assert.equal(state.renderScale, 1);
    assert.equal(steps(changes).filter((change) => change.time > 20).length, 0);
});

check('sparse hitch pairs the outlier filter never confirms still enter the ring', () => {
    const state = initial();
    let n = 0;
    const hitchPairs = (s, t, rnd) => {
        if (t < 20) return flat(1000 / 30)(s, t, rnd);
        n++;
        return n % 30 < 2 ? 200 : flat(1000 / 30)(s, t, rnd);
    };
    simulate(state, 60, hitchPairs, mobile, { seed: 4 });
    assert(state.frameAvgMs < 35, 'hitches were filtered from the average');
    assert(!locked(state), 'but not from the cadence ring');
    assert(state.cadenceRestoresDisabled);
});

check('a failed jump drops straight back to the floor, where the probe takes over', () => {
    const state = initial();
    // Flat at every scale except 0.95, where 20 % of the frames slip: the
    // reference (taken at 0.95 in the first window) passes, the jump fails.
    const edge = (s, t, rnd) => (s.renderScale >= 0.95 - 1e-8 && t > 5 ? mix(0.2, 45, 1000 / 30)(s, t, rnd) : flat(1000 / 30)(s, t, rnd));
    const changes = simulate(state, 60, edge, mobile, { seed: 2 });
    const jump = steps(changes).find((change) => change.phase === 'probing');
    assert(jump && near(jump.scale, 0.95), `jumped to ${jump?.scale}`);
    const back = steps(changes).find((change) => change.time > jump.time);
    assert(back && near(back.scale, FLOOR) && back.phase === 'held', `failed jump went to ${back?.scale} (${back?.phase})`);
    assert(locked(state));
    // Held at the floor with clean windows: no strikes, no release, and the
    // held phase does not probe again on its own.
    assert(near(state.renderScale, FLOOR));
    assert.equal(state.cadencePhase, 'held');
});

check('a fill-bound phone whose steps are within the tolerance climbs at most 2 ms above the floor cadence', () => {
    const state = initial();
    // 25.9 ms at the floor, +1.0 ms per step: the band is anchored at the
    // floor, so the climb stops once the cadence is 2 ms slower.
    const linearFill = (s, t, rnd) => 20 + 14 * s.renderScale ** 2 + (rnd() * 2 - 1) * 0.3;
    simulate(state, 60, linearFill, mobile, { seed: 8 });
    assert(locked(state));
    assert(state.renderScale <= 0.75 + 1e-8, `held at ${state.renderScale}`);
    assert(20 + 14 * state.renderScale ** 2 - state.lockedCadenceMs <= GOVERNOR.cadenceToleranceMs + 0.3);
});

check('a reference found in the window that straddles the floor arrival still counts', () => {
    const state = initial();
    const hitchyAbove = (s, t, rnd) => (s.renderScale > 0.75 + 1e-8 ? mix(0.26, 50, 1000 / 30)(s, t, rnd) : flat(1000 / 30)(s, t, rnd));
    simulate(state, 60, hitchyAbove, mobile, { seed: 5 });
    assert(locked(state));
    assert(near(state.cadenceRefScale, 0.75, 1e-6), `reference at ${state.cadenceRefScale}`);
    assert(near(state.renderScale, 0.75));
});

check('a transient descent that recovers leaves no stale reference for a later cap', () => {
    const state = initial();
    simulate(state, 60, after(3, flat(1000 / 30), after(15, flat(VSYNC, 0.1), flat(50))), mobile, { seed: 6 });
    assert(locked(state));
    assert(near(state.lockedCadenceMs, 50, 0.5), `locked at ${state.lockedCadenceMs}`);
    assert.equal(state.renderScale, 1);
});

check('start lights and replays may supply the reference but take no decisions; racing frames restart the window', () => {
    const state = initial();
    // A long replay: the floor is reached at ~7.2 s and two whole floor
    // windows (~9.3 s, ~11.5 s) pass while not racing — neither may lock.
    const changes = simulate(state, 60, flat(1000 / 30), mobile, { racing: (t) => t > 12 });
    const restore = steps(changes).find((change) => change.phase === 'probing');
    assert(restore, 'locked once racing');
    assert(restore.time > 14 && restore.time < 15, `locked at ${restore.time}`);
    assert(near(restore.scale, 0.95), 'the reference captured during the replay was used');
    assert(near(state.cadenceRefScale, 0.95, 1e-6), `reference at ${state.cadenceRefScale}`);
    assert(state.renderScale === 1 && locked(state));
});

check('a cadence that improves inside the verification window never sends the scale below the jump', () => {
    const state = initial();
    // Low Power Mode goes off 0.3 s after the jump to 0.95 (~9.3 s): the
    // window is flat at 16.7 — faster, not slower. A strike, no step back;
    // the second strike releases and the classic rule climbs from 0.95.
    const changes = simulate(state, 40, after(9.6, flat(1000 / 30), flat(VSYNC, 0.1)), mobile);
    const jump = steps(changes).find((change) => change.phase === 'probing');
    assert(jump && near(jump.scale, 0.95), `jumped to ${jump?.scale}`);
    const afterJump = steps(changes).filter((change) => change.time > jump.time);
    assert(afterJump.every((change) => change.scale >= 0.95 - 1e-8), `fell to ${Math.min(...afterJump.map((change) => change.scale))}`);
    assert(!locked(state));
    assert(!state.cadenceRestoresDisabled);
    assert.equal(state.renderScale, 1);
});

check('a faster cadence during the replay releases the lock so the classic rules can climb like before', () => {
    const state = initial();
    const knee = (s, t, rnd) => Math.max(33, 24 + 14 * s.renderScale ** 2) + (rnd() * 2 - 1) * 0.3;
    // Held at the knee (0.85); the lap ends at 40 s, the phone leaves Low
    // Power Mode while the replay runs (40–70 s), the next run races from 70.
    const changes = simulate(state, 90, after(40, knee, flat(VSYNC, 0.1)), mobile, { seed: 2, racing: (t) => t < 40 || t > 70 });
    assert(near(steps(changes).filter((change) => change.time < 40).at(-1).scale, 0.85));
    const replayClimb = steps(changes).filter((change) => change.time > 40 && change.time < 70);
    assert(replayClimb.length >= 3, `climbed during the replay: ${replayClimb.length} steps`);
    assert.equal(state.renderScale, 1);
    assert(!locked(state) && !state.cadenceRestoresDisabled);
});

check('a reallocation transient right after a cadence-driven scale change stays out of its window', () => {
    const state = initial();
    let lastScale = 1;
    let since = 99;
    // Every scale change costs eight 120 ms frames (buffer reallocation).
    const realloc = (s, t, rnd) => {
        if (s.renderScale !== lastScale) {
            lastScale = s.renderScale;
            since = 0;
        }
        since++;
        return since <= 8 ? 120 : flat(1000 / 30)(s, t, rnd);
    };
    simulate(state, 40, realloc, mobile, { seed: 3 });
    assert(locked(state));
    assert.equal(state.renderScale, 1);
    assert.equal(state.cadencePhase, 'held');
});

check('a slow window right after a floor lock holds at the floor without reporting a scale change', () => {
    const state = initial();
    // No reference (noisy start), floor lock at ~9.5 s, then the first probe
    // window is noisy again: back to the floor — which is no change at all.
    const stream = (s, t, rnd) => (t < 7.5 || (t > 9.7 && t < 12.3) ? mix(0.3, 100, 1000 / 30)(s, t, rnd) : flat(1000 / 30)(s, t, rnd));
    const changes = simulate(state, 40, stream, mobile, { seed: 4 });
    assert.equal(state.cadenceRefMs, 0, 'no reference was available');
    assert(locked(state) && near(state.lockedCadenceMs, 1000 / 30, 0.5));
    assert.equal(state.cadencePhase, 'held');
    assert(near(state.renderScale, FLOOR));
    assert(steps(changes).every((change) => change.time < 8), 'the frame() invariant would flag a false scaleChanged');
});

check('a Game whose restores were disabled stays unjudged across a restart and a racing flip', () => {
    const state = initial();
    simulate(state, 45, after(30, flat(1000 / 30), flat(50)), mobile, { seed: 3 });
    assert(state.cadenceRestoresDisabled && !locked(state) && near(state.renderScale, FLOOR));
    resetCadenceForRun(state);
    const changes = simulate(state, 40, flat(50), mobile, { seed: 3, from: 45, racing: (t) => t < 50 || t > 55 });
    assert.equal(steps(changes).length, 0);
    assert(!locked(state) && near(state.renderScale, FLOOR));
});

check('a reference whose jump failed is forgotten on release: the next lock probes from the floor', () => {
    const state = initial();
    let failedAt = Infinity;
    const stream = (s, t, rnd) => {
        if (s.renderScale >= 0.95 - 1e-8 && t > 5) return mix(0.2, 45, 1000 / 30)(s, t, rnd);
        if (s.cadencePhase === 'held' && failedAt === Infinity) failedAt = t;
        if (t > failedAt + 3 && t < failedAt + 9) return mix(0.3, 50, 1000 / 30)(s, t, rnd);
        return flat(1000 / 30)(s, t, rnd);
    };
    const changes = simulate(state, 90, stream, mobile, { seed: 2 });
    assert(failedAt < 15, `the jump failed at ${failedAt}`);
    const secondLock = steps(changes).find((change) => change.time > failedAt + 9 && change.phase === 'probing');
    assert(secondLock && near(secondLock.scale, 0.7), `second lock probed from the floor (${secondLock?.scale})`);
    assert(locked(state) && near(state.renderScale, 0.9), `held at ${state.renderScale}`);
});

check('a descent driven by hitches over a fast median takes no reference and never jumps', () => {
    const state = initial();
    // 60 Hz with 12 % x 100 ms GC stalls: the average is overloaded (26.7 ms),
    // the median (16.7) is not.
    const changes = simulate(state, 60, mix(0.12, 100, VSYNC), mobile, { seed: 3 });
    assert(steps(changes).some((change) => near(change.scale, FLOOR)));
    assert.equal(state.cadenceRefMs, 0, 'a fast median is not a reference');
    assert(steps(changes).every((change) => change.phase !== 'probing'), 'no jump');
    assert(!state.cadenceRestoresDisabled);
});

check('a flat but unloaded floor window is not probed', () => {
    const state = initial();
    // The floor fixed it: 18.5 ms sits in the classic dead band (17.3–20.3),
    // flat, and differs from the 33.3 reference — nothing to lock.
    const fixedByFloor = (s, t, rnd) => (s.renderScale <= FLOOR + 1e-8 ? flat(18.5, 0.2)(s, t, rnd) : flat(1000 / 30)(s, t, rnd));
    simulate(state, 40, fixedByFloor, mobile, { seed: 6 });
    assert(near(state.cadenceRefMs, 1000 / 30, 0.5));
    assert(!locked(state));
    assert(near(state.renderScale, FLOOR));
});

check('a restart keeps an unfinished descent and a proven lock, but starts a fresh window', () => {
    const open = initial();
    simulate(open, 4, flat(1000 / 30), mobile);
    assert.equal(open.cadencePhase, 'descent');
    assert(open.cadenceRefMs > 0);
    resetCadenceForRun(open);
    assert.equal(open.cadencePhase, 'descent');
    assert(open.cadenceRefMs > 0);
    assert.equal(open.cadenceFrames, 0);

    const proven = initial();
    simulate(proven, 20, flat(1000 / 30), mobile);
    assert(locked(proven));
    resetCadenceForRun(proven);
    assert(locked(proven));
    assert.equal(proven.cadenceFrames, 0);
});

console.log(`\nQuality governor: ${checks} scenarios passed.`);
