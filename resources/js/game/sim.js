/**
 * Чистата симулация на играта: повърхности, фиксирана стъпка, връщане
 * на пистата, хронометър/сектори — И записът на входа.
 *
 * Извадена от Game.js нарочно: файлът няма three.js/DOM зависимости, така че
 * СЪЩИЯТ код тича в браузъра (играта) и в Node (сървърната валидация на
 * обиколките — scripts/game/validate-lap.mjs). Обиколка = запис на входа +
 * начално състояние; повторното изпълнение възпроизвежда времето.
 *
 * Детерминизъм: физиката е чиста функция с фиксирана стъпка; повърхностите
 * (кербове/чакъл/банкинг/ширина) се извеждат детерминирано от данните на
 * пистата + конфига; входът се КВАНТУВА преди употреба (виж tick), така че
 * записаното е точно каквото е играно. Math.sin/cos може да се различават
 * между JS двигатели — затова сървърът сравнява с толеранс, не бит по бит.
 */

import { circuitFor } from './circuits.js';
import { CIRCLE_RADIUS, HALF_LENGTH, resolveWallContact } from './collisions.js';
import { CAR, FIXED_DT, createCarState, step } from './physics.js';
import { bankAt, findKerbRanges, prepareTrack, projectOnTrack } from './track.js';

/** Версия на симулацията — записва се в трейса; при промяна в физиката или
 *  повърхностите се вдига и сървърът знае, че стари трейсове не се повтарят.
 *  v2: излизането от пистата вече не пуска автоматично връщане (времето
 *  тече, обиколката се инвалидира); наказателният рестарт от старта отпадна.
 *  v3: физиката пази изгладеното положение на педалите и новия модел на
 *  гумите/повърхностите; snapshot-ът ги носи, за да остане replay-ят точен. */
export const SIM_VERSION = 3;

/** Брой сектори на обиколка, както в истинската Формула 1. */
export const SECTORS = 3;

/** Продължителност на връщането на пистата (брояч 3-2-1), в тикове. */
const RECOVER_TICKS = 360; // 3 s при 120 Hz

/** Колко дълго извън пистата, преди излизането да „брои" (инвалидира). */
const OFFTRACK_GRACE = 48; // 0.4 s

/** Закъсал: толкова дълго извън пистата под STUCK_SPEED → връщане. Играч,
 *  който се измъква сам, никога не го вижда — времето просто си тече. */
const STUCK_TICKS = 210; // 1.75 s
const STUCK_SPEED = 3.5; // m/s

/** След излизане: толкова тика "охлаждане", преди пресичане на линията да
 *  може да въоръжи ВАЛИДНА обиколка. Спира срязването на последния шикан
 *  в загряващата — иначе то носи безплатна скорост на стартовата права. */
const CUT_COOLDOWN = 600; // 5 s

/** Таван на точките „излизания" в HUD-а (само индикатор, без наказание). */
export const MAX_WARNINGS = 3;

/** Земно ускорение, m/s² — същата SI стойност като във physics.js. */
const GRAVITY = 9.81;

/** Под този праг изгладената DEM кривина е остатъчен шум, не осезаем релеф. */
const VERTICAL_CURVATURE_DEAD_ZONE = 0.0012;

/** Болидът остава залепен за трасето: билото не занулява, а компресията не
 *  умножава безкрайно сцеплението при шумна височинна проба. */
const MIN_LOAD_FACTOR = 0.25;
const MAX_LOAD_FACTOR = 1.8;

/** Период на назъбването на керба, метри — споделен с визуалния ритъм. */
const KERB_PERIOD = 0.9;

/** Под тази скорост без педал държим колата на място върху наклон. */
const HILL_HOLD_SPEED = 0.3;

/** Задържаме сигнала достатъчно за един 30 Hz render кадър при симулация 120 Hz. */
const WALL_HIT_HOLD_TICKS = 4;

/** Метри ПРЕДИ мястото на излизане, на които връщаме колата. */
const RECOVER_LOOKBACK = 25;

/** Дял от скоростта, с който пускаме колата след връщане. */
const RECOVER_SPEED_FACTOR = 0.6;

/** Кадри за ghost/реплей: на всеки колко ОТБРОЕНИ тика пазим позиция.
 *  Споделена с Game.js (духът индексира кадрите по нея). */
export const FRAME_EVERY = 2;

/** Таван на записа: покрива 20-минутния таван на lap_ms на сървъра плюс
 *  резервите за броячи/гейтове. Под него никоя приемлива обиколка не се
 *  режe — отрязан трейс би направил честен бавен играч на „измамник". */
const MAX_TRACE_TICKS = 150000;

/**
 * @typedef {object} LapTrace
 * @property {number} v          SIM_VERSION
 * @property {object} start      Снапшот на състоянието при пресичане на линията
 * @property {Uint8Array} inputs 2 байта на тик: волан (Int8+128) + флагове
 */

/**
 * Създава симулация за писта + стил. Викащият чете публичните полета за
 * HUD/рендер; всичко се мутира само от tick()/reset().
 *
 * @param {import('./track.js').Track} track  Вече минал през prepareTrack
 * @param {import('./circuits.js').CircuitStyle} circuit
 * @param {Simulation|null} [shared] Симулация на СЪЩАТА писта, чиито
 *        повърхностни таблици (кербове/run-off) да се преизползват — AI
 *        съперниците не преизчисляват идентичните сканове на кривината.
 */
export function createSim(track, circuit, shared = null) {
    return new Simulation(track, circuit, shared);
}

/**
 * Удобство за сървъра: от суровия JSON на пистата до готова симулация.
 *
 * @param {object} trackData Съдържанието на {slug}.json
 */
export function createSimFromData(trackData) {
    const circuit = circuitFor(trackData.slug);

    return new Simulation(prepareTrack(trackData, circuit), circuit);
}

class Simulation {
    constructor(track, circuit, shared = null) {
        this.track = track;
        this.circuit = circuit;

        // Повърхности по ред от осевата линия: кербове (яздят се, с вибрация)
        // и run-off зони (чакълът дърпа истински, тревата — както досега).
        // Таблиците са чисто четими след построяване → при подадена сестринска
        // симулация (същата писта) се споделят, вместо да се сканира повторно.
        if (shared !== null) {
            this.kerbSide = shared.kerbSide;
            this.runoffSide = shared.runoffSide;
        } else {
            this.kerbSide = new Int8Array(track.count);
            for (const range of findKerbRanges(track)) {
                for (let r = range.from; r <= range.to; r++) {
                    this.kerbSide[((r % track.count) + track.count) % track.count] = range.side;
                }
            }

            // Битови флагове (1 = зона отдясно/+1, 2 = отляво/-1): в шикан
            // двете страни имат чакъл на съседни редове.
            this.runoffSide = new Uint8Array(track.count);
            if (circuit.runoff !== 'none') {
                for (const range of runoffRanges(track)) {
                    const bit = range.side < 0 ? 1 : 2; // зоната е от -side страната
                    for (let r = range.from; r <= range.to; r++) {
                        this.runoffSide[((r % track.count) + track.count) % track.count] |= bit;
                    }
                }
            }
        }

        this.runoffPhysics =
            circuit.runoff === 'gravel'
                ? { gripFactor: 0.28, drag: 13 }
                : circuit.runoff === 'asphalt'
                    ? { gripFactor: 0.75, drag: 3.5 }
                    : null;

        this.state = createCarState(track);
        this.surface = { height: track.ys[0], gradient: track.gradient[0], bank: 0 };
        this.trackIndexHint = null;
        this.offSurface = null; // 'gravel' | 'asphalt' | 'grass' | null
        this.onKerb = false;

        // AI съперниците (Game.js) карат в собствени симулации, чиито обиколки
        // никого не интересуват — флагът спира записа им (памет за нищо).
        this.recordEnabled = true;

        // Старт от решетката (състезание): колата стои ЗАД линията и първото
        // пресичане е потеглянето, не начало на летяща обиколка — прескача се,
        // за да е обиколка 1 бойна, а хронометрираната да тръгва на скорост
        // (сравнима с класацията). Game го сеща след нареждане на решетката.
        this.gridCrossingsToSkip = 0;

        // Преизползвани обекти — нула алокации на тик.
        this._projection = {};
        this._wallProjections = [{}, {}];
        this._input = { steer: 0, throttle: 0, brake: 0 };
        this._stepOptions = { onKerb: false, kerbPhase: 0, loadFactor: 1, bankAccel: 0 };
        this._simTick = 0;
        this._wallHitHold = 0;

        this.bestLapTicks = null;
        this.lastLapTicks = null;
        this.lastSectors = [null, null, null];

        this.#resetLapState();
    }

    /**
     * Връща колата на стартовата линия.
     *
     * @param {boolean} keepRecords Дали рекордът да се запази
     */
    reset(keepRecords = true) {
        // Мутира се НА МЯСТО: Game държи живи референции към state/surface
        // (avoidance списъци, контакти, рендер) — подмяна на обекта ги
        // превръща в замразени „фантоми".
        Object.assign(this.state, createCarState(this.track));
        this.surface.height = this.track.ys[0];
        this.surface.gradient = this.track.gradient[0];
        this.surface.bank = 0;
        this.trackIndexHint = null;
        this.offSurface = null;
        this.onKerb = false;
        this._simTick = 0;
        this._wallHitHold = 0;

        if (!keepRecords) {
            this.bestLapTicks = null;
            this.lastLapTicks = null;
            this.lastSectors = [null, null, null];
        }

        this.#resetLapState();
    }

    /**
     * Една стъпка на симулацията (FIXED_DT). Входът се квантува ТУК — така
     * записаното е точно каквото е играно, и повторението е идентично.
     *
     * @param {{steer: number, throttle: number, brake: number}} rawInput
     * @returns {null|{type: 'finished', lapMs: number, sectorsMs: Array<number|null>,
     *          valid: boolean, lapTicks: number, trace: LapTrace|null,
     *          frames: Float32Array|null}}
     */
    tick(rawInput) {
        const input = quantizeInput(rawInput, this._input);
        this._simTick++;

        // wallHit е презентационен изход: задържа се четири физични тика, за
        // да не бъде пропуснат между два render кадъра, после се изчиства.
        if (this._wallHitHold > 1) {
            this._wallHitHold--;
        } else {
            this._wallHitHold = 0;
            this.state.out.wallHit = null;
        }

        // Запис: всеки тик от летящата обиколка (вкл. броячите на връщане —
        // повторението ги възпроизвежда само, но тиковете трябва да са 1:1).
        // Прелее ли таванът, ЦЕЛИЯТ запис пада (не отрязан — отрязан трейс не
        // се преиграва докрай и би минал за фалшификат).
        if (this.recording) {
            if (this.recInputs.length >= MAX_TRACE_TICKS * 2) {
                this.recording = false;
                this.recInputs = [];
                this.recFrames = [];
                this.recStart = null;
            } else {
                pushTraceInput(this.recInputs, input);
            }
        }

        // Връщане на пистата: колата стои на респ. точката, брои 3-2-1.
        if (this.recovering) {
            this.recoverTicks--;
            if (this.recoverTicks <= 0) {
                this.#completeRecovery();
            }
            return null;
        }

        const projection = projectOnTrack(
            this.track,
            this.state.x,
            this.state.z,
            this.trackIndexHint,
            this._projection
        );
        this.trackIndexHint = projection.index;

        // Банкингът накланя платното: височината под колата зависи и от
        // страничното отместване; интерполиран между точките (bankAt).
        const bank = bankAt(this.track, projection.index, projection.along);
        this.surface.height = projection.height - projection.lateral * bank;
        this.surface.gradient = projection.gradient;
        this.surface.bank = bank;

        // Кербовете се броят за трасе (реалните track limits): пълно сцепление
        // + вибрация, без предупреждения. Извън тях повърхността определя
        // наказанието — чакълът е капан, асфалтовият апрон прощава.
        const half = this.track.halfWidths[projection.index];
        const absLateral = Math.abs(projection.lateral);
        const lateralSide = projection.lateral > 0 ? 1 : -1;
        const strictlyOn = absLateral < half;
        const kerbHere = this.kerbSide[projection.index] === lateralSide;
        const onTrack = strictlyOn || (kerbHere && absLateral < half + 1.15);

        let offRoad = null;
        if (!onTrack) {
            const zoneBit = lateralSide > 0 ? 1 : 2;
            if (
                this.runoffPhysics &&
                (this.runoffSide[projection.index] & zoneBit) !== 0 &&
                absLateral < half + 8
            ) {
                offRoad = this.runoffPhysics;
                this.offSurface = this.circuit.runoff;
            } else {
                this.offSurface = 'grass';
            }
        } else {
            this.offSurface = null;
        }
        this.onKerb = onTrack && kerbHere && absLateral > half - 0.45;

        if (onTrack) {
            this.offTrackTicks = 0;
            if (this.cutCooldown > 0) {
                this.cutCooldown--;
            }
            this.#rememberSafeState(projection.index);
        } else {
            this.offTrackTicks++;

            // Броят на излизанията — наказанията в състезание (race.js). По
            // ръб: едно излизане = едно наказание, колкото и да трае.
            if (this.offTrackTicks === OFFTRACK_GRACE + 1) {
                this.excursions++;
            }

            // Реални track limits: излизането НЕ прекъсва карането — времето
            // си тече, но летящата обиколка става невалидна (иначе срязването
            // на шикан е безплатно предимство за класацията). Проверката е по
            // НИВО (>), не по ръб (===): обиколка, въоръжена по средата на
            // излизане, се инвалидира на следващия тик, а не никога.
            if (this.offTrackTicks > OFFTRACK_GRACE) {
                if (this.phase === 'flying' && this.lapValid) {
                    this.lapValid = false;
                    this.warnings++;
                }
                // Прясното срязване отравя и СЛЕДВАЩОТО въоръжаване (виж
                // #armFlyingLap) — вкл. срязан последен шикан в загряващата.
                this.cutCooldown = CUT_COOLDOWN;
            }

            // Връщане на пистата САМО при закъсване (заровен в чакъла, опрян
            // в стена) — който може, се измъква сам.
            if (
                this.offTrackTicks > STUCK_TICKS &&
                Math.abs(this.state.vForward) < STUCK_SPEED &&
                this.phase !== 'finished'
            ) {
                this.#beginRecovery();
                return null;
            }
        }

        // Банкираният завой носи реално повече странична хватка.
        const bankGrip = 1 + Math.min(0.35, Math.abs(bank) * 1.1);

        // Нормалният товар от релефа е N/(m·g) = 1 + v²·κᵥ/g. Мъртвата зона
        // премахва остатъчния шум от DEM на равните писти; таваните държат
        // аркадния модел стабилен при връх/компресия с висока скорост.
        const rawVerticalCurvature = sampleCyclic(
            this.track.vertCurv,
            projection.index,
            projection.along,
            this.track.spacing,
            this.track.count
        );
        const verticalCurvature =
            Math.abs(rawVerticalCurvature) < VERTICAL_CURVATURE_DEAD_ZONE
                ? 0
                : rawVerticalCurvature;
        const speedSq = this.state.vForward * this.state.vForward;

        const stepOptions = this._stepOptions;
        stepOptions.onKerb = this.onKerb;
        const kerbTurns = projection.distance / KERB_PERIOD;
        stepOptions.kerbPhase = kerbTurns - Math.floor(kerbTurns);
        stepOptions.loadFactor = Math.max(
            MIN_LOAD_FACTOR,
            Math.min(MAX_LOAD_FACTOR, 1 + (speedSq * verticalCurvature) / GRAVITY)
        );
        // bank > 0 сваля +нормалата (дясно), а +vLateral е наляво: знакът е −.
        stepOptions.bankAccel = (-GRAVITY * bank) / Math.sqrt(1 + bank * bank);
        this.state.out.kerbSide = this.onKerb ? lateralSide : 0;

        // Без отделен съединител/ръчна спирачка гравитацията би потеглила
        // болида назад още на стартова решетка с лек наклон. Под прага за
        // пълно спиране и без команда от педалите държим надлъжната ос.
        const hillHold =
            Math.abs(this.state.vForward) < HILL_HOLD_SPEED &&
            input.throttle === 0 &&
            input.brake === 0;
        const longitudinalGradient = hillHold ? 0 : projection.gradient;

        step(
            this.state,
            input,
            FIXED_DT,
            onTrack,
            longitudinalGradient,
            offRoad,
            bankGrip,
            stepOptions
        );
        if (hillHold && this.state.vForward < 0) {
            this.state.vForward = 0;
        }
        this.#resolveWalls();

        return this.#updateLapTiming(projection);
    }

    // ── Вътрешни ─────────────────────────────────────────────────────────

    /**
     * Проверява двата кръга на болида срещу стените след интегрирането на
     * позицията. Разрешава само най-дълбокото проникване за тика, за да няма
     * два противоречиви импулса при нос/задница върху различни редове.
     */
    #resolveWalls() {
        const state = this.state;
        const sinH = Math.sin(state.heading);
        const cosH = Math.cos(state.heading);
        let deepest = null;

        for (let c = 0; c < 2; c++) {
            const circleSign = c === 0 ? 1 : -1;
            const circleX = state.x + sinH * HALF_LENGTH * circleSign;
            const circleZ = state.z + cosH * HALF_LENGTH * circleSign;
            const projection = projectOnTrack(
                this.track,
                circleX,
                circleZ,
                this.trackIndexHint,
                this._wallProjections[c]
            );
            const rightWall = sampleCyclic(
                this.track.wallRight,
                projection.index,
                projection.along,
                this.track.spacing,
                this.track.count
            );
            const leftWall = sampleCyclic(
                this.track.wallLeft,
                projection.index,
                projection.along,
                this.track.spacing,
                this.track.count
            );
            const rightDepth = projection.lateral + CIRCLE_RADIUS - rightWall;
            const leftDepth = -projection.lateral + CIRCLE_RADIUS - leftWall;

            if (rightDepth > 0 && (deepest === null || rightDepth > deepest.depth)) {
                deepest = {
                    depth: rightDepth,
                    pushX: -this.track.nx[projection.index],
                    pushZ: -this.track.nz[projection.index],
                    circleSign,
                };
            }
            if (leftDepth > 0 && (deepest === null || leftDepth > deepest.depth)) {
                deepest = {
                    depth: leftDepth,
                    pushX: this.track.nx[projection.index],
                    pushZ: this.track.nz[projection.index],
                    circleSign,
                };
            }
        }

        if (deepest === null) {
            return;
        }

        const impulse = resolveWallContact(
            state,
            sinH,
            cosH,
            deepest.pushX,
            deepest.pushZ,
            deepest.depth,
            deepest.circleSign
        );

        if (impulse > 0) {
            state.out.wallHit = {
                impulse,
                nx: deepest.pushX,
                nz: deepest.pushZ,
                tick: this._simTick,
            };
            this._wallHitHold = WALL_HIT_HOLD_TICKS;
        }
    }

    #resetLapState() {
        this.lapTicks = 0;
        this.sectorsVisited = new Array(SECTORS).fill(false);
        this.lastProgress = 0;
        // 'formation' (загряваща) → 'flying' (квалификационната) → 'finished'.
        this.phase = 'formation';
        this.lapValid = true;
        this.sectorTicks = new Array(SECTORS).fill(null);
        this.currentSector = 0;

        this.gridCrossingsToSkip = 0;
        this.recovering = false;
        this.recoverTicks = 0;
        this.recoverReleaseSpeed = 0;
        this.recoverResumeSpeed = 0;
        this.recoverTarget = null;
        this.offTrackTicks = 0;
        this.cutCooldown = 0;
        this.warnings = 0;
        // Излизания от reset насам — за разлика от warnings не се нулират
        // между обиколките, защото наказанието в състезание е за цялата дистанция.
        this.excursions = 0;
        this.timerGated = false;
        this.gateDistance = 0;
        this.safeState = this.#safeStateAt(0, 0);
        // Рендерът да не интерполира през телепорт.
        this.snapRender = false;

        // Запис на летящата обиколка (входове + кадри за ghost/реплей).
        this.recording = false;
        this.recInputs = [];
        this.recFrames = [];
        this.recStart = null;
    }

    /**
     * Въоръжава хронометъра за нова летяща обиколка и стартира записа: пълен
     * снапшот на състоянието + чисти буфери. Повторението тръгва оттук.
     *
     * @param {number} sector
     */
    #armFlyingLap(sector) {
        this.lapTicks = 0;
        // Обиколка, тръгнала след прясно срязване (вкл. срязан последен
        // шикан в предишната), е невалидна от раждането си — иначе изходната
        // скорост от срязването е подарък за класацията.
        this.lapValid = this.cutCooldown === 0;
        this.sectorsVisited = new Array(SECTORS).fill(false);
        this.sectorsVisited[sector] = true;
        this.sectorTicks = new Array(SECTORS).fill(null);
        this.currentSector = sector;
        this.timerGated = false;

        this.recording = this.recordEnabled;
        this.recInputs = [];
        this.recFrames = [];
        const s = this.state;
        this.recStart = {
            x: s.x,
            z: s.z,
            heading: s.heading,
            vForward: s.vForward,
            vLateral: s.vLateral,
            steer: s.steer,
            throttlePedal: s.throttlePedal,
            brakePedal: s.brakePedal,
            yawRate: s.yawRate,
            slip: s.slip,
            hint: this.trackIndexHint,
            lastProgress: this.lastProgress,
            sector,
            // Track-limits състоянието влиза в снапшота — иначе живото и
            // преиграването се разминават по lapValid (обиколка, въоръжена по
            // средата на излизане или след прясно срязване).
            offTrack: this.offTrackTicks,
            cut: this.cutCooldown,
        };
    }

    /**
     * Състезание: веднага нова летяща обиколка от текущата позиция (вика се
     * НА пресичането, което току-що завърши предната). Без това следващата
     * обиколка минава като 'formation' — нехронометрирана и незаписана.
     */
    rearmFlyingLap() {
        const sector = Math.min(SECTORS - 1, Math.floor(this.lastProgress * SECTORS));
        this.phase = 'flying';
        this.#armFlyingLap(sector);
    }

    /**
     * Възстановява симулацията от снапшот на записа — сървърното повторение
     * стартира летящата обиколка точно откъдето е тръгнала при играча.
     *
     * @param {object} start LapTrace.start
     */
    restoreForReplay(start) {
        this.reset(false);
        Object.assign(this.state, {
            x: start.x,
            z: start.z,
            heading: start.heading,
            vForward: start.vForward,
            vLateral: start.vLateral,
            steer: start.steer,
            throttlePedal: start.throttlePedal ?? 0,
            brakePedal: start.brakePedal ?? 0,
            yawRate: start.yawRate,
            slip: start.slip,
        });
        this.trackIndexHint = start.hint;
        this.lastProgress = start.lastProgress;
        this.phase = 'flying';
        this.warnings = 0;
        // Преди въоръжаването — #armFlyingLap чете cutCooldown за lapValid.
        this.offTrackTicks = start.offTrack ?? 0;
        this.cutCooldown = start.cut ?? 0;
        this.#armFlyingLap(start.sector);
        // Повторението не записва повторно.
        this.recording = false;
    }

    #rememberSafeState(index) {
        const safe = this.safeState;
        safe.index = index;
        safe.x = this.track.xs[index];
        safe.z = this.track.zs[index];
        safe.heading = Math.atan2(this.track.tx[index], this.track.tz[index]);
        safe.speed = this.state.vForward;
    }

    #safeStateAt(index, speed = 0) {
        return {
            index,
            x: this.track.xs[index],
            z: this.track.zs[index],
            heading: Math.atan2(this.track.tx[index], this.track.tz[index]),
            speed,
        };
    }

    #beginRecovery() {
        const preOffSpeed = this.safeState.speed;
        const offset = Math.round(RECOVER_LOOKBACK / this.track.spacing);
        const count = this.track.count;
        const index = (((this.safeState.index - offset) % count) + count) % count;
        const target = this.#safeStateAt(index, preOffSpeed);

        this.recoverReleaseSpeed = preOffSpeed * RECOVER_SPEED_FACTOR;
        this.recovering = true;
        this.recoverTicks = RECOVER_TICKS;
        this.recoverResumeSpeed = preOffSpeed;
        this.offTrackTicks = 0;

        this.#placeCarAt(target);
    }

    #placeCarAt(target) {
        this.state.x = target.x;
        this.state.z = target.z;
        this.state.heading = target.heading;
        this.state.vForward = 0;
        this.state.vLateral = 0;
        this.state.yawRate = 0;
        this.state.steer = 0;
        this.state.slip = 0;

        this.trackIndexHint = target.index;
        this.surface.height = this.track.ys[target.index];
        this.surface.gradient = this.track.gradient[target.index];
        // Наклонът на респ. точката — колата ляга на банкирания меш.
        this.surface.bank = this.track.bankSlope[target.index];
        this.recoverTarget = target;
        this.snapRender = true;

        this.offSurface = null;
        this.onKerb = false;
    }

    #completeRecovery() {
        this.recovering = false;

        this.state.vForward = this.recoverReleaseSpeed;
        this.state.vLateral = 0;
        this.state.yawRate = 0;

        const target = this.recoverTarget;
        this.lastProgress = target.index / this.track.count;

        // „Безплатни" са само метрите назад до мястото на излизане.
        this.timerGated = true;
        this.gateDistance = RECOVER_LOOKBACK;
    }

    /**
     * @param {{lateral: number, distance: number}} projection
     * @returns {null|object} 'finished' събитие при пълна обиколка
     */
    #updateLapTiming(projection) {
        const progress = clamp01(projection.distance / this.track.length);

        if (this.phase === 'finished') {
            this.lastProgress = progress;
            return null;
        }

        const sector = Math.min(SECTORS - 1, Math.floor(progress * SECTORS));

        if (this.phase === 'flying') {
            if (this.timerGated) {
                // „Безплатни" са само метрите до мястото на излизане.
                this.gateDistance -= Math.max(0, this.state.vForward) * FIXED_DT;
                if (this.state.vForward >= this.recoverResumeSpeed || this.gateDistance <= 0) {
                    this.timerGated = false;
                }
            }
            if (!this.timerGated) {
                this.lapTicks++;

                // Кадър за ghost/реплей на всеки FRAME_EVERY отброени тика —
                // 1:1 с времето на обиколката, паузите (гейт) паузират и духа.
                if (this.recording && this.lapTicks % FRAME_EVERY === 0) {
                    this.recFrames.push(this.state.x, this.state.z, this.state.heading);
                }
            }
        }

        this.sectorsVisited[sector] = true;

        if (sector !== this.currentSector) {
            if (
                this.phase === 'flying' &&
                sector === this.currentSector + 1 &&
                this.sectorTicks[this.currentSector] === null
            ) {
                this.sectorTicks[this.currentSector] = this.lapTicks;
            }
            this.currentSector = sector;
        }

        const wrappedForward = this.lastProgress > 0.85 && progress < 0.15;
        const wrappedBackward = this.lastProgress < 0.15 && progress > 0.85;

        this.lastProgress = progress;

        if (wrappedForward) {
            this.timerGated = false;

            if (this.gridCrossingsToSkip > 0) {
                // Потеглянето от решетката — не е нито летяща, нито завършена.
                this.gridCrossingsToSkip--;
            } else if (this.phase === 'formation') {
                this.phase = 'flying';
                this.warnings = 0;
                this.#armFlyingLap(sector);
            } else if (this.phase === 'flying' && this.sectorsVisited.every(Boolean)) {
                return this.#finishLap();
            } else {
                // Непълна обиколка — хронометрираме отначало (и нов запис).
                this.#armFlyingLap(sector);
            }
        } else if (wrappedBackward && this.phase === 'flying') {
            // Мина линията на заден ход — назад към загряваща, без запис.
            this.phase = 'formation';
            this.lapTicks = 0;
            this.recording = false;
        }

        return null;
    }

    #finishLap() {
        const [s1End, s2End] = this.sectorTicks;
        const sectorTicks =
            s1End !== null && s2End !== null
                ? [s1End, s2End - s1End, this.lapTicks - s2End]
                : [null, null, null];

        this.lastLapTicks = this.lapTicks;
        this.lastSectors = sectorTicks;

        if (this.lapValid && (this.bestLapTicks === null || this.lapTicks < this.bestLapTicks)) {
            this.bestLapTicks = this.lapTicks;
        }

        this.phase = 'finished';

        const toMs = (ticks) => (ticks === null ? null : Math.round(ticks * FIXED_DT * 1000));

        const trace = this.recording && this.recStart
            ? { v: SIM_VERSION, start: this.recStart, inputs: Uint8Array.from(this.recInputs) }
            : null;
        const frames = this.recFrames.length > 0 ? Float32Array.from(this.recFrames) : null;
        this.recording = false;

        return {
            type: 'finished',
            lapMs: toMs(this.lapTicks),
            sectorsMs: sectorTicks.map(toMs),
            valid: this.lapValid,
            lapTicks: this.lapTicks,
            trace,
            frames,
        };
    }
}

// ── Повърхностни диапазони (споделени с decor.js) ────────────────────────

/**
 * Диапазони с |кривина| над праг — суровината за чакъл/табели/гуми в decor
 * и за run-off физиката тук. Живее в sim, за да няма three.js по веригата.
 *
 * @param {import('./track.js').Track} track
 * @param {number} minCurv
 * @param {number} minLen
 * @returns {Array<{from: number, to: number, side: number, peak: number}>}
 */
export function curvatureRanges(track, minCurv, minLen) {
    const { curvature, count } = track;
    const ranges = [];
    let current = null;

    for (let i = 0; i < count; i++) {
        const k = curvature[i];
        const side = k > minCurv ? 1 : k < -minCurv ? -1 : 0;

        if (side === 0) {
            if (current) {
                ranges.push(current);
                current = null;
            }
            continue;
        }

        if (current && current.side === side) {
            current.to = i;
            current.peak = Math.max(current.peak, Math.abs(k));
        } else {
            if (current) {
                ranges.push(current);
            }
            current = { from: i, to: i, side, peak: Math.abs(k) };
        }
    }

    if (current) {
        ranges.push(current);
    }

    return ranges.filter((r) => r.to - r.from >= minLen);
}

/**
 * Диапазоните на run-off зоните (същите като buildRunoffZones строи).
 *
 * @param {import('./track.js').Track} track
 * @returns {Array<{from: number, to: number, side: number}>}
 */
export function runoffRanges(track) {
    return curvatureRanges(track, 0.014, 4).map((r) => ({
        from: r.from - 14,
        to: r.to + 6,
        side: r.side,
    }));
}

// ── Сериализация на трейс/кадри (localStorage и POST към сървъра) ────────

/**
 * @param {LapTrace} trace
 * @returns {string} JSON с base64 входове — готово за POST/localStorage
 */
export function encodeTrace(trace) {
    return JSON.stringify({
        v: trace.v,
        start: trace.start,
        inputs: bytesToBase64(trace.inputs),
    });
}

/**
 * @param {string} encoded
 * @returns {LapTrace|null}
 */
export function decodeTrace(encoded) {
    try {
        const raw = JSON.parse(encoded);
        return {
            v: raw.v,
            start: raw.start,
            inputs: base64ToBytes(raw.inputs),
        };
    } catch {
        return null;
    }
}

/**
 * @param {Float32Array} frames
 * @returns {string}
 */
export function encodeFrames(frames) {
    return bytesToBase64(new Uint8Array(frames.buffer, frames.byteOffset, frames.byteLength));
}

/**
 * @param {string} encoded
 * @returns {Float32Array|null}
 */
export function decodeFrames(encoded) {
    try {
        const bytes = base64ToBytes(encoded);
        return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
    } catch {
        return null;
    }
}

/**
 * Квантува суровия вход така, както симулацията го изиграва: волан на 1/127
 * (аналоговият tilt), газ/спирачка на бит. Записът и повторението минават
 * през СЪЩАТА функция — иначе записаното не е точно изиграното.
 *
 * @param {{steer: number, throttle: number, brake: number}} rawInput
 * @param {{steer: number, throttle: number, brake: number}} out
 */
export function quantizeInput(rawInput, out) {
    const steer = Math.max(-1, Math.min(1, rawInput.steer));
    out.steer = Math.round(steer * 127) / 127;
    out.throttle = rawInput.throttle > 0.5 ? 1 : 0;
    out.brake = rawInput.brake > 0.5 ? 1 : 0;

    return out;
}

/**
 * Добавя вече квантуван вход като 2 байта: волан (Int8+128) + флагове.
 *
 * @param {number[]} target
 * @param {{steer: number, throttle: number, brake: number}} input
 */
export function pushTraceInput(target, input) {
    target.push(Math.round(input.steer * 127) + 128, (input.throttle ? 1 : 0) | (input.brake ? 2 : 0));
}

/**
 * Разопакова записан вход обратно в {steer, throttle, brake} за tick().
 *
 * @param {Uint8Array} inputs
 * @param {number} tickIndex
 * @param {{steer: number, throttle: number, brake: number}} out
 */
export function readTraceInput(inputs, tickIndex, out) {
    const steerByte = inputs[tickIndex * 2];
    const flags = inputs[tickIndex * 2 + 1];

    out.steer = (steerByte - 128) / 127;
    out.throttle = flags & 1 ? 1 : 0;
    out.brake = flags & 2 ? 1 : 0;

    return out;
}

/** btoa/Buffer — каквото има в средата (браузър или Node). */
export function bytesToBase64(bytes) {
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(bytes).toString('base64');
    }
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(binary);
}

export function base64ToBytes(encoded) {
    if (typeof Buffer !== 'undefined') {
        return new Uint8Array(Buffer.from(encoded, 'base64'));
    }
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/** Линейна циклична проба от таблица по подпозицията след даден ред. */
function sampleCyclic(values, index, along, spacing, count) {
    const steps = along / spacing;
    const base = Math.floor(steps);
    const t = steps - base;
    const a = values[(((index + base) % count) + count) % count];
    const b = values[(((index + base + 1) % count) + count) % count];

    return a + (b - a) * t;
}

/**
 * @param {number} v
 * @returns {number}
 */
function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
