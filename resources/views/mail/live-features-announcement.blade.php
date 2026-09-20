@component('mail::message')
# Уикендът вече се гледа с Падок 🏁

Здравей! Прогнозата досега беше нещо, което попълваш в петък и отваряш пак чак във вторник. Оправихме точно това.

## 🔴 Прогнозите на живо

Докато тече състезанието, страницата на кръга точкува прогнозата ти по текущите позиции. Виждаш колко точки имаш в момента и кой от Падок те води — таблицата се мени с всяко изпреварване.

Временно е точно толкова, колкото трябва: подиумът се точкува на живо, а най-бързата обиколка, отпадналите и safety car се начисляват чак на финала.
@if ($unsubscribeToken)
{{-- Абонат без акаунт: страницата на кръга няма форма за него. --}}

Прогнозата иска само три имена за подиума и отнема минута.

@component('mail::button', ['url' => url('/register')])
Включи се
@endcomponent
@elseif ($nextRace)

Следващ кръг: **{{ $nextRace['name'] }}**@if ($nextRace['deadline']) — прогнозите се заключват **{{ $nextRace['deadline'] }}**@else.@endif

@component('mail::button', ['url' => $nextRace['url']])
Подай прогноза
@endcomponent
@else

@component('mail::button', ['url' => url('/leaderboard')])
Виж класирането
@endcomponent
@endif

@if ($resultMailOn && ! $unsubscribeToken)
А вечерта след състезанието ти пишем какво е донесла прогнозата ти — точки, какво позна и къде си в класирането. Стига до тези, които са прогнозирали за кръга, и се спира от същия линк долу.

@endif
@if ($tsolov)
## Цоловметър

@if ($tsolov['leads'])
**Никола Цолов води шампионата на Формула 2** с {{ $tsolov['points'] }} точки@if ($tsolov['rival']) — {{ $tsolov['rival']['gap'] }} пред {{ $tsolov['rival']['name'] }}@endif.
@else
**Никола Цолов е {{ $tsolov['position'] }}-и в шампионата на Формула 2** с {{ $tsolov['points'] }} точки@if ($tsolov['rival']) — на {{ $tsolov['rival']['gap'] }} от {{ $tsolov['rival']['name'] }}@endif.
@endif
@if ($tsolovNext)

Следващо каране: {{ $tsolovNext }}
@endif

Българин се бори за титла, а това се следеше трудно на български. Сега е на началната страница и се обновява сам.

@component('mail::button', ['url' => url('/tsolov'), 'color' => 'success'])
Следи Цолов
@endcomponent

@endif
## ⏱ Хронометърът чака първото време

Класацията на пистата на уикенда е празна. Който запише първото чисто време, е №1 — и остава там, докато някой не го бие.

Ново е и това: ако покараш, без да си влязъл, времето вече не изчезва. Изчаква те и влиза в класацията в момента, в който се впишеш.

@component('mail::button', ['url' => url('/game')])
Карай
@endcomponent

@include('mail.partials.community')

До скоро на пистата! 🏁<br> Екипът на Падок

@if ($unsubscribeToken)
<small>Получаваш този имейл като абонат на бюлетина на Падок. [Отпиши се]({{ route('newsletter.unsubscribe', $unsubscribeToken) }})</small>
@elseif ($userUnsubscribeUrl)
<small>Получаваш този имейл, защото имаш акаунт в Падок. [Спри имейлите]({{ $userUnsubscribeUrl }})</small>
@endif
@endcomponent
