/**
 * Рендер на физическия модел на двигателя извън браузъра — за ухото на
 * човека (WAV) и за окото на ревюто (спектрограма PNG, статистика).
 *
 *   node scripts/game/engine-render.mjs [out-dir] [--track=monza] [--seconds=40] [--skip=20] [--engine=v6-hybrid|v10]
 *
 * --skip пропуска началото: от стоящ старт автопилотът пълзи през първия
 * шикан на Монца (~4 m/s за 5 s) — не е картина на каране.
 *
 * Пише в out-dir (по подразбиране storage/app/engine-samples, извън git):
 *   lap-{track}.wav       обиколка на автопилота през модела (chase микс)
 *   lap-{track}.png       спектрограма 0–8 kHz на същото
 *   lap-{track}.json      запис 60 Hz (обороти/газ/смени) за лабораторията
 *   sweep.wav / sweep.png празен ход → смяна → празен ход (газ, после спиране)
 *   stats.json            RMS по обороти и натоварване, пик, CPU
 *
 * Картата обороти → модел е тази на sound.js: мащабът на ерата
 * (ENGINE_RPM_SCALE), hybridEngineDemand (товар и MGU-K при спиране) и
 * пукотите при отпускане. Ако я промениш там — и тук.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { driveAutopilot } from '../../resources/js/game/autopilot.js';
import { SHIFT_RPM, createDrivetrain, updateDrivetrain } from '../../resources/js/game/drivetrain.js';
import { EngineModel } from '../../resources/js/game/engineWorklet.js';
import { FIXED_DT } from '../../resources/js/game/physics.js';
import { createSimFromData } from '../../resources/js/game/sim.js';
import { hybridEngineDemand } from '../../resources/js/game/sound.js';

/** Като ENGINE_ERAS в sound.js: оборотите за ухото спрямо стрелката. */
export const ENGINE_RPM_SCALE = { 'v6-hybrid': 1, v10: 1.55 };
const SAMPLE_RATE = 48000;
const BLOCK = 128;
const FRAME_RATE = 60;

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const found = args.find((arg) => arg.startsWith(`--${name}=`));

    return found ? found.slice(name.length + 3) : fallback;
};
const outDir = args.find((arg) => !arg.startsWith('--')) ?? 'storage/app/engine-samples';
const trackSlug = option('track', 'monza');
const maxSeconds = Number(option('seconds', '40'));
const skipSeconds = Number(option('skip', '20'));
const engineOption = option('engine', 'v6-hybrid');

// ── Запис на обиколка: автопилот + трансмисията на играта ────────────────
/**
 * @returns {{ rate: number, frames: Array<{rpm: number, throttle: number, limiter: boolean, shift: number, overrun: boolean, speed: number}> }}
 */
export function recordLap(slug, seconds) {
    const trackData = JSON.parse(readFileSync(`public/game-tracks/${slug}.json`, 'utf8'));
    const sim = createSimFromData(trackData);
    const input = { steer: 0, throttle: 0, brake: 0 };
    const train = createDrivetrain(false);
    const frames = [];
    const ticksPerFrame = Math.round(1 / (FIXED_DT * FRAME_RATE));
    const totalTicks = Math.round(seconds / FIXED_DT);
    let previousThrottle = 0;

    for (let tick = 0; tick < totalTicks; tick++) {
        driveAutopilot(sim, input);
        sim.tick(input);
        if (tick % ticksPerFrame !== ticksPerFrame - 1) {
            continue;
        }
        const state = sim.state;
        const throttle = state.throttlePedal ?? input.throttle;
        updateDrivetrain(train, state.vForward, input.throttle, 1 / FRAME_RATE);
        // Същото условие като Game.js за overrun пукотите.
        const overrun = previousThrottle > 0.8 && throttle < 0.1 && train.visualRpm > SHIFT_RPM * 0.77;
        previousThrottle = throttle;
        frames.push({
            rpm: Math.round(train.visualRpm),
            throttle: Math.round(throttle * 1000) / 1000,
            brake: Math.round(input.brake * 1000) / 1000,
            limiter: train.limiter,
            shift: Math.abs(state.vForward) > 2 ? train.shifted : 0,
            overrun,
            speed: Math.round(Math.abs(state.vForward) * 100) / 100,
        });
    }

    return { rate: FRAME_RATE, frames };
}

// ── Рендер през модела с картата на sound.js ────────────────────────────
/**
 * @param {{rate: number, frames: object[]}} recording
 * @param {{ engine?: string, exhaust?: number, intake?: number, mech?: number, tuning?: object }} [mix]
 */
export function renderRecording(recording, mix = {}) {
    const engine = mix.engine ?? 'v6-hybrid';
    const rpmScale = ENGINE_RPM_SCALE[engine] ?? 1;
    const model = new EngineModel(SAMPLE_RATE, { engine, tuning: mix.tuning });
    model.exhaustGain = mix.exhaust ?? 1;
    model.intakeGain = mix.intake ?? 0.25;
    model.mechGain = mix.mech ?? 0.25;
    const harvestState = { liftSeconds: 0 };
    const demand = { load: 0, mguk: 0 };
    const samplesPerFrame = SAMPLE_RATE / recording.rate;
    const total = Math.floor(recording.frames.length * samplesPerFrame);
    const left = new Float32Array(total);
    const right = new Float32Array(total);
    const blockLeft = new Float32Array(BLOCK);
    const blockRight = new Float32Array(BLOCK);
    let smoothedRpm = recording.frames[0]?.rpm * rpmScale || 5000;
    let frameIndex = -1;
    let busy = 0;

    for (let start = 0; start < total; start += BLOCK) {
        const time = start / SAMPLE_RATE;
        const index = Math.min(recording.frames.length - 1, Math.floor(start / samplesPerFrame));
        const frame = recording.frames[index];
        if (index !== frameIndex) {
            frameIndex = index;
            if (engine === 'v6-hybrid') {
                hybridEngineDemand(harvestState, frame.throttle, frame.brake ?? 0, frame.speed ?? 0, 1 / recording.rate, demand);
            } else {
                demand.load = frame.throttle;
                demand.mguk = 0;
            }
            if (frame.shift > 0) {
                model.message({ type: 'cut', at: time, duration: 0.035 });
            } else if (frame.shift < 0) {
                model.message({ type: 'blip', at: time, duration: 0.09 });
            }
            if (frame.overrun) {
                model.message({ type: 'pops', times: overrunOffsets(frame.rpm / SHIFT_RPM, index).map((o) => time + o), strength: 1 });
            }
        }
        // Главната нишка пише rpm със setTargetAtTime(τ = 20 ms) — същото тук.
        const target = frame.rpm * rpmScale;
        smoothedRpm += (target - smoothedRpm) * (1 - Math.exp(-BLOCK / SAMPLE_RATE / 0.02));
        model.rpmTarget = smoothedRpm;
        model.loadTarget = demand.load;
        model.mgukTarget = demand.mguk;
        model.limiterOn = frame.limiter;

        const began = performance.now();
        model.process(blockLeft, blockRight, BLOCK, time);
        busy += performance.now() - began;
        const count = Math.min(BLOCK, total - start);
        left.set(blockLeft.subarray(0, count), start);
        right.set(blockRight.subarray(0, count), start);
    }

    return { left, right, realtimeFactor: busy / 1000 / (total / SAMPLE_RATE) };
}

/** Детерминирана версия на офсетите от sound.overrun (там са Math.random). */
function overrunOffsets(revRatio, seed) {
    let state = (seed * 2654435761) >>> 0 || 1;
    const random = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;

        return state / 4294967296;
    };
    const count = Math.max(2, Math.min(5, 2 + Math.floor(Math.min(1, revRatio) * 3)));
    const offsets = [];
    let at = 0.02 + random() * 0.05;
    for (let i = 0; i < count && at < 0.5; i++) {
        offsets.push(at);
        at += 0.06 + random() * 0.08;
    }

    return offsets;
}

// ── WAV (16-bit PCM стерео) ─────────────────────────────────────────────
export function writeWav(path, left, right, sampleRate = SAMPLE_RATE) {
    const frames = left.length;
    const buffer = Buffer.alloc(44 + frames * 4);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + frames * 4, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(2, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 4, 28);
    buffer.writeUInt16LE(4, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(frames * 4, 40);
    for (let i = 0; i < frames; i++) {
        buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), 44 + i * 4);
        buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), 46 + i * 4);
    }
    writeFileSync(path, buffer);
}

// ── Спектрограма → PNG (без зависимости: собствен FFT и PNG енкодер) ─────
function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) {
            j ^= bit;
        }
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let size = 2; size <= n; size <<= 1) {
        const angle = (-2 * Math.PI) / size;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        for (let start = 0; start < n; start += size) {
            let cr = 1;
            let ci = 0;
            for (let k = 0; k < size / 2; k++) {
                const a = start + k;
                const b = a + size / 2;
                const tr = re[b] * cr - im[b] * ci;
                const ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                const next = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = next;
            }
        }
    }
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }

    return table;
})();

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }

    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));

    return Buffer.concat([length, body, crc]);
}

/** Тъмносиньо → червено → жълто → бяло по dB. */
function heat(value) {
    const v = Math.max(0, Math.min(1, value));
    const r = Math.min(255, Math.round(v * 3 * 255));
    const g = Math.min(255, Math.max(0, Math.round((v * 3 - 1) * 255)));
    const b = Math.min(255, Math.max(0, Math.round((v * 3 - 2) * 255 + (1 - v) * 60)));

    return [r, g, b];
}

export function writeSpectrogram(path, signal, { maxHz = 8000, width = 1400, height = 480, sampleRate = SAMPLE_RATE } = {}) {
    const size = 4096;
    const hop = Math.max(64, Math.floor((signal.length - size) / width));
    const columns = Math.max(1, Math.floor((signal.length - size) / hop));
    const bins = Math.floor((maxHz / sampleRate) * size);
    const window = new Float64Array(size).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
    const pixels = Buffer.alloc((columns * 3 + 1) * height);
    const re = new Float64Array(size);
    const im = new Float64Array(size);

    for (let x = 0; x < columns; x++) {
        for (let i = 0; i < size; i++) {
            re[i] = signal[x * hop + i] * window[i];
            im[i] = 0;
        }
        fft(re, im);
        for (let y = 0; y < height; y++) {
            const bin = Math.floor(((height - 1 - y) / height) * bins);
            const magnitude = Math.hypot(re[bin], im[bin]) / (size / 4);
            const db = 20 * Math.log10(magnitude + 1e-9);
            const [r, g, b] = heat((db + 90) / 80);
            const offset = y * (columns * 3 + 1) + 1 + x * 3;
            pixels[offset] = r;
            pixels[offset + 1] = g;
            pixels[offset + 2] = b;
        }
    }

    const header = Buffer.alloc(13);
    header.writeUInt32BE(columns, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', deflateSync(pixels)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
    writeFileSync(path, png);
}

// ── Статистика: устойчиви обороти × натоварване ─────────────────────────
export function steadyStats(engine = 'v6-hybrid', tuning = undefined) {
    const rows = [];
    const rpms = engine === 'v10' ? [5000, 7500, 10000, 12500, 15000, 17500, 18750] : [4500, 6000, 7500, 9000, 10500, 12000];
    for (const load of [0, 0.5, 1]) {
        for (const rpm of rpms) {
            const model = new EngineModel(SAMPLE_RATE, { engine, tuning });
            model.rpm = rpm;
            model.rpmTarget = rpm;
            model.load = load;
            model.loadTarget = load;
            const left = new Float32Array(BLOCK);
            const right = new Float32Array(BLOCK);
            let sum = 0;
            let count = 0;
            let peak = 0;
            const blocks = Math.ceil((SAMPLE_RATE * 1.5) / BLOCK);
            for (let b = 0; b < blocks; b++) {
                model.process(left, right, BLOCK, (b * BLOCK) / SAMPLE_RATE);
                if (b * BLOCK < SAMPLE_RATE * 0.5) {
                    continue; // първата половин секунда: тръбите се пълнят
                }
                for (let i = 0; i < BLOCK; i++) {
                    sum += left[i] * left[i] + right[i] * right[i];
                    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
                }
                count += 2 * BLOCK;
            }
            rows.push({ rpm, load, rmsDb: Math.round(10 * Math.log10(sum / count + 1e-12) * 10) / 10, peak: Math.round(peak * 1000) / 1000 });
        }
    }

    return rows;
}

function sweepRecording() {
    const frames = [];
    const seconds = 9;
    for (let i = 0; i < seconds * FRAME_RATE; i++) {
        const t = i / FRAME_RATE;
        const rise = t < 4.5 ? t / 4.5 : 1 - (t - 4.5) / 4.5;
        const accelerating = t < 4.5;
        frames.push({
            rpm: 4000 + rise * (SHIFT_RPM - 4000),
            throttle: accelerating ? 1 : 0,
            brake: accelerating ? 0 : 0.8,
            limiter: false,
            shift: 0,
            overrun: Math.abs(t - 4.5) < 0.5 / FRAME_RATE,
            speed: 60,
        });
    }

    return { rate: FRAME_RATE, frames };
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/engine-render.mjs')) {
    mkdirSync(outDir, { recursive: true });

    const recorded = recordLap(trackSlug, skipSeconds + maxSeconds);
    const lap = { rate: recorded.rate, frames: recorded.frames.slice(Math.round(skipSeconds * recorded.rate)) };
    writeFileSync(join(outDir, `lap-${trackSlug}.json`), JSON.stringify(lap));
    const rendered = renderRecording(lap, { engine: engineOption });
    writeWav(join(outDir, `lap-${trackSlug}.wav`), rendered.left, rendered.right);
    writeSpectrogram(join(outDir, `lap-${trackSlug}.png`), rendered.left);

    const sweep = renderRecording(sweepRecording(), { engine: engineOption });
    writeWav(join(outDir, 'sweep.wav'), sweep.left, sweep.right);
    writeSpectrogram(join(outDir, 'sweep.png'), sweep.left);

    let peak = 0;
    for (const v of rendered.left) {
        peak = Math.max(peak, Math.abs(v));
    }
    const stats = { engine: engineOption, realtimeFactor: rendered.realtimeFactor, lapPeak: peak, steady: steadyStats(engineOption) };
    writeFileSync(join(outDir, 'stats.json'), JSON.stringify(stats, null, 2));

    console.log(`Обиколка ${trackSlug}: ${(lap.frames.length / FRAME_RATE).toFixed(1)} s, пик ${peak.toFixed(3)}, CPU ${(rendered.realtimeFactor * 100).toFixed(2)} % от реалното време`);
    console.table(stats.steady.filter((row) => row.load !== 0.5));
    console.log(`Записано в ${outDir}`);
}
