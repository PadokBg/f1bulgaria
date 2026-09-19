/**
 * Оркестратор на играта: сцена, камера, вход, цикъл, хронометър.
 *
 * Времето се брои в стъпки на симулацията, НЕ по стенен часовник. Освен че е
 * коректно (кадрите се колебаят, стъпките не), това е предпоставката за
 * сървърна валидация по-късно: обиколка = брой стъпки × FIXED_DT.
 */

import * as THREE from 'three';
// HDRLoader = старият RGBELoader; RGBELoader в 0.180 е само shim, който
// предупреждава в конзолата при всяко създаване.
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { createAtmosphere } from './atmosphere.js';
import { createAsphaltTextures } from './asphaltTexture.js';
import {
    attachCarModel,
    buildCar,
    buildCarShadowProxy,
    buildGhostRigFromTemplate,
    buildOpponentRigFromTemplate,
    loadCarTemplate,
    updateCarRig,
} from './car.js';
import { createChaseCamera } from './camera.js';
import { createCarEffects } from './carEffects.js';
import { circuitFor } from './circuits.js';
import { createCascadedShadows } from './csm.js';
import { consumeShift, gamepadConnected, hapticPulse, readGamepad } from './gamepad.js';
import { applyNightSheen, createNightLights } from './nightLights.js';
import { ParticleEffects } from './particles.js';
import { createGradePass, gradeFor } from './postfx.js';
import { createReplayDriver, createReplayOut } from './replayDriver.js';
import { SkidMarks } from './skidmarks.js';
import { buildTrackMeshes, COLORS } from './mesh.js';
import { applySurfaceShaders, surfaceRepeat } from './surfaceShader.js';
import { CAR, FIXED_DT, speedKmh } from './physics.js';
import {
    FRAME_EVERY,
    MAX_WARNINGS,
    SIM_VERSION,
    createSim,
    decodeFrames,
    encodeFrames,
    encodeTrace,
} from './sim.js';
import {
    RACE_PENALTY_MS,
    RACE_TOTAL_LAPS,
    RACE_VERSION,
    classifyRace,
    createRace,
    encodeRaceTrace,
    gridRace,
    gridSlot,
    overtakeCharge,
    raceGap,
    racePenalties,
    recordTimingAt,
    stepRace,
    trackWrap,
} from './race.js';
import { createRadioVoice } from './radioVoice.js';
import { hashString, mulberry32 } from './random.js';
import { createEngineSound } from './sound.js';
import engineWorkletUrl from './engineWorklet.js?url';
import { isMobileDevice } from './device.js';
import { shouldCaptureGameKey } from './keyboard.js';
import { advanceQualityGovernor, createCadenceState, GOVERNOR, resetCadenceForRun, restartCadenceWindow } from './qualityGovernor.js';
import { createLightweightAa } from './lightweightAa.js';
import { prepareTrack, projectOnTrack } from './track.js';
import { SHIFT_RPM, createDrivetrain, shiftDown, shiftUp, updateDrivetrain } from './drivetrain.js';
import { createTvDirector, recordClip as captureReplayClip } from './tvDirector.js';

/** localStorage ключ на духа (най-бързата ТИ обиколка на това устройство). */
const ghostKey = (slug) => `padok-ghost-${slug}`;

/** Максимално време, което един кадър може да добави — спира спиралата на
 *  смъртта. Свалено (0.25→0.1): след GC пауза/смяна на таб 0.25 s → ~30 стъпки в
 *  един кадър, който сам е дълъг и се самоподхранва. 0.1 = до 12 стъпки. */
const MAX_FRAME_TIME = 0.1;

/**
 * Поредни гръмнали кадри, след които играта се смята за трайно счупена
 * (виж Game.#frameFailed). Гръмнал шейдър гърми на всеки кадър и удря
 * прага за 50 ms; еднократен fluke от чужд API не сваля играта.
 */
const FATAL_FRAME_ERRORS = 3;

/** HUD телеметрия — не по-често от 30 Hz. Vue реактивността на всеки кадър
 *  (60+ Hz) е излишен diff/patch; 30 Hz е гладко за таймера, наполовина churn. */
const TELEMETRY_INTERVAL = 1 / 30;

/** Ливреи на AI съперниците — генерични цветове, без реални отбори. */
const LIVERIES = [0x2563eb, 0xff7a00, 0x00a36c, 0xd7d7de, 0xe6007e, 0xf5c400];

/** Измислени имена на ботовете за класирането — никакви реални пилоти. */
const BOT_NAMES = ['В. Колев', 'М. Петров', 'Г. Илиев', 'Д. Стоянов', 'Н. Радев', 'Х. Марков'];

/** Радар за кола отстрани: докъде напред/назад и встрани се „вижда", м. */
const RADAR_ALONG = 7;
const RADAR_LATERAL = 6;

/** Радиото: най-много едно съобщение на толкова стъпки (без наказанията). */
const RADIO_GAP_TICKS = Math.round(1.5 / FIXED_DT);
/** Смяна на позиция се казва, щом се задържи толкова (страна до страна трепти). */
const RADIO_POSITION_SETTLE_TICKS = Math.round(1 / FIXED_DT);
/** Кола зад теб на по-малко от толкова секунди = атака. */
const RADIO_ATTACK_GAP = 0.6;
const RADIO_ATTACK_COOLDOWN_TICKS = Math.round(25 / FIXED_DT);
/** Грешка на бот се казва, ако е на по-малко от толкова метра от теб. */
const RADIO_MISTAKE_RANGE = 250;

/** Стартова процедура (състезание): интервал между светлините. Решетката,
 *  дистанцията и наказанията живеят в race.js — сървърът ги преиграва. */
const LAUNCH_LIGHT_INTERVAL = 0.85; // s между палене на две светлини

/** Веене на карирания флаг на маршала — скорост (rad/s) и амплитуда (rad). */
const FLAG_WAVE_SPEED = 8;
const FLAG_WAVE_AMP = 0.6;

const CAMERA = {
    distance: 9.5,
    height: 3.6,
    lookAhead: 12,
    /** Field of view при покой и при максимална скорост. */
    fovIdle: 62,
    fovFast: 84,
    /** Колко бързо камерата догонва колата. По-високо = по-залепена. */
    followDamping: 7.5,
    /** Бордова (halo) камера: око на пилота над кокпита. */
    onboardHeight: 1.05,
    onboardForward: 0.25,
    onboardLookAhead: 55,
};

/**
 * Tone mapping — A/B на снимки от Монца (2026-09-10, HDRI ден): AgX при
 * експозиция ×1.3 избелва небето и прави червената ливрея пастелна; ACES
 * избутва червеното към оранжево и леко замъглява; Khronos Neutral пази
 * тона (червеното остава червено, небето — синьо) при същата експозиция като
 * досегашната картина. Затова Neutral е по подразбиране; другите два стоят
 * на един ред разстояние. И двата пътя (composer → OutputPass; телефон →
 * директен рендер) четат renderer.toneMapping.
 */
const TONE_MAPPING = 'neutral';
const TONE_PRESETS = {
    neutral: { mapping: THREE.NeutralToneMapping, exposureScale: 1, saturationScale: 1 },
    agx: { mapping: THREE.AgXToneMapping, exposureScale: 1.3, saturationScale: 1.065 },
    aces: { mapping: THREE.ACESFilmicToneMapping, exposureScale: 1, saturationScale: 1 },
};

/**
 * Bloom: греят само стойности > 1.0 в линейния HDR буфер — слънцето,
 * прожекторите, стартовите светлини, HDR глоу по болида. Старите 0.1 бяха
 * невидими за цената си (10 blur прохода). Нощем по-силен: светлините СА
 * картината.
 */
const BLOOM = { strength: 0.16, nightStrength: 0.3, radius: 0.28, threshold: 1.08 };

/** Споделен resolved promise за composer конфигурации без lazy Ultra модул. */
const COMPOSER_READY = Promise.resolve();

/** Сенчестата кутия около колата (полуразмер, m) и разстоянието до слънцето. */
const SHADOW_HALF_SIZE = 30;
const SUN_DISTANCE = 300;

/** Звукът на решетката преди старта — константен обект, нула алокации/кадър. */
const LAUNCH_SOUND_EXTRAS = Object.freeze({ kerb: false, gravel: false, speed: 0 });

/**
 * Груба евристика за слабо устройство (телефон / малко CPU ядра) — ползва се, за
 * да се смъкне post-processing-ът там, където fill-rate-ът е тесен. Мобилната
 * преценка е ОБЩАТА с Vue (device.js) — иначе iPad получаваше десктоп рендер
 * (composer, HDRI, 1024 сенки) с мобилни контроли.
 *
 * @returns {boolean}
 */
function isLowPowerDevice() {
    const fewCores = (navigator.hardwareConcurrency || 8) <= 4;
    const memory = Number(navigator.deviceMemory);
    const lowMemory = Number.isFinite(memory) && memory > 0 && memory <= 4;

    return isMobileDevice() || fewCores || lowMemory;
}

/**
 * Твърд таван за мобилния/low-power път. Настройката се прилага и върху
 * запазен ръчен пресет, и при жива смяна, така че стар Ultra избор не може да
 * върне скъпите проходи, сенки или плътност на частиците на слаб хардуер.
 *
 * @param {object} quality
 */
function clampLowPowerQuality(quality) {
    quality.postFx = false;
    quality.motionBlur = false;
    // 'off' е спасителният режим (виж SHADOWS_OFF в Game/Index.vue): таванът
    // за слаб хардуер го СВАЛЯ до 'low', ако го презапише, и телефонът с
    // счупен сенчест шейдър пак остава без картина.
    quality.shadows = quality.shadows === 'off' ? 'off' : 'low';
    quality.csmQuality = 'low';
    quality.ao = false;
    quality.particles = clamp(Number.isFinite(quality.particles) ? quality.particles : 0.5, 0.25, 0.5);
    quality.dpr = clamp(Number.isFinite(quality.dpr) ? quality.dpr : 1.5, 0.5, 1.5);
}

/**
 * Auto-only стъпки след изчерпване на динамичната резолюция. Те са монотонни
 * за текущата сесия, за да няма shader recompilation/визуално помпане насред
 * обиколка; нова игра или ръчен избор започва от заявения профил.
 *
 * @param {object} quality
 * @param {number} stage 0 = full, 1 = balanced, 2 = safe
 */
function clampAdaptiveQuality(quality, stage) {
    if (quality.adaptive !== true || stage <= 0) {
        return;
    }
    quality.motionBlur = false;
    quality.particles = Math.min(Number.isFinite(quality.particles) ? quality.particles : 1, 0.75);
    quality.csmQuality = 'medium';

    if (stage >= 2) {
        quality.postFx = false;
        quality.shadows = quality.shadows === 'off' ? 'off' : 'low';
        quality.csmQuality = 'low';
        quality.ao = false;
        quality.particles = Math.min(quality.particles, 0.5);
    }
}

export class Game {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} trackData Съдържанието на {slug}.json
     * @param {(telemetry: object) => void} onTelemetry
     * @param {(result: object) => void} [onFinish] Извиква се веднъж при
     *        завършена квалификационна обиколка (за резултатния екран).
     */
    constructor(canvas, trackData, onTelemetry, onFinish = () => {}, options = {}) {
        this.canvas = canvas;
        // Фатална грешка (виж #fail): Vue сваля играта и показва съобщение. По
        // подразбиране само логва — играта е ползваема и без Vue. Стои НАЙ-
        // ОТПРЕД, защото шейдър може да не се свърже още в конструктора
        // (небето се рендерира там) — тогава #fail пада върху него.
        this.onFatalError = (error) => {
            console.error('Game: фатална грешка', error);
        };
        this.failed = false;
        this.failure = null; // грешката, ако е гръмнало преди Vue да закачи своя onFatalError
        this.frameErrors = 0; // поредни гръмнали кадри (виж #frameFailed)
        this.onTelemetry = onTelemetry;
        this.onFinish = onFinish;
        this.simVersion = SIM_VERSION;
        this.onProgress = options.onProgress ?? (() => {});
        // Една преценка за слабо устройство — ползва се на 5+ места.
        this.lowPower = isLowPowerDevice();
        // Качествени настройки: десктопът тръгва с всичко, телефонът — без
        // composer/motion blur и с малка сенчеста карта. HUD-ът ги сменя през
        // setQuality(); всеки десктоп-only разход в другите модули се гейтва
        // с `!game.lowPower && game.quality.X`. ao/particles са само флагове
        // за следващите пакети (AO проход, плътност на частиците).
        this.quality = {
            adaptive: true,
            postFx: !this.lowPower,
            motionBlur: !this.lowPower,
            shadows: this.lowPower ? 'low' : 'high',
            csmQuality: this.lowPower ? 'low' : 'auto',
            ao: false,
            particles: this.lowPower ? 0.5 : 1,
            dpr: 1, // попълва се от baseDpr по-долу
            ...(options.quality && typeof options.quality === 'object' ? options.quality : {}),
        };
        if (this.lowPower) {
            clampLowPowerQuality(this.quality);
        }
        // Визуалната идентичност на пистата: питлейн, терен, светлина, а вече
        // и ГЕОМЕТРИЯ — widthProfile/banking влизат в prepareTrack (circuits.js).
        this.circuit = circuitFor(trackData.slug);
        this.track = prepareTrack(trackData, this.circuit);

        this.renderer = new THREE.WebGLRenderer({
            canvas,
            // MSAA на контекста е за директния mobile/Low път. Останалият
            // десктоп рисува в offscreen MSAA target на composer-а;
            // multisample backbuffer-ът там получаваше само fullscreen quad-а
            // на OutputPass, а струваше ~236 MB на DPR 2/1440p + резолв на кадър.
            antialias: this.lowPower || this.quality.postFx === false,
            powerPreference: 'high-performance',
        });
        // Над 2 нищо не се печели визуално; на телефон 1.5 е неразличимо в
        // движение, а е -44% пиксели. Отгоре работи и динамичният governor.
        const requestedDpr = Number.isFinite(this.quality.dpr) && this.quality.dpr > 0
            ? this.quality.dpr
            : Infinity;
        this.baseDpr = Math.min(window.devicePixelRatio, this.lowPower ? 1.5 : 2, requestedDpr);
        this.quality.dpr = this.baseDpr;
        this.renderScale = 1;
        this.frameAvgMs = 0; // сийдва се от първия реален кадър (виж #governResolution)
        this.scaleCooldown = 0;
        this.vsyncMs = GOVERNOR.maxVsyncMs;
        this.prevFrameMs = GOVERNOR.maxVsyncMs;
        this.outlierCount = 0;
        this.outlierTimer = 0;
        this.autoQualityStage = 0;
        this.autoQualitySlowSeconds = 0;
        Object.assign(this, createCadenceState());
        this.renderer.setPixelRatio(this.baseDpr);

        // Браузърът може да отнеме WebGL контекста (рестарт на драйвера, липса
        // на видео памет, а от Brave 1.93 — и защитата му срещу fingerprinting,
        // brave-browser#57902). Кадрите след това не рисуват НИЩО, но
        // симулацията, HUD-ът и звукът си вървят: играчът гледа бяло платно с
        // жив скоростомер и мисли, че играта се е счупила. Третираме го като
        // фатално — Vue сваля играта и казва какво да направи.
        // preventDefault() е задължителен: без него браузърът дори не опитва
        // да върне контекста.
        this.contextLost = false;
        this.onContextLostEvent = (event) => {
            event.preventDefault();
            this.contextLost = true;
            this.#fail(new Error('Браузърът прекъсна WebGL контекста.'));
        };
        canvas.addEventListener('webglcontextlost', this.onContextLostEvent);

        // Драйвер, който не може да свърже шейдър, е другият начин да се стигне
        // до празно платно с жив HUD: three само логва в конзолата и рисува
        // нищо. Известен случай е Pixel 10 (Tensor G5 / PowerVR) на Android 17
        // — „Shader Error 1282, VALIDATE_STATUS false" с празен лог, който бие
        // и по други сайтове с 3D (three.js#34311). Първият такъв шейдър сваля
        // играта със съобщение вместо да я остави да „върви" невидима.
        this.shaderFailed = false;
        this.renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
            this.shaderFailed = true;
            const log = (shader) => gl.getShaderInfoLog(shader)?.trim() || '(празен лог)';
            this.#fail(
                new Error(
                    `Шейдърът не се свърза: ${gl.getProgramInfoLog(program)?.trim() || '(празен лог)'} · ` +
                        `vertex: ${log(vertexShader)} · fragment: ${log(fragmentShader)}`
                )
            );
        };

        // Филмов tone mapping + сенки. Експозицията е част от атмосферата на
        // пистата (мек Спа срещу ярко крайбрежие в Зандвоорт), мащабирана за
        // избрания tone mapper (виж TONE_MAPPING).
        const tone = TONE_PRESETS[TONE_MAPPING];
        this.renderer.toneMapping = tone.mapping;
        this.renderer.toneMappingExposure = this.circuit.atmosphere.exposure * tone.exposureScale;
        this.renderer.shadowMap.enabled = this.quality.shadows !== 'off';
        // Телефон: PCF (не Soft) — tap-овете са в пъти по-евтини, а на
        // малък екран разликата не се чете.
        this.renderer.shadowMap.type = this.lowPower ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
        this.maxAniso = this.renderer.capabilities.getMaxAnisotropy?.() ?? 1;

        const atmosphere = this.circuit.atmosphere;
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(COLORS.sky); // сменя се от небето по-долу
        this.scene.fog = new THREE.Fog(atmosphere.fogColor, atmosphere.fogNear, atmosphere.fogFar);

        this.camera = new THREE.PerspectiveCamera(CAMERA.fovIdle, 1, 0.5, 2200);

        // HDRI-то, външният болид и PBR текстурите се зареждат асинхронно и
        // тръгват ПРЕДИ синхронния строеж на сцената (buildTrackMeshes: терен,
        // дървета, OSM — стотици ms на телефон), така че мрежата се застъпва
        // с CPU работата вместо да я чака. Изчакваме ги ПРЕДИ старта (виж
        // Game/Index.vue), за да не подменят вида по средата на играта. Никога
        // не reject-ват — при липса остава процедурното. Прогресът тежи по
        // реалните байтове: болидът е най-голямото сваляне.
        this.loadParts = { car: 0, env: 0, tex: 0 };
        const envReady = this.#setupEnvironment();

        this.carRig = buildCar();
        this.carShadowProxy = buildCarShadowProxy();
        this.carRig.shadowProxy = this.carShadowProxy;
        this.carRig.body.add(this.carShadowProxy);
        configureCarShadowCasters(this.carRig, this.carShadowProxy);
        this.carTemplate = null;
        const templateReady = loadCarTemplate().then((template) => {
            this.carTemplate = template;
            return template;
        });
        this.carEffects = null;
        // По избор: външен GLB болид (public/game-models/car.glb). Липсва ли —
        // остава процедурният силует по-горе. Спирачното греене/ауспухът се
        // закачат СЛЕД подмяната — attachCarModel скрива децата на body-то.
        const carReady = attachCarModel(
            this.carRig,
            () => this.disposed || this.started,
            (fraction) => {
                this.loadParts.car = fraction;
                this.#reportProgress();
            },
            {
                environment: () => this.scene.environment,
                environmentRotation: () => this.scene.environmentRotation,
                maxAniso: this.maxAniso,
                lowPower: this.lowPower,
            }
        ).then(() => {
            if (this.disposed) {
                return;
            }
            this.loadParts.car = 1;
            this.#reportProgress();
            this.#tightenCarMaterials();
            configureCarShadowCasters(this.carRig, this.carShadowProxy);
            this.cascadedShadows?.refreshMaterials();
            this.carRig.setEnvironment(this.scene.environment, this.scene.environmentRotation);
            this.carEffects = createCarEffects(this.carRig, {
                night: this.atmosphere?.night === true,
                lowPower: this.lowPower,
                quality: this.quality,
                camera: this.camera,
                gradePass: () => this.gradePass,
            });
        });
        // Прилагането на текстурите чака surfaceMaterials (сложни по-долу);
        // decode callback-ите така или иначе идват след конструктора.
        const trackReady = this.#loadTrackTextures();

        this.trackGroup = buildTrackMeshes(this.track, this.circuit, {
            lowPower: this.lowPower,
            quality: this.quality,
            look: this.atmosphere?.look ?? this.circuit.look,
            maxAniso: this.maxAniso,
        });
        this.scene.add(this.trackGroup);
        this.surfaceMaterials = this.trackGroup.userData.surfaces;
        this.surfaceController = applySurfaceShaders(this.surfaceMaterials, this.track, this.circuit, {
            lowPower: this.lowPower,
            quality: this.quality,
            cloudTexture: this.atmosphere?.cloudTexture ?? null,
            cloudStrength: this.atmosphere?.cloudShadow?.strength ?? 0,
            wet: 0,
        });
        this.marshalFlag = this.trackGroup.userData.marshalFlag; // вее се на летящата обиколка
        this.startLights = this.trackGroup.userData.startLights; // 5-те светлини на гантрито
        this.decorAnimations = this.trackGroup.userData.animations ?? []; // виенското колело и др.
        this.marshalPosts = this.trackGroup.userData.marshalPosts ?? []; // жълти флагове по постовете
        this.activeYellowPost = null;
        this.scene.add(this.carRig.root);

        applyNightSheen(this.surfaceMaterials);
        this.nightLights = createNightLights(
            this.scene,
            this.track,
            this.circuit,
            this.trackGroup.userData.floodlights,
            {
                lowPower: this.lowPower,
                quality: this.quality,
                pitRange: this.trackGroup.userData.pitRange,
                grandstands: this.trackGroup.userData.grandstandBounds,
                sun: this.sun,
                sunDir: this.sunDir,
                pixelScale: this.baseDpr,
            }
        );

        // Дим/чакъл/искри + следите от гуми на играча. Размерът на частиците
        // е в буферни пиксели — казваме им реалния DPR (и после governor-а).
        this.particles = new ParticleEffects(this.scene, {
            lowPower: this.lowPower,
            quality: this.quality,
            circuit: this.circuit,
            sunDir: this.sunDir,
            sunColor: this.atmosphere?.sunColor ?? this.circuit.atmosphere.sunColor,
            sunIntensity: this.atmosphere?.sunIntensity ?? this.circuit.atmosphere.sunIntensity,
        });
        this.playerEmitter = this.particles.createEmitter(this.carRig);
        this.skidMarks = new SkidMarks(this.scene, { lowPower: this.lowPower, quality: this.quality });
        this.playerSkidWriter = this.skidMarks.createWriter(this.carRig, this.playerEmitter);
        this.pendingImpact = null;
        this.lastWallHitTick = -1;
        this.wasLocking = false;

        envReady.then(() => {
            if (this.disposed) {
                return;
            }
            this.loadParts.env = 1;
            this.#reportProgress();
            this.carRig.setEnvironment(this.scene.environment, this.scene.environmentRotation);
        });
        trackReady.then(() => {
            this.loadParts.tex = 1;
            this.#reportProgress();
        });
        this.ready = Promise.all([envReady, carReady, trackReady, templateReady])
            .then(([, , , template]) => {
                this.#upgradeGhostRig(template);
                return this.#warmup();
            })
            .then(() => this.onProgress(1));

        // Сенки: всичко ПРИЕМА сянка; хвърлят я колата и подбраният декор
        // близо до трасето (гантри, пит стена/гараж, гуми, табели, мостове —
        // виж castShadow в decor.js). Тежките далечни меши (земя, терен,
        // дървета, OSM сгради) не хвърлят: тяхната сянка не се вижда, а струва.
        // Сенчестият pass рисува декора всеки кадър (frustumCulled=false), но
        // общата му геометрия е десетки хиляди триъгълника — поносимо.
        this.scene.traverse((o) => {
            if (o.isMesh) {
                o.receiveShadow = true;
                // Телефон: декорът НЕ хвърля сянка (цял geometry pass по-малко);
                // колите си я пазят — тяхната е тази, която „стъпва" на пътя.
                if (this.lowPower) {
                    o.castShadow = false;
                }
            }
        });
        configureCarShadowCasters(this.carRig, this.carShadowProxy);

        // Цялата постъпкова логика (повърхности, физика, хронометър, запис на
        // входа) живее в sim.js — същият код тича и в сървърната валидация.
        this.sim = createSim(this.track, this.circuit);

        this.input = { throttle: 0, brake: 0, steer: 0 };
        this.keys = new Set();
        this.touch = { throttle: 0, brake: 0, steer: 0 };
        // Авто-газ (мобилно): болидът ускорява сам, играчът само насочва (tilt) и
        // спира. Включва се от Vue при мобилно устройство.
        this.autoThrottle = false;

        this.effectTime = 0;

        // Камера: chase (по подразбиране) или бордова (C). Halo силуетът е
        // дете на камерата — видим само в бордовия режим.
        this.cameraMode = 'chase';
        this.scene.add(this.camera);
        this.halo = buildHaloOverlay();
        this.halo.visible = false;
        this.camera.add(this.halo);
        // Воланът в бордовата камера — върти се със state.steer.
        this.steeringWheel = buildSteeringWheel();
        this.halo.add(this.steeringWheel);
        this.chaseCamera = createChaseCamera(this.camera, this.track, {
            circuit: this.circuit,
            rig: this.carRig,
            halo: this.halo,
            steeringWheel: this.steeringWheel,
            lowPower: this.lowPower,
        });
        this.chaseCamera.snap(this.sim.state, this.sim.surface);
        this.lookTarget = this.chaseCamera.lookTarget;
        // Спасителният режим не строи каскадните сенки: те кърпят всеки
        // материал със свой GLSL, а точно свързването на шейдър е това, което
        // гърми на счупения драйвер.
        this.cascadedShadows = this.quality.shadows === 'off' ? null : createCascadedShadows({
            camera: this.camera,
            scene: this.scene,
            renderer: this.renderer,
            lightDirection: this.sunDir,
            lowPower: this.lowPower,
            quality: this.quality,
            shadowProxy: this.carShadowProxy,
        });

        // G-force наклоните на бордовата камера (изгладени ускорения).
        this.gLong = 0;
        this.gLat = 0;

        // Звукът: синтезиран двигател (sound.js). Контекстът се създава чак
        // при start() — бутонът „Карай" е потребителският жест. Физическият
        // модел е отделен worklet модул — Vite го дава като URL (`?url`).
        this.sound = createEngineSound({ lowPower: this.lowPower, quality: this.quality, workletUrl: engineWorkletUrl });

        // Vue-то закача този callback, за да маха replay overlay-а, когато
        // реплеят свърши отвътре (R рестарт/reset), не само от своя бутон.
        this.onReplayEnd = () => {};

        // Духът: най-бързата обиколка на това устройство, полупрозрачен болид,
        // каращ редом с теб на летящата обиколка. Реплеят ползва същите кадри.
        // Без личен рекорд се зарежда ОФИЦИАЛНИЯТ дух на Падок (златист) —
        // и първият играч на пистата има срещу кого да кара.
        this.ghost = this.#loadGhost();
        this.ghostRig = buildGhostRig();
        this.ghostRig.root.visible = false;
        this.scene.add(this.ghostRig.root);
        this.ghostDriver = createReplayDriver(this.track, this.circuit);
        this.ghostOut = createReplayOut();
        if (!this.ghost) {
            this.#loadOfficialGhost();
        }
        this.lastLapFrames = null; // кадрите на току-що завършената обиколка
        this.replay = null; // {frames, t, camIndex} — активен ТВ реплей
        const sampler = this.trackGroup.userData.sampler;
        const groundHeight = sampler
            ? (typeof sampler.heightAt === 'function'
                ? (x, z) => sampler.heightAt(x, z)
                : typeof sampler.height === 'function'
                    ? (x, z) => sampler.height(x, z)
                    : undefined)
            : undefined;
        this.tvDirector = createTvDirector(this.camera, this.track, this.circuit, {
            rig: this.carRig,
            chaseCamera: this.chaseCamera,
            halo: this.halo,
            helicopter: this.trackGroup.userData.helicopter,
            grandstandBounds: this.trackGroup.userData.grandstandBounds,
            pitRange: this.trackGroup.userData.pitRange,
            groundHeight,
            lowPower: this.lowPower,
            quality: this.quality,
            loop: true,
        });
        this.weather = 'dry';
        this.lastLapAnalysis = null;
        this.lapAnalysis = createLapAnalysisRecorder(this.track);

        // AI съперници („състезание"): полето живее в race.js (детерминирана
        // симулация, която сървърът преиграва); тук са записите му + ригове.
        this.race = null;
        this.opponents = [];
        // Място в „състезанието" (позиция П1..Пn): цели обиколки + прогрес.
        // В състезание това е race.playerLaps (брои се на всеки тик).
        this.playerRace = { laps: 0, lastProgress: 0 };
        // Бойната обиколка 1 вече е отчетена в телеметрията.
        this.outLapReported = false;
        // Стартова процедура: {elapsed, hold} докато тече отброяването със
        // светлините — симулацията е замразена, никой не потегля преди гасене.
        this.launch = null;
        // Vue-то показва светлините през този callback (брой светнали, null = край).
        this.onLaunch = () => {};

        // Финал на състезанието: {position, standings} след RACE_TOTAL_LAPS.
        this.raceResult = null;
        this.onRaceFinish = () => {};
        // Окончателното класиране, когато полето доизкара след флага.
        this.onRaceClassification = () => {};
        // Радио съобщенията от състезанието: {id, text, tone}.
        this.onRaceMessage = () => {};
        // Задочният съперник: реално състезание на играч от класацията като
        // полупрозрачна кола без контакт (виж setRaceRival).
        this.raceRival = null;
        this.radio = createRadioState();
        // Гласът на радиото: генерирани клипове през радио филтъра на звука.
        // Без клипове (не са генерирани) радиото остава само текстово.
        this.radioVoice = createRadioVoice(this.sound);
        this.radioVoiceEnabled = true;

        // Соло резултатният екран пада симетрично на подиума: вътрешен reset
        // (R / „Рестарт" по време на реплей) чисти и Vue състоянието през това.
        this.onResultClear = () => {};


        // Дуел: духът на съперник от класацията (сървърни кадри). Докато е
        // зареден, се показва ТОЙ (фуксия), а не личният/официалният.
        this.rivalGhost = null;

        // Живата делта срещу духа: указател в кадрите му (локално търсене).
        this.ghostDeltaHint = 0;

        // Доплер на съперника: последна дистанция/време за радиалната скорост.
        this.prevRivalDistance = null;
        this.prevRivalTime = 0;

        // Attract: духът кара демо зад pre-start екрана, докато чакаш „Карай".
        this.attractId = null;

        // Мини-картата: нормализирани точки на трасето (веднъж) за Vue canvas.
        this.minimap = buildMinimap(this.track);

        this.accumulator = 0;
        this.lastFrame = 0;
        this.running = false;
        this.paused = false;
        this.rafId = null;
        // Пазят инвариантите на асинхронните loader-и: не подменяй вида СЛЕД
        // старта (късен pop) и не пипай renderer-а СЛЕД освобождаване.
        this.started = false;
        this.disposed = false;
        // Lazy Ultra postfx lifecycle: generation-ът обезсилва късен import при
        // смяна на preset/quit, а ready държи warm-up екрана до реалното закачане.
        this.composerGeneration = 0;
        this.composerReady = COMPOSER_READY;
        this.gtaoPass = null;

        // Преизползвани обекти (нула алокации/кадър в hot path) + акумулатори.
        this._render = {};
        this._carDyn = {};
        this._soundExtras = {
            kerb: false,
            gravel: false,
            speed: 0,
            slip: 0,
            brake: 0,
            crowd: 0,
            tunnel: false,
            cameraMode: 'chase',
            limiter: false,
            spin: 0,
            wet: false,
            wallHit: null,
        };
        this._screenPoint = new THREE.Vector3();
        this.telemetryAccum = TELEMETRY_INTERVAL; // първи кадър праща телеметрия веднага
        this.flagWave = 0;

        // Трансмисия (обороти/предавка за HUD).
        this.manualTransmission = options.transmission === 'manual';
        this.drivetrain = createDrivetrain(this.manualTransmission);
        this.prevThrottleForOverrun = 0;

        this.#placeCameraBehindCar();
        this.#bindEvents();
        this.#setupComposer();
        this.resize();
    }

    /** Стартира цикъла. */
    start() {
        if (this.running || this.failed || this.disposed) {
            return;
        }

        this.stopAttract();
        this.running = true;
        this.paused = false;
        this.started = true;
        this.lastFrame = performance.now();
        // Гратис за governor-а: първата секунда носи компилации/първи качвания
        // и EMA-то още се сийдва — не е сигнал за стъпка.
        this.scaleCooldown = GOVERNOR.downCooldown;
        this.autoQualitySlowSeconds = 0;
        resetCadenceForRun(this);
        this.#resetPlayerRace();
        this.sound.start();
        this.onLaunch(this.launch ? 0 : null);
        this.#notify(this.onAttemptStart);
        this.rafId = requestAnimationFrame(this.#frame);
    }

    /**
     * Attract режим: духът (официалният или дуелният) кара ТВ демо зад
     * pre-start екрана. Спира се сам при start()/dispose.
     */
    startAttract() {
        if (this.attractId !== null || this.running || this.disposed) {
            return;
        }

        const ghost = this.rivalGhost ?? this.ghost;
        if (!ghost?.frames || ghost.frames.length < 6) {
            return;
        }

        if (!this.tvDirector.start(ghost.frames)) {
            return;
        }
        this.playerSkidWriter?.end();
        this.tvDirector.setCamera('tv');
        this.replay = { attract: true };
        this.lastFrame = performance.now();

        const loop = (now) => {
            if (this.running || this.disposed || this.failed || this.replay === null) {
                this.attractId = null;
                return;
            }
            this.attractId = requestAnimationFrame(loop);
            const dt = Math.min((now - this.lastFrame) / 1000, MAX_FRAME_TIME);
            this.lastFrame = now;
            try {
                this.#replayFrame(dt);
                this.frameErrors = 0;
            } catch (error) {
                this.#frameFailed(error);
            }
        };
        this.attractId = requestAnimationFrame(loop);
    }

    /**
     * Гръмнал кадър. Еднократна грешка (напр. haptics/звук API на екзотичен
     * браузър) само се логва — кадърът е вече пропуснат, следващият идва.
     * Повторение на ПОРЕДНИ кадри значи трайно счупване (гръмнал шейдър
     * гърми на всеки кадър) → #fail.
     *
     * @param {unknown} error
     */
    #frameFailed(error) {
        this.frameErrors++;
        if (this.frameErrors >= FATAL_FRAME_ERRORS) {
            this.#fail(error);
            return;
        }
        console.error('Game: кадърът гръмна, продължаваме', error);
    }

    /**
     * Наблюдателските callback-и (телеметрия на сесията във Vue) са странични:
     * гръмнат ли, старт/обиколка/пауза продължават, а грешката отива в
     * конзолата. Иначе throw от статистиката би замразил играта преди първия
     * кадър или би загубил резултата на обиколката.
     *
     * @param {Function|undefined|null} callback
     * @param {unknown} [payload]
     */
    #notify(callback, payload) {
        if (typeof callback !== 'function') {
            return;
        }
        try {
            callback(payload);
        } catch (error) {
            console.error('Game: наблюдател гръмна', error);
        }
    }

    /**
     * Изключение, избягало от кадъра (renderer.render/compile), е фатално за
     * тази инстанция: three не може да развие renderStateStack/renderListStack
     * след throw, а гръмнал onBeforeCompile гърми отново на всеки кадър —
     * „продължаваме" би значело безкраен полунарисуван кадър с растяща памет
     * (точно това виждаха телефоните при кръпка върху липсващ chunk).
     * Спираме цикъла и сигнализираме на Vue да свали играта с съобщение.
     *
     * @param {unknown} error
     */
    #fail(error) {
        if (this.failed || this.disposed) {
            return;
        }
        this.failed = true;
        this.failure = error;
        // Спирането не бива да скрие сигнала: гръмне ли и то, Vue все пак
        // трябва да разбере, а dispose() ще довърши чистенето.
        try {
            this.stop();
            this.stopAttract();
        } catch (stopError) {
            console.error('Game: спирането след грешка гръмна', stopError);
        }
        try {
            this.onFatalError(error);
        } catch (callbackError) {
            console.error('Game: onFatalError гръмна', callbackError);
        }
    }

    stopAttract() {
        if (this.attractId === null) {
            return;
        }
        cancelAnimationFrame(this.attractId);
        this.attractId = null;
        this.replay = null;
        this.tvDirector.stop();
        this.#placeCameraBehindCar();
    }

    /** Спира цикъла, без да освобождава ресурси. */
    stop() {
        this.running = false;
        this.sound.stop();
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    /** Замразява симулацията, без да нулира обиколката. */
    pause() {
        if (!this.running) {
            return;
        }
        this.paused = true;
        this.#notify(this.onPauseChange, true);
        this.stop();
    }

    /** Продължава същата фиксирана симулация след pause/blur. */
    resume() {
        if (!this.paused || this.running || this.disposed || this.failed) {
            return;
        }
        this.paused = false;
        this.#notify(this.onPauseChange, false);
        this.running = true;
        this.lastFrame = performance.now();
        restartCadenceWindow(this);
        if (this.replay) {
            this.sound.setBroadcast(true);
        } else {
            this.sound.start();
        }
        this.rafId = requestAnimationFrame(this.#frame);
    }

    /**
     * Връща колата на стартовата линия.
     *
     * @param {boolean} keepRecords Дали рекордът да се запази
     */
    reset(keepRecords = true) {
        this.stopReplay();
        this.sim.reset(keepRecords);
        this.lapAnalysis.reset();
        this.lastLapAnalysis = null;
        this.accumulator = 0;
        // Нова обиколка = ново състезание: решетка + светлини отначало.
        // Vue-то сваля подиума през същия callback (R по време на подиум).
        this.raceResult = null;
        this.onRaceFinish(null);
        this.onResultClear();
        if (this.race) {
            gridRace(this.race);
            // Ново състезание — нов инженер по радиото.
            void this.radioVoice.startRace();
        }
        this.#gridOpponents();
        this.#gridPlayer();
        this.#armLaunch();
        this.#resetPlayerRace();
        this.#placeCameraBehindCar();
        if (this.started) {
            this.#notify(this.onAttemptStart);
        }
    }

    /**
     * Зарежда духа на съперник от класацията (сървърните кадри от
     * потвърдената му обиколка) — дуелът „Карай срещу…".
     *
     * @param {{frames: string, lap_ticks: number|null, lap_ms: number, name: string}} data
     * @returns {boolean}
     */
    setRivalGhost(data) {
        const frames = decodeFrames(data.frames);
        if (!frames || frames.length < 6) {
            return false;
        }

        this.rivalGhost = {
            frames,
            // lap_ticks липсва при стари записи — извежда се от кадрите.
            lapTicks: data.lap_ticks ?? Math.floor(frames.length / 3) * FRAME_EVERY,
            name: data.name,
        };
        this.ghostDriver?.reset();
        tintGhostRig(this.ghostRig, 0xe879f9); // фуксия = съперник от класацията

        // Демото зад pre-start екрана превключва на дуелния дух.
        if (!this.running) {
            this.stopAttract();
            this.startAttract();
        }

        return true;
    }

    /**
     * Задочна битка: най-доброто състезание на играч от класацията
     * „Състезание" кара в твоето като полупрозрачна кола — без контакт, но с
     * интервал в кулата, радио на всяка обиколка и сравнение на финала.
     * Кадрите тръгват от гасенето на светлините, затова времето се подравнява
     * по часовника на състезанието.
     *
     * @param {{frames: string, name: string, total_ms: number, race_ms: number,
     *          penalties: number, race_ticks: number|null}} data
     * @returns {boolean}
     */
    setRaceRival(data) {
        const frames = decodeFrames(data.frames);
        if (!frames || frames.length < 6) {
            return false;
        }

        this.raceRival = {
            frames,
            name: data.name,
            totalMs: data.total_ms,
            raceMs: data.race_ms,
            penalties: data.penalties,
            raceTicks: data.race_ticks ?? Math.floor(frames.length / 3) * FRAME_EVERY,
            timing: null,
        };
        this.#resetRaceRivalTiming();
        this.ghostDriver?.reset();
        tintGhostRig(this.ghostRig, 0xe879f9); // фуксия = съперник от класацията

        return true;
    }

    /**
     * Гласът на радиото вкл/изкл (настройка на играча). Текстът остава винаги.
     *
     * @param {boolean} enabled
     */
    setRadioVoice(enabled) {
        this.radioVoiceEnabled = enabled;
        this.radioVoice.setEnabled(enabled);
        // Включен по средата на състезание: инженер, ако още няма избран.
        if (enabled && this.race && this.radioVoice.voice() === null) {
            void this.radioVoice.startRace();
        }
    }

    /**
     * Конфигурира AI съперниците (вика се от pre-start екрана, преди start()).
     *
     * В състезание колите СЕ БЛЪСКАТ (collisions.js) — и играчът. Полето е
     * чиста детерминирана симулация (race.js): сървърът преиграва целия
     * запис, заедно с ботовете и ударите, и времето отива в класацията
     * „Състезание" — отделна от обиколките „Сам на пистата".
     *
     * @param {number} count 0 = сам на пистата
     */
    setOpponents(count) {
        this.#clearOpponents();

        if (!count) {
            return;
        }

        // Полето + решетката: симулациите и параметрите на ботовете идват от
        // race.js (детерминирано по пистата); тук им се закачат ригове.
        this.race = createRace(this.sim, count);
        // Инженерът за това състезание (случаен глас) + изтеглени клипове.
        void this.radioVoice.startRace();
        this.opponents = this.race.opponents;

        // Геометрията на болида е идентична за всички ботове — първият риг я
        // дава на останалите (5× по-малко GPU буфери). Материалите остават
        // per-кола (ливрея + изсветляване).
        let templateGeometries = null;

        for (let i = 0; i < count; i++) {
            const opp = this.opponents[i];

            // Телефон: ботовете не хвърлят сянка — 5 × 16 меша в 512 картата
            // всеки кадър бяха най-скъпият ред в състезателния режим.
            let rig;
            if (this.carTemplate && !this.lowPower) {
                rig = buildOpponentRigFromTemplate(this.carTemplate, LIVERIES[i % LIVERIES.length], {
                    lowPower: false,
                    castShadow: true,
                    environment: this.scene.environment,
                    environmentRotation: this.scene.environmentRotation,
                    maxAniso: this.maxAniso,
                });
            } else {
                rig = buildOpponentRig(LIVERIES[i % LIVERIES.length], !this.lowPower);
                if (templateGeometries === null) {
                    templateGeometries = [];
                    rig.root.traverse((object) => {
                        if (object.isMesh) {
                            templateGeometries.push(object.geometry);
                        }
                    });
                } else {
                    // buildCar е детерминиран → редът на обхождане съвпада 1:1.
                    let next = 0;
                    rig.root.traverse((object) => {
                        if (object.isMesh) {
                            object.geometry.dispose();
                            object.geometry = templateGeometries[next++];
                        }
                    });
                }
            }
            this.scene.add(rig.root);

            const emitter = this.lowPower ? null : this.particles.createEmitter(rig);
            const skidWriter = this.lowPower ? null : this.skidMarks.createWriter(rig, emitter);
            const effects = this.lowPower
                ? null
                : createCarEffects(rig, {
                    night: this.atmosphere?.night === true,
                    lowPower: false,
                    quality: this.quality,
                    isPlayer: false,
                    seed: hashString(`${this.track.slug}:${i}`),
                });

            // Само презентация — автопилотът чете от същия обект единствено
            // полетата, които race.js е сложил (темпо, линия, others).
            Object.assign(opp, {
                rig,
                emitter,
                skidWriter,
                effects,
                drivetrain: createDrivetrain(false),
                prevX: 0,
                prevZ: 0,
                prevHeading: 0,
                _render: {},
                _dyn: {},
            });
        }

        this.#gridOpponents();
        this.#gridPlayer();
        this.#armLaunch();
        this.#resetPlayerRace();
        // GLB материалите се добавят след първоначалния ready/warm-up. CSM
        // трябва да ги patch-не преди първия grid кадър, иначе всяка каскада
        // се сумира като отделно слънце до следващия периодичен scan.
        // Изключение от renderer.compile е програмна грешка в кръпка, не
        // „бавна компилация" — следващият кадър би гръмнал със същото.
        void this.#warmup().catch((error) => this.#fail(error));
    }

    /**
     * ТВ реплей на последната завършена обиколка: колата повтаря кадрите,
     * камерата скача между крайпътни постове като телевизионна режисура.
     *
     * @returns {boolean} Дали има какво да се повтори
     */
    startReplay() {
        if (!this.lastLapFrames || this.lastLapFrames.length < 6) {
            return false;
        }

        if (!this.tvDirector.start(this.lastLapFrames)) {
            return false;
        }
        this.playerSkidWriter?.end();
        this.tvDirector.setCamera('tv');
        this.tvDirector.setSpeed(1);
        this.replay = { attract: false };
        this.ghostRig.root.visible = false;
        // ТВ картина: без halo и без двигател в ухото. Съперниците се крият —
        // записът е само на играча, а замразени в кадъра биха изглеждали
        // катастрофирали.
        for (const opp of this.opponents) {
            opp.rig.root.visible = false;
        }
        this.halo.visible = false;
        this.sound.setBroadcast(true);

        return true;
    }

    /** Изход от реплея — обратно към резултатния екран/колата. */
    stopReplay() {
        if (!this.replay) {
            return;
        }
        this.replay = null;
        this.tvDirector.stop();
        this.playerSkidWriter?.end();
        this.sound.setBroadcast(false);
        this.chaseCamera.setMode(this.cameraMode);
        this.lookTarget = this.chaseCamera.lookTarget;
        this.halo.visible = this.cameraMode === 'onboard';
        for (const opp of this.opponents) {
            opp.rig.root.visible = true;
        }
        if (this.running && !this.sound.broadcasting()) {
            this.sound.start();
        }
        this.#placeCameraBehindCar();
        // Vue-то маха своя replay overlay през този callback.
        this.onReplayEnd();
    }

    /** Преоразмерява рендера към текущия размер на canvas-а. */
    resize() {
        const width = this.canvas.clientWidth || 1;
        const height = this.canvas.clientHeight || 1;

        this.renderer.setSize(width, height, false);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        this.composer?.setSize(width, height);
        this.lightweightAa?.setSize(width, height, this.renderer.getPixelRatio());
        if (this.gradePass) {
            this.gradePass.uniforms.uAspect.value = width / height;
        }
    }

    /**
     * Управление от екранните бутони.
     *
     * @param {{throttle?: number, brake?: number, steer?: number}} values
     */
    setTouchInput(values) {
        Object.assign(this.touch, values);
    }

    /** Задава трансмисията (авто/ръчна). Вика се ПРЕДИ старта (pre-start екран). */
    setTransmission(mode) {
        this.manualTransmission = mode === 'manual';
        this.drivetrain.manual = this.manualTransmission;
    }

    /**
     * Сменя качествените настройки на живо (HUD). Частично обновяване —
     * подаваш само ключовете, които сменяш. postFx/ao пресъздават composer-а
     * (и претоплят шейдърите), shadows сменя сенчестата карта, dpr — базовата
     * резолюция; motionBlur/particles са флагове, четени по кадър. На телефон
     * composer-ът остава изключен независимо от postFx. Персистирането е
     * работа на HUD-а.
     *
     * @param {Partial<{adaptive: boolean, postFx: boolean, motionBlur: boolean,
     *                  shadows: 'low'|'high', ao: boolean, particles: number,
     *                  dpr: number}>} partial
     */
    setQuality(partial = {}) {
        if (this.disposed) {
            return;
        }
        const previous = { ...this.quality };
        Object.assign(this.quality, partial);
        const quality = this.quality;
        const adaptiveChanged = quality.adaptive !== previous.adaptive;
        if (adaptiveChanged || quality.adaptive !== true) {
            this.autoQualityStage = 0;
            this.autoQualitySlowSeconds = 0;
            // Ръчен избор сменя цената на кадъра: заключената каденца не важи.
            Object.assign(this, createCadenceState());
        }
        clampAdaptiveQuality(quality, this.autoQualityStage);
        if (this.lowPower) {
            clampLowPowerQuality(quality);
        }
        const shadowStructureChanged = quality.shadows !== previous.shadows
            || quality.csmQuality !== previous.csmQuality;

        if (quality.shadows !== previous.shadows) {
            this.#applyShadowSize(this.sun, quality.shadows);
        }
        if (shadowStructureChanged) {
            this.cascadedShadows?.setQuality(quality);
        }
        if (quality.dpr !== previous.dpr) {
            this.baseDpr = clamp(quality.dpr, 0.5, 3);
            quality.dpr = this.baseDpr;
            // Друг пикселен бюджет — преценката за каденцата е правена на стария.
            Object.assign(this, createCadenceState());
            this.#applyRenderScale();
        }
        if (quality.particles !== previous.particles) {
            this.particles.setDensity(quality.particles);
        }
        const composerChanged = quality.postFx !== previous.postFx || quality.ao !== previous.ao;
        if (composerChanged) {
            this.#disposeComposer();
            this.#setupComposer();
            this.resize();
        }
        if (composerChanged || shadowStructureChanged) {
            void this.#warmup().catch((error) => this.#fail(error));
        }
    }

    /** Сух/мокър визуален режим без промяна на детерминираната физика. */
    setWeather(mode) {
        const wet = mode === 'wet';
        this.weather = wet ? 'wet' : 'dry';
        this.surfaceController?.setWet(wet ? 1 : 0);
        this.particles?.setWet(wet);
        this.skidMarks?.setWet(wet);
        this.sound?.setRain?.(wet ? 0.75 : 0);
    }

    /** Скорост на активния ТВ реплей. */
    setReplaySpeed(speed) {
        this.tvDirector?.setSpeed(speed);
    }

    /** Камера на активния реплей: телевизионна, chase или бордова. */
    setReplayCamera(mode) {
        this.tvDirector?.setCamera(mode);
    }

    /** Търсене по относителното време на реплея (0..1). */
    setReplayTime(fraction) {
        this.playerSkidWriter?.end();
        this.tvDirector?.seek(fraction);
    }

    seekReplay(fraction) {
        this.setReplayTime(fraction);
    }

    /** Снимка на текущия кадър. */
    capturePhoto() {
        if (this.disposed || this.failed || !this.canvas?.toBlob) {
            return Promise.resolve(null);
        }
        try {
            this.#render();
        } catch (error) {
            this.#fail(error);
            return Promise.resolve(null);
        }
        return new Promise((resolve) => {
            this.canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.94);
        });
    }

    /** WebM клип от canvas-а; null в браузър без MediaRecorder/captureStream. */
    recordClip(seconds = 12) {
        return captureReplayClip(this.canvas, seconds);
    }

    /** Данните от последната завършена обиколка за резултатния анализ. */
    getLapAnalysis() {
        return this.lastLapAnalysis;
    }

    /**
     * Chase ↔ бордова (halo) камера. Без ефект по време на ТВ реплей.
     *
     * @param {'chase'|'onboard'} mode
     */
    setCameraMode(mode) {
        if (this.replay || mode === this.cameraMode || (mode !== 'chase' && mode !== 'onboard')) {
            return;
        }
        this.cameraMode = mode;
        this.chaseCamera.setMode(mode);
        this.halo.visible = mode === 'onboard';
        this.lookTarget = this.chaseCamera.lookTarget;
    }

    /**
     * Заглушава/пуска звука. Не и в ТВ реплей — там звукът е спрян и unmute
     * би пуснал двигателя на замразени обороти за миг.
     *
     * @param {boolean} muted
     */
    setMuted(muted) {
        if (this.replay) {
            return;
        }
        this.sound.setMuted(muted);
    }

    /** Освобождава WebGL ресурсите. Задължително при unmount. */
    dispose() {
        this.disposed = true;
        this.stop();
        this.tvDirector?.dispose();
        this.chaseCamera?.dispose();
        this.carEffects?.dispose();
        this.#clearOpponents();
        this.playerSkidWriter?.end();
        this.cascadedShadows?.dispose();
        this.nightLights?.dispose();
        this.surfaceController?.dispose();
        this.atmosphere?.dispose();
        this.trackGroup?.userData.dispose?.();
        this.sound.dispose();
        this.particles.dispose();
        this.skidMarks.dispose();
        this.#unbindEvents();

        // Риговете имат споделени GLB геометрии; собственият им dispose знае
        // кои ресурси са кеширани и кои принадлежат на конкретната игра.
        this.scene.remove(this.carRig.root, this.ghostRig.root);
        this.carRig.dispose?.();
        this.ghostRig.dispose?.();

        this.scene.traverse((object) => {
            if (object.geometry && !object.geometry.userData?.shared) {
                object.geometry.dispose();
            }

            if (object.material) {
                const materials = Array.isArray(object.material)
                    ? object.material
                    : [object.material];

                for (const material of materials) {
                    // material.dispose() НЕ чисти картите — освобождаваме ги ръчно,
                    // иначе canvas текстурите (публика/бордове/флаг) и текстурите на
                    // GLB болида текат GPU памет при всеки quit/restart.
                    for (const key of DISPOSABLE_MAPS) {
                        material[key]?.dispose?.();
                    }
                    material.dispose();
                }
            }

            // geometry.dispose() НЕ чисти instanceMatrix буферите — трибуните,
            // ориентирите и дърветата са InstancedMesh (а BatchedMesh държи
            // и собствени текстури с матрици); освобождаваме ги изрично.
            if (object.isInstancedMesh || object.isBatchedMesh) {
                object.dispose();
            }
        });

        this.#disposeComposer();
        this.cubeRT?.dispose();
        this.envRT?.dispose();
        this.hdrBackground?.dispose();
        // Shadow map-ът на слънцето е отделен render target — нито traverse-ът,
        // нито renderer.dispose() го чистят (~4 MB GPU на рестарт).
        this.sun?.shadow?.dispose?.();
        this.renderer.dispose();
        // renderer.dispose() пуска кешовете на three, но НЕ контекста: всяка
        // писта е нов canvas + renderer (Index.vue) и контекстите се трупат до
        // GC. Chrome пази ~16 живи и гаси НАЙ-СТАРИЯ — след достатъчно
        // рестарти това е текущата игра. Губим го изрично.
        this.renderer.forceContextLoss();
    }

    // ── Вътрешни ─────────────────────────────────────────────────────────

    /**
     * Асфалтът се пече веднага; тревата и чакълът зареждат PBR карти.
     * Промисът влиза в this.ready, за да са готови преди първия кадър.
     *
     * @returns {Promise<void>}
     */
    #loadTrackTextures() {
        const loader = new THREE.TextureLoader();
        const maxAniso = this.renderer.capabilities.getMaxAnisotropy?.() ?? 1;

        // Зарежда една карта; резолвва с текстурата при успех или с null при
        // грешка (никога reject).
        const load = (url, srgb, repeat) => new Promise((resolve) => {
            const texture = loader.load(url, () => resolve(texture), undefined, () => resolve(null));
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;
            texture.anisotropy = maxAniso;
            texture.repeat.set(repeat[0], repeat[1]);
            if (srgb) {
                texture.colorSpace = THREE.SRGBColorSpace;
            }
            return texture;
        });

        // Подменя процедурния материал на повърхността САМО при успешен diffuse
        // и само ако играта още не е тръгнала/освободена — иначе остава
        // процедурният цвят (без черно, без късен pop). repeat: u напречно (по
        // ширината), v по дължина на всеки 8 m (виж UV-то в ribbonMesh).
        // Телефон: само diffuse — normal/rough картите (≈4.3 MB) не се четат
        // на малък екран под движеща се камера, а тройният texture fetch на
        // фрагмент яде точно тесния мобилен bandwidth.
        const detail = !this.lowPower;
        const asphalt = this.surfaceMaterials?.asphalt;
        if (asphalt) {
            const textures = createAsphaltTextures({ detail, anisotropy: maxAniso, repeat: surfaceRepeat('asphalt') });
            for (const slot of ['map', 'normalMap', 'roughnessMap']) {
                asphalt[slot]?.dispose?.();
                asphalt[slot] = textures[slot];
            }
            asphalt.color.set(0xffffff);
            asphalt.vertexColors = true;
            asphalt.needsUpdate = true;
        }
        const applyTo = (name, dir, repeat) => Promise.all([
            load(`/game-textures/${dir}/diff.jpg`, true, repeat),
            detail ? load(`/game-textures/${dir}/nor.jpg`, false, repeat) : Promise.resolve(null),
            detail ? load(`/game-textures/${dir}/rough.jpg`, false, repeat) : Promise.resolve(null),
        ]).then(([map, normalMap, roughnessMap]) => {
            const material = this.surfaceMaterials?.[name];
            if (!map || this.started || this.disposed || !material) {
                for (const texture of [map, normalMap, roughnessMap]) {
                    texture?.dispose?.();
                }
                return;
            }
            // Чакълът тръгва с процедурна canvas карта — освобождаваме я, преди
            // да я подменим, иначе стои в GPU паметта до края на сесията.
            material.map?.dispose?.();
            material.map = map;
            material.normalMap = normalMap;
            material.roughnessMap = roughnessMap;
            // Геометричната вариация е неутрална около 1.0 и разбива
            // повторението на тайла; запазваме я и след идването на PBR картите.
            material.vertexColors = true;
            // Тревата се тонира според пистата (изсушена в Зандвоорт, златиста
            // в Монца) — текстурата е обща, характерът идва от тона.
            material.color.set(name === 'grass' ? this.circuit.grassTint : 0xffffff);
            material.needsUpdate = true;
        });

        // Бавна мрежа да не държи loading екрана безкрайно.
        return Promise.race([
            Promise.all([
                applyTo('grass', 'grass', [surfaceRepeat('grass'), surfaceRepeat('grass')]),
                applyTo('gravel', 'gravel', [surfaceRepeat('gravel'), surfaceRepeat('gravel')]),
            ]),
            new Promise((resolve) => setTimeout(resolve, 6000)),
        ]);
    }

    #setupEnvironment() {
        // Посока на слънцето от азимут/елевация — част от атмосферата на
        // пистата (ниското златно слънце на Монца, високото на Монако).
        const atmosphere = this.circuit.atmosphere;
        const night = atmosphere.night === true;
        const elevation = atmosphere.sunElevation;
        const azimuth = atmosphere.sunAzimuth;
        const phi = THREE.MathUtils.degToRad(90 - elevation);
        const theta = THREE.MathUtils.degToRad(azimuth);
        const sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);

        // Нощ: „слънцето" на НЕБЕСНИЯ шейдър отива под хоризонта (-12°) —
        // Rayleigh моделът сам дава тъмносиния здрач; directional-ът горе
        // остава конфигурираният (сборният ефект на прожекторите).
        const skyPhi = night ? THREE.MathUtils.degToRad(90 + 12) : phi;
        const skySunDir = new THREE.Vector3().setFromSphericalCoords(1, skyPhi, theta);

        // Атмосферно небе (Rayleigh/Mie). Рендираме го в кубмап → фон (винаги на
        // хоризонта, независимо от позицията) + environment map за IBL.
        const sky = new Sky();
        sky.scale.setScalar(10000);
        const u = sky.material.uniforms;
        u.turbidity.value = 6;
        u.rayleigh.value = 2.2;
        u.mieCoefficient.value = 0.005;
        u.mieDirectionalG.value = 0.8;
        u.sunPosition.value.copy(skySunDir);

        // HalfFloat: слънчевият диск на Sky (~130× след pow-компресията в
        // края на шейдъра) и хоризонтът над 1.0 оцеляват до PMREM-а и bloom-а.
        // В 8-битов куб се режеха на 1.0 → плоско IBL по боята и bloom, който
        // никога не вижда слънцето. Това е ЕДИНСТВЕНОТО небе на телефоните и
        // на нощните писти. 6×512² half-float = 6 MB, еднократно.
        // Телефон: 256. HalfFloat-ът е това, което спасява слънцето и
        // хоризонта; размерът на стената решава само остротата на диска, а
        // на 6" 3-texel диск не се чете. PMREM-ът се оразмерява по стената
        // (3·N × 4·N HalfFloat RGBA) и стои жив цял сезон като environment:
        // 25 MB при 512 срещу 6 MB при 256, плюс 4× по-дълъг blur при
        // зареждане — без видима полза на малкия екран.
        const cubeRT = new THREE.WebGLCubeRenderTarget(this.lowPower ? 256 : 512, { type: THREE.HalfFloatType });
        const cubeCam = new THREE.CubeCamera(1, 200000, cubeRT);
        const skyScene = new THREE.Scene();
        skyScene.add(sky);
        cubeCam.update(this.renderer, skyScene);

        // Композируемият атмосферен слой семплира същото процедурно небе,
        // добавя височинна мъгла, слънчев/лунен диск, облаци, вятър и общите
        // облачни сенки за настилките. Семплирането е синхронно, преди
        // desktop кубът да бъде освободен по-долу.
        this.atmosphere = createAtmosphere({
            renderer: this.renderer,
            scene: this.scene,
            circuit: this.circuit,
            lowPower: this.lowPower,
            quality: this.quality,
            cubeRT,
            sunDir,
            track: this.track,
            slug: this.track.slug,
        });

        const pmrem = new THREE.PMREMGenerator(this.renderer);
        this.envRT = pmrem.fromCubemap(cubeRT.texture);
        this.scene.environment = this.envRT.texture;
        if (this.lowPower) {
            // Телефон: суровият куб — един samplerCube fetch на пиксел небе.
            // Замъгленият вариант отдолу минава през CubeUV (2×4 fetch-а +
            // клонове) върху ~40% от екрана, а на 6" назъбеният 3-texel
            // слънчев диск не се чете. Кубът остава жив до dispose().
            this.scene.background = cubeRT.texture;
            this.scene.backgroundBlurriness = 0;
            this.cubeRT = cubeRT;
        } else {
            // Десктоп: фонът е САМИЯТ PMREM (CubeUV), не суровият куб —
            // backgroundBlurriness > 0 иначе би накарал three да генерира
            // ВТОРИ вътрешен PMREM само за фона. 0.05 → roughnessToMip =
            // −2·log2(1.16·0.05) ≈ 8.2, т.е. ~256-px ниво на 512 куб: колкото
            // днешната резолюция, но HDR, гладко и без назъбен ръб на
            // слънчевия диск. Нулира се, когато HDRI-то стане фон. Кубът
            // вече не трябва на никого (6 MB) — освобождава се веднага.
            this.scene.background = this.envRT.texture;
            this.scene.backgroundBlurriness = 0.05;
            cubeRT.dispose();
            this.cubeRT = null;
        }
        // Същата сила като при HDRI-то → няма скок в осветлението, ако HDRI-то
        // се приложи по-късно или изобщо липсва. Нощем env-ът е блед здрач.
        this.scene.environmentIntensity = night ? 0.25 : 0.5;

        // Звезди над нощните писти — статичен Points купол. Радиусът стои ПОД
        // far плана на камерата (2200): точка извън клип обема се реже изцяло
        // от GPU-то (frustumCulled=false спира само CPU cull-а). Seed-ът е
        // детерминиран по пистата — небето не се разбърква при рестарт.
        if (night) {
            const starCount = 450;
            const positions = new Float32Array(starCount * 3);
            const rand = mulberry32(hashString(this.track.slug));
            for (let i = 0; i < starCount; i++) {
                // Горна полусфера, равномерно по площ.
                const azimuthAngle = rand() * Math.PI * 2;
                const y = 0.12 + rand() * 0.88;
                const r = Math.sqrt(1 - y * y);
                positions[i * 3] = Math.cos(azimuthAngle) * r * 1800;
                positions[i * 3 + 1] = y * 1800;
                positions[i * 3 + 2] = Math.sin(azimuthAngle) * r * 1800;
            }
            const starGeometry = new THREE.BufferGeometry();
            starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            const stars = new THREE.Points(
                starGeometry,
                new THREE.PointsMaterial({
                    color: 0xdfe8ff,
                    size: 2.0,
                    sizeAttenuation: false,
                    transparent: true,
                    opacity: 0.8,
                    depthWrite: false,
                    fog: false,
                })
            );
            stars.frustumCulled = false;
            this.scene.add(stars);
            // Куполът следва камерата в #render (skybox трик): пистите не са
            // центрирани в origin-а (Джеда стига ~1.4 km встрани) и статичен
            // купол пак би излязъл извън far плана на отсрещния ръб.
            this.stars = stars;
        }
        pmrem.dispose();
        sky.geometry.dispose();
        sky.material.dispose();

        // Небесен fill: малък ОСТАТЪК над env картата (тя вече носи небето;
        // двете околни светлини се сумираха и сенчестият асфалт беше едва
        // по-тъмен от огрения), с цветовете на пистата: небе = мъглата,
        // повдигната 20%, земя = основният тон на терена. Нощем студен и слаб.
        const hemisphere = night
            ? new THREE.HemisphereLight(0x27324a, 0x0b0d12, 0.35)
            : new THREE.HemisphereLight(
                new THREE.Color(atmosphere.fogColor).lerp(new THREE.Color(0xffffff), 0.2),
                this.circuit.terrain.base,
                0.3
            );
        this.scene.add(hemisphere);
        this.hemisphere = hemisphere;
        this.atmosphere.setHemisphere(hemisphere);

        const sun = new THREE.DirectionalLight(atmosphere.sunColor, atmosphere.sunIntensity);
        sun.castShadow = this.quality.shadows !== 'off';
        // Bias в световни метри, ~1 texel от кутията (виж #applyShadowSize).
        // Старите 0.6 m бяха ~10 texel-а: точката на сянката се вдигаше над
        // колелата и дъното, а отпечатъкът се местеше към слънцето с
        // 0.6/tan(24°) ≈ 1.35 m на Монца — сянката не докосваше гумите.
        // Малкият bias е коректен, защото GLB-то е FrontSide
        // (#tightenCarMaterials): сенчестият pass рисува само гърбовете.
        sun.shadow.bias = -0.0002;
        this.#applyShadowSize(sun, this.quality.shadows);
        // Само болидът и близкият декор хвърлят сянка и сенчестата камера
        // следва колата — затова стягаме кутията до ~60 m около нея. 1024
        // върху 60 m е остро (~17 texel/m), докато 170 m разпиляваха картата
        // по празен терен. По-малка кутия = по-остра сянка И по-евтино.
        const s = SHADOW_HALF_SIZE;
        Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 900 });
        sun.shadow.camera.updateProjectionMatrix();
        this.scene.add(sun);
        this.scene.add(sun.target);

        this.sun = sun;
        this.sunDir = sunDir;
        // Базисът на светлинното пространство — същият, който
        // DirectionalLightShadow строи с lookAt от слънцето към target-а
        // (z = sunDir, up = Y). Центърът на кутията се закръгля до texel в
        // него (#followSun), така че решетката на сенчестата карта стои
        // неподвижна в света и сянката не пълзи по ръбовете при движение.
        this._sunBasis = new THREE.Matrix4().lookAt(sunDir, new THREE.Vector3(), THREE.Object3D.DEFAULT_UP);
        this._sunBasisInverse = this._sunBasis.clone().transpose();
        this._sunCenter = new THREE.Vector3();

        // ── Фаза 2: истински HDRI за околната среда ──────────────────────────
        // Отраженията по clearcoat боята и по мокрия асфалт идват от снимано
        // небе (Poly Haven CC0), не от процедурното — оттам „реалният" вид.
        //
        // Процедурното небе горе е само мигновен placeholder. HDRI-то се
        // ЗАРЕЖДА ПРЕДИ старта (Game.start го чака през this.ready), за да не
        // подменя фон/светлина по средата на играта („смяна на климата").
        // PMREM се смята веднъж → нулев per-frame разход. Никога не reject-ва:
        // при липсващ файл или бавна мрежа остава процедурното небе.
        // Нощем HDRI (дневно небе) няма работа — процедурният здрач остава.
        // На телефон — също: 4.5 MB заради отражения, нечетими на 6" екран.
        if (night || this.lowPower) {
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            let settled = false;
            const done = () => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                resolve();
            };
            // Бавна мрежа да не държи loading екрана безкрайно.
            const timer = setTimeout(done, 6000);

            // Небето е част от идентичността: мрачното на Спа не е това на
            // Монако. Файлът идва от atmosphere.hdri (по подразбиране общото).
            const hdriName = atmosphere.hdri ?? 'sky_2k';
            new HDRLoader().load(
                `/game-hdri/${hdriName}.hdr`,
                (hdr) => {
                    // Късно (след timeout/старт) или след освобождаване — не
                    // подменяй фона (би било pop) и не пускай PMREM на мъртъв renderer.
                    if (this.started || this.disposed) {
                        hdr.dispose?.();
                        done();
                        return;
                    }
                    hdr.mapping = THREE.EquirectangularReflectionMapping;
                    const pmrem = new THREE.PMREMGenerator(this.renderer);
                    const envRT = pmrem.fromEquirectangular(hdr);
                    pmrem.dispose();

                    this.envRT?.dispose?.();       // старият env (от процедурното небе)
                    this.envRT = envRT;
                    this.scene.environment = envRT.texture;
                    this.scene.environmentIntensity = 0.5;
                    this.scene.background = hdr;    // видимото небе = HDRI → отраженията съвпадат с гледката
                    // Без blur three конвертира equirect-а в 1024-px куб (=
                    // image.height, WebGLCubeMaps) — по-остър от 512 PMREM-а,
                    // през който би минал фонът при blur > 0.
                    this.scene.backgroundBlurriness = 0;
                    this.hdrBackground = hdr;       // пазим за dispose при teardown
                    // Запеченото слънце на снимката застава на азимута на
                    // аналитичното — иначе отражението по боята и сянката сочат
                    // в различни посоки.
                    const rotation = this.#hdriRotation(hdriName, hdr);
                    this.scene.environmentRotation.y = rotation;
                    this.scene.backgroundRotation.y = rotation;
                    this.atmosphere?.sampleSky({ hdr });
                    done();
                },
                undefined,
                done,   // няма HDRI → остава процедурното небе
            );
        });
    }

    /**
     * Завъртане (rad, ос Y), което подравнява запеченото слънце на HDRI-то с
     * аналитичното. Азимутът на снимката идва от atmosphere.hdriSunAzimuth
     * (градуси, конвенцията на sunAzimuth), а при липса се измерва веднъж по
     * най-ярката колона на equirect-а (слънцето е 100–1000× над всичко друго;
     * при облачно небе колоната е произволна и завъртането е безвредно).
     *
     * Конвенции на three: equirectUv дава u = atan(dir.z, dir.x)/2π + 0.5, а
     * environmentRotation/backgroundRotation се прилагат с ОБЪРНАТ знак върху
     * посоката на четене (WebGLMaterials/WebGLBackground „accommodate
     * left-handed frame"): при завъртане ρ светът в посока φ чете картата в
     * φ + ρ. Слънцето на картата (φ_hdri) да се види в посоката на
     * аналитичното (φ_sun): φ_sun + ρ = φ_hdri → ρ = φ_hdri − φ_sun.
     *
     * @param {string} name Файлът (ключ на кеша)
     * @param {THREE.DataTexture} hdr
     * @returns {number}
     */
    #hdriRotation(name, hdr) {
        const atmosphere = this.circuit.atmosphere;
        const sunAngle = Math.atan2(this.sunDir.z, this.sunDir.x);
        let hdriAngle;
        if (typeof atmosphere.hdriSunAzimuth === 'number') {
            const theta = THREE.MathUtils.degToRad(atmosphere.hdriSunAzimuth);
            hdriAngle = Math.atan2(Math.cos(theta), Math.sin(theta)); // setFromSphericalCoords: x = sinθ, z = cosθ
        } else {
            hdriAngle = measureHdriSunAngle(name, hdr);
        }

        return hdriAngle - sunAngle;
    }

    /**
     * Размер на сенчестата карта по качество + bias ≈ 1 texel в метри
     * (60 m / 1024 = 5.9 cm → 0.05; 60 m / 512 = 11.7 cm → 0.08). three
     * създава map-а само когато е null — при смяна го освобождаваме.
     *
     * @param {THREE.DirectionalLight} sun
     * @param {'low'|'high'} level
     */
    #applyShadowSize(sun, level) {
        sun.castShadow = level !== 'off';
        this.renderer.shadowMap.enabled = level !== 'off';
        if (level === 'off') {
            return;
        }
        const size = level === 'high' ? 1024 : 512;
        sun.shadow.mapSize.set(size, size);
        sun.shadow.normalBias = size >= 1024 ? 0.05 : 0.08;
        this.shadowTexel = (2 * SHADOW_HALF_SIZE) / size;
        if (sun.shadow.map) {
            sun.shadow.map.dispose();
            sun.shadow.map = null;
        }
    }

    /**
     * GLB материалите идват DoubleSide от glTF-а. За сенките това е бедствие:
     * FrontSide обекти three рисува в shadow map-а с обърнати страни (само
     * гърбовете → без acne с малък bias), а DoubleSide влиза с двете страни и
     * иска огромния normalBias, който отлепяше сянката от гумите. FrontSide +
     * normalBias ~1 texel = контактна сянка под колата. (car-model пакетът
     * поема това в car.js; дублирането е безвредно.)
     */
    #tightenCarMaterials() {
        this.carRig.model?.traverse((object) => {
            if (!object.isMesh) {
                return;
            }
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            for (const material of materials) {
                if (material && material.side !== THREE.FrontSide) {
                    material.side = THREE.FrontSide;
                    material.needsUpdate = true;
                }
            }
        });
    }

    #setupComposer() {
        const generation = ++this.composerGeneration;
        this.composerReady = COMPOSER_READY;
        this.gtaoPass = null;

        // Native MSAA keeps the mobile/initial-Low path direct. A desktop
        // context created for the full composer cannot gain native MSAA later;
        // its lightweight fallback preserves edges when Auto sheds effects.
        if (this.lowPower || this.quality.postFx === false) {
            this.composer = null;
            this.composerTarget = null;
            this.bloomPass = null;
            this.gradePass = null;
            this.particles?.setDepth(null);
            if (!this.lowPower
                && this.renderer.getContext().getContextAttributes()?.antialias === false
                && this.renderer.extensions.has('EXT_color_buffer_float')) {
                this.lightweightAa = createLightweightAa(this.renderer);
                this.lightweightAa.setSize(this.canvas.clientWidth || 1, this.canvas.clientHeight || 1, this.renderer.getPixelRatio());
            }
            return;
        }

        const w = this.canvas.clientWidth || 1;
        const h = this.canvas.clientHeight || 1;
        const dpr = this.renderer.getPixelRatio();
        const pw = Math.max(1, Math.round(w * dpr));
        const ph = Math.max(1, Math.round(h * dpr));

        // Сцената се рисува в MSAA HalfFloat target с depth ТЕКСТУРА: three
        // резолвва цвят + дълбочина (blitFramebuffer) в края на всеки
        // renderer.render в него, така че следващите ефекти (меки частици,
        // heat haze, AO) четат composerTarget.depthTexture. Хардуерният MSAA
        // замества трите SMAA прохода и не трепти по оградите/кербовете.
        const sceneTarget = new THREE.WebGLRenderTarget(pw, ph, {
            type: THREE.HalfFloatType,
            samples: Math.min(4, this.renderer.capabilities.maxSamples),
            depthTexture: new THREE.DepthTexture(pw, ph),
        });
        // Ping-pong партньорът е без MSAA/depth texture: в него пишат само
        // fullscreen проходи (грейдът) — MSAA там е чиста загуба на памет.
        const pingTarget = new THREE.WebGLRenderTarget(pw, ph, { type: THREE.HalfFloatType });

        const composer = new EffectComposer(this.renderer, pingTarget);
        // EffectComposer клонира подадения target за renderTarget2, а
        // RenderPass рисува в readBuffer = renderTarget2 (EffectComposer.js:97,
        // RenderPass.js:146). Заменяме клонинга със сцената target; #render
        // пази ролите след всеки кадър.
        composer.renderTarget2.dispose();
        composer.renderTarget2 = sceneTarget;
        composer.readBuffer = sceneTarget;

        composer.addPass(new RenderPass(this.scene, this.camera));

        const night = this.circuit.atmosphere.night === true;
        this.bloomPass = new UnrealBloomPass(
            new THREE.Vector2(w, h),
            night ? BLOOM.nightStrength : BLOOM.strength,
            BLOOM.radius,
            BLOOM.threshold
        );
        composer.addPass(this.bloomPass);

        // Broadcast грейд + скоростни ефекти — един fullscreen проход (postfx.js).
        this.gradePass = createGradePass({
            grade: gradeFor(this.circuit),
            saturationScale: TONE_PRESETS[TONE_MAPPING].saturationScale,
            aspect: w / h,
        });
        composer.addPass(this.gradePass);

        // Финал: tone mapping (от renderer.toneMapping) + sRGB към екрана. При
        // composer рендерът е линеен до OutputPass, затова няма двойно tone mapping.
        composer.addPass(new OutputPass());

        // Подаденият target е във физически пиксели, а setSize приема логически
        // и сам умножава по pixel ratio-то на renderer-а — изравнява размерите
        // на passes-ите, които конструкторът е оразмерил от физическия target.
        composer.setSize(w, h);
        this.composer = composer;
        this.composerTarget = sceneTarget;
        this.particles?.setDepth(() => this.composerTarget?.depthTexture ?? null);

        // Само изрично Ultra (ao === true) заявява този chunk. Auto/High/Medium/
        // Low и мобилният early return по-горе не парсват модула и не създават
        // targets, материали или кадърна работа. AO влиза преди bloom/grade.
        if (this.quality.ao === true) {
            this.composerReady = import('./ultraPostfx.js')
                .then(({ createUltraGtaoPass }) => {
                    if (
                        this.disposed
                        || generation !== this.composerGeneration
                        || composer !== this.composer
                        || this.quality.ao !== true
                    ) {
                        return;
                    }
                    const gtaoPass = createUltraGtaoPass({
                        camera: this.camera,
                        depthTexture: sceneTarget.depthTexture,
                    });
                    composer.insertPass(gtaoPass, 1);
                    this.gtaoPass = gtaoPass;
                })
                .catch((error) => {
                    if (!this.disposed && generation === this.composerGeneration) {
                        console.warn('Ultra GTAO failed to load; continuing without AO.', error);
                    }
                });
        }
    }

    /** Освобождава composer-а с всичките му проходи и targets. */
    #disposeComposer() {
        // Обезсилва евентуален import още преди early return-а. Callback-ът му
        // ще види различен generation и няма да създаде никакъв GPU ресурс.
        this.composerGeneration += 1;
        this.composerReady = COMPOSER_READY;
        this.gtaoPass = null;
        this.lightweightAa?.dispose();
        this.lightweightAa = null;
        if (!this.composer) {
            return;
        }
        // EffectComposer.dispose() не чисти passes-ите — Bloom/Output държат
        // собствени render targets, които иначе текат при всеки quit/rebuild.
        for (const pass of this.composer.passes) {
            pass.dispose?.();
        }
        this.composer.dispose(); // renderTarget1 + renderTarget2 (= composerTarget)
        this.composerTarget.depthTexture?.dispose();
        this.composer = null;
        this.composerTarget = null;
        this.bloomPass = null;
        this.gradePass = null;
        this.gtaoPass = null;
    }

    /** Loading прогрес към Vue: болидът е ~70% от реалните байтове. */
    #reportProgress() {
        this.onProgress(
            Math.min(0.99, this.loadParts.car * 0.7 + this.loadParts.env * 0.15 + this.loadParts.tex * 0.15)
        );
    }

    /** Adapt presentation to sustained load, preserving clarity before expensive effects. */
    #governResolution(rawDt) {
        const change = advanceQualityGovernor(this, rawDt, {
            adaptive: this.quality.adaptive,
            lowPower: this.lowPower,
            // Светлините и реплеят рисуват друга сцена: кадрите им хранят
            // средното, но не решават за каденцата.
            racing: !this.launch && !this.replay,
        });
        if (change.stageChanged) {
            this.setQuality(this.autoQualityStage === 1 ? {
                motionBlur: false,
                csmQuality: 'medium',
                particles: 0.75,
            } : {
                postFx: false,
                motionBlur: false,
                shadows: 'low',
                csmQuality: 'low',
                ao: false,
                particles: 0.5,
            });
        }
        if (change.scaleChanged) {
            this.#applyRenderScale();
        }
    }

    #applyRenderScale() {
        this.renderer.setPixelRatio(this.baseDpr * this.renderScale);
        // EffectComposer кешира pixel ratio-то при конструкция — без изричния
        // setPixelRatio неговите render targets (RenderPass/Bloom/SMAA, т.е.
        // основната GPU цена) остават на пълна резолюция и governor-ът само
        // замъглява картината, без да печели кадри.
        this.composer?.setPixelRatio(this.baseDpr * this.renderScale);
        // Частиците са оразмерени в буферни пиксели — подаваме новия мащаб,
        // за да не подскачат спрямо колата при стъпка на governor-а.
        this.particles.setScale(this.baseDpr * this.renderScale);
        this.nightLights?.setPixelScale(this.baseDpr * this.renderScale);
        this.resize();
    }

    /** Рендер през composer-а (десктоп) или директно (телефон). */
    #render() {
        // Звездите (нощ) висят на фиксиран радиус ОКОЛО камерата — така
        // никога не опират far плана, а без паралакс изглеждат безкрайно далеч.
        this.stars?.position.copy(this.camera.position);
        if (this.composer) {
            this.composer.render();
            // Инвариант: RenderPass рисува в readBuffer, а всеки проход с
            // needsSwap разменя буферите — при нечетен брой размени следващият
            // кадър би рисувал сцената в ping-pong партньора без MSAA/depth.
            // Връщаме ролите, за да може всеки пакет да добавя проходи свободно.
            if (this.composer.readBuffer !== this.composerTarget) {
                this.composer.swapBuffers();
            }
        } else if (this.lightweightAa) {
            this.lightweightAa.render(this.scene, this.camera);
        } else {
            this.renderer.render(this.scene, this.camera);
        }
    }

    /**
     * Компилира шейдърите ПРЕДИ старта, докато loading екранът е горе
     * (this.ready чака). renderer.compile пуска линковането (паралелно, ако
     * има KHR_parallel_shader_compile), а ние изчакваме програмите да са
     * готови, преди двата реални кадъра, които топлят post passes-ите — иначе
     * първият composer.render() блокира главната нишка за 100–500 ms точно
     * при „Карай". Собствен poll вместо renderer.compileAsync: неговият цикъл
     * не знае за dispose и при напускане по време на зареждане би се въртял
     * вечно върху загубен контекст.
     */
    async #warmup() {
        // Ultra pass-ът е lazy, но трябва да е закачен и компилиран преди
        // loading екранът да изчезне. При жива смяна старият warm-up се отказва.
        const composerGeneration = this.composerGeneration;
        await this.composerReady;
        if (this.disposed || composerGeneration !== this.composerGeneration) {
            return;
        }
        this.#followSun(this.sim.state.x, this.sim.surface.height, this.sim.state.z);
        this.cascadedShadows?.refreshMaterials();
        this.cascadedShadows?.update(this.carRig.root.position);
        const materials = this.renderer.compile(this.scene, this.camera);
        await this.#awaitPrograms(materials);
        if (this.disposed || composerGeneration !== this.composerGeneration) {
            return;
        }
        // renderer.compile не топли post passes-ите — трябват реални кадри.
        this.#render();
        this.#render();
    }

    /**
     * @param {Set<THREE.Material>} materials Върнати от renderer.compile
     * @returns {Promise<void>}
     */
    #awaitPrograms(materials) {
        return new Promise((resolve) => {
            const check = () => {
                if (this.disposed) {
                    resolve();
                    return;
                }
                for (const material of materials) {
                    const program = this.renderer.properties.get(material).currentProgram;
                    if (!program || program.isReady()) {
                        materials.delete(material);
                    }
                }
                if (materials.size === 0) {
                    resolve();
                    return;
                }
                setTimeout(check, 10);
            };
            check();
        });
    }

    /**
     * Духът от localStorage: {frames, lapTicks} или null.
     */
    #loadGhost() {
        try {
            const raw = localStorage.getItem(ghostKey(this.track.slug));
            if (!raw) {
                return null;
            }
            const parsed = JSON.parse(raw);
            if (parsed.v !== SIM_VERSION) {
                return null; // стар запис от друга физика — не е честен съперник
            }
            const frames = decodeFrames(parsed.frames);
            return frames ? { frames, lapTicks: parsed.lapTicks } : null;
        } catch {
            return null;
        }
    }

    /**
     * Официалният дух на Падок (public/game-ghosts, scripts/game/build-ghosts.mjs):
     * еталонна обиколка на автопилота — показва се, докато нямаш собствена.
     */
    async #loadOfficialGhost() {
        try {
            const response = await fetch(`/game-ghosts/${this.track.slug}.json`);
            if (!response.ok) {
                return;
            }
            const parsed = await response.json();
            // Междувременно играчът може да е направил своя обиколка — тя печели.
            if (parsed.v !== SIM_VERSION || this.disposed || this.ghost) {
                return;
            }
            const frames = decodeFrames(parsed.frames);
            if (!frames) {
                return;
            }
            this.ghost = { frames, lapTicks: parsed.lapTicks, official: true };
            if (!this.rivalGhost && !this.raceRival) {
                tintGhostRig(this.ghostRig, 0xf2c14e); // златист = официалният
            }
            // Ако pre-start екранът още стои — духът тръгва като демо.
            this.startAttract();
        } catch {
            // Няма официален дух за тази писта — нищо страшно.
        }
    }

    /** Подменя процедурния дух с холограмен клонинг на същия GLB болид. */
    #upgradeGhostRig(template) {
        if (!template || this.disposed || !this.ghostRig) {
            return;
        }
        const tint = this.rivalGhost || this.raceRival ? 0xe879f9 : this.ghost?.official ? 0xf2c14e : 0x9fc8ff;
        const previous = this.ghostRig;
        const next = buildGhostRigFromTemplate(template, tint);
        next.root.visible = previous.root.visible;
        next.root.position.copy(previous.root.position);
        next.root.quaternion.copy(previous.root.quaternion);
        this.scene.add(next.root);
        this.scene.remove(previous.root);
        previous.dispose?.();
        this.ghostRig = next;
    }

    /**
     * Пази новия рекорден дух (тихо — квотата на localStorage не е гарантирана).
     *
     * @param {Float32Array} frames
     * @param {number} lapTicks
     */
    #saveGhost(frames, lapTicks) {
        // Духът в паметта се обновява ВИНАГИ — квотата на localStorage може
        // да провали само персистирането, не тазсесийния съперник.
        if (this.ghost?.official && !this.rivalGhost && !this.raceRival) {
            tintGhostRig(this.ghostRig, 0x9fc8ff); // вече е личният, син
        }
        this.ghost = { frames, lapTicks };
        this.ghostDriver?.reset();

        try {
            localStorage.setItem(
                ghostKey(this.track.slug),
                JSON.stringify({ v: SIM_VERSION, lapTicks, frames: encodeFrames(frames) })
            );
        } catch {
            // Пълно/блокирано хранилище — духът просто не се запазва за после.
        }
    }

    #placeCameraBehindCar() {
        const state = this.sim.state;
        if (this.chaseCamera) {
            this.chaseCamera.setMode(this.cameraMode);
            this.chaseCamera.snap(state, this.sim.surface);
            this.lookTarget = this.chaseCamera.lookTarget;
            return;
        }
        const forwardX = Math.sin(state.heading);
        const forwardZ = Math.cos(state.heading);

        this.camera.position.set(
            state.x - forwardX * CAMERA.distance,
            this.sim.surface.height + CAMERA.height,
            state.z - forwardZ * CAMERA.distance
        );
        this.camera.lookAt(state.x, this.sim.surface.height + 0.6, state.z);
    }

    #bindEvents() {
        this.onKeyDown = (event) => {
            if (!shouldCaptureGameKey(event, this.started)) {
                this.keys.delete(event.code);
                return;
            }
            if (INTERESTING_KEYS.has(event.code)) {
                event.preventDefault();
                this.keys.add(event.code);
            }

            // R преди старта би убил attract демото зад pre-start екрана
            // (reset → stopReplay нулира replay и цикълът му умира на място) —
            // рестартът има смисъл само след „Карай".
            if (event.code === 'KeyR' && this.started) {
                this.reset(true);
            }

            // C превключва chase ↔ бордова (halo) камера (не и в ТВ реплей).
            if (event.code === 'KeyC' && !event.repeat) {
                this.setCameraMode(this.cameraMode === 'chase' ? 'onboard' : 'chase');
            }

            // M заглушава/пуска звука (виж setMuted за реплея).
            if (event.code === 'KeyM' && !event.repeat) {
                this.setMuted(!this.sound.muted());
            }

            // Ръчна трансмисия: W = нагоре, S = надолу (веднъж на натискане —
            // event.repeat спира повтарянето при задържане).
            if (this.manualTransmission && !event.repeat) {
                if (event.code === 'KeyW') {
                    shiftUp(this.drivetrain);
                } else if (event.code === 'KeyS') {
                    shiftDown(this.drivetrain);
                }
            }
        };

        this.onKeyUp = (event) => {
            this.keys.delete(event.code);
        };

        // Alt-Tab по време на завой оставя клавиша „натиснат" завинаги.
        // Звукът също спира: за разлика от visibilitychange, blur хваща и
        // фокус към ДРУГО приложение при все още видим браузър (Windows) —
        // иначе двигателят бучи, докато човекът си гледа пощата.
        this.onBlur = () => {
            this.keys.clear();
            this.touch.throttle = 0;
            this.touch.brake = 0;
            this.touch.steer = 0;
            this.pause();
        };
        this.onFocus = () => {
            if (!document.hidden) {
                this.resume();
            }
        };

        // В скрит таб rAF спира, но Web Audio продължава — двигателят би
        // бучал на замразени обороти до безкрай. Спираме/пускаме със скриването.
        // !replay като в onFocus: ТВ реплеят е без двигател и връщането в таба
        // не бива да пуска замразения дрон върху него.
        this.onVisibility = () => {
            if (document.hidden) {
                this.keys.clear();
                this.pause();
            } else {
                this.resume();
            }
        };

        window.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('keyup', this.onKeyUp);
        window.addEventListener('blur', this.onBlur);
        window.addEventListener('focus', this.onFocus);
        document.addEventListener('visibilitychange', this.onVisibility);
    }

    #unbindEvents() {
        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('keyup', this.onKeyUp);
        window.removeEventListener('blur', this.onBlur);
        window.removeEventListener('focus', this.onFocus);
        document.removeEventListener('visibilitychange', this.onVisibility);
        this.canvas.removeEventListener('webglcontextlost', this.onContextLostEvent);
    }

    #readInput() {
        // Директни проверки, без closure/rest-масиви — извиква се на всеки кадър.
        // При ръчна трансмисия W/S са за смяна на предавка → само стрелките карат.
        const keys = this.keys;
        const ws = !this.manualTransmission;
        const throttle = keys.has('ArrowUp') || (ws && keys.has('KeyW')) ? 1 : 0;
        const brake = keys.has('ArrowDown') || keys.has('Space') || (ws && keys.has('KeyS')) ? 1 : 0;
        const steer =
            (keys.has('ArrowLeft') || keys.has('KeyA') ? -1 : 0) +
            (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0);

        this.input.brake = Math.max(brake, this.touch.brake);
        // Авто-газ: пълна газ, освен когато спираш (спирачката вдига газта). Иначе
        // нормалната газ от клавиатура/тъч.
        this.input.throttle = this.autoThrottle
            ? (this.input.brake > 0 ? 0 : 1)
            : Math.max(throttle, this.touch.throttle);

        // Дясноориентирана three.js сцена + chase камера зад колата → физическото
        // „надясно" (+x) се РЕНДЕРИРА вляво на екрана. Обръщаме тук (клавиатура и
        // тъч наведнъж), за да съвпада натиснатата посока с видяната. Физиката
        // (physics.js) остава недокосната — тя е чиста функция за replay.
        const merged = steer !== 0 ? steer : this.touch.steer;
        this.input.steer = -merged;

        // Аналогов стик + тригери. Модулът пише само при реален вход, така че
        // неутрален включен контролер не изтрива клавиатурата или тъча.
        readGamepad(this.input);
        if (this.manualTransmission) {
            const shift = consumeShift();
            if (shift > 0) {
                shiftUp(this.drivetrain);
            } else if (shift < 0) {
                shiftDown(this.drivetrain);
            }
        } else {
            consumeShift();
        }
    }

    /**
     * Летящата обиколка завърши: духът се обновява при рекорд, кадрите остават
     * за ТВ реплея, а трейсът тръгва към UI-а (и оттам — към сървъра).
     *
     * @param {object} event Събитието от sim.tick
     */
    #onLapFinished(event) {
        this.#notify(this.onLapCompleted, { lapMs: event.lapMs, valid: event.valid, untimed: false });
        // Състезание: няма резултатен екран по средата — race.js вече е
        // въоръжил следващата обиколка в същия тик. Кадрите на ПОСЛЕДНАТА
        // обиколка хранят ТВ реплея на подиума; финалът идва от #finishRace.
        if (this.race) {
            if (event.frames) {
                this.lastLapFrames = event.frames;
            }
            return;
        }

        if (event.frames) {
            this.lastLapFrames = event.frames;

            // Духът е еталонът за СОЛО атака — обиколка, „подпомогната" от
            // удари/драфт в състезание, не бива да го замърсява. Официалният
            // дух е само заместител: ПЪРВАТА ти валидна обиколка го измества,
            // дори да е по-бавна — иначе личният рекорд изобщо не се записва,
            // докато не биеш автопилота.
            if (
                event.valid &&
                this.opponents.length === 0 &&
                (this.ghost === null || this.ghost.official || event.lapTicks < this.ghost.lapTicks)
            ) {
                // Камбанка само за истинско подобрение (не за първата/официалния).
                if (this.ghost !== null && !this.ghost.official && event.lapTicks < this.ghost.lapTicks) {
                    this.sound.recordChime();
                }
                this.#saveGhost(event.frames, event.lapTicks);
            }
        }

        // Дотук стигат само соло обиколки (състезанието излезе по-горе) —
        // затова времето е възпроизводимо и може да върви към класацията.
        this.onFinish({
            lapMs: event.lapMs,
            sectorsMs: event.sectorsMs,
            valid: event.valid,
            // Записът на входа — доказателството на обиколката за сървъра.
            trace: event.trace ? encodeTrace(event.trace) : null,
            simVersion: SIM_VERSION,
        });
    }

    /**
     * Една стъпка на цялото поле през race.js — същата функция, която
     * сървърът преиграва. Тук остава само презентацията: предишните позиции
     * за интерполация и най-силният удар с участие на играча (искри + звук).
     *
     * @returns {object|null} Завършена хронометрирана обиколка на играча
     */
    #stepRaceTick() {
        for (const opp of this.opponents) {
            const os = opp.sim.state;
            opp.prevX = os.x;
            opp.prevZ = os.z;
            opp.prevHeading = os.heading;
        }

        const step = stepRace(this.race, this.input);
        const state = this.sim.state;

        for (const event of this.race.events) {
            this.#radioEvent(event);
        }
        if (step.classified) {
            const classification = this.#raceClassificationView();
            this.#notify(this.onRaceClassification, {
                position: this.race.result.finalPosition,
                classification,
                standings: standingsOf(classification),
            });
        }

        for (const contact of this.race.contacts) {
            if (contact.a !== state && contact.b !== state) {
                continue;
            }
            if (contact.impulse < 1.2) {
                continue;
            }
            if (this.pendingImpact === null || contact.impulse > this.pendingImpact.impulse) {
                this.pendingImpact = contact;
            }
        }

        return step.playerEvent;
    }

    /** Броячът на обиколките на играча: в състезание е този на race.js. */
    #resetPlayerRace() {
        this.playerRace = this.race ? this.race.playerLaps : { laps: 0, lastProgress: this.sim.lastProgress };
        this.outLapReported = false;
        this.radio = createRadioState();
        this.radioVoice.clear();
        this.#resetRaceRivalTiming();
    }

    /** Хронометражът на задочния съперник тръгва от слота на играча. */
    #resetRaceRivalTiming() {
        if (!this.raceRival) {
            return;
        }
        if (!this.race) {
            this.raceRival.timing = null;
            return;
        }
        this.raceRival.timing = {
            laps: 0,
            lastProgress: gridSlot(this.track, this.opponents.length).progress,
            timingPoint: -1,
            passTicks: new Float64Array(this.race.timingPoints).fill(-1),
            finished: false,
        };
        this.ghostDriver?.reset();
    }

    /**
     * Радар за кола отстрани: колко близо е най-близката кола отляво и отдясно
     * на ЕКРАНА (0..1). Страничната ос на физиката (cos h, −sin h) се рендерира
     * наляво — виж бележката при vLateral в physics.js.
     *
     * @returns {{left: number, right: number}}
     */
    #radar() {
        const state = this.sim.state;
        const sin = Math.sin(state.heading);
        const cos = Math.cos(state.heading);
        let left = 0;
        let right = 0;

        for (const opp of this.opponents) {
            if (opp.sim.recovering) {
                continue;
            }
            const dx = opp.sim.state.x - state.x;
            const dz = opp.sim.state.z - state.z;
            const along = dx * sin + dz * cos;
            const lateral = dx * cos - dz * sin;
            const side = Math.abs(lateral);
            if (Math.abs(along) > RADAR_ALONG || side > RADAR_LATERAL || side < 0.6) {
                continue;
            }
            const closeness = Math.min(1, (RADAR_LATERAL - side) / 3) * Math.min(1, (RADAR_ALONG - Math.abs(along)) / 2);
            if (lateral > 0) {
                left = Math.max(left, closeness);
            } else {
                right = Math.max(right, closeness);
            }
        }

        return { left, right };
    }

    /**
     * Радиото: кратко съобщение + глас (или сигнал, ако гласът е изключен
     * или клиповете не са генерирани). Наказанията минават винаги,
     * останалото — най-много едно на RADIO_GAP_TICKS.
     *
     * @param {string} text Текстът на екрана (с точните секунди)
     * @param {'info'|'good'|'bad'} tone
     * @param {boolean} [priority]
     * @param {string[]} [voice] Клиповете от radioPhrases.json, по ред
     */
    #say(text, tone, priority = false, voice = []) {
        const clock = this.race?.clock ?? 0;
        if (!priority && clock - this.radio.lastSaid < RADIO_GAP_TICKS) {
            return;
        }
        this.radio.lastSaid = clock;
        this.radio.sequence++;
        if (this.radioVoiceEnabled && voice.length > 0 && this.radioVoice.available()) {
            this.radioVoice.say(voice, priority);
        } else {
            this.sound.beep(tone === 'bad' ? 560 : 1320, 0.05);
        }
        this.#notify(this.onRaceMessage, { id: this.radio.sequence, text, tone });
    }

    /** Събития от race.js (наказания, грешки, режим за изпреварване) → радио. */
    #radioEvent(event) {
        const race = this.race;
        const me = race.playerLaps;
        const name = (entry) => BOT_NAMES[entry.opponentIndex % BOT_NAMES.length];
        const clip = (entry, phrase) => `bot-${entry.opponentIndex % BOT_NAMES.length}-${phrase}`;

        if (event.type === 'penalty' && event.entry === me) {
            const contact = event.reason === 'contact';
            this.#say(
                contact ? 'Наказание +5 s — удар отзад' : 'Наказание +5 s — излизане от пистата',
                'bad',
                true,
                [contact ? 'penalty-contact' : 'penalty-track']
            );
        } else if (event.type === 'penalty' && event.reason === 'contact' && event.victim === me) {
            this.#say(`${name(event.entry)} получи +5 s за удара в теб`, 'good', true, [clip(event.entry, 'penalty')]);
        } else if (event.type === 'mistake' && race.result === null) {
            let along = event.entry.sim.lastProgress - me.lastProgress;
            if (along < -0.5) along += 1;
            if (along > 0.5) along -= 1;
            if (Math.abs(along * this.track.length) <= RADIO_MISTAKE_RANGE) {
                this.#say(
                    event.big ? `${name(event.entry)} излезе от пистата!` : `${name(event.entry)} изпусна спирането`,
                    'info',
                    false,
                    [clip(event.entry, event.big ? 'off' : 'mistake')]
                );
            }
        } else if (event.type === 'overtake' && event.entry === me) {
            this.#say('Режим за изпреварване: +0.5 MJ', 'good', false, ['overtake']);
        }
    }

    /**
     * Радио от състоянието на полето (30 Hz): смяна на позиция, атака отзад,
     * последна обиколка, разлика до задочния съперник на линията.
     */
    #radioTelemetry(rows, position) {
        const race = this.race;
        const radio = this.radio;
        const me = race.playerLaps;
        if (race.result !== null || race.clock < RADIO_POSITION_SETTLE_TICKS * 5) {
            radio.position = position;
            return;
        }

        const field = rows.filter((row) => !row.isRival);
        const mine = field.findIndex((row) => row.isPlayer);

        if (radio.position === null) {
            radio.position = position;
        } else if (position !== radio.position) {
            if (radio.pendingPosition !== position) {
                radio.pendingPosition = position;
                radio.pendingSince = race.clock;
            } else if (race.clock - radio.pendingSince >= RADIO_POSITION_SETTLE_TICKS) {
                const gained = position < radio.position;
                const other = field[gained ? mine + 1 : mine - 1];
                if (other?.name) {
                    const bot = other.entry.opponentIndex % BOT_NAMES.length;
                    this.#say(
                        gained ? `П${position}! Изпревари ${other.name}` : `${other.name} те изпревари — П${position}`,
                        gained ? 'good' : 'bad',
                        false,
                        gained
                            ? [`bot-${bot}-passed`, `gained-p${position}`]
                            : [`bot-${bot}-passes`, `lost-p${position}`]
                    );
                }
                radio.position = position;
                radio.pendingPosition = null;
            }
        } else {
            radio.pendingPosition = null;
        }

        if (!radio.lastLapSaid && me.laps === RACE_TOTAL_LAPS) {
            radio.lastLapSaid = true;
            this.#say('Последна обиколка!', 'info', true, ['last-lap']);
        }

        const behind = field[mine + 1];
        if (behind && behind.name) {
            const gap = raceGap(race, behind.entry, me);
            const seconds = gap.ticks === null ? null : gap.ticks * FIXED_DT;
            const lastWarned = radio.attackSaid.get(behind.name) ?? -Infinity;
            if (seconds !== null && seconds <= RADIO_ATTACK_GAP && race.clock - lastWarned >= RADIO_ATTACK_COOLDOWN_TICKS) {
                radio.attackSaid.set(behind.name, race.clock);
                this.#say(`${behind.name} е на ${seconds.toFixed(1)} s зад теб`, 'info', false, [
                    `bot-${behind.entry.opponentIndex % BOT_NAMES.length}-attack`,
                ]);
            }
        }

        const rival = this.raceRival?.timing;
        if (rival && me.laps >= 2 && me.laps !== radio.rivalLapSaid && me.laps <= RACE_TOTAL_LAPS) {
            radio.rivalLapSaid = me.laps;
            const rivalAhead = rival.laps + rival.lastProgress > me.laps + me.lastProgress;
            const gap = rivalAhead ? raceGap(race, me, rival) : raceGap(race, rival, me);
            if (gap.ticks !== null) {
                const seconds = (gap.ticks * FIXED_DT).toFixed(1);
                this.#say(
                    rivalAhead ? `Спрямо ${this.raceRival.name}: +${seconds} s` : `Спрямо ${this.raceRival.name}: −${seconds} s`,
                    rivalAhead ? 'bad' : 'good',
                    false,
                    [rivalAhead ? 'rival-ahead' : 'rival-behind']
                );
            }
        }
    }

    /**
     * Класирането за подиума (временно при флага, окончателно след полето).
     *
     * @returns {Array<object>}
     */
    #raceClassificationView() {
        const rows = classifyRace(this.race);
        const winner = rows[0];

        return rows.map((row, i) => ({
            position: i + 1,
            name: row.opponentIndex === null ? null : BOT_NAMES[row.opponentIndex % BOT_NAMES.length],
            isPlayer: row.opponentIndex === null,
            finished: row.finished,
            totalMs: row.totalMs,
            gapMs: i > 0 && row.finished && winner.finished ? row.totalMs - winner.totalMs : null,
            lapsDown: row.lapsDown,
            penalties: row.penalties,
            bestLapMs: row.bestLapMs,
            fastestLap: row.fastestLap,
        }));
    }

    #frame = (now) => {
        if (!this.running) {
            return;
        }

        this.rafId = requestAnimationFrame(this.#frame);

        // Граница за изключения: rAF е презареден по-горе, така че без нея
        // гръмнал кадър се повтаря вечно (виж #frameFailed / #fail).
        try {
            this.#step(now);
            this.frameErrors = 0;
        } catch (error) {
            this.#frameFailed(error);
        }
    };

    /**
     * Един жив кадър: вход → фиксирани стъпки на симулацията → риг/камера/
     * ефекти → рендер → телеметрия към HUD-а (30 Hz).
     *
     * @param {number} now performance.now() от rAF
     */
    #step(now) {
        const rawDt = (now - this.lastFrame) / 1000;
        const dt = Math.min(rawDt, MAX_FRAME_TIME);
        this.lastFrame = now;

        // Динамична резолюция: реалният кадър (преди клампата) управлява
        // мащаба — хваща и слаби устройства, и thermal throttling.
        this.#governResolution(rawDt);

        // ── ТВ реплей: симулацията е замразена, кадрите се превъртат ────────
        if (this.replay) {
            this.#replayFrame(dt);
            return;
        }

        // ── Стартова процедура: решетката чака светлините да угаснат ───────
        if (this.launch) {
            this.#launchFrame(dt);
            return;
        }

        this.#readInput();

        this.accumulator += dt;

        const sim = this.sim;
        const state = sim.state;

        // Снапшот ПРЕДИ стъпките от този кадър. Ако не се завърти стъпка (висок
        // FPS), prev == state и рендерът стои неподвижен — без трептене.
        let prevX = state.x;
        let prevZ = state.z;
        let prevHeading = state.heading;

        // За бойната обиколка на състезанието (виж под цикъла).
        const lapsBefore = this.playerRace.laps;
        let timedLapFinished = false;

        while (this.accumulator >= FIXED_DT) {
            prevX = state.x;
            prevZ = state.z;
            prevHeading = state.heading;

            const phaseBefore = sim.phase;
            const event = this.race ? this.#stepRaceTick() : sim.tick(this.input);
            if (phaseBefore !== 'flying' && sim.phase === 'flying') {
                this.lapAnalysis.reset();
            }
            if (phaseBefore === 'flying' || sim.phase === 'flying') {
                this.lapAnalysis.record(sim.lastProgress, state, this.input);
            }
            if (event?.type === 'finished') {
                timedLapFinished = true;
                const reference = this.rivalGhost ?? this.ghost;
                this.lastLapAnalysis = this.lapAnalysis.finish(reference?.frames ?? null);
                this.#onLapFinished(event);
            }

            this.accumulator -= FIXED_DT;
        }

        // Изминат път за позицията П1..Пn — в състезание race.js го брои на
        // всеки тик; соло праговете хващат пресичане и телепорт назад.
        if (!this.race) {
            trackWrap(this.playerRace, sim.lastProgress);
        }

        // Първата обиколка на състезанието е бойна (симът я не хронометрира —
        // виж gridRace), но за играча тя е обиколка 1/3 и телеметрията я
        // брои като завършена без време. Пресичане №1 е потеглянето от
        // решетката, №2 е краят ѝ. Флагът пази срещу повторно броене при
        // връщане назад през линията; ако симът все пак е хронометрирал
        // тази обиколка (recovery преди линията), тя вече мина през
        // #onLapFinished и не се брои втори път.
        if (
            this.race &&
            !this.outLapReported &&
            lapsBefore === 1 &&
            this.playerRace.laps === 2
        ) {
            this.outLapReported = true;
            if (!timedLapFinished) {
                this.#notify(this.onLapCompleted, { lapMs: null, valid: true, untimed: true });
            }
        }

        // Карираният флаг падна в някой тик от този кадър (race.js).
        if (this.race?.result && !this.raceResult) {
            this.#finishRace();
        }

        // След телепорт (връщане на пистата) не интерполираме от старото място —
        // иначе колата „прелита" през картата за един кадър. Камерата се залепя
        // наново, шейкът от старото място се нулира.
        if (sim.snapRender) {
            prevX = state.x;
            prevZ = state.z;
            prevHeading = state.heading;
            sim.snapRender = false;
            this.ghostDriver.reset();
            this.#placeCameraBehindCar();
        }

        // Интерполация между последните две стъпки. Физиката тиктака на 120 Hz,
        // но кадрите идват на променлива честота — без това колата и камерата
        // подскачат/дърпат, особено щом FPS-ът се разклати. alpha е остатъкът от
        // акумулатора: 0 = точно на стъпка, →1 = почти на следващата.
        let dHeading = state.heading - prevHeading;
        // Пази срещу евентуален wrap на heading в [-π, π].
        if (dHeading > Math.PI) dHeading -= 2 * Math.PI;
        else if (dHeading < -Math.PI) dHeading += 2 * Math.PI;

        // Преизползван обект вместо spread на всеки кадър — нула алокации.
        const alpha = this.accumulator / FIXED_DT;
        const render = this._render;
        Object.assign(render, state);
        render.x = prevX + (state.x - prevX) * alpha;
        render.z = prevZ + (state.z - prevZ) * alpha;
        render.heading = prevHeading + dHeading * alpha;

        const dyn = this._carDyn;
        dyn.gLong = state.out?.ax ?? this.gLong;
        dyn.gLat = state.out?.ay ?? state.yawRate * state.vForward;
        dyn.brake = state.brakePedal ?? this.input.brake;
        dyn.throttle = state.throttlePedal ?? this.input.throttle;
        dyn.lockF = state.out?.lockF ?? 0;
        dyn.lockR = state.out?.lockR ?? 0;
        dyn.spin = state.out?.spin ?? 0;
        dyn.kerbSide = state.out?.kerbSide ?? (sim.onKerb ? 1 : 0);
        dyn.rumble = this.chaseCamera.rumble;
        updateCarRig(this.carRig, render, sim.surface, dt, dyn);

        // Камерата следва вектора на движение, апекса и релефа; сама добавя
        // G-наклон, кербов heave, ударен kick и FOV по скоростта.
        this.effectTime += dt;
        this.chaseCamera.update(dt, render, sim, state.out);
        this.gLong = this.chaseCamera.gLong;
        this.gLat = this.chaseCamera.gLat;
        dyn.rumble = this.chaseCamera.rumble;

        // Духът: полупрозрачният съперник повтаря рекордната обиколка, тик
        // по тик срещу твоя хронометър — вижда се само на летящата обиколка.
        this.#updateGhost(dt);

        // Съперниците: интерполация като при играча.
        this.#updateOpponents(alpha, dt);

        // Един и същ набор tyre сигнали храни осветения дим/прах/искри и
        // четирите независими следи от гумите.
        this.playerEmitter.emit(dt, render, sim.surface, sim, this.input, state.out);
        this.playerSkidWriter.write(dt, render, sim.surface, sim, this.input, state.out);
        this.particles.update(dt, this.camera);
        this.skidMarks.update(dt, this.camera);

        const wallHit = state.out?.wallHit ?? null;
        if (wallHit && wallHit.tick !== this.lastWallHitTick) {
            this.lastWallHitTick = wallHit.tick;
            const strength = clamp01(wallHit.impulse / 10);
            this.particles.impactSparks(
                render.x,
                sim.surface.height + 0.3,
                render.z,
                wallHit.nx,
                wallHit.nz,
                strength
            );
            this.sound.impact(strength);
            this.chaseCamera.kick(strength, wallHit.nx, wallHit.nz);
            hapticPulse('impact', strength);
            navigator.vibrate?.(Math.round(20 + strength * 45));
        }

        const locking = (state.out?.lockF ?? 0) > 0.3 || (state.out?.lockR ?? 0) > 0.3;
        if (locking && !this.wasLocking) {
            hapticPulse('lock', Math.max(state.out?.lockF ?? 0, state.out?.lockR ?? 0));
        }
        this.wasLocking = locking;

        // Удар от този кадър: искри + звук + вибрация (Android).
        if (this.pendingImpact !== null) {
            const impact = this.pendingImpact;
            this.pendingImpact = null;
            const strength = Math.min(1, impact.impulse / 6);
            this.particles.burst(impact.x, sim.surface.height + 0.4, impact.z, strength);
            this.sound.impact(strength);
            navigator.vibrate?.(30);
            hapticPulse('impact', strength);
            this.chaseCamera.kickFrom(strength, impact.x, impact.z);
        }

        // Кратък тактилен тик при качване на керб (Android; iOS няма API).
        if (sim.onKerb && !this.wasOnKerb) {
            navigator.vibrate?.(8);
            hapticPulse('kerb');
        }
        this.wasOnKerb = sim.onKerb;

        // Маршалът вее карирания флаг само на летящата (финалната) обиколка.
        if (this.marshalFlag) {
            if (sim.phase === 'flying') {
                this.flagWave += dt * FLAG_WAVE_SPEED;
                this.marshalFlag.rotation.z = Math.sin(this.flagWave) * FLAG_WAVE_AMP;
            } else if (this.marshalFlag.rotation.z !== 0) {
                this.marshalFlag.rotation.z = 0; // в покой прътът е изправен
            }
        }

        // Декор анимации (виенското колело на Сузука се върти бавно).
        for (const animate of this.decorAnimations) {
            animate(dt);
        }

        // Жълт флаг: най-близкият маршалски пост вее, докато тече връщането.
        if (sim.recovering) {
            if (!this.activeYellowPost && this.marshalPosts.length > 0) {
                const target = sim.safeState.index;
                const count = this.track.count;
                let best = null;
                let bestDistance = Infinity;
                for (const post of this.marshalPosts) {
                    const forward = (((post.index - target) % count) + count) % count;
                    const distance = Math.min(forward, count - forward);
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        best = post;
                    }
                }
                this.activeYellowPost = best;
            }
            if (this.activeYellowPost) {
                this.activeYellowPost.pivot.rotation.z = 0.15 + Math.sin(this.effectTime * 7) * 0.45;
            }
        } else if (this.activeYellowPost) {
            this.activeYellowPost.pivot.rotation.z = 1.25; // прибран
            this.activeYellowPost = null;
        }

        // Петте светлини на гантрито: в соло — червени през загряващата,
        // гаснат на летящата. В състезание ги командва #launchFrame, а след
        // потеглянето стоят угаснали („lights out and away we go").
        if (this.startLights) {
            const target = sim.phase === 'formation' && this.opponents.length === 0 ? 3.2 : 0;
            for (const material of this.startLights) {
                if (material.emissiveIntensity !== target) {
                    material.emissiveIntensity = target;
                }
            }
        }

        // Трансмисия (обороти/предавка за HUD) — гладко, всеки кадър.
        updateDrivetrain(this.drivetrain, state.vForward, this.input.throttle, dt);

        // Смяната на предавка: звуковият „крак"/blip + пламък от ауспуха.
        if (this.drivetrain.shifted !== 0 && Math.abs(state.vForward) > 2) {
            this.sound.shift(this.drivetrain.shifted > 0 ? 1 : -1);
        }

        const pedalThrottle = state.throttlePedal ?? this.input.throttle;
        if (
            this.prevThrottleForOverrun > 0.8 &&
            pedalThrottle < 0.1 &&
            this.drivetrain.visualRpm > SHIFT_RPM * 0.77
        ) {
            this.carEffects?.pops(this.sound.overrun(this.drivetrain.visualRpm / SHIFT_RPM));
        }
        this.prevThrottleForOverrun = pedalThrottle;

        // Спирачно греене, contact blob, clearcoat dirt и синхронизиран
        // ауспух върху реалния GLB/процедурния резерв.
        this.carEffects?.update(dt, render, this.input, this.drivetrain, sim, {
            cameraMode: this.cameraMode,
        });

        // Звукът следва реалните обороти + повърхността под колата.
        // Тълпата се чува при трибуните на старт-финала; тунелът (Монако)
        // включва риверба.
        const progressMeters = sim.lastProgress * this.track.length;
        const startDistance = Math.min(progressMeters, this.track.length - progressMeters);
        const tunnel = this.circuit.tunnel;

        const soundExtras = this._soundExtras;
        soundExtras.kerb = sim.onKerb;
        soundExtras.gravel = sim.offSurface === 'gravel';
        soundExtras.speed = Math.abs(state.vForward);
        soundExtras.slip = state.slip;
        soundExtras.brake = this.input.brake;
        soundExtras.cameraMode = this.cameraMode;
        soundExtras.limiter = this.drivetrain.limiter;
        soundExtras.spin = state.out?.spin ?? 0;
        soundExtras.wet = this.weather === 'wet';
        soundExtras.wallHit = state.out?.wallHit ?? null;
        soundExtras.crowd = this.circuit.startGrandstands ? Math.max(0, 1 - startDistance / 220) : 0;
        soundExtras.tunnel = tunnel !== undefined && progressMeters >= tunnel.from && progressMeters <= tunnel.to;
        this.sound.update(this.drivetrain.visualRpm, state.throttlePedal ?? this.input.throttle, soundExtras);
        this.#updateRivalSound(render);

        this.trackGroup.userData.update?.(dt, this.camera, this.effectTime);
        this.atmosphere?.update(dt, this.camera.position, soundExtras.tunnel);
        this.surfaceController?.update(dt, this.camera, this.sunDir);
        this.nightLights?.update(dt, render, this.camera, sim.trackIndexHint);

        this.#followSun(render.x, sim.surface.height, render.z);
        this.cascadedShadows?.update(this.carRig.root.position);
        this.#updatePostFx(
            dt,
            clamp01(Math.abs(state.vForward) / CAR.maxSpeed),
            this.cameraMode === 'onboard' ? this.lookTarget : this.carRig.root.position
        );

        this.#render();

        // HUD телеметрия — не по-често от 30 Hz (виж TELEMETRY_INTERVAL): Vue
        // реактивността на всеки кадър е излишен diff/patch + GC натиск, а
        // рендерът вече е нарисуван. Таймерът остава гладък.
        this.telemetryAccum += dt;
        if (this.telemetryAccum < TELEMETRY_INTERVAL) {
            return;
        }
        this.telemetryAccum = 0;

        // Позиция в „състезанието": по МЯСТО на пистата (обиколки + прогрес).
        // Гридът стартира пред теб → тръгваш последен и гониш; изпревариш ли
        // кола физически, позицията пада веднага.
        let position = 1;
        let tower = null;
        let radar = null;
        let overtake = null;
        if (this.race) {
            const race = this.race;
            const rows = race.entries.map((entry) => ({
                entry,
                name: entry.opponentIndex === null ? null : BOT_NAMES[entry.opponentIndex % BOT_NAMES.length],
                isPlayer: entry.opponentIndex === null,
                isRival: false,
                covered: entry.laps + entry.lastProgress,
            }));
            const rivalTiming = this.raceRival?.timing;
            if (rivalTiming) {
                rows.push({
                    entry: rivalTiming,
                    name: this.raceRival.name,
                    isPlayer: false,
                    isRival: true,
                    covered: rivalTiming.laps + rivalTiming.lastProgress,
                });
            }
            rows.sort((a, b) => b.covered - a.covered);

            // Задочният съперник е в кулата, но не и в позицията — не е на пистата.
            position = rows.filter((row) => !row.isRival).findIndex((row) => row.isPlayer) + 1;

            // Кулата: интервал до колата ОТПРЕД, в секунди (точките на race.js).
            tower = rows.map((row, idx) => {
                const gap = idx === 0 ? { ticks: 0, lapped: 0 } : raceGap(race, row.entry, rows[idx - 1].entry);

                return {
                    name: row.name,
                    isPlayer: row.isPlayer,
                    isRival: row.isRival,
                    gapS: gap.ticks === null ? null : Math.round(gap.ticks * FIXED_DT * 10) / 10,
                    lapped: gap.lapped,
                };
            });

            radar = this.#radar();
            const charge = overtakeCharge(race.playerLaps);
            overtake = charge > 0 || race.playerLaps.overtakeActive ? { charge, active: race.playerLaps.overtakeActive } : null;
            this.#radioTelemetry(rows, position);
        }

        // Живата делта срещу духа (соло/дуел) — зелено/червено в HUD-а.
        const ghostDelta = this.#ghostDelta();

        // Мини-картата: нормализирани точки на колите (30 Hz е достатъчно).
        const mapDots = [{ ...this.minimap.project(state.x, state.z), t: 0 }];
        for (const opp of this.opponents) {
            mapDots.push({ ...this.minimap.project(opp.sim.state.x, opp.sim.state.z), t: 1 });
        }
        if (this.ghostRig.root.visible) {
            const g = this.ghostRig.root.position;
            // Типът оцветява точката като 3D духа: официален златист (2),
            // личен син (3), дуелен фуксия (4) — виж DOT_COLORS в Index.vue.
            const t = this.rivalGhost || (this.race && this.raceRival) ? 4 : this.ghost?.official ? 2 : 3;
            mapDots.push({ ...this.minimap.project(g.x, g.z), t });
        }

        this.onTelemetry({
            speed: Math.round(speedKmh(state)),
            speedRatio: this.chaseCamera.speedRatio,
            rpm: Math.round(this.drivetrain.visualRpm),
            gear: this.drivetrain.gear,
            pedals: {
                throttle: state.throttlePedal ?? this.input.throttle,
                brake: state.brakePedal ?? this.input.brake,
            },
            throttle: state.throttlePedal ?? this.input.throttle,
            brake: state.brakePedal ?? this.input.brake,
            slip: state.slip,
            ax: state.out?.ax ?? this.chaseCamera.gLong,
            ay: state.out?.ay ?? this.chaseCamera.gLat,
            gEff: Math.max(9.81, (CAR.baseGrip + CAR.downforceCoef * state.vForward * state.vForward) * (state.out?.loadFactor ?? 1)),
            lockF: state.out?.lockF ?? 0,
            lockR: state.out?.lockR ?? 0,
            satF: state.out?.rhoF ?? 0,
            satR: state.out?.rhoR ?? 0,
            gamepadConnected: gamepadConnected(),
            position,
            fieldSize: this.opponents.length + 1,
            raceLap: this.playerRace.laps,
            raceTotalLaps: this.race ? RACE_TOTAL_LAPS : 0,
            // Излизания дотук в състезанието — всяко е +RACE_PENALTY_MS.
            racePenalties: this.race ? racePenalties(this.race) : 0,
            // Слипстрийм зад кола отпред, 0..1 (race.js).
            draft: this.race ? this.race.playerDraft : 0,
            // Режим за изпреварване на играча: остатък 0..1 и пуска ли се сега.
            overtake,
            // Кола отстрани: 0..1 отляво/отдясно на екрана.
            radar,
            tower,
            ghostDelta,
            delta: ghostDelta,
            mapDots,
            lapTime: sim.phase === 'flying' ? sim.lapTicks * FIXED_DT : null,
            lastLap: sim.lastLapTicks === null ? null : sim.lastLapTicks * FIXED_DT,
            bestLap: sim.bestLapTicks === null ? null : sim.bestLapTicks * FIXED_DT,
            sector: sim.currentSector + 1,
            sectors: sim.lastSectors.map((t) => (t === null ? null : t * FIXED_DT)),
            lapValid: sim.lapValid,
            trackProgress: sim.lastProgress,
            started: sim.phase === 'flying',
            phase: sim.phase,
            recovering: sim.recovering,
            recoverCount: sim.recovering ? Math.ceil(sim.recoverTicks / 120) : 0,
            gated: sim.phase === 'flying' && sim.timerGated,
            warnings: sim.warnings,
            maxWarnings: MAX_WARNINGS,
            // За бързите настройки на HUD-а: коя камера е активна (и C я сменя)
            // и докъде е слязъл governor-ът (индикатор за качество).
            cameraMode: this.cameraMode,
            renderScale: this.renderScale,
            frameMs: Math.round(this.frameAvgMs * 10) / 10,
            qualityTier: this.lowPower
                ? 'low-power'
                : this.quality.adaptive === true
                    ? ['auto-full', 'auto-balanced', 'auto-safe'][this.autoQualityStage]
                    : 'manual',
        });
    }

    /**
     * Сенчестата кутия следва колата: посоката на слънцето е фиксирана, движи
     * се само центърът, за да е острата сянка около играча. Центърът се
     * закръгля до texel в базиса на светлината (_sunBasis) — иначе всяко
     * субпикселно преместване преизчислява ръбовете и сянката трепти/пълзи,
     * най-зле на 512 карта. Реплеят и живият кадър минават оттук.
     *
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    #followSun(x, y, z) {
        const c = this._sunCenter.set(x, y, z).applyMatrix4(this._sunBasisInverse);
        const t = this.shadowTexel;
        c.x = Math.round(c.x / t) * t;
        c.y = Math.round(c.y / t) * t;
        c.applyMatrix4(this._sunBasis);
        this.sun.target.position.copy(c);
        this.sun.position.set(
            c.x + this.sunDir.x * SUN_DISTANCE,
            c.y + this.sunDir.y * SUN_DISTANCE,
            c.z + this.sunDir.z * SUN_DISTANCE
        );
    }

    /**
     * Per-frame uniform-ите на грейда (postfx.js): скоростното размазване —
     * плавно по smootherstep на скоростта, в бордовата камера 70% (там
     * движението се чете и без него), нула при изключен motionBlur; центърът
     * му — колата на екрана (в бордовата: точката на погледа); времето и
     * кадърът за шума/дитъра. Реплеят/решетката подават скорост 0: камерата
     * там е статична и радиално размазване няма смисъл.
     *
     * @param {number} dt
     * @param {number} speedRatio 0..1
     * @param {THREE.Vector3|null} focus Световна точка, която остава остра
     */
    #updatePostFx(dt, speedRatio, focus) {
        const pass = this.gradePass;
        if (!pass) {
            return;
        }
        const u = pass.uniforms;
        // 1000·1.6 (скоростта на heat-haze шума) е цяло число → увиването е
        // безшевно за RepeatWrapping; целочисленият хеш на дитъра не зависи от uTime.
        u.uTime.value = (u.uTime.value + dt) % 1000;
        u.uFrame.value = (u.uFrame.value + 1) % 4096;

        const blur = this.quality.motionBlur && speedRatio > 0
            ? THREE.MathUtils.smootherstep(speedRatio, 0, 1) * (this.cameraMode === 'onboard' ? 0.7 : 1)
            : 0;
        u.uSpeed.value = blur;
        if (blur === 0 || !focus) {
            return;
        }

        // Проекция на фокуса през ТЕКУЩАТА камера (матрицата ѝ е от миналия
        // рендер, а #updateCamera току-що я премести).
        this.camera.updateMatrixWorld();
        const p = this._screenPoint.copy(focus).project(this.camera);
        if (Math.abs(p.z) <= 1) {
            u.uCenter.value.set(clamp((p.x + 1) * 0.5, -0.5, 1.5), clamp((p.y + 1) * 0.5, -0.5, 1.5));
        }
    }

    /**
     * Карираният флаг: класирането се снима в момента на финала на играча
     * (по място на пистата — изпреварилите ботове са легитимно напред).
     * Резултатът и записът идват от race.js — същото, което сървърът преиграва.
     */
    #finishRace() {
        const result = this.race.result;
        const classification = this.#raceClassificationView();
        const rival = this.raceRival;

        this.raceResult = {
            // Временна позиция: ботовете зад теб още финишират (виж
            // onRaceClassification за окончателната).
            position: result.position,
            final: false,
            standings: standingsOf(classification),
            classification,
            rival: rival ? { name: rival.name, totalMs: rival.totalMs, deltaMs: result.totalMs - rival.totalMs } : null,
            raceMs: result.raceMs,
            penalties: result.penalties,
            trackLimits: result.trackLimits,
            contactFaults: result.contactFaults,
            penaltyMs: result.penalties * RACE_PENALTY_MS,
            totalMs: result.totalMs,
            // Записът на входа за класацията „Състезание" (null при преливане).
            trace: encodeRaceTrace(this.race),
            simVersion: SIM_VERSION,
            raceVersion: RACE_VERSION,
        };
        this.sound.fanfare(this.raceResult.position);
        this.onRaceFinish(this.raceResult);
    }

    /**
     * Живата делта срещу духа: времето, на което духът е бил на ТОВА място,
     * срещу текущия хронометър. Търсенето в кадрите е локално около указател.
     *
     * @returns {number|null} Секунди (+ = изоставаш), null когато няма дуел
     */
    #ghostDelta() {
        const ghost = this.rivalGhost ?? this.ghost;
        const sim = this.sim;

        if (
            !ghost?.frames ||
            sim.phase !== 'flying' ||
            sim.timerGated ||
            this.opponents.length > 0
        ) {
            return null;
        }

        const frames = ghost.frames;
        const count = Math.floor(frames.length / 3);
        if (count < 2) {
            return null;
        }

        // Нова обиколка → указателят се връща на старта.
        if (sim.lapTicks < 10) {
            this.ghostDeltaHint = 0;
        }

        const x = sim.state.x;
        const z = sim.state.z;
        let best = this.ghostDeltaHint;
        let bestD = Infinity;
        const window = 150;

        // Кадрите са ЕДНА обиколка, не цикъл — клампваме търсенето вместо
        // модулно увиване: на линията увиването залепва за отсрещния край и
        // делтата проблясва ±цяла обиколка за един телеметричен кадър.
        const from = Math.max(0, this.ghostDeltaHint - 20);
        const to = Math.min(count - 1, this.ghostDeltaHint + window);
        for (let k = from; k <= to; k++) {
            const dx = x - frames[k * 3];
            const dz = z - frames[k * 3 + 1];
            const d = dx * dx + dz * dz;
            if (d < bestD) {
                bestD = d;
                best = k;
            }
        }

        this.ghostDeltaHint = best;

        // Далеч от линията на духа (излизане/recovery) — делтата лъже.
        if (bestD > 35 * 35) {
            return null;
        }

        // Същият -1 кадър като #updateGhost: frames[k] е състоянието СЛЕД
        // тик (k+1)·FRAME_EVERY — без корекцията делтата постоянно надписва
        // ~17 ms изоставане и спори с рендерирания дух.
        return (sim.lapTicks - (best + 1) * FRAME_EVERY) * FIXED_DT;
    }

    /** Маха съперниците от сцената и освобождава ресурсите им. */
    #clearOpponents() {
        for (const opp of this.opponents) {
            this.scene.remove(opp.rig.root);
            opp.effects?.dispose();
            if (opp.emitter) {
                this.particles.removeEmitter(opp.emitter);
            }
            if (opp.skidWriter) {
                this.skidMarks.removeWriter(opp.skidWriter);
            }
            opp.rig.dispose?.();
        }
        this.opponents = [];
        this.race = null;
        this.cascadedShadows?.refreshMaterials();
    }

    /**
     * Ботовете вече стоят на решетката (gridRace в race.js) — тук само
     * риговете и интерполацията се залепват за слотовете им.
     */
    #gridOpponents() {
        for (const opp of this.opponents) {
            const s = opp.sim.state;
            opp.prevX = s.x;
            opp.prevZ = s.z;
            opp.prevHeading = s.heading;

            opp.rig.root.visible = true;
            updateCarRig(opp.rig, s, opp.sim.surface, 1);
        }
    }

    /**
     * Играчът вече е на последния ред на решетката (gridRace в race.js) —
     * тук се залепват ригът и камерата за слота.
     */
    #gridPlayer() {
        if (!this.race) {
            return;
        }

        const sim = this.sim;
        const s = sim.state;
        // Ригът се синхронизира веднага (както при ботовете): по време на
        // стартовата процедура сим стъпки няма, а камерата вече гледа слота —
        // иначе болидът стои на старт-финала, извън кадър, докато светят светлините.
        updateCarRig(this.carRig, s, sim.surface, 1);
        this.lookTarget = null;
        this.#placeCameraBehindCar();
    }

    /** Въоръжава стартовата процедура (само в състезание). */
    #armLaunch() {
        this.launch =
            this.opponents.length > 0
                ? { elapsed: 0, hold: 0.6 + Math.random() * 0.9, prevLit: 0 }
                : null;
        this.onLaunch(this.launch ? 0 : null);
    }

    /**
     * Кадър от стартовата процедура: света е замръзнал, петте светлини се
     * палят една по една, произволна пауза — и гаснат: старт. Двигателят
     * реве все по-високо с всяка светлина.
     *
     * @param {number} dt
     */
    #launchFrame(dt) {
        const launch = this.launch;
        launch.elapsed += dt;

        const lit = Math.min(5, Math.floor(launch.elapsed / LAUNCH_LIGHT_INTERVAL) + 1);
        const outAt = 4 * LAUNCH_LIGHT_INTERVAL + launch.hold;

        // Бийп на всяка нова светлина; по-висок и дълъг при гасенето.
        if (lit !== launch.prevLit) {
            launch.prevLit = lit;
            this.sound.beep(600 + lit * 40);
        }

        if (launch.elapsed >= outAt) {
            // Гаснат — и потегляме.
            if (this.startLights) {
                for (const material of this.startLights) {
                    material.emissiveIntensity = 0;
                }
            }
            this.sound.beep(980, 0.28);
            navigator.vibrate?.(40);
            hapticPulse('launch');
            this.launch = null;
            this.accumulator = 0;
            this.onLaunch(null);
            return;
        }

        if (this.startLights) {
            for (let i = 0; i < this.startLights.length; i++) {
                const target = i < lit ? 3.2 : 0;
                if (this.startLights[i].emissiveIntensity !== target) {
                    this.startLights[i].emissiveIntensity = target;
                }
            }
        }

        // Решетката по правилата от 2026 г.: без MGU-H турбото се завърта само
        // с газове, затова пилотите държат високи, неспокойни обороти през
        // цялата процедура. Козметично — светлините не пипат симулацията.
        const wave = 0.6 * Math.sin(launch.elapsed * 5.3) + 0.4 * Math.sin(launch.elapsed * 1.9 + 1);
        this.sound.update(8800 + lit * 350 + wave * 1100, 0.55 + 0.1 * wave, LAUNCH_SOUND_EXTRAS);

        for (const animate of this.decorAnimations) {
            animate(dt);
        }

        this.effectTime += dt;
        this.trackGroup.userData.update?.(dt, this.camera, this.effectTime);
        this.atmosphere?.update(dt, this.camera.position, false);
        this.surfaceController?.update(dt, this.camera, this.sunDir);
        this.nightLights?.update(dt, this.sim.state, this.camera, this.sim.trackIndexHint);
        this.#followSun(this.sim.state.x, this.sim.surface.height, this.sim.state.z);
        this.cascadedShadows?.update(this.carRig.root.position);

        this.onLaunch(lit);
        this.#updatePostFx(dt, 0, null);
        this.#render();
    }

    /**
     * Рендер на съперниците: същата интерполация между стъпките като при играча.
     *
     * @param {number} alpha Остатък от акумулатора, [0..1)
     * @param {number} dt
     */
    #updateOpponents(alpha, dt) {
        for (const opp of this.opponents) {
            const s = opp.sim.state;

            // Телепорт (recovery) — без интерполация през картата.
            if (opp.sim.snapRender) {
                opp.prevX = s.x;
                opp.prevZ = s.z;
                opp.prevHeading = s.heading;
                opp.sim.snapRender = false;
            }

            let dH = s.heading - opp.prevHeading;
            if (dH > Math.PI) dH -= 2 * Math.PI;
            else if (dH < -Math.PI) dH += 2 * Math.PI;

            const render = opp._render;
            Object.assign(render, s);
            render.x = opp.prevX + (s.x - opp.prevX) * alpha;
            render.z = opp.prevZ + (s.z - opp.prevZ) * alpha;
            render.heading = opp.prevHeading + dH * alpha;

            const dyn = opp._dyn;
            dyn.gLong = s.out?.ax ?? 0;
            dyn.gLat = s.out?.ay ?? s.yawRate * s.vForward;
            dyn.brake = s.brakePedal ?? opp.input.brake;
            dyn.throttle = s.throttlePedal ?? opp.input.throttle;
            dyn.lockF = s.out?.lockF ?? 0;
            dyn.lockR = s.out?.lockR ?? 0;
            dyn.spin = s.out?.spin ?? 0;
            dyn.kerbSide = s.out?.kerbSide ?? (opp.sim.onKerb ? 1 : 0);
            dyn.rumble = 0;
            updateCarRig(opp.rig, render, opp.sim.surface, dt, dyn);
            updateDrivetrain(opp.drivetrain, s.vForward, opp.input.throttle);
            opp.emitter?.emit(dt, render, opp.sim.surface, opp.sim, opp.input, s.out);
            opp.skidWriter?.write(dt, render, opp.sim.surface, opp.sim, opp.input, s.out);
            opp.effects?.update(dt, render, opp.input, opp.drivetrain, opp.sim, {
                cameraMode: this.cameraMode,
            });
        }
    }

    /**
     * Най-близкият съперник в ухото: сила по разстоянието, панорама по
     * страната спрямо камерата.
     *
     * @param {object} render Интерполираното състояние на играча
     */
    #updateRivalSound(render) {
        if (this.opponents.length === 0) {
            return;
        }

        let nearest = Infinity;
        let speed = 0;
        let nx = 0;
        let nz = 0;

        for (const opp of this.opponents) {
            const s = opp.sim.state;
            const d = Math.hypot(s.x - render.x, s.z - render.z);
            if (d < nearest) {
                nearest = d;
                speed = Math.abs(s.vForward);
                nx = s.x;
                nz = s.z;
            }
        }

        // Панорама: проекция върху дясната ос на камерата (матрицата е от
        // предния кадър — закъснение от 1 кадър, нечуто).
        let pan = 0;
        if (Number.isFinite(nearest) && nearest > 0.001) {
            const e = this.camera.matrixWorld.elements;
            pan = ((nx - this.camera.position.x) * e[0] + (nz - this.camera.position.z) * e[2]) / 25;
        }

        // Доплер: радиална скорост от разликата на дистанциите между кадри.
        // Голям скок = смяна на най-близкия/телепорт — нулира се, не „свисти".
        let closing = 0;
        if (
            Number.isFinite(nearest) &&
            this.prevRivalDistance !== null &&
            Math.abs(this.prevRivalDistance - nearest) < 15
        ) {
            const frameDt = Math.max(1 / 240, (performance.now() - this.prevRivalTime) / 1000);
            closing = (this.prevRivalDistance - nearest) / frameDt;
        }
        this.prevRivalDistance = Number.isFinite(nearest) ? nearest : null;
        this.prevRivalTime = performance.now();

        this.sound.updateRival(nearest, speed, pan, closing);
    }

    /**
     * Духът: интерполира кадрите на рекордната обиколка спрямо ТЕКУЩИЯ
     * хронометър — истинска задочна битка, паузите (гейт) спират и двамата.
     */
    #updateGhost(dt) {
        if (this.race && this.raceRival?.timing) {
            this.#updateRaceRival(dt);
            return;
        }

        const sim = this.sim;
        // Дуелният дух (класацията) има предимство пред личния/официалния.
        const ghost = this.rivalGhost ?? this.ghost;

        // Духът е СОЛО фийчър: в състезание позлатеният официален дух би
        // карал „през" полето като седми, недосегаем съперник — объркващо,
        // при това в цвят близък до жълтата ливрея.
        if (!ghost || sim.phase !== 'flying' || this.opponents.length > 0) {
            if (this.ghostRig.root.visible) {
                this.ghostDriver.reset();
            }
            this.ghostRig.root.visible = false;
            return;
        }

        const frames = ghost.frames;
        // -1 кадър: frames[k] е състоянието СЛЕД отброен тик 2(k+1) — без
        // корекцията духът върви ~17 ms пред реалната си позиция и „бие"
        // играч, който точно изравнява рекорда.
        const position = Math.max(0, sim.lapTicks / FRAME_EVERY - 1);
        if (position >= this.ghostDriver.frameCount(frames) - 1) {
            // Духът вече е финиширал — прибира се.
            this.ghostRig.root.visible = false;
            return;
        }

        this.ghostDriver.sample(frames, position, this.ghostOut);
        this.ghostDriver.applyToRig(this.ghostRig, this.ghostOut, dt);
        this.ghostRig.root.visible = true;
    }

    /**
     * Задочният съперник в състезание: кадрите му по часовника на
     * състезанието (гасенето = кадър 0), плюс хронометраж за кулата.
     *
     * @param {number} dt
     */
    #updateRaceRival(dt) {
        const rival = this.raceRival;
        const timing = rival.timing;
        const frames = rival.frames;
        // -1 кадър: frames[k] е състоянието СЛЕД тик 2(k+1) (виж #updateGhost).
        const position = Math.max(0, this.race.clock / FRAME_EVERY - 1);

        if (position >= this.ghostDriver.frameCount(frames) - 1) {
            // Съперникът финишира — прибира се; остава в кулата на линията.
            if (!timing.finished) {
                timing.finished = true;
                timing.laps = RACE_TOTAL_LAPS + 1;
                timing.lastProgress = 0;
            }
            this.ghostRig.root.visible = false;
            return;
        }

        this.ghostDriver.sample(frames, position, this.ghostOut);
        this.ghostDriver.applyToRig(this.ghostRig, this.ghostOut, dt);
        this.ghostRig.root.visible = true;

        if (this.race.clock > 0) {
            trackWrap(timing, this.ghostOut.lastProgress);
            recordTimingAt(this.race, timing, Math.round((position + 1) * FRAME_EVERY));
        }
    }

    /**
     * Кадър от ТВ реплея: колата повтаря записа, камерата снима от крайпътни
     * постове с телевизионна режисура (задръж докато отмине, режи напред).
     *
     * @param {number} dt
     */
    #replayFrame(dt) {
        const director = this.tvDirector;
        if (!director.active) {
            return;
        }
        director.update(dt);
        const car = director.car;

        this.effectTime += dt;
        this.playerEmitter.emit(dt, car, car.surface, car, car, car);
        this.playerSkidWriter.write(dt, car, car.surface, car, car, car);
        this.particles.update(dt, this.camera);
        this.skidMarks.update(dt, this.camera);
        this.carEffects?.update(dt, car, car, director.drivetrain, car, {
            cameraMode: director.cameraMode(),
            replay: true,
        });

        for (const animate of this.decorAnimations) {
            animate(dt);
        }
        this.trackGroup.userData.update?.(dt, this.camera, this.effectTime);

        const tunnel = this.circuit.tunnel;
        const inTunnel = Boolean(tunnel) && car.distance >= tunnel.from && car.distance <= tunnel.to;
        this.atmosphere?.update(dt, this.camera.position, inTunnel);
        this.surfaceController?.update(dt, this.camera, this.sunDir);
        this.nightLights?.update(dt, car, this.camera, car.trackIndexHint);

        this.sound.updateBroadcast(
            director.shot.distance,
            Math.abs(car.vForward),
            director.shot.pan,
            director.shot.closing,
            director.drivetrain.visualRpm,
            director.drivetrain.shifted
        );
        this.#followSun(car.x, car.y, car.z);
        this.cascadedShadows?.update(this.carRig.root.position);
        this.#updatePostFx(dt, clamp01(Math.abs(car.vForward) / CAR.maxSpeed), this.carRig.root.position);
        this.#render();

        if (!this.replay?.attract) {
            this.telemetryAccum += dt;
            if (this.telemetryAccum >= TELEMETRY_INTERVAL) {
                this.telemetryAccum = 0;
                this.onTelemetry({
                    replayProgress: director.progress(),
                    replaySpeed: director.playbackSpeed(),
                    replayCamera: director.cameraMode(),
                    speed: Math.round(Math.abs(car.vForward) * 3.6),
                    rpm: Math.round(director.drivetrain.visualRpm),
                    gear: director.drivetrain.gear,
                });
            }
        }
    }

}

const INTERESTING_KEYS = new Set([
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'KeyW',
    'KeyA',
    'KeyS',
    'KeyD',
    'Space',
]);

/**
 * Духът: процедурният болид, полупрозрачен и без сянка — рекордната обиколка,
 * каращa редом. Външният GLB не се клонира нарочно: духът се чете по-ясно
 * като силует.
 *
 * @returns {ReturnType<typeof buildCar>}
 */
function buildGhostRig() {
    const rig = buildCar();
    rig.tintables = [];

    rig.root.traverse((object) => {
        if (object.isMesh) {
            const material = object.material.clone();
            material.transparent = true;
            material.opacity = 0.35;
            material.depthWrite = false;
            if (material.color) {
                // Базовият цвят се пази — тонът се сменя (личен син ↔
                // официален златист) без да се наслагват lerp-ове.
                rig.tintables.push({ material, base: material.color.clone() });
            }
            object.material = material;
            object.castShadow = false;
        }
    });

    tintGhostRig(rig, 0x9fc8ff); // призрачно-син = личният рекорд

    return rig;
}

/**
 * Тонира духа: личен (син) или официалният на Падок (златист).
 *
 * @param {ReturnType<typeof buildGhostRig>} rig
 * @param {number} tint
 */
function tintGhostRig(rig, tint) {
    if (typeof rig.setTint === 'function') {
        rig.setTint(tint);
        return;
    }
    const color = new THREE.Color(tint);
    for (const { material, base } of rig.tintables) {
        material.color.copy(base).lerp(color, 0.7);
    }
}

/**
 * Съперник: процедурният болид с генерична ливрея (само боята се сменя —
 * никакви реални отбори). Материалите са клонирани per-кола, за да може
 * изсветляването при близост да не пипа другите.
 *
 * @param {number} color
 * @param {boolean} castShadow Телефонът ги маха от сенчестия pass
 * @returns {ReturnType<typeof buildCar> & {materials: THREE.Material[]}}
 */
function buildOpponentRig(color, castShadow) {
    const rig = buildCar();
    const materials = [];
    const cloned = new Map();

    rig.root.traverse((object) => {
        if (!object.isMesh) {
            return;
        }

        let material = cloned.get(object.material);
        if (!material) {
            material = object.material.clone();
            // Боядисва се само боята (MeshPhysical) — гуми/тъмни части остават.
            if (material.isMeshPhysicalMaterial) {
                material.color.set(color);
            }
            cloned.set(object.material, material);
            materials.push(material);
        }
        object.material = material;
        object.castShadow = castShadow;
    });

    rig.materials = materials;

    return rig;
}

/** Нулево състояние на радиото за ново състезание. */
function createRadioState() {
    return {
        sequence: 0,
        lastSaid: -Infinity,
        position: null,
        pendingPosition: null,
        pendingSince: 0,
        lastLapSaid: false,
        attackSaid: new Map(),
        rivalLapSaid: 0,
    };
}

/**
 * Подредбата за подиума (2-1-3 блоковете) от класирането.
 *
 * @param {Array<{position: number, name: string|null, isPlayer: boolean}>} classification
 */
function standingsOf(classification) {
    return classification.map((row) => ({ position: row.position, name: row.name, isPlayer: row.isPlayer }));
}

/**
 * Събира телеметрията на летящата обиколка в равномерни 10-метрови бинове.
 * Пази само суми и първо време на достигане, затова няма алокации в sim тика.
 */
function createLapAnalysisRecorder(track) {
    const bins = Math.max(2, Math.ceil(track.length / 10));
    const speedSum = new Float64Array(bins);
    const brakeSum = new Float64Array(bins);
    const throttleSum = new Float64Array(bins);
    const samples = new Uint16Array(bins);
    const firstTime = new Float64Array(bins);
    let elapsed = 0;

    const reset = () => {
        speedSum.fill(0);
        brakeSum.fill(0);
        throttleSum.fill(0);
        samples.fill(0);
        firstTime.fill(Number.NaN);
        elapsed = 0;
    };

    const record = (progress, state, input) => {
        elapsed += FIXED_DT;
        const distance = clamp(progress, 0, 1 - Number.EPSILON) * track.length;
        const index = Math.min(bins - 1, Math.floor(distance / track.length * bins));
        speedSum[index] += Math.abs(state.vForward) * 3.6;
        brakeSum[index] += state.brakePedal ?? input.brake ?? 0;
        throttleSum[index] += state.throttlePedal ?? input.throttle ?? 0;
        samples[index]++;
        if (!Number.isFinite(firstTime[index])) {
            firstTime[index] = elapsed;
        }
    };

    const finish = (ghostFrames) => {
        const speed = new Float64Array(bins);
        const brake = new Float64Array(bins);
        const throttle = new Float64Array(bins);
        for (let i = 0; i < bins; i++) {
            if (samples[i] > 0) {
                speed[i] = speedSum[i] / samples[i];
                brake[i] = brakeSum[i] / samples[i];
                throttle[i] = throttleSum[i] / samples[i];
            } else {
                speed[i] = Number.NaN;
                brake[i] = Number.NaN;
                throttle[i] = Number.NaN;
            }
        }
        fillAnalysisGaps(speed, 0);
        fillAnalysisGaps(brake, 0);
        fillAnalysisGaps(throttle, 0);
        const playerTime = Float64Array.from(firstTime);
        fillAnalysisGaps(playerTime, 0);

        const ghost = ghostFrames?.length >= 6 ? analysisProfileFromFrames(track, ghostFrames, bins) : null;
        const delta = ghost
            ? Array.from(playerTime, (value, i) => value - ghost.time[i])
            : null;
        const speeds = Array.from(speed);
        const avgSpeed = speeds.reduce((sum, value) => sum + value, 0) / speeds.length;
        const brakingBins = Array.from(brake).filter((value) => value > 0.5).length;

        return {
            length: track.length,
            binMetres: track.length / bins,
            speed: speeds,
            throttle: Array.from(throttle),
            brake: Array.from(brake),
            ghostSpeed: ghost ? Array.from(ghost.speed) : null,
            delta,
            sectors: [1 / 3, 2 / 3],
            summary: {
                topSpeed: Math.max(...speeds),
                averageSpeed: avgSpeed,
                brakingPercent: (brakingBins / bins) * 100,
                finalDelta: delta ? delta[delta.length - 1] : null,
            },
        };
    };

    reset();
    return { reset, record, finish };
}

/** Извежда скорост и време по дистанция от 60 Hz ghost кадрите [x,z,heading]. */
function analysisProfileFromFrames(track, frames, bins) {
    const speedSum = new Float64Array(bins);
    const samples = new Uint16Array(bins);
    const time = new Float64Array(bins);
    time.fill(Number.NaN);
    let hint = null;
    const projection = {};
    const frameCount = Math.floor(frames.length / 3);
    const frameDt = FIXED_DT * FRAME_EVERY;

    for (let frame = 0; frame < frameCount - 1; frame++) {
        const at = frame * 3;
        const next = at + 3;
        const x = frames[at];
        const z = frames[at + 1];
        projectOnTrack(track, x, z, hint, projection);
        hint = projection.index;
        const index = Math.min(bins - 1, Math.floor(clamp(projection.distance / track.length, 0, 1 - Number.EPSILON) * bins));
        const metres = Math.hypot(frames[next] - x, frames[next + 1] - z);
        // Recovery/сеек скок не е скорост; оставяме съседните бинове да го запълнят.
        if (metres < 8) {
            speedSum[index] += (metres / frameDt) * 3.6;
            samples[index]++;
        }
        if (!Number.isFinite(time[index])) {
            time[index] = frame * frameDt;
        }
    }

    const speed = new Float64Array(bins);
    for (let i = 0; i < bins; i++) {
        speed[i] = samples[i] > 0 ? speedSum[i] / samples[i] : Number.NaN;
    }
    fillAnalysisGaps(speed, 0);
    fillAnalysisGaps(time, 0);
    return { speed, time };
}

/** Линейно запълва празните бинове между най-близките измерени съседи. */
function fillAnalysisGaps(values, fallback) {
    let first = -1;
    for (let i = 0; i < values.length; i++) {
        if (Number.isFinite(values[i])) {
            first = i;
            break;
        }
    }
    if (first < 0) {
        values.fill(fallback);
        return;
    }
    for (let i = 0; i < first; i++) {
        values[i] = values[first];
    }
    let left = first;
    for (let right = first + 1; right < values.length; right++) {
        if (!Number.isFinite(values[right])) {
            continue;
        }
        const a = values[left];
        const b = values[right];
        const width = right - left;
        for (let i = left + 1; i < right; i++) {
            values[i] = a + (b - a) * ((i - left) / width);
        }
        left = right;
    }
    for (let i = left + 1; i < values.length; i++) {
        values[i] = values[left];
    }
}

/**
 * Мини-картата: нормализира трасето в квадрат [0,1]² (центрирано) и дава
 * project() за живите точки. Строи се веднъж; Vue рисува по canvas.
 *
 * @param {import('./track.js').Track} track
 * @returns {{path: Array<[number, number]>, project: (x: number, z: number) => {x: number, y: number}}}
 */
function buildMinimap(track) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < track.count; i++) {
        minX = Math.min(minX, track.xs[i]);
        maxX = Math.max(maxX, track.xs[i]);
        minZ = Math.min(minZ, track.zs[i]);
        maxZ = Math.max(maxZ, track.zs[i]);
    }

    const size = Math.max(maxX - minX, maxZ - minZ) || 1;
    const padX = (size - (maxX - minX)) / 2;
    const padZ = (size - (maxZ - minZ)) / 2;

    const project = (x, z) => ({
        x: (x - minX + padX) / size,
        y: (z - minZ + padZ) / size,
    });

    const path = [];
    const step = Math.max(1, Math.floor(track.count / 220));
    for (let i = 0; i < track.count; i += step) {
        const p = project(track.xs[i], track.zs[i]);
        path.push([p.x, p.y]);
    }

    return { path, project };
}

/**
 * Воланът за бордовата камера: обръч + спици + хъб, дете на halo групата.
 *
 * @returns {THREE.Group}
 */
function buildSteeringWheel() {
    const group = new THREE.Group();
    const dark = new THREE.MeshBasicMaterial({ color: 0x14161a });
    const accent = new THREE.MeshBasicMaterial({ color: 0x2c3038 });

    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.02, 6, 20), dark);
    group.add(rim);

    for (const angle of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]) {
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.15, 0.015), accent);
        spoke.position.set(Math.sin(angle) * 0.075, Math.cos(angle) * 0.075, 0);
        spoke.rotation.z = -angle;
        group.add(spoke);
    }

    const hub = new THREE.Mesh(new THREE.CircleGeometry(0.045, 10), accent);
    hub.position.z = 0.008;
    group.add(hub);

    group.position.set(0, -0.32, -0.52);

    return group;
}

/**
 * Halo силуетът + ръбът на кокпита за бордовата камера. Дете на камерата —
 * MeshBasic черно, като сянка срещу светлината (както го вижда пилотът).
 *
 * @returns {THREE.Group}
 */
function buildHaloOverlay() {
    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color: 0x0c0d0f });

    // Обръчът на halo-то — горната дъга пред погледа.
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.024, 8, 28, Math.PI), material);
    hoop.position.set(0, 0.1, -0.62);
    group.add(hoop);

    // Централната стойка.
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.2, 0.05), material);
    pylon.position.set(0, 0.0, -0.6);
    group.add(pylon);

    // Ръбът на кокпита — долната дъга.
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.08, 6, 24, Math.PI), material);
    rim.rotation.z = Math.PI;
    rim.position.set(0, -0.36, -0.78);
    group.add(rim);

    return group;
}

/**
 * Един нискополигонален mesh хвърля сянката на болида. Така GLB детайлът не
 * се рисува отново във всяка CSM каскада, а мобилният единичен shadow pass
 * също остава евтин.
 *
 * @param {import('./car.js').CarRig} rig
 * @param {THREE.Mesh} proxy
 */
function configureCarShadowCasters(rig, proxy) {
    rig.root.traverse((object) => {
        if (object.isMesh) {
            object.castShadow = object === proxy;
        }
    });
    proxy.castShadow = true;
}

/**
 * Картите, които material.dispose() не чисти (виж Game.dispose). envMap не е
 * тук: това е споделеният scene.environment, освобождаван отделно.
 */
const DISPOSABLE_MAPS = [
    'map',
    'normalMap',
    'roughnessMap',
    'metalnessMap',
    'aoMap',
    'emissiveMap',
    'alphaMap',
    'bumpMap',
    'clearcoatMap',
    'clearcoatRoughnessMap',
    'clearcoatNormalMap',
];

/** Измереният азимут на слънцето по HDRI файл — една сканировка на файл за сесията. */
const hdriSunAngles = new Map();

/**
 * Азимутът (rad, в конвенцията на equirectUv: atan(z, x)) на най-ярката
 * колона на HDR equirect-а — слънцето. Стъпка 2 по двете оси: ~0.5 M
 * пиксела за 2K, около 10 ms, еднократно на файл. HDRLoader връща HalfFloat
 * (Uint16) по подразбиране; Float32 се приема също. flipY не влияе на
 * колоната.
 *
 * @param {string} name
 * @param {THREE.DataTexture} hdr
 * @returns {number}
 */
function measureHdriSunAngle(name, hdr) {
    const cached = hdriSunAngles.get(name);
    if (cached !== undefined) {
        return cached;
    }

    const { data, width, height } = hdr.image;
    const half = data instanceof Uint16Array;
    const read = half ? (v) => THREE.DataUtils.fromHalfFloat(v) : (v) => v;
    let best = -Infinity;
    let bestX = width / 2;
    for (let y = 0; y < height; y += 2) {
        let i = y * width * 4;
        for (let x = 0; x < width; x += 2, i += 8) {
            const luma = read(data[i]) * 0.2126 + read(data[i + 1]) * 0.7152 + read(data[i + 2]) * 0.0722;
            if (luma > best) {
                best = luma;
                bestX = x;
            }
        }
    }

    const angle = ((bestX + 0.5) / width - 0.5) * Math.PI * 2;
    hdriSunAngles.set(name, angle);

    return angle;
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
