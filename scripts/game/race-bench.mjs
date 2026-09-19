/**
 * Стенд за СЪСТЕЗАНИЕТО: „играч" с автопилот на дадено темпо срещу полето.
 * Мери не само кой печели, а дали изобщо има състезание: изпреварвания, дял
 * от времето в близка битка, контакти и грешки на ботовете.
 *
 *   node scripts/game/race-bench.mjs [playerPace=0.95] [slug ...]
 *
 * Колони: финална позиция и общо време на играча, изпреварвания в полето
 * (смени в подредбата), % от времето с кола на ≤ 30 m от играча, контакти
 * (нови удари с импулс > 1.5), излизания на ботовете, режим за изпреварване
 * (колко пъти е даден и колко секунди общо е пускан от всички коли).
 */

import { readFileSync } from 'node:fs';

import { driveAutopilot, resetAutopilotDriver } from '../../resources/js/game/autopilot.js';
import { FIXED_DT } from '../../resources/js/game/physics.js';
import { createRace, stepRace } from '../../resources/js/game/race.js';
import { createSimFromData } from '../../resources/js/game/sim.js';

const playerPace = Number(process.argv[2] ?? 0.95);
const requested = process.argv.slice(3);
const index = JSON.parse(readFileSync('public/game-tracks/index.json', 'utf8'));
const slugs = requested.length > 0 ? requested : index.map((track) => track.slug);

const rows = [];

for (const slug of slugs) {
    const race = createRace(createSimFromData(JSON.parse(readFileSync(`public/game-tracks/${slug}.json`, 'utf8'))));
    const options = { pace: playerPace, others: race.opponents.map((opp) => opp.sim) };
    const input = { steer: 0, throttle: 0, brake: 0 };
    const length = race.player.track.length;
    resetAutopilotDriver(race.player);

    let overtakes = 0;
    let previousOrder = null;
    let battleTicks = 0;
    let contacts = 0;
    let contactCooldown = 0;
    let ticks = 0;
    let mistakes = 0;
    let overtakeGrants = 0;
    let overtakeTicks = 0;
    let faults = 0;

    for (; ticks < 25 * 60 * 120 && race.classification === null; ticks++) {
        driveAutopilot(race.player, input, options);
        stepRace(race, input);
        for (const event of race.events) {
            if (event.type === 'mistake') mistakes++;
            if (event.type === 'overtake') overtakeGrants++;
            if (event.type === 'penalty' && event.reason === 'contact') faults++;
        }
        for (const entry of race.entries) {
            if (entry.overtakeActive) overtakeTicks++;
        }
        if (race.result !== null) {
            continue;
        }

        const playerCovered = race.playerLaps.laps + race.playerLaps.lastProgress;
        let closest = Infinity;
        for (const opp of race.opponents) {
            const gap = Math.abs(opp.laps + opp.lastProgress - playerCovered) * length;
            if (gap < closest) closest = gap;
        }
        if (closest <= 30) battleTicks++;

        if (contactCooldown > 0) {
            contactCooldown--;
        } else if (race.contacts.some((contact) => contact.impulse > 1.5)) {
            contacts++;
            contactCooldown = 60;
        }

        // Подредбата веднъж в секунда — трептенето на един тик не е изпреварване.
        if (ticks % 120 === 0 && ticks > 120 * 10) {
            const order = [{ key: -1, covered: playerCovered }, ...race.opponents.map((opp, i) => ({ key: i, covered: opp.laps + opp.lastProgress }))]
                .sort((a, b) => b.covered - a.covered)
                .map((entry) => entry.key)
                .join(',');
            if (previousOrder !== null && order !== previousOrder) overtakes++;
            previousOrder = order;
        }
    }

    const result = race.result;
    rows.push({
        slug,
        pos: result ? `${result.position}→${result.finalPosition}` : 'DNF',
        total: result ? (result.totalMs / 1000).toFixed(1) : '-',
        pen: result ? result.penalties : '-',
        overtakes,
        battle: `${Math.round((battleTicks / Math.max(1, ticks)) * 100)}%`,
        contacts,
        botExc: race.opponents.reduce((sum, opp) => sum + opp.sim.excursions, 0),
        mistakes,
        ot: overtakeGrants,
        otSec: (overtakeTicks * FIXED_DT).toFixed(1),
        faults,
        minutes: (ticks * FIXED_DT / 60).toFixed(1),
    });
}

console.table(rows);
