<?php

declare(strict_types=1);

use App\Models\GameSessionEvent;
use App\Models\GameVisit;
use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

// Суровите събития от играта живеят RETENTION_DAYS (виж GameSessionEvent),
// посещенията — година (GameVisit); агрегатите в game_sessions остават.
Schedule::command('model:prune', ['--model' => [GameSessionEvent::class, GameVisit::class]])
    ->dailyAt('04:10')
    ->timezone('Europe/Sofia')
    ->onOneServer();

// Изтеклите MCP токени (padok:mcp-token --days) спират да важат сами;
// това само чисти редовете им от personal_access_tokens.
Schedule::command('sanctum:prune-expired --hours=24')
    ->dailyAt('04:20')
    ->timezone('Europe/Sofia')
    ->onOneServer();

// Заключва прогнозите 5 мин преди квалификацията — върви всяка минута.
Schedule::command('f1:lock-predictions')
    ->everyMinute()
    ->withoutOverlapping();

// Синхрон на резултати. На 15 мин, а не на час: каналът публикува от базата и
// час закъснение се вижда. Jolpica прави 3 заявки на пускане при лимит ~500 на
// час, така че честотата не е проблем — Jolpica обаче публикува със собствено
// закъснение и това остава тясното място.
Schedule::command('f1:sync-results')
    ->everyFifteenMinutes()
    ->withoutOverlapping(14);

// Разписание на сесиите + класации от тренировките и спринт квалификацията.
//
// Разписанието е критично, не украса: `race_sessions` се чете от
// NextRaceResolver, за да разбере дали тече уикенд. Докато таблицата беше
// празна, началната страница не показваше нито активен уикенд, нито
// състояние след финала.
Schedule::command('f1:sync-sessions')
    ->everyFifteenMinutes()
    ->withoutOverlapping(14)
    ->runInBackground()
    ->appendOutputTo(storage_path('logs/scheduler.log'));

// Рекап на състезанието — ЕЖЕЧАСНО, не в фиксиран неделен час.
//
// Беше `weeklyOn(0, '20:00')` и това беше единствен изстрел: условието
// (резултати от състезанието) идва от Jolpica, която публикува когато си
// иска. На 06.09.2026 състезанието беше в 16:00, а в 20:00 резултати още
// нямаше — рекапът се пропусна. По-лошото: `resolveRace` подрежда по
// най-нов, а следващият кръг беше същата неделя четири часа по-рано, тоест
// пропуснатият рекап щеше да бъде изяден от него и да не излезе НИКОГА.
//
// Сега командата се буди всеки час и праща в мига, в който резултатите се
// появят. Вътрешните гардове не се променят: без резултати от състезанието
// не праща нищо, а `newsletter_sends` държи по едно писмо на кръг. Сама
// пази и приличен час (9-22 софийско), за да не буди хората.
Schedule::command('f1:weekly-digest')
    ->hourly()
    ->timezone('Europe/Sofia')
    ->onOneServer()
    ->withoutOverlapping(55);

// Петъчен preview на състезателния уикенд в 09:00 софийско време.
// Вътрешният guard праща само ако до 7 дни напред има кръг.
Schedule::command('f1:race-preview')
    ->weeklyOn(5, '09:00')
    ->timezone('Europe/Sofia')
    ->onOneServer()
    ->withoutOverlapping(120);

// Играта в канала: четвъртък — старт на седмичното предизвикателство
// на пистата на уикенда; понеделник — резултати + значка на победителя.
// Вътрешният guard мълчи, когато няма писта на уикенда/никой не е карал.
Schedule::command('game:weekly-channel --mode=open')
    ->weeklyOn(4, '10:00')
    ->timezone('Europe/Sofia')
    ->onOneServer()
    ->withoutOverlapping(120);

Schedule::command('game:weekly-channel --mode=wrap')
    ->weeklyOn(1, '10:00')
    ->timezone('Europe/Sofia')
    ->onOneServer()
    ->withoutOverlapping(120);

// Подсещане за неподадена прогноза. Проверява на кръгъл час, но вътрешният
// guard (24-часов прозорец преди заключването + `newsletter_sends` по race_id)
// пуска най-много едно писмо на кръг — обикновено петък вечер.
//
// Отделно от preview-то нарочно: preview-то е за всички и е информационно,
// това стига САМО до хората без прогноза и е с една задача.
Schedule::command('f1:prediction-reminder')
    ->hourly()
    ->timezone('Europe/Sofia')
    ->onOneServer()
    ->withoutOverlapping(55);

// Другата половина на уикенда: какво донесе прогнозата. Вечерта след
// състезанието, когато резултатите вече са синхронизирани и точкувани —
// вътрешният guard (последен ТОЧКУВАН кръг + newsletter_sends по race_id)
// пуска най-много едно писмо на кръг. Флагът features.race_result_mail е
// изключен, докато политиката не изброи и това писмо: дотогава командата
// излиза, без да прати нищо.
Schedule::command('f1:race-result-mail')
    ->dailyAt('21:30')
    ->timezone('Europe/Sofia')
    ->onOneServer()
    ->withoutOverlapping(60);

// Понеделнишкият анонс на куиза (имейл + пост в канала) — 09:00 софийско.
// Вътрешният guard (newsletter_sends по седмица) пази от дублиране.
Schedule::command('padok:quiz-monday')
    ->weeklyOn(1, '09:00')
    ->timezone('Europe/Sofia')
    ->onOneServer()
    ->withoutOverlapping(120);

// „Днес сме на живо" — проверка на 15 мин, но вътрешните пазачи (3-часов
// прозорец преди старта + newsletter_sends по race_id + флаг + OpenF1
// креденшъли) го пускат веднъж на състезателна неделя.
Schedule::command('f1:live-announce')
    ->everyFifteenMinutes()
    ->onOneServer()
    ->withoutOverlapping(14);

// Допълване на куиз басейна: LLM чернови с двойна сляпа проверка, влизат
// направо активни. Пуска се само при активни под quiz.pool_target.
Schedule::command('padok:generate-quiz-questions --top-up')
    ->weeklyOn(3, '10:00')
    ->timezone('Europe/Sofia')
    ->onOneServer()
    ->withoutOverlapping(120);

// „Пулс" през паузите — проверка всяка сряда 18:00 софийско време.
// Седмично, а не месечно: закачен за 1-во число пулсът геометрично не може
// да улучи лятната пауза (1 август/септември винаги опират в guard-овете).
// Вътрешните guard-ове (14 дни тишина назад, 10 дни буфер напред, 21 дни
// между два пулса чрез `newsletter_sends`) го пускат ефективно веднъж на
// 3-4 седмици и само в дълги паузи.
Schedule::command('f1:offseason-pulse')
    ->weeklyOn(3, '18:00')
    ->timezone('Europe/Sofia')
    ->onOneServer()
    ->withoutOverlapping(120);

// News pipeline — новини през целия ден: вземане на всеки 30 мин, LLM
// превод + автоматична публикация 5 мин по-късно. LLM разходът зависи от
// броя нови елементи, не от честотата — по-честият цикъл не струва повече.
Schedule::command('news:fetch')
    ->cron('0,30 * * * *')
    ->withoutOverlapping(25)
    ->runInBackground()
    ->appendOutputTo(storage_path('logs/scheduler.log'));

// Lock-ът изтича след 40 мин: при runInBackground убит процес (OOM, deploy,
// reboot) не освобождава mutex-а и default-ните 24h биха спрели цикъла за ден.
Schedule::command('news:enrich --limit=25')
    ->cron('5,35 * * * *')
    ->withoutOverlapping(40)
    ->runInBackground()
    ->appendOutputTo(storage_path('logs/scheduler.log'));

// Машинна поправка на имена и транслитерации след обогатяването. По-малките
// модели грешат имена по два начина: пишат едно и също име различно в
// съседни статии, и понякога ПРЕВЕЖДАТ фамилия като нарицателно
// („Leclerc" -> „Лекар"). Промптът го забранява, това е мрежата отдолу.
//
// Слотът е нарочен: news:enrich върви в :05/:35 и трае ~8 мин на партида от
// 25, а channel:enqueue-news е в :23/:53 — поправката минава между двете, за
// да не тръгне сгрешено име към Telegram канала. Само база, без LLM.
Schedule::command('news:normalize-bg')
    ->cron('15,45 * * * *')
    ->withoutOverlapping(10)
    ->appendOutputTo(storage_path('logs/scheduler.log'));

// Осигурителна мрежа: обогатени, но незавършили публикация елементи (напр.
// грешка при featured_image) се публикуват тук, вместо да висят pending.
Schedule::command('news:publish-pending')
    ->hourlyAt(20)
    ->withoutOverlapping(10)
    ->appendOutputTo(storage_path('logs/scheduler.log'));

// F2 синхрон от официалния API. На 15 мин, защото резултатите излизат минути
// след сесията, а каналът публикува от базата.
//
// Честотата не е скъпа: F2ApiSync дърпа класация само за сесия без резултати
// или за състезание, което още не е `Final`. В спокоен ден това са две
// заявки — календарът и класирането.
//
// f2:sync-wikipedia вече НЕ е в разписанието — API-то е основният източник,
// а Wikipedia остава ръчна, само за сезоните преди 2026 (`--historical`).
Schedule::command('f2:sync')
    ->everyFifteenMinutes()
    ->withoutOverlapping(14)
    ->runInBackground()
    ->appendOutputTo(storage_path('logs/scheduler.log'));

// Свеж sitemap всеки час — публикуваните през деня статии влизат в индекса
// на Google без ръчна намеса.
Schedule::command('sitemap:generate')
    ->hourlyAt(45)
    ->withoutOverlapping();

// Дописва пълни статии там, където inline генерацията в news:enrich се е
// провалила, плюс наваксване на стария backlog — най-новите първо.
Schedule::command('news:generate-articles --limit=10')
    ->hourlyAt(25)
    ->withoutOverlapping(50)
    ->runInBackground()
    ->appendOutputTo(storage_path('logs/scheduler.log'));

// Най-важните новини към канала. На 15 мин, изместено от news:* слотовете
// (:00/:30 fetch, :05/:35 enrich, :20 publish-pending, :25 generate-articles),
// за да не се блъска с тях.
//
// Само поставя в опашката — изпращането е на channel:post.
Schedule::command('channel:enqueue-news')
    ->cron('8,23,38,53 * * * *')
    ->withoutOverlapping(14)
    ->runInBackground()
    ->appendOutputTo(storage_path('logs/scheduler.log'));

// Изпразва изходящата опашка към Telegram канала. На 5 мин: синхроните само
// пълнят опашката, а тя трябва да тръгва бързо след сесия.
//
// withoutOverlapping е задължително — две едновременни пускания биха взели
// един и същи ред и биха го публикували два пъти, преди първото да е
// маркирало `sent_at`.
Schedule::command('channel:post')
    ->everyFiveMinutes()
    ->withoutOverlapping(10)
    ->runInBackground()
    ->appendOutputTo(storage_path('logs/scheduler.log'));

// Пази от ТИХ отказ. На 03-04.09.2026 доставчикът спря да сервира модела,
// всяка LLM заявка връщаше 403, NewsEnricher я гълташе като warning и
// оставяше реда pending. Командата връщаше SUCCESS, cron изглеждаше здрав,
// sitemap-ът се обновяваше — пайплайнът мълча 24 часа и разбрахме по
// застоялите новини на сайта.
//
// Проверката гледа резултата (публикува ли се още), а не конкретна грешка,
// за да хване и причини, които още не сме виждали. Праща един имейл на
// инцидент и един при възстановяване; изпращането е синхронно, защото
// мъртъв queue worker е точно една от авариите, за които трябва да се обади.
//
// :50 — извън всички news слотове (:00/:30 fetch, :05/:35 enrich,
// :15/:45 normalize, :20 publish-pending, :25 generate-articles).
Schedule::command('news:health-check')
    ->hourlyAt(50)
    ->onOneServer()
    ->withoutOverlapping(55)
    ->appendOutputTo(storage_path('logs/scheduler.log'));

// Рекапът с данни от OpenF1 след състезание.
//
// На всеки час, защото прозорецът в самата команда (3-36 часа след старта)
// решава кога има работа — така пропуснат час се наваксва сам, вместо да
// изгуби кръга. Извън състезателен уикенд заявката е една към базата и нула
// към OpenF1.
//
// :47 — свободна минута: :00/:30, :05/:35, :15/:45, :20, :25, :50 и
// :08/:23/:38/:53 са заети от новинарския конвейер и канала.
Schedule::command('padok:race-data-recap')
    ->hourlyAt(47)
    ->onOneServer()
    ->withoutOverlapping(45)
    ->runInBackground()
    ->appendOutputTo(storage_path('logs/scheduler.log'));

// Дневен отчет за активността към админ имейла — накрая на деня (софийско).
Schedule::command('report:daily-activity')
    ->dailyAt('23:55')
    ->timezone('Europe/Sofia')
    ->withoutOverlapping();
