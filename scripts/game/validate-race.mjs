/**
 * Сървърна валидация на състезание от играта: преиграва записания вход на
 * играча от гасенето на светлините до карирания флаг — заедно с ботовете и
 * контактите — през СЪЩАТА симулация (resources/js/game/race.js) и печата
 * резултата като JSON на stdout.
 *
 * Вика се от ValidateGameRaceJob с път до payload файл:
 *   node scripts/game/validate-race.mjs /tmp/payload.json
 *
 * payload: { "trackFile": "/path/to/monza.json", "trace": "<encodeRaceTrace JSON>" }
 * изход:   { "status": "finished|incomplete|version_mismatch|bad_trace",
 *            "raceMs": 375083|null, "penalties": 0|null, "totalMs": ..|null,
 *            "position": 1..6|null, "raceTicks": ..|null, "frames": "<base64>"|null,
 *            "trailingTicks": 0|null }
 *
 * position е ОКОНЧАТЕЛНАТА позиция: след флага полето доизкарва без вход.
 * frames са кадрите на играча от гасенето до флага — задочният съперник в
 * чужди състезания („Състезавай се срещу").
 *
 * За разлика от обиколката тук няма стартов снапшот от клиента: решетката е
 * фиксирана, затова единственото, което клиентът контролира, е входът.
 */

import { readFileSync } from 'node:fs';

import { RACE_OPPONENTS, RACE_VERSION, decodeRaceTrace, replayRace } from '../../resources/js/game/race.js';
import { SIM_VERSION, createSimFromData, encodeFrames } from '../../resources/js/game/sim.js';

const EMPTY = { raceMs: null, penalties: null, totalMs: null, position: null, raceTicks: null, frames: null, trailingTicks: null };

const fail = (status) => {
    console.log(JSON.stringify({ status, ...EMPTY }));
    process.exit(0);
};

const payloadPath = process.argv[2];

if (!payloadPath) {
    fail('bad_trace');
}

let payload;
let trackData;
try {
    payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
    trackData = JSON.parse(readFileSync(payload.trackFile, 'utf8'));
} catch {
    fail('bad_trace');
}

const trace = typeof payload.trace === 'string' ? decodeRaceTrace(payload.trace) : null;

if (!trace || trace.inputs.length === 0 || trace.inputs.length % 2 !== 0) {
    fail('bad_trace');
}

if (trace.v !== SIM_VERSION || trace.rv !== RACE_VERSION) {
    // Стар клиент срещу нови правила — не може да се повтори честно.
    fail('version_mismatch');
}

if (trace.opponents !== RACE_OPPONENTS) {
    fail('bad_trace');
}

const player = createSimFromData(trackData);
// Обиколките на играча в състезанието не трябват на сървъра — само памет.
player.recordEnabled = false;

const { result, consumedTicks, frames } = replayRace(player, trace, { frames: true });

console.log(
    JSON.stringify(
        result
            ? {
                status: 'finished',
                raceMs: result.raceMs,
                penalties: result.penalties,
                totalMs: result.totalMs,
                position: result.finalPosition,
                raceTicks: result.raceTicks,
                frames: frames ? encodeFrames(frames) : null,
                // Честният запис свършва точно на флага; остатък значи, че
                // клиентът и сървърът са видели различни състезания.
                trailingTicks: Math.floor(trace.inputs.length / 2) - consumedTicks,
            }
            : { status: 'incomplete', ...EMPTY }
    )
);
