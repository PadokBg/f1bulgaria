/**
 * Селфтест на физическия модел на двигателя (engineWorklet.js) и на
 * логиката „какво иска двигателят" от sound.js.
 *
 *   node scripts/game/engine-sound-selftest.mjs
 *
 * Ухото остава съдия за тембъра (scripts/game/engine-lab.mjs); тук се пазят
 * свойствата, които не бива да се чупят при настройка: детерминизъм,
 * стабилност на тръбите, височина по оборотите, реакция на газта и
 * срязването, таван на сигнала, турбото и MGU-K на хибрида, цена за процесора.
 */

import assert from 'node:assert/strict';

import { ENGINE_PRESETS, EngineModel } from '../../resources/js/game/engineWorklet.js';
import { hybridEngineDemand } from '../../resources/js/game/sound.js';

const SAMPLE_RATE = 48000;
const BLOCK = 128;
/** Без случайни пукоти — за сравненията по ниво. */
const QUIET = { burblesPerSecond: 0, misfiresPerSecond: 0 };
/** Паления на оборот: V6 — 3, V10 — 5. */
const FIRINGS_PER_REV = { 'v6-hybrid': 3, v10: 5 };

/**
 * @param {{ engine?: string, rpm: number|((time: number) => number), load: number|((time: number) => number), mguk?: number, seconds: number, tuning?: object, seed?: number, before?: (model: EngineModel) => void, limiter?: boolean, exhaust?: number, intake?: number, mech?: number }} scenario
 */
function render({ engine = 'v6-hybrid', rpm, load, mguk = 0, seconds, tuning, seed, before, limiter = false, exhaust = 1, intake = 0.3, mech = 0.2 }) {
    const model = new EngineModel(SAMPLE_RATE, { engine, tuning, seed });
    const at = (value, time) => (typeof value === 'function' ? value(time) : value);
    model.rpm = at(rpm, 0);
    model.load = at(load, 0);
    model.limiterOn = limiter;
    model.mgukTarget = mguk;
    model.exhaustGain = exhaust;
    model.intakeGain = intake;
    model.mechGain = mech;
    before?.(model);
    const total = Math.floor(seconds * SAMPLE_RATE);
    const left = new Float32Array(total);
    const right = new Float32Array(total);
    const blockLeft = new Float32Array(BLOCK);
    const blockRight = new Float32Array(BLOCK);
    const boost = [];
    for (let start = 0; start < total; start += BLOCK) {
        const time = start / SAMPLE_RATE;
        model.rpmTarget = at(rpm, time);
        model.loadTarget = at(load, time);
        model.process(blockLeft, blockRight, BLOCK, time);
        const count = Math.min(BLOCK, total - start);
        left.set(blockLeft.subarray(0, count), start);
        right.set(blockRight.subarray(0, count), start);
        boost.push(model.boost);
    }

    return { left, right, model, boost };
}

function rmsDb(signal, from = 0, to = signal.length) {
    let sum = 0;
    for (let i = from; i < to; i++) {
        sum += signal[i] * signal[i];
    }

    return 10 * Math.log10(sum / Math.max(1, to - from) + 1e-20);
}

/** Мощност (dB) на честота през Goertzel — без FFT за една точка. */
function powerAt(signal, frequency, from, length) {
    const k = (2 * Math.PI * frequency) / SAMPLE_RATE;
    const coefficient = 2 * Math.cos(k);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < length; i++) {
        const windowed = signal[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1)));
        const s0 = windowed + coefficient * s1 - s2;
        s2 = s1;
        s1 = s0;
    }

    return 10 * Math.log10(s1 * s1 + s2 * s2 - coefficient * s1 * s2 + 1e-20);
}

const sampleAt = (seconds) => Math.floor(seconds * SAMPLE_RATE);

for (const engine of Object.keys(ENGINE_PRESETS)) {
    const firingsPerRev = FIRINGS_PER_REV[engine];
    const top = engine === 'v10' ? 18000 : 12000;

    // ── Детерминизъм: същият seed → бит-идентичен звук ──────────────────
    {
        const sweep = { engine, rpm: (t) => 5000 + t * 6000, load: (t) => (t < 0.6 ? 1 : 0), seconds: 1.2, seed: 42 };
        const first = render(sweep);
        const second = render(sweep);
        assert.deepEqual(first.left, second.left, `${engine}: същият seed и вход трябва да дадат същия звук`);
        const other = render({ ...sweep, seed: 43 });
        assert.notDeepEqual(first.left, other.left, `${engine}: друг seed = друг двигател`);
    }

    // ── Краен и в таван при всичко наведнъж: срязвания, лимитер, пукоти ──
    {
        const { left, right } = render({
            engine,
            rpm: (t) => 5000 + (top - 4000) * Math.abs(Math.sin(t * 1.3)),
            load: (t) => (Math.sin(t * 5) > 0 ? 1 : 0),
            mguk: -1,
            seconds: 4,
            limiter: true,
            mech: 1,
            before: (model) => {
                for (let i = 0; i < 12; i++) {
                    model.message({ type: 'cut', at: 0.2 + i * 0.3, duration: 0.035 });
                }
                model.message({ type: 'pops', times: [0.5, 0.55, 0.6, 1.5, 2.5], strength: 1 });
            },
        });
        for (const channel of [left, right]) {
            for (let i = 0; i < channel.length; i++) {
                assert.ok(Number.isFinite(channel[i]), `${engine}: NaN/Inf в семпъл ${i}`);
                assert.ok(Math.abs(channel[i]) <= 1, `${engine}: клипване в семпъл ${i}: ${channel[i]}`);
            }
        }
    }

    // ── Стабилност: спрян двигател → тръбите заглъхват, турбото спира ────
    {
        const { left } = render({ engine, rpm: (t) => (t < 0.5 ? top : 0), load: (t) => (t < 0.5 ? 1 : 0), seconds: 4, tuning: QUIET });
        // Турбото на хибрида се върти по инерция (~0.8 s константа) — чакаме го.
        const tail = rmsDb(left, sampleAt(3.4));
        assert.ok(tail < -80, `${engine}: след спиране звукът трябва да заглъхне, остана ${tail.toFixed(1)} dB`);
    }

    // ── Височина: палещата честота следва оборотите ──────────────────────
    for (const rpm of [6000, 9000, top]) {
        const { left } = render({ engine, rpm, load: 1, seconds: 1, tuning: QUIET, mech: 0 });
        const firing = (rpm / 60) * firingsPerRev;
        const atFiring = powerAt(left, firing, sampleAt(0.4), 16384);
        // Между хармониците на половинката на ордера не бива да има пик.
        const between = powerAt(left, firing * 1.1, sampleAt(0.4), 16384);
        assert.ok(
            atFiring - between > 15,
            `${engine} ${rpm} об/мин: палещата честота ${firing} Hz трябва да доминира (разлика ${(atFiring - between).toFixed(1)} dB)`
        );
    }

    // ── Газта: пълна газ е чувствително по-силна от затворена ────────────
    for (const rpm of [6000, top - 1000]) {
        const full = render({ engine, rpm, load: 1, seconds: 1.5, tuning: QUIET });
        const closed = render({ engine, rpm, load: 0, seconds: 1.5, tuning: QUIET });
        const difference = rmsDb(full.left, sampleAt(1)) - rmsDb(closed.left, sampleAt(1));
        assert.ok(difference > 8, `${engine} ${rpm} об/мин: газта трябва да дава > 8 dB, дава ${difference.toFixed(1)} dB`);
    }

    // ── Срязване при смяна: пулсациите спират ────────────────────────────
    {
        const base = { engine, rpm: top - 500, load: 1, seconds: 1, tuning: QUIET };
        const clean = render(base);
        const cut = render({ ...base, before: (model) => model.message({ type: 'cut', at: 0.5, duration: 0.035 }) });
        const window = [sampleAt(0.515), sampleAt(0.535)];
        const drop = rmsDb(clean.left, ...window) - rmsDb(cut.left, ...window);
        assert.ok(drop > 4, `${engine}: срязването трябва да свали нивото, свали го с ${drop.toFixed(1)} dB`);
        const beforeCut = cut.left.subarray(0, sampleAt(0.49));
        assert.deepEqual(beforeCut, clean.left.subarray(0, beforeCut.length), `${engine}: преди срязването звукът е непроменен`);
    }

    // ── Настройката на живо сменя тръбите (лабораторията разчита на това) ─
    {
        const base = { engine, rpm: 9000, load: 1, seconds: 0.5, tuning: QUIET, seed: 7 };
        const stock = render(base);
        const longer = render({
            ...base,
            before: (model) => model.message({ type: 'tune', values: { primaryLength: ENGINE_PRESETS[engine].primaryLength * 1.3 } }),
        });
        assert.notDeepEqual(stock.left, longer.left, `${engine}: по-дълги първични тръби = друг звук`);
    }
}

// ── Хибрид: турбото закъснява без MGU-H ──────────────────────────────────
{
    const { boost } = render({ rpm: 11000, load: (t) => (t < 0.5 ? 0 : 1), seconds: 2.5, tuning: QUIET });
    const at = (seconds) => boost[Math.floor((seconds * SAMPLE_RATE) / BLOCK)];
    assert.ok(at(0.45) < 0.05, `Без газ турбото не бива да има напор (${at(0.45).toFixed(2)})`);
    assert.ok(at(0.65) < 0.5, `0.15 s след газта турбото още не е завъртяно — закъснението е белег на 2026 (${at(0.65).toFixed(2)})`);
    assert.ok(at(2.4) > 0.9, `След ~2 s напорът е пълен (${at(2.4).toFixed(2)})`);
}

// ── Хибрид: MGU-K вие по оборотите, когато дава или зарежда ──────────────
{
    const rpm = 11000;
    const mgukHz = (rpm / 60) * ENGINE_PRESETS['v6-hybrid'].mgukRatio * ENGINE_PRESETS['v6-hybrid'].mgukPolePairs;
    const idle = render({ rpm, load: 1, mguk: 0, seconds: 1, tuning: QUIET, exhaust: 0, intake: 0, mech: 1 });
    const harvesting = render({ rpm, load: 1, mguk: -1, seconds: 1, tuning: QUIET, exhaust: 0, intake: 0, mech: 1 });
    const gain = powerAt(harvesting.left, mgukHz, sampleAt(0.4), 16384) - powerAt(idle.left, mgukHz, sampleAt(0.4), 16384);
    assert.ok(gain > 20, `MGU-K при зареждане трябва да се чува на ${mgukHz.toFixed(0)} Hz (+${gain.toFixed(1)} dB)`);
}

// ── Хибрид: спирачната зона по правилата от 2026 ─────────────────────────
{
    const state = { liftSeconds: 0 };
    const demand = { load: 0, mguk: 0 };
    hybridEngineDemand(state, 1, 0, 60, 0.1, demand);
    assert.deepEqual(demand, { load: 1, mguk: 1 }, 'Пълна газ: ДВС на пълен товар, MGU-K дава');
    hybridEngineDemand(state, 0, 1, 60, 0.1, demand);
    assert.equal(demand.load, 0, 'Първите мигове след отпускането са чист overrun (пукане)');
    assert.equal(demand.mguk, -1, 'На спирачката MGU-K зарежда');
    for (let i = 0; i < 10; i++) {
        hybridEngineDemand(state, 0, 1, 40, 0.1, demand);
    }
    assert.ok(demand.load > 0.5, `След ~0.6 s ДВС се връща на товар, за да зарежда (${demand.load})`);
    hybridEngineDemand(state, 0, 0, 2, 0.1, demand);
    assert.deepEqual(demand, { load: 0, mguk: 0 }, 'Почти на място няма зареждане');
}

// ── Цена: моделът трябва да е далеч под реалното време ───────────────────
for (const engine of Object.keys(ENGINE_PRESETS)) {
    const seconds = 4;
    const began = performance.now();
    render({ engine, rpm: (t) => 6000 + t * 1500, load: 1, seconds });
    const factor = (performance.now() - began) / 1000 / seconds;
    // Десктоп ~0.03; телефонът е 3–5× по-бавен, а worklet-ът се отказва сам
    // над 0.5. Прагът хваща регресия, преди да стигне до телефоните.
    assert.ok(factor < 0.12, `${engine}: моделът е твърде скъп — ${(factor * 100).toFixed(1)} % от реалното време`);
    console.log(`Цена ${engine}: ${(factor * 100).toFixed(2)} % от реалното време (Node)`);
}

console.log('СЕЛФТЕСТ ОК: физическият модел на двигателя (V6 хибрид 2026 и V10)');
