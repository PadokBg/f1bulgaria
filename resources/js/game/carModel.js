/**
 * Външният GLB болид (public/game-models/car.glb): зареждане с кеш, runtime
 * разделяне на колелата, hero материали и дребните добавки (blur дискове,
 * шлем, ръце, ливрея на съперник, холограма на духа).
 *
 * ЗАЩО runtime split: пакетираният файл има 3 нода — тяло + по ЕДИН меш за
 * предната и задната ДВОЙКА колела (позициите на двете гуми са запечени във
 * върховете, x ≈ ±0.89 m). За да се въртят и завиват поотделно, всяка двойка
 * се реже по знака на X на центроида на триъгълника и всяка половина се
 * центрира в собствената си главина. Прави се ВЕДНЪЖ на страница (шаблонът
 * се кешира), клонингите (съперници, дух) споделят геометрията.
 *
 * ЗАЩО кеш на ниво модул: всяка писта е нова Game инстанция (нов WebGL
 * контекст); GPU качването е неизбежно, но 4 MB изтегляне + meshopt
 * декодиране + split + маски (~200 ms) се плащат само първия път. Game.dispose
 * може да dispose-не споделените геометрии/текстури — three ги качва наново
 * при следваща употреба (CPU данните остават), така че кешът надживява играта.
 *
 * Модулът не пипа window/document при зареждане (селфтестове в Node).
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { applyPatch } from './materialPatch.js';

const MODEL_URL = '/game-models/car.glb';

/** Дължина по Z — колкото процедурния болид, за да пасне на физиката/пистата. */
const MODEL_TARGET_LENGTH = 4.6;

/** Имената на нодовете в пакетирания GLB (проверени по JSON чънка на файла). */
const NODE_BODY = 'appliances_appliances_0';
const NODE_FRONT_PAIR = 'frontWheel_L_frontWheel_0';
const NODE_REAR_PAIR = 'rearWheel_L_rearWheel_0';

/** Под този дял триъгълници в едната половина split-ът се смята за провален. */
const SPLIT_MIN_SHARE = 0.3;

/** Резолюция на маските, извлечени от 2048² ливреята. */
const MASK_SIZE = 512;

/** Джантата е ~74 % от радиуса на гумата (18" джанта / 720 mm гума). */
const RIM_RADIUS_RATIO = 0.74;

/** Цвят на blur диска, ако атласът не даде смислена средна стойност. */
const RIM_COLOR_FALLBACK = 0x8a8d93;

/**
 * @typedef {object} WheelTemplate
 * @property {'front'|'rear'} axle
 * @property {-1|1} side          Знак на X на главината
 * @property {THREE.BufferGeometry} geometry  Центрирана в главината, ос по X
 * @property {{x: number, y: number, z: number}} hub  Главина в риг пространство
 * @property {number} radius
 * @property {number} width
 * @property {boolean} split      false = двойката не можа да се раздели (обща геометрия)
 */

/**
 * @typedef {object} CarTemplate
 * @property {THREE.BufferGeometry} bodyGeometry   Запечена в риг пространство (+Z напред, стъпила на y=0)
 * @property {THREE.MeshStandardMaterial} bodyMaterial   Оригиналът от GLTF (не се рендира; клонира се)
 * @property {WheelTemplate[]} wheels
 * @property {{front: THREE.MeshStandardMaterial, rear: THREE.MeshStandardMaterial}} wheelMaterials
 * @property {{front: THREE.Color, rear: THREE.Color}} rimColors
 * @property {{maskA: THREE.DataTexture, maskB: THREE.DataTexture, paintLuma: number}|null} masks
 * @property {THREE.Box3} bounds   Общ bbox в риг пространство
 * @property {{front: Axle, rear: Axle}} axles
 */

/**
 * @typedef {object} Axle
 * @property {number} x       |x| на главината
 * @property {number} y       Височина на главината (= радиус, стъпила гума)
 * @property {number} z
 * @property {number} radius
 */

/** @type {Promise<CarTemplate|null>|null} */
let cachedTemplate = null;

/** @type {Array<(fraction: number) => void>} */
let progressListeners = [];

/**
 * Зарежда и подготвя шаблона на болида — веднъж на страница. Никога не
 * reject-ва: при липсващ/счупен файл резолвва null (остава процедурният).
 * Неуспехът НЕ се кешира, за да може следващата игра да опита отново.
 *
 * @param {(fraction: number) => void} [onProgress]
 * @returns {Promise<CarTemplate|null>}
 */
export function loadCarTemplate(onProgress) {
    if (cachedTemplate) {
        // Кеш (или изтегляне в ход): прогресът е 1 веднага щом шаблонът е
        // готов; слушателят не влиза в progressListeners — списъкът се чисти
        // само от callback-ите на loader-а, които вече са минали.
        cachedTemplate.then((template) => {
            if (template) {
                onProgress?.(1);
            }
        });

        return cachedTemplate;
    }
    if (onProgress) {
        progressListeners.push(onProgress);
    }

    cachedTemplate = new Promise((resolve) => {
        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        loader.load(
            MODEL_URL,
            (gltf) => {
                let template = null;
                try {
                    template = prepareCarTemplate(gltf.scene);
                } catch {
                    template = null;
                }
                if (template === null) {
                    cachedTemplate = null;
                }
                const listeners = progressListeners;
                progressListeners = [];
                for (const listener of listeners) {
                    listener(1);
                }
                resolve(template);
            },
            (xhr) => {
                // Прогрес по реалните байтове; без Content-Length — груба оценка.
                const fraction =
                    xhr.total > 0 ? Math.min(1, xhr.loaded / xhr.total) : Math.min(0.95, xhr.loaded / 7_000_000);
                for (const listener of progressListeners) {
                    listener(fraction);
                }
            },
            () => {
                cachedTemplate = null;
                progressListeners = [];
                resolve(null);
            }
        );
    });

    return cachedTemplate;
}

/**
 * Запича трансформациите на нодовете в геометрията (риг пространство:
 * +Z напред, центрирано по X/Z, стъпило на y = 0, дължина
 * MODEL_TARGET_LENGTH), реже двойките колела и извлича маските.
 *
 * @param {THREE.Object3D} scene
 * @returns {CarTemplate|null}
 */
export function prepareCarTemplate(scene) {
    scene.updateMatrixWorld(true);
    const body = scene.getObjectByName(NODE_BODY);
    const frontPair = scene.getObjectByName(NODE_FRONT_PAIR);
    const rearPair = scene.getObjectByName(NODE_REAR_PAIR);
    if (!body?.isMesh || !frontPair?.isMesh || !rearPair?.isMesh) {
        return null;
    }

    // Пас 1: световните матрици на нодовете + мащабът към целевата дължина.
    const bodyGeometry = bakeGeometry(body.geometry, body.matrixWorld);
    const frontGeometry = bakeGeometry(frontPair.geometry, frontPair.matrixWorld);
    const rearGeometry = bakeGeometry(rearPair.geometry, rearPair.matrixWorld);
    const raw = [bodyGeometry, frontGeometry, rearGeometry];

    const bounds = new THREE.Box3();
    for (const geometry of raw) {
        geometry.computeBoundingBox();
        bounds.union(geometry.boundingBox);
    }
    const size = new THREE.Vector3();
    bounds.getSize(size);
    const scale = MODEL_TARGET_LENGTH / (size.z || size.x || 1);

    // Пас 2: центриране по X/Z и стъпване на земята СЛЕД мащаба.
    const center = new THREE.Vector3();
    bounds.getCenter(center);
    const normalize = new THREE.Matrix4()
        .makeTranslation(-center.x * scale, -bounds.min.y * scale, -center.z * scale)
        .multiply(new THREE.Matrix4().makeScale(scale, scale, scale));
    for (const geometry of raw) {
        geometry.applyMatrix4(normalize);
        geometry.computeBoundingBox();
    }

    // Неразделена двойка (split: false) остава един меш на ос, центриран в
    // средата ѝ, който се търкаля общо и не завива.
    const wheels = [...splitWheelPair(frontGeometry, 'front'), ...splitWheelPair(rearGeometry, 'rear')];

    // Споделени между всички клонинги (играч, съперници, дух) и между игрите:
    // Game.dispose/#clearOpponents не бива да ги dispose-ват.
    bodyGeometry.userData.shared = true;
    for (const wheel of wheels) {
        wheel.geometry.userData.shared = true;
    }

    const finalBounds = new THREE.Box3().copy(bodyGeometry.boundingBox);
    for (const wheel of wheels) {
        const box = wheel.geometry.boundingBox.clone().translate(new THREE.Vector3(wheel.hub.x, wheel.hub.y, wheel.hub.z));
        finalBounds.union(box);
    }

    const bodyMaterial = firstMaterial(body.material);
    const frontMaterial = firstMaterial(frontPair.material);
    const rearMaterial = firstMaterial(rearPair.material);

    // Оригиналните (quantized) геометрии вече не трябват — половините и
    // запеченото тяло ги заместват. Освобождаваме GPU-то да не ги качва.
    body.geometry.dispose();
    frontPair.geometry.dispose();
    rearPair.geometry.dispose();

    return {
        bodyGeometry,
        bodyMaterial,
        wheels,
        wheelMaterials: { front: frontMaterial, rear: rearMaterial },
        rimColors: {
            front: averageRimColor(frontMaterial.map),
            rear: averageRimColor(rearMaterial.map),
        },
        masks: deriveCarMasks(bodyMaterial.map),
        bounds: finalBounds,
        axles: measureAxles(wheels),
    };
}

/**
 * Копира геометрията във Float32 атрибути (quantized Int16/Int8 от
 * KHR_mesh_quantization не могат да поемат мащаб > 1) и прилага матрица.
 *
 * @param {THREE.BufferGeometry} source
 * @param {THREE.Matrix4} matrix
 * @returns {THREE.BufferGeometry}
 */
function bakeGeometry(source, matrix) {
    const geometry = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv']) {
        const attribute = source.getAttribute(name);
        if (attribute) {
            geometry.setAttribute(name, toFloatAttribute(attribute));
        }
    }
    if (source.index) {
        geometry.setIndex(source.index.clone());
    }
    if (!geometry.getAttribute('normal')) {
        geometry.computeVertexNormals();
    }
    geometry.applyMatrix4(matrix);

    return geometry;
}

/**
 * @param {THREE.BufferAttribute|THREE.InterleavedBufferAttribute} attribute
 * @returns {THREE.BufferAttribute}
 */
function toFloatAttribute(attribute) {
    const itemSize = attribute.itemSize;
    const array = new Float32Array(attribute.count * itemSize);
    for (let i = 0; i < attribute.count; i++) {
        for (let c = 0; c < itemSize; c++) {
            // getComponent денормализира quantized стойностите.
            array[i * itemSize + c] = attribute.getComponent(i, c);
        }
    }

    return new THREE.BufferAttribute(array, itemSize);
}

/**
 * Реже двойка колела по знака на X на центроида на всеки триъгълник (никога
 * по връх — триъгълник през x = 0 би се разкъсал). При провал (едната
 * половина под 30 %) връща ЕДИН запис с общата геометрия и split: false.
 *
 * @param {THREE.BufferGeometry} pair   Запечена в риг пространство
 * @param {'front'|'rear'} axle
 * @returns {WheelTemplate[]}
 */
export function splitWheelPair(pair, axle) {
    const position = pair.getAttribute('position');
    const index = pair.index;
    const triangleCount = index ? index.count / 3 : position.count / 3;
    const sideOf = new Int8Array(triangleCount);
    let negative = 0;

    for (let t = 0; t < triangleCount; t++) {
        const a = index ? index.getX(t * 3) : t * 3;
        const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        const cx = position.getX(a) + position.getX(b) + position.getX(c);
        sideOf[t] = cx < 0 ? -1 : 1;
        if (cx < 0) {
            negative++;
        }
    }

    const share = Math.min(negative, triangleCount - negative) / triangleCount;
    if (share < SPLIT_MIN_SHARE) {
        pair.computeBoundingBox();
        const hub = new THREE.Vector3();
        pair.boundingBox.getCenter(hub);
        pair.translate(-hub.x, -hub.y, -hub.z);
        pair.computeBoundingBox();
        const size = new THREE.Vector3();
        pair.boundingBox.getSize(size);

        return [{ axle, side: 1, geometry: pair, hub, radius: size.y / 2, width: size.x, split: false }];
    }

    const halves = [-1, 1].map((side) => {
        const geometry = extractTriangles(pair, sideOf, side);
        geometry.computeBoundingBox();
        const hub = new THREE.Vector3();
        geometry.boundingBox.getCenter(hub);
        geometry.translate(-hub.x, -hub.y, -hub.z);
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        const size = new THREE.Vector3();
        geometry.boundingBox.getSize(size);

        return { axle, side, geometry, hub, radius: size.y / 2, width: size.x, split: true };
    });
    pair.dispose();

    return halves;
}

/**
 * Нова индексирана геометрия само от триъгълниците с дадения знак; върховете
 * се преномерират компактно (без toNonIndexed — три пъти повече върхове).
 *
 * @param {THREE.BufferGeometry} source
 * @param {Int8Array} sideOf
 * @param {-1|1} side
 * @returns {THREE.BufferGeometry}
 */
function extractTriangles(source, sideOf, side) {
    const index = source.index;
    const vertexCount = source.getAttribute('position').count;
    const remap = new Int32Array(vertexCount).fill(-1);
    const order = [];
    const newIndex = [];

    for (let t = 0; t < sideOf.length; t++) {
        if (sideOf[t] !== side) {
            continue;
        }
        for (let k = 0; k < 3; k++) {
            const v = index ? index.getX(t * 3 + k) : t * 3 + k;
            if (remap[v] < 0) {
                remap[v] = order.length;
                order.push(v);
            }
            newIndex.push(remap[v]);
        }
    }

    const geometry = new THREE.BufferGeometry();
    for (const name of Object.keys(source.attributes)) {
        const attribute = source.getAttribute(name);
        const itemSize = attribute.itemSize;
        const array = new Float32Array(order.length * itemSize);
        for (let i = 0; i < order.length; i++) {
            for (let c = 0; c < itemSize; c++) {
                array[i * itemSize + c] = attribute.getComponent(order[i], c);
            }
        }
        geometry.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
    }
    geometry.setIndex(order.length > 65535 ? new THREE.Uint32BufferAttribute(newIndex, 1) : new THREE.Uint16BufferAttribute(newIndex, 1));

    return geometry;
}

/**
 * @param {WheelTemplate[]} wheels
 * @returns {{front: Axle, rear: Axle}}
 */
function measureAxles(wheels) {
    const axles = {};
    for (const axle of ['front', 'rear']) {
        const set = wheels.filter((wheel) => wheel.axle === axle);
        const split = set.every((wheel) => wheel.split);
        // Неразделена двойка: главината е на ~80 % от външния ръб (гума ~0.3 m).
        const x = split
            ? set.reduce((sum, wheel) => sum + Math.abs(wheel.hub.x), 0) / set.length
            : (set[0].width / 2) * 0.8;
        axles[axle] = {
            x,
            y: set.reduce((sum, wheel) => sum + wheel.hub.y, 0) / set.length,
            z: set.reduce((sum, wheel) => sum + wheel.hub.z, 0) / set.length,
            radius: set.reduce((sum, wheel) => sum + wheel.radius, 0) / set.length,
        };
    }

    return axles;
}

/**
 * @param {THREE.Material|THREE.Material[]} material
 * @returns {THREE.MeshStandardMaterial}
 */
function firstMaterial(material) {
    return Array.isArray(material) ? material[0] : material;
}

// ── Маски и цветове от текстурите ────────────────────────────────────────

/**
 * Рисува изображението на текстурата в offscreen canvas и връща пикселите.
 * null, ако средата няма canvas (Node) или картината не е рисуема.
 *
 * @param {THREE.Texture|null} texture
 * @param {number} size
 * @returns {ImageData|null}
 */
function readTexturePixels(texture, size) {
    const image = texture?.image;
    if (!image || typeof document === 'undefined') {
        return null;
    }
    try {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0, size, size);

        return context.getImageData(0, 0, size, size);
    } catch {
        return null;
    }
}

/**
 * Маски за боята от базовия цвят на ливреята: наситените пиксели са боя (под
 * лак), светлите ненаситени — спонсорски надписи (също под лака), тъмните
 * ненаситени — карбон (мат). Записва две текстури, защото three чете
 * roughnessMap от .g И clearcoatRoughnessMap също от .y — не могат да делят
 * една карта с различни стойности.
 *
 *   maskA (RGBA): R = clearcoat, G = roughness, B = маска „боя" (за ливреята на
 *                 съперниците), A = 255
 *   maskB (RG):   G = clearcoatRoughness
 *
 * @param {THREE.Texture|null} baseColor
 * @returns {{maskA: THREE.DataTexture, maskB: THREE.DataTexture, paintLuma: number}|null}
 */
export function deriveCarMasks(baseColor) {
    const pixels = readTexturePixels(baseColor, MASK_SIZE);
    if (!pixels) {
        return null;
    }
    const count = MASK_SIZE * MASK_SIZE;
    const dataA = new Uint8Array(count * 4);
    const dataB = new Uint8Array(count * 2);
    let paintLumaSum = 0;
    let paintWeight = 0;

    for (let i = 0; i < count; i++) {
        const r = pixels.data[i * 4] / 255;
        const g = pixels.data[i * 4 + 1] / 255;
        const b = pixels.data[i * 4 + 2] / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const lightness = (max + min) / 2;
        const chroma = max - min;
        const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1));
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

        // Тъмносиният карбон също е наситен: яркостта го отделя от боята.
        const paint = smoothstep(0.35, 0.55, saturation) * smoothstep(0.18, 0.36, max);
        const white = (1 - paint) * smoothstep(0.6, 0.8, luma);
        const gloss = Math.max(paint, white);

        dataA[i * 4] = Math.round(lerp(0.08, 0.72, gloss) * 255);
        dataA[i * 4 + 1] = Math.round(lerp(0.72, 0.38, gloss) * 255);
        dataA[i * 4 + 2] = Math.round(paint * 255);
        dataA[i * 4 + 3] = 255;
        dataB[i * 2] = 0;
        dataB[i * 2 + 1] = Math.round(lerp(0.42, 0.2, gloss) * 255);

        paintLumaSum += luma * paint;
        paintWeight += paint;
    }

    const maskA = new THREE.DataTexture(dataA, MASK_SIZE, MASK_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
    const maskB = new THREE.DataTexture(dataB, MASK_SIZE, MASK_SIZE, THREE.RGFormat, THREE.UnsignedByteType);
    for (const texture of [maskA, maskB]) {
        // Същата ориентация като картата от GLTF (flipY false) — UV-тата съвпадат.
        texture.flipY = baseColor.flipY;
        texture.wrapS = baseColor.wrapS;
        texture.wrapT = baseColor.wrapT;
        texture.magFilter = THREE.LinearFilter;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.generateMipmaps = true;
        texture.needsUpdate = true;
    }
    maskA.name = 'car-mask-a';
    maskB.name = 'car-mask-b';

    return { maskA, maskB, paintLuma: paintWeight > 0 ? paintLumaSum / paintWeight : 0.2 };
}

/**
 * Средният цвят на светлите (луминанс > 0.35) пиксели на атласа на колелото —
 * джантата; гумата е почти черна и не влиза. Върху 128² смалено копие.
 *
 * @param {THREE.Texture|null} atlas
 * @returns {THREE.Color}
 */
function averageRimColor(atlas) {
    const pixels = readTexturePixels(atlas, 128);
    const color = new THREE.Color(RIM_COLOR_FALLBACK);
    if (!pixels) {
        return color;
    }
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < 128 * 128; i++) {
        const pr = pixels.data[i * 4] / 255;
        const pg = pixels.data[i * 4 + 1] / 255;
        const pb = pixels.data[i * 4 + 2] / 255;
        if (0.2126 * pr + 0.7152 * pg + 0.0722 * pb > 0.35) {
            r += pr;
            g += pg;
            b += pb;
            n++;
        }
    }
    if (n < 64) {
        return color;
    }
    // Атласът е sRGB; Color.setRGB с SRGBColorSpace го линеаризира.
    return color.setRGB(r / n, g / n, b / n, THREE.SRGBColorSpace);
}

// ── Материали ────────────────────────────────────────────────────────────

/**
 * Боя с истински лак: MeshPhysical върху ливреята с маски за roughness /
 * clearcoat. Явен envMap (иначе three r180 игнорира envMapIntensity на
 * материала и колата отразява със scene.environmentIntensity).
 *
 * Слабо метална база и мек лак: червеното остава наситено, а отражението
 * подчертава формата, без да превръща карбона и крилата в огледала.
 *
 * @param {CarTemplate} template
 * @param {{environment?: THREE.Texture|null, environmentRotation?: THREE.Euler|null, maxAniso?: number, lowPower?: boolean}} options
 * @returns {THREE.MeshPhysicalMaterial}
 */
export function makePaintMaterial(template, options = {}) {
    const source = template.bodyMaterial;
    const material = new THREE.MeshPhysicalMaterial({
        name: 'car-paint',
        map: source.map ?? null,
        color: source.color.clone(),
        side: THREE.FrontSide,
    });
    if (material.map && options.maxAniso) {
        material.map.anisotropy = options.maxAniso;
    }
    material.metalness = 0.08;
    material.ior = 1.5;
    material.specularIntensity = 1;
    material.envMap = options.environment ?? null;
    if (options.environmentRotation) {
        // При явен envMap three ползва envMapRotation на МАТЕРИАЛА, не на сцената.
        material.envMapRotation.copy(options.environmentRotation);
    }
    material.userData.ownEnv = true;

    if (template.masks && !options.lowPower) {
        material.roughness = 1; // × maskA.g
        material.roughnessMap = template.masks.maskA;
        material.clearcoat = 1; // × maskA.r
        material.clearcoatMap = template.masks.maskA;
        material.clearcoatRoughness = 1; // × maskB.g
        material.clearcoatRoughnessMap = template.masks.maskB;
        material.envMapIntensity = 0.85;
    } else {
        // Телефон/без маски: класификация от вече прочетения базов цвят,
        // преди ливреята/замърсяването. Без нови текстури или texture fetch.
        material.roughness = 0.38;
        material.clearcoat = 0.72;
        material.clearcoatRoughness = 0.2;
        material.envMapIntensity = 0.85;
        applyPatch(material, {
            name: 'paint-finish',
            replace: [
                [
                    'map_fragment',
                    /* glsl */ `#include <map_fragment>
                    float carMax = max(max(diffuseColor.r, diffuseColor.g), diffuseColor.b);
                    float carMin = min(min(diffuseColor.r, diffuseColor.g), diffuseColor.b);
                    float carChroma = (carMax - carMin) / max(carMax, 0.001);
                    // Цветът тук е линеен: тъмносиният карбон е под 0.035.
                    float carPaintGloss = max(
                        smoothstep(0.35, 0.65, carChroma) * smoothstep(0.035, 0.11, carMax),
                        smoothstep(0.3, 0.65, carMin)
                    );`,
                ],
                [
                    'roughnessmap_fragment',
                    /* glsl */ `#include <roughnessmap_fragment>
                    roughnessFactor = mix(0.72, roughnessFactor, carPaintGloss);`,
                ],
                [
                    'lights_physical_fragment',
                    /* glsl */ `#include <lights_physical_fragment>
                    #ifdef USE_CLEARCOAT
                        material.clearcoat *= mix(0.11, 1.0, carPaintGloss);
                        material.clearcoatRoughness = max(material.clearcoatRoughness, mix(0.42, 0.2, carPaintGloss));
                    #endif`,
                ],
            ],
        });
    }

    return material;
}

/**
 * Гумите + джантите делят атлас и draw call, но имат различен финиш:
 * матов борд, сатенена контактна повърхност и метална джанта. Маската е по
 * радиуса в локалната геометрия, така че надписите върху борда не стават
 * метални. Без измерена ос остава общият резервен материал.
 *
 * @param {THREE.MeshStandardMaterial} source
 * @param {{environment?: THREE.Texture|null, environmentRotation?: THREE.Euler|null, maxAniso?: number, radius?: number, lowPower?: boolean}} options
 * @returns {THREE.MeshStandardMaterial}
 */
export function makeWheelMaterial(source, options = {}) {
    const material = new THREE.MeshStandardMaterial({
        name: 'car-wheel',
        map: source.map ?? null,
        color: source.color.clone(),
        side: THREE.FrontSide,
        roughness: 0.7,
        metalness: 0.15,
    });
    if (material.map && options.maxAniso) {
        material.map.anisotropy = Math.min(4, options.maxAniso);
    }
    material.envMap = options.environment ?? null;
    if (options.environmentRotation) {
        material.envMapRotation.copy(options.environmentRotation);
    }
    material.envMapIntensity = 0.8;

    if (Number.isFinite(options.radius) && options.radius > 0 && !options.lowPower) {
        applyPatch(material, {
            name: 'wheel-finish',
            uniforms: { uWheelRadius: { value: options.radius } },
            vertexHead: 'varying vec3 vWheelLocal;',
            vertexMain: 'vWheelLocal = position;',
            fragmentHead: /* glsl */ `
                uniform float uWheelRadius;
                varying vec3 vWheelLocal;`,
            replace: [
                [
                    'color_fragment',
                    /* glsl */ `#include <color_fragment>
                    float wheelRadial = length(vWheelLocal.yz) / uWheelRadius;
                    float wheelRim = 1.0 - smoothstep(${RIM_RADIUS_RATIO - 0.04}, ${RIM_RADIUS_RATIO + 0.02}, wheelRadial);
                    float wheelTread = smoothstep(0.91, 0.98, wheelRadial);
                    // Фини следи по слика; производните гасят детайла под пиксел.
                    float wheelScuffPhase = vWheelLocal.x * 720.0;
                    float wheelScuffFade = (1.0 - smoothstep(0.5, 2.0, fwidth(wheelScuffPhase)))
                        * (1.0 - smoothstep(8.0, 24.0, length(vViewPosition)));
                    float wheelScuff = sin(wheelScuffPhase + sin(vWheelLocal.z * 34.0)) * wheelScuffFade * wheelTread;
                    diffuseColor.rgb *= 1.0 + 0.035 * wheelScuff;`,
                ],
                [
                    'roughnessmap_fragment',
                    /* glsl */ `#include <roughnessmap_fragment>
                    roughnessFactor = mix(mix(0.82, 0.61, wheelTread), 0.32, wheelRim);
                    roughnessFactor += 0.025 * wheelScuff;`,
                ],
                [
                    'metalnessmap_fragment',
                    /* glsl */ `#include <metalnessmap_fragment>
                    metalnessFactor = 0.88 * wheelRim;`,
                ],
            ],
        });
    }

    return material;
}

/**
 * Ливрея на съперник: наситените (боя) пиксели се оцветяват в uLivery, като
 * се пази сенчестото им разпределение (luma / средна luma на боята). Така
 * работят и цветове, недостижими с hue-rotate от червено (сребро, бяло).
 * Кръпката се прилага върху клониран материал (клонингите не носят кръпки).
 *
 * @param {THREE.MeshPhysicalMaterial} material
 * @param {CarTemplate} template
 * @param {number|THREE.Color} color
 * @returns {{uLivery: {value: THREE.Color}}}
 */
export function applyLiveryPatch(material, template, color) {
    const uniforms = {
        uLivery: { value: new THREE.Color(color) },
        uPaintLuma: { value: template.masks?.paintLuma ?? 0.2 },
        tLiveryMask: { value: template.masks?.maskA ?? null },
    };
    if (!template.masks) {
        // Без маска: цялата карта се тонира — по-грубо, но различимо.
        applyPatch(material, {
            name: 'livery',
            uniforms,
            fragmentHead: /* glsl */ `
                uniform vec3 uLivery;
                uniform float uPaintLuma;`,
            replace: [
                [
                    'color_fragment',
                    /* glsl */ `#include <color_fragment>
                    {
                        float l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
                        diffuseColor.rgb = uLivery * clamp(l / uPaintLuma, 0.0, 2.0);
                    }`,
                ],
            ],
        });

        return uniforms;
    }

    applyPatch(material, {
        name: 'livery',
        uniforms,
        fragmentHead: /* glsl */ `
            uniform vec3 uLivery;
            uniform float uPaintLuma;
            uniform sampler2D tLiveryMask;`,
        replace: [
            [
                'color_fragment',
                /* glsl */ `#include <color_fragment>
                {
                    float paintMask = texture2D(tLiveryMask, vMapUv).b;
                    float l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
                    vec3 tinted = uLivery * clamp(l / uPaintLuma, 0.0, 2.0);
                    diffuseColor.rgb = mix(diffuseColor.rgb, tinted, paintMask);
                }`,
            ],
        ],
    });

    return uniforms;
}

/**
 * Холограма за духа: френел ръб + сканлинии, адитивна, без запис в дълбочина.
 * Един материал за тяло + колела; тонът се сменя през uniform, не с нови
 * материали.
 *
 * @param {number|THREE.Color} tint
 * @returns {THREE.ShaderMaterial}
 */
export function makeHologramMaterial(tint) {
    return new THREE.ShaderMaterial({
        name: 'car-hologram',
        uniforms: {
            uTint: { value: new THREE.Color(tint) },
            uTime: { value: 0 },
        },
        vertexShader: /* glsl */ `
            varying vec3 vViewNormal;
            varying vec3 vViewPos;
            varying float vLocalY;
            void main() {
                vLocalY = position.y;
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                vViewNormal = normalize(normalMatrix * normal);
                vViewPos = mv.xyz;
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: /* glsl */ `
            uniform vec3 uTint;
            uniform float uTime;
            varying vec3 vViewNormal;
            varying vec3 vViewPos;
            varying float vLocalY;
            void main() {
                vec3 n = normalize(vViewNormal);
                vec3 v = normalize(-vViewPos);
                float fresnel = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 2.5);
                float scan = 0.8 + 0.2 * sin(vLocalY * 90.0 - uTime * 7.0);
                vec3 color = uTint * (0.22 + fresnel * 1.1) * scan;
                gl_FragColor = vec4(color, 0.16 + fresnel * 0.55);
                #include <colorspace_fragment>
            }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.FrontSide,
        fog: false,
        toneMapped: true,
    });
}

// ── Сглобяване на GLB кола за риг ────────────────────────────────────────

/**
 * @typedef {object} WheelRigEntry
 * @property {'front'|'rear'} axle
 * @property {-1|1} side
 * @property {THREE.Group} steer   Пивот на завиването (позициониран в главината; при задните стои на 0)
 * @property {THREE.Group} spin    Пивот на търкалянето (ос X)
 * @property {THREE.Mesh} mesh
 * @property {number} radius
 * @property {number} width
 * @property {THREE.Mesh[]} discs  Blur дискове (opacity се пише от updateCarRig)
 * @property {number} lockBlend    Вътрешно: 0..1 доколко колелото е блокирало
 * @property {boolean} [far]       Далечно LOD колело на съперник (без ефекти)
 */

/**
 * @typedef {object} GlbCar
 * @property {THREE.Group} model   Групата с тялото (под rig.body)
 * @property {THREE.Mesh} body
 * @property {WheelRigEntry[]} wheels   Пивотите (под rig.unsprung)
 * @property {THREE.Material[]} materials   Всички клонирани материали (боя + гуми)
 * @property {THREE.MeshPhysicalMaterial[]} paintMaterials
 * @property {THREE.MeshStandardMaterial[]} wheelMaterials
 * @property {{front: Axle, rear: Axle}} axles
 * @property {number} wheelRadius
 * @property {{front: number, rear: number}} tyreWidth
 */

/**
 * Инстанцира шаблона: споделена геометрия, собствени материали, пивоти за
 * всяко колело, blur дискове. Материалите са per-кола (съперниците се
 * тонират и изсветляват поотделно).
 *
 * @param {CarTemplate} template
 * @param {{environment?: THREE.Texture|null, environmentRotation?: THREE.Euler|null, maxAniso?: number, lowPower?: boolean, castShadow?: boolean, material?: THREE.Material}} options
 *   material — ако е зададен (холограма на духа), се ползва за ВСИЧКИ мешове
 * @returns {GlbCar}
 */
export function buildGlbCar(template, options = {}) {
    const castShadow = options.castShadow ?? true;
    const shared = options.material ?? null;
    const paint = shared ?? makePaintMaterial(template, options);
    const wheelMaterials = shared
        ? { front: shared, rear: shared }
        : {
              front: makeWheelMaterial(template.wheelMaterials.front, { ...options, radius: template.axles.front.radius }),
              rear: makeWheelMaterial(template.wheelMaterials.rear, { ...options, radius: template.axles.rear.radius }),
          };

    const model = new THREE.Group();
    model.name = 'car-glb';
    const body = new THREE.Mesh(template.bodyGeometry, paint);
    body.name = 'car-body';
    body.castShadow = castShadow;
    body.receiveShadow = true;
    model.add(body);

    const wheels = template.wheels.map((wheel) => {
        const steer = new THREE.Group();
        steer.name = `wheel-${wheel.axle}-${wheel.side < 0 ? 'l' : 'r'}`;
        steer.position.set(wheel.hub.x, wheel.hub.y, wheel.hub.z);
        const spin = new THREE.Group();
        steer.add(spin);
        const mesh = new THREE.Mesh(wheel.geometry, wheelMaterials[wheel.axle]);
        mesh.castShadow = castShadow;
        mesh.receiveShadow = true;
        spin.add(mesh);

        const discs = shared ? [] : buildBlurDiscs(wheel, template.rimColors[wheel.axle]);
        for (const disc of discs) {
            steer.add(disc);
        }

        return { axle: wheel.axle, side: wheel.side, steer, spin, mesh, radius: wheel.radius, width: wheel.width, discs, lockBlend: 0 };
    });

    const materials = shared ? [shared] : [paint, wheelMaterials.front, wheelMaterials.rear];
    const front = template.wheels.filter((wheel) => wheel.axle === 'front');
    const rear = template.wheels.filter((wheel) => wheel.axle === 'rear');

    return {
        model,
        body,
        wheels,
        materials,
        paintMaterials: shared ? [] : [paint],
        wheelMaterials: shared ? [] : [wheelMaterials.front, wheelMaterials.rear],
        axles: {
            front: { ...template.axles.front },
            rear: { ...template.axles.rear },
        },
        wheelRadius: (template.axles.front.radius + template.axles.rear.radius) / 2,
        tyreWidth: {
            front: front[0].split ? front[0].width : 2 * (front[0].width / 2 - template.axles.front.x),
            rear: rear[0].split ? rear[0].width : 2 * (rear[0].width / 2 - template.axles.rear.x),
        },
    };
}

// ── Blur дискове ─────────────────────────────────────────────────────────

/** @type {THREE.CanvasTexture|null} */
let blurDiscTexture = null;

/**
 * Радиална алфа: плътна до 70 % от радиуса, гасне до ръба. Споделена за
 * всички колела; никой не я dispose-ва (Game.dispose я маха от GPU, three я
 * качва наново от canvas-а).
 *
 * @returns {THREE.Texture|null}
 */
function getBlurDiscTexture() {
    if (blurDiscTexture || typeof document === 'undefined') {
        return blurDiscTexture;
    }
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,0.85)');
    gradient.addColorStop(0.55, 'rgba(255,255,255,0.85)');
    gradient.addColorStop(0.72, 'rgba(255,255,255,0.55)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
    blurDiscTexture = new THREE.CanvasTexture(canvas);
    blurDiscTexture.name = 'wheel-blur';

    return blurDiscTexture;
}

/**
 * Два диска в равнините на джантата (външна и вътрешна страна), с цвета на
 * джантата от атласа. Радиус = джантата (не гумата): страничната стена на
 * гумата е еднородно черна и няма какво да се „размазва", а диск до ръба
 * на гумата би я боядисал сиво.
 *
 * @param {{radius: number, width: number, side: number, split: boolean}} wheel
 * @param {THREE.Color} rimColor
 * @returns {THREE.Mesh[]}
 */
export function buildBlurDiscs(wheel, rimColor) {
    const texture = getBlurDiscTexture();
    if (!texture) {
        return [];
    }
    const radius = wheel.radius * RIM_RADIUS_RATIO;
    const geometry = new THREE.CircleGeometry(radius, 32);
    // Мъглата остава: дискът е „джантата" на далечен съперник и трябва да
    // избледнява с нея, не да свети с чист цвят на 300 m.
    const material = new THREE.MeshBasicMaterial({
        map: texture,
        color: rimColor,
        transparent: true,
        opacity: 0,
        depthWrite: false,
    });
    material.name = 'wheel-blur';

    const discs = [];
    const half = wheel.width / 2;
    for (const face of [-1, 1]) {
        const disc = new THREE.Mesh(geometry, material);
        // CircleGeometry гледа по +Z; завъртане около Y я обръща към ±X.
        disc.rotation.y = face * (Math.PI / 2);
        disc.position.x = face * (half - 0.02);
        disc.renderOrder = 2;
        disc.userData.carLight = true;
        disc.visible = false; // updateCarRig го показва над прага на blur-а
        discs.push(disc);
    }

    return discs;
}

// ── Пилот ────────────────────────────────────────────────────────────────

/**
 * Процедурен шлем: сфера с лак + тъмна лента визьор. Стои в кокпита под
 * rig.body (накланя се с тялото) и се люлее с gLat през updateCarRig.
 *
 * @param {number|THREE.Color} color
 * @param {{x: number, y: number, z: number}} position   Кокпит в риг пространство
 * @returns {THREE.Group}
 */
export function buildHelmet(color, position) {
    const group = new THREE.Group();
    group.name = 'helmet';
    group.position.set(position.x, position.y, position.z);

    const shell = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 16, 12),
        new THREE.MeshPhysicalMaterial({
            color,
            metalness: 0.1,
            roughness: 0.3,
            clearcoat: 1,
            clearcoatRoughness: 0.08,
        })
    );
    shell.scale.set(1, 1.08, 1.05);
    shell.castShadow = true;
    group.add(shell);

    // Визьорът: тънка лента отпред, леко над екватора на сферата.
    const visor = new THREE.Mesh(
        new THREE.SphereGeometry(0.143, 16, 6, Math.PI * 0.62, Math.PI * 0.76, Math.PI * 0.4, Math.PI * 0.18),
        new THREE.MeshPhysicalMaterial({
            color: 0x0b0d12,
            metalness: 0.4,
            roughness: 0.15,
            clearcoat: 1,
            clearcoatRoughness: 0.05,
        })
    );
    visor.scale.copy(shell.scale);
    group.add(visor);

    // Раменете/яката на седалката — сферата да не виси във въздуха.
    const collar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.2, 0.1, 12),
        new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.8 })
    );
    collar.position.y = -0.15;
    group.add(collar);

    group.userData.carLight = true;

    return group;
}

/**
 * Две капсули „ръце" за бордовата камера — родител е воланът на Game
 * (той се върти със state.steer, ръцете вървят с него).
 *
 * @returns {THREE.Group}
 */
export function buildDriverArms() {
    const group = new THREE.Group();
    group.name = 'driver-arms';
    const glove = new THREE.MeshStandardMaterial({ color: 0x1d1f26, roughness: 0.85 });
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x2f3138, roughness: 0.9 });

    for (const side of [-1, 1]) {
        // Ръкав от волана (9 и 3 часа) назад-надолу към рамото.
        const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.32, 4, 8), sleeve);
        arm.position.set(side * 0.19, -0.16, 0.2);
        arm.rotation.set(-0.9, 0, side * 0.35);
        group.add(arm);

        const hand = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.06, 4, 8), glove);
        hand.position.set(side * 0.165, 0.0, 0.02);
        hand.rotation.z = Math.PI / 2;
        group.add(hand);
    }

    return group;
}

/**
 * Позицията на кокпита в риг пространство: измерена от bbox-а на тялото,
 * с проверени пропорции на F1 болид (главата е на ~48 % от дължината,
 * измерено от носа, връх на ~0.62 m).
 *
 * @param {CarTemplate} template
 * @returns {{x: number, y: number, z: number}}
 */
export function cockpitPosition(template) {
    const box = template.bounds;
    const length = box.max.z - box.min.z;

    return { x: 0, y: Math.min(box.max.y, 0.95) * 0.64, z: box.max.z - length * 0.485 };
}

// ── Помощни ──────────────────────────────────────────────────────────────

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
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
function lerp(a, b, t) {
    return a + (b - a) * t;
}
