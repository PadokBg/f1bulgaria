/**
 * Атмосферата на пистата: въздухът между камерата и хоризонта.
 *
 * Стълбът „Slow Roads": хоризонтът никога не е твърда линия. Далечният терен
 * се разтваря в цвета на НЕБЕТО ПРИ ХОРИЗОНТА (семплиран от показаното небе —
 * HDRI или процедурния куб, не ръчна константа), мъглата е по-гъста ниско и
 * по-топла към слънцето, слънцето е реален диск, който bloom-ът озарява, а
 * където няма HDRI (телефон, нощ, здрач) над сцената плуват облаци и луна.
 *
 * Модулът е чисто презентационен: чете circuit/look, никога sim state.
 *
 * ЕДИНСТВЕНИЯТ fog override в играта живее тук (installFogChunks). Никой
 * друг пакет не подменя fog_* chunk-овете; който иска обект без мъгла, слага
 * material.fog = false.
 *
 * Публично:
 *   installFogChunks()                    — глобален chunk override; изпълнява се при import
 *   FOG_UNIFORMS                          — споделените стойности на мъглата (виж коментара там)
 *   PRESETS, skyParamsFor(circuit)        — параметрите на Sky шейдъра по preset
 *   sunDirectionFor(circuit)              — единичен вектор КЪМ слънцето (формулата на Game.js)
 *   createAtmosphere({...})               — слънце/облаци/луна/мъгла/hemisphere за една игра
 */

import * as THREE from 'three';
import { lookFor } from './circuits.js';

// ─── Мъгла: глобален override на fog chunk-овете ─────────────────────────────
//
// ЗАЩО глобален (ShaderChunk), а не applyPatch по материал: мъглата трябва да
// стигне до ВСЕКИ материал с fog:true — терен, дървета (InstancedMesh), OSM,
// клонираните материали на съперниците, Points на частиците, Sprite-ове —
// включително създадените от други пакети след нас. Подмяната на chunk-а е
// едно място, без обхождане на сцената, и three я резолвва при компилация.
//
// ЗАЩО uniform стойностите са ГОЛИ обекти {x,y,z}, а не Vector3/Color: при
// компилация three клонира uniforms-ите на ShaderLib за всеки материал
// (UniformsUtils.clone → cloneUniforms). Vector3/Color се клонират (.clone()),
// числата се копират по стойност — и промяна след това не стига до вече
// компилираните програми. Гол обект без .clone() обаче се копира ПО РЕФЕРЕНЦИЯ
// (cloneUniforms: `dst[u][p] = property`), а WebGLUniforms качва vec3/vec4 от
// всичко с поле .x (setValueV3f/V4f). Така ЕДИН обект захранва всички програми
// без hook по материал. Скаларите затова са опаковани във vec4.

const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogRay;
#endif
`;

const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	// Лъчът камера→връх в СВЕТОВНИ оси, от view-space позицията: viewMatrix е
	// твърдо движение, обратното на ротацията му е транспонираното. Не зависи
	// от modelMatrix/instanceMatrix/batchingMatrix — всеки вграден шейдър на
	// three има mvPosition в обхват при fog_vertex (спрайтове и точки също).
	vFogRay = transpose( mat3( viewMatrix ) ) * mvPosition.xyz;
#endif
`;

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogRay;
	uniform vec3 uFogHorizon;
	uniform vec3 uFogZenith;
	uniform vec3 uFogSunDir;
	uniform vec3 uFogSunColor;
	// x: височинен спад (1/m), y: дял на височинната мъгла 0..1, z: плътност (мащаб на разстоянието), w: in-scatter към слънцето 0..1
	uniform vec4 uFogParams;
	// x: под на мъглата (световно y), y: скорост на прехода хоризонт→зенит по dir.y, z: свободно, w: 1 = атмосферата е задала хоризонта
	uniform vec4 uFogParams2;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	float fogDist = length( vFogRay );
	vec3 fogDir = vFogRay / max( fogDist, 1e-3 );
	// Експоненциална височинна мъгла (интегралът на Quilez): средна плътност
	// по лъча спрямо тази на височината на камерата. Ограничена отгоре, за да
	// не гърми, когато камерата слезе под пода (Спа: долината под Eau Rouge).
	float fogK = uFogParams.x * vFogRay.y;
	float fogInt = abs( fogK ) > 1e-3 ? ( 1.0 - exp( - fogK ) ) / fogK : 1.0 - 0.5 * fogK;
	float fogH = clamp( exp( - uFogParams.x * ( cameraPosition.y - uFogParams2.x ) ) * fogInt, 0.0, 2.0 );
	float fogEff = fogDist * uFogParams.z * mix( 1.0, fogH, uFogParams.y );
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * fogEff * fogEff );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, fogEff );
	#endif
	// Цветът е този на небето в посоката на лъча: хоризонтът ниско, зенитът
	// нагоре (короните на дърветата по билото се стапят в синьото, не в
	// сивото), плюс топло сияние към слънцето — широк лоб (^8) и ядро (^32).
	vec3 fogSky = mix( mix( fogColor, uFogHorizon, uFogParams2.w ), uFogZenith, clamp( fogDir.y * uFogParams2.y, 0.0, 1.0 ) );
	float fogSun = max( dot( fogDir, uFogSunDir ), 0.0 );
	fogSun *= fogSun;
	fogSun *= fogSun;
	fogSun *= fogSun;
	fogSky = mix( fogSky, uFogSunColor, uFogParams.w * ( 0.7 * fogSun + 0.3 * fogSun * fogSun * fogSun * fogSun ) );
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogSky, fogFactor );
#endif
`;

/**
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} [w]
 * @returns {{x: number, y: number, z: number, w?: number}}
 */
function plainVec(x, y, z, w) {
    return w === undefined ? { x, y, z } : { x, y, z, w };
}

/**
 * Споделените стойности на мъглата. Стойностите по подразбиране възпроизвеждат
 * СТАНДАРТНАТА линейна мъгла на three (без височина, без слънце, fogColor),
 * докато createAtmosphere не ги презапише — сцена без атмосфера изглежда
 * както преди. Пиши в .value.x/.y/… — никога не подменяй самите обекти:
 * референциите вече седят във всяка компилирана програма.
 *
 * ShaderMaterial на друг пакет, който включва fog chunk-овете, ги получава
 * автоматично през UniformsUtils.merge([UniformsLib.fog, …]) (merge клонира по
 * същото правило) или ръчно: Object.assign(material.uniforms, FOG_UNIFORMS).
 */
export const FOG_UNIFORMS = Object.freeze({
    uFogHorizon: { value: plainVec(0.74, 0.8, 0.86) },
    uFogZenith: { value: plainVec(0.35, 0.5, 0.78) },
    uFogSunDir: { value: plainVec(0, 1, 0) },
    uFogSunColor: { value: plainVec(1, 0.92, 0.8) },
    uFogParams: { value: plainVec(0, 0, 1, 0) },
    uFogParams2: { value: plainVec(0, 3, 0, 0) },
});

let fogChunksInstalled = false;

/**
 * Подменя fog chunk-овете на three и регистрира uniforms-ите в UniformsLib.fog
 * И във всеки ShaderLib запис с мъгла (ShaderLib е събран от UniformsLib при
 * зареждането на three — късна добавка само в UniformsLib не би стигнала до
 * вградените материали). Идемпотентна; изпълнява се при import на модула,
 * т.е. преди първата компилация на какъвто и да е материал в играта.
 */
export function installFogChunks() {
    if (fogChunksInstalled || THREE.ShaderChunk.fog_fragment.includes('vFogRay')) {
        fogChunksInstalled = true;
        return;
    }
    THREE.ShaderChunk.fog_pars_vertex = FOG_PARS_VERTEX;
    THREE.ShaderChunk.fog_vertex = FOG_VERTEX;
    THREE.ShaderChunk.fog_pars_fragment = FOG_PARS_FRAGMENT;
    THREE.ShaderChunk.fog_fragment = FOG_FRAGMENT;

    Object.assign(THREE.UniformsLib.fog, FOG_UNIFORMS);
    for (const key of Object.keys(THREE.ShaderLib)) {
        const uniforms = THREE.ShaderLib[key]?.uniforms;
        if (uniforms?.fogColor) {
            Object.assign(uniforms, FOG_UNIFORMS);
        }
    }
    fogChunksInstalled = true;
}

installFogChunks();

// ─── Presets ──────────────────────────────────────────────────────────────────

/**
 * Светлинните preset-и. sky = uniforms на Sky (Preetham) за процедурния куб:
 * това е небето на телефона, на нощта и placeholder-ът преди HDRI-то, а от
 * него се семплира и хоризонтът на мъглата, така че overcast дава бледа,
 * млечна мъгла, а golden — топла. skyElevation: елевация на слънцето на
 * НЕБЕСНИЯ шейдър (null = тази на светлината); hdri: дали десктопът зарежда
 * снимано небе; hemisphere: сила на fill-а (overcast е по-силен: без пряко
 * слънце светлината идва отвсякъде); sunSprite: сила на слънчевия диск;
 * cloud*: облачните пелени за небе без HDRI; exposureScale омекотява
 * светлите части преди tone mapping-а, без да променя цветовия характер.
 */
export const PRESETS = Object.freeze({
    day: {
        sky: { turbidity: 6, rayleigh: 2.2, mieCoefficient: 0.005, mieDirectionalG: 0.8 },
        skyElevation: null,
        hdri: true,
        hemisphere: 0.3,
        sunSprite: 1,
        exposureScale: 0.84,
        cloudTint: 0xffffff,
        cloudOpacity: 0.55,
    },
    golden: {
        sky: { turbidity: 8, rayleigh: 2.6, mieCoefficient: 0.012, mieDirectionalG: 0.85 },
        skyElevation: null,
        hdri: true,
        hemisphere: 0.28,
        sunSprite: 1.05,
        exposureScale: 0.7,
        cloudTint: 0xfff0dc,
        cloudOpacity: 0.5,
    },
    overcast: {
        sky: { turbidity: 20, rayleigh: 0.8, mieCoefficient: 0.04, mieDirectionalG: 0.6 },
        skyElevation: null,
        hdri: true,
        hemisphere: 0.45,
        sunSprite: 0.25,
        exposureScale: 0.9,
        cloudTint: 0xe2e6ea,
        cloudOpacity: 0.7,
    },
    // Здрач: слънце на 5° над хоризонта, гъст Mie — оранжево небе, дълги
    // сенки. Няма HDRI (дневната снимка би го развалила). Авторът на пистата
    // сваля и atmosphere.sunElevation ниско, за да съвпаднат сенките.
    dusk: {
        sky: { turbidity: 10, rayleigh: 3, mieCoefficient: 0.02, mieDirectionalG: 0.9 },
        skyElevation: 5,
        hdri: false,
        hemisphere: 0.3,
        sunSprite: 1.1,
        exposureScale: 0.72,
        cloudTint: 0xffc9a0,
        cloudOpacity: 0.5,
    },
    // Нощ: небесното слънце на −12° дава тъмносиния здрач на Rayleigh модела;
    // directional-ът остава прожекторите. Без слънчев диск, с луна.
    night: {
        sky: { turbidity: 6, rayleigh: 2.2, mieCoefficient: 0.005, mieDirectionalG: 0.8 },
        skyElevation: -12,
        hdri: false,
        // Floodlit asphalt and grandstands bounce neutral light even under a
        // black sky. Keep this separate from sky/fog brightness so carbon and
        // tyre sidewalls retain shape without lifting the whole night image.
        hemisphere: 0.95,
        hemisphereSky: 0xc4c9d0,
        hemisphereGround: 0x898b8e,
        sunSprite: 0,
        exposureScale: 0.88,
        cloudTint: 0x1b2233,
        cloudOpacity: 0.6,
    },
});

/**
 * Посока КЪМ слънцето от азимут/елевация — същата формула като Game.js, за
 * да сочат сянката, слънчевият диск и in-scatter-ът към една точка.
 *
 * @param {object} circuit
 * @returns {THREE.Vector3}
 */
export function sunDirectionFor(circuit) {
    const atmosphere = circuit.atmosphere;
    const phi = THREE.MathUtils.degToRad(90 - atmosphere.sunElevation);
    const theta = THREE.MathUtils.degToRad(atmosphere.sunAzimuth);

    return new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
}

/**
 * Параметрите на Sky шейдъра за пистата: Game.js ги слага върху
 * sky.material.uniforms преди рендера на куба. useHdri казва дали десктопът
 * изобщо да зарежда HDRI (нощ/здрач — не); lowPower го гейтва отделно.
 *
 * @param {object} circuit
 * @returns {{turbidity: number, rayleigh: number, mieCoefficient: number, mieDirectionalG: number, sunElevation: number, sunAzimuth: number, skySunDir: THREE.Vector3, useHdri: boolean, preset: string}}
 */
export function skyParamsFor(circuit) {
    const look = lookFor(circuit);
    const preset = PRESETS[look.preset] ?? PRESETS.day;
    const sunElevation = preset.skyElevation ?? circuit.atmosphere.sunElevation;
    const sunAzimuth = circuit.atmosphere.sunAzimuth;
    const skySunDir = new THREE.Vector3().setFromSphericalCoords(
        1,
        THREE.MathUtils.degToRad(90 - sunElevation),
        THREE.MathUtils.degToRad(sunAzimuth)
    );

    return {
        ...preset.sky,
        sunElevation,
        sunAzimuth,
        skySunDir,
        useHdri: preset.hdri,
        preset: look.preset,
    };
}

// ─── Процедурни текстури ──────────────────────────────────────────────────────

const CLOUD_TEXTURE_SIZE = 256;
const CLOUD_TILE_METRES = 1000;
const CLOUD_SHEET_SIZE = 4000;
const CLOUD_LAYERS = [
    { height: 420, repeat: 4, driftScale: 1, uvBase: [0, 0] },
    { height: 480, repeat: 3, driftScale: 1.25, uvBase: [0.5, 0.37] },
];
const SUN_DISTANCE = 1500;
const MOON_DISTANCE = 1800;

/**
 * Детерминиран PRNG (mulberry32) — копие на този от Game.js; облаците са
 * едни и същи при всяко зареждане на една писта.
 *
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32(seed) {
    let a = seed >>> 0;

    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * @param {string} value
 * @returns {number}
 */
function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }

    return hash >>> 0;
}

/**
 * @param {number} t
 * @returns {number}
 */
function fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
function lerp(a, b, t) {
    return a + (b - a) * t;
}

/**
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} x
 * @returns {number}
 */
function smoothstep(edge0, edge1, x) {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));

    return t * t * (3 - 2 * t);
}

/**
 * Тайлващ се fbm value noise (тороидална решетка, квинтична интерполация) в
 * [0, 1]. Първата октава е с baseCells клетки — за облаци 4 клетки на 1 km
 * дават 250-метрови купести маси, каквито се четат от чейс камерата;
 * шумът в noiseTex.js е за настилки (16+ клетки) и е твърде ситен тук.
 *
 * @param {number} size
 * @param {number} seed
 * @param {number} octaves
 * @param {number} baseCells
 * @returns {Float32Array}
 */
function tileableFbm(size, seed, octaves, baseCells) {
    const out = new Float32Array(size * size);
    let total = 0;
    for (let octave = 0; octave < octaves; octave++) {
        const cells = baseCells << octave;
        if (cells > size) {
            break;
        }
        const amplitude = 1 / (1 << octave);
        const rand = mulberry32(seed + octave * 7919);
        const lattice = new Float32Array(cells * cells);
        for (let i = 0; i < lattice.length; i++) {
            lattice[i] = rand();
        }
        const scale = cells / size;
        for (let y = 0; y < size; y++) {
            const fy = y * scale;
            const y0 = Math.floor(fy);
            const y1 = (y0 + 1) % cells;
            const ty = fade(fy - y0);
            for (let x = 0; x < size; x++) {
                const fx = x * scale;
                const x0 = Math.floor(fx);
                const x1 = (x0 + 1) % cells;
                const tx = fade(fx - x0);
                const top = lerp(lattice[y0 * cells + x0], lattice[y0 * cells + x1], tx);
                const bottom = lerp(lattice[y1 * cells + x0], lattice[y1 * cells + x1], tx);
                out[y * size + x] += amplitude * lerp(top, bottom, ty);
            }
        }
        total += amplitude;
    }
    for (let i = 0; i < out.length; i++) {
        out[i] /= total;
    }

    return out;
}

/**
 * Облачна карта: RGBA8 256², RepeatWrapping, mipmaps. Алфата е покритието
 * (0 = чисто небе) с праг по look.clouds.cover; RGB потъмнява дебелите ядра.
 * Същата текстура е и картата на облачните сенки (семплира се .a).
 *
 * @param {number} cover 0..1
 * @param {string} slug
 * @returns {THREE.DataTexture}
 */
function makeCloudTexture(cover, slug) {
    const size = CLOUD_TEXTURE_SIZE;
    const field = tileableFbm(size, hashString(`clouds:${slug}`), 5, 4);
    const data = new Uint8Array(size * size * 4);
    const threshold = 0.68 - 0.36 * cover;
    for (let i = 0; i < field.length; i++) {
        const alpha = smoothstep(threshold, threshold + 0.28, field[i]);
        // Осветени ръбове, сиви „кореми": плътното ядро е наполовина по-тъмно
        // от небето — това е, което прави облака четим и на бяло небе.
        const shade = 1 - 0.5 * alpha * Math.sqrt(alpha);
        data[i * 4] = Math.round(shade * 255);
        data[i * 4 + 1] = Math.round(shade * 255);
        data[i * 4 + 2] = Math.round(shade * 255);
        data[i * 4 + 3] = Math.round(alpha * 255);
    }
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.name = `clouds-${slug}`;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;

    return texture;
}

/**
 * Радиален спрайт (слънце/луна): RGBA8, ClampToEdge. shape дава (rgb, alpha)
 * по r∈[0,1] от центъра.
 *
 * @param {number} size
 * @param {string} name
 * @param {(r: number) => [number, number]} shape
 * @returns {THREE.DataTexture}
 */
function makeRadialTexture(size, name, shape) {
    const data = new Uint8Array(size * size * 4);
    const half = size / 2;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const r = Math.hypot(x + 0.5 - half, y + 0.5 - half) / half;
            const [value, alpha] = shape(r);
            const i = (y * size + x) * 4;
            data[i] = data[i + 1] = data[i + 2] = Math.round(Math.min(1, Math.max(0, value)) * 255);
            data[i + 3] = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
        }
    }
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.name = name;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;

    return texture;
}

/**
 * Слънце: твърд диск + две гаусови сияния. Малкото сияние остава в алфата
 * (спрайтът е адитивен, HDR цветът му минава през bloom-а на десктопа).
 *
 * @returns {THREE.DataTexture}
 */
function makeSunTexture() {
    return makeRadialTexture(128, 'sun', (r) => {
        const disc = smoothstep(0.13, 0.1, r);
        const glow = 0.55 * Math.exp(-((r / 0.3) ** 2)) + 0.18 * Math.exp(-((r / 0.75) ** 2));

        return [1, disc + (1 - disc) * glow];
    });
}

/**
 * Луна: диск с мек ръб, лек limb darkening и бледо хало.
 *
 * @returns {THREE.DataTexture}
 */
function makeMoonTexture() {
    return makeRadialTexture(64, 'moon', (r) => {
        const disc = smoothstep(0.42, 0.36, r);
        const halo = 0.15 * Math.exp(-((r / 0.8) ** 2));
        const limb = 1 - 0.25 * Math.min(1, (r / 0.4) ** 2);

        return [disc > 0 ? limb : 1, disc + (1 - disc) * halo];
    });
}

/**
 * Облачна пелена: квадрат 4×4 km с RGBA vertex colours — алфата пада
 * радиално, за да не се вижда ръбът на пелената над хоризонта. Мащабът на
 * UV е метричен (repeat тайлове по 1 km), а world-anchoring-ът става през
 * map.offset в update() — пелената следва камерата, шарката стои в света.
 *
 * @param {number} segments
 * @returns {THREE.BufferGeometry}
 */
function makeCloudSheetGeometry(segments) {
    const geometry = new THREE.PlaneGeometry(CLOUD_SHEET_SIZE, CLOUD_SHEET_SIZE, segments, segments);
    const positions = geometry.attributes.position;
    const colors = new Float32Array(positions.count * 4);
    const radius = CLOUD_SHEET_SIZE / 2;
    for (let i = 0; i < positions.count; i++) {
        const r = Math.hypot(positions.getX(i), positions.getY(i)) / radius;
        colors[i * 4] = 1;
        colors[i * 4 + 1] = 1;
        colors[i * 4 + 2] = 1;
        colors[i * 4 + 3] = smoothstep(1, 0.35, r);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    geometry.rotateX(-Math.PI / 2);

    return geometry;
}

// ─── Семплиране на показаното небе ────────────────────────────────────────────

const HORIZON_ELEVATION = [2, 7];
const ZENITH_ELEVATION = [30, 40];

/**
 * @param {Float32Array|Uint16Array|Uint8Array} data
 * @returns {(v: number) => number}
 */
function channelReader(data) {
    if (data instanceof Uint16Array) {
        return (v) => THREE.DataUtils.fromHalfFloat(v);
    }
    if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
        return (v) => v / 255;
    }

    return (v) => v;
}

/**
 * Средният цвят на HDRI equirect-а в лента по елевация. Редовете на
 * DataTexture-а от HDRLoader са в реда на картината (ред 0 = зенит, среда =
 * хоризонт, последен = надир) — проверено върху двата файла в public/.
 *
 * @param {THREE.DataTexture} hdr
 * @param {number} fromElevation градуси
 * @param {number} toElevation градуси
 * @returns {THREE.Color|null}
 */
function averageEquirectBand(hdr, fromElevation, toElevation) {
    const { data, width, height } = hdr.image;
    const read = channelReader(data);
    const rowFrom = Math.floor(((90 - toElevation) / 180) * (height - 1));
    const rowTo = Math.floor(((90 - fromElevation) / 180) * (height - 1));
    const stride = 4;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = rowFrom; y <= rowTo; y++) {
        let i = y * width * 4;
        for (let x = 0; x < width; x += stride, i += 4 * stride) {
            r += read(data[i]);
            g += read(data[i + 1]);
            b += read(data[i + 2]);
            n++;
        }
    }

    return finiteColor(r, g, b, n);
}

/**
 * Средният цвят на процедурния куб в лента по елевация, от четирите странични
 * стени (пълните 360° на хоризонта). Стените на GL cube map са с начало
 * горе-ляво и three ги рендира обърнати по y; readPixels чете отдолу нагоре,
 * така че елевация e (fov 90°) е на ред (1 − tan e)/2 · size — проверено
 * емпирично: Mie сиянието на слънце на 24° пикира на ред ≈0.28·size. Кубът е
 * HalfFloat (Uint16) — един readback на ~2×45 реда × 4 стени при зареждане.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.WebGLCubeRenderTarget} cubeRT
 * @param {number} fromElevation
 * @param {number} toElevation
 * @returns {THREE.Color|null}
 */
function averageCubeBand(renderer, cubeRT, fromElevation, toElevation) {
    const size = cubeRT.width;
    const type = cubeRT.texture.type;
    if (renderer.capabilities.textureTypeReadable?.(type) === false) {
        return null;
    }
    const rowOf = (elevation) =>
        Math.min(size - 1, Math.max(0, Math.round(((1 - Math.tan(THREE.MathUtils.degToRad(elevation))) / 2) * size)));
    const y0 = rowOf(toElevation);
    const rows = Math.max(1, rowOf(fromElevation) - y0);
    const buffer =
        type === THREE.HalfFloatType
            ? new Uint16Array(size * rows * 4)
            : type === THREE.FloatType
              ? new Float32Array(size * rows * 4)
              : new Uint8Array(size * rows * 4);
    const read = channelReader(buffer);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (const face of [0, 1, 4, 5]) {
        buffer.fill(0);
        try {
            renderer.readRenderTargetPixels(cubeRT, 0, y0, size, rows, buffer, face);
        } catch {
            return null;
        }
        for (let i = 0; i < buffer.length; i += 16) {
            r += read(buffer[i]);
            g += read(buffer[i + 1]);
            b += read(buffer[i + 2]);
            n++;
        }
    }

    return finiteColor(r, g, b, n);
}

/**
 * Средният цвят или null при празен/повреден readback (нула навсякъде, NaN).
 *
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} n
 * @returns {THREE.Color|null}
 */
function finiteColor(r, g, b, n) {
    if (n === 0 || !Number.isFinite(r + g + b) || r + g + b <= 1e-4) {
        return null;
    }

    return new THREE.Color(r / n, g / n, b / n);
}

/**
 * Изтегля ОТТЕНЪКА на семплирания цвят към авторския при ЗАПАЗЕНА яркост:
 * яркостта трябва да е точно тази на небето (иначе напълно замъгленият терен
 * е с друга светлота от фона и ръбът се връща като лента), а характерът —
 * хладна Спа, топла Монца — идва от авторската fogColor.
 *
 * @param {THREE.Color} out
 * @param {THREE.Color} sampled
 * @param {THREE.Color} authored
 * @param {number} weight Дял на авторския оттенък 0..1
 * @returns {THREE.Color}
 */
function blendTint(out, sampled, authored, weight) {
    const luma = (c) => Math.max(1e-5, c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722);
    const ls = luma(sampled);
    const la = luma(authored);
    const r = lerp(sampled.r / ls, authored.r / la, weight) * ls;
    const g = lerp(sampled.g / ls, authored.g / la, weight) * ls;
    const b = lerp(sampled.b / ls, authored.b / la, weight) * ls;

    return out.setRGB(r, g, b);
}

// ─── Атмосферата на една игра ─────────────────────────────────────────────────

/**
 * @typedef {object} CloudShadow
 * @property {THREE.DataTexture} texture   RGBA 256², RepeatWrapping; .a = покритие 0..1
 * @property {THREE.Vector2} offset        Отместване в тайлове (вятър + проекция по слънцето), обновява се всеки кадър
 * @property {number} strength             look.cloudShadow 0..1 (0 → консуматорът пропуска fetch-а)
 * @property {number} tileMetres           1000
 * @property {{tCloud: {value: THREE.Texture}, uCloudOffset: {value: THREE.Vector2}, uCloudStrength: {value: number}, uCloudTile: {value: number}}} uniforms
 *           Готови за applyPatch (споделени обекти). GLSL на консуматора:
 *           `float cover = texture2D(tCloud, vec2(wp.x, -wp.z) / uCloudTile + uCloudOffset).a;`
 *           `directLight.color *= 1.0 - uCloudStrength * cover;`
 */

/**
 * Създава атмосферата на пистата и я закача към сцената.
 *
 * Ред на извикване в Game.#setupEnvironment: след cubeCam.update (кубът е
 * нужен за семплиране на хоризонта и се чете ПРЕДИ Game да го dispose-не),
 * после atmosphere.sampleSky({hdr}) когато HDRI-то пристигне.
 *
 * @param {object} options
 * @param {THREE.WebGLRenderer} options.renderer
 * @param {THREE.Scene} options.scene
 * @param {object} options.circuit                circuitFor(slug)
 * @param {boolean} [options.lowPower]
 * @param {object|null} [options.quality]         game.quality (postFx решава HDR силата на диска)
 * @param {THREE.WebGLCubeRenderTarget|null} [options.cubeRT]  Процедурният куб — семплира се веднага
 * @param {THREE.HemisphereLight|null} [options.hemisphere]    Fill светлината, преоцветявана по небето
 * @param {THREE.Vector3|null} [options.sunDir]   Посока към слънцето (game.sunDir); по подразбиране от пистата
 * @param {{ys?: Float32Array}|null} [options.track]  За пода на мъглата (най-ниската точка на трасето)
 * @param {number} [options.groundLevel]          Под на мъглата, ако няма track
 * @param {string} [options.slug]                 Seed на облаците (по подразбиране от track/circuit)
 */
export function createAtmosphere({
    renderer,
    scene,
    circuit,
    lowPower = false,
    quality = null,
    cubeRT = null,
    hemisphere = null,
    sunDir = null,
    track = null,
    groundLevel = 0,
    slug = '',
}) {
    installFogChunks();
    const look = lookFor(circuit);
    const preset = PRESETS[look.preset] ?? PRESETS.day;
    const night = look.preset === 'night';
    const bloom = !lowPower && quality?.postFx !== false;
    const atmosphere = circuit.atmosphere;
    const seed = slug || track?.slug || `${atmosphere.sunAzimuth}:${atmosphere.fogColor}`;

    const sun = sunDir ? sunDir.clone().normalize() : sunDirectionFor(circuit);
    const sunColor = new THREE.Color(atmosphere.sunColor);
    const authoredFog = new THREE.Color(atmosphere.fogColor);

    let floor = groundLevel;
    if (track?.ys?.length) {
        floor = Infinity;
        for (let i = 0; i < track.ys.length; i++) {
            if (track.ys[i] < floor) {
                floor = track.ys[i];
            }
        }
    }

    const exposureOriginal = renderer.toneMappingExposure;
    const exposureBase = exposureOriginal * (preset.exposureScale ?? 0.9);
    renderer.toneMappingExposure = exposureBase;

    const state = {
        horizon: authoredFog.clone(),
        // Без семплирано небе: зенитът е хоризонтът, изтеглен към синьо
        // (нощем авторската мъгла е почти черна и остава такава).
        zenith: authoredFog.clone().multiply(new THREE.Color(0.5, 0.64, 0.92)),
        skyMode: 'procedural',
        exposureOriginal,
        exposureBase,
        exposure: exposureBase,
        wasInTunnel: false,
        overshoot: 0,
    };

    // ── Мъгла ────────────────────────────────────────────────────────────────
    const fog = look.fog;
    const u = FOG_UNIFORMS;
    u.uFogSunDir.value.x = sun.x;
    u.uFogSunDir.value.y = sun.y;
    u.uFogSunDir.value.z = sun.z;
    u.uFogParams.value.x = fog.falloff;
    u.uFogParams.value.y = fog.height;
    u.uFogParams.value.z = fog.density;
    u.uFogParams.value.w = night ? 0 : fog.sunScatter;
    u.uFogParams2.value.x = floor + fog.floor;
    u.uFogParams2.value.y = 3;
    u.uFogParams2.value.w = 1;

    // ── Вятър и облачни сенки (споделени с surfaceShader, дървета, флагове) ──
    const wind = { x: look.wind.x, z: look.wind.z, speed: look.wind.speed };
    const windLength = Math.hypot(wind.x, wind.z) || 1;
    wind.x /= windLength;
    wind.z /= windLength;

    const cloudTexture = makeCloudTexture(look.clouds.cover, seed);
    const drift = new THREE.Vector2();
    // Сянката на облак на 420 m пада встрани по слънцето: 420/tan(elev) метра
    // срещу посоката му (константа в тайлове, за да съвпада с пелената горе).
    const sunShift = new THREE.Vector2(
        (-sun.x / Math.max(0.15, sun.y)) * (CLOUD_LAYERS[0].height / CLOUD_TILE_METRES),
        (sun.z / Math.max(0.15, sun.y)) * (CLOUD_LAYERS[0].height / CLOUD_TILE_METRES)
    );
    /** @type {CloudShadow} */
    const cloudShadow = {
        texture: cloudTexture,
        offset: new THREE.Vector2().copy(sunShift),
        strength: night ? 0 : look.cloudShadow,
        tileMetres: CLOUD_TILE_METRES,
        uniforms: {
            tCloud: { value: cloudTexture },
            uCloudOffset: { value: null },
            uCloudStrength: { value: night ? 0 : look.cloudShadow },
            uCloudTile: { value: CLOUD_TILE_METRES },
        },
    };
    cloudShadow.uniforms.uCloudOffset.value = cloudShadow.offset;

    // ── Обекти по небето ─────────────────────────────────────────────────────
    const group = new THREE.Group();
    group.name = 'atmosphere';
    scene.add(group);

    /** @type {THREE.Sprite|null} */
    let sunSprite = null;
    if (preset.sunSprite > 0) {
        // Умерен HDR цвят: дискът остава ярък, но не залива половината кадър
        // с bloom. Без composer текстурата сама носи мекото сияние.
        const material = new THREE.SpriteMaterial({
            map: makeSunTexture(),
            color: sunColor.clone().multiplyScalar((bloom ? 1.7 : 1.45) * preset.sunSprite),
            blending: THREE.AdditiveBlending,
            transparent: true,
            depthTest: true,
            depthWrite: false,
            fog: false,
            sizeAttenuation: false,
        });
        sunSprite = new THREE.Sprite(material);
        sunSprite.name = 'sun';
        sunSprite.scale.set(0.14, 0.14, 1);
        sunSprite.frustumCulled = false;
        group.add(sunSprite);
    }

    /** @type {THREE.Sprite|null} */
    let moon = null;
    const moonDir = new THREE.Vector3();
    if (night) {
        // Срещу прожекторите (иначе би стояла в светлината им), 38° над хоризонта.
        const azimuth = Math.atan2(-sun.x, -sun.z) + THREE.MathUtils.degToRad(25);
        const elevation = THREE.MathUtils.degToRad(38);
        moonDir.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
        const material = new THREE.SpriteMaterial({
            map: makeMoonTexture(),
            color: new THREE.Color(0xd8e0ff).multiplyScalar(1.6),
            blending: THREE.AdditiveBlending,
            transparent: true,
            depthTest: true,
            depthWrite: false,
            fog: false,
            sizeAttenuation: false,
        });
        moon = new THREE.Sprite(material);
        moon.name = 'moon';
        moon.scale.set(0.07, 0.07, 1);
        moon.frustumCulled = false;
        group.add(moon);
    }

    // Облаци: две пелени (паралакс) на десктоп, една на телефон — прозрачен
    // overdraw върху ~40% от екрана е това, което tile GPU-то не прощава.
    const layers = lowPower ? CLOUD_LAYERS.slice(0, 1) : CLOUD_LAYERS;
    const sheets = layers.map((layer) => {
        // Клонинг = собствен offset/repeat, същият GPU upload (общ Source).
        const map = cloudTexture.clone();
        map.repeat.set(layer.repeat, layer.repeat);
        const material = new THREE.MeshBasicMaterial({
            map,
            color: preset.cloudTint,
            transparent: true,
            opacity: preset.cloudOpacity * (lowPower ? 1.2 : 1),
            depthWrite: false,
            fog: false,
            vertexColors: true,
            side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(makeCloudSheetGeometry(20), material);
        mesh.name = `clouds-${layer.height}`;
        mesh.frustumCulled = false;
        // Прозрачните се сортират по дълбочина на обекта: звездите на Game.js
        // седят В камерата (дълбочина 0) и биха се рисували върху облаците.
        // renderOrder 1 праща пелените след всички обикновени прозрачни —
        // облаците закриват звезди, луна и слънчев диск, както трябва.
        mesh.renderOrder = 1;
        group.add(mesh);

        return { mesh, map, layer };
    });

    // ── Hemisphere ───────────────────────────────────────────────────────────
    const hemisphereColours = {
        sky: new THREE.Color(preset.hemisphereSky ?? 0xffffff),
        ground: new THREE.Color(preset.hemisphereGround ?? circuit.terrain.base),
        intensity: preset.hemisphere,
    };

    const sunFog = new THREE.Color();
    const white = new THREE.Color(0xffffff);
    const cloudTint = new THREE.Color(preset.cloudTint);

    /**
     * Прилага текущите хоризонт/зенит към мъглата, fill-а и fog.color.
     */
    function applySky() {
        const h = state.horizon;
        const z = state.zenith;
        u.uFogHorizon.value.x = h.r;
        u.uFogHorizon.value.y = h.g;
        u.uFogHorizon.value.z = h.b;
        u.uFogZenith.value.x = z.r;
        u.uFogZenith.value.y = z.g;
        u.uFogZenith.value.z = z.b;
        // Сиянието: хоризонтът, изтеглен към цвета на слънцето и по-ярък —
        // мъглата срещу слънцето свети, не просто пожълтява.
        sunFog.copy(h).lerp(sunColor, 0.42).multiplyScalar(0.98);
        u.uFogSunColor.value.x = sunFog.r;
        u.uFogSunColor.value.y = sunFog.g;
        u.uFogSunColor.value.z = sunFog.b;
        if (scene.fog) {
            scene.fog.color.copy(h);
        }
        if (preset.hemisphereSky === undefined) {
            hemisphereColours.sky.copy(h).lerp(z, 0.4).lerp(white, 0.15);
        }
        if (hemisphere) {
            hemisphere.color.copy(hemisphereColours.sky);
            hemisphere.groundColor.copy(hemisphereColours.ground);
            hemisphere.intensity = hemisphereColours.intensity;
        }
        // Облаците са осветени колкото небето (HDR): при небе с яркост 2.0
        // пелена с цвят 1.0 е само сив размазан отпечатък. Тонът на preset-а
        // остава, яркостта следва семплирания хоризонт; текстурата потъмнява
        // ядрата под това ниво.
        const clouds = state.skyMode !== 'hdri';
        const skyLuma = h.r * 0.2126 + h.g * 0.7152 + h.b * 0.0722;
        for (const sheet of sheets) {
            sheet.mesh.visible = clouds;
            sheet.mesh.material.color.copy(cloudTint).multiplyScalar(Math.max(1, skyLuma * 1.15));
        }
    }

    /**
     * Семплира показаното небе: хоризонтът (2–7° елевация) и зенитната лента
     * (30–40°) — от HDRI данните (CPU) или от процедурния куб (GPU readback).
     * Авторската fogColor дава (1 − horizonMix) от оттенъка — тя носи характера
     * (Спа хладна, Монца топла); небето дава яркостта, така че ръбът на
     * терена изчезва в него.
     *
     * @param {{hdr?: THREE.DataTexture|null, cubeRT?: THREE.WebGLCubeRenderTarget|null}} source
     * @returns {boolean} Дали е имало какво да се семплира
     */
    function sampleSky({ hdr = null, cubeRT: cube = null } = {}) {
        let horizon = null;
        let zenith = null;
        if (hdr?.image?.data) {
            horizon = averageEquirectBand(hdr, HORIZON_ELEVATION[0], HORIZON_ELEVATION[1]);
            zenith = averageEquirectBand(hdr, ZENITH_ELEVATION[0], ZENITH_ELEVATION[1]);
            state.skyMode = 'hdri';
        } else if (cube?.isWebGLCubeRenderTarget) {
            horizon = averageCubeBand(renderer, cube, HORIZON_ELEVATION[0], HORIZON_ELEVATION[1]);
            zenith = averageCubeBand(renderer, cube, ZENITH_ELEVATION[0], ZENITH_ELEVATION[1]);
            state.skyMode = 'procedural';
        }
        if (horizon) {
            blendTint(state.horizon, horizon, authoredFog, 1 - fog.horizonMix);
        }
        if (zenith) {
            state.zenith.copy(zenith);
        }
        applySky();

        return horizon !== null;
    }

    /**
     * Закача (или сменя) fill светлината, която следва небето — Game я строи
     * след куба, т.е. след createAtmosphere; при HDRI се преоцветява пак.
     *
     * @param {THREE.HemisphereLight|null} light
     */
    function setHemisphere(light) {
        hemisphere = light;
        applySky();
    }

    if (cubeRT) {
        sampleSky({ cubeRT });
    } else {
        applySky();
    }

    const camXZ = new THREE.Vector2();

    /**
     * @param {number} dt
     * @param {THREE.Vector3} cameraPosition
     * @param {boolean} [inTunnel] Експозиционна адаптация (Монако)
     */
    function update(dt, cameraPosition, inTunnel = false) {
        if (sunSprite) {
            sunSprite.position.copy(cameraPosition).addScaledVector(sun, SUN_DISTANCE);
        }
        if (moon) {
            moon.position.copy(cameraPosition).addScaledVector(moonDir, MOON_DISTANCE);
        }

        // Облаците се носят С вятъра: шарката, закотвена на uv = P/tile + drift,
        // се мести с +W метра, когато drift.x намалее с W/tile (v е с обърнат
        // знак заради ротацията на пелената: локалното y е световното −z).
        const step = (look.clouds.speed * dt) / CLOUD_TILE_METRES;
        drift.x -= wind.x * step;
        drift.y += wind.z * step;
        cloudShadow.offset.copy(drift).add(sunShift);

        camXZ.set(cameraPosition.x, cameraPosition.z);
        for (const { mesh, map, layer } of sheets) {
            mesh.position.set(cameraPosition.x, cameraPosition.y + layer.height, cameraPosition.z);
            map.offset.set(
                (camXZ.x * layer.repeat) / CLOUD_SHEET_SIZE + drift.x * layer.driftScale + layer.uvBase[0],
                (-camXZ.y * layer.repeat) / CLOUD_SHEET_SIZE + drift.y * layer.driftScale + layer.uvBase[1]
            );
        }

        // Тунел: „окото" се стеснява вътре, при излизане прегаря за 0.4 s и
        // се успокоява — клишето на изхода от тунела на Монако.
        if (state.wasInTunnel && !inTunnel) {
            state.overshoot = 0.25;
        }
        state.wasInTunnel = inTunnel;
        state.overshoot = Math.max(0, state.overshoot - dt);
        const target = state.exposureBase * (inTunnel ? 0.62 : state.overshoot > 0 ? 1.12 : 1);
        state.exposure += (target - state.exposure) * (1 - Math.exp(-1.8 * dt));
        renderer.toneMappingExposure = state.exposure;
    }

    function dispose() {
        scene.remove(group);
        for (const { mesh, map } of sheets) {
            mesh.geometry.dispose();
            mesh.material.dispose();
            map.dispose();
        }
        cloudTexture.dispose();
        if (sunSprite) {
            sunSprite.material.map.dispose();
            sunSprite.material.dispose();
        }
        if (moon) {
            moon.material.map.dispose();
            moon.material.dispose();
        }
        // Мъглата остава със стойностите на пистата до следващата игра — без
        // атмосфера сцена няма, а нулиране би трепнало кадъра при dispose.
        renderer.toneMappingExposure = state.exposureOriginal;
    }

    return {
        look,
        preset: look.preset,
        night,
        skyMode: () => state.skyMode,
        sunDir: sun,
        sunColor,
        sunIntensity: atmosphere.sunIntensity,
        moonDir: night ? moonDir : null,
        fogUniforms: FOG_UNIFORMS,
        horizon: state.horizon,
        zenith: state.zenith,
        hemisphere: hemisphereColours,
        wind,
        cloudShadow,
        cloudTexture,
        group,
        sunSprite,
        moon,
        sampleSky,
        setHemisphere,
        update,
        dispose,
    };
}
