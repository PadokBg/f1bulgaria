<?php

declare(strict_types=1);

/*
|--------------------------------------------------------------------------
| Държави на пилотите от Формула 2
|--------------------------------------------------------------------------
|
| Ключът е slug-ът на пилота (Str::slug върху латинското име, точно както го
| гради F2ApiSync::resolveDriver). Стойността е кодът на държавата, който
| App\Support\CountryFlag превежда до знаме.
|
| ЗАЩО СЪЩЕСТВУВА: официалният резултатен API на Формула 2 НЕ връща
| националност. Проверено емпирично — в резултатите на сесия полетата са
| positionNumber, driverFirstName, driverLastName, driverReference, driverTLA,
| racingNumber, teamName, teamKey, teamColourCode, classifiedTime,
| gapToLeader, lapsCompleted; в класирането — championshipPoints,
| driverNameFormat, driverShortName, position. Държава няма никъде. Без тази
| таблица всеки пилот, създаден от синхрона, остава с country_code = null и
| се показва без знаме из целия F2 раздел.
|
| ЗАЩО НЕ Е АВТОМАТИЧНО: няма от какво да се изведе. Нито името, нито отборът
| носят гражданството — Дюрксен кара с парагвайски флаг въпреки германското
| потекло, Беганович със шведски въпреки босненското, а Гьоте е роден в
| Лондон, но се състезава за Германия. Затова таблицата е ръчна и се допълва
| при всяка промяна на решетката.
|
| ФОРМАТ: кодовете следват нотацията на МОК, с която вече са записани
| данните от Wikipedia (BUL, GER, NED, PAR, IRE), а не ISO 3166-1 alpha-3.
| Това не е козметика: F2Controller търси българина с
| where('country_code', 'BUL'), а F2RaceController, F2DriversController и
| F2TeamsController вдигат is_bulgarian по същото сравнение. Всеки код тук
| трябва да присъства в App\Support\CountryFlag::MAP, иначе знамето изчезва
| безшумно.
|
| ВАЖНО: F2ApiSync попълва само липсващ country_code. Записите от Wikipedia
| и seed-а са водещи и никога не се презаписват оттук.
*/

return [

    // --- Решетка 2026 ---
    'nikola-tsolov' => 'BUL',
    'dino-beganovic' => 'SWE',
    'john-bennett' => 'GBR',
    'roman-bilinski' => 'POL',
    'mari-boya' => 'ESP',
    'rafael-camara' => 'BRA',
    'alex-dunne' => 'IRE',
    'joshua-durksen' => 'PAR',
    'emerson-fittipaldi-jr' => 'BRA',
    'oliver-goethe' => 'GER',
    'colton-herta' => 'USA',
    'tasanapol-inthraphuvasak' => 'THA',
    'noel-leon' => 'MEX',
    'kush-maini' => 'IND',
    'gabriele-mini' => 'ITA',
    'ritomo-miyata' => 'JPN',
    'sebastian-montoya' => 'COL',
    'cian-shields' => 'GBR',
    'martinius-stenshorne' => 'NOR',
    'laurens-van-hoepen' => 'NED',
    'nico-varrone' => 'ARG',
    'rafael-villagomez' => 'MEX',

    // --- Варианти на изписване ---
    // API-то и Wikipedia невинаги дават едно и също име, а slug-ът се гради
    // от него. Дубликатите тук пазят знамето, независимо кой източник е
    // създал записа.
    'alexander-dunne' => 'IRE',
    'emerson-fittipaldi' => 'BRA',

    // --- Заместници ---
    // Флагът се записва само при създаването на пилота от резултат, тоест
    // редът тук трябва да е в деплоя преди първия му кръг.
    'hiyu-yamakoshi' => 'JPN', // Van Amersfoort, Баку 2026

];
