/**
 * Звук на двигателя и света — СИНТЕЗ в Web Audio, не семплиран loop.
 *
 * Двигателят има два гласа. Основният е физическият модел на V10 в
 * AudioWorklet (engineWorklet.js: цилиндри, първични тръби, колектори,
 * всмукване) — зарежда се асинхронно след start(), затова до него, при липса
 * на AudioWorklet или при телефон, който не смогва (worklet-ът докладва
 * натоварването си), свири осцилаторният синтез по-долу. Съперниците винаги
 * са на осцилаторния глас: шест физически модела са твърде скъпи.
 *
 * Предишният опит (семплиран откъс) звучеше като „забила предавка", защото
 * питчването на дълъг запис не следва оборотите точно. Тук честотата се
 * извежда от реалните обороти на трансмисията всеки кадър: двигател на R
 * об/мин пали FIRINGS_PER_REV пъти на оборот → палеща честота R/60·F Hz.
 * Смените на предавките дават скока в тона безплатно — оборотите реално падат.
 *
 * Тяло с движеща се височина: два PeriodicWave осцилатора (48 хармоника,
 * четните подчертани) на половин палеща честота, разстроени ∓6 cents → tanh
 * → три ФИКСИРАНИ пикови филтъра (въздушна кутия/тръби — те не мърдат с
 * оборотите и точно това прави „двигател", а не „синт") → lowpass по газта.
 *
 * Три отделни възела върху двигателя, за да не се презаписват взаимно:
 * engineGain (пише го САМО update, всеки кадър), engineDuck (пипат го САМО
 * събитията: смяна, удар, overrun), engineAm (LFO дълбочини: лимитер,
 * overrun, burble). Преди всичко минаваше през един AudioParam и срезът при
 * качване зависеше от кадровата честота.
 *
 * Шумовете (всмукване, керб, чакъл, вятър, гуми, тълпа…) четат ЕДИН 4 s
 * буфер, но всеки от случаен офсет — иначе са един и същ сигнал и тълпата
 * беше просто по-силен вятър.
 *
 * Реплеят е „ТВ картина": setBroadcast(true) сваля микса на пилота и пуска
 * крайпътния канал (updateBroadcast) — Доплер и lowpass по разстоянието до
 * ТВ поста. Attract режимът никога не създава контекст → тих по конструкция.
 *
 * Контекстът се създава при start() — изисква потребителски жест (бутона
 * „Карай"). Никакви асети, нула мрежа. iOS: физическият superключ за
 * беззвучен режим спира Web Audio изцяло (WebKit го брои за ambient); единственият
 * заобиколен път е HTMLMediaElement с беззвучен клип, което би било вграден
 * асет — умишлено НЕ е включено (решение на собственика).
 */

import { SHIFT_RPM } from './drivetrain.js';

/** Общо ниво — умерено; setVolume го скалира, M заглушава изцяло. */
const MASTER_VOLUME = 0.45;

/**
 * Ера на двигателя. 'hybrid' (по подразбиране): V6 турбо хибрид по правилата
 * от 2026 г. — 3 паления на оборот, стрелката и ухото в един мащаб
 * (drivetrain.js SHIFT_RPM ≈ реалните смени). 'v10': 5 паления на оборот и
 * оборотите за ухото ×1.55 — смяната на ~11 900 по стрелката звучи като
 * ~18 500 на V10 от 2005 г. Само константа — A/B на ухо.
 */
const ENGINE_ERA = 'hybrid';

const ENGINE_ERAS = {
    v10: { firingsPerRev: 5, rpmScale: 1.55, turbo: false, model: 'v10' },
    hybrid: { firingsPerRev: 3, rpmScale: 1, turbo: true, model: 'v6-hybrid' },
};

const ERA = ENGINE_ERAS[ENGINE_ERA];

/**
 * 2026: при спиране и в бавните завои ДВС не пада на празен ход — остава на
 * товар и върти MGU-K като генератор (зарежда батерията). Затова в бавните
 * части болидът звучи високо и „на газ", макар да не ускорява. Първите
 * HARVEST_DELAY секунди след отпускането са чист overrun (пукането), после
 * товарът се връща. Оценка по описанията на производителите — нивото се
 * сверява на ухо (setHarvestLoad в лабораторията).
 */
const HARVEST_LOAD = 0.6;
const HARVEST_DELAY = 0.25;
const HARVEST_RAMP = 0.35;

/**
 * Какво иска двигателят в този кадър: товар за ДВС и момент на MGU-K
 * (+ дава, − зарежда). Чиста функция — ползва я и scripts/game/engine-render.mjs,
 * за да рендерира WAV със същата логика като играта.
 *
 * @param {{ liftSeconds: number }} state   мутира се: време от отпускането
 * @param {number} throttle 0..1
 * @param {number} brake 0..1
 * @param {number} speed m/s
 * @param {number} dt s
 * @param {{ load: number, mguk: number }} out
 * @param {number} [harvestLoad]
 * @returns {{ load: number, mguk: number }}
 */
export function hybridEngineDemand(state, throttle, brake, speed, dt, out, harvestLoad = HARVEST_LOAD) {
    if (throttle < 0.15 && speed > 12) {
        state.liftSeconds += dt;
    } else {
        state.liftSeconds = 0;
    }
    const harvest = clamp01((state.liftSeconds - HARVEST_DELAY) / HARVEST_RAMP);
    out.load = Math.max(clamp01(throttle), harvestLoad * harvest);
    out.mguk = speed < 3 ? 0 : throttle > 0.3 ? clamp01(throttle) : -Math.max(clamp01(brake), 0.6 * harvest);

    return out;
}

/**
 * Ниво на физическия модел спрямо осцилаторния глас (изравнено на ухо в
 * лабораторията), тембър по камера и кога worklet-ът се смята за твърде
 * скъп: дял от реалното време на аудио нишката в два поредни отчета (по 1 s)
 * → обратно към осцилаторите до края на сесията.
 */
const MODEL_ENABLED_FOR_ERA = true;
const MODEL_LEVEL = 2.5;
const MODEL_TONE_CHASE = 6500;
const MODEL_TONE_ONBOARD = 9500;
const MODEL_MAX_LOAD = 0.5;
const MODEL_CUT_SECONDS = 0.035;
const MODEL_BLIP_SECONDS = 0.09;

/**
 * Миксът на модела по камера: отвън доминира ауспухът, в кокпита —
 * всмукването (въздушната кутия е над главата на пилота) и механиката (при
 * хибрида там са и турбото, и воят на MGU-K — затова mech е по-силен).
 */
const MODEL_MIX = {
    chase: { exhaust: 1, intake: 0.25, mech: 0.25, width: 0.4 },
    onboard: { exhaust: 0.65, intake: 0.9, mech: 0.75, width: 0.2 },
    broadcast: { exhaust: 1, intake: 0.1, mech: 0.15, width: 0.3 },
};

/** Хармоници в PeriodicWave (над Найкуист браузърът ги реже сам). */
const HARMONICS = 48;

/**
 * Период на зъбите на керба, m — СЪЩИЯТ като в mesh.js, sim и камерата, за
 * да съвпадат ухо и око: честота на тракането = скорост / период.
 */
const KERB_PERIOD = 0.9;

/** Обхват на съперника в ухото (m) и в ТВ картината (крайпътен пост). */
const RIVAL_RANGE = 70;
const BROADCAST_RANGE = 200;

/** Лимитерът „бие" на 27 Hz; пукот на всеки ~110 ms. */
const LIMITER_RATE = 27;
const LIMITER_CRACK_EVERY = 0.11;

/** Дължина на шумовия буфер, s. */
const NOISE_SECONDS = 4;

const MUTE_KEY = 'padok-game-muted';
const VOLUME_KEY = 'padok-game-volume';

/** Предпочитанията за звука надживяват инстанцията (quit → нова обиколка). */
/**
 * iOS Safari пуска Web Audio в сесия „ambient", която бутонът за тих режим
 * заглушава — затова звукът идваше само при включен звънец. „playback"
 * (Audio Session API, Safari 16.4+) свири и в тих режим, но спира музиката на
 * други приложения, така че се иска само докато звукът в играта е пуснат.
 * Другаде API-то липсва и това е no-op.
 *
 * @param {'playback'|'auto'} type
 */
function requestAudioSession(type) {
    try {
        const session = typeof navigator !== 'undefined' ? navigator.audioSession : undefined;
        if (session && session.type !== type) {
            session.type = type;
        }
    } catch {
        // Отказ/стара имплементация — остава поведението по подразбиране.
    }
}

function readMuted() {
    try {
        return localStorage.getItem(MUTE_KEY) === '1';
    } catch {
        return false;
    }
}

function writeMuted(value) {
    try {
        localStorage.setItem(MUTE_KEY, value ? '1' : '0');
    } catch {
        // Блокирано хранилище (private mode) — предпочитанието е само за сесията.
    }
}

function readVolume() {
    try {
        const raw = localStorage.getItem(VOLUME_KEY);
        if (raw === null) {
            return 1;
        }
        const parsed = Number.parseFloat(raw);

        return Number.isFinite(parsed) ? clamp01(parsed) : 1;
    } catch {
        return 1;
    }
}

function writeVolume(value) {
    try {
        localStorage.setItem(VOLUME_KEY, String(value));
    } catch {
        // Както при mute — сесийно.
    }
}

function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
}

/**
 * Хармоничният спектър на двигателя: четните ордери силни, нечетните
 * приглушени (1/k^0.8 наклон), истинските палещи ордери (2, 4, 10 спрямо
 * основната на половин палеща честота) подчертани ×1.6.
 *
 * @param {AudioContext} ctx
 * @returns {PeriodicWave}
 */
function buildEngineWave(ctx) {
    const real = new Float32Array(HARMONICS);
    const imag = new Float32Array(HARMONICS);
    for (let k = 1; k < HARMONICS; k++) {
        let amplitude = (k % 2 === 0 ? 1 : 0.35) / k ** 0.8;
        if (k === 2 || k === 4 || k === 10) {
            amplitude *= 1.6;
        }
        imag[k] = amplitude;
    }

    return ctx.createPeriodicWave(real, imag);
}

/**
 * Пише AudioParam само при реална промяна на целта: булевите слоеве (керб,
 * чакъл, тунел) иначе трупат по едно събитие на кадър за нищо.
 *
 * @param {AudioParam} param
 * @param {number} value
 * @param {number} tau
 * @param {number} t
 */
function setP(param, value, tau, t) {
    const last = param._target;
    if (last !== undefined && Math.abs(last - value) <= 1e-4 * Math.max(1, Math.abs(value))) {
        return;
    }
    param._target = value;
    param.setTargetAtTime(value, t, tau);
}

/**
 * Замразява параметър на текущата му стойност преди нова автоматизация —
 * cancelScheduledValues сам би върнал стойността ОТПРЕДИ последната крива.
 *
 * @param {AudioParam} param
 * @param {number} t
 */
/** Радиото: пращенето преди гласа, s; сила на гласа в микса; двигателят под него. */
const RADIO_SQUELCH_LEAD = 0.08;
const RADIO_LEVEL = 1.6;
const RADIO_ENGINE_DUCK = 0.45;

let radioCurveCache = null;

/**
 * Мека сатурация (tanh-подобна, рационална) — „пробитият" звук на отборното
 * радио. Кешира се: кривата е еднаква за всеки клип.
 *
 * @returns {Float32Array}
 */
function radioCurve() {
    if (radioCurveCache === null) {
        const samples = 1024;
        radioCurveCache = new Float32Array(samples);
        for (let i = 0; i < samples; i++) {
            const x = ((i / (samples - 1)) * 2 - 1) * 2.2;
            radioCurveCache[i] = x / (1 + Math.abs(x));
        }
    }

    return radioCurveCache;
}

function holdParam(param, t) {
    if (typeof param.cancelAndHoldAtTime === 'function') {
        param.cancelAndHoldAtTime(t);
    } else {
        const value = param.value;
        param.cancelScheduledValues(t);
        param.setValueAtTime(value, t);
    }
    param._target = undefined;
}

/**
 * @typedef {object} SoundExtras
 * @property {boolean} [kerb]        колата е на керб
 * @property {boolean} [gravel]      в чакъла
 * @property {boolean} [grass]       в тревата
 * @property {boolean} [runoff]      на асфалтов run-off
 * @property {number}  [speed]       m/s
 * @property {number}  [slip]        странично плъзгане (state.slip)
 * @property {number}  [satF]        насищане на предните гуми 0..1+ (sim out.rhoF)
 * @property {number}  [satR]        насищане на задните 0..1+ (sim out.rhoR)
 * @property {number}  [lockF]       блокирани предни 0..1
 * @property {number}  [lockR]       блокирани задни 0..1
 * @property {number}  [spin]        буксуване 0..1
 * @property {{impulse: number}|null} [wallHit] удар в стена този кадър
 * @property {number}  [brake]       0..1
 * @property {number}  [crowd]       близост до трибуни 0..1
 * @property {boolean} [tunnel]      в тунела (Монако)
 * @property {boolean} [bridge]      под мост/кросоувър
 * @property {'chase'|'onboard'} [cameraMode]
 * @property {boolean} [onboard]     алтернатива на cameraMode
 * @property {number}  [gear]        drivetrain.gear; 0 = заден ход (свирене на кутията)
 * @property {boolean} [limiter]     ръчна + лимитер + газ (drivetrain.limiter)
 * @property {boolean} [replay]      ТВ кадър — миксът на пилота е свален (като setBroadcast)
 * @property {number}  [wet]         0..1 дъжд (алтернатива на setRain)
 */

/**
 * @param {{ lowPower?: boolean, quality?: object, workletUrl?: string, engineModel?: boolean }} [options]
 *   Като при останалите модули: lowPower (телефон) сваля единствения скъп за
 *   CPU възел — тунелният конволвер става 0.35 s моно вместо 0.7 s стерео — и
 *   маха Haas закъсненията (полировка за слушалки на десктоп). quality не се
 *   чете — аудиото няма GPU цена. workletUrl: адресът на engineWorklet.js
 *   (Vite `?url` в играта, суров път в лабораторията); без него звучи само
 *   осцилаторният глас. engineModel: false изключва модела (A/B сравнение).
 */
export function createEngineSound(options = {}) {
    const lowPower = options.lowPower === true;
    const workletUrl = typeof options.workletUrl === 'string' ? options.workletUrl : null;
    let modelWanted = options.engineModel !== false && MODEL_ENABLED_FOR_ERA;
    // Физическият модел: null до зареждането; modelFailed спира нови опити.
    let model = null;
    let modelFailed = false;
    let modelLoadRatio = 0;
    let modelLoadStrikes = 0;
    let broadcastRpm = 0;
    let broadcastLoad = 0.8;
    // Хибридът: време от отпускането и какво иска двигателят (без алокации в кадъра).
    const harvestState = { liftSeconds: 0 };
    const demand = { load: 0, mguk: 0 };
    let harvestLoad = HARVEST_LOAD;
    let ctx = null;
    let nodes = null;
    let muted = readMuted();
    let volume = readVolume();
    // Отложеният suspend от stop(): пази се, за да може start() да го отмени.
    // Иначе бърз stop→start (blur→focus, край на реплей) първо резюмира
    // контекста, а закъснелият таймер го суспендва — и звукът "умира".
    let suspendTimer = null;
    // В спряно състояние (blur/меню) unmute с M НЕ бива да вдига мастера —
    // контекстът е още 'running' до отложения suspend и замразеният двигател
    // би избучал за части от секундата.
    let stopped = true;
    // ТВ картина: миксът на пилота е свален, крайпътният канал е активен.
    let broadcast = false;
    // Дали двигателят беше спрян (stop) преди ТВ картината — setBroadcast(true)
    // събужда контекста, за да се чуе fly-by-ът и след финал; при излизане
    // връщаме същото състояние, иначе замразеният двигател би избучал.
    let stoppedBeforeBroadcast = false;
    // Състояние между кадрите на update() — всичко е скаларно, нула алокации.
    let prevThrottle = 0;
    let nextCrackAt = 0;
    let bridgeUntil = 0;
    let lastScrapeAt = 0;
    let lastResumeTry = 0;
    let lastUpdateAt = 0;
    let boostEstimate = 0;
    let rainLevel = 0;

    const masterLevel = () => (muted || stopped ? 0 : MASTER_VOLUME * volume);

    const applyLevel = (tau) => {
        if (ctx && nodes) {
            nodes.master.gain.setTargetAtTime(masterLevel(), ctx.currentTime, tau);
        }
    };

    // Спиране: затихване и отложен suspend — паузата/менюто са тихи. Общо за
    // stop() и за излизането от ТВ картина, започнала при спрян двигател.
    const stopSound = () => {
        stopped = true;
        requestAudioSession('auto');
        if (!ctx || !nodes) {
            return;
        }
        applyLevel(0.1);
        if (suspendTimer !== null) {
            clearTimeout(suspendTimer);
        }
        suspendTimer = setTimeout(() => {
            suspendTimer = null;
            ctx?.suspend?.()?.catch?.(() => {});
        }, 300);
    };

    // iOS 'interrupted' (обаждане, Siri) не е стандартно състояние — resume
    // може да се откаже; опитваме най-много веднъж в секунда.
    const tryResume = () => {
        const now = typeof performance !== 'undefined' ? performance.now() : 0;
        if (now - lastResumeTry < 1000) {
            return;
        }
        lastResumeTry = now;
        const promise = ctx.resume?.();
        promise?.catch?.(() => {});
    };

    const build = () => {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        const t0 = ctx.currentTime;

        // ── Помощници за възли ──────────────────────────────────────────
        const gain = (value) => {
            const node = ctx.createGain();
            node.gain.value = value;

            return node;
        };
        const biquad = (type, frequency, q = 1, gainDb = 0) => {
            const node = ctx.createBiquadFilter();
            node.type = type;
            node.frequency.value = frequency;
            node.Q.value = q;
            node.gain.value = gainDb;

            return node;
        };
        const osc = (type, frequency) => {
            const node = ctx.createOscillator();
            node.type = type;
            node.frequency.value = frequency;

            return node;
        };
        // Постоянен сигнал: ConstantSource, а в стар WebKit — зациклен буфер.
        const constant = (value) => {
            if (ctx.createConstantSource) {
                const node = ctx.createConstantSource();
                node.offset.value = value;

                return node;
            }
            const buffer = ctx.createBuffer(1, 128, ctx.sampleRate);
            buffer.getChannelData(0).fill(value);
            const node = ctx.createBufferSource();
            node.buffer = buffer;
            node.loop = true;

            return node;
        };
        const sources = [];
        const started = (node) => {
            sources.push(node);

            return node;
        };

        // ── Мастер ─────────────────────────────────────────────────────
        const master = gain(0);
        master.connect(ctx.destination);

        // Brick-wall лимитер ПРЕДИ силата: прагът му е спрямо микса, не
        // спрямо избраната от играча сила (след master при 0.45 никога не
        // би се задействал). Пази редлайн + свистене + удар от клипване.
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -2;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.001;
        limiter.release.value = 0.06;
        limiter.connect(master);

        // Лек компресор връзва слоевете.
        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -18;
        compressor.ratio.value = 6;
        compressor.connect(limiter);

        // Всички слоеве се събират тук; оттук тръгват и send-овете.
        const mix = gain(1);
        mix.connect(compressor);

        // Миксът на пилота (двигател, всмукване, вятър, гуми, повърхности) —
        // ТВ картината го сваля наведнъж.
        const driverMix = gain(1);
        driverMix.connect(mix);

        // Общ −1 за униполярна AM: (LFO − 1)·depth ∈ [−2·depth, 0] — гейнът
        // само пада от базата, никога не я надвишава.
        const minusOne = started(constant(-1));
        const amPair = (lfo, targetParam) => {
            const depth = gain(0);
            lfo.connect(depth);
            minusOne.connect(depth);
            depth.connect(targetParam);

            return depth;
        };

        // ── Двигател ─────────────────────────────────────────────────────
        const wave = buildEngineWave(ctx);
        const engineMix = gain(0.45);
        const oscA = started(osc('sine', 300));
        oscA.setPeriodicWave(wave);
        oscA.detune.value = -6;
        const oscB = started(osc('sine', 300));
        oscB.setPeriodicWave(wave);
        oscB.detune.value = 6;
        oscA.connect(engineMix);
        oscB.connect(engineMix);

        // „Буцест" празен ход: AM на палеща/10 при ниски обороти.
        const lumpLfo = started(osc('sine', 30));
        const lumpDepth = amPair(lumpLfo, engineMix.gain);

        // Soft clip — метални хармоници, без цифрова твърдост.
        const shaper = ctx.createWaveShaper();
        const curve = new Float32Array(512);
        for (let i = 0; i < 512; i++) {
            const x = (i / 511) * 2 - 1;
            curve[i] = Math.tanh(2.2 * x);
        }
        shaper.curve = curve;

        // Фиксираните форманти = тялото (въздушна кутия, изпускателни тръби).
        const formant1 = biquad('peaking', 260, 1.5, 8);
        const formant2 = biquad('peaking', 900, 2, 6);
        const formant3 = biquad('peaking', 2400, 3, 5);
        // Пиковете добавят ниво — трим, за да остане компресорът в същия режим.
        const formantTrim = gain(0.7);

        const engineFilter = biquad('lowpass', 800, 1.1);
        const engineGain = gain(0);
        const engineDuck = gain(1);
        const engineAm = gain(1);
        const engineOut = gain(1);

        engineMix.connect(shaper);
        shaper.connect(formant1);
        formant1.connect(formant2);
        formant2.connect(formant3);
        formant3.connect(formantTrim);
        formantTrim.connect(engineFilter);
        engineFilter.connect(engineGain);
        engineGain.connect(engineDuck);
        engineDuck.connect(engineAm);
        engineAm.connect(engineOut);
        engineOut.connect(driverMix);

        // Лимитер: 27 Hz квадрат; overrun: 8–16 Hz квадрат; burble при
        // затворена газ на високи обороти: 11 Hz. Всеки със своя дълбочина,
        // защото ги пишат различни места (кадър vs събитие).
        const limiterLfo = started(osc('square', LIMITER_RATE));
        const limiterDepth = amPair(limiterLfo, engineAm.gain);
        const overrunLfo = started(osc('square', 12));
        const overrunDepth = amPair(overrunLfo, engineAm.gain);
        const burbleLfo = started(osc('square', 11));
        const burbleDepth = amPair(burbleLfo, engineAm.gain);

        // Haas ширина: закъснели копия встрани (8 и 5 ms) около сухия център.
        // Две страни, за да не „дърпа" прецедентният ефект към едната.
        const hasPanner = typeof ctx.createStereoPanner === 'function';
        if (hasPanner && !lowPower) {
            for (const [delaySeconds, pan] of [
                [0.008, 1],
                [0.005, -1],
            ]) {
                const delay = ctx.createDelay(0.05);
                delay.delayTime.value = delaySeconds;
                const side = gain(0.3);
                const panner = ctx.createStereoPanner();
                panner.pan.value = pan;
                engineOut.connect(delay);
                delay.connect(side);
                side.connect(panner);
                panner.connect(driverMix);
            }
        }

        // Ранна рефлексия от трибуните (18 ms) — отваря се с близостта им.
        const standDelay = ctx.createDelay(0.05);
        standDelay.delayTime.value = 0.018;
        const standGain = gain(0);
        engineOut.connect(standDelay);
        standDelay.connect(standGain);
        standGain.connect(driverMix);

        // ── Физическият модел: влиза в същата верига (duck/AM/Haas/тунел) ──
        // Тонът е въздухът между двигателя и ухото (отвън яде високото). Второ
        // рамо — ТВ картината: същият модел от крайпътния пост, с lowpass и
        // панорама по разстоянието (updateBroadcast).
        const modelTone = biquad('lowpass', MODEL_TONE_CHASE, 0.6);
        const modelLevel = gain(0);
        modelTone.connect(modelLevel);
        modelLevel.connect(engineDuck);
        const broadcastFilter = biquad('lowpass', 2000, 0.8);
        const broadcastGain = gain(0);
        const broadcastPan = hasPanner ? ctx.createStereoPanner() : null;
        modelTone.connect(broadcastFilter);
        broadcastFilter.connect(broadcastGain);
        if (broadcastPan) {
            broadcastGain.connect(broadcastPan);
            broadcastPan.connect(mix);
        } else {
            broadcastGain.connect(mix);
        }

        // ── Шумове (един буфер, различни офсети и филтри) ────────────────
        const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * NOISE_SECONDS, ctx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
            data[i] = Math.random() * 2 - 1;
        }
        const makeNoise = () => {
            const src = ctx.createBufferSource();
            src.buffer = noiseBuffer;
            src.loop = true;
            src.start(t0, Math.random() * (NOISE_SECONDS - 0.1));

            return src;
        };

        // Всмукване/изпускане — диша с газта.
        const intakeFilter = biquad('bandpass', 1400, 0.8);
        const intakeGain = gain(0);
        makeNoise().connect(intakeFilter);
        intakeFilter.connect(intakeGain);
        intakeGain.connect(driverMix);

        // Кербове: високочестотен шум, AM на скорост/0.9 m → тракане, което
        // ускорява с колата и съвпада с видимите зъби.
        const kerbFilter = biquad('highpass', 500, 0.7);
        const kerbGain = gain(0);
        const kerbLfo = started(osc('square', 31));
        const kerbDepth = gain(0); // вдига се само на керба
        kerbLfo.connect(kerbDepth);
        kerbDepth.connect(kerbGain.gain);
        makeNoise().connect(kerbFilter);
        kerbFilter.connect(kerbGain);
        kerbGain.connect(driverMix);

        // Чакъл: нисък тътен с гранулирана AM (шум през 12 Hz lowpass =
        // случайно блуждаене → хрущене, не равен съсък). Тревата е същият
        // слой, наполовина и с отворен до 400 Hz филтър.
        const gravelFilter = biquad('lowpass', 240, 0.7);
        const gravelGain = gain(0);
        makeNoise().connect(gravelFilter);
        gravelFilter.connect(gravelGain);
        gravelGain.connect(driverMix);
        const gravelWalk = biquad('lowpass', 12, 0.7);
        const gravelAmDepth = gain(0);
        makeNoise().connect(gravelWalk);
        gravelWalk.connect(gravelAmDepth);
        gravelAmDepth.connect(gravelGain.gain);

        // Асфалтов run-off: сух съсък над 1800 Hz (гумата „пее" на гладкото).
        const runoffFilter = biquad('highpass', 1800, 0.7);
        const runoffGain = gain(0);
        makeNoise().connect(runoffFilter);
        runoffFilter.connect(runoffGain);
        runoffGain.connect(driverMix);

        // Вятър — квадрат на скоростта, пориви от бавен LFO.
        const windFilter = biquad('bandpass', 750, 0.4);
        const windGain = gain(0);
        makeNoise().connect(windFilter);
        windFilter.connect(windGain);
        windGain.connect(driverMix);
        const gustLfo = started(osc('sine', 0.35));
        const gustDepth = amPair(gustLfo, windGain.gain);

        // Свистене на гуми: тесен bandpass с вибрато + октава — вой, не съскане.
        const screechSource = makeNoise();
        const screechFilter = biquad('bandpass', 2600, 7);
        const screechOctave = biquad('bandpass', 5200, 7);
        const screechOctaveGain = gain(0.35);
        const screechGain = gain(0);
        const screechLfo = started(osc('sine', 5.5));
        const screechDepth = gain(260);
        screechLfo.connect(screechDepth);
        screechDepth.connect(screechFilter.frequency);
        screechSource.connect(screechFilter);
        screechSource.connect(screechOctave);
        screechFilter.connect(screechGain);
        screechOctave.connect(screechOctaveGain);
        screechOctaveGain.connect(screechGain);
        screechGain.connect(driverMix);

        // Подзавиване: предните са наситени, задните — не. По-висок, равен
        // „стърг" — различим от воя на плъзгащата задница.
        const scrubFilter = biquad('bandpass', 1800, 3);
        const scrubGain = gain(0);
        makeNoise().connect(scrubFilter);
        scrubFilter.connect(scrubGain);
        scrubGain.connect(driverMix);

        // Блокирана гума: нисък глас (950 Hz), накъсан на 17 Hz — гумата
        // „подскача" по асфалта. Буксуването споделя веригата с половин AM.
        const lockFilter = biquad('bandpass', 950, 4);
        const lockAm = gain(1);
        const lockGain = gain(0);
        const lockLfo = started(osc('square', 17));
        const lockDepth = amPair(lockLfo, lockAm.gain);
        makeNoise().connect(lockFilter);
        lockFilter.connect(lockAm);
        lockAm.connect(lockGain);
        lockGain.connect(driverMix);

        // Свирене на кутията: триъгълник на скорост·22 Hz, едва доловим.
        const whineOsc = started(osc('triangle', 20));
        const whineGain = gain(0);
        whineOsc.connect(whineGain);
        whineGain.connect(driverMix);

        // Дъжд: пръски във високото, растат със скоростта (setRain/extras.wet).
        const rainFilter = biquad('bandpass', 4500, 0.5);
        const rainGain = gain(0);
        makeNoise().connect(rainFilter);
        rainFilter.connect(rainGain);
        rainGain.connect(driverMix);

        // ── Хибридна ера: турбо/MGU-H свирене и MGU-K harvest ─────────────
        let turbo = null;
        if (ERA.turbo) {
            // Boost следва газ·обороти с инерцията на турбината (0.35 s
            // нагоре, 0.6 s надолу); честотата на свиренето расте с него.
            const boost = started(constant(0));
            const turboSine = started(osc('sine', 1800));
            const turboTri = started(osc('triangle', 3600));
            const sineScale = gain(4200);
            const triScale = gain(8400);
            boost.connect(sineScale);
            boost.connect(triScale);
            sineScale.connect(turboSine.frequency);
            triScale.connect(turboTri.frequency);
            const turboHp = biquad('highpass', 1500, 0.7);
            const turboGain = gain(0);
            const turboLevel = gain(0.012);
            boost.connect(turboLevel);
            turboLevel.connect(turboGain.gain);
            turboSine.connect(turboHp);
            turboTri.connect(turboHp);
            turboHp.connect(turboGain);
            turboGain.connect(driverMix);

            const harvestOsc = started(osc('sine', 2400));
            const harvestGain = gain(0);
            harvestOsc.connect(harvestGain);
            harvestGain.connect(driverMix);

            turbo = { boost, harvestOsc, harvestGain };
        }

        // ── Тълпа: собствен шум → три форманта на глас (350/850/1900 Hz), всеки
        // с двойка бавни LFO — жагор, който диша, не равен съсък. ──────────
        const crowdSource = makeNoise();
        const crowdSum = gain(1);
        const crowdLfoRates = [
            [0.11, 0.23],
            [0.13, 0.19],
            [0.09, 0.27],
        ];
        [350, 850, 1900].forEach((frequency, i) => {
            const formant = biquad('bandpass', frequency, 2.5);
            const formantGain = gain(1);
            crowdSource.connect(formant);
            formant.connect(formantGain);
            formantGain.connect(crowdSum);
            for (const rate of crowdLfoRates[i]) {
                const lfo = started(osc('sine', rate));
                const depth = amPair(lfo, formantGain.gain);
                depth.gain.value = 0.22;
            }
        });
        const crowdGain = gain(0);
        crowdSum.connect(crowdGain);
        crowdGain.connect(mix);
        // Възгласи (рекорд/финал): отделен път, чуваем и далеч от трибуните.
        const cheerGain = gain(0);
        crowdSum.connect(cheerGain);
        cheerGain.connect(mix);

        // ── Пространство: тунел (конволюция) и мост (slapback) върху ЦЕЛИЯ
        // микс — преди само двигателят ставаше мокър и илюзията се късаше. ──
        const convolver = ctx.createConvolver();
        const irLength = Math.floor(ctx.sampleRate * (lowPower ? 0.35 : 0.7));
        const irChannels = lowPower ? 1 : 2;
        const ir = ctx.createBuffer(irChannels, irLength, ctx.sampleRate);
        for (let channel = 0; channel < irChannels; channel++) {
            const channelData = ir.getChannelData(channel);
            let smoothed = 0;
            for (let i = 0; i < irLength; i++) {
                // Затихващ шум, леко изгладен (евтин lowpass) — бетонен тунел.
                const raw = (Math.random() * 2 - 1) * Math.exp((-6 * i) / irLength);
                smoothed = smoothed * 0.6 + raw * 0.4;
                channelData[i] = smoothed;
            }
        }
        convolver.buffer = ir;
        const tunnelSend = gain(0);
        mix.connect(tunnelSend);
        tunnelSend.connect(convolver);
        convolver.connect(compressor);

        const bridgeSend = gain(0);
        const slapDelay = ctx.createDelay(0.1);
        slapDelay.delayTime.value = 0.045;
        const slapFeedback = gain(0.35);
        const slapLowpass = biquad('lowpass', 2000, 0.7);
        mix.connect(bridgeSend);
        bridgeSend.connect(slapDelay);
        slapDelay.connect(slapFeedback);
        slapFeedback.connect(slapLowpass);
        slapLowpass.connect(slapDelay);
        slapLowpass.connect(compressor);

        // ── Съперник / крайпътен канал: същото тяло в умалено, lowpass по
        // разстоянието, панорама по страната, Доплер по радиалната скорост. ──
        const rivalA = started(osc('sine', 300));
        rivalA.setPeriodicWave(wave);
        rivalA.detune.value = -6;
        const rivalB = started(osc('sine', 300));
        rivalB.setPeriodicWave(wave);
        rivalB.detune.value = 6;
        const rivalMix = gain(0.45);
        rivalA.connect(rivalMix);
        rivalB.connect(rivalMix);
        const rivalShaper = ctx.createWaveShaper();
        rivalShaper.curve = curve;
        const rivalFilter = biquad('lowpass', 900, 0.9);
        const rivalDuck = gain(1);
        const rivalGain = gain(0);
        rivalMix.connect(rivalShaper);
        rivalShaper.connect(rivalFilter);
        rivalFilter.connect(rivalDuck);
        rivalDuck.connect(rivalGain);
        // StereoPanner липсва в стари WebKit — тогава направо в микса.
        const rivalPan = hasPanner ? ctx.createStereoPanner() : null;
        if (rivalPan) {
            rivalGain.connect(rivalPan);
            rivalPan.connect(mix);
        } else {
            rivalGain.connect(mix);
        }

        for (const src of sources) {
            src.start(t0);
        }

        // iOS: обаждане/Siri → 'interrupted'; при връщане в 'running' нивото
        // се прилага наново. Резюмиране при прекъсване, ако не сме спрени.
        ctx.onstatechange = () => {
            if (!ctx) {
                return;
            }
            if (ctx.state === 'running') {
                applyLevel(0.05);
            } else if (ctx.state === 'interrupted' && !stopped) {
                tryResume();
            }
        };

        nodes = {
            master,
            compressor,
            mix,
            driverMix,
            engineMix,
            engineGain,
            engineDuck,
            engineFilter,
            oscA,
            oscB,
            lumpLfo,
            lumpDepth,
            limiterDepth,
            overrunLfo,
            overrunDepth,
            burbleDepth,
            standGain,
            intakeFilter,
            intakeGain,
            kerbGain,
            kerbDepth,
            kerbLfo,
            gravelFilter,
            gravelGain,
            gravelAmDepth,
            runoffGain,
            windFilter,
            windGain,
            gustDepth,
            screechFilter,
            screechOctave,
            screechGain,
            scrubGain,
            lockGain,
            lockDepth,
            whineOsc,
            whineGain,
            rainGain,
            turbo,
            crowdGain,
            cheerGain,
            tunnelSend,
            bridgeSend,
            rivalA,
            rivalB,
            rivalFilter,
            rivalDuck,
            rivalGain,
            rivalPan,
            noiseBuffer,
            modelTone,
            modelLevel,
            broadcastFilter,
            broadcastGain,
            broadcastPan,
        };

        loadModel(ctx);
    };

    // ── Физически модел: асинхронно зареждане, отчети за натоварването ──────
    const dropModel = () => {
        modelFailed = true;
        if (model) {
            try {
                model.node.port.postMessage({ type: 'stop' });
                model.node.disconnect();
            } catch {
                // Контекстът вече е затворен.
            }
        }
        model = null;
    };

    const onModelMessage = (data) => {
        if (data?.type !== 'load' || !Number.isFinite(data.ratio)) {
            return;
        }
        modelLoadRatio = data.ratio;
        // Два поредни тежки отчета: телефонът не смогва и звукът ще пука —
        // осцилаторите са по-добри от накъсан модел.
        modelLoadStrikes = data.ratio > MODEL_MAX_LOAD ? modelLoadStrikes + 1 : 0;
        if (modelLoadStrikes >= 2) {
            dropModel();
        }
    };

    const loadModel = (context) => {
        if (
            workletUrl === null ||
            modelFailed ||
            !MODEL_ENABLED_FOR_ERA ||
            !context.audioWorklet ||
            typeof AudioWorkletNode !== 'function'
        ) {
            return;
        }
        let loading;
        try {
            loading = context.audioWorklet.addModule(workletUrl);
        } catch {
            // Синхронен отказ (невалиден адрес) не бива да спре целия звук.
            modelFailed = true;

            return;
        }
        loading
            .then(() => {
                if (ctx !== context || !nodes || model) {
                    return;
                }
                const node = new AudioWorkletNode(context, 'padok-engine', {
                    numberOfInputs: 0,
                    numberOfOutputs: 1,
                    outputChannelCount: [2],
                    processorOptions: { engine: ERA.model },
                });
                node.connect(nodes.modelTone);
                node.port.onmessage = (event) => onModelMessage(event.data);
                node.onprocessorerror = dropModel;
                const param = (name) => node.parameters.get(name);
                model = {
                    node,
                    rpm: param('rpm'),
                    load: param('load'),
                    exhaust: param('exhaust'),
                    intake: param('intake'),
                    mech: param('mech'),
                    limiter: param('limiter'),
                    mguk: param('mguk'),
                    width: param('width'),
                };
            })
            .catch(() => {
                // Без модул (мрежа, CSP, стар браузър) — остава осцилаторният глас.
                modelFailed = true;
            });
    };

    const modelLive = () => modelWanted && model !== null;

    /**
     * @param {'chase'|'onboard'|'broadcast'} kind
     * @param {number} t
     */
    const setModelMix = (kind, t) => {
        const mixSetting = MODEL_MIX[kind];
        setP(model.exhaust, mixSetting.exhaust, 0.15, t);
        setP(model.intake, mixSetting.intake, 0.15, t);
        setP(model.mech, mixSetting.mech, 0.15, t);
        setP(model.width, mixSetting.width, 0.15, t);
    };

    const ready = () => ctx !== null && nodes !== null && ctx.state === 'running';

    // Едно-shot помощници: тон и шумов взрив през микса (mute важи, тунелът
    // ги мокри). `when` е офсет в секунди — по часовника на контекста, не
    // setTimeout: не трепери под товар и не се губи при suspend.
    const oneShotTone = (type, freq, duration, peak, glideTo = null, when = 0) => {
        if (!ready()) {
            return;
        }
        const t = ctx.currentTime + Math.max(0, when);
        const node = ctx.createOscillator();
        node.type = type;
        node.frequency.setValueAtTime(freq, t);
        if (glideTo !== null) {
            node.frequency.exponentialRampToValueAtTime(Math.max(20, glideTo), t + duration);
        }
        const envelope = ctx.createGain();
        envelope.gain.setValueAtTime(0.0001, t);
        envelope.gain.exponentialRampToValueAtTime(peak, t + 0.012);
        envelope.gain.exponentialRampToValueAtTime(0.0001, t + duration);
        node.connect(envelope);
        envelope.connect(nodes.mix);
        node.start(t);
        node.stop(t + duration + 0.05);
        node.onended = () => {
            node.disconnect();
            envelope.disconnect();
        };
    };

    const noiseBurst = (filterFreq, filterType, duration, peak, when = 0, q = 1) => {
        if (!ready()) {
            return;
        }
        const t = ctx.currentTime + Math.max(0, when);
        const src = ctx.createBufferSource();
        // Преизползва общия шумов буфер от build() през нов източник.
        src.buffer = nodes.noiseBuffer;
        const filter = ctx.createBiquadFilter();
        filter.type = filterType;
        filter.frequency.value = filterFreq;
        filter.Q.value = q;
        const envelope = ctx.createGain();
        envelope.gain.setValueAtTime(peak, t);
        envelope.gain.exponentialRampToValueAtTime(0.0001, t + duration);
        src.connect(filter);
        filter.connect(envelope);
        envelope.connect(nodes.mix);
        src.start(t, Math.random() * (NOISE_SECONDS - 1));
        src.stop(t + duration + 0.05);
        src.onended = () => {
            src.disconnect();
            filter.disconnect();
            envelope.disconnect();
        };
    };

    /**
     * Срез на двигателя (ignition cut) върху даден duck възел — само
     * събитийната автоматизация, без per-frame презапис.
     *
     * @param {AudioParam} param
     * @param {number} t
     * @param {number} floor
     */
    const duckCut = (param, t, floor) => {
        holdParam(param, t);
        param.linearRampToValueAtTime(floor, t + 0.018);
        param.setTargetAtTime(1, t + 0.07, 0.03);
    };

    /**
     * Blip при сваляне: кратко „излайване" над базата (газта се повдига сама).
     *
     * @param {AudioParam} param
     * @param {number} t
     */
    const duckBlip = (param, t) => {
        holdParam(param, t);
        param.linearRampToValueAtTime(1.5, t + 0.03);
        param.setTargetAtTime(1, t + 0.09, 0.04);
    };

    /**
     * Крайпътен/съпернически канал — общото ядро на updateRival и
     * updateBroadcast.
     *
     * @param {number} distance
     * @param {number} speed
     * @param {number} pan
     * @param {number} closing
     * @param {number|undefined} rpm
     * @param {number} shift
     * @param {number} range
     * @param {number} dopplerGain
     * @param {number} maxLevel
     * @param {number} cutoffSpan
     */
    const driveRival = (distance, speed, pan, closing, rpm, shift, range, dopplerGain, maxLevel, cutoffSpan) => {
        const t = ctx.currentTime;
        const audible = Number.isFinite(distance) && distance < range;
        const proximity = audible ? Math.max(0, 1 - distance / range) ** 2 : 0;

        // Без подадени обороти: псевдо-обороти от скоростта (без смени).
        // Доплерът е преувеличен — физически точният (±v/340) е почти нечут.
        const effectiveRpm = rpm ?? 5000 + Math.min(1, speed / 92) * 9500;
        const doppler = 1 + clamp((dopplerGain * closing) / 340, -0.3, 0.3);
        const fundamental = Math.max(20, ((effectiveRpm * ERA.rpmScale) / 60) * ERA.firingsPerRev * 0.5 * doppler);
        setP(nodes.rivalA.frequency, fundamental, 0.04, t);
        setP(nodes.rivalB.frequency, fundamental, 0.04, t);
        setP(nodes.rivalFilter.frequency, 900 + cutoffSpan * proximity, 0.06, t);
        setP(nodes.rivalGain.gain, proximity * maxLevel, 0.06, t);
        if (nodes.rivalPan) {
            setP(nodes.rivalPan.pan, clamp(pan, -1, 1), 0.06, t);
        }
        if (shift > 0) {
            duckCut(nodes.rivalDuck.gain, t, 0.05);
        } else if (shift < 0) {
            duckBlip(nodes.rivalDuck.gain, t);
        }
    };

    /**
     * Осцилаторният глас на двигателя (резерв и A/B): PeriodicWave двойка,
     * буцест празен ход, лимитер/burble AM, всмукване. Вика се от update(),
     * когато физическият модел не свири.
     */
    const updateOscillatorEngine = (n, t, firing, revRatio, throttle, rpm, onboard, limiterOn) => {
        // Плавни преходи (20–40 ms) — без стъпаловидно „циклене".
        setP(n.oscA.frequency, firing / 2, 0.02, t);
        setP(n.oscB.frequency, firing / 2, 0.02, t);
        const detuneDip = limiterOn ? -18 : 0;
        setP(n.oscA.detune, -6 + detuneDip, 0.01, t);
        setP(n.oscB.detune, 6 + detuneDip, 0.01, t);
        setP(n.lumpLfo.frequency, Math.max(5, firing / 10), 0.05, t);
        setP(n.lumpDepth.gain, (1 - revRatio) ** 2 * 0.1, 0.05, t);

        // Филтърът се отваря с газта и оборотите — „ръмжене" на пълна газ,
        // приглушено пърпорене на подаване. Onboard: +600 Hz (в каската
        // си); chase: таван 5.5 kHz (въздухът яде високото).
        const baseCutoff = 500 + revRatio * 3800 + throttle * 1600;
        const cutoff = onboard ? Math.min(7000, baseCutoff + 600) : Math.min(5500, baseCutoff);
        setP(n.engineFilter.frequency, cutoff, 0.04, t);
        setP(n.engineGain.gain, 0.14 + throttle * 0.36 + revRatio * 0.12, 0.05, t);

        // Лимитер (ръчна, опрян таван с газ): 27 Hz срез, разстройка надолу и
        // пукот на всеки ~110 ms по часовника на контекста.
        setP(n.limiterDepth.gain, limiterOn ? 0.19 : 0, 0.01, t);
        if (limiterOn) {
            if (nextCrackAt < t) {
                nextCrackAt = t;
            }
            let scheduled = 0;
            while (nextCrackAt < t + 0.03 && scheduled < 3) {
                noiseBurst(1200, 'bandpass', 0.025, 0.22, nextCrackAt - t, 2);
                nextCrackAt += LIMITER_CRACK_EVERY;
                scheduled++;
            }
        } else {
            nextCrackAt = 0;
        }

        // Burble: затворена газ на високи обороти = тихо къркорене.
        setP(n.burbleDepth.gain, throttle < 0.05 && rpm > 8000 ? 0.06 : 0, 0.05, t);

        setP(n.intakeFilter.frequency, 900 + revRatio * 2400, 0.05, t);
        setP(n.intakeGain.gain, (0.02 + throttle * 0.09) * (onboard ? 1.5 : 1), 0.05, t);
    };

    /**
     * Стържене в стена: метален шум + звън, по силата; не по-често от
     * веднъж на 60 ms (стената дава контакт на всеки тик).
     *
     * @param {number} level 0..1
     */
    const wallScrape = (level) => {
        if (!ready() || !(level > 0)) {
            return;
        }
        const t = ctx.currentTime;
        if (t - lastScrapeAt < 0.06) {
            return;
        }
        lastScrapeAt = t;
        const strength = clamp01(level);
        noiseBurst(2500, 'highpass', 0.12 + 0.2 * strength, 0.15 * strength, 0, 0.7);
        noiseBurst(3000, 'bandpass', 0.1, 0.12 * strength, 0, 1.2);
        oneShotTone('square', 1400, 0.12, 0.05 * strength, 900);
        const duck = nodes.engineDuck.gain;
        holdParam(duck, t);
        duck.linearRampToValueAtTime(1 - 0.3 * strength, t + 0.01);
        duck.setTargetAtTime(1, t + 0.04, 0.05);
    };

    return {
        start() {
            // Преди build/resume: типът на сесията важи за звука, пуснат след него.
            if (!muted) {
                requestAudioSession('playback');
            }
            if (!ctx) {
                try {
                    build();
                } catch {
                    // Без Web Audio (стар браузър/политика) — играта работи тихо.
                    ctx = null;
                    nodes = null;
                    return;
                }
            }
            // Отменя висящ suspend от предишен stop() — виж suspendTimer.
            if (suspendTimer !== null) {
                clearTimeout(suspendTimer);
                suspendTimer = null;
            }
            stopped = false;
            lastResumeTry = 0;
            tryResume();
            applyLevel(0.2);
        },

        stop() {
            stopSound();
        },

        setMuted(value) {
            muted = value;
            requestAudioSession(value || stopped ? 'auto' : 'playback');
            writeMuted(value);
            // Спряно състояние остава тихо и при unmute — предпочитанието е
            // записано, силата идва при следващия start().
            applyLevel(0.05);
        },

        muted() {
            return muted;
        },

        /**
         * Сила 0..1 (умножава MASTER_VOLUME), запазва се между сесиите.
         *
         * @param {number} value
         */
        setVolume(value) {
            volume = clamp01(Number.isFinite(value) ? value : 1);
            writeVolume(volume);
            applyLevel(0.05);
        },

        volume() {
            return volume;
        },

        /**
         * Дъжд 0..1 — пръски, растящи със скоростта. Алтернатива: extras.wet.
         *
         * @param {number} level
         */
        setRain(level) {
            rainLevel = clamp01(level ?? 0);
        },

        /**
         * ТВ картина (реплей): миксът на пилота пада, крайпътният канал
         * (updateBroadcast) поема. Без контекст (attract) само се помни.
         *
         * @param {boolean} on
         */
        setBroadcast(on) {
            const next = Boolean(on);
            if (next === broadcast) {
                return;
            }
            broadcast = next;
            if (!ctx || !nodes) {
                return;
            }
            const t = ctx.currentTime;
            setP(nodes.driverMix.gain, broadcast ? 0 : 1, 0.25, t);
            if (broadcast) {
                // Реплеят тръгва и след финал, когато stop() вече е свалил
                // мастера: събуждаме контекста като start(), но помним, за да
                // върнем тишината при излизане (Game решава дали да start()-не).
                stoppedBeforeBroadcast = stopped;
                if (suspendTimer !== null) {
                    clearTimeout(suspendTimer);
                    suspendTimer = null;
                }
                stopped = false;
                lastResumeTry = 0;
                tryResume();
                applyLevel(0.2);
                // Кадровите send-ове (тунел, мост) иначе замръзват на
                // стойността от последния жив кадър — update() не тече тук.
                setP(nodes.tunnelSend.gain, 0, 0.12, t);
                setP(nodes.bridgeSend.gain, 0, 0.05, t);
                bridgeUntil = 0;
                // Лек фонов жагор в ТВ картината.
                setP(nodes.crowdGain.gain, 0.05, 0.4, t);
            } else {
                // Каналът не бива да остане на нивото на последния fly-by.
                setP(nodes.rivalGain.gain, 0, 0.05, t);
                setP(nodes.broadcastGain.gain, 0, 0.05, t);
                if (stoppedBeforeBroadcast) {
                    stoppedBeforeBroadcast = false;
                    stopSound();
                }
            }
        },

        broadcasting() {
            return broadcast;
        },

        /**
         * Кадър на пилота. `rpm` е drivetrain.visualRpm (blip/задържане/лимитер
         * идват оттам), `throttle` 0..1. Нищо тук не пише в sim.
         *
         * @param {number} rpm
         * @param {number} throttle
         * @param {SoundExtras} extras
         */
        update(rpm, throttle, extras) {
            if (!ctx || !nodes) {
                return;
            }
            if (ctx.state !== 'running') {
                if (ctx.state === 'interrupted' && !stopped) {
                    tryResume();
                }
                return;
            }

            const t = ctx.currentTime;
            const n = nodes;
            const speed = extras.speed ?? 0;
            const onboard = extras.cameraMode === 'onboard' || extras.onboard === true;
            // ТВ кадър през extras: миксът на пилота пада като при setBroadcast,
            // но каналът остава на updateRival (не е реплей от ТВ пост).
            if (!broadcast) {
                setP(n.driverMix.gain, extras.replay === true ? 0 : 1, 0.25, t);
            }
            const slip = extras.slip ?? 0;
            const brake = extras.brake ?? 0;
            const limiterOn = extras.limiter === true;
            // Стъпка по часовника на контекста — за турбо инерцията.
            const audioDt = lastUpdateAt > 0 ? Math.min(0.1, t - lastUpdateAt) : 1 / 60;
            lastUpdateAt = t;

            // Буксуване: от sim (out.spin) или груб proxy — пълна газ, бавно и
            // накъсана задница = мощностен занос. Вдига оборотите за ухото.
            let spin = extras.spin;
            if (spin === undefined) {
                spin = throttle > 0.9 && speed < 25 && slip > 0.2 ? (1 - speed / 25) * clamp01((slip - 0.2) / 0.4) : 0;
            }
            spin = clamp01(spin);
            const audioRpm = rpm + spin * 2000;
            const revRatio = clamp01(audioRpm / SHIFT_RPM);
            const firing = Math.max(40, ((audioRpm * ERA.rpmScale) / 60) * ERA.firingsPerRev);

            // ── Двигател: физическият модел, ако е зареден ──
            // Същите обороти и газ; срязването в лимитера, пукотите и blip-овете
            // са вътре в модела, затова осцилаторните AM слоеве мълчат.
            if (modelLive()) {
                setP(model.rpm, audioRpm * ERA.rpmScale, 0.02, t);
                // Хибридът зарежда при спиране: ДВС на товар, MGU-K като генератор.
                if (ERA.turbo) {
                    hybridEngineDemand(harvestState, throttle, brake, speed, audioDt, demand, harvestLoad);
                } else {
                    demand.load = clamp01(throttle);
                    demand.mguk = 0;
                }
                setP(model.load, demand.load, 0.02, t);
                setP(model.mguk, demand.mguk, 0.05, t);
                setP(model.limiter, limiterOn ? 1 : 0, 0.005, t);
                setModelMix(onboard ? 'onboard' : 'chase', t);
                setP(n.modelTone.frequency, onboard ? MODEL_TONE_ONBOARD : MODEL_TONE_CHASE, 0.15, t);
                setP(n.modelLevel.gain, MODEL_LEVEL, 0.08, t);
                setP(n.engineGain.gain, 0, 0.08, t);
                setP(n.lumpDepth.gain, 0, 0.05, t);
                setP(n.limiterDepth.gain, 0, 0.01, t);
                setP(n.burbleDepth.gain, 0, 0.05, t);
                setP(n.intakeGain.gain, 0, 0.05, t);
                nextCrackAt = 0;
            } else {
                setP(n.modelLevel.gain, 0, 0.08, t);
                updateOscillatorEngine(n, t, firing, revRatio, throttle, rpm, onboard, limiterOn);
            }

            // ── Повърхности ──
            // Базата и дълбочината са равни → гейнът се люлее 0..0.32
            // (униполярна AM). Само LFO върху нулева база би обръщал знака на
            // шума — нечуто; истинското „тракане" иска включване/изключване.
            const kerbLevel = extras.kerb ? 0.16 : 0;
            setP(n.kerbGain.gain, kerbLevel, 0.015, t);
            setP(n.kerbDepth.gain, kerbLevel, 0.015, t);
            setP(n.kerbLfo.frequency, clamp(speed / KERB_PERIOD, 10, 170), 0.05, t);

            const gravelLevel = extras.gravel ? 0.22 : extras.grass ? 0.11 : 0;
            setP(n.gravelFilter.frequency, extras.grass ? 400 : 240, 0.05, t);
            setP(n.gravelGain.gain, gravelLevel, 0.04, t);
            // Шумът след 12 Hz lowpass е ~0.014 RMS → ×35 дава люлеене ≈ ±0.5
            // от нивото; отрицателните върхове само обръщат знака (нечуто).
            setP(n.gravelAmDepth.gain, gravelLevel * 35, 0.04, t);

            setP(n.runoffGain.gain, extras.runoff ? 0.06 * Math.min(1, speed / 30) : 0, 0.05, t);

            // ── Вятър / кутия ──
            const windBase = Math.min(1, (speed / 92) ** 2) * 0.1 * (onboard ? 1.9 : 0.6);
            setP(n.windFilter.frequency, onboard ? 600 + speed * 14 : 750, 0.1, t);
            setP(n.windGain.gain, windBase * 1.35, 0.1, t);
            setP(n.gustDepth.gain, windBase * 0.35, 0.1, t);

            // Задният ход е с прави зъби (без синхрон) — единственото свирене
            // на кутията, което пилотът наистина чува: по-високо и по-силно
            // при ниска скорост. Напред — едва доловим триъгълник по скоростта.
            const speedRatio = Math.min(1, speed / 92);
            const reverse = extras.gear === 0;
            setP(n.whineOsc.frequency, Math.max(20, speed * (reverse ? 60 : 22)), 0.03, t);
            const whineLevel = reverse
                ? 0.03 * Math.min(1, speed / 8)
                : 0.015 * speedRatio ** 1.5;
            setP(n.whineGain.gain, whineLevel * (onboard ? 1.8 : 1), 0.05, t);

            setP(n.rainGain.gain, clamp01(extras.wet ?? rainLevel) * (0.02 + 0.05 * Math.min(1, speed / 40)), 0.1, t);

            // ── Гуми ──
            // Свистене: расте със страничното плъзгане; по-високо и по-остро
            // при по-силно плъзгане и скорост. Чуваш лимита ПРЕДИ чакъла.
            const slipLevel = clamp01((slip - 0.22) / 0.5);
            const speedFactor = Math.min(1, speed / 22);
            const screechFreq = 1900 + slipLevel * 1100 + Math.min(speed, 60) * 6;
            setP(n.screechFilter.frequency, screechFreq, 0.03, t);
            setP(n.screechFilter.Q, 5 + 6 * slipLevel, 0.03, t);
            setP(n.screechOctave.frequency, screechFreq * 2, 0.03, t);
            setP(n.screechGain.gain, Math.min(0.4, slipLevel * 0.32 * speedFactor), 0.03, t);

            // Подзавиване от реалните сигнали (sim out): предни наситени, задни не.
            const satF = extras.satF;
            const understeer =
                satF === undefined ? 0 : clamp01((satF - 0.9) * 10) * clamp01((0.95 - (extras.satR ?? 0)) * 5);
            setP(n.scrubGain.gain, understeer * 0.12 * speedFactor, 0.04, t);

            // Блокиране: sim out.lockF/lockR, а преди v3 — евристиката на
            // следите (спирачка + начално плъзгане). Буксуването е с половин AM.
            let lock;
            if (extras.lockF !== undefined || extras.lockR !== undefined) {
                lock = Math.max(clamp01(extras.lockF ?? 0), clamp01(extras.lockR ?? 0) * 0.7);
            } else {
                lock = brake > 0.7 && slip > 0.12 ? 0.6 : 0;
            }
            const lockLevel = (lock * 0.3 + spin * 0.15) * Math.min(1, speed / 12);
            setP(n.lockGain.gain, lockLevel, 0.03, t);
            setP(n.lockDepth.gain, lock > spin ? 0.5 : 0.25, 0.03, t);

            // ── Свят ──
            const crowd = clamp01(extras.crowd ?? 0);
            setP(n.crowdGain.gain, crowd * 0.11, 0.2, t);
            setP(n.standGain.gain, crowd * 0.22, 0.2, t);

            // Тунелът (Монако): мокър send към риверба само вътре.
            setP(n.tunnelSend.gain, extras.tunnel ? 0.9 : 0, 0.12, t);

            // Мостът: slapback за 0.4 s след преминаване (прозорецът на Game е
            // няколко метра — ехото трябва да го надживее).
            if (extras.bridge) {
                bridgeUntil = t + 0.4;
            }
            setP(n.bridgeSend.gain, t < bridgeUntil ? 0.5 : 0, 0.05, t);

            // Стена: стържене по силата на удара (ограничено в wallScrape).
            const wallHit = extras.wallHit;
            if (wallHit && wallHit.impulse > 0) {
                wallScrape(Math.min(1, wallHit.impulse / 10));
            }

            // ── Хибрид: турбо инерция, wastegate при отпускане, harvest при спиране ──
            // Моделът има собствени турбо, wastegate и MGU-K — осцилаторните
            // слоеве свирят само с осцилаторния двигател.
            if (n.turbo && modelLive()) {
                n.turbo.boost.offset?.setTargetAtTime(0, t, 0.1);
                setP(n.turbo.harvestGain.gain, 0, 0.05, t);
                boostEstimate = 0;
            } else if (n.turbo) {
                const boostTarget = throttle * revRatio;
                const tau = throttle > 0 ? 0.35 : 0.6;
                n.turbo.boost.offset?.setTargetAtTime(boostTarget, t, tau);
                boostEstimate += (boostTarget - boostEstimate) * (1 - Math.exp(-audioDt / tau));
                if (prevThrottle > 0.6 && throttle < 0.1 && boostEstimate > 0.5) {
                    noiseBurst(2600, 'bandpass', 0.22, 0.1, 0, 1.5);
                    oneShotTone('sine', 3200, 0.25, 0.04, 900);
                }
                setP(n.turbo.harvestOsc.frequency, 2400 + speed * 30, 0.05, t);
                setP(n.turbo.harvestGain.gain, brake > 0.3 && speed > 5 ? 0.02 * brake : 0, 0.05, t);
            }

            prevThrottle = throttle;
        },

        /**
         * Смяна на предавка: при качване — ignition-cut „крак" (срез на
         * duck възела + метален щрак); при сваляне — blip (височината идва от
         * drivetrain.visualRpm, тук е само „лайването" на газта + всмукване).
         *
         * @param {1|-1} direction
         */
        shift(direction) {
            if (!ready()) {
                return;
            }
            const t = ctx.currentTime;
            if (modelLive()) {
                // Моделът срязва запалването сам: тръбите доехтяват, а
                // несгорялото гориво пука при повторното палене. Отвън остава
                // само металното щракане на зъбите на кутията.
                if (direction > 0) {
                    model.node.port.postMessage({ type: 'cut', at: t, duration: MODEL_CUT_SECONDS });
                    noiseBurst(2600, 'bandpass', 0.04, 0.12, 0, 2);
                } else {
                    model.node.port.postMessage({ type: 'blip', at: t, duration: MODEL_BLIP_SECONDS });
                    noiseBurst(2200, 'bandpass', 0.04, 0.08, 0, 2);
                }

                return;
            }
            if (direction > 0) {
                duckCut(nodes.engineDuck.gain, t, 0.02);
                noiseBurst(1900, 'bandpass', 0.07, 0.5);
            } else {
                duckBlip(nodes.engineDuck.gain, t);
                noiseBurst(1400, 'bandpass', 0.08, 0.25, 0, 0.8);
            }
        },

        /**
         * Отпускане на газта на високи обороти: 2–5 пукота (lowpass шум
         * 420–700 Hz) в рамките на 0.5 s + накъсване 8–16 Hz на двигателя за
         * 0.6 s. Връща офсетите на пукотите (секунди от сега), за да мигне
         * пламъкът в СЪЩИТЕ моменти.
         *
         * @param {number} revRatio 0..1
         * @returns {number[]} офсети в секунди (възходящи); празен без контекст
         */
        overrun(revRatio) {
            if (!ready()) {
                return [];
            }
            const t = ctx.currentTime;
            const count = clamp(2 + Math.floor(clamp01(revRatio) * 3), 2, 5);
            const offsets = [];
            let at = 0.02 + Math.random() * 0.05;
            for (let i = 0; i < count && at < 0.5; i++) {
                offsets.push(at);
                at += 0.06 + Math.random() * 0.08;
            }

            // Моделът пали горивото в колектора — пукотът излиза през
            // тръбите с техния тембър; пламъкът на Game мига в същите моменти.
            if (modelLive()) {
                model.node.port.postMessage({ type: 'pops', times: offsets.map((offset) => t + offset), strength: 1 });

                return offsets;
            }

            for (const offset of offsets) {
                noiseBurst(420 + Math.random() * 280, 'lowpass', 0.03 + Math.random() * 0.03, 0.25 + Math.random() * 0.15, offset, 0.9);
            }

            nodes.overrunLfo.frequency.setValueAtTime(8 + Math.random() * 8, t);
            const depth = nodes.overrunDepth.gain;
            holdParam(depth, t);
            depth.linearRampToValueAtTime(0.175, t + 0.02);
            depth.setValueAtTime(0.175, t + 0.45);
            depth.setTargetAtTime(0, t + 0.45, 0.06);

            return offsets;
        },

        /**
         * Бийп на стартовите светлини (по-висок и дълъг при гасенето).
         *
         * @param {number} freq
         * @param {number} [duration]
         */
        /**
         * Декодира гласов клип в контекста на играта. null без Web Audio или
         * при повреден файл — радиото тогава остава само текстово.
         *
         * @param {ArrayBuffer} data
         * @returns {Promise<AudioBuffer|null>}
         */
        async decodeClip(data) {
            if (!ctx) {
                return null;
            }
            try {
                return await ctx.decodeAudioData(data);
            } catch {
                return null;
            }
        },

        /**
         * Гласов клип „по радиото": тесен честотен диапазон като на
         * отборното радио, леко изкривяване, пращене преди и след и приглушен
         * двигател отдолу. Минава през микса, така че mute и силата важат.
         * Резолва се, когато клипът свърши (веднага, ако звукът е спрян).
         *
         * @param {AudioBuffer} buffer
         * @returns {Promise<void>}
         */
        playRadio(buffer) {
            if (!ready() || !buffer) {
                return Promise.resolve();
            }

            const start = ctx.currentTime + RADIO_SQUELCH_LEAD;
            const end = start + buffer.duration;

            noiseBurst(2600, 'bandpass', 0.09, 0.05, 0, 0.9);
            noiseBurst(2600, 'bandpass', 0.07, 0.04, end - ctx.currentTime + 0.02, 0.9);

            const source = ctx.createBufferSource();
            source.buffer = buffer;
            const highpass = ctx.createBiquadFilter();
            highpass.type = 'highpass';
            highpass.frequency.value = 380;
            const lowpass = ctx.createBiquadFilter();
            lowpass.type = 'lowpass';
            lowpass.frequency.value = 3200;
            const shaper = ctx.createWaveShaper();
            shaper.curve = radioCurve();
            const level = ctx.createGain();
            level.gain.value = RADIO_LEVEL;

            source.connect(highpass);
            highpass.connect(lowpass);
            lowpass.connect(shaper);
            shaper.connect(level);
            level.connect(nodes.mix);

            // Двигателят отстъпва на гласа, после се връща.
            const duck = nodes.engineDuck.gain;
            holdParam(duck, ctx.currentTime);
            duck.linearRampToValueAtTime(RADIO_ENGINE_DUCK, start);
            duck.setTargetAtTime(1, end, 0.12);

            source.start(start);

            return new Promise((resolve) => {
                source.onended = () => {
                    source.disconnect();
                    highpass.disconnect();
                    lowpass.disconnect();
                    shaper.disconnect();
                    level.disconnect();
                    resolve();
                };
            });
        },

        beep(freq, duration = 0.09) {
            oneShotTone('square', freq, duration, 0.12);
        },

        /**
         * Удар между коли: тъп нискочестотен взрив + кратко „хлътване" на
         * двигателя, мащабирано по силата.
         *
         * @param {number} strength 0..1
         */
        impact(strength) {
            if (!ready()) {
                return;
            }
            noiseBurst(230, 'lowpass', 0.16, 0.35 + strength * 0.5);
            oneShotTone('sine', 95, 0.14, 0.3 + strength * 0.3, 48);

            const t = ctx.currentTime;
            const duck = nodes.engineDuck.gain;
            holdParam(duck, t);
            duck.linearRampToValueAtTime(0.4, t + 0.01);
            duck.setTargetAtTime(1, t + 0.05, 0.05);
        },

        /** Виж wallScrape в затварянето — достъпен и от update(). */
        wallScrape,

        /**
         * Подиумен джингъл: мажорно арпеджио за П1-П3, неутрално за назад.
         * Нотите са по часовника на контекста — не се губят при suspend.
         *
         * @param {number} position
         */
        fanfare(position) {
            const notes = position <= 3
                ? [523.25, 659.25, 783.99, 1046.5] // C-E-G-C
                : [440, 554.37]; // кратко и неутрално
            notes.forEach((freq, i) => {
                oneShotTone('triangle', freq, 0.32, 0.16, null, i * 0.14);
            });
        },

        /** Камбанка за нов личен рекорд: два възходящи чисти тона. */
        recordChime() {
            oneShotTone('sine', 880, 0.22, 0.14);
            oneShotTone('sine', 1174.66, 0.3, 0.14, null, 0.13);
        },

        /**
         * Възглас на трибуните (рекорд, финал, гасене на светлините):
         * надигане на жагора + клаксони, чуваеми навсякъде по пистата.
         *
         * @param {number} [strength] 0..1
         */
        cheer(strength = 1) {
            if (!ready()) {
                return;
            }
            const s = clamp01(strength);
            const t = ctx.currentTime;
            const swell = nodes.cheerGain.gain;
            holdParam(swell, t);
            swell.linearRampToValueAtTime(0.16 * s, t + 0.25);
            swell.setValueAtTime(0.16 * s, t + 1.4);
            swell.setTargetAtTime(0, t + 1.4, 0.6);
            for (const [when, freq] of [
                [0.15, 370],
                [0.5, 415],
                [0.9, 349],
            ]) {
                oneShotTone('sawtooth', freq, 0.45, 0.04 * s, freq * 0.97, when);
            }
        },

        /**
         * Най-близкият съперник: сила по разстоянието, тон по оборотите му
         * (или по скоростта, ако няма трансмисия), панорама според страната,
         * Доплер по радиалната скорост. Извън обхват → тишина. В ТВ режим
         * каналът е на updateBroadcast и това е no-op.
         *
         * @param {number} distance Метри до най-близката друга кола (Infinity = няма)
         * @param {number} speed Нейната скорост, m/s
         * @param {number} pan [-1, 1] — отляво/отдясно на камерата
         * @param {number} [closing] Скорост на сближаване, m/s (+ = приближава)
         * @param {number} [rpm] Оборотите ѝ (opp.drivetrain.visualRpm)
         * @param {number} [shift] +1/−1 в кадъра на смяна на предавка, иначе 0
         */
        updateRival(distance, speed, pan, closing = 0, rpm = undefined, shift = 0) {
            if (!ready() || broadcast) {
                return;
            }
            driveRival(distance, speed, pan, closing, rpm, shift, RIVAL_RANGE, 3, 0.22, 2200);
        },

        /**
         * Крайпътен fly-by в ТВ картината: разстояние до ТВ поста, скорост от
         * кадрите, панорама спрямо камерата, Доплер ×2, lowpass по
         * разстоянието (900 + 6000·(1−d/200)² Hz).
         *
         * @param {number} distance Метри от ТВ поста до колата
         * @param {number} speed m/s (от разликата на кадрите)
         * @param {number} pan [-1, 1]
         * @param {number} [closing] m/s (+ = приближава към поста)
         * @param {number} [rpm] Обороти от scratch трансмисията на реплея
         * @param {number} [shift] +1/−1 при смяна на предавка в реплея
         */
        updateBroadcast(distance, speed, pan, closing = 0, rpm = undefined, shift = 0) {
            if (!ready() || !broadcast) {
                return;
            }
            if (!modelLive()) {
                driveRival(distance, speed, pan, closing, rpm, shift, BROADCAST_RANGE, 2, 0.5, 6000);

                return;
            }

            // Истинският двигател и в ТВ картината: Доплерът мести оборотите
            // (височината на модела следва тях), разстоянието — lowpass и сила.
            const t = ctx.currentTime;
            const audible = Number.isFinite(distance) && distance < BROADCAST_RANGE;
            const proximity = audible ? Math.max(0, 1 - distance / BROADCAST_RANGE) ** 2 : 0;
            const effectiveRpm = rpm ?? 5000 + Math.min(1, speed / 92) * 9500;
            const doppler = 1 + clamp((2 * closing) / 340, -0.3, 0.3);
            // Реплеят не носи газта: растящи обороти = пълна газ, падащи без
            // смяна = спиране (хибридът зарежда на товар, V10 е отпуснат).
            const rising = effectiveRpm - broadcastRpm;
            const brakingLoad = ERA.turbo ? harvestLoad : 0;
            const loadGoal = shift !== 0 ? broadcastLoad : rising > 15 ? 1 : rising < -40 ? brakingLoad : broadcastLoad;
            broadcastLoad += (loadGoal - broadcastLoad) * 0.3;
            broadcastRpm = effectiveRpm;

            setP(model.rpm, effectiveRpm * ERA.rpmScale * doppler, 0.03, t);
            setP(model.load, broadcastLoad, 0.03, t);
            setP(model.mguk, ERA.turbo ? (loadGoal >= 1 ? 0.8 : loadGoal === brakingLoad ? -0.6 : 0) : 0, 0.08, t);
            setP(model.limiter, 0, 0.005, t);
            setModelMix('broadcast', t);
            setP(nodes.modelTone.frequency, MODEL_TONE_CHASE, 0.1, t);
            setP(nodes.broadcastFilter.frequency, 900 + 6000 * proximity, 0.06, t);
            setP(nodes.broadcastGain.gain, proximity * MODEL_LEVEL * 0.5, 0.06, t);
            if (nodes.broadcastPan) {
                setP(nodes.broadcastPan.pan, clamp(pan, -1, 1), 0.06, t);
            }
            setP(nodes.rivalGain.gain, 0, 0.05, t);
            if (shift > 0) {
                model.node.port.postMessage({ type: 'cut', at: t, duration: MODEL_CUT_SECONDS });
            } else if (shift < 0) {
                model.node.port.postMessage({ type: 'blip', at: t, duration: MODEL_BLIP_SECONDS });
            }
        },

        /**
         * Физическият модел срещу осцилаторния глас (A/B в лабораторията).
         * Изключеният модел остава зареден — връщането е мигновено.
         *
         * @param {boolean} enabled
         */
        setEngineModel(enabled) {
            modelWanted = Boolean(enabled) && MODEL_ENABLED_FOR_ERA;
        },

        /**
         * Състоянието на модела: свири ли и колко от аудио нишката ползва.
         *
         * @returns {{ active: boolean, failed: boolean, load: number }}
         */
        engineInfo() {
            return { active: modelLive(), failed: modelFailed, load: modelLoadRatio };
        },

        /**
         * Настройка на модела на живо (лабораторията) — ключовете на пресета
         * (engineWorklet.js V6_HYBRID_PRESET / V10_PRESET).
         *
         * @param {object} values
         */
        tuneEngine(values) {
            model?.node.port.postMessage({ type: 'tune', values });
        },

        /**
         * Товарът на ДВС при зареждане в спирачна зона (0 = отпуснат като до
         * 2025 г.). За сверяване на ухо в лабораторията.
         *
         * @param {number} value
         */
        setHarvestLoad(value) {
            harvestLoad = clamp01(Number.isFinite(value) ? value : HARVEST_LOAD);
        },

        dispose() {
            if (suspendTimer !== null) {
                clearTimeout(suspendTimer);
                suspendTimer = null;
            }
            if (model) {
                model.node.port.onmessage = null;
                model.node.port.postMessage({ type: 'stop' });
            }
            model = null;
            if (ctx) {
                ctx.onstatechange = null;
                ctx.close?.()?.catch?.(() => {});
            }
            ctx = null;
            nodes = null;
        },
    };
}
