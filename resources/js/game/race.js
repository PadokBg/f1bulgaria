/**
 * Чистата симулация на СЪСТЕЗАНИЕТО: играч + AI съперници + контакти между
 * колите + обиколки, наказания, режим за изпреварване, грешки на ботовете
 * и класиране. Без
 * three.js/DOM — същият код тича в браузъра (Game.js) и в Node
 * (scripts/game/validate-race.mjs).
 *
 * Състезанието е чиста функция от пистата и входа на играча: решетката е
 * фиксирана, параметрите и грешките на ботовете идват от PRNG, засят с
 * пистата, автопилотът е детерминиран, а контактите се решават в същата
 * фиксирана стъпка. Затова записът на входа от гасенето на светлините до
 * карирания флаг стига на сървъра да преиграе ЦЯЛОТО състезание. След флага
 * на играча колата му спира да влияе на полето — ботовете доизкарват
 * детерминирано и без повече вход, и сървърът знае окончателното класиране.
 *
 * Класацията е по общо време + RACE_PENALTY_MS за всяко наказание: излизане
 * от пистата или вина за удар.
 */

import { driveAutopilot, resetAutopilotDriver, speedPlanFor } from './autopilot.js';
import { resolveCarContacts } from './collisions.js';
import { CAR, FIXED_DT } from './physics.js';
import { hashString, mulberry32 } from './random.js';
import {
    FRAME_EVERY,
    SIM_VERSION,
    base64ToBytes,
    bytesToBase64,
    createSim,
    pushTraceInput,
    quantizeInput,
    readTraceInput,
} from './sim.js';

/** Версия на правилата (решетка, ботове, контакти, наказания, режим за
 *  изпреварване, финал). Вдига се при всяка промяна, с която същият вход дава
 *  друг резултат — сървърът отхвърля трейсове със стара версия, вместо да ги
 *  преиграе грешно. v2: DRS е заменен с режима за изпреварване от 2026 г. */
export const RACE_VERSION = 2;

/** Съперници на решетката. Влиза в трейса; сървърът приема само този брой. */
export const RACE_OPPONENTS = 5;

/** Дистанция на състезанието, обиколки (обиколка 1 тръгва от решетката). */
export const RACE_TOTAL_LAPS = 3;

/** Едно наказание (излизане или вина за удар), ms. */
export const RACE_PENALTY_MS = 5000;

/** Таван на записа: 20 минути. Прелее ли, записът пада и резултатът не се
 *  праща — отрязан трейс не може да се преиграе до финала. */
export const MAX_RACE_TICKS = Math.round((20 * 60) / FIXED_DT);

/** След флага на играча полето доизкарва най-много толкова, после се
 *  класира по изминатото (закъсал бот не държи подиума вечно). */
const MAX_TICKS_AFTER_FLAG = Math.round((3 * 60) / FIXED_DT);

const PENALTY_TICKS = Math.round(RACE_PENALTY_MS / 1000 / FIXED_DT);

const GRID_ROW_GAP = 7; // m между редовете на решетката
const GRID_FIRST_ROW = 6; // m от стартовата линия до първия ред
const GRID_LATERAL = 1.6; // m шахматно отместване от осевата линия

/** Слипстрийм: колата точно зад друга губи до този дял от съпротивлението.
 *  Без него еднакво бързите на права коли никога не се изпреварват там. */
const DRAFT_MAX = 0.35;
const DRAFT_RANGE = 45; // m зад колата отпред, линейно отслабва
const DRAFT_WIDTH = 2.2; // m странично разминаване, отвъд — чист въздух
const DRAFT_MIN_SPEED = 25; // m/s — под това аеродинамиката не се усеща

/**
 * Режим за изпреварване — правилата от 2026 г. вместо DRS. Засичането е на
 * линията (след финалния завой): до 1 s зад кола → още 0.5 MJ електрическа
 * енергия за започващата обиколка; неизползваното изгаря на следващата
 * линия. Колата я пуска сама на пълна газ в горната част на правите — там
 * MGU-K иначе намалява мощността. Автоматично, защото бутон би сменил
 * формата на записа за сървъра. Активната аеродинамика (отворени крила на
 * правите) е за всички и не дава относително предимство — не е механизъм.
 */
const OVERTAKE_ENERGY = 0.5e6 / 800; // J/kg: 0.5 MJ върху ~800 kg кола с пилот
const OVERTAKE_POWER = 350e3 / 800; // W/kg: пълната мощност на MGU-K
const OVERTAKE_MIN_SPEED = 55; // m/s (~200 km/h) — горната част на правата
const OVERTAKE_THROTTLE = 0.95;
const OVERTAKE_WINDOW_TICKS = Math.round(1 / FIXED_DT);
const OVERTAKE_FROM_LAP = 2; // обиколка 1 е бойна от решетката

/** Точки за хронометраж по обиколката — интервали в секунди. */
const TIMING_SPACING = 20; // m

/** Вина за удар: нос в задница със сближаване над ~17 km/h. */
const FAULT_IMPULSE = 3;
const FAULT_ALIGNMENT = 0.7; // ударът е пред нападателя (cos на ъгъла)
const FAULT_COOLDOWN_TICKS = Math.round(3 / FIXED_DT);

/** Грешки на ботовете: при влизане в спирачна зона — късно спиране. */
const MISTAKE_CHANCE = 0.02;
const MISTAKE_CHANCE_PRESSURE = 0.12;
const MISTAKE_PRESSURE_GAP = 15; // m до кола отпред или отзад
const MISTAKE_BRAKE_DROP = 8; // m/s планирано забавяне = спирачна зона
const MISTAKE_LOOKAHEAD = 0.6; // s напред по плана
const MISTAKE_MILD = 1.07; // изнася се, губи изхода
const MISTAKE_BIG = 1.14; // излиза от пистата
const MISTAKE_BIG_SHARE = 0.35;
const MISTAKE_TICKS = Math.round(2.5 / FIXED_DT);
const MISTAKE_START_GRACE = Math.round(5 / FIXED_DT); // хаосът на старта стига

/**
 * @typedef {object} RaceEntry Кола в състезанието (играчът или бот)
 * @property {import('./sim.js').Simulation} sim
 * @property {number|null} opponentIndex null = играчът
 * @property {number} laps
 * @property {number} lastProgress
 * @property {number|null} finishTick
 * @property {number} contactPenalties
 * @property {number|null} frozenPenalties Наказанията в момента на финала
 * @property {number|null} bestLapTicks Най-бърза валидна обиколка
 */

/**
 * @typedef {object} RaceResult Резултатът на играча при карирания флаг
 * @property {number} raceTicks  Стъпки от гасенето до флага
 * @property {number} raceMs     Чисто време
 * @property {number} penalties  Всички наказания
 * @property {number} trackLimits Излизания
 * @property {number} contactFaults Вина за удар
 * @property {number} totalMs    raceMs + наказанията — по него е класацията
 * @property {number} position   Временна позиция при флага
 */

/**
 * @typedef {object} ClassificationRow
 * @property {number|null} opponentIndex null = играчът
 * @property {boolean} finished
 * @property {number|null} totalMs Време + наказания (финиширалите)
 * @property {number} penalties
 * @property {number|null} bestLapMs
 * @property {boolean} fastestLap
 * @property {number} lapsDown Обиколки назад от лидера (нефиниширалите)
 */

/**
 * Създава полето около симулацията на играча и нарежда решетката. Ботовете
 * делят повърхностните таблици на играча (същата писта).
 *
 * @param {import('./sim.js').Simulation} player
 * @param {number} [count]
 */
export function createRace(player, count = RACE_OPPONENTS) {
    const track = player.track;
    // Детерминирано по пистата — една и съща решетка при всеки рестарт и на
    // сървъра. Редът на извикванията на rand() е част от RACE_VERSION.
    const rand = mulberry32(hashString(track.slug));
    const timingPoints = Math.max(8, Math.round(track.length / TIMING_SPACING));

    const opponents = [];
    for (let i = 0; i < count; i++) {
        const sim = createSim(track, player.circuit, player);
        // Обиколките на ботовете не интересуват никого — без запис.
        sim.recordEnabled = false;

        const entry = createEntry(sim, i, timingPoints);
        // Автопилотът чете темпото/линията/others директно от записа.
        // Темпото мащабира хватката на планировчика (PLANNER в autopilot.js):
        // 0.98 е на ръба на чистото каране, 0.90 е ~4% по-бавно на обиколка.
        entry.pace = 0.9 + rand() * 0.08;
        // Лична линия само на правите и само към средата (autopilot я гаси).
        entry.lineOffset = (rand() - 0.5) * 0.8;
        entry.input = { steer: 0, throttle: 0, brake: 0 };
        entry.mistakeFactor = 1;
        opponents.push(entry);
    }

    for (const opp of opponents) {
        opp.others = [player, ...opponents.filter((o) => o !== opp).map((o) => o.sim)];
    }

    const playerEntry = createEntry(player, null, timingPoints);
    const entries = [playerEntry, ...opponents];

    const race = {
        player,
        opponents,
        // Броячът на играча (Game.js го чете като playerRace).
        playerLaps: playerEntry,
        entries,
        entryByState: new Map(entries.map((entry) => [entry.sim.state, entry])),
        timingPoints,
        seed: hashString(`${track.slug}:mistakes`),
        mistakeRand: null,
        /** Стъпки от гасенето; спира при флага на играча (времето му). */
        ticks: 0,
        /** Стъпки от гасенето; продължава след флага (ботовете доизкарват). */
        clock: 0,
        result: null,
        classification: null,
        playerDetached: false,
        recording: true,
        recInputs: [],
        recordFrames: false,
        frames: [],
        // Колко слипстрийм има играчът в последния тик, 0..1 (за HUD-а).
        playerDraft: 0,
        // Събитията от последния тик (наказания, грешки, режим за изпреварване, финали).
        events: [],
        // Преизползвани обекти — нула алокации на тик.
        contactCars: [],
        contacts: [],
        quantized: { steer: 0, throttle: 0, brake: 0 },
        step: { playerEvent: null, finished: false, classified: false },
    };

    gridRace(race);

    return race;
}

function createEntry(sim, opponentIndex, timingPoints) {
    return {
        sim,
        opponentIndex,
        laps: 0,
        lastProgress: 0,
        finishTick: null,
        contactPenalties: 0,
        lastExcursions: 0,
        frozenPenalties: null,
        bestLapTicks: null,
        faultCooldown: 0,
        timingPoint: -1,
        passTicks: new Float64Array(timingPoints),
        linePassTick: -1,
        overtakeLap: 0,
        overtakeEnergy: 0,
        overtakeActive: false,
        crossedLine: false,
        brakingZone: false,
        mistakeTicks: 0,
    };
}

/**
 * Ново състезание: всички коли на решетката, неподвижни; играчът е последен.
 * Пилотите, обиколките, наказанията, грешките и записът тръгват от нула.
 *
 * @param {ReturnType<typeof createRace>} race
 */
export function gridRace(race) {
    const { player, opponents } = race;
    const track = player.track;

    opponents.forEach((opp, i) => {
        const slot = gridSlot(track, i);
        opp.sim.reset(false);
        placeOnSlot(opp.sim, slot);
        resetAutopilotDriver(opp.sim);
        opp.mistakeFactor = 1;
        opp.others = [player, ...opponents.filter((o) => o !== opp).map((o) => o.sim)];
    });

    // Записите (най-добра обиколка) не влияят на физиката — пазят се.
    player.reset(true);
    placeOnSlot(player, gridSlot(track, opponents.length));
    // Първото пресичане е потеглянето: обиколка 1 е бойна, хронометърът на
    // обиколките тръгва при следващото минаване на линията, на скорост.
    player.gridCrossingsToSkip = 1;
    player.snapRender = true;

    for (const entry of race.entries) {
        entry.laps = 0;
        entry.lastProgress = entry.sim.lastProgress;
        entry.finishTick = null;
        entry.contactPenalties = 0;
        entry.lastExcursions = 0;
        entry.frozenPenalties = null;
        entry.bestLapTicks = null;
        entry.faultCooldown = 0;
        entry.timingPoint = -1;
        entry.passTicks.fill(-1);
        entry.linePassTick = -1;
        entry.overtakeLap = entry.laps;
        entry.overtakeEnergy = 0;
        entry.overtakeActive = false;
        entry.brakingZone = false;
        entry.mistakeTicks = 0;
    }

    race.mistakeRand = mulberry32(race.seed);
    race.ticks = 0;
    race.clock = 0;
    race.result = null;
    race.classification = null;
    race.playerDetached = false;
    race.recording = true;
    race.recInputs = [];
    race.frames = [];
    race.playerDraft = 0;
    race.events.length = 0;
}

/**
 * Една фиксирана стъпка на цялото поле. Връща преизползван обект:
 * playerEvent = завършена хронометрирана обиколка на играча, finished =
 * карираният флаг на играча падна В ТАЗИ стъпка, classified = полето
 * доизкара и окончателното класиране е готово. race.events носи наказанията,
 * грешките, режима за изпреварване и финалите от стъпката.
 *
 * @param {ReturnType<typeof createRace>} race
 * @param {{steer: number, throttle: number, brake: number}} rawInput
 */
export function stepRace(race, rawInput) {
    const { player, opponents } = race;
    const step = race.step;
    const playerEntry = race.playerLaps;
    step.playerEvent = null;
    step.finished = false;
    step.classified = false;
    race.events.length = 0;
    race.clock++;

    const playerRacing = race.result === null;

    if (playerRacing && race.recording) {
        if (race.recInputs.length >= MAX_RACE_TICKS * 2) {
            race.recording = false;
            race.recInputs = [];
        } else {
            pushTraceInput(race.recInputs, quantizeInput(rawInput, race.quantized));
        }
    }

    const event = player.tick(rawInput);
    if (event?.type === 'finished') {
        // Веднага нова летяща обиколка — не през 'formation', иначе би се
        // хронометрирала само всяка втора.
        player.rearmFlyingLap();
        step.playerEvent = event;
        if (playerRacing) {
            noteLap(playerEntry, event);
        }
    }

    for (const opp of opponents) {
        updateMistake(race, opp);
        driveAutopilot(opp.sim, opp.input, opp);
        const oppEvent = opp.sim.tick(opp.input);
        if (oppEvent?.type === 'finished') {
            opp.sim.rearmFlyingLap();
            if (opp.finishTick === null) {
                noteLap(opp, oppEvent);
            }
        }
    }

    // Контактите: всички коли се блъскат. Кола в „Връщане на пистата" е
    // извадена, а играчът след флага вече не участва.
    const cars = race.contactCars;
    cars.length = 0;
    if (playerRacing && !player.recovering) {
        cars.push(player.state);
    }
    for (const opp of opponents) {
        if (!opp.sim.recovering) {
            cars.push(opp.sim.state);
        }
    }
    resolveCarContacts(cars, race.contacts);
    judgeContacts(race);

    for (const entry of race.entries) {
        if (entry.faultCooldown > 0) {
            entry.faultCooldown--;
        }
        trackWrap(entry, entry.sim.lastProgress);
        recordTiming(race, entry);
        noteExcursions(race, entry);
    }

    updateOvertake(race);
    applyAero(race);

    if (race.recordFrames && playerRacing && race.clock % FRAME_EVERY === 0) {
        race.frames.push(player.state.x, player.state.z, player.state.heading);
    }

    for (const opp of opponents) {
        if (opp.finishTick === null && opp.laps > RACE_TOTAL_LAPS) {
            finishEntry(race, opp);
        }
    }

    if (playerRacing) {
        race.ticks++;

        // Пресичане № RACE_TOTAL_LAPS+1 (първото е потеглянето) = флагът.
        if (playerEntry.laps > RACE_TOTAL_LAPS) {
            finishEntry(race, playerEntry);
            race.result = buildResult(race);
            detachPlayer(race);
            step.finished = true;
        }
    } else if (race.classification === null) {
        const everyoneFinished = opponents.every((opp) => opp.finishTick !== null);
        if (everyoneFinished || race.clock - playerEntry.finishTick > MAX_TICKS_AFTER_FLAG) {
            race.classification = classifyRace(race);
            race.result.finalPosition = race.classification.findIndex((row) => row.opponentIndex === null) + 1;
            step.classified = true;
        }
    }

    return step;
}

/**
 * Наказанията на играча дотук — за HUD-а.
 *
 * @param {ReturnType<typeof createRace>} race
 */
export function racePenalties(race) {
    return penaltiesOf(race.playerLaps);
}

/**
 * Класиране: финиширалите по време + наказания, останалите по изминатото.
 * Вика се и преди края (временно класиране на подиума).
 *
 * @param {ReturnType<typeof createRace>} race
 * @returns {ClassificationRow[]}
 */
export function classifyRace(race) {
    const rows = race.entries.map((entry) => {
        const penalties = penaltiesOf(entry);
        const finished = entry.finishTick !== null;

        return {
            entry,
            opponentIndex: entry.opponentIndex,
            finished,
            totalTicks: finished ? entry.finishTick + penalties * PENALTY_TICKS : null,
            covered: entry.laps + entry.lastProgress,
            penalties,
            bestLapTicks: entry.bestLapTicks,
        };
    });

    // Стабилно сортиране: при равенство играчът (първи в списъка) е отпред.
    rows.sort((a, b) => {
        if (a.finished !== b.finished) {
            return a.finished ? -1 : 1;
        }
        return a.finished ? a.totalTicks - b.totalTicks : b.covered - a.covered;
    });

    let fastest = null;
    for (const row of rows) {
        if (row.bestLapTicks !== null && (fastest === null || row.bestLapTicks < fastest)) {
            fastest = row.bestLapTicks;
        }
    }

    const toMs = (ticks) => Math.round(ticks * FIXED_DT * 1000);
    const leaderCovered = Math.max(...rows.map((row) => row.covered));

    return rows.map((row) => ({
        opponentIndex: row.opponentIndex,
        finished: row.finished,
        totalMs: row.totalTicks === null ? null : toMs(row.totalTicks),
        penalties: row.penalties,
        bestLapMs: row.bestLapTicks === null ? null : toMs(row.bestLapTicks),
        fastestLap: fastest !== null && row.bestLapTicks === fastest,
        lapsDown: row.finished ? 0 : Math.floor(leaderCovered - row.covered),
    }));
}

/**
 * Интервал между две коли в стъпки: колко по-късно `behind` е минала точката,
 * в която е сега, спрямо `ahead`. { lapped } ако е обиколка и повече назад.
 *
 * @param {ReturnType<typeof createRace>} race
 * @param {{laps: number, lastProgress: number, timingPoint: number}} behind
 * @param {{laps: number, lastProgress: number, passTicks: Float64Array}} ahead
 * @returns {{ticks: number|null, lapped: number}}
 */
export function raceGap(race, behind, ahead) {
    const lapped = Math.floor(ahead.laps + ahead.lastProgress - (behind.laps + behind.lastProgress));
    if (lapped >= 1) {
        return { ticks: null, lapped };
    }
    if (behind.timingPoint < 0) {
        return { ticks: null, lapped: 0 };
    }
    const passed = ahead.passTicks[behind.timingPoint];

    return { ticks: passed < 0 ? null : Math.max(0, race.clock - passed), lapped: 0 };
}

/**
 * Хронометражът за кола извън симулацията (задочният съперник в Game.js):
 * същите точки като полето, за да са интервалите сравними.
 *
 * @param {ReturnType<typeof createRace>} race
 * @param {{laps: number, lastProgress: number, timingPoint: number, passTicks: Float64Array}} entry
 * @param {number} tick
 */
export function recordTimingAt(race, entry, tick) {
    const point = Math.min(race.timingPoints - 1, Math.floor(entry.lastProgress * race.timingPoints));
    if (point !== entry.timingPoint) {
        entry.timingPoint = point;
        entry.passTicks[point] = tick;
    }
}

/**
 * Записът на състезанието за сървъра, или null, ако няма пълен запис
 * (не е финиширано или таванът е преливал).
 *
 * @param {ReturnType<typeof createRace>} race
 * @returns {string|null}
 */
export function encodeRaceTrace(race) {
    if (race.result === null || !race.recording || race.recInputs.length !== race.result.raceTicks * 2) {
        return null;
    }

    return JSON.stringify({
        v: SIM_VERSION,
        rv: RACE_VERSION,
        opponents: race.opponents.length,
        inputs: bytesToBase64(Uint8Array.from(race.recInputs)),
    });
}

/**
 * @param {string} encoded
 * @returns {{v: unknown, rv: unknown, opponents: unknown, inputs: Uint8Array}|null}
 */
export function decodeRaceTrace(encoded) {
    try {
        const raw = JSON.parse(encoded);
        if (typeof raw?.inputs !== 'string') {
            return null;
        }

        return { v: raw.v, rv: raw.rv, opponents: raw.opponents, inputs: base64ToBytes(raw.inputs) };
    } catch {
        return null;
    }
}

/**
 * Преиграва записан вход от решетката до флага, после оставя полето да
 * доизкара без вход (играчът вече не влияе) до окончателното класиране.
 *
 * @param {import('./sim.js').Simulation} player Прясна симулация на пистата
 * @param {{opponents: number, inputs: Uint8Array}} trace
 * @param {{frames?: boolean}} [options] frames: запиши кадрите на играча (дух)
 * @returns {{result: RaceResult|null, classification: ClassificationRow[]|null,
 *            consumedTicks: number, frames: Float32Array|null}}
 */
export function replayRace(player, trace, options = {}) {
    const race = createRace(player, trace.opponents);
    race.recording = false;
    race.recordFrames = options.frames === true;

    const input = { steer: 0, throttle: 0, brake: 0 };
    const ticks = Math.floor(trace.inputs.length / 2);
    let consumedTicks = 0;

    while (consumedTicks < ticks && race.result === null) {
        readTraceInput(trace.inputs, consumedTicks, input);
        stepRace(race, input);
        consumedTicks++;
    }

    if (race.result !== null) {
        const idle = { steer: 0, throttle: 0, brake: 0 };
        while (race.classification === null) {
            stepRace(race, idle);
        }
    }

    return {
        result: race.result,
        classification: race.classification,
        consumedTicks,
        frames: race.recordFrames && race.frames.length > 0 ? Float32Array.from(race.frames) : null,
    };
}

/**
 * Слот i на решетката (0 = най-отпред, до линията), шахматно ляво/дясно.
 *
 * @param {import('./track.js').Track} track
 * @param {number} i
 */
export function gridSlot(track, i) {
    const backMeters = GRID_FIRST_ROW + i * GRID_ROW_GAP;
    const back = Math.round(backMeters / track.spacing) % track.count;
    const index = (track.count - back) % track.count;
    const lateral = (i % 2 === 0 ? 1 : -1) * GRID_LATERAL;

    return {
        index,
        x: track.xs[index] + track.nx[index] * lateral,
        z: track.zs[index] + track.nz[index] * lateral,
        heading: Math.atan2(track.tx[index], track.tz[index]),
        progress: index / track.count,
        height: track.ys[index] - lateral * track.bankSlope[index],
    };
}

// ── Вътрешни ─────────────────────────────────────────────────────────────

function penaltiesOf(entry) {
    return entry.frozenPenalties ?? entry.sim.excursions + entry.contactPenalties;
}

function noteLap(entry, event) {
    if (event.valid && (entry.bestLapTicks === null || event.lapTicks < entry.bestLapTicks)) {
        entry.bestLapTicks = event.lapTicks;
    }
}

function finishEntry(race, entry) {
    entry.finishTick = race.clock;
    entry.frozenPenalties = entry.sim.excursions + entry.contactPenalties;
    entry.overtakeEnergy = 0;
    entry.overtakeActive = false;
    race.events.push({ type: 'finish', entry });
}

/** Играчът е финиширал: колата му спира да влияе на полето (ботове, аеро, удари). */
function detachPlayer(race) {
    race.playerDetached = true;
    for (const opp of race.opponents) {
        opp.others = opp.others.filter((sim) => sim !== race.player);
    }
}

function isRacing(race, entry) {
    return entry.finishTick === null && !(entry === race.playerLaps && race.playerDetached);
}

function noteExcursions(race, entry) {
    const excursions = entry.sim.excursions;
    if (excursions !== entry.lastExcursions) {
        entry.lastExcursions = excursions;
        if (isRacing(race, entry)) {
            race.events.push({ type: 'penalty', entry, reason: 'track' });
        }
    }
}

function recordTiming(race, entry) {
    recordTimingAt(race, entry, race.clock);
}

/**
 * Съдийство на ударите: нос в задница, пред нападателя, със сближаване над
 * прага → наказание за колата отзад. Страничните допири са състезание.
 */
function judgeContacts(race) {
    for (const contact of race.contacts) {
        if (contact.impulse < FAULT_IMPULSE || contact.aFront === contact.bFront) {
            continue;
        }

        // Нормалата сочи от A към B: ударът е пред A, ако е по посоката ѝ.
        const culprit = contact.aFront ? contact.a : contact.b;
        const towards = contact.aFront ? 1 : -1;
        const alignment =
            towards * (contact.nx * Math.sin(culprit.heading) + contact.nz * Math.cos(culprit.heading));
        if (alignment < FAULT_ALIGNMENT) {
            continue;
        }

        const entry = race.entryByState.get(culprit);
        if (!entry || entry.faultCooldown > 0 || !isRacing(race, entry)) {
            continue;
        }

        entry.contactPenalties++;
        entry.faultCooldown = FAULT_COOLDOWN_TICKS;
        const victim = race.entryByState.get(contact.aFront ? contact.b : contact.a) ?? null;
        race.events.push({ type: 'penalty', entry, reason: 'contact', victim });
    }
}

/**
 * Бот влиза в спирачна зона → шанс за късно спиране (по-голям под натиск).
 * Случайността е засята по пистата и се тегли само на детерминирани
 * събития, затова сървърът я възпроизвежда.
 */
function updateMistake(race, opp) {
    if (opp.mistakeTicks > 0) {
        opp.mistakeTicks--;
        if (opp.mistakeTicks === 0) {
            opp.mistakeFactor = 1;
        }
        return;
    }

    const sim = opp.sim;
    if (opp.finishTick !== null || sim.recovering || sim.trackIndexHint === null) {
        opp.brakingZone = false;
        return;
    }

    const track = sim.track;
    const speed = sim.state.vForward;
    const plan = speedPlanFor(track, opp.pace);
    const ahead = (sim.trackIndexHint + Math.round((speed * MISTAKE_LOOKAHEAD) / track.spacing)) % track.count;
    const inBrakingZone = plan[ahead] < speed - MISTAKE_BRAKE_DROP;

    if (inBrakingZone && !opp.brakingZone && race.clock > MISTAKE_START_GRACE) {
        const chance = underPressure(race, opp) ? MISTAKE_CHANCE_PRESSURE : MISTAKE_CHANCE;
        if (race.mistakeRand() < chance) {
            const big = race.mistakeRand() < MISTAKE_BIG_SHARE;
            opp.mistakeFactor = big ? MISTAKE_BIG : MISTAKE_MILD;
            opp.mistakeTicks = MISTAKE_TICKS;
            race.events.push({ type: 'mistake', entry: opp, big });
        }
    }
    opp.brakingZone = inBrakingZone;
}

function underPressure(race, opp) {
    const length = opp.sim.track.length;
    for (const other of race.entries) {
        if (other === opp || !isRacing(race, other) || other.sim.recovering) {
            continue;
        }
        let along = other.sim.lastProgress - opp.sim.lastProgress;
        if (along < -0.5) along += 1;
        if (along > 0.5) along -= 1;
        if (Math.abs(along * length) < MISTAKE_PRESSURE_GAP) {
            return true;
        }
    }
    return false;
}

/**
 * Засичането на линията: колите, които я минаха в тази стъпка, получават
 * енергията за изпреварване, ако до 1 s преди тях я е минала кола отпред.
 * Два прохода — кола отпред, минала линията в същата стъпка, иначе би
 * зависела от реда в масива.
 *
 * @param {ReturnType<typeof createRace>} race
 */
function updateOvertake(race) {
    for (const entry of race.entries) {
        entry.crossedLine = false;
        if (entry.laps > entry.overtakeLap) {
            entry.overtakeLap = entry.laps;
            entry.linePassTick = race.clock;
            entry.crossedLine = true;
            // Неизползваното от миналата обиколка изгаря на линията.
            entry.overtakeEnergy = 0;
        }
    }

    for (const entry of race.entries) {
        if (!entry.crossedLine || !isRacing(race, entry) || entry.sim.recovering) {
            continue;
        }
        if (entry.laps >= OVERTAKE_FROM_LAP && carAheadWithinSecond(race, entry)) {
            entry.overtakeEnergy = OVERTAKE_ENERGY;
            race.events.push({ type: 'overtake', entry, state: 'available' });
        }
    }
}

function carAheadWithinSecond(race, entry) {
    const covered = entry.laps + entry.lastProgress;
    for (const other of race.entries) {
        if (other === entry || !isRacing(race, other) || other.linePassTick < 0) {
            continue;
        }
        const ahead = other.laps + other.lastProgress > covered;
        if (ahead && race.clock - other.linePassTick <= OVERTAKE_WINDOW_TICKS) {
            return true;
        }
    }
    return false;
}

/**
 * Колко от енергията за изпреварване остава на колата, 0..1 (за HUD-а).
 *
 * @param {RaceEntry} entry
 * @returns {number}
 */
export function overtakeCharge(entry) {
    return entry.overtakeEnergy / OVERTAKE_ENERGY;
}

/**
 * Слипстрийм + режим за изпреварване. Слипстрийм: колата губи част от
 * съпротивлението плътно зад кола в същата лента (до нула на DRAFT_RANGE /
 * DRAFT_WIDTH). Режимът: допълнителна мощност P → ускорение P/v, докато
 * стигне енергията. И двете се прилагат след физиката на тика като
 * допълнително ускорение, таванът е максималната скорост на колата. Играчът
 * след флага не участва.
 *
 * @param {ReturnType<typeof createRace>} race
 */
function applyAero(race) {
    const entries = race.entries;
    const track = race.player.track;
    race.playerDraft = 0;

    for (let f = 0; f < entries.length; f++) {
        const followerEntry = entries[f];
        if (followerEntry === race.playerLaps && race.playerDetached) {
            continue;
        }

        const follower = followerEntry.sim;
        const speed = follower.state.vForward;
        followerEntry.overtakeActive = false;
        if (follower.recovering || speed < DRAFT_MIN_SPEED || follower.trackIndexHint === null) {
            continue;
        }

        const hint = follower.trackIndexHint;
        const nx = track.nx[hint];
        const nz = track.nz[hint];
        let strength = 0;

        for (let l = 0; l < entries.length; l++) {
            const leaderEntry = entries[l];
            const leader = leaderEntry.sim;
            if (l === f || leader.recovering || (leaderEntry === race.playerLaps && race.playerDetached)) {
                continue;
            }

            let along = leader.lastProgress - follower.lastProgress;
            if (along < -0.5) along += 1;
            if (along > 0.5) along -= 1;
            const gap = along * track.length;
            if (gap <= 1 || gap >= DRAFT_RANGE) {
                continue;
            }

            const lateral = Math.abs(
                (leader.state.x - follower.state.x) * nx + (leader.state.z - follower.state.z) * nz
            );
            if (lateral >= DRAFT_WIDTH) {
                continue;
            }

            const candidate = (1 - gap / DRAFT_RANGE) * (1 - lateral / DRAFT_WIDTH);
            if (candidate > strength) strength = candidate;
        }

        let boost = DRAFT_MAX * strength * CAR.drag * speed * speed * FIXED_DT;
        if (
            followerEntry.overtakeEnergy > 0 &&
            speed >= OVERTAKE_MIN_SPEED &&
            follower.state.throttlePedal >= OVERTAKE_THROTTLE
        ) {
            // Енергия на kg за тика: P·dt, а последната порция — колкото е останало.
            const energy = Math.min(OVERTAKE_POWER * FIXED_DT, followerEntry.overtakeEnergy);
            followerEntry.overtakeEnergy -= energy;
            followerEntry.overtakeActive = true;
            boost += energy / speed;
        }
        if (boost > 0) {
            const boosted = speed + boost;
            follower.state.vForward = boosted < CAR.maxSpeed ? boosted : CAR.maxSpeed;
        }
        if (followerEntry === race.playerLaps) {
            race.playerDraft = strength;
        }
    }
}

function placeOnSlot(sim, slot) {
    const track = sim.track;
    const state = sim.state;

    state.x = slot.x;
    state.z = slot.z;
    state.heading = slot.heading;
    state.vForward = 0; // стоящ старт — чака светлините
    sim.trackIndexHint = slot.index;
    sim.lastProgress = slot.progress;
    sim.surface.height = slot.height;
    sim.surface.gradient = track.gradient[slot.index];
    sim.surface.bank = track.bankSlope[slot.index];
}

/** @returns {RaceResult} */
function buildResult(race) {
    const entry = race.playerLaps;
    const raceMs = Math.round(race.ticks * FIXED_DT * 1000);
    const penalties = penaltiesOf(entry);

    return {
        raceTicks: race.ticks,
        raceMs,
        penalties,
        trackLimits: entry.sim.excursions,
        contactFaults: entry.contactPenalties,
        totalMs: raceMs + penalties * RACE_PENALTY_MS,
        position: classifyRace(race).findIndex((row) => row.opponentIndex === null) + 1,
        finalPosition: null,
    };
}

/**
 * Брои пресичанията на стартовата линия (в двете посоки) по прогреса.
 *
 * @param {{laps: number, lastProgress: number}} entry
 * @param {number} progress
 */
export function trackWrap(entry, progress) {
    if (entry.lastProgress > 0.85 && progress < 0.15) {
        entry.laps++;
    } else if (entry.lastProgress < 0.15 && progress > 0.85) {
        entry.laps--;
    }
    entry.lastProgress = progress;
}
