@component('mail::message')
# {{ $points }} {{ $points === 1 ? 'точка' : 'точки' }} за {{ $race->name_bg }} 🏁

{{ $race->circuit }}, {{ $race->country }}

Прогнозата ти те нареди **{{ $raceRank['rank'] }}-и от {{ $raceRank['total'] }}** за този кръг@if ($seasonRank), а в класирането за сезона си **{{ $seasonRank }}-и**@endif.

@component('mail::table')
| Какво позна | Точки |
|:------------|------:|
@foreach ($rows as $row)
| {{ $row['points'] > 0 ? '✓' : '✗' }} {{ $row['label'] }} | {{ $row['points'] > 0 ? '+'.$row['points'] : '0' }} |
@endforeach
@endcomponent

@component('mail::button', ['url' => route('races.show', $race)])
Виж разбивката
@endcomponent

Следващият кръг вече чака прогноза.

До скоро!<br> Екипът на Падок

<small>Получаваш този имейл, защото подаде прогноза за този кръг в Падок. [Спри имейлите]({{ $userUnsubscribeUrl }})</small>
@endcomponent
