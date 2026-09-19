/**
 * Chase / бордова камера на играта — цялата логика на камерата в
 * играта живее тук (Game.js само вика update/snap/setMode).
 *
 * Принципи:
 *  - Камерата има СОБСТВЕНО изгладено състояние (smoothPos, look, roll, fovH).
 *    camera.position се ПРЕЗАПИСВА всеки кадър = изгладено + шейк, така че
 *    шейкът никога не влиза в интеграцията — амплитудата не зависи от
 *    кадровата честота (старият бъг на 240 Hz с наслагващия се офсет е
 *    структурно невъзможен, не „премахнат преди/добавен след").
 *  - Chase-ът се изравнява с ВЕКТОРА НА СКОРОСТТА, не с носа: при oversteer
 *    колата видимо се завърта в кадъра. Погледът води към апекса (средна
 *    кривина на линията 30 m напред) и с yaw-rate lead.
 *  - Зрителното поле е ХОРИЗОНТАЛНО и се конвертира по аспекта: 21:9 не
 *    става рибешко око, портретният телефон — тунел.
 *  - Коридорна клампа: целта на камерата се проектира върху трасето и се
 *    дърпа към осевата, ако би излязла зад мантинелите (Монако), не потъва
 *    под асфалта и не пробива тавана на тунела.
 *
 * Чисто презентационно: чете sim state/surface, никога не пише в тях.
 */

import * as THREE from 'three';

import { CAR } from './physics.js';
import { heightAt, projectOnTrack } from './track.js';

/** Период на кербовата назъбеност — общ договор (mesh, sim, audio, камера). */
const KERB_PERIOD = 0.9;

/**
 * Настройки по подразбиране. Дистанция/височина са при покой; „s" е
 * smootherstep на скоростта (0..1). FOV стойностите са ХОРИЗОНТАЛНИ градуси.
 * Кокпитът пази почти постоянен ъгъл: големият zoom при скорост мести
 * волана и halo-то в кадъра и прави дистанциите трудни за преценка.
 */
export const CHASE_TUNING = Object.freeze({
    distance: 8.8,
    distanceSpeed: 0.15,
    distanceBrake: 0.15,
    height: 3.35,
    heightSpeed: 0.15,
    lookAhead: 12,
    lookHeight: 0.9,
    followDamping: 6.5,
    lookDamping: 5.5,
    rollDamping: 3.5,
    fovHIdle: 88,
    fovHFast: 90,
    fovBrake: 0.5,
    onboardHeight: 0.62,
    onboardForward: 0.10,
    onboardLookAhead: 55,
    onboardLookHeight: 1.0,
    onboardLookDamping: 14,
    onboardFovHIdle: 96,
    onboardFovHFast: 99,
    onboardRigBlend: 0.18,
    corridorMargin: 5,
    corridorMarginStreet: 0.9,
    floorClearance: 1.4,
    tunnelClearance: 3.0,
    maxYawOffset: 0.2,
});

/**
 * Праг, над който проекционната матрица се преизчислява (градуси). По-широк
 * от 0.01: при почти постоянна скорост да не пресмятаме матрицата всеки кадър.
 */
const FOV_EPSILON = 0.05;

/** Праг за известяване на сенките (CSM updateFrustums) при промяна на FOV. */
const FOV_NOTIFY_EPSILON = 0.5;

/** Скок на болида между два кадъра, над който хинтовете се забравят (m). */
const JUMP_RESET = 20;

const UP = new THREE.Vector3(0, 1, 0);
const TWO_PI = Math.PI * 2;

/**
 * @typedef {object} ChaseCameraOptions
 * @property {object} [circuit] Профил на пистата (streetWalls, tunnel) за коридорната клампа
 * @property {object} [rig] Ригът на болида (root/body) — бордовата камера се закача за body-то
 * @property {THREE.Object3D} [halo] Halo силуетът (дете на камерата) — видим само в 'onboard'
 * @property {THREE.Object3D} [steeringWheel] Воланът в halo-то — върти се със state.steer
 * @property {boolean} [lowPower] Телефон: шейкът наполовина
 * @property {(fovVertical: number) => void} [onFovChange] При |ΔFOV| > 0.5° (сенчестите фрустуми)
 * @property {Partial<typeof CHASE_TUNING>} [tuning]
 */

/**
 * @typedef {object} ChaseCamera
 * @property {'chase'|'onboard'} mode
 * @property {(dt: number, render: object, sim: object, out?: object, mode?: 'chase'|'onboard') => void} update
 * @property {(state: object, surface: {height: number}) => void} snap
 * @property {(mode: 'chase'|'onboard') => void} setMode
 * @property {(strength: number, dirX: number, dirZ: number) => void} kick
 * @property {(strength: number, sourceX: number, sourceZ: number) => void} kickFrom
 * @property {() => number} fovVertical
 * @property {THREE.Vector3} lookTarget Точката на погледа (фокус на motion blur в бордовата)
 * @property {number} rumble Кербовият хийв на болида (m) за rig.body.position.y
 * @property {number} speedRatio smootherstep(|v| / maxSpeed) от последния update
 * @property {number} gLong Изгладено надлъжно ускорение (m/s²)
 * @property {number} gLat Изгладено странично ускорение (m/s²)
 * @property {() => void} dispose
 */

/**
 * @param {THREE.PerspectiveCamera} camera
 * @param {import('./track.js').Track} track
 * @param {ChaseCameraOptions} [options]
 * @returns {ChaseCamera}
 */
export function createChaseCamera(camera, track, options = {}) {
    const circuit = options.circuit ?? null;
    const rig = options.rig ?? null;
    const halo = options.halo ?? null;
    const steeringWheel = options.steeringWheel ?? null;
    const lowPower = options.lowPower === true;
    const onFovChange = typeof options.onFovChange === 'function' ? options.onFovChange : null;
    const T = { ...CHASE_TUNING, ...(options.tuning ?? {}) };
    const externalNear = camera.near;
    let hiddenHelmet = null;
    let helmetWasVisible = true;

    const streetWalls = circuit?.streetWalls === true;
    const tunnel = circuit?.tunnel ?? null;
    const shakeScale = lowPower ? 0.5 : 1;
    const lookAheadPoints = Math.max(1, Math.round(30 / track.spacing));

    // Изгладено състояние на камерата (persistent) — нищо от него не се чете
    // обратно от camera.position.
    const smoothPos = new THREE.Vector3();
    const lookTarget = new THREE.Vector3();
    let hasLook = false;
    let camRoll = 0;
    let fovH = T.fovHIdle;
    let notifiedFov = 0;

    // Ускорения (изгладени 6/s). Надлъжното се акумулира между промени на
    // vForward: state.vForward е от последния ТИК, на 240 Hz половината
    // кадри го виждат непроменен → наивното Δv/dt редува 0 и 2a.
    let gLong = 0;
    let gLat = 0;
    let prevV = 0;
    let accumDt = 0;
    let rawLong = 0;

    // Удар: сила (0..1, гасне exp(−9t)) + посока в XZ; последната позиция на
    // болида дава посоката при kickFrom (контакт с друга кола).
    let kick = 0;
    const kickDir = new THREE.Vector2(0, 1);
    let lastCarX = 0;
    let lastCarZ = 0;

    let effectTime = 0;

    // Хинтирани проекции: колата (височина на погледа, кривина напред, кербов
    // прогрес) и целта на камерата (коридорът). Отделни хинтове — целта е
    // ~10 m зад колата, но на стек хеърпин може да се падне на другия клон.
    let carHint = null;
    let camHint = null;
    const carProj = {};
    const camProj = {};

    // Scratch — нула алокации на кадър.
    const target = new THREE.Vector3();
    const look = new THREE.Vector3();
    const right = new THREE.Vector3();
    const scratch = new THREE.Vector3();
    const rigQuat = new THREE.Quaternion();
    const yawQuat = new THREE.Quaternion();
    const lookQuat = new THREE.Quaternion();
    const lookMatrix = new THREE.Matrix4();
    const eyeLocal = new THREE.Vector3();

    const api = {
        mode: 'chase',
        lookTarget,
        rumble: 0,
        speedRatio: 0,
        gLong: 0,
        gLat: 0,
        update,
        snap,
        setMode,
        kick: applyKick,
        kickFrom,
        fovVertical: () => camera.fov,
        dispose,
    };

    /**
     * @param {'chase'|'onboard'} mode
     */
    function setMode(mode) {
        if (mode !== 'chase' && mode !== 'onboard') {
            return;
        }
        const changed = mode !== api.mode;
        api.mode = mode;
        syncCockpitVisibility();
        if (!changed) return;
        fovH = mode === 'onboard' ? T.onboardFovHIdle : T.fovHIdle;
        applyFov();
        // Погледът да не замахне от старата точка.
        hasLook = false;
    }

    function syncCockpitVisibility() {
        const onboard = api.mode === 'onboard';
        const helmet = onboard ? rig?.helmet ?? null : null;
        if (hiddenHelmet !== helmet) {
            if (hiddenHelmet) hiddenHelmet.visible = helmetWasVisible;
            hiddenHelmet = helmet;
            if (helmet) helmetWasVisible = helmet.visible;
        }
        if (hiddenHelmet) hiddenHelmet.visible = false;
        if (halo) {
            halo.visible = onboard;
        }
        const near = onboard ? 0.045 : externalNear;
        if (camera.near !== near) {
            camera.near = near;
            camera.updateProjectionMatrix();
        }
    }

    function driverEye() {
        // The shipped GLB head centre is (.0, .608, .069). The eye is
        // slightly higher and forward, beneath its real integrated halo.
        // Read the live helmet so an asynchronously attached model also works.
        if (rig?.helmet) {
            eyeLocal.copy(rig.helmet.position);
            eyeLocal.y += 0.012;
            eyeLocal.z += 0.031;
        } else {
            eyeLocal.set(0, T.onboardHeight, T.onboardForward);
        }
        return eyeLocal;
    }

    /**
     * Залепя камерата зад болида веднага (старт, телепорт, край на реплей):
     * без изглаждане, без остатъчен шейк/удар/наклон.
     *
     * @param {object} state {x, z, heading, vForward}
     * @param {{height: number}} surface
     */
    function snap(state, surface) {
        const forwardX = Math.sin(state.heading);
        const forwardZ = Math.cos(state.heading);
        smoothPos.set(
            state.x - forwardX * T.distance,
            surface.height + T.height,
            state.z - forwardZ * T.distance
        );
        hasLook = false;
        camRoll = 0;
        kick = 0;
        gLong = 0;
        gLat = 0;
        rawLong = 0;
        accumDt = 0;
        prevV = state.vForward ?? 0;
        carHint = null;
        camHint = null;

        // Кадърът преди първия update (warmup рендерите) да е смислен.
        camera.position.copy(smoothPos);
        camera.up.copy(UP);
        camera.lookAt(state.x, surface.height + 0.6, state.z);
        syncCockpitVisibility();
        if (api.mode === 'onboard') {
            if (rig) {
                rig.body.updateWorldMatrix(true, false);
                camera.position.copy(rig.body.localToWorld(driverEye()));
                rig.body.getWorldQuaternion(camera.quaternion);
            } else {
                camera.position.set(state.x + forwardX * T.onboardForward,
                    surface.height + T.onboardHeight, state.z + forwardZ * T.onboardForward);
                camera.quaternion.setFromAxisAngle(UP, state.heading);
            }
            camera.rotateY(Math.PI);
        }
    }

    /**
     * Удар по посока (dirX, dirZ) — накъде да ритне камерата (от контакта
     * КЪМ колата). Нормалата на стената (sim out.wallHit.nx/nz) е точно това.
     *
     * @param {number} strength 0..1
     * @param {number} dirX
     * @param {number} dirZ
     */
    function applyKick(strength, dirX, dirZ) {
        const len = Math.hypot(dirX, dirZ);
        if (len > 1e-6) {
            kickDir.set(dirX / len, dirZ / len);
        }
        kick = Math.max(kick, clamp01(strength));
    }

    /**
     * Удар от световна точка (контакт с друга кола): посоката е от контакта
     * към последната позиция на болида.
     *
     * @param {number} strength 0..1
     * @param {number} sourceX
     * @param {number} sourceZ
     */
    function kickFrom(strength, sourceX, sourceZ) {
        applyKick(strength, lastCarX - sourceX, lastCarZ - sourceZ);
    }

    /**
     * @param {number} dt Секунди
     * @param {object} render Интерполирано състояние {x, z, heading, vForward, vLateral, yawRate, steer}
     * @param {object} sim {surface: {height, gradient, bank}, trackIndexHint, onKerb, offSurface}
     * @param {object} [out] sim.state.out (ax, ay, kerbSide…) — по избор
     * @param {'chase'|'onboard'} [mode] Принудителен режим (реплей); иначе текущият
     */
    function update(dt, render, sim, out = undefined, mode = undefined) {
        if (mode !== undefined) {
            setMode(mode);
        }
        syncCockpitVisibility();

        const surface = sim.surface;
        const heading = render.heading;
        const vForward = render.vForward;
        const vLateral = render.vLateral ?? 0;
        const yawRate = render.yawRate ?? 0;
        const speed = Math.abs(vForward);
        const s = THREE.MathUtils.smootherstep(speed / CAR.maxSpeed, 0, 1);
        const forwardX = Math.sin(heading);
        const forwardZ = Math.cos(heading);
        // Дясната нормала на посоката (както track.nx/nz спрямо тангентата).
        const rightX = -forwardZ;
        const rightZ = forwardX;

        // Телепорт (recovery/сеек) без snap(): хинтовете биха останали на
        // стария клон — глобален скан за този кадър.
        if (carHint !== null && Math.hypot(render.x - lastCarX, render.z - lastCarZ) > JUMP_RESET) {
            carHint = null;
            camHint = null;
        }
        lastCarX = render.x;
        lastCarZ = render.z;
        effectTime += dt;

        // ── Ускорения ─────────────────────────────────────────────────────
        accumDt += dt;
        if (out !== undefined && Number.isFinite(out.ax)) {
            rawLong = out.ax;
            accumDt = 0;
        } else if (vForward !== prevV || accumDt > 0.05) {
            rawLong = accumDt > 0 ? clamp((vForward - prevV) / accumDt, -50, 50) : 0;
            prevV = vForward;
            accumDt = 0;
        }
        const rawLat =
            out !== undefined && Number.isFinite(out.ay) ? out.ay : clamp(yawRate * vForward, -40, 40);
        const kg = 1 - Math.exp(-6 * dt);
        gLong += (rawLong - gLong) * kg;
        gLat += (rawLat - gLat) * kg;
        const brakeAmt = clamp01(-gLong / 35);

        // ── Проекция на колата: поглед по височината на трасето НАПРЕД ──
        if (carHint === null && sim.trackIndexHint !== null && sim.trackIndexHint !== undefined) {
            carHint = sim.trackIndexHint;
        }
        projectOnTrack(track, render.x, render.z, carHint, carProj);
        carHint = carProj.index;
        const progressMeters = carProj.distance;

        // Апексът: средна кривина на СЪСТЕЗАТЕЛНАТА линия 30 m напред → погледът
        // се измества към вътрешната страна на идващия завой (+ = надясно).
        const curvAhead = meanCurvatureAhead(carProj.index);
        const apexLateral = clamp(curvAhead * 55, -1.5, 1.5);

        // Вектор на скоростта: β > 0 = плъзгане наляво (физиката: +vLateral е
        // по (cos h, −sin h) = −дясно). Камерата стои зад ВЕКТОРА, не зад носа.
        const slipAngle = Math.atan2(vLateral, Math.max(2, speed));
        const behindYaw = heading + clamp(slipAngle * 0.25, -T.maxYawOffset, T.maxYawOffset);
        const lookYaw =
            heading + clamp(slipAngle * 0.3 + yawRate * 0.12, -T.maxYawOffset, T.maxYawOffset);

        const isOnboard = api.mode === 'onboard';
        const k = 1 - Math.exp(-T.followDamping * dt);

        if (isOnboard) {
            updateOnboard(dt, render, sim, surface, lookYaw, slipAngle, forwardX, forwardZ);
        } else {
            // ── Chase: цел зад вектора на скоростта ───────────────────────
            const distance = T.distance + T.distanceSpeed * s - T.distanceBrake * brakeAmt;
            const height = T.height + T.heightSpeed * s;
            // Леко встрани от плъзгането: задницата се вижда как излиза.
            const sideOffset = -slipAngle * 0.45;
            target.set(
                render.x - Math.sin(behindYaw) * distance + rightX * sideOffset,
                surface.height + height,
                render.z - Math.cos(behindYaw) * distance + rightZ * sideOffset
            );
            clampToCorridor(target);

            if (!hasLook) {
                smoothPos.copy(target);
            } else {
                smoothPos.lerp(target, k);
                // И изгладената позиция: в хеърпин тя реже хордата между две
                // клампнати цели и излиза през вътрешния керб/мантинела.
                clampToCorridor(smoothPos);
            }

            look.set(
                render.x + Math.sin(lookYaw) * T.lookAhead,
                heightAt(track, carProj.index, carProj.along + T.lookAhead) + T.lookHeight,
                render.z + Math.cos(lookYaw) * T.lookAhead
            );
            const ai = (carProj.index + Math.round(T.lookAhead / track.spacing)) % track.count;
            look.x += track.nx[ai] * apexLateral;
            look.z += track.nz[ai] * apexLateral;

            if (!hasLook) {
                lookTarget.copy(look);
                hasLook = true;
            } else {
                lookTarget.lerp(look, 1 - Math.exp(-T.lookDamping * dt));
            }

            camera.position.copy(smoothPos);
            camera.up.copy(UP);
            camera.lookAt(lookTarget);

            // Хоризонтът ляга с банкинга (0.55 от ъгъла) и леко с G. Знак:
            // bank > 0 сваля дясната страна; rotateZ е около +Z на камерата
            // (гледа назад) → отрицателен ъгъл накланя дясното надолу.
            const rollTarget = -(Math.atan(surface.bank ?? 0) * 0.25 + clamp(gLat / 40, -1, 1) * 0.008);
            camRoll += (rollTarget - camRoll) * (1 - Math.exp(-T.rollDamping * dt));
        }

        // ── Шейк: върху презаписаната позиция, никога в изгладената ──────
        const t = effectTime;
        const kickAmp = kick * (isOnboard ? 0.12 : 0.5);
        kick *= Math.exp(-9 * dt);

        // Микро-трептенето е почти незабележимо в chase. Силното движение на
        // камерата спрямо твърдото окачване караше самия болид да изглежда сякаш
        // се клати. На борда остава фин механичен feedback.
        const motionShake = (isOnboard ? 0.35 : 0.08) * shakeScale;
        const a = (0.002 + 0.008 * s * s * s) * motionShake;
        let sy = a * (Math.sin(t * 37) + 0.6 * Math.sin(t * 53));
        const sx = 0.5 * a * Math.sin(t * 29);
        let roll = 0.0025 * s * s * Math.sin(t * 23) * motionShake;

        // Чакълът тресе камерата (по време — по прогреса би алиасирало на
        // 60 fps при 40 m/s).
        if (sim.offSurface === 'gravel' && speed > 4) {
            const gravel = (Math.sin(t * 43) * 0.02 + Math.sin(t * 61) * 0.012) * shakeScale;
            sy += isOnboard ? gravel : gravel * 0.18;
        }

        // Кербът: по ПРОГРЕСА на колата с периода на назъбеността (0.9 m) —
        // същата фаза като кика в sim и дрънченето в audio. Хийвът на болида
        // се изнася през api.rumble.
        let rumble = 0;
        if (sim.onKerb && speed > 8) {
            rumble = Math.sin((progressMeters * TWO_PI) / KERB_PERIOD) * 0.006 * Math.min(1, speed / 45);
        }
        api.rumble = rumble;
        // Бордовата с риг наследява хийва от body-то — не го добавяме два пъти.
        if (isOnboard) {
            if (rig === null) {
                sy += rumble * 0.8;
            }
        } else {
            sy += rumble * 0.08;
        }

        // Удар: ритник по нормалата на контакта + завъртане, гаснещи.
        const kickOff = 0.35 * kickAmp * Math.sin(t * 40);
        roll += 0.06 * kickAmp * Math.sin(t * 35);

        right.set(1, 0, 0).applyQuaternion(camera.quaternion);
        camera.position.x += right.x * sx + kickDir.x * kickOff;
        camera.position.y += sy;
        camera.position.z += right.z * sx + kickDir.y * kickOff;

        if (isOnboard) {
            // G-tilt върху ориентацията от рига: спирачката навежда носа,
            // завоят накланя главата (както досега), плюс шейк ролката.
            camera.rotateX(clamp(gLong, -50, 50) * 0.0007);
            camera.rotateZ(-clamp(gLat, -40, 40) * 0.0008 + roll);
        } else {
            camera.rotateZ(camRoll + roll);
        }

        // ── FOV: хоризонтален, по аспект ─────────────────────────────────
        const fovIdle = isOnboard ? T.onboardFovHIdle : T.fovHIdle;
        const fovFast = isOnboard ? T.onboardFovHFast : T.fovHFast;
        const fovTarget = fovIdle + (fovFast - fovIdle) * s - T.fovBrake * brakeAmt;
        fovH += (fovTarget - fovH) * k;
        applyFov();

        api.speedRatio = s;
        api.gLong = gLong;
        api.gLat = gLat;
    }

    /**
     * Камера от очите на пилота — позицията и базовата
     * ориентация идват от рига (наклон по склона, крен по банкинга/завоя,
     * пич при спиране), към които се смесва малко демпфиран поглед напред.
     */
    function updateOnboard(dt, render, sim, surface, lookYaw, slipAngle, forwardX, forwardZ) {
        if (rig !== null) {
            // updateCarRig е сложил root/body преди нас; световната матрица
            // обаче се смята чак при рендера — две матрици, евтино.
            rig.body.updateWorldMatrix(true, false);
            scratch.copy(driverEye());
            rig.body.localToWorld(scratch);
            camera.position.copy(scratch);
            rig.body.getWorldQuaternion(rigQuat);
        } else {
            camera.position.set(
                render.x + forwardX * T.onboardForward,
                surface.height + T.onboardHeight,
                render.z + forwardZ * T.onboardForward
            );
            rigQuat.setFromAxisAngle(UP, render.heading);
        }

        // Камерата гледа по −Z, болидът — по +Z: π около Y, плюс воланът
        // (леко завъртане на главата), yaw lead и обратно на плъзгането.
        const yawOffset = clamp((render.steer ?? 0) * 0.12 + (render.yawRate ?? 0) * 0.25 - slipAngle * 0.25, -T.maxYawOffset, T.maxYawOffset);
        yawQuat.setFromAxisAngle(UP, Math.PI + yawOffset);
        rigQuat.multiply(yawQuat);

        // Погледът 55 m напред по трасето — интерполирана височина (без 4 m
        // стъпала), демпфиран 14/s.
        look.set(
            render.x + Math.sin(lookYaw) * T.onboardLookAhead,
            heightAt(track, carProj.index, carProj.along + T.onboardLookAhead) + T.onboardLookHeight,
            render.z + Math.cos(lookYaw) * T.onboardLookAhead
        );
        if (!hasLook) {
            lookTarget.copy(look);
            hasLook = true;
        } else {
            lookTarget.lerp(look, 1 - Math.exp(-T.onboardLookDamping * dt));
        }
        lookMatrix.lookAt(camera.position, lookTarget, UP);
        lookQuat.setFromRotationMatrix(lookMatrix);

        camera.quaternion.copy(rigQuat).slerp(lookQuat, T.onboardRigBlend);

        if (steeringWheel !== null) {
            // Реалният ъгъл (визуално ~100° до упор) + трептене на волана по керба.
            const jitter = sim.onKerb && Math.abs(render.vForward) > 8 ? 0.03 * Math.sin(effectTime * 85) : 0;
            steeringWheel.rotation.z = (render.steer ?? 0) * 1.8 + jitter;
        }
    }

    /**
     * Коридорът: целта не излиза отвъд halfWidth + марж (0.9 m при плътни
     * мантинели, 5 m иначе), не потъва под пътя и не пробива тавана на тунела.
     *
     * @param {THREE.Vector3} v Целта (мутира се)
     */
    function clampToCorridor(v) {
        projectOnTrack(track, v.x, v.z, camHint, camProj);
        camHint = camProj.index;
        const i = camProj.index;
        const lateral = camProj.lateral;
        const maxLat = track.halfWidths[i] + (streetWalls ? T.corridorMarginStreet : T.corridorMargin);

        if (Math.abs(lateral) > maxLat) {
            const pull = lateral - Math.sign(lateral) * maxLat;
            v.x -= track.nx[i] * pull;
            v.z -= track.nz[i] * pull;
        }

        const clampedLateral = clamp(lateral, -maxLat, maxLat);
        const groundY = camProj.height - clampedLateral * track.bankSlope[i];
        if (v.y < groundY + T.floorClearance) {
            v.y = groundY + T.floorClearance;
        }
        if (tunnel !== null) {
            const d = camProj.distance;
            if (d >= tunnel.from - 8 && d <= tunnel.to + 8 && v.y > groundY + T.tunnelClearance) {
                v.y = groundY + T.tunnelClearance;
            }
        }
    }

    /**
     * Средна кривина на състезателната линия за следващите 30 m (+ = дясно).
     *
     * @param {number} index
     * @returns {number}
     */
    function meanCurvatureAhead(index) {
        const curv = track.raceCurv ?? track.curvature;
        if (!curv) {
            return 0;
        }
        let sum = 0;
        for (let n = 1; n <= lookAheadPoints; n++) {
            sum += curv[(index + n) % track.count];
        }
        return sum / lookAheadPoints;
    }

    /** Хоризонтален → вертикален FOV по текущия аспект; матрицата само при нужда. */
    function applyFov() {
        const aspect = camera.aspect || 16 / 9;
        const fovV = THREE.MathUtils.radToDeg(
            2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fovH) / 2) / aspect)
        );
        if (Math.abs(camera.fov - fovV) > FOV_EPSILON) {
            camera.fov = fovV;
            camera.updateProjectionMatrix();
        }
        if (onFovChange !== null && Math.abs(fovV - notifiedFov) > FOV_NOTIFY_EPSILON) {
            notifiedFov = fovV;
            onFovChange(fovV);
        }
    }

    function dispose() {
        api.mode = 'chase';
        syncCockpitVisibility();
        hasLook = false;
        kick = 0;
    }

    return api;
}

/**
 * Интерполация на рендер състоянието между два тика — освен x/z/heading
 * и vForward/yawRate, за да не редува G-оценката 0/2a на високи честоти.
 * `prev` се снима с snapshotRender ПРЕДИ стъпките от кадъра.
 *
 * @param {object} render Целеви обект (преизползван)
 * @param {{x: number, z: number, heading: number, vForward: number, yawRate: number}} prev
 * @param {object} state Текущото състояние на симулацията
 * @param {number} alpha Остатък от акумулатора, [0..1)
 * @returns {object} render
 */
export function interpolateRender(render, prev, state, alpha) {
    Object.assign(render, state);
    let dHeading = state.heading - prev.heading;
    if (dHeading > Math.PI) dHeading -= TWO_PI;
    else if (dHeading < -Math.PI) dHeading += TWO_PI;
    render.x = prev.x + (state.x - prev.x) * alpha;
    render.z = prev.z + (state.z - prev.z) * alpha;
    render.heading = prev.heading + dHeading * alpha;
    render.vForward = prev.vForward + (state.vForward - prev.vForward) * alpha;
    render.yawRate = prev.yawRate + (state.yawRate - prev.yawRate) * alpha;
    return render;
}

/**
 * @param {{x: number, z: number, heading: number, vForward: number, yawRate: number}} prev
 * @param {object} state
 */
export function snapshotRender(prev, state) {
    prev.x = state.x;
    prev.z = state.z;
    prev.heading = state.heading;
    prev.vForward = state.vForward;
    prev.yawRate = state.yawRate;
}

/**
 * @param {number} v
 * @returns {number}
 */
function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
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
