/**
 * Стенд за ботовете: колко бързо и колко чисто кара автопилотът соло
 * обиколка на всяка писта. Мерилото при настройката на скоростния профил —
 * бърз бот, който излиза или удря стени, е по-лош от бавен.
 *
 *   node scripts/game/bot-bench.mjs [pace=1] [slug ...]
 *
 * Колони: чиста обиколка (първата летяща), валидна ли е, излизания, удари в
 * стена, максимална и средна скорост.
 */

import { readFileSync } from 'node:fs';

import { driveAutopilot } from '../../resources/js/game/autopilot.js';
import { FIXED_DT } from '../../resources/js/game/physics.js';
import { createSimFromData } from '../../resources/js/game/sim.js';

const pace = Number(process.argv[2] ?? 1);
const requested = process.argv.slice(3);
const index = JSON.parse(readFileSync('public/game-tracks/index.json', 'utf8'));
const slugs = requested.length > 0 ? requested : index.map((track) => track.slug);

const rows = [];

for (const slug of slugs) {
    const sim = createSimFromData(JSON.parse(readFileSync(`public/game-tracks/${slug}.json`, 'utf8')));
    sim.recordEnabled = false;
    const input = { steer: 0, throttle: 0, brake: 0 };

    let finished = null;
    let wallHits = 0;
    let lastWallTick = -10;
    let maxSpeed = 0;
    let flyingTicks = 0;
    let flyingDistance = 0;
    let excursionsAtArm = null;

    for (let tick = 0; tick < 8 * 60 * 120 && finished === null; tick++) {
        driveAutopilot(sim, input, { pace });
        const event = sim.tick(input);

        if (sim.phase === 'flying') {
            excursionsAtArm ??= sim.excursions;
            flyingTicks++;
            flyingDistance += Math.max(0, sim.state.vForward) * FIXED_DT;
            maxSpeed = Math.max(maxSpeed, sim.state.vForward);

            const hit = sim.state.out.wallHit;
            if (hit !== null && hit.tick !== lastWallTick && hit.tick > lastWallTick + 4) {
                wallHits++;
                lastWallTick = hit.tick;
            }
        }

        if (event?.type === 'finished') {
            finished = event;
        }
    }

    rows.push({
        slug,
        lap: finished ? (finished.lapMs / 1000).toFixed(3) : 'DNF',
        valid: finished ? (finished.valid ? 'да' : 'НЕ') : '-',
        excursions: excursionsAtArm === null ? '-' : sim.excursions - excursionsAtArm,
        walls: wallHits,
        maxKmh: Math.round(maxSpeed * 3.6),
        avgKmh: flyingTicks > 0 ? Math.round((flyingDistance / (flyingTicks * FIXED_DT)) * 3.6) : 0,
    });
}

console.table(rows);
