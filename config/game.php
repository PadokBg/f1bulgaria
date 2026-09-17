<?php

declare(strict_types=1);

/*
|--------------------------------------------------------------------------
| Игра — данни за пистите
|--------------------------------------------------------------------------
|
| Трасетата се генерират от свободни географски данни, не се моделират:
|   - осева линия: bacinger/f1-circuits (произход OpenStreetMap, ODbL)
|   - надморска височина: OpenTopoData (mapzen / EU-DEM, Copernicus)
|   - ориентири: OpenStreetMap през Overpass (ODbL)
|
| Формата и релефът на едно място са факти, не авторско произведение. Затова
| пресъздаването им е чисто, но атрибуцията е задължителна (виж resources/js/
| Pages/Game/Index.vue) и по трасето НЯМА реални рекламни пана, лога на отбори
| или ливреи — те са търговски марки.
|
*/

return [

    // Bumping this value starts a fresh competitive season. Historical laps
    // stay in the database, but only records from this simulation version are
    // eligible for leaderboards, profiles, badges and server ghosts.
    'sim_version' => 3,

    // Mirrors RACE_VERSION in resources/js/game/race.js (grid, bots, contacts,
    // penalties, finish). Bumping it starts a fresh race leaderboard.
    'race_version' => 1,

    // Mirrors RACE_OPPONENTS / RACE_PENALTY_MS in race.js.
    'race' => [
        'opponents' => 5,
        'total_laps' => 3,
        'penalty_ms' => 5000,
    ],

    /*
    |----------------------------------------------------------------------
    | Писти
    |----------------------------------------------------------------------
    |
    | Ключът е Jolpica circuitId (== circuit_slug другаде в приложението).
    |
    |   feature      — id на feature-а в bacinger GeoJSON
    |   width        — реална ширина на трасето в метри (Монако е тясно)
    |   start_offset — отместване на стартовата линия в метри по посока на
    |                  обиколката; първата точка в GeoJSON-а е произволна
    |   max_slope    — таван на наклона (m/m) при изглаждане на профила.
    |                  Ео Руж е ~0.18; всичко над това е артефакт от DEM-а.
    |   elevation    — false изключва профила за писта, чиито данни са
    |                  негодни (тунели: DEM-ът връща скалата отгоре)
    |
    | Таваните на наклона са реалните за всяка писта. DEM на 30 m резолюция
    | покрай склон връща фалшиви стръмнини; таванът ги реже, без да пипа
    | истинския релеф. Ео Руж е най-стръмното в календара — оттам и 0.18 за Спа.
    |
    */
    'tracks' => [
        'monza' => ['feature' => 'it-1922', 'width' => 14.0, 'start_offset' => 0.0, 'max_slope' => 0.06],
        'spa' => ['feature' => 'be-1925', 'width' => 13.5, 'start_offset' => 0.0, 'max_slope' => 0.18],
        'silverstone' => ['feature' => 'gb-1948', 'width' => 13.0, 'start_offset' => 0.0, 'max_slope' => 0.05],
        // start_offset: суровият GeoJSON започва при Казиното (върха на трасето);
        // реалният старт/финал е на правата Rascasse → Sainte Dévote, на
        // пристанищното ниво — ~2770 m по посоката на обиколката.
        'monaco' => ['feature' => 'mc-1929', 'width' => 9.0, 'start_offset' => 2770.0, 'max_slope' => 0.15],
        'suzuka' => ['feature' => 'jp-1962', 'width' => 13.0, 'start_offset' => 0.0, 'max_slope' => 0.10],
        'red_bull_ring' => ['feature' => 'at-1969', 'width' => 13.5, 'start_offset' => 0.0, 'max_slope' => 0.12],
        'zandvoort' => ['feature' => 'nl-1948', 'width' => 12.0, 'start_offset' => 0.0, 'max_slope' => 0.08],
        'interlagos' => ['feature' => 'br-1940', 'width' => 13.0, 'start_offset' => 0.0, 'max_slope' => 0.10],

        // ── Календарът 2026: elevation => false пази дневния лимит на
        // OpenTopoData за пистите, където релефът реално значи нещо. ──────
        'bahrain' => ['feature' => 'bh-2002', 'width' => 15.0, 'start_offset' => 0.0, 'max_slope' => 0.04],
        'jeddah' => ['feature' => 'sa-2021', 'width' => 12.0, 'start_offset' => 0.0, 'max_slope' => 0.03, 'elevation' => false],
        'albert_park' => ['feature' => 'au-1953', 'width' => 13.0, 'start_offset' => 0.0, 'max_slope' => 0.04],
        'shanghai' => ['feature' => 'cn-2004', 'width' => 14.0, 'start_offset' => 0.0, 'max_slope' => 0.04, 'elevation' => false],
        'miami' => ['feature' => 'us-2022', 'width' => 13.0, 'start_offset' => 0.0, 'max_slope' => 0.04, 'elevation' => false],
        'imola' => ['feature' => 'it-1953', 'width' => 12.5, 'start_offset' => 0.0, 'max_slope' => 0.10],
        'catalunya' => ['feature' => 'es-1991', 'width' => 13.0, 'start_offset' => 0.0, 'max_slope' => 0.08],
        'villeneuve' => ['feature' => 'ca-1978', 'width' => 12.5, 'start_offset' => 0.0, 'max_slope' => 0.03, 'elevation' => false],
        'hungaroring' => ['feature' => 'hu-1986', 'width' => 12.5, 'start_offset' => 0.0, 'max_slope' => 0.08],
        'baku' => ['feature' => 'az-2016', 'width' => 11.0, 'start_offset' => 0.0, 'max_slope' => 0.06],
        'marina_bay' => ['feature' => 'sg-2008', 'width' => 12.0, 'start_offset' => 0.0, 'max_slope' => 0.03, 'elevation' => false],
        'americas' => ['feature' => 'us-2012', 'width' => 15.0, 'start_offset' => 0.0, 'max_slope' => 0.10],
        'rodriguez' => ['feature' => 'mx-1962', 'width' => 13.0, 'start_offset' => 0.0, 'max_slope' => 0.05],
        'vegas' => ['feature' => 'us-2023', 'width' => 13.0, 'start_offset' => 0.0, 'max_slope' => 0.03, 'elevation' => false],
        'losail' => ['feature' => 'qa-2004', 'width' => 12.5, 'start_offset' => 0.0, 'max_slope' => 0.03, 'elevation' => false],
        'yas_marina' => ['feature' => 'ae-2009', 'width' => 14.0, 'start_offset' => 0.0, 'max_slope' => 0.04, 'elevation' => false],
    ],

    /*
    |----------------------------------------------------------------------
    | Сървърна валидация на обиколки
    |----------------------------------------------------------------------
    |
    | Опашката преиграва записания вход през Node (същата симулация като
    | клиента). Node трябва да е наличен за queue worker-а.
    |
    */
    'validator' => [
        'node' => env('GAME_NODE_BINARY', 'node'),
    ],

    /*
    |----------------------------------------------------------------------
    | Надморска височина
    |----------------------------------------------------------------------
    */
    'elevation' => [
        'endpoint' => env('GAME_ELEVATION_ENDPOINT', 'https://api.opentopodata.org/v1'),

        // mapzen комбинира най-добрия наличен източник за всеки регион и
        // покрива целия свят. eudem25m е по-точен, но само за Европа.
        'dataset' => env('GAME_ELEVATION_DATASET', 'mapzen'),

        // Ограниченията на публичния API: 100 локации на заявка, 1 заявка/сек,
        // 1000 локации на ден. Затова резултатите се кешират и командата се
        // пуска по една писта.
        'batch_size' => 100,
        'delay_ms' => 1200,

        // Таван на наклона по подразбиране (m/m). Ео Руж е около 0.18.
        'max_slope' => 0.20,

        // Колко пъти да мине изглаждането по профила.
        'smoothing_passes' => 6,
    ],

    /*
    |----------------------------------------------------------------------
    | Ориентири от OpenStreetMap
    |----------------------------------------------------------------------
    */
    'landmarks' => [
        'endpoint' => env('GAME_OVERPASS_ENDPOINT', 'https://overpass-api.de/api/interpreter'),

        // Колко метра около трасето да се търсят ориентири.
        'radius' => 400,

        // Типични височини за extrude, метри.
        'heights' => [
            'grandstand' => 12.0,
            'building' => 8.0,
        ],
    ],

];
