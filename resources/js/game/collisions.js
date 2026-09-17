/**
 * Контакти на болида: кола–кола (режим „Състезание") и кола–стена (навсякъде).
 *
 * Всяка кола е два кръга (предница/задница) върху равнината на пистата. При
 * застъпване телата се разделят и получават импулс по нормалата + лек въртящ
 * „ритник" при офсетов удар — достатъчно за честно състезателно блъскане,
 * без да е тежка физика на твърди тела.
 *
 * Кола–кола живее САМО в състезателния режим. Там времето на играча зависи
 * и от ботовете, затова сървърът преиграва ЦЯЛОТО поле (race.js) — ударите
 * са детерминирани като всичко останало в тика.
 *
 * Стените са друго: неподвижни, детерминирани от данните на пистата
 * (track.wallLeft/wallRight), затова ударът в тях Е част от симулацията и се
 * преиграва 1:1 на сървъра (sim.js вика resolveWallContact всяка стъпка).
 *
 * Известен компромис: удар по кола под lowSpeedThreshold (2 m/s) губи
 * въртящия ритник — кинематичният клон на physics.step презаписва yawRate.
 * Ниската скорост прави ефекта незабележим; не си струва специален случай.
 *
 * Чист модул без three.js/DOM — тества се в Node. Само +−×/√ (без
 * трансцендентни функции) → бит-идентичен между JS двигателите.
 */

/** Радиус на всеки от двата кръга на колата, м (полуширина на болида). */
export const CIRCLE_RADIUS = 0.95;

/** Отстояние на кръговете от центъра по надлъжната ос, м. */
export const HALF_LENGTH = 1.25;

/** Еластичност на удара кола–кола: 0 = лепкав, 1 = билярд. Ниска — F1 не отскача. */
const RESTITUTION = 0.25;

/** Еластичност на удара в стена — мантинелата поглъща, не изстрелва. */
const WALL_RESTITUTION = 0.15;

/** Дял от тангенциалната скорост, който остъргването губи при удар с
 *  нормална скорост ≥ WALL_SCRAPE_FULL_SPEED (линейно под нея). */
const WALL_SCRAPE = 0.12;
const WALL_SCRAPE_FULL_SPEED = 10;

/** Въртящ ритник от стена, rad/s на m/s нормална скорост, и таванът му. */
const WALL_YAW_KICK = 0.25;
const MAX_WALL_YAW_KICK = 0.6;

/** Колко над повърхността на стената оставяме колата след разделяне, м —
 *  срещу повторен контакт на следващия тик от шума на плаващата запетая. */
const WALL_MARGIN = 0.05;

/** Таван на скоростния импулс на един тик кола–кола, m/s — срещу експлозии
 *  при дълбоко застъпване (телепорт, спавн). */
const MAX_IMPULSE = 6;

/** Въртящ ефект от офсетов удар кола–кола, rad/s на m/s импулс. */
const YAW_KICK = 0.35;

/** Таван на въртящия ритник на един контакт кола–кола, rad/s. */
const MAX_YAW_KICK = 0.9;

/**
 * Разрешава контактите между всички двойки коли. Мутира състоянията
 * (x, z, vForward, vLateral, yawRate) на място.
 *
 * @param {Array<import('./physics.js').CarState>} cars
 * @param {Array<{a: object, b: object, impulse: number, x: number, z: number,
 *         aFront: boolean, bFront: boolean, nx: number, nz: number}>} [outContacts]
 *        По избор: списък на ударите от този тик (за искри/звук). Подава се
 *        преизползван масив — нулира се тук.
 */
export function resolveCarContacts(cars, outContacts = null) {
    if (outContacts !== null) {
        outContacts.length = 0;
    }

    for (let i = 0; i < cars.length; i++) {
        for (let j = i + 1; j < cars.length; j++) {
            const contact = resolvePair(cars[i], cars[j]);
            if (contact !== null && outContacts !== null) {
                outContacts.push(contact);
            }
        }
    }
}

/**
 * Удар в неподвижна стена: разделя колата от стената и, ако се движи към
 * нея, обръща нормалната компонента на скоростта (слаб отскок), остъргва
 * тангенциалната и завърта колата според това кой край е ударил.
 *
 * Мутира `state` (x, z, vForward, vLateral, yawRate). Извиква се от sim.js,
 * който вече е намерил най-дълбоко проникналия кръг.
 *
 * @param {import('./physics.js').CarState} state
 * @param {number} sinH   sin(heading), подаден от викащия (смятан веднъж на тик)
 * @param {number} cosH   cos(heading)
 * @param {number} pushX  Нормала на стената КЪМ трасето (единичен вектор) —
 *                        посоката, в която стената бута колата
 * @param {number} pushZ
 * @param {number} depth  Проникване на най-дълбокия кръг, м (> 0)
 * @param {number} circleSign +1 = удари предният кръг, −1 = задният
 * @returns {number} Нормалната скорост на удара, m/s (0 = само разделяне —
 *          колата вече се отдалечава от стената)
 */
export function resolveWallContact(state, sinH, cosH, pushX, pushZ, depth, circleSign) {
    // ── Разделяне: колата излиза от стената по нормалата ─────────────────
    const push = depth + WALL_MARGIN;
    state.x += pushX * push;
    state.z += pushZ * push;

    // ── Скорост в света (forward = (sin h, cos h), lateral = (cos h, −sin h)) ──
    const vx = state.vForward * sinH + state.vLateral * cosH;
    const vz = state.vForward * cosH - state.vLateral * sinH;

    // Компонента по нормалата: < 0 = движи се навътре в стената.
    const vN = vx * pushX + vz * pushZ;
    if (vN >= 0) {
        return 0;
    }

    const impulse = -vN;

    // Нормалната компонента се обръща със слаб отскок; тангенциалната се
    // остъргва пропорционално на силата на удара (мантинелата „хваща").
    const scrape = 1 - WALL_SCRAPE * Math.min(1, impulse / WALL_SCRAPE_FULL_SPEED);
    const tx = vx - vN * pushX;
    const tz = vz - vN * pushZ;
    const newN = -WALL_RESTITUTION * vN;
    const nvx = tx * scrape + newN * pushX;
    const nvz = tz * scrape + newN * pushZ;

    // Обратно в локалната рамка.
    state.vForward = nvx * sinH + nvz * cosH;
    state.vLateral = nvx * cosH - nvz * sinH;

    // ── Въртящ ритник: ударен нос се отмества по нормалата, задница — обратно ──
    // Знакът идва от страничната компонента на нормалата в рамката на колата
    // (същата конструкция като при кола–кола, с нормала −push за „A").
    const side = pushX * cosH - pushZ * sinH;
    const kick = Math.min(MAX_WALL_YAW_KICK, impulse * WALL_YAW_KICK);
    state.yawRate += clamp(circleSign * side * kick, -MAX_WALL_YAW_KICK, MAX_WALL_YAW_KICK);

    return impulse;
}

/**
 * @param {import('./physics.js').CarState} a
 * @param {import('./physics.js').CarState} b
 * @returns {{a: object, b: object, impulse: number, x: number, z: number}|null}
 */
function resolvePair(a, b) {
    // Бърз отказ: центровете са по-далеч от максималния обхват.
    const dcx = b.x - a.x;
    const dcz = b.z - a.z;
    const reach = 2 * (HALF_LENGTH + CIRCLE_RADIUS);
    if (dcx * dcx + dcz * dcz > reach * reach) {
        return null;
    }

    const aSin = Math.sin(a.heading);
    const aCos = Math.cos(a.heading);
    const bSin = Math.sin(b.heading);
    const bCos = Math.cos(b.heading);

    // Най-дълбокото застъпване измежду 4-те двойки кръгове.
    let deepest = null;

    for (const sa of [1, -1]) {
        const ax = a.x + aSin * HALF_LENGTH * sa;
        const az = a.z + aCos * HALF_LENGTH * sa;

        for (const sb of [1, -1]) {
            const bx = b.x + bSin * HALF_LENGTH * sb;
            const bz = b.z + bCos * HALF_LENGTH * sb;

            const dx = bx - ax;
            const dz = bz - az;
            const distSq = dx * dx + dz * dz;
            const minDist = 2 * CIRCLE_RADIUS;

            if (distSq >= minDist * minDist) {
                continue;
            }

            const dist = Math.sqrt(distSq);
            const depth = minDist - dist;

            if (deepest === null || depth > deepest.depth) {
                // Нормала от A към B; при точно съвпадение — по оста на A.
                const nx = dist > 1e-6 ? dx / dist : aCos;
                const nz = dist > 1e-6 ? dz / dist : -aSin;
                deepest = { depth, nx, nz, sa, sb };
            }
        }
    }

    if (deepest === null) {
        return null;
    }

    const { depth, nx, nz, sa, sb } = deepest;

    // ── Разделяне на позициите (50/50) ───────────────────────────────────
    const push = depth / 2;
    a.x -= nx * push;
    a.z -= nz * push;
    b.x += nx * push;
    b.z += nz * push;

    // ── Скоростен импулс по нормалата ────────────────────────────────────
    // Световни скорости от локалните (forward = (sin h, cos h), lateral е
    // по (cos h, -sin h) — виж physics.js).
    const avx = a.vForward * aSin + a.vLateral * aCos;
    const avz = a.vForward * aCos - a.vLateral * aSin;
    const bvx = b.vForward * bSin + b.vLateral * bCos;
    const bvz = b.vForward * bCos - b.vLateral * bSin;

    // Относителна скорост на B спрямо A по нормалата: < 0 = сближават се.
    const relN = (bvx - avx) * nx + (bvz - avz) * nz;

    if (relN < 0) {
        // Равни маси → импулсът се дели поравно.
        const impulse = Math.min(MAX_IMPULSE, (-(1 + RESTITUTION) * relN) / 2);

        const navx = avx - impulse * nx;
        const navz = avz - impulse * nz;
        const nbvx = bvx + impulse * nx;
        const nbvz = bvz + impulse * nz;

        // Обратно в локалните рамки.
        a.vForward = navx * aSin + navz * aCos;
        a.vLateral = navx * aCos - navz * aSin;
        b.vForward = nbvx * bSin + nbvz * bCos;
        b.vLateral = nbvx * bCos - nbvz * bSin;

        // ── Въртящ ритник при офсетов удар ───────────────────────────────
        // Ударен в предницата → носът се отмества по нормалата; в
        // задницата — обратно. Знакът идва от страничната компонента на
        // нормалата в рамката на всяка кола.
        const aSide = nx * aCos - nz * aSin; // нормалата странично за A
        const bSide = nx * bCos - nz * bSin;
        const kick = Math.min(MAX_YAW_KICK, impulse * YAW_KICK);

        a.yawRate += clamp(-sa * aSide * kick, -MAX_YAW_KICK, MAX_YAW_KICK);
        b.yawRate += clamp(sb * bSide * kick, -MAX_YAW_KICK, MAX_YAW_KICK);

        return {
            a,
            b,
            impulse,
            x: (a.x + b.x) / 2,
            z: (a.z + b.z) / 2,
            // Кой край на всяка кола е в удара и посоката A→B — за съдийството
            // (race.js): нос в задница = вина на задния.
            aFront: sa === 1,
            bFront: sb === 1,
            nx,
            nz,
        };
    }

    // Само разделяне на позициите (застъпване без сближаване) — не е „удар".
    return null;
}

/**
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
}
