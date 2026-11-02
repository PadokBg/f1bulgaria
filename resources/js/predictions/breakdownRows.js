/**
 * Редовете на разбивката на една прогноза — общи за разбивката на сайта
 * (PredictionBreakdown.vue) и за картичката за споделяне (resultCard.js).
 * Писмото след кръга ги повтаря в App\Mail\RaceResultMail.
 *
 * breakdown_json пази само спечелените точки, затова видът на попадението се
 * извежда от стойността спрямо точковата схема — както
 * BadgeService::isPerfectPodium разпознава точния подиум. Без това частичното
 * попадение (пилот на подиума, но на друго място) носеше същото „✓" като
 * точното и „✓ Победител +5" изглеждаше като познат победител.
 */

export const BREAKDOWN_LABELS = [
    ['p1', 'Победител'],
    ['p2', 'Второ място'],
    ['p3', 'Трето място'],
    ['pole', 'Pole позиция'],
    ['fastest_lap', 'Най-бърза обиколка'],
    ['dnf', 'Брой отпаднали'],
    ['safety_car', 'Safety car'],
];

const PODIUM_SLOTS = ['p1', 'p2', 'p3'];

// note — за разбивката на сайта; shortNote — за картичката, където редът е
// тесен. Кратката казва какво е сгрешено: „Второ място · на подиума" звучеше
// като познато второ място.
const PODIUM_PARTIAL = { note: 'на подиума, но на друго място', shortNote: 'друга позиция' };
const DNF_PARTIAL = { note: 'с разлика от един', shortNote: 'с разлика 1' };

/**
 * @param {string} key  ключ от breakdown_json
 * @param {number} points  спечелените точки за категорията
 * @param {object|null} scoring  config('predictions.scoring') — споделеният prop predictionScoring
 * @returns {'exact'|'partial'|'miss'}
 */
export function classifyHit(key, points, scoring) {
    if (points <= 0) {
        return 'miss';
    }

    // Без схема двете не се различават — по-добре старото „✓", отколкото
    // точно попадение да излезе като частично.
    if (!scoring) {
        return 'exact';
    }

    if (PODIUM_SLOTS.includes(key)) {
        return points === scoring.exact?.[key] ? 'exact' : 'partial';
    }

    if (key === 'dnf') {
        return points === scoring.dnf_exact ? 'exact' : 'partial';
    }

    return 'exact';
}

/**
 * @param {Record<string, number>|null} breakdown  breakdown_json от PredictionScore
 * @param {object|null} scoring  config('predictions.scoring')
 * @returns {Array<{key: string, label: string, points: number, status: 'exact'|'partial'|'miss', note: string|null, shortNote: string|null}>}
 */
export function breakdownRows(breakdown, scoring) {
    // Нескорирана прогноза идва без breakdown.
    if (!breakdown) {
        return [];
    }

    return BREAKDOWN_LABELS
        .filter(([key]) => breakdown[key] !== undefined)
        .map(([key, label]) => {
            const points = Number(breakdown[key]) || 0;
            const status = classifyHit(key, points, scoring);
            const partial = status === 'partial'
                ? (key === 'dnf' ? DNF_PARTIAL : PODIUM_PARTIAL)
                : null;

            return {
                key,
                label,
                points,
                status,
                note: partial?.note ?? null,
                shortNote: partial?.shortNote ?? null,
            };
        });
}
