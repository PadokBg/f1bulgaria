/**
 * Офлайн настройка на скоростния планировчик на ботовете (PLANNER в
 * autopilot.js): координатно търсене по всички писти. Целта е най-ниско
 * сумарно време на соло обиколка, като всяко излизане, удар в стена или
 * незавършена обиколка се наказва тежко — бот, който не е чист, е безполезен
 * в състезание с човек.
 *
 *   node scripts/game/bot-tune.mjs [rounds=3]
 *
 * Отпечатва най-добрите стойности — те се пренасят на ръка в PLANNER.
 * Тича със СЪЩАТА симулация като играта, затова резултатът е преносим.
 */

import { readFileSync } from 'node:fs';

import { PLANNER, driveAutopilot } from '../../resources/js/game/autopilot.js';
import { createSimFromData } from '../../resources/js/game/sim.js';

const rounds = Number(process.argv[2] ?? 3);
const index = JSON.parse(readFileSync('public/game-tracks/index.json', 'utf8'));
const tracks = index.map((meta) => JSON.parse(readFileSync(`public/game-tracks/${meta.slug}.json`, 'utf8')));

/** Секунди наказание — повече от всяка реална печалба от рисковото темпо. */
const PENALTY_EXCURSION = 25;
const PENALTY_WALL = 15;
const PENALTY_DNF = 400;

/** Кара една соло обиколка; връща време и нечистотии. */
function lapOn(trackData, pace = 1) {
    const sim = createSimFromData(trackData);
    sim.recordEnabled = false;
    const input = { steer: 0, throttle: 0, brake: 0 };
    let excursionsAtArm = null;
    let walls = 0;
    let lastWallTick = -10;

    for (let tick = 0; tick < 6 * 60 * 120; tick++) {
        driveAutopilot(sim, input, { pace });
        const event = sim.tick(input);

        if (sim.phase === 'flying' || event) {
            excursionsAtArm ??= sim.excursions;
            const hit = sim.state.out.wallHit;
            if (hit !== null && hit.tick > lastWallTick + 4) {
                walls++;
                lastWallTick = hit.tick;
            }
        }

        if (event?.type === 'finished') {
            return { seconds: event.lapMs / 1000, excursions: sim.excursions - excursionsAtArm, walls };
        }
    }

    return null;
}

function score() {
    let total = 0;
    let dirty = 0;
    for (const trackData of tracks) {
        const lap = lapOn(trackData);
        if (lap === null) {
            total += PENALTY_DNF;
            dirty++;
            continue;
        }
        total += lap.seconds + lap.excursions * PENALTY_EXCURSION + lap.walls * PENALTY_WALL;
        dirty += lap.excursions + lap.walls > 0 ? 1 : 0;
    }
    return { total, dirty };
}

const SEARCH = {
    lateralUse: [0.02, 0.6, 1.3],
    brakeUse: [0.03, 0.5, 1.05],
    steerMargin: [0.05, 0.6, 2.5],
    reactionTime: [0.02, 0.05, 0.6],
    exitLateralUse: [0.04, 0.3, 1.2],
    lookAheadTime: [0.05, 0.3, 0.9],
    yawDamping: [0.04, 0, 0.4],
};

let best = score();
console.log(`старт: ${best.total.toFixed(1)} s, нечисти писти ${best.dirty}`, JSON.stringify(PLANNER));

for (let round = 0; round < rounds; round++) {
    for (const [key, [step, min, max]] of Object.entries(SEARCH)) {
        const scale = step / (round + 1);
        for (const direction of [1, -1]) {
            // Върви в посоката, докато подобрява.
            while (true) {
                const previous = PLANNER[key];
                const candidate = Math.round((previous + direction * scale) * 1000) / 1000;
                if (candidate < min || candidate > max) break;
                PLANNER[key] = candidate;
                const result = score();
                if (result.total < best.total - 0.05) {
                    best = result;
                    console.log(`  ${key}=${candidate}: ${best.total.toFixed(1)} s, нечисти ${best.dirty}`);
                } else {
                    PLANNER[key] = previous;
                    break;
                }
            }
        }
    }
    console.log(`кръг ${round + 1}: ${best.total.toFixed(1)} s, нечисти ${best.dirty}`, JSON.stringify(PLANNER));
}
