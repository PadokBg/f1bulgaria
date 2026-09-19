/**
 * ТВ режисура на реплея/attract демото: крайпътни постове НАПРЕД по
 * трасето, дълъг обектив с автозуум, операторска пружина с whip при
 * преминаване, хели и нисък кадър в ротация, parc fermé в края.
 *
 * Защо: старата логика режеше към НАЙ-БЛИЗКИЯ пост, когато колата се
 * отдалечи на 170 m — т.е. ~12 m приближаване и 158 m задници (обърнато
 * спрямо телевизията). Тук постът се избира 110–170 m ПРЕДИ колата,
 * държи се, докато тя не го отмине с 25 m, и се реже напред. Индексът на
 * колата по трасето идва от реплей драйвера (хинтирана проекция), не от
 * евклидово разстояние.
 *
 * Директорът е собственик на реплей часовника (t в кадри) и кара рига през
 * replayDriver; Game чете director.car за частици/следи/звук/сянка.
 * Чисто презентационно — не пише в симулацията.
 */

import * as THREE from 'three';

import { createDrivetrain, updateDrivetrain } from './drivetrain.js';
import { FRAME_STRIDE, createReplayDriver, createReplayOut } from './replayDriver.js';

/**
 * Параметри на BokehPass за ТВ картината (десктоп, само в реплей). Базовата
 * бленда е за 48° и се мащабира ×(48/fov)² в updateBokehPass: дългият
 * обектив (12°) е плитък като 600 mm при f/4, широкият кадър — почти
 * пълна дълбочина. VISUAL планът дава 0.00008, SIM — 0.0008: шейдърът
 * умножава разликата в МЕТРИ (focus + viewZ), т.е. 0.0008 стига maxblur
 * на 10 m от фокуса и размазва асфалта пред колата; 0.00008 (100 m) е
 * правилната база за ×16 при 12°.
 */
export const BOKEH_OPTIONS = Object.freeze({ focus: 60, aperture: 0.00008, maxblur: 0.008 });

/** Граници на мащабираната бленда — да не „пръска" при 12° и да не изчезва при 65°. */
const APERTURE_MIN = 0.00004;
const APERTURE_MAX = 0.0014;

/** Постове на всеки ~180 m; цикъл на кадрите; страничен отстъп на високия/ниския пост. */
const POST_SPACING = 180;
const SHOT_CYCLE = ['post', 'post', 'heli', 'post', 'low'];
const POST_LATERAL = 16;
const POST_HEIGHT = 7;
const LOW_LATERAL = 2.2;
const LOW_HEIGHT = 0.45;

/** Прозорец за избор напред (m) и колко след преминаването се реже. */
const PICK_MIN = 110;
const PICK_MAX = 170;
const PICK_FALLBACK_MIN = 60;
const CUT_AFTER = 25;
/** Сеек/телепорт: колата се е озовала далеч от поста → нов кадър. */
const LOST_DISTANCE = 400;

/** Зуум: рамкирай ~9 m по късата ос на екрана, между 12° и 50°. */
const FRAME_METERS = 9;
const ZOOM_MIN = 12;
const ZOOM_MAX = 50;
const ZOOM_DAMPING = 4;
const HELI_FOV_MIN = 24;
const HELI_FOV_MAX = 30;
const LOW_FOV = 65;
const PARC_FOV = 40;

/** Операторът: критично демпфирана пружина (ω) + водене по скоростта (s). */
const SPRING_OMEGA = 6;
const LOOK_LEAD = 0.15;
const FOCUS_DAMPING = 6;

/** Хели: орбита около колата. */
const HELI_BACK = 40;
const HELI_UP = 55;
const HELI_RATE = 0.15;
const HELI_REAL_RANGE = 500;

/** Parc fermé: бавна орбита около спрялата кола. */
const PARC_RADIUS = 9;
const PARC_HEIGHT = 1.6;
const PARC_RATE = 0.12;

/** Марж около трибуна/пит, в който пост не се слага (m). */
const OBSTACLE_MARGIN = 6;

/** Права: под тази средна кривина страната се редува вместо „вътрешна". */
const STRAIGHT_CURVATURE = 0.0025;

/** Секунди на записан кадър (60 Hz). */
const FRAME_SECONDS = 1 / 60;

/** Градска писта: ниският пост е пред мантинелата (0.9 m), високият — над нея. */
const STREET_LOW_LATERAL = 0.9;
const STREET_POST_EXTRA_HEIGHT = 3;

const UP = new THREE.Vector3(0, 1, 0);
const DEG = 180 / Math.PI;

/**
 * @typedef {object} TvPost
 * @property {number} i Индекс на осевата линия
 * @property {'post'|'heli'|'low'} type
 * @property {number} side +1 по нормалата (дясно), −1 обратно
 * @property {number} x
 * @property {number} y
 * @property {number} z
 */

/**
 * @typedef {object} TvShot Резултатът от кадъра — за Bokeh, broadcast звука и HUD-а.
 * @property {'tv'|'heli'|'low'|'parc'|'chase'|'onboard'} type
 * @property {number} fov Вертикалният FOV на камерата (градуси)
 * @property {number} focusDistance Разстояние камера→кола (демпфирано) за DOF
 * @property {number} distance Хоризонтално разстояние пост→кола (за звука)
 * @property {number} closing Скорост на сближаване към поста, m/s (+ = приближава)
 * @property {number} pan −1..1 — колата отляво/отдясно на камерата
 * @property {number} cuts Брой рязания от start() насам
 */

/**
 * @typedef {object} TvDirectorOptions
 * @property {import('./car.js').CarRig} [rig] Ригът на болида — директорът го кара през replayDriver
 * @property {import('./camera.js').ChaseCamera} [chaseCamera] За реплей камери 'chase'/'onboard'
 * @property {THREE.Object3D} [halo] Halo силуетът — видим само в реплей режим 'onboard'
 * @property {THREE.Object3D} [helicopter] Хеликоптерът от декора (група) — реалната машина снима, щом е близо
 * @property {Array<{cx: number, cz: number, radius: number}>} [grandstandBounds] Трибуни (decor) — без постове вътре
 * @property {{from: number, to: number, sign: number}} [pitRange] Пит комплексът (редове + страна)
 * @property {(x: number, z: number) => number} [groundHeight] Теренът (sampler.height) — постът да не потъне в хълм
 * @property {boolean} [loop] true (по подразбиране): обиколката се върти; false: parc fermé в края
 * @property {boolean} [lowPower]
 * @property {object} [quality]
 */

/**
 * @typedef {object} TvDirector
 * @property {boolean} active
 * @property {import('./replayDriver.js').ReplayOut} car Състоянието на реплей колата (render + sim + out)
 * @property {TvShot} shot
 * @property {import('./drivetrain.js').Drivetrain} drivetrain Scratch трансмисия (обороти за broadcast звука)
 * @property {TvPost[]} posts
 * @property {(frames: Float32Array) => boolean} start
 * @property {(dt: number) => boolean} update Връща true в кадъра, в който обиколката свърши (wrap или parc fermé)
 * @property {() => void} stop
 * @property {(mode: 'tv'|'chase'|'onboard') => void} setCamera
 * @property {(speed: number) => void} setSpeed 0.25..4
 * @property {(fraction: number) => void} seek
 * @property {() => number} progress 0..1
 * @property {() => 'tv'|'chase'|'onboard'} cameraMode
 * @property {() => number} playbackSpeed
 * @property {() => void} dispose
 */

/**
 * @param {THREE.PerspectiveCamera} camera
 * @param {import('./track.js').Track} track
 * @param {object} circuit
 * @param {TvDirectorOptions} [options]
 * @returns {TvDirector}
 */
export function createTvDirector(camera, track, circuit, options = {}) {
    const rig = options.rig ?? null;
    const chaseCamera = options.chaseCamera ?? null;
    const halo = options.halo ?? null;
    const helicopter = options.helicopter ?? null;
    const loop = options.loop !== false;
    const streetWalls = circuit?.streetWalls === true;
    const driver = createReplayDriver(track, circuit);
    const car = createReplayOut();
    const drivetrain = createDrivetrain(false);
    const { count, spacing, length } = track;

    const shot = {
        type: 'tv',
        fov: 48,
        focusDistance: 60,
        distance: 0,
        closing: 0,
        pan: 0,
        cuts: 0,
    };

    let posts = null;
    let frames = null;
    let frameCount = 0;
    let t = 0;
    let speed = 1;
    let mode = 'tv';
    let finished = false;
    let currentPost = null;
    let justCut = true;
    let effectTime = 0;
    let heliAngle = 0;
    let parcAngle = 0;
    let fovSmooth = 48;
    let prevDistance = null;
    let cutFrames = 0;

    // Пружината на оператора (позиция + скорост на точката на погледа).
    const lookPos = new THREE.Vector3();
    const lookVel = new THREE.Vector3();

    // Scratch — нула алокации на кадър.
    const target = new THREE.Vector3();
    const camPos = new THREE.Vector3();
    const carPos = new THREE.Vector3();
    const scratch = new THREE.Vector3();

    const api = {
        active: false,
        car,
        shot,
        drivetrain,
        get posts() {
            return ensurePosts();
        },
        start,
        update,
        stop,
        setCamera,
        setSpeed,
        seek,
        progress,
        cameraMode: () => mode,
        playbackSpeed: () => speed,
        dispose,
    };

    /**
     * @param {Float32Array} frames60 Кадри [x, z, heading] на 60 Hz (подредбата на sim.js)
     * @returns {boolean} Дали има какво да се пусне (≥ 2 кадъра)
     */
    function start(frames60) {
        const n = frames60 ? Math.floor(frames60.length / FRAME_STRIDE) : 0;
        if (n < 2) {
            return false;
        }
        frames = frames60;
        frameCount = n;
        t = 0;
        finished = false;
        currentPost = null;
        justCut = true;
        cutFrames = 0;
        prevDistance = null;
        shot.cuts = 0;
        heliAngle = 0;
        parcAngle = 0;
        driver.reset();
        ensurePosts();
        api.active = true;
        chaseCamera?.setMode(mode === 'onboard' ? 'onboard' : 'chase');
        if (halo !== null) {
            halo.visible = mode === 'onboard';
        }
        // Първият кадър да има какво да покаже: колата на старта, камерата
        // на първия пост напред — без изчакване на следващия update.
        driver.sample(frames, 0, car);
        if (rig !== null) {
            driver.applyToRig(rig, car, 1);
        }
        placeCamera(0);
        return true;
    }

    function stop() {
        api.active = false;
        frames = null;
        currentPost = null;
        finished = false;
    }

    /**
     * @param {'tv'|'chase'|'onboard'} next
     */
    function setCamera(next) {
        if (next !== 'tv' && next !== 'chase' && next !== 'onboard') {
            return;
        }
        if ((next === 'chase' || next === 'onboard') && chaseCamera === null) {
            next = 'tv';
        }
        if (next === mode) {
            return;
        }
        mode = next;
        chaseCamera?.setMode(mode === 'onboard' ? 'onboard' : 'chase');
        if (mode === 'tv') {
            currentPost = null;
            justCut = true;
        } else {
            chaseCamera.snap(car, car.surface);
        }
        // Chase камерата показва halo-то по своя режим; в ТВ кадъра то няма
        // място, а stopReplay го връща по живия cameraMode.
        if (halo !== null) {
            halo.visible = mode === 'onboard';
        }
    }

    /**
     * @param {number} value
     */
    function setSpeed(value) {
        speed = Number.isFinite(value) ? clamp(value, 0.25, 4) : 1;
    }

    /**
     * @param {number} fraction 0..1
     */
    function seek(fraction) {
        if (frames === null) {
            return;
        }
        t = clamp(fraction, 0, 1) * (frameCount - 1 - 1e-6);
        finished = false;
        driver.reset();
        currentPost = null;
        justCut = true;
        prevDistance = null;
        driver.sample(frames, t, car);
        if (mode !== 'tv' && chaseCamera !== null) {
            chaseCamera.snap(car, car.surface);
        }
    }

    /**
     * @returns {number}
     */
    function progress() {
        return frameCount > 1 ? t / (frameCount - 1) : 0;
    }

    /**
     * @param {number} dt
     * @returns {boolean} true в кадъра на края на обиколката
     */
    function update(dt) {
        if (!api.active || frames === null) {
            return false;
        }

        effectTime += dt;
        let done = false;

        if (!finished) {
            // 60 кадъра/секунда реално време × скорост на възпроизвеждане.
            t += dt * (1 / FRAME_SECONDS) * speed;
            if (t >= frameCount - 1) {
                done = true;
                if (loop) {
                    t -= frameCount - 1;
                    driver.reset();
                    prevDistance = null;
                } else {
                    t = frameCount - 1 - 1e-6;
                    finished = true;
                }
            }
            driver.sample(frames, t, car);
            if (finished) {
                driver.halt(car);
                parcAngle = Math.atan2(camera.position.x - car.x, camera.position.z - car.z);
            }
        } else {
            done = true;
        }

        if (rig !== null) {
            driver.applyToRig(rig, car, dt);
        }
        updateDrivetrain(drivetrain, car.vForward, car.throttle, dt);

        placeCamera(dt);

        return done;
    }

    /**
     * Камерата за този кадър според режима.
     *
     * @param {number} dt
     */
    function placeCamera(dt) {
        if (finished) {
            parcFerme(dt);
        } else if (mode !== 'tv' && chaseCamera !== null) {
            chaseCamera.update(dt, car, car, car, mode);
            shot.type = mode;
            shot.fov = camera.fov;
            camera.updateMatrixWorld();
            finishShot(dt, camera.position.x, camera.position.z);
        } else {
            tvShot(dt);
        }
    }

    /**
     * Кадър от крайпътен пост / хеликоптер / нисък ъгъл.
     *
     * @param {number} dt
     */
    function tvShot(dt) {
        const carIndex = car.trackIndexHint;
        carPos.set(car.x, car.y + 0.6, car.z);

        if (currentPost === null || passedBy(currentPost, carIndex) > CUT_AFTER || lostPost(currentPost)) {
            cutTo(choosePost(carIndex));
        }
        const post = currentPost;

        // ── Позиция на камерата ─────────────────────────────────────────
        if (post.type === 'heli') {
            heliAngle += dt * HELI_RATE;
            let useReal = false;
            if (helicopter !== null) {
                helicopter.getWorldPosition(scratch);
                useReal = scratch.distanceTo(carPos) < HELI_REAL_RANGE;
            }
            if (useReal) {
                camPos.copy(scratch);
            } else {
                const fx = Math.sin(car.heading);
                const fz = Math.cos(car.heading);
                const cos = Math.cos(heliAngle);
                const sin = Math.sin(heliAngle);
                // (−fwd·40) завъртяно около Y с heliAngle, +55 нагоре.
                const ox = -fx * HELI_BACK;
                const oz = -fz * HELI_BACK;
                camPos.set(car.x + ox * cos + oz * sin, car.y + HELI_UP, car.z - ox * sin + oz * cos);
            }
        } else {
            camPos.set(post.x, post.y, post.z);
        }

        // ── Точката на погледа: колата + водене по скоростта ────────────
        const fx = Math.sin(car.heading);
        const fz = Math.cos(car.heading);
        const lx = Math.cos(car.heading);
        const lz = -Math.sin(car.heading);
        const vx = fx * car.vForward + lx * car.vLateral;
        const vz = fz * car.vForward + lz * car.vLateral;
        if (post.type === 'low') {
            target.set(car.x + fx * 6, car.y + 0.5, car.z + fz * 6);
        } else {
            target.set(car.x + vx * LOOK_LEAD, car.y + 0.6, car.z + vz * LOOK_LEAD);
        }

        if (justCut) {
            lookPos.copy(target);
            lookVel.set(0, 0, 0);
            justCut = false;
        } else {
            // Критично демпфирана пружина, полу-имплицитен Ойлер (стабилна
            // при ω·dt < 2 — dt е ограничен до 1/30).
            const h = Math.min(dt, 1 / 30);
            const w2 = SPRING_OMEGA * SPRING_OMEGA;
            const damp = 2 * SPRING_OMEGA;
            lookVel.x += (w2 * (target.x - lookPos.x) - damp * lookVel.x) * h;
            lookVel.y += (w2 * (target.y - lookPos.y) - damp * lookVel.y) * h;
            lookVel.z += (w2 * (target.z - lookPos.z) - damp * lookVel.z) * h;
            lookPos.addScaledVector(lookVel, h);
        }

        // Ръчен шум на оператора — в метри при колата, скалиран с
        // разстоянието, за да се чете и през дългия обектив.
        const dist = camPos.distanceTo(carPos);
        const noiseScale = post.type === 'low' ? 0.35 : clamp(dist / 60, 0.5, 3);
        const te = effectTime;
        camera.position.copy(camPos);
        camera.up.copy(UP);
        camera.lookAt(
            lookPos.x + 0.1 * Math.sin(te * 0.7) * noiseScale,
            lookPos.y + (0.15 * Math.sin(te * 0.9) + 0.08 * Math.sin(te * 2.3)) * noiseScale,
            lookPos.z + 0.1 * Math.cos(te * 0.7) * noiseScale
        );

        // ── Зуум: постоянен размер на колата в кадъра ───────────────────
        let fovTarget;
        if (post.type === 'low') {
            fovTarget = LOW_FOV;
        } else {
            const framing = 2 * Math.atan(FRAME_METERS / Math.max(dist, 1)) * DEG;
            fovTarget =
                post.type === 'heli'
                    ? clamp(framing, HELI_FOV_MIN, HELI_FOV_MAX)
                    : clamp(framing, ZOOM_MIN, ZOOM_MAX);
        }
        fovSmooth += (fovTarget - fovSmooth) * (1 - Math.exp(-ZOOM_DAMPING * dt));
        applyFov(fovSmooth);

        shot.type = post.type === 'post' ? 'tv' : post.type;
        camera.updateMatrixWorld();
        finishShot(dt, camPos.x, camPos.z);
    }

    /**
     * Parc fermé: бавна орбита около спрялата кола (краят на реплея без цикъл).
     *
     * @param {number} dt
     */
    function parcFerme(dt) {
        parcAngle += dt * PARC_RATE;
        carPos.set(car.x, car.y + 0.5, car.z);
        camPos.set(
            car.x + Math.sin(parcAngle) * PARC_RADIUS,
            car.y + PARC_HEIGHT,
            car.z + Math.cos(parcAngle) * PARC_RADIUS
        );
        camera.position.copy(camPos);
        camera.up.copy(UP);
        camera.lookAt(carPos);
        fovSmooth += (PARC_FOV - fovSmooth) * (1 - Math.exp(-ZOOM_DAMPING * dt));
        applyFov(fovSmooth);
        shot.type = 'parc';
        camera.updateMatrixWorld();
        finishShot(dt, camPos.x, camPos.z);
    }

    /**
     * Общите полета на кадъра: DOF фокус, разстояние/сближаване/панорама за
     * broadcast звука.
     *
     * @param {number} dt
     * @param {number} px Позиция на „поста" (микрофона) — камерата
     * @param {number} pz
     */
    function finishShot(dt, px, pz) {
        const distance = Math.hypot(car.x - px, car.z - pz);
        const focus = camera.position.distanceTo(carPos.set(car.x, car.y + 0.6, car.z));
        if (cutFrames === 0) {
            shot.focusDistance = focus;
        } else {
            shot.focusDistance += (focus - shot.focusDistance) * (1 - Math.exp(-FOCUS_DAMPING * dt));
        }
        // Доплер: радиална скорост от разликата на дистанциите; скок
        // (рязане/сеек) → 0, не „свистене".
        shot.closing =
            prevDistance !== null && dt > 0 && Math.abs(prevDistance - distance) < 15
                ? (prevDistance - distance) / dt
                : 0;
        prevDistance = distance;
        shot.distance = distance;
        const e = camera.matrixWorld.elements;
        shot.pan = clamp(((car.x - camera.position.x) * e[0] + (car.z - camera.position.z) * e[2]) / 25, -1, 1);
        shot.fov = camera.fov;
        cutFrames++;
    }

    /**
     * @param {TvPost} post
     */
    function cutTo(post) {
        currentPost = post;
        justCut = true;
        cutFrames = 0;
        prevDistance = null;
        shot.cuts++;
        if (post.type === 'heli') {
            heliAngle = 0;
        }
        // Дългият обектив стартира тесен и се отваря с приближаването —
        // без „зуум навътре" от широк кадър при всяко рязане.
        if (post.type === 'low') {
            fovSmooth = LOW_FOV;
        } else {
            const d = Math.hypot(car.x - post.x, car.z - post.z);
            fovSmooth = clamp(2 * Math.atan(FRAME_METERS / Math.max(d, 1)) * DEG, ZOOM_MIN, ZOOM_MAX);
        }
    }

    /**
     * Метри, с които колата е ОТМИНАЛА поста (0, ако още не го е стигнала).
     *
     * @param {TvPost} post
     * @param {number} carIndex
     * @returns {number}
     */
    function passedBy(post, carIndex) {
        const ahead = aheadMeters(post, carIndex);
        return ahead > length / 2 ? length - ahead : 0;
    }

    /**
     * Метри по трасето от колата НАПРЕД до поста, [0, length).
     *
     * @param {TvPost} post
     * @param {number} carIndex
     * @returns {number}
     */
    function aheadMeters(post, carIndex) {
        return ((((post.i - carIndex) % count) + count) % count) * spacing - car.along;
    }

    /**
     * @param {TvPost} post
     * @returns {boolean} Сеек/телепорт: колата е далеч от поста
     */
    function lostPost(post) {
        return post.type !== 'heli' && Math.hypot(car.x - post.x, car.z - post.z) > LOST_DISTANCE;
    }

    /**
     * Първият пост 110–170 m напред; иначе най-близкият на ≥ 60 m; иначе
     * най-близкият напред изобщо.
     *
     * @param {number} carIndex
     * @returns {TvPost}
     */
    function choosePost(carIndex) {
        const list = ensurePosts();
        let best = null;
        let bestAhead = Infinity;
        let fallback = null;
        let fallbackAhead = Infinity;
        let nearest = list[0];
        let nearestAhead = Infinity;
        for (const post of list) {
            const ahead = aheadMeters(post, carIndex);
            if (ahead >= PICK_MIN && ahead <= PICK_MAX && ahead < bestAhead) {
                best = post;
                bestAhead = ahead;
            }
            if (ahead >= PICK_FALLBACK_MIN && ahead < fallbackAhead) {
                fallback = post;
                fallbackAhead = ahead;
            }
            if (ahead >= 0 && ahead < nearestAhead) {
                nearest = post;
                nearestAhead = ahead;
            }
        }
        return best ?? fallback ?? nearest;
    }

    /**
     * Постовете (веднъж; трасето е константа): на ~180 m, типизирани по
     * цикъла, от вътрешната страна на завоя (на правите — редуване), извън
     * трибуните и пит комплекса.
     *
     * @returns {TvPost[]}
     */
    function ensurePosts() {
        if (posts !== null) {
            return posts;
        }
        const every = Math.max(1, Math.round(POST_SPACING / spacing));
        const bounds = options.grandstandBounds ?? [];
        const pit = options.pitRange ?? null;
        const curv = track.raceCurv ?? track.curvature;
        const around = Math.max(1, Math.round(40 / spacing));
        const built = [];
        let cycle = 0;
        let alternate = 1;

        for (let i = 0; i < count; i += every) {
            let mean = 0;
            for (let n = -around; n <= around; n++) {
                mean += curv[(((i + n) % count) + count) % count];
            }
            mean /= 2 * around + 1;

            let inside;
            if (Math.abs(mean) < STRAIGHT_CURVATURE) {
                alternate = -alternate;
                inside = alternate;
            } else {
                // Кривина + = десен завой, вътрешната страна е по нормалата (+).
                inside = mean > 0 ? 1 : -1;
            }

            const type = SHOT_CYCLE[cycle % SHOT_CYCLE.length];
            const post =
                makePost(i, type, inside, bounds, pit) ?? makePost(i, type, -inside, bounds, pit);
            if (post === null) {
                continue;
            }
            built.push(post);
            cycle++;
        }

        // Трасе без нито един свободен ред (теоретично) — един пост на старта,
        // за да не остане камерата без позиция.
        if (built.length === 0) {
            built.push(makePost(0, 'post', 1, [], null));
        }

        posts = built;
        return posts;
    }

    /**
     * @param {number} i
     * @param {'post'|'heli'|'low'} type
     * @param {number} side
     * @param {Array<{cx: number, cz: number, radius: number}>} bounds
     * @param {{from: number, to: number, sign: number}|null} pit
     * @returns {TvPost|null}
     */
    function makePost(i, type, side, bounds, pit) {
        const half = track.halfWidths[i];
        // Ниският кадър е от ВЪНШНАТА страна (колата минава пред обектива
        // с целия си борд); подадената side е вътрешната.
        const lowLateral = streetWalls ? STREET_LOW_LATERAL : LOW_LATERAL;
        const lateral = type === 'low' ? -side * (half + lowLateral) : side * (half + POST_LATERAL);
        const x = track.xs[i] + track.nx[i] * lateral;
        const z = track.zs[i] + track.nz[i] * lateral;
        const roadY = track.ys[i] - lateral * track.bankSlope[i];
        const postSide = lateral > 0 ? 1 : -1;

        if (pit !== null && postSide === pit.sign && rowInRange(i, pit.from, pit.to)) {
            return null;
        }
        for (const b of bounds) {
            if (Math.hypot(x - b.cx, z - b.cz) < b.radius + OBSTACLE_MARGIN) {
                return null;
            }
        }

        let y;
        if (type === 'low') {
            y = roadY + LOW_HEIGHT;
        } else {
            y = roadY + POST_HEIGHT + (streetWalls ? STREET_POST_EXTRA_HEIGHT : 0);
            if (typeof options.groundHeight === 'function') {
                y = Math.max(y, options.groundHeight(x, z) + 3);
            }
        }

        return { i, type, side: postSide, x, y, z };
    }

    /**
     * @param {number} i
     * @param {number} from Може да е отрицателен (редове преди 0)
     * @param {number} to
     * @returns {boolean}
     */
    function rowInRange(i, from, to) {
        const wrapped = i > count / 2 ? i - count : i;
        return (wrapped >= from && wrapped <= to) || (i >= from && i <= to);
    }

    /**
     * Вертикален FOV така, че `fov` да важи за КЪСАТА ос на екрана: на
     * портретен телефон дългият обектив рамкира колата по ширина, не става
     * 7° иглен отвор.
     *
     * @param {number} fov Градуси
     */
    function applyFov(fov) {
        const aspect = camera.aspect || 16 / 9;
        const fovV = aspect >= 1 ? fov : 2 * Math.atan(Math.tan((fov / DEG) / 2) / aspect) * DEG;
        if (Math.abs(camera.fov - fovV) > 0.05) {
            camera.fov = fovV;
            camera.updateProjectionMatrix();
        }
    }

    function dispose() {
        stop();
        posts = null;
    }

    return api;
}

/**
 * Записва клип от canvas-а (реплеят/attract демото) като WebM Blob —
 * MediaRecorder върху captureStream; vp9 → vp8 → каквото има. null без
 * поддръжка (Safari без WebM, скрит таб), никога reject.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} [seconds] 1..30
 * @returns {Promise<Blob|null>}
 */
export function recordClip(canvas, seconds = 12) {
    if (
        typeof MediaRecorder === 'undefined' ||
        !canvas ||
        typeof canvas.captureStream !== 'function'
    ) {
        return Promise.resolve(null);
    }
    const duration = clamp(seconds, 1, 30) * 1000;
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(
        (type) => MediaRecorder.isTypeSupported?.(type)
    );

    return new Promise((resolve) => {
        let recorder;
        let stream;
        try {
            stream = canvas.captureStream(60);
            recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        } catch {
            resolve(null);
            return;
        }
        const chunks = [];
        recorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                chunks.push(event.data);
            }
        };
        recorder.onerror = () => {
            stream.getTracks().forEach((track) => track.stop());
            resolve(null);
        };
        recorder.onstop = () => {
            stream.getTracks().forEach((track) => track.stop());
            resolve(chunks.length > 0 ? new Blob(chunks, { type: recorder.mimeType || 'video/webm' }) : null);
        };
        recorder.start(1000);
        setTimeout(() => {
            if (recorder.state !== 'inactive') {
                recorder.stop();
            }
        }, duration);
    });
}

/**
 * Bokeh за ТВ картината: включен само по време на реплей, фокусът върху
 * колата, блендата по обектива (×(48/fov)²). Извиква се от Game всеки
 * реплей кадър и веднъж с enabled=false при излизане.
 *
 * @param {{enabled: boolean, uniforms: {focus: {value: number}, aperture: {value: number}}}|null} pass
 * @param {TvShot} shot
 * @param {boolean} enabled
 */
export function updateBokehPass(pass, shot, enabled) {
    if (!pass) {
        return;
    }
    pass.enabled = enabled;
    if (!enabled) {
        return;
    }
    const ratio = 48 / Math.max(shot.fov, 1);
    pass.uniforms.focus.value = shot.focusDistance;
    pass.uniforms.aperture.value = clamp(BOKEH_OPTIONS.aperture * ratio * ratio, APERTURE_MIN, APERTURE_MAX);
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
