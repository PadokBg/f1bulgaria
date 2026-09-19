/**
 * Физически модел на двигател — AudioWorklet в браузъра, чист клас в Node.
 *
 * Не е семпъл и не е синтезатор с осцилатори. Моделира се какво става в
 * изпускателната система: при отваряне на изпускателния клапан всеки
 * цилиндър изстрелва газов импулс в своята първична тръба (дигитален
 * waveguide — две линии за закъснение, вълна напред и назад). Тръбите на
 * банката се срещат в колектора, част от вълната се връща към клапаните,
 * а останалото продължава надолу. Резонансите на тръбите стоят на място, а
 * хармониците на паленето ги пресичат с оборотите — оттам тембърът, който се
 * сменя по оборотни диапазони. Всеки цикъл е малко различен (горенето не се
 * повтаря бит по бит), а двете банки не са огледални — оттам „живото".
 *
 * Два двигателя (V6_HYBRID_PRESET е този на играта):
 * - V6 турбо хибрид по правилата от 2026 г.: 1.6 l, 90°, палене на 120°,
 *   колектори 3-в-1 към една турбина. Турбината връща част от вълната,
 *   изсмуква енергия и заглажда импулсите; без MGU-H тя се върти само от
 *   газовете — закъснение при отваряне на газта, а wastegate тръбата
 *   изпуска сурови импулси при висок напор и при отпускане (оттам по-
 *   агресивният звук и пукането спрямо 2014–2025). MGU-K вие по оборотите,
 *   когато дава мощност или зарежда.
 * - V10 от 2005 г. (A/B и за любителите): колектори 5-в-1, отворени опашки.
 *
 * Плюс всмукване (фунии към въздушна кутия с Хелмхолцов резонанс) и блок
 * (резонанси, възбудени от горенето, и зъбните колела).
 *
 * Подходът: S. Baldan, H. Lachambre, S. Delle Monache, P. Boussard,
 * „Physically informed car engine sound synthesis for virtual and augmented
 * environments" (IEEE SIVE, 2015).
 *
 * Файлът е самостоятелен (без import): браузърът го зарежда като asset през
 * `?url` (Vite не бъндълва worklet модули), а Node го внася директно за
 * self-test-а и WAV рендерите. Горещият път не алокира нищо.
 */

/** V10 от 2005 г. — ъглите са в градуси колянов вал от ГМТ на горенето. */
export const V10_PRESET = Object.freeze({
    layout: 'v10',
    turbo: false,
    /** Изпускателният клапан: рано отваряне (високооборотен двигател), кратко припокриване. */
    exhaustOpen: 112,
    exhaustClose: 385,
    intakeOpen: 335,
    intakeClose: 610,
    /** Нарастване на blowdown импулса (градуси) и затихването му (ms — физическо време, не ъгъл). */
    blowdownRiseDeg: 9,
    blowdownDecayMs: 0.42,
    /** Изтласкване от буталото след долната мъртва точка, спрямо blowdown-а. */
    displacement: 0.2,
    /** Импулс без горене (срязано запалване / пропуск) — само компресия. */
    motoring: 0.12,
    /** Първични тръби: дължина (m), разлика между цилиндрите и по-дългата банка B. */
    primaryLength: 0.52,
    primarySpread: 0.025,
    bankSkew: 0.018,
    /** Тръбата след колектора: при V10 — опашката до атмосферата. */
    tailLength: 0.28,
    /** Скорост на звука в горещите газове, m/s (~600 °C средно по тръбата). */
    gasSpeed: 560,
    /** Сечение на тръбата след колектора спрямо първичната. */
    tailArea: 2.4,
    /** Загуби по стените: усилване и едно-полюсен lowpass (1 = без филтър) на преминаване. */
    pipeGain: 0.985,
    pipeDamping: 0.82,
    portReflectionClosed: 0.93,
    portReflectionOpen: -0.25,
    /** Отворен край: нискочестотното се отразява (с обърнат знак), високото излиза. */
    openReflection: 0.82,
    openCutoff: 2400,
    /** Турбина и wastegate (само при turbo: true). */
    turbineReflection: 0,
    turbineCutoff: 2000,
    turbineExtraction: 0,
    spoolStartRpm: 6000,
    spoolSpanRpm: 5000,
    spoolUpSeconds: 0.35,
    spoolDownSeconds: 0.8,
    wastegateBoost: 0.8,
    wastegateLift: 0.7,
    tailpipeLength: 0.4,
    tailpipeSpeed: 520,
    wastegateLength: 0.28,
    wastegateLevel: 1,
    turboWhistle: 0,
    whistleMinHz: 2800,
    whistleMaxHz: 7200,
    /** MGU-K: предавка към коляновия вал, двойки полюси, сила на воя. */
    mgukLevel: 0,
    mgukRatio: 3,
    mgukPolePairs: 4,
    /** Всмукване: фуния + канал (m), скорост на звука във въздуха, въздушна кутия. */
    runnerLength: 0.19,
    airSpeed: 345,
    runnerReflection: 0.72,
    runnerCutoff: 3200,
    airboxHz: 118,
    airboxQ: 1.6,
    /** Кутията (Хелмхолц, тътен) и фуниите (хармониците — „вой" над главата). */
    airboxLevel: 1.6,
    runnerLevel: 7,
    /** Кутията и шнорхелът гасят високото — двуполюсен lowpass на всмукването. */
    intakeToneHz: 3200,
    intakeAmount: 0.9,
    intakeNoise: 0.05,
    /** Турбулентен шум в газовия поток — „ръбът" на звука. */
    flowNoise: 0.18,
    /** Разлика между циклите: при пълна газ, при затворена, и по време (градуси). */
    jitter: 0.06,
    jitterLight: 0.2,
    jitterTimingDeg: 0.8,
    /** Постоянна разлика между цилиндрите (не са идентични). */
    cylinderSpread: 0.04,
    /**
     * Пропуски на запалване при затворена газ и „изстрели" в ауспуха при
     * отпусната газ на високи обороти — в събития за секунда, не на цикъл:
     * иначе с оборотите растат десетократно.
     */
    misfiresPerSecond: 3,
    burblesPerSecond: 5,
    burbleMinRpm: 9000,
    /** Резонанси на блока (Hz) и тяхното Q. */
    blockModes: [680, 1450, 3100],
    blockQ: 8,
    blockLevel: 0.25,
    /** Зъбни колела на разпределителния механизъм: ордери спрямо коляновия вал. */
    whineOrders: [18, 34],
    whineLevel: 0.012,
    popLevel: 0.35,
    /** Лимитер с пълно срязване: честота и дял на срязаните цикли. */
    limiterRate: 13,
    limiterDuty: 0.45,
    /**
     * Калибровка на трите източника (при усилване 1 от главната нишка):
     * излъчването е производна на потока и без нея ауспухът е с ~25 dB под
     * всмукването. Камерата после ги смесва през exhaust/intake/mech.
     */
    exhaustLevel: 9,
    exhaustToneHz: 7000,
    intakeLevel: 0.9,
    mechLevel: 1,
    outputGain: 1.2,
    /** Компенсация на силата: без нея ~20 dB разлика между празен ход и червено. */
    loudnessPivotRpm: 9000,
    loudnessSlope: 0.55,
});

/**
 * V6 турбо хибрид, 2026 г. Работният диапазон е ~7 000–12 000 об/мин:
 * над 10 500 регламентът тавани енергията на горивото, затова въртенето
 * към тавана от 15 000 не носи мощност. Числата, които не идват от
 * регламента (дължини, ъгли на клапаните), са инженерна оценка, настроена на
 * ухо в лабораторията.
 */
export const V6_HYBRID_PRESET = Object.freeze({
    ...V10_PRESET,
    layout: 'v6',
    turbo: true,
    exhaustOpen: 118,
    exhaustClose: 380,
    intakeOpen: 345,
    intakeClose: 600,
    /** По-високо налягане пред турбината — по-дълъг blowdown. */
    blowdownRiseDeg: 10,
    blowdownDecayMs: 0.55,
    displacement: 0.25,
    primaryLength: 0.55,
    primarySpread: 0.02,
    bankSkew: 0.012,
    /** Тръбата от колектора 3-в-1 до турбината. */
    tailLength: 0.2,
    gasSpeed: 620,
    tailArea: 1.8,
    turbineReflection: 0.45,
    turbineCutoff: 2200,
    turbineExtraction: 0.45,
    spoolStartRpm: 6500,
    spoolSpanRpm: 4500,
    spoolUpSeconds: 0.35,
    spoolDownSeconds: 0.8,
    wastegateBoost: 0.8,
    wastegateLift: 0.7,
    tailpipeLength: 0.42,
    tailpipeSpeed: 520,
    wastegateLength: 0.28,
    wastegateLevel: 1.2,
    turboWhistle: 0.02,
    mgukLevel: 0.03,
    openCutoff: 2000,
    openReflection: 0.8,
    runnerLength: 0.16,
    airboxHz: 95,
    airboxLevel: 1.2,
    runnerLevel: 4,
    intakeLevel: 0.7,
    whineOrders: [15, 28],
    /** Без MGU-H турбото не се държи завъртяно електрически — повече пукане. */
    burbleMinRpm: 7000,
    burblesPerSecond: 6,
    popLevel: 0.4,
    limiterRate: 12,
    exhaustLevel: 9,
    exhaustToneHz: 6500,
    outputGain: 1.2,
    loudnessPivotRpm: 8000,
    loudnessSlope: 0.4,
});

export const ENGINE_PRESETS = Object.freeze({ 'v6-hybrid': V6_HYBRID_PRESET, v10: V10_PRESET });

/** Цилиндри, цилиндри на банка и слот на палене (банките се редуват). */
const LAYOUTS = {
    // V10, ред 1-6-5-10-2-7-3-8-4-9: слот k (на 72°) → цилиндър.
    v10: { cylinders: 10, bankSize: 5, slots: [0, 4, 6, 8, 2, 1, 5, 7, 9, 3] },
    // V6 на 120°, ред 1-4-2-5-3-6 (A B A B A B).
    v6: { cylinders: 6, bankSize: 3, slots: [0, 2, 4, 1, 3, 5] },
};
const MAX_CYLINDERS = 10;

/** Пръстенов буфер на линия; маската е по-бърза от модуло. */
const RING = 512;
const MASK = RING - 1;

/** Линии: първични, тръби след колектора, фунии, опашка след турбината, wastegate. */
const LINE_PRIMARY_OUT = 0;
const LINE_PRIMARY_BACK = 10;
const LINE_TAIL_OUT = 20;
const LINE_TAIL_BACK = 22;
const LINE_RUNNER_OUT = 24;
const LINE_RUNNER_BACK = 34;
const LINE_TURBO_OUT = 44;
const LINE_TURBO_BACK = 45;
const LINE_WASTEGATE_OUT = 46;
const LINE_WASTEGATE_BACK = 47;
const LINE_COUNT = 48;

/** Таблиците по ъгъл са през 1° за целия цикъл от 720°. */
const TABLE_SIZE = 721;
const RISE_TABLE_SIZE = 257;

const MAX_POPS = 16;

/**
 * Линейно до 0.7, после меко коляно, асимптотично към 1 — пукот или удар
 * не клипват, а нормалният сигнал не се оцветява.
 *
 * @param {number} x
 * @returns {number}
 */
function softLimit(x) {
    const magnitude = x < 0 ? -x : x;
    if (magnitude <= 0.7) {
        return x;
    }
    const shaped = 0.7 + 0.3 * Math.tanh((magnitude - 0.7) / 0.3);

    return x < 0 ? -shaped : shaped;
}

/**
 * Една стъпка xorshift32 — детерминиран шум, същият в браузъра и в Node.
 *
 * @param {number} x
 * @returns {number}
 */
function xorshift(x) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;

    return x >>> 0;
}

/**
 * Връща стойност в [0, 1). Входът е фаза минус отместване на цилиндъра —
 * винаги в (−2, 2), затова без Math.floor.
 *
 * @param {number} x
 * @returns {number}
 */
function wrapUnit(x) {
    if (x < 0) {
        x += 1;
        return x < 0 ? x + 1 : x;
    }

    return x >= 1 ? x - 1 : x;
}

function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
}

/**
 * RBJ bandpass (0 dB в пика) — коефициенти [b0, b2, a1, a2] (b1 = 0).
 *
 * @param {Float64Array} out
 * @param {number} offset
 * @param {number} frequency
 * @param {number} q
 * @param {number} sampleRate
 */
function bandpassCoefficients(out, offset, frequency, q, sampleRate) {
    const w0 = (2 * Math.PI * Math.min(frequency, sampleRate * 0.45)) / sampleRate;
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    out[offset] = alpha / a0;
    out[offset + 1] = -alpha / a0;
    out[offset + 2] = (-2 * Math.cos(w0)) / a0;
    out[offset + 3] = (1 - alpha) / a0;
}

export class EngineModel {
    /**
     * @param {number} sampleRate
     * @param {{ engine?: 'v6-hybrid'|'v10', seed?: number, tuning?: object }} [options]
     */
    constructor(sampleRate, options = {}) {
        this.sampleRate = sampleRate;
        const base = ENGINE_PRESETS[options.engine] ?? V6_HYBRID_PRESET;
        this.tuning = { ...base, ...(options.tuning ?? {}) };
        this.seed = (options.seed ?? 0x9e3779b9) >>> 0 || 1;
        this.random = this.seed;

        // Входове — Node ги пише директно, worklet-ът от AudioParam-ите.
        this.rpmTarget = 5000;
        this.loadTarget = 0;
        this.exhaustGain = 1;
        this.intakeGain = 0.3;
        this.mechGain = 0.2;
        this.limiterOn = false;
        this.width = 0.35;
        /** MGU-K: +1 дава пълна мощност, −1 зарежда с пълна сила. */
        this.mgukTarget = 0;

        this.rpm = this.rpmTarget;
        this.load = 0;
        this.phase = 0;
        this.writeIndex = 0;
        this.sampleIndex = 0;
        this.boost = 0;
        this.wastegate = 0;
        this.mguk = 0;

        this.lines = new Float32Array(LINE_COUNT * RING);
        this.lineFilter = new Float64Array(LINE_COUNT);

        this.slot = new Float64Array(MAX_CYLINDERS);
        this.bankOf = new Uint8Array(MAX_CYLINDERS);
        this.cylinderFactor = new Float64Array(MAX_CYLINDERS);
        this.primaryDelay = new Int32Array(MAX_CYLINDERS);
        this.runnerDelay = new Int32Array(MAX_CYLINDERS);
        this.tailDelay = new Int32Array(2);

        // Състояние на цикъла по цилиндър.
        this.lastLocal = new Float64Array(MAX_CYLINDERS).fill(0.999);
        this.timingOffset = new Float64Array(MAX_CYLINDERS);
        this.blowAmp = new Float64Array(MAX_CYLINDERS);
        this.pushAmp = new Float64Array(MAX_CYLINDERS);
        this.burnAmp = new Float64Array(MAX_CYLINDERS);
        this.blowStarted = new Uint8Array(MAX_CYLINDERS);
        this.blowEnvelope = new Float64Array(MAX_CYLINDERS);
        this.blowAge = new Float64Array(MAX_CYLINDERS);
        this.runnerFilter = new Float64Array(MAX_CYLINDERS);
        this.primaryArrival = new Float64Array(MAX_CYLINDERS);
        this.unburnt = new Float64Array(2);

        this.exhaustValve = new Float64Array(TABLE_SIZE);
        this.intakeValve = new Float64Array(TABLE_SIZE);
        this.pushTable = new Float64Array(TABLE_SIZE);
        this.closingTaper = new Float64Array(TABLE_SIZE);
        this.burnTable = new Float64Array(TABLE_SIZE);
        this.riseTable = new Float64Array(RISE_TABLE_SIZE);

        // Отворени краища: 0/1 банките (V10) или 0 опашка / 1 wastegate (турбо).
        this.openFilter = new Float64Array(2);
        this.previousFlow = new Float64Array(2);
        this.turbineFilter = new Float64Array(2);
        this.exhaustTone = new Float64Array(2);
        this.intakeTone = new Float64Array(2);
        this.flowNoiseState = new Float64Array(3);
        this.blockCoefficients = new Float64Array(12);
        this.blockState = new Float64Array(12);
        this.airboxCoefficients = new Float64Array(4);
        this.airboxState = new Float64Array(2);
        this.whinePhase = new Float64Array(2);
        this.whistlePhase = 0;
        this.mgukPhase = 0;
        this.previousIntake = 0;
        this.dcState = new Float64Array(4);
        this.wobble = 0;

        // Събития по часовника на контекста (секунди).
        this.cutFrom = -1;
        this.cutUntil = -1;
        this.blipUntil = -1;
        this.popTimes = new Float64Array(MAX_POPS);
        this.popStrengths = new Float64Array(MAX_POPS);
        this.popCount = 0;
        this.popEnvelope = new Float64Array(2);
        this.popAge = new Float64Array(2);
        this.limiterClock = 0;

        this.applyTuning();
    }

    /**
     * Пресмята всичко, което зависи от настройката: разположение, закъснения,
     * таблици, филтри. Вика се от конструктора и при tune съобщение.
     */
    applyTuning() {
        const t = this.tuning;
        const sr = this.sampleRate;
        const toSamples = (meters, speed) => clamp(Math.round((meters / speed) * sr), 2, RING - 2);
        const layout = LAYOUTS[t.layout] ?? LAYOUTS.v6;
        this.cylinderCount = layout.cylinders;
        this.bankSize = layout.bankSize;

        // Постоянните разлики между цилиндрите са от собствен генератор —
        // същият seed дава същия двигател при всяка настройка.
        let fixedRandom = this.seed ^ 0x5bd1e995;
        const nextFixed = () => {
            fixedRandom = xorshift(fixedRandom);

            return fixedRandom / 4294967296 - 0.5;
        };

        for (let c = 0; c < this.cylinderCount; c++) {
            const bank = c < this.bankSize ? 0 : 1;
            this.bankOf[c] = bank;
            this.slot[c] = layout.slots[c] / this.cylinderCount;
            this.cylinderFactor[c] = 1 + t.cylinderSpread * 2 * nextFixed();
            const length = t.primaryLength * (1 + t.primarySpread * 2 * nextFixed()) * (1 + bank * t.bankSkew);
            this.primaryDelay[c] = toSamples(length, t.gasSpeed);
            this.runnerDelay[c] = toSamples(t.runnerLength * (1 + 0.02 * nextFixed()), t.airSpeed);
        }
        this.tailDelay[0] = toSamples(t.tailLength, t.gasSpeed);
        this.tailDelay[1] = toSamples(t.tailLength * (1 + t.bankSkew), t.gasSpeed);
        this.tailpipeDelay = toSamples(t.tailpipeLength, t.tailpipeSpeed);
        this.wastegateDelay = toSamples(t.wastegateLength, t.tailpipeSpeed);

        const span = t.exhaustClose - t.exhaustOpen;
        const intakeSpan = t.intakeClose - t.intakeOpen;
        for (let deg = 0; deg < TABLE_SIZE; deg++) {
            const inExhaust = deg >= t.exhaustOpen && deg < t.exhaustClose;
            this.exhaustValve[deg] = inExhaust ? Math.sin((Math.PI * (deg - t.exhaustOpen)) / span) : 0;
            this.closingTaper[deg] = inExhaust ? clamp((t.exhaustClose - deg) / 25, 0, 1) : 0;
            this.pushTable[deg] = inExhaust && deg > 180 ? Math.sin((Math.PI * (deg - 180)) / (t.exhaustClose - 180)) : 0;
            const inIntake = deg >= t.intakeOpen && deg < t.intakeClose;
            this.intakeValve[deg] = inIntake ? Math.sin((Math.PI * (deg - t.intakeOpen)) / intakeSpan) : 0;
            // Налягането на горенето: пик около 10° след ГМТ, изгасва до 45°.
            this.burnTable[deg] = deg < 45 ? Math.sin((Math.PI * deg) / 45) ** 2 : 0;
        }
        for (let i = 0; i < RISE_TABLE_SIZE; i++) {
            this.riseTable[i] = 0.5 - 0.5 * Math.cos((Math.PI * i) / (RISE_TABLE_SIZE - 1));
        }

        const onePole = (hz) => 1 - Math.exp((-2 * Math.PI * hz) / sr);
        this.openCoefficient = onePole(t.openCutoff);
        this.runnerCoefficient = onePole(t.runnerCutoff);
        this.turbineCoefficient = onePole(t.turbineCutoff);
        this.flowCoefficient = onePole(6000);
        this.exhaustToneCoefficient = onePole(t.exhaustToneHz);
        this.intakeToneCoefficient = onePole(t.intakeToneHz);
        this.loadCoefficient = 1 - Math.exp(-1 / (0.015 * sr));
        this.mgukCoefficient = 1 - Math.exp(-1 / (0.05 * sr));
        this.dcCoefficient = Math.exp((-2 * Math.PI * 18) / sr);
        for (let m = 0; m < 3; m++) {
            bandpassCoefficients(this.blockCoefficients, m * 4, t.blockModes[m] ?? 1000, t.blockQ, sr);
        }
        bandpassCoefficients(this.airboxCoefficients, 0, t.airboxHz, t.airboxQ, sr);
    }

    /** xorshift32 → [-1, 1). Детерминиран: същият seed = същият звук. */
    noise() {
        this.random = xorshift(this.random);

        return this.random / 2147483648 - 1;
    }

    /** Приблизително нормално разпределение (сума от 4 равномерни), σ ≈ 1. */
    gauss() {
        return (this.noise() + this.noise() + this.noise() + this.noise()) * 0.866;
    }

    /**
     * Съобщение от главната нишка (или директно от Node).
     *
     * @param {{type: string, at?: number, duration?: number, times?: number[], strength?: number, values?: object}} data
     */
    message(data) {
        if (!data || typeof data !== 'object') {
            return;
        }
        switch (data.type) {
            case 'cut':
                this.cutFrom = data.at ?? 0;
                this.cutUntil = (data.at ?? 0) + (data.duration ?? 0.035);
                break;
            case 'blip':
                this.blipUntil = (data.at ?? 0) + (data.duration ?? 0.09);
                break;
            case 'pops': {
                const times = Array.isArray(data.times) ? data.times : [];
                for (const time of times) {
                    this.queuePop(time, data.strength ?? 1);
                }
                break;
            }
            case 'tune':
                this.tuning = { ...this.tuning, ...(data.values ?? {}) };
                this.applyTuning();
                break;
            default:
                break;
        }
    }

    /**
     * @param {number} time секунди по часовника на контекста
     * @param {number} strength
     */
    queuePop(time, strength) {
        if (this.popCount >= MAX_POPS) {
            return;
        }
        this.popTimes[this.popCount] = time;
        this.popStrengths[this.popCount] = strength;
        this.popCount++;
    }

    /**
     * Нов цикъл на цилиндъра (ГМТ на горенето): гори ли, колко силно, с
     * какво отклонение по време. Пропуснатото гориво изгаря в горещия
     * ауспух при следващото палене — пукотът след срязване.
     *
     * @param {number} c
     * @param {number} time
     */
    beginCycle(c, time) {
        const t = this.tuning;
        const load = this.load;
        const bank = this.bankOf[c];
        const cut =
            (time >= this.cutFrom && time < this.cutUntil) ||
            (this.limiterOn && this.limiterClock % 1 < t.limiterDuty);
        // Цилиндрови цикли в секунда: rpm/120 на цилиндър.
        const cyclesPerSecond = Math.max(1, (this.rpm / 120) * this.cylinderCount);
        const misfire = !cut && load < 0.1 && this.noise() * 0.5 + 0.5 < t.misfiresPerSecond / cyclesPerSecond;
        const fired = !cut && !misfire;

        const sigma = t.jitterLight + (t.jitter - t.jitterLight) * load;
        const variation = Math.max(0.2, 1 + sigma * this.gauss());
        const base = fired ? 0.15 + 0.85 * load : t.motoring;
        this.blowAmp[c] = this.cylinderFactor[c] * base * variation;
        this.pushAmp[c] = (fired ? 1 : 0.6) * (0.4 + 0.6 * load) * t.displacement;
        this.burnAmp[c] = fired ? this.cylinderFactor[c] * (0.3 + 0.7 * load) * variation : 0;
        this.timingOffset[c] = (t.jitterTimingDeg / 720) * this.gauss();
        this.blowStarted[c] = 0;

        // Несгорялото гориво (срязване, пропуск) се пали в горещия колектор
        // при следващото горене на банката. Единичен пропуск (0.5) не стига,
        // а под прага на пукането пропуските не трупат — пука след срязване,
        // лимитер и при отпускане на високи обороти, не на празен ход.
        if (!fired) {
            const fuel = cut ? 1 : this.rpm > t.burbleMinRpm ? 0.5 : 0;
            this.unburnt[bank] = Math.min(4, this.unburnt[bank] + fuel);
        } else {
            if (this.unburnt[bank] >= 1 && this.noise() > -0.4) {
                this.queuePop(time + 0.002, Math.min(1, 0.35 + 0.15 * this.unburnt[bank]));
            } else if (
                load < 0.08 &&
                this.rpm > t.burbleMinRpm &&
                this.noise() * 0.5 + 0.5 < t.burblesPerSecond / cyclesPerSecond
            ) {
                this.queuePop(time + 0.001, 0.12 + 0.16 * (this.noise() * 0.5 + 0.5));
            }
            this.unburnt[bank] = 0;
        }
    }

    /**
     * Рендерира `frames` семпъла стерео. `time` е часовникът на контекста в
     * първия семпъл — по него се изпълняват насрочените срязвания и пукоти.
     *
     * @param {Float32Array} left
     * @param {Float32Array} right
     * @param {number} frames
     * @param {number} time
     */
    process(left, right, frames, time) {
        const t = this.tuning;
        const sr = this.sampleRate;
        const secondsPerSample = 1 / sr;
        // Масивите и настройките в локални — горещият цикъл минава милиони
        // пъти в секунда, а свойствата на `this` V8 не извежда извън цикъла.
        const lines = this.lines;
        const lineFilter = this.lineFilter;
        const slot = this.slot;
        const timingOffset = this.timingOffset;
        const lastLocal = this.lastLocal;
        const bankOf = this.bankOf;
        const exhaustValve = this.exhaustValve;
        const intakeValveTable = this.intakeValve;
        const pushTable = this.pushTable;
        const closingTaper = this.closingTaper;
        const burnTable = this.burnTable;
        const riseTable = this.riseTable;
        const blowStarted = this.blowStarted;
        const blowAge = this.blowAge;
        const blowEnvelope = this.blowEnvelope;
        const blowAmp = this.blowAmp;
        const pushAmp = this.pushAmp;
        const burnAmp = this.burnAmp;
        const primaryDelay = this.primaryDelay;
        const runnerDelay = this.runnerDelay;
        const primaryArrival = this.primaryArrival;
        const runnerFilter = this.runnerFilter;
        const cylinderFactor = this.cylinderFactor;
        const flowState = this.flowNoiseState;
        const openFilter = this.openFilter;
        const previousFlow = this.previousFlow;
        const turbineFilter = this.turbineFilter;
        const exhaustTone = this.exhaustTone;
        const intakeToneState = this.intakeTone;
        const airbox = this.airboxCoefficients;
        const airboxState = this.airboxState;
        const blockCoefficients = this.blockCoefficients;
        const blockState = this.blockState;
        const whinePhase = this.whinePhase;
        const dc = this.dcState;

        const cylinderCount = this.cylinderCount;
        const bankSize = this.bankSize;
        const turbo = t.turbo === true;
        const damping = t.pipeDamping;
        const pipeGain = t.pipeGain;
        const flowNoise = t.flowNoise;
        const exhaustOpen = t.exhaustOpen;
        const portClosed = t.portReflectionClosed;
        const portSpan = t.portReflectionOpen - t.portReflectionClosed;
        const intakeAmount = t.intakeAmount;
        const intakeNoise = t.intakeNoise;
        const runnerReflection = t.runnerReflection;
        const openReflection = t.openReflection;
        const tailArea = t.tailArea;
        const tailAreaSum = bankSize + tailArea;
        const turbineReflection = t.turbineReflection;
        const runnerCoefficient = this.runnerCoefficient;
        const flowCoefficient = this.flowCoefficient;
        const openCoefficient = this.openCoefficient;
        const turbineCoefficient = this.turbineCoefficient;
        const loadCoefficient = this.loadCoefficient;
        const exhaustToneCoefficient = this.exhaustToneCoefficient;
        const intakeToneCoefficient = this.intakeToneCoefficient;
        const dcCoefficient = this.dcCoefficient;
        const exhaustLevel = t.exhaustLevel;
        const intakeMix = t.intakeLevel;
        const airboxLevel = t.airboxLevel;
        const runnerLevel = t.runnerLevel;
        const blockLevel = t.blockLevel;
        const mechLevel = t.mechLevel;
        const wastegateLevel = t.wastegateLevel;
        const whineOrderA = t.whineOrders[0] ?? 18;
        const whineOrderB = t.whineOrders[1] ?? 34;
        const exhaustGain = this.exhaustGain;
        const intakeGain = this.intakeGain;
        const mechGain = this.mechGain;
        const widthA = (1 + this.width) * 0.5;
        const widthB = (1 - this.width) * 0.5;
        const tailDelayA = this.tailDelay[0];
        const tailDelayB = this.tailDelay[1];
        const tailpipeDelay = this.tailpipeDelay;
        const wastegateDelay = this.wastegateDelay;

        // На блок (2.7 ms при 128 семпъла оборотите мърдат под 1 %): затихване
        // и ширина на импулса, изравняване на силата, „върти ли се".
        const rpmStart = this.rpm;
        const rpmEnd = clamp(this.rpmTarget, 0, 30000);
        const rpmStep = (rpmEnd - rpmStart) / frames;
        const rpmMid = 0.5 * (rpmStart + rpmEnd);
        const blockSeconds = frames * secondsPerSample;
        const degPerSampleMid = (rpmMid / 120) * secondsPerSample * 720;
        const decayDeg = clamp(t.blowdownDecayMs * 1e-3 * rpmMid * 6, 10, 90);
        const decayStep = Math.exp(-degPerSampleMid / decayDeg);
        const riseScale = (RISE_TABLE_SIZE - 1) / Math.max(t.blowdownRiseDeg, 2.5 * degPerSampleMid);
        const gain = t.outputGain * Math.pow(t.loudnessPivotRpm / Math.max(3000, rpmMid), t.loudnessSlope);
        // Газовият поток идва от движението на буталата: спрян двигател
        // не „духа" (иначе замръзнал отворен клапан шуми вечно).
        const running = rpmMid >= 1500 ? 1 : Math.max(0, rpmMid / 1500);
        const whineAmount = t.whineLevel * (rpmMid / 19000) * (rpmMid / 19000);

        // Турбо без MGU-H: напорът гони газ × обороти с инерцията на ротора;
        // wastegate-ът отваря при таван на напора и изпуска при отпускане.
        let extraction = 0;
        let wastegate = 0;
        let whistleStep = 0;
        let whistleAmount = 0;
        let mgukStep = 0;
        if (turbo) {
            const spool = clamp((rpmMid - t.spoolStartRpm) / t.spoolSpanRpm, 0, 1);
            const boostTarget = clamp(this.load, 0, 1) * spool;
            const tau = boostTarget > this.boost ? t.spoolUpSeconds : t.spoolDownSeconds;
            this.boost += (boostTarget - this.boost) * (1 - Math.exp(-blockSeconds / tau));
            const lifted = this.load < 0.1 && this.boost > 0.25;
            const wastegateGoal = lifted
                ? t.wastegateLift
                : clamp((this.boost - t.wastegateBoost) / (1 - t.wastegateBoost), 0, 1) * 0.6;
            this.wastegate += (wastegateGoal - this.wastegate) * (1 - Math.exp(-blockSeconds / 0.04));
            wastegate = this.wastegate;
            extraction = t.turbineExtraction * (0.5 + 0.5 * this.boost);
            whistleStep = (t.whistleMinHz + (t.whistleMaxHz - t.whistleMinHz) * this.boost) * secondsPerSample;
            whistleAmount = t.turboWhistle * this.boost * this.boost;
            mgukStep = ((rpmMid / 60) * t.mgukRatio * t.mgukPolePairs) * secondsPerSample;
        }
        const mgukLevel = t.mgukLevel * (0.3 + 0.7 * Math.min(1, rpmMid / 12000));

        let random = this.random;
        let rpm = rpmStart;
        let load = this.load;
        let phase = this.phase;
        let wobble = this.wobble;
        let mguk = this.mguk;
        let w = this.writeIndex;

        for (let i = 0; i < frames; i++) {
            const now = time + i * secondsPerSample;

            // ── Колянов вал: обороти, газ, лек разнобой в ъгловата скорост ──
            rpm += rpmStep;
            const loadGoal = now < this.blipUntil ? Math.max(this.loadTarget, 0.9) : this.loadTarget;
            load += (clamp(loadGoal, 0, 1) - load) * loadCoefficient;
            mguk += (clamp(this.mgukTarget, -1, 1) - mguk) * this.mgukCoefficient;
            random = xorshift(random);
            wobble += (random / 2147483648 - 1 - wobble) * 0.0008;
            const cyclesPerSample = (rpm > 0 ? rpm / 120 : 0) * secondsPerSample * (1 + wobble * 0.004);
            phase += cyclesPerSample;
            if (phase >= 1) {
                phase -= 1;
            }
            const degPerSample = cyclesPerSample * 720;

            // Шум на потока — по един за банка и за всмукването, леко изгладен.
            random = xorshift(random);
            flowState[0] += (random / 2147483648 - 1 - flowState[0]) * flowCoefficient;
            random = xorshift(random);
            flowState[1] += (random / 2147483648 - 1 - flowState[1]) * flowCoefficient;
            random = xorshift(random);
            flowState[2] += (random / 2147483648 - 1 - flowState[2]) * flowCoefficient;

            let bankSumA = 0;
            let bankSumB = 0;
            let intakeFlow = 0;
            let burn = 0;
            const suctionScale = -intakeAmount * (0.35 + 0.65 * load) * running;
            const intakeNoiseScale = flowState[2] * intakeNoise * (0.4 + 0.6 * load) * running;

            for (let c = 0; c < cylinderCount; c++) {
                let local = wrapUnit(phase - slot[c] - timingOffset[c]);
                if (lastLocal[c] - local > 0.5) {
                    this.random = random;
                    this.rpm = rpm;
                    this.load = load;
                    this.beginCycle(c, now);
                    random = this.random;
                    local = wrapUnit(phase - slot[c] - timingOffset[c]);
                }
                lastLocal[c] = local;

                const deg = local * 720;
                const index = deg | 0;
                const frac = deg - index;

                // ── Изпускане: blowdown + изтласкване + турбулентност ──
                const valve = exhaustValve[index] + (exhaustValve[index + 1] - exhaustValve[index]) * frac;
                let source = 0;
                if (valve > 0) {
                    if (blowStarted[c] === 0) {
                        blowStarted[c] = 1;
                        blowAge[c] = deg - exhaustOpen;
                        blowEnvelope[c] = Math.exp(-blowAge[c] / decayDeg);
                    } else {
                        blowAge[c] += degPerSample;
                        blowEnvelope[c] *= decayStep;
                    }
                    const risePosition = blowAge[c] * riseScale;
                    const rise = risePosition >= RISE_TABLE_SIZE - 1 ? 1 : riseTable[risePosition | 0];
                    const blow = blowAmp[c] * rise * blowEnvelope[c];
                    const push = pushAmp[c] * (pushTable[index] + (pushTable[index + 1] - pushTable[index]) * frac);
                    source = ((blow + push) * closingTaper[index] + flowState[bankOf[c]] * flowNoise * blow) * running;
                }

                const readIndex = (w - primaryDelay[c]) & MASK;
                const outBase = (LINE_PRIMARY_OUT + c) * RING;
                const arrivingAtPort = lines[(LINE_PRIMARY_BACK + c) * RING + readIndex];
                const arrivingAtCollector = lines[outBase + readIndex];
                const outLine = LINE_PRIMARY_OUT + c;
                lineFilter[outLine] += (source + (portClosed + portSpan * valve) * arrivingAtPort - lineFilter[outLine]) * damping;
                lines[outBase + w] = lineFilter[outLine] * pipeGain;
                primaryArrival[c] = arrivingAtCollector;
                if (c < bankSize) {
                    bankSumA += arrivingAtCollector;
                } else {
                    bankSumB += arrivingAtCollector;
                }

                // ── Всмукване: вакуумен импулс при отворен клапан ──
                const intakeValve = intakeValveTable[index] + (intakeValveTable[index + 1] - intakeValveTable[index]) * frac;
                const runnerRead = (w - runnerDelay[c]) & MASK;
                const runnerOutBase = (LINE_RUNNER_OUT + c) * RING;
                const runnerBackBase = (LINE_RUNNER_BACK + c) * RING;
                const arrivingAtValve = lines[runnerBackBase + runnerRead];
                const arrivingAtAirbox = lines[runnerOutBase + runnerRead];
                const suction = (suctionScale * cylinderFactor[c] * intakeValve + intakeNoiseScale) * intakeValve;
                const runnerOut = LINE_RUNNER_OUT + c;
                lineFilter[runnerOut] += (suction + (0.95 - 1.15 * intakeValve) * arrivingAtValve - lineFilter[runnerOut]) * damping;
                lines[runnerOutBase + w] = lineFilter[runnerOut] * pipeGain;
                runnerFilter[c] += (arrivingAtAirbox - runnerFilter[c]) * runnerCoefficient;
                const runnerReflected = -runnerReflection * runnerFilter[c];
                lines[runnerBackBase + w] = runnerReflected;
                intakeFlow += arrivingAtAirbox - runnerReflected;

                // ── Горене → блок ──
                if (index < 45 && burnAmp[c] > 0) {
                    burn += burnAmp[c] * burnTable[index];
                }
            }
            burn *= running;

            // ── Колектори и тръбите след тях ──
            let popInjection = 0;
            if (this.popCount > 0 || this.popEnvelope[0] > 1e-4 || this.popEnvelope[1] > 1e-4) {
                this.random = random;
                popInjection = this.advancePops(now);
                random = this.random;
            }
            let radiatedA = 0;
            let radiatedB = 0;
            let incidentA = 0;
            let incidentB = 0;
            for (let bank = 0; bank < 2; bank++) {
                const tailRead = (w - (bank === 0 ? tailDelayA : tailDelayB)) & MASK;
                const tailBackLine = LINE_TAIL_BACK + bank;
                const tailOutLine = LINE_TAIL_OUT + bank;
                const arrivingFromTail = lines[tailBackLine * RING + tailRead];
                const junction = (2 * ((bank === 0 ? bankSumA : bankSumB) + tailArea * arrivingFromTail)) / tailAreaSum;

                const first = bank * bankSize;
                for (let c = first; c < first + bankSize; c++) {
                    const backLine = LINE_PRIMARY_BACK + c;
                    lineFilter[backLine] += (junction - primaryArrival[c] - lineFilter[backLine]) * damping;
                    lines[backLine * RING + w] = lineFilter[backLine] * pipeGain;
                }

                const intoTail = junction - arrivingFromTail + (turbo ? 0 : popInjection * (bank === 0 ? 1 : 0.7));
                lineFilter[tailOutLine] += (intoTail - lineFilter[tailOutLine]) * damping;
                lines[tailOutLine * RING + w] = lineFilter[tailOutLine] * pipeGain;

                const incident = lines[tailOutLine * RING + tailRead];
                if (turbo) {
                    // Турбината е стеснение: връща вълната със същия знак.
                    lines[tailBackLine * RING + w] = turbineReflection * incident;
                    if (bank === 0) {
                        incidentA = incident;
                    } else {
                        incidentB = incident;
                    }
                    continue;
                }

                // Отворен край: отразено = −r·lowpass(падащо); излъченото налягане
                // е производната на обемния поток (падащо − отразено).
                openFilter[bank] += (incident - openFilter[bank]) * openCoefficient;
                const reflected = -openReflection * openFilter[bank];
                lines[tailBackLine * RING + w] = reflected;
                const flow = incident - reflected;
                const radiated = flow - previousFlow[bank];
                previousFlow[bank] = flow;
                if (bank === 0) {
                    radiatedA = radiated;
                } else {
                    radiatedB = radiated;
                }
            }

            if (turbo) {
                // Двете банки влизат в турбината. Wastegate-ът взима част преди
                // нея — сурово; турбината изсмуква енергия и заглажда импулсите.
                const through = (incidentA + incidentB) * (1 - turbineReflection);
                turbineFilter[0] += (through * (1 - wastegate) * (1 - extraction) - turbineFilter[0]) * turbineCoefficient;
                turbineFilter[1] += (turbineFilter[0] - turbineFilter[1]) * turbineCoefficient;

                // Опашката след турбината (0) и wastegate тръбата (1): отворени краища.
                for (let pipe = 0; pipe < 2; pipe++) {
                    const outLine = pipe === 0 ? LINE_TURBO_OUT : LINE_WASTEGATE_OUT;
                    const backLine = pipe === 0 ? LINE_TURBO_BACK : LINE_WASTEGATE_BACK;
                    const read = (w - (pipe === 0 ? tailpipeDelay : wastegateDelay)) & MASK;
                    const arrivingBack = lines[backLine * RING + read];
                    const input =
                        pipe === 0
                            ? turbineFilter[1] + 0.5 * arrivingBack + popInjection * 0.8
                            : through * wastegate + 0.3 * arrivingBack + popInjection * 0.6;
                    lineFilter[outLine] += (input - lineFilter[outLine]) * damping;
                    lines[outLine * RING + w] = lineFilter[outLine] * pipeGain;
                    const incident = lines[outLine * RING + read];
                    openFilter[pipe] += (incident - openFilter[pipe]) * openCoefficient;
                    const reflected = -openReflection * openFilter[pipe];
                    lines[backLine * RING + w] = reflected;
                    const flow = incident - reflected;
                    const radiated = flow - previousFlow[pipe];
                    previousFlow[pipe] = flow;
                    if (pipe === 0) {
                        radiatedA = radiated;
                        radiatedB = radiated;
                    } else {
                        // Wastegate тръбите са встрани от опашката — леко разтворени.
                        radiatedA += radiated * wastegateLevel;
                        radiatedB += radiated * wastegateLevel * 0.8;
                    }
                }
            }

            // ── Въздушна кутия: Хелмхолцов резонанс + директно излъчване ──
            const airboxOut = airbox[0] * intakeFlow + airboxState[0];
            airboxState[0] = -airbox[2] * airboxOut + airboxState[1];
            airboxState[1] = airbox[1] * intakeFlow - airbox[3] * airboxOut;
            const intakeDirect = intakeFlow - this.previousIntake;
            this.previousIntake = intakeFlow;
            const intakeRaw = (airboxLevel * airboxOut + runnerLevel * intakeDirect) * intakeMix;
            intakeToneState[0] += (intakeRaw - intakeToneState[0]) * intakeToneCoefficient;
            intakeToneState[1] += (intakeToneState[0] - intakeToneState[1]) * intakeToneCoefficient;
            const intake = intakeToneState[1];

            // ── Блок, зъбни колела, турбо свирене, MGU-K ──
            let block = 0;
            for (let k = 0; k < 12; k += 4) {
                const y = blockCoefficients[k] * burn + blockState[k];
                blockState[k] = -blockCoefficients[k + 2] * y + blockState[k + 1];
                blockState[k + 1] = blockCoefficients[k + 1] * burn - blockCoefficients[k + 3] * y;
                block += y;
            }
            const revsPerSample = cyclesPerSample * 2;
            whinePhase[0] += whineOrderA * revsPerSample;
            if (whinePhase[0] >= 1) {
                whinePhase[0] -= Math.floor(whinePhase[0]);
            }
            whinePhase[1] += whineOrderB * revsPerSample;
            if (whinePhase[1] >= 1) {
                whinePhase[1] -= Math.floor(whinePhase[1]);
            }
            let mech =
                block * blockLevel +
                (Math.sin(2 * Math.PI * whinePhase[0]) + Math.sin(2 * Math.PI * whinePhase[1])) * whineAmount * (0.6 + 0.4 * load);
            if (turbo) {
                this.whistlePhase += whistleStep;
                if (this.whistlePhase >= 1) {
                    this.whistlePhase -= 1;
                }
                mech += Math.sin(2 * Math.PI * this.whistlePhase) * whistleAmount;
                // MGU-K: основната електрическа честота + хармоник на инвертора;
                // при зареждане (−) тембърът е по-остър.
                this.mgukPhase += mgukStep;
                if (this.mgukPhase >= 1) {
                    this.mgukPhase -= 1;
                }
                const angle = 2 * Math.PI * this.mgukPhase;
                const torque = mguk < 0 ? -mguk : mguk;
                mech +=
                    (Math.sin(angle) + 0.35 * Math.sin(2 * angle) + (mguk < 0 ? 0.3 * Math.sin(3 * angle) : 0)) *
                    torque *
                    mgukLevel;
            }
            mech *= mechLevel;

            // ── Микс: двете банки (или опашка + wastegate) в стерео ──
            // Излъчването (производна) е с наклон +6 dB/окт — въздухът и
            // разстоянието го смекчават: едно-полюсен lowpass.
            exhaustTone[0] += (radiatedA * exhaustLevel - exhaustTone[0]) * exhaustToneCoefficient;
            exhaustTone[1] += (radiatedB * exhaustLevel - exhaustTone[1]) * exhaustToneCoefficient;
            const common = intakeGain * intake + mechGain * mech;
            const outLeft = (exhaustGain * (exhaustTone[0] * widthA + exhaustTone[1] * widthB) + common) * gain;
            const outRight = (exhaustGain * (exhaustTone[0] * widthB + exhaustTone[1] * widthA) + common) * gain;

            // DC блокер и мек таван — предпазни, не оцветяват в нормален режим.
            const dcLeft = outLeft - dc[0] + dcCoefficient * dc[1];
            dc[0] = outLeft;
            dc[1] = dcLeft;
            const dcRight = outRight - dc[2] + dcCoefficient * dc[3];
            dc[2] = outRight;
            dc[3] = dcRight;
            left[i] = softLimit(dcLeft);
            right[i] = softLimit(dcRight);
            w = (w + 1) & MASK;
        }

        this.random = random;
        this.rpm = rpm;
        this.load = load;
        this.phase = phase;
        this.wobble = wobble;
        this.mguk = mguk;
        this.writeIndex = w;
        this.limiterClock = (this.limiterClock + t.limiterRate * blockSeconds) % 1e6;
        this.sampleIndex += frames;
    }

    /**
     * Пукоти (изгаряне на гориво в ауспуха): кратък тъп удар + шумов взрив,
     * инжектирани след колектора — излизат през тръбата с нейния тембър.
     *
     * @param {number} now
     * @returns {number}
     */
    advancePops(now) {
        for (let p = 0; p < this.popCount; p++) {
            if (this.popTimes[p] <= now) {
                const slot = this.popEnvelope[0] <= this.popEnvelope[1] ? 0 : 1;
                this.popEnvelope[slot] = this.popStrengths[p] * this.tuning.popLevel;
                this.popAge[slot] = 0;
                this.popCount--;
                this.popTimes[p] = this.popTimes[this.popCount];
                this.popStrengths[p] = this.popStrengths[this.popCount];
                p--;
            }
        }

        let injection = 0;
        const step = 1 / this.sampleRate;
        for (let s = 0; s < 2; s++) {
            if (this.popEnvelope[s] > 1e-4) {
                const age = this.popAge[s];
                const thump = age < 0.003 ? Math.sin((Math.PI * age) / 0.003) : 0;
                injection += this.popEnvelope[s] * (0.55 * this.noise() * Math.exp(-age / 0.0018) + 0.45 * thump);
                this.popAge[s] = age + step;
                if (age > 0.02) {
                    this.popEnvelope[s] = 0;
                }
            }
        }

        return injection;
    }
}

// ── AudioWorklet обвивка (само в AudioWorkletGlobalScope) ────────────────
if (typeof AudioWorkletProcessor === 'function' && typeof registerProcessor === 'function') {
    /** Колко често worklet-ът докладва натоварването си (секунди аудио). */
    const LOAD_REPORT_SECONDS = 1;

    class PadokEngineProcessor extends AudioWorkletProcessor {
        static get parameterDescriptors() {
            return [
                { name: 'rpm', defaultValue: 5000, minValue: 0, maxValue: 30000, automationRate: 'k-rate' },
                { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
                { name: 'exhaust', defaultValue: 1, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
                { name: 'intake', defaultValue: 0.3, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
                { name: 'mech', defaultValue: 0.2, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
                { name: 'limiter', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
                { name: 'width', defaultValue: 0.35, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
                { name: 'mguk', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
            ];
        }

        constructor(options) {
            super();
            const processorOptions = options?.processorOptions ?? {};
            this.model = new EngineModel(sampleRate, processorOptions);
            this.alive = true;
            this.busyMs = 0;
            this.reportSamples = 0;
            this.port.onmessage = (event) => {
                if (event.data?.type === 'stop') {
                    this.alive = false;
                    return;
                }
                this.model.message(event.data);
            };
        }

        process(inputs, outputs, parameters) {
            const output = outputs[0];
            if (!output || output.length === 0) {
                return this.alive;
            }
            const started = Date.now();
            const model = this.model;
            model.rpmTarget = parameters.rpm[0];
            model.loadTarget = parameters.load[0];
            model.exhaustGain = parameters.exhaust[0];
            model.intakeGain = parameters.intake[0];
            model.mechGain = parameters.mech[0];
            model.limiterOn = parameters.limiter[0] > 0.5;
            model.width = parameters.width[0];
            model.mgukTarget = parameters.mguk[0];
            const left = output[0];
            const right = output[1] ?? output[0];
            model.process(left, right, left.length, currentTime);

            // Date.now() е с милисекундна стъпка, но средното за секунда е
            // достатъчно, за да хване телефон, който не смогва.
            this.busyMs += Date.now() - started;
            this.reportSamples += left.length;
            if (this.reportSamples >= sampleRate * LOAD_REPORT_SECONDS) {
                const audioMs = (this.reportSamples / sampleRate) * 1000;
                this.port.postMessage({ type: 'load', ratio: this.busyMs / audioMs });
                this.busyMs = 0;
                this.reportSamples = 0;
            }

            return this.alive;
        }
    }

    registerProcessor('padok-engine', PadokEngineProcessor);
}
