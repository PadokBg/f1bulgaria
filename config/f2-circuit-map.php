<?php

declare(strict_types=1);

/*
|--------------------------------------------------------------------------
| F2 локация (от заглавието на Wikipedia кръга) → F1 circuit jolpica_id
|--------------------------------------------------------------------------
|
| Свързва F2 кръговете със съществуващите F1 писти (за кръстосани връзки).
| Локацията се извлича от "{year} {Location} Formula 2 round". Липсваща
| локация → circuit_jolpica_id = null (кръгът пак се записва).
|
*/

return [
    'Melbourne' => 'albert_park',
    'Sakhir' => 'bahrain',
    'Bahrain' => 'bahrain',
    'Jeddah' => 'jeddah',
    'Imola' => 'imola',
    'Miami' => 'miami',
    // Така ги пише официалното API (meetingLocation); горните са от Wikipedia.
    'Miami Gardens' => 'miami',
    'Monte Carlo' => 'monaco',
    'Monaco' => 'monaco',
    'Barcelona' => 'catalunya',
    'Catalunya' => 'catalunya',
    'Montreal' => 'villeneuve',
    'Montréal' => 'villeneuve',
    'Spielberg' => 'red_bull_ring',
    'Red Bull Ring' => 'red_bull_ring',
    'Silverstone' => 'silverstone',
    'Budapest' => 'hungaroring',
    'Hungaroring' => 'hungaroring',
    'Spa-Francorchamps' => 'spa',
    'Spa' => 'spa',
    'Zandvoort' => 'zandvoort',
    'Monza' => 'monza',
    'Madrid' => 'madring',
    'Baku' => 'baku',
    'Lusail' => 'losail',
    'Yas Island' => 'yas_marina',
    'Yas Marina' => 'yas_marina',
];
