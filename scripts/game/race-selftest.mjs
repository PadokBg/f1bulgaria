/**
 * Селфтест на детерминизма на СЪСТЕЗАНИЕТО: автопилот кара вместо играча
 * срещу пълната решетка (контакти, наказания, DRS, грешки на ботовете),
 * записът се преиграва през сериализацията (пътят на сървъра) и резултатът,
 * окончателното класиране и кадрите на духа трябва да съвпаднат ТОЧНО.
 *
 * Живото състезание продължава с активен „играч" след флага, а сървърното
 * доизкарва без вход — съвпадащото класиране доказва, че играчът след флага
 * наистина не влияе на полето. Второ състезание на СЪЩИТЕ симулации (рестарт
 * в играта) трябва да даде същото.
 *
 * Три сценария: чисто каране, „небрежен" играч с люлеещ се волан, който
 * излиза от пистата, и „сляп", който не вижда трафика и блъска отзад — така
 * и двата вида наказания се преиграват.
 * Пада с код 1 при разминаване.
 *
 *   node scripts/game/race-selftest.mjs [public/game-tracks/monza.json]
 */

import { readFileSync } from 'node:fs';

import { driveAutopilot, resetAutopilotDriver } from '../../resources/js/game/autopilot.js';
import {
    RACE_OPPONENTS,
    createRace,
    decodeRaceTrace,
    encodeRaceTrace,
    gridRace,
    replayRace,
    stepRace,
} from '../../resources/js/game/race.js';
import { createSimFromData } from '../../resources/js/game/sim.js';

const trackFile = process.argv[2] ?? 'public/game-tracks/monza.json';
const trackData = JSON.parse(readFileSync(trackFile, 'utf8'));

const SCENARIOS = [
    { name: 'чисто', pace: 0.95, wobble: 0, expectPenalties: false },
    { name: 'небрежно', pace: 0.95, wobble: 0.45, expectPenalties: true },
    // Не вижда трафика → блъска отзад: пътят на съдийството за удари.
    { name: 'сляп', pace: 1, wobble: 0, blind: true, expectContactFaults: true },
];

const fail = (message) => {
    console.error(`СЕЛФТЕСТ: ${message}`);
    process.exit(1);
};

/** Кара едно състезание до окончателното класиране; „играчът" е автопилот. */
function driveRace(race, scenario) {
    const options = { pace: scenario.pace, others: scenario.blind ? [] : race.opponents.map((opp) => opp.sim) };
    const input = { steer: 0, throttle: 0, brake: 0 };
    const maxTicks = 25 * 60 * 120;
    const counts = { mistakes: 0, contactPenalties: 0, drsOpen: 0 };

    resetAutopilotDriver(race.player);
    for (let tick = 0; tick < maxTicks && race.classification === null; tick++) {
        driveAutopilot(race.player, input, options);
        // Детерминирано люлеене на волана — излизания без Math.random.
        input.steer = Math.max(-1, Math.min(1, input.steer + Math.sin(tick * 0.013) * scenario.wobble));
        stepRace(race, input);

        for (const event of race.events) {
            if (event.type === 'mistake') counts.mistakes++;
            if (event.type === 'penalty' && event.reason === 'contact') counts.contactPenalties++;
            if (event.type === 'drs' && event.state === 'open') counts.drsOpen++;
        }
    }

    return counts;
}

const checksum = (frames) => {
    let sum = 0;
    for (let i = 0; i < frames.length; i++) {
        sum = (sum * 31 + Math.round(frames[i] * 1000)) % 2147483647;
    }
    return sum;
};

for (const scenario of SCENARIOS) {
    const race = createRace(createSimFromData(trackData));
    race.recordFrames = true;
    const counts = driveRace(race, scenario);
    const live = race.result;

    if (!live || !race.classification) {
        fail(`[${scenario.name}] състезанието не завърши до окончателно класиране`);
    }

    const encoded = encodeRaceTrace(race);
    if (!encoded) {
        fail(`[${scenario.name}] няма запис на завършеното състезание`);
    }

    console.log(
        `[${scenario.name}] ${live.raceMs} ms + ${live.penalties} наказания (${live.trackLimits} излизания, ` +
        `${live.contactFaults} удара) = ${live.totalMs} ms, П${live.position}→П${live.finalPosition}/${RACE_OPPONENTS + 1}, ` +
        `грешки на ботове ${counts.mistakes}, DRS ${counts.drsOpen}, трейс ${(encoded.length / 1024).toFixed(0)} KB`
    );

    if (scenario.expectContactFaults && live.contactFaults === 0) {
        fail(`[${scenario.name}] нито една вина за удар — съдийството не е покрито`);
    }

    if (scenario.expectPenalties && live.penalties === 0) {
        fail(`[${scenario.name}] няма нито едно наказание — пътят на наказанията не е покрит`);
    }

    const started = performance.now();
    const replay = replayRace(createSimFromData(trackData), decodeRaceTrace(encoded), { frames: true });
    const replaySeconds = (performance.now() - started) / 1000;

    if (!replay.result || !replay.classification) {
        fail(`[${scenario.name}] преиграването не стигна до класиране`);
    }

    for (const key of ['raceTicks', 'raceMs', 'penalties', 'trackLimits', 'contactFaults', 'totalMs', 'position', 'finalPosition']) {
        if (replay.result[key] !== live[key]) {
            fail(`[${scenario.name}] ${key} се разминава — живо ${live[key]}, преиграно ${replay.result[key]}`);
        }
    }

    if (JSON.stringify(replay.classification) !== JSON.stringify(race.classification)) {
        fail(`[${scenario.name}] окончателното класиране се разминава — играчът след флага влияе на полето`);
    }

    if (replay.consumedTicks !== live.raceTicks) {
        fail(`[${scenario.name}] преиграването изяде ${replay.consumedTicks} тика, записът е ${live.raceTicks}`);
    }

    const liveFrames = Float32Array.from(race.frames);
    if (!replay.frames || replay.frames.length !== liveFrames.length || checksum(replay.frames) !== checksum(liveFrames)) {
        fail(`[${scenario.name}] кадрите на духа се разминават`);
    }

    // Рестарт на същите симулации — пътят на „Ново състезание" в играта.
    gridRace(race);
    race.recordFrames = true;
    driveRace(race, scenario);

    if (!race.result || race.result.totalMs !== live.totalMs || race.result.finalPosition !== live.finalPosition) {
        fail(`[${scenario.name}] второто състезание на същите симулации се разминава — ${live.totalMs} срещу ${race.result?.totalMs}`);
    }

    console.log(`[${scenario.name}] ОК: преиграно точно за ${replaySeconds.toFixed(2)} s`);
}

console.log('СЕЛФТЕСТ ОК: състезанието се възпроизвежда детерминирано.');
