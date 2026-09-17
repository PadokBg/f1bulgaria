/**
 * Генерира тестовата фикстура за e2e валидацията на състезание (Pest →
 * tests/Fixtures/game/race.json): автопилотът кара едно честно състезание
 * срещу пълната решетка и записът се дъмпва заедно с резултата.
 *
 *   node scripts/game/make-race-fixture.mjs
 *
 * Пуска се след ВСЯКА промяна на SIM_VERSION или RACE_VERSION — иначе e2e
 * тестът ще реже фикстурата като version_mismatch. Ред Бул Ринг е най-късото
 * състезание → най-малката фикстура и най-бързият тест.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { driveAutopilot } from '../../resources/js/game/autopilot.js';
import { RACE_VERSION, createRace, encodeRaceTrace, stepRace } from '../../resources/js/game/race.js';
import { SIM_VERSION, createSimFromData } from '../../resources/js/game/sim.js';

const slug = 'red_bull_ring';
const race = createRace(createSimFromData(JSON.parse(readFileSync(`public/game-tracks/${slug}.json`, 'utf8'))));
const options = { pace: 0.95, others: race.opponents.map((opp) => opp.sim) };
const input = { steer: 0, throttle: 0, brake: 0 };

for (let tick = 0; tick < 20 * 60 * 120 && race.result === null; tick++) {
    driveAutopilot(race.player, input, options);
    stepRace(race, input);
}

const trace = race.result ? encodeRaceTrace(race) : null;

if (!trace) {
    console.error('Автопилотът не завърши състезанието — фикстурата не е обновена.');
    process.exit(1);
}

// Окончателното класиране: полето доизкарва след флага, играчът вече не влияе.
while (race.classification === null) {
    stepRace(race, input);
}

const { raceMs, raceTicks, penalties, totalMs, position, finalPosition } = race.result;

writeFileSync(
    'tests/Fixtures/game/race.json',
    JSON.stringify({
        track: slug,
        race_ms: raceMs,
        penalties,
        total_ms: totalMs,
        position,
        final_position: finalPosition,
        race_ticks: raceTicks,
        sim_version: SIM_VERSION,
        race_version: RACE_VERSION,
        trace,
    })
);
console.log(`Фикстура обновена: ${slug}, ${totalMs} ms, позиция ${position}→${finalPosition}, sim v${SIM_VERSION}, race v${RACE_VERSION}.`);
