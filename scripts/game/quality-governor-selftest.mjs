/** Time-series regressions for sharpness, thermal pressure and transient stalls. */
import assert from 'node:assert/strict';
import { advanceQualityGovernor } from '../../resources/js/game/qualityGovernor.js';

const automatic = { adaptive: true, lowPower: false };
const manual = { adaptive: false, lowPower: false };
const mobile = { adaptive: true, lowPower: true };

function initial(overrides = {}) {
    return {
        renderScale: 1, frameAvgMs: 0, scaleCooldown: 1,
        vsyncMs: 1000 / 60, prevFrameMs: 1000 / 60,
        outlierCount: 0, outlierTimer: 0,
        autoQualityStage: 0, autoQualitySlowSeconds: 0,
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

let checks = 0;
function check(name, test) {
    test();
    checks++;
    console.log(`✓ ${name}`);
}

for (const hz of [60, 120, 144]) {
    check(`a stable ${hz} Hz display retains full resolution and effects`, () => {
        const state = initial();
        const changes = drive(state, 30, 1 / hz);
        assert.equal(changes.length, 0);
        assert.equal(state.renderScale, 1);
        assert.equal(state.autoQualityStage, 0);
    });
}

check('sustained 30 fps sheds effects before allowing deeper blur', () => {
    const state = initial();
    const changes = drive(state, 25, 1 / 30);
    assert.equal(state.autoQualityStage, 2);
    assert(Math.abs(state.renderScale - 0.65) < 1e-8);
    assert(changes.filter((change) => change.stage < 2).every((change) => change.scale >= 0.8));
    assert.deepEqual(changes.filter((change) => change.stageChanged).map((change) => change.stage), [1, 2]);
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

check('a sustained 100 ms frame stream reaches the feature fallback', () => {
    const state = initial();
    drive(state, 2, 1 / 60);
    const changes = drive(state, 25, 0.1);
    assert.equal(state.autoQualityStage, 2);
    assert(state.frameAvgMs > 90);
    assert(changes.filter((change) => change.stage < 2).every((change) => change.scale >= 0.8));
    assert(Math.abs(state.renderScale - 0.65) < 1e-8);
});

check('tab pauses and invalid intervals cannot alter governor state', () => {
    const state = initial({ renderScale: 0.85, frameAvgMs: 23, autoQualitySlowSeconds: 1.5 });
    const before = structuredClone(state);
    for (const dt of [0, -1, NaN, Infinity, 0.251, 30]) {
        frame(state, dt);
        assert.deepEqual(state, before);
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
    const recoveries = changes.filter((change) => change.scaleChanged);
    for (let i = 1; i < recoveries.length; i++) {
        assert(recoveries[i].time - recoveries[i - 1].time >= 2.99);
        assert(recoveries[i].scale - recoveries[i - 1].scale <= 0.050001);
    }
});

for (const [name, options] of [['manual', manual], ['mobile', mobile]]) {
    check(`${name} quality retains its chosen effects and protects its resolution floor`, () => {
        const state = initial();
        const changes = drive(state, 25, 0.1, options);
        assert.equal(state.autoQualityStage, 0);
        assert.equal(state.autoQualitySlowSeconds, 0);
        assert(Math.abs(state.renderScale - 0.65) < 1e-8);
        assert(changes.every((change) => change.scale >= 0.65 && !change.stageChanged));
        for (let i = 1; i < changes.length; i++) {
            assert(changes[i].time - changes[i - 1].time >= 0.99);
            assert(changes[i - 1].scale - changes[i].scale <= 0.050001);
        }
    });
}

check('short overload bursts cannot accumulate a quality downgrade across long good stretches', () => {
    const state = initial({ renderScale: 0.8, frameAvgMs: 30, scaleCooldown: 0 });
    for (let i = 0; i < 5; i++) {
        drive(state, 1, 1 / 30);
        drive(state, 8, 1 / 60);
    }
    assert.equal(state.autoQualityStage, 0);
});

console.log(`\nQuality governor: ${checks} scenarios passed.`);
