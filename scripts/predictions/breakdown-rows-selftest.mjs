/**
 * Видът попадение в разбивката на прогноза (resources/js/predictions/breakdownRows.js):
 * точно / частично / мимо, изведено от спечелените точки спрямо точковата схема.
 *
 *   node scripts/predictions/breakdown-rows-selftest.mjs
 *
 * Пази регресията, заради която модулът съществува: частичните 5 т. за пилот
 * от подиума на друго място се показваха със зелено „✓" като точно попадение
 * („✓ Победител +5") — на сайта, на картичката за споделяне и в писмото.
 */

import assert from 'node:assert/strict';

import { BREAKDOWN_LABELS, breakdownRows, classifyHit } from '../../resources/js/predictions/breakdownRows.js';

// Стойностите на config/predictions.php към 02.11.2026 — тук се проверява
// логиката, затова схемата е фиксирана, а не прочетена от PHP.
const scoring = {
    exact: { p1: 25, p2: 18, p3: 15 },
    podium_partial: 5,
    pole: 6,
    fastest_lap: 5,
    dnf_exact: 5,
    dnf_close: 2,
    safety_car: 4,
};

let checks = 0;
const check = (name, fn) => {
    fn();
    checks++;
    console.log(`  ok  ${name}`);
};

check('точно място на подиума е точно попадение', () => {
    for (const slot of ['p1', 'p2', 'p3']) {
        assert.equal(classifyHit(slot, scoring.exact[slot], scoring), 'exact', slot);
    }
});

check('пилот на подиума, но на друго място е частично попадение', () => {
    for (const slot of ['p1', 'p2', 'p3']) {
        assert.equal(classifyHit(slot, scoring.podium_partial, scoring), 'partial', slot);
    }
});

check('нула точки е мимо във всяка категория', () => {
    for (const [key] of BREAKDOWN_LABELS) {
        assert.equal(classifyHit(key, 0, scoring), 'miss', key);
    }
});

check('DNF: точен брой е точно, разлика от един е частично', () => {
    assert.equal(classifyHit('dnf', scoring.dnf_exact, scoring), 'exact');
    assert.equal(classifyHit('dnf', scoring.dnf_close, scoring), 'partial');
});

check('бонус със същата стойност като частичния подиум остава точно попадение', () => {
    // Най-бързата обиколка носи 5 т. — колкото частичният подиум.
    assert.equal(classifyHit('fastest_lap', scoring.fastest_lap, scoring), 'exact');
    assert.equal(classifyHit('pole', scoring.pole, scoring), 'exact');
    assert.equal(classifyHit('safety_car', scoring.safety_car, scoring), 'exact');
});

check('без схема не обявява точно попадение за частично', () => {
    assert.equal(classifyHit('p1', scoring.podium_partial, null), 'exact');
    assert.equal(classifyHit('p1', 0, null), 'miss');
});

check('нескорирана прогноза няма редове', () => {
    assert.deepEqual(breakdownRows(null, scoring), []);
    assert.deepEqual(breakdownRows(undefined, scoring), []);
});

check('реална разбивка: точен победител, разменени второ и трето', () => {
    // R19 от сезон 2026: P1 точно, P2/P3 разменени, най-бърза обиколка,
    // DNF с разлика 1 и safety car.
    const rows = breakdownRows(
        { p1: 25, p2: 5, p3: 5, pole: 0, fastest_lap: 5, dnf: 2, safety_car: 4 },
        scoring,
    );

    assert.deepEqual(rows.map((row) => row.key), BREAKDOWN_LABELS.map(([key]) => key));
    assert.deepEqual(
        rows.map((row) => row.status),
        ['exact', 'partial', 'partial', 'miss', 'exact', 'partial', 'exact'],
    );
    assert.deepEqual(
        rows.map((row) => row.note),
        [null, 'на подиума, но на друго място', 'на подиума, но на друго място', null, null, 'с разлика от един', null],
    );
    assert.deepEqual(
        rows.map((row) => row.shortNote),
        [null, 'друга позиция', 'друга позиция', null, null, 'с разлика 1', null],
    );
});

check('пропуска липсващите ключове и пази реда на формата', () => {
    const rows = breakdownRows({ p3: 15, p1: 5 }, scoring);

    assert.deepEqual(rows.map((row) => [row.key, row.label, row.status]), [
        ['p1', 'Победител', 'partial'],
        ['p3', 'Трето място', 'exact'],
    ]);
});

check('точки, дошли като низ, се четат като число', () => {
    const [row] = breakdownRows({ p1: '25' }, scoring);

    assert.equal(row.points, 25);
    assert.equal(row.status, 'exact');
});

console.log(`breakdown-rows: ${checks} проверки минаха`);
