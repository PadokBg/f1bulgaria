/**
 * Полуавтоматична трансмисия — само за оборотомера, индикатора на предавката и
 * звука. НЕ пипа физиката (там тягата е константна, виж physics.js): това е
 * визуално-звуков слой върху скоростта.
 *
 * По регламента от 2026 г.: 8 предавки напред + 1 задна, таван на оборотите
 * 15 000 об/мин. Таванът не е работният диапазон: над 10 500 об/мин
 * енергията на горивото е ограничена, затова болидите сменят около
 * 11 500–12 000 — стрелката и звукът следват реалния диапазон (SHIFT_RPM).
 * Сменя автоматично нагоре в края на предавката и надолу при падане на
 * оборотите (с хистерезис, за да не „лови" на границата).
 *
 * Два вида обороти живеят в обекта:
 * - `rpm` — геометричните (скорост ÷ предавка). Те решават смените и са
 *   детерминирани спрямо скоростта.
 * - `visualRpm` — „каквото чува ухото и вижда стрелката": задържане при
 *   качване (ignition cut), blip при сваляне, буксуващ съединител при
 *   потегляне, отскок в лимитера на ръчната. Чисто козметичен слой; звукът и
 *   HUD-ът четат него.
 */

/** Таванът на оборотите по регламента от 2026 г. — само лимитерът на ръчната го опира. */
export const REDLINE = 15000;

/**
 * Оборотите в края на всяка предавка (при GEAR_TOP). Работният връх на
 * двигателите от 2026 г.; оборотомерът и звукът са в този мащаб.
 */
export const SHIFT_RPM = 12200;

/** Обороти на празен ход (F1 върти високо). */
const IDLE = 4000;

/**
 * Прагове за автоматична смяна (хистерезис между тях спира трептенето).
 * Спрямо [IDLE, SHIFT_RPM] са на същите дялове като старите 14 600/8 500
 * спрямо [IDLE, 15 000] — смените стават при същите скорости, сменя се
 * само мащабът на оборотите.
 */
const UPSHIFT = 11900;
const DOWNSHIFT = 7350;

/**
 * Скорост (m/s), при която всяка предавка стига SHIFT_RPM. 8-ма опира
 * максималната скорост на болида (~92 m/s ≈ 331 km/h). Прогресията е плавна.
 */
const GEAR_TOP = [15, 23, 32, 42, 53, 65, 78, 95];

/**
 * Козметика на visualRpm. Качване: ignition cut държи оборотите 50 ms и
 * после ги пуска за 80 ms (безшевната кутия сменя без пауза, но оборотите не
 * падат мигновено). Сваляне: авто-blip +900 об/мин за 100 ms. Потегляне:
 * под 8 m/s съединителят буксува и двигателят следва газта, не колелата.
 * Лимитер (ръчна): стрелката подскача ~12 Hz в 260 об/мин под тавана.
 */
const UPSHIFT_HOLD = 0.05;
const UPSHIFT_EASE = 0.08;
const DOWNSHIFT_BLIP = 900;
const DOWNSHIFT_BLIP_TIME = 0.1;
const CLUTCH_SPEED = 8;
const CLUTCH_THROTTLE_SHARE = 0.55;
const LIMITER_BOUNCE = 260;
const LIMITER_BOUNCE_RATE = 75;
const VISUAL_TAU = 0.03;

/**
 * @typedef {object} Drivetrain
 * @property {number} gear        1..8 напред, 0 = заден (R)
 * @property {number} rpm         геометрични обороти (решават смените)
 * @property {number} visualRpm   козметични обороти за звук/HUD
 * @property {boolean} reverse
 * @property {boolean} manual
 * @property {boolean} limiter    ръчна + опрян лимитер + газ (звукът „бие")
 * @property {number} shifted     изход за кадъра: 1 = качи, -1 = свали, 0 = без смяна
 * @property {number} pendingShift ръчна смяна (W/S) между два кадъра, чака updateDrivetrain
 * @property {number} shiftKind   0 = няма, 1 = качване, -1 = сваляне (тече envelope)
 * @property {number} shiftTimer  секунди от началото на envelope-а
 * @property {number} shiftFrom   visualRpm в момента на смяната
 * @property {number} time        натрупано време за отскока в лимитера
 */

/**
 * @param {boolean} [manual]  ръчна трансмисия (играчът сменя с W/S)
 * @returns {Drivetrain}
 */
export function createDrivetrain(manual = false) {
    return {
        gear: 1,
        rpm: IDLE,
        visualRpm: IDLE,
        reverse: false,
        manual,
        limiter: false,
        shifted: 0,
        pendingShift: 0,
        shiftKind: 0,
        shiftTimer: 0,
        shiftFrom: IDLE,
        time: 0,
    };
}

/**
 * Ръчна смяна нагоре (W). От заден ход/неутрално → 1-ва (не е „смяна" за
 * ухото). Клавишът идва между два кадъра, затова смяната се записва като
 * чакаща — updateDrivetrain я обявява в `shifted` и пуска envelope-а; иначе
 * сравнението „предавка преди/след" в кадъра никога не я вижда.
 *
 * @param {Drivetrain} train
 */
export function shiftUp(train) {
    if (train.gear < 1) {
        train.gear = 1;
    } else if (train.gear < 8) {
        train.gear++;
        train.pendingShift = 1;
    }
}

/**
 * Ръчна смяна надолу (S). Не влиза в заден ход (той е автоматичен при спиране).
 *
 * @param {Drivetrain} train
 */
export function shiftDown(train) {
    if (train.gear > 1) {
        train.gear--;
        train.pendingShift = -1;
    }
}

/**
 * Обороти за дадена скорост в дадена предавка.
 *
 * @param {number} speed  m/s (>= 0)
 * @param {number} gear   1..8
 * @returns {number}
 */
function rpmFor(speed, gear) {
    const top = GEAR_TOP[gear - 1] ?? GEAR_TOP[GEAR_TOP.length - 1];

    return IDLE + (speed / top) * (SHIFT_RPM - IDLE);
}

/**
 * Обновява оборотите + предавката от скоростта и газта. Мутира `train`.
 *
 * @param {Drivetrain} train
 * @param {number} vForward  надлъжна скорост, m/s (< 0 = заден ход)
 * @param {number} throttle  [0, 1]
 * @param {number} [elapsed] секунди от предния кадър (само за visualRpm)
 * @returns {Drivetrain}
 */
export function updateDrivetrain(train, vForward, throttle, elapsed = 1 / 60) {
    const gearBefore = train.gear;
    const reverseBefore = train.reverse;
    const pending = train.pendingShift;
    train.pendingShift = 0;

    updateGeometric(train, vForward, throttle);

    // Смяната се обявява само между предни предавки — влизането и излизането
    // от заден ход не е „смяна" за ухото. Ръчната (pending) е с предимство;
    // автоматичната може да прескочи няколко предавки наведнъж (телепорт),
    // но за ухото това е една смяна.
    let shifted = 0;
    if (!train.reverse && !reverseBefore) {
        if (pending !== 0) {
            shifted = pending;
        } else if (train.gear !== gearBefore && gearBefore >= 1) {
            shifted = train.gear > gearBefore ? 1 : -1;
        }
    }
    train.shifted = shifted;

    if (shifted !== 0) {
        train.shiftKind = shifted;
        train.shiftTimer = 0;
        train.shiftFrom = train.visualRpm;
    }

    updateVisual(train, vForward, throttle, elapsed);

    return train;
}

/**
 * Геометричните обороти и предавката — непроменена логика.
 *
 * @param {Drivetrain} train
 * @param {number} vForward
 * @param {number} throttle
 */
function updateGeometric(train, vForward, throttle) {
    // Заден ход.
    if (vForward < -0.3) {
        train.reverse = true;
        train.gear = 0;
        const frac = Math.min(1, Math.abs(vForward) / 12);
        train.rpm = IDLE + frac * (SHIFT_RPM - IDLE) * 0.6;

        return;
    }

    train.reverse = false;
    const speed = vForward > 0 ? vForward : 0;

    // ── Ръчна: играчът сменя (shiftUp/shiftDown); без автоматична смяна ──
    if (train.manual) {
        if (train.gear < 1) {
            train.gear = 1; // излизане от заден ход
        }
        let rpm = rpmFor(speed, train.gear);
        if (speed < 2) {
            // Почти в покой оборотите следват газта (двигателят се върти).
            rpm = Math.max(rpm, IDLE + throttle * (SHIFT_RPM - IDLE) * 0.45);
        }
        train.rpm = clamp(rpm, IDLE, REDLINE);

        return;
    }

    // ── Автоматична ──
    if (speed < 2) {
        // Почти в покой: оборотите следват газта (двигателят се върти без движение).
        train.gear = 1;
        train.rpm = clamp(IDLE + throttle * (SHIFT_RPM - IDLE) * 0.45, IDLE, REDLINE);

        return;
    }

    let rpm = rpmFor(speed, train.gear);

    // Пълно догонване в едно извикване (while, не if): при връщането на пистата
    // скоростта скача рязко (телепорт до release speed за една стъпка). Една
    // смяна на кадър оставяше оборотите забити в червено, а предавката
    // „проблясваше" 1→2→3… няколко кадъра, докато настигне.
    while (rpm > UPSHIFT && train.gear < 8) {
        train.gear++;
        rpm = rpmFor(speed, train.gear);
    }
    while (rpm < DOWNSHIFT && train.gear > 1) {
        train.gear--;
        rpm = rpmFor(speed, train.gear);
    }

    train.rpm = clamp(rpm, IDLE, REDLINE);
}

/**
 * Козметичният слой върху геометричните обороти.
 *
 * @param {Drivetrain} train
 * @param {number} vForward
 * @param {number} throttle
 * @param {number} elapsed
 */
function updateVisual(train, vForward, throttle, elapsed) {
    train.time += elapsed;
    let target = train.rpm;

    if (!train.reverse) {
        // Буксуващ съединител: при потегляне двигателят реве по газта, а
        // колелата още не са го „хванали". Тежестта гасне линейно до 8 m/s.
        const speed = vForward > 0 ? vForward : 0;
        if (speed < CLUTCH_SPEED) {
            const clutch = IDLE + throttle * (SHIFT_RPM - IDLE) * CLUTCH_THROTTLE_SHARE;
            const weight = 1 - speed / CLUTCH_SPEED;
            target = Math.max(target, target * (1 - weight) + clutch * weight);
        }
    }

    // Лимитер само на ръчната: автоматичната сменя на 14 600 и никога не го
    // опира. Геометричните са захванати на REDLINE; стрелката подскача.
    train.limiter = train.manual && !train.reverse && train.rpm >= REDLINE - 1 && throttle > 0.05;
    if (train.limiter) {
        target = REDLINE - (LIMITER_BOUNCE * (1 + Math.sin(train.time * LIMITER_BOUNCE_RATE))) / 2;
    }

    if (train.shiftKind === 1) {
        train.shiftTimer += elapsed;
        if (train.shiftTimer < UPSHIFT_HOLD) {
            target = train.shiftFrom;
        } else if (train.shiftTimer < UPSHIFT_HOLD + UPSHIFT_EASE) {
            const k = smoothstep((train.shiftTimer - UPSHIFT_HOLD) / UPSHIFT_EASE);
            target = train.shiftFrom + (target - train.shiftFrom) * k;
        } else {
            train.shiftKind = 0;
        }
    } else if (train.shiftKind === -1) {
        train.shiftTimer += elapsed;
        if (train.shiftTimer < DOWNSHIFT_BLIP_TIME) {
            target += DOWNSHIFT_BLIP * Math.sin((train.shiftTimer / DOWNSHIFT_BLIP_TIME) * Math.PI);
        } else {
            train.shiftKind = 0;
        }
    }

    target = clamp(target, IDLE, REDLINE);

    // Експоненциално догонване: маха стъпалата от кадровата честота, без да
    // размива смените (осцилаторите в звука добавят свои 20 ms).
    const alpha = 1 - Math.exp(-elapsed / VISUAL_TAU);
    train.visualRpm += (target - train.visualRpm) * alpha;
}

/**
 * @param {number} k 0..1
 * @returns {number}
 */
function smoothstep(k) {
    const x = clamp(k, 0, 1);

    return x * x * (3 - 2 * x);
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
