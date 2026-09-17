<?php

declare(strict_types=1);

use App\Http\Controllers\BadgeSeenController;
use App\Http\Controllers\CalendarController;
use App\Http\Controllers\CircuitsController;
use App\Http\Controllers\CommentsController;
use App\Http\Controllers\CompareController;
use App\Http\Controllers\DriversController;
use App\Http\Controllers\EngineeringController;
use App\Http\Controllers\F2CalendarController;
use App\Http\Controllers\F2Controller;
use App\Http\Controllers\F2DriversController;
use App\Http\Controllers\F2RaceController;
use App\Http\Controllers\F2TeamsController;
use App\Http\Controllers\FeedbackController;
use App\Http\Controllers\FeedController;
use App\Http\Controllers\GameController;
use App\Http\Controllers\GameFeedbackController;
use App\Http\Controllers\GameLeaderboardController;
use App\Http\Controllers\GameSessionController;
use App\Http\Controllers\GameVisitController;
use App\Http\Controllers\HistoryController;
use App\Http\Controllers\HomeController;
use App\Http\Controllers\LeaderboardController;
use App\Http\Controllers\LiveTimingController;
use App\Http\Controllers\NewsController;
use App\Http\Controllers\NewsletterController;
use App\Http\Controllers\OgImageController;
use App\Http\Controllers\PredictionController;
use App\Http\Controllers\ProfileController;
use App\Http\Controllers\PublicProfileController;
use App\Http\Controllers\QuizController;
use App\Http\Controllers\RaceController;
use App\Http\Controllers\RaceDataController;
use App\Http\Controllers\RivalriesController;
use App\Http\Controllers\SearchController;
use App\Http\Controllers\StandingsController;
use App\Http\Controllers\StaticPageController;
use App\Http\Controllers\TeamsController;
use App\Http\Controllers\TerminologyController;
use App\Http\Controllers\TsolovController;
use Illuminate\Support\Facades\Route;

// Публични страници (V1 launch scope).
Route::get('/', [HomeController::class, 'index'])->name('home');
Route::get('/calendar', [CalendarController::class, 'index'])->name('calendar');
Route::get('/calendar.ics', [CalendarController::class, 'ics'])->name('calendar.ics');
Route::get('/calendar/team/{slug}.ics', [CalendarController::class, 'teamIcs'])->where('slug', '[a-z0-9_-]+')->name('calendar.team.ics');
Route::get('/calendar/{slug}.ics', [CalendarController::class, 'driverIcs'])->where('slug', '[a-z0-9_-]+')->name('calendar.driver.ics');
Route::get('/standings', [StandingsController::class, 'index'])->name('standings');
Route::get('/standings/{year}', [StandingsController::class, 'index'])->where('year', '[0-9]{4}')->name('standings.year');
Route::get('/leaderboard', [LeaderboardController::class, 'index'])->name('leaderboard');
Route::get('/races/{race}', [RaceController::class, 'show'])->name('races.show');
Route::get('/teams', [TeamsController::class, 'index'])->name('teams.index');
Route::get('/teams/{slug}', [TeamsController::class, 'show'])->name('teams.show');
Route::get('/drivers', [DriversController::class, 'index'])->name('drivers.index');
Route::get('/drivers/{slug}', [DriversController::class, 'show'])->name('drivers.show');
Route::get('/terminologiya', [TerminologyController::class, 'index'])->name('terminology');
// Търсене из целия сайт. throttle пази LIKE заявките от скъп scan при
// автоматизиран трафик — 30/мин е далеч над реалното човешко темпо.
// Изричен префикс на кофата: голият 'throttle:N,M' се дели с всеки друг
// гол рут и един бърст изчерпва лимита и на останалите.
Route::get('/tarsene', SearchController::class)
    ->middleware('throttle:30,1,search')
    ->name('search');
Route::get('/poveritelnost', [StaticPageController::class, 'privacy'])->name('privacy');
Route::get('/usloviya', [StaticPageController::class, 'terms'])->name('terms');
Route::get('/kontakt', [StaticPageController::class, 'contact'])->name('contact');

// V2+ модули — завършени, но скрити за launch (config/features.php). Кодът
// остава непокътнат; рутовете връщат 404 докато флагът е изключен. Включи през
// .env (напр. FEATURE_F2=true) — без code change. Навигацията също чете флаговете.
Route::middleware('feature:live_timing')->group(function () {
    Route::get('/live', [LiveTimingController::class, 'index'])->name('live');
    Route::get('/live/refresh', [LiveTimingController::class, 'refresh'])->name('live.refresh');
});

Route::middleware('feature:circuits')->group(function () {
    Route::get('/circuits', [CircuitsController::class, 'index'])->name('circuits.index');
    Route::get('/circuits/{slug}', [CircuitsController::class, 'show'])->name('circuits.show');
});

Route::middleware('feature:compare')->group(function () {
    Route::get('/compare', [CompareController::class, 'index'])->name('compare.index');
    Route::get('/compare/{slug1}/{slug2}', [CompareController::class, 'show'])->name('compare.show');
});

Route::middleware('feature:tsolov')->group(function () {
    Route::get('/tsolov', [TsolovController::class, 'index'])->name('tsolov');
});

Route::middleware('feature:f2')->group(function () {
    Route::get('/f2', [F2Controller::class, 'index'])->name('f2');
    Route::get('/f2/calendar', [F2CalendarController::class, 'index'])->name('f2.calendar');
    Route::get('/f2/calendar/{year}', [F2CalendarController::class, 'index'])->where('year', '[0-9]{4}')->name('f2.calendar.year');
    Route::get('/f2/drivers', [F2DriversController::class, 'index'])->name('f2.drivers.index');
    Route::get('/f2/drivers/{slug}', [F2DriversController::class, 'show'])->name('f2.drivers.show');
    Route::get('/f2/teams', [F2TeamsController::class, 'index'])->name('f2.teams.index');
    Route::get('/f2/teams/{slug}', [F2TeamsController::class, 'show'])->name('f2.teams.show');
    // sprint|feature са наследени отрязъци — не ги преименувай, външни линкове
    // и вече публикувани постове в канала сочат към тях.
    Route::get('/f2/races/{race}/{session}', [F2RaceController::class, 'show'])
        ->where('session', 'practice|qualifying|qualifying-a|qualifying-b|sprint|feature')
        ->name('f2.race');
    Route::get('/f2/seasons/{year}', [F2Controller::class, 'season'])->where('year', '[0-9]{4}')->name('f2.season');
});

Route::middleware('feature:history')->group(function () {
    Route::get('/istoria', [HistoryController::class, 'index'])->name('history');
    Route::get('/istoria/svetovna', [HistoryController::class, 'world'])->name('history.world');
    Route::get('/istoria/bulgaria', [HistoryController::class, 'bulgaria'])->name('history.bulgaria');
});

Route::middleware('feature:rivalries')->group(function () {
    Route::get('/rivalries', [RivalriesController::class, 'index'])->name('rivalries.index');
    Route::middleware('auth')->group(function () {
        Route::get('/rivalries/create', [RivalriesController::class, 'create'])->name('rivalries.create');
        Route::post('/rivalries', [RivalriesController::class, 'store'])->name('rivalries.store');
    });
    Route::get('/rivalries/{slug}', [RivalriesController::class, 'show'])->name('rivalries.show');
});

Route::middleware('feature:game')->group(function () {
    Route::get('/game', [GameController::class, 'index'])->name('game');

    // Класация: публична за четене (лилави рекорди за всички), запис само с
    // вход. Throttle-ната е като духа: панелът на всяка карта я вика често,
    // а гост без лимит удря 4 заявки към базата на всяко зареждане.
    // Изрични префикси на кофите — голият 'throttle:N,M' дели една кофа с
    // всеки друг гол рут (виж ThrottleBucketsTest).
    Route::get('/game/leaderboard/{track}', [GameLeaderboardController::class, 'show'])
        ->middleware('throttle:60,1,game-leaderboard')
        ->name('game.leaderboard');
    // Духът на потребител за дуел — публичен, както класацията. Границата на
    // id-то е и защита: неограничено [0-9]+ прелива PHP int → 500 за гост.
    Route::get('/game/ghost/{track}/{user}', [GameLeaderboardController::class, 'ghost'])
        ->where('user', '[0-9]{1,10}')
        ->middleware('throttle:60,1,game-ghost')
        ->name('game.ghost');
    Route::get('/game/race-ghost/{track}/{user}', [GameLeaderboardController::class, 'raceGhost'])
        ->where('user', '[0-9]{1,10}')
        ->middleware('throttle:60,1,game-race-ghost')
        ->name('game.race-ghost');
    Route::post('/game/lap', [GameLeaderboardController::class, 'store'])
        ->middleware(['auth', 'throttle:30,1,game-lap'])
        ->name('game.lap.store');
    // Състезание трае поне няколко минути, а всяко преиграване е ~1–2 s CPU
    // на опашката за цялото поле — затова лимитът е тесен: 3 на минута
    // покриват повторен опит, но не и наводняване на worker-а.
    Route::post('/game/race', [GameLeaderboardController::class, 'storeRace'])
        ->middleware(['auth', 'throttle:3,1,game-race'])
        ->name('game.race.store');
    // „Карай" на регистриран потребител — следата „пробвал е играта" за
    // админа (Играчи). Без вход не записваме нищо: гостът няма акаунт.
    Route::post('/game/session', [GameSessionController::class, 'store'])
        ->middleware(['auth', 'throttle:30,1,game-session'])
        ->name('game.session.store');
    Route::post('/game/session/{session}/events', [GameSessionController::class, 'events'])
        ->whereNumber('session')
        ->middleware(['auth', 'throttle:120,1,game-session-events'])
        ->name('game.session.events');
    // Гост-„Карай" — без вход; регистрираните минават през /game/session.
    Route::post('/game/visit', [GameVisitController::class, 'store'])
        ->middleware('throttle:30,1,game-visit')
        ->name('game.visit.store');
    Route::post('/game/feedback', [GameFeedbackController::class, 'store'])
        ->middleware(['auth', 'throttle:5,1,game-feedback'])
        ->name('game.feedback.store');
});

// „Инженерство“ — обяснителната рубрика за техниката. Съдържанието е в
// config/engineering-content.php, затова няма нито модел, нито таблица.
Route::middleware('feature:engineering')->group(function () {
    Route::get('/inzhenerstvo', [EngineeringController::class, 'index'])->name('engineering.index');
    Route::get('/inzhenerstvo/{slug}', [EngineeringController::class, 'show'])
        ->where('slug', '[a-z0-9-]+')
        ->name('engineering.show');
});

// „Данни“ — рекапът от OpenF1 след всяко състезание. Латиница-транслитерация
// на адреса, както /terminologiya, /istoria и /tarsene.
Route::middleware('feature:data_recap')->group(function () {
    Route::get('/danni', [RaceDataController::class, 'index'])->name('racedata.index');
    Route::get('/danni/{race}', [RaceDataController::class, 'show'])->name('racedata.show');
    // og:image за социалните карти — очертанието на пистата. Рисува се при
    // първото поискване и се пази на диска.
    Route::get('/danni/{race}/og.png', [OgImageController::class, 'circuit'])->name('racedata.og');
});

Route::middleware('feature:quiz')->group(function () {
    Route::get('/quiz', [QuizController::class, 'index'])->name('quiz');
    Route::post('/quiz', [QuizController::class, 'score'])
        ->middleware('throttle:10,1,quiz')
        ->name('quiz.score');
});

// RSS за агрегатори и Telegram ботове — безплатен дистрибуционен канал.
Route::get('/feed', FeedController::class)->name('feed');

Route::get('/news', [NewsController::class, 'index'])->name('news.index');
Route::get('/news/{slug}', [NewsController::class, 'show'])->name('news.show');
Route::middleware(['auth', 'verified'])->group(function () {
    Route::post('/news/{slug}/comments', [CommentsController::class, 'store'])
        ->middleware('throttle:5,1,comments')
        ->name('news.comments.store');
    Route::delete('/comments/{comment}', [CommentsController::class, 'destroy'])->name('comments.destroy');
});
Route::post('/newsletter/subscribe', [NewsletterController::class, 'subscribe'])
    ->middleware('throttle:5,1,newsletter')
    ->name('newsletter.subscribe');
// Legacy: линкове от стари потвърждаващи имейли (double opt-in е премахнат).
Route::get('/newsletter/confirm/{token}', [NewsletterController::class, 'confirm'])->name('newsletter.confirm');
Route::get('/newsletter/unsubscribe/{token}', [NewsletterController::class, 'unsubscribe'])->name('newsletter.unsubscribe');
// Опт-аут за потребители с акаунт (дайджест/preview/пулс) — signed линк от писмата.
Route::get('/newsletter/email-stop/{user}', [NewsletterController::class, 'userUnsubscribe'])
    ->middleware('signed')
    ->name('newsletter.user-unsubscribe');

// One-click отписване (RFC 8058) — същите URI-та, но POST от пощенския
// доставчик. List-Unsubscribe хедърът сочи именно тук, затова методите не
// бива да искат сесия, CSRF токен или потвърждение от човек.
Route::post('/newsletter/unsubscribe/{token}', [NewsletterController::class, 'unsubscribeOneClick'])
    ->name('newsletter.unsubscribe.one-click');
Route::post('/newsletter/email-stop/{user}', [NewsletterController::class, 'userUnsubscribeOneClick'])
    ->middleware('signed')
    ->name('newsletter.user-unsubscribe.one-click');
Route::get('/profiles/{user}', [PublicProfileController::class, 'show'])->name('profiles.show');

Route::get('/dashboard', [CalendarController::class, 'index'])
    ->middleware(['auth', 'verified'])
    ->name('dashboard');

// Изисква вход.
Route::middleware('auth')->group(function () {
    Route::get('/predictions', [PredictionController::class, 'index'])->name('predictions.index');
    // Тостът за нова значка маркира видяното. Кофата е широка нарочно:
    // викането е по едно на затваряне, но нека не блокира при бърз клик.
    Route::post('/badges/seen', BadgeSeenController::class)
        ->middleware('throttle:30,1,badges-seen')
        ->name('badges.seen');
    Route::post('/races/{race}/prediction', [PredictionController::class, 'store'])->name('predictions.store');

    Route::get('/profile', [ProfileController::class, 'edit'])->name('profile.edit');
    Route::patch('/profile', [ProfileController::class, 'update'])->name('profile.update');
    Route::delete('/profile', [ProfileController::class, 'destroy'])->name('profile.destroy');

    // Обратна връзка — постоянна страница + карта-подкана в PublicLayout
    // (SurveyPromptService решава кога се показва). Отговорите се четат във Filament.
    // Throttle с изричен префикс: голият 'throttle:5,1' ползва ЕДНА кофа на
    // потребител за всички рутове — спам по формата щеше да блокира и X-а на картата.
    Route::get('/obratna-vrazka', [FeedbackController::class, 'show'])->name('feedback');
    Route::post('/obratna-vrazka', [FeedbackController::class, 'store'])
        ->middleware('throttle:5,1,feedback-store')
        ->name('feedback.store');
    Route::post('/obratna-vrazka/dismiss', [FeedbackController::class, 'dismiss'])
        ->middleware('throttle:5,1,feedback-dismiss')
        ->name('feedback.dismiss');
});

require __DIR__.'/auth.php';
