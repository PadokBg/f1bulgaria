<script setup>
import HeroSection from '@/Components/Hero/HeroSection.vue';
import DataRecapCard from '@/Components/Homepage/DataRecapCard.vue';
import ThisDayWidget from '@/Components/Homepage/ThisDayWidget.vue';
import LiveSessionBanner from '@/Components/LiveSessionBanner.vue';
import GameTeaserWidget from '@/Components/Homepage/GameTeaserWidget.vue';
import TsolovMeter from '@/Components/Homepage/TsolovMeter.vue';
import FeaturedNewsCard from '@/Components/News/FeaturedNewsCard.vue';
import NewsCard from '@/Components/News/NewsCard.vue';
import MyLeagueStanding from '@/Components/Predictions/MyLeagueStanding.vue';
import PublicLayout from '@/Layouts/PublicLayout.vue';
import { hasRoute } from '@/utils/routes';
import { Link, usePage } from '@inertiajs/vue3';
import { computed } from 'vue';

const props = defineProps({
    hero: { type: Object, required: true },
    liveSession: { type: Object, default: null },
    thisDay: { type: Array, default: () => [] },
    // Последният рекап с данни; null при изключен флаг или преди първия кръг.
    dataRecap: { type: Object, default: null },
    topNews: { type: Array, default: () => [] },
    // null, ако човекът е гост, вече е прогнозирал или срокът е минал.
    predictionCta: { type: Object, default: null },
    // Огледалото му: позицията в лигата на вече прогнозиралия. null за гост.
    me: { type: Object, default: null },
    gameTeaser: { type: Object, default: null },
    // Цоловметърът; null при изключен флаг или несинхронизиран сезон във Ф2.
    tsolov: { type: Object, default: null },
});

const page = usePage();
const features = computed(() => page.props.features ?? {});

const allLinks = [
    { label: 'Календар', desc: 'Всички състезания за сезона', route: 'calendar' },
    { label: 'Класиране', desc: 'Пилоти и конструктори', route: 'standings' },
    { label: 'Отбори', desc: '10-те отбора с branding и статистика', route: 'teams.index' },
    { label: 'Пилоти', desc: 'Профили, статистика, head-to-head', route: 'drivers.index' },
    { label: 'Писти', desc: 'История и all-time класирания', route: 'circuits.index', feature: 'circuits' },
    { label: 'Сравни пилоти', desc: 'Двама пилоти един до друг', route: 'compare.index', feature: 'compare' },
    { label: 'Дуели', desc: 'Великите съперничества в историята', route: 'rivalries.index', feature: 'rivalries' },
    { label: 'Прогнози', desc: 'Познай подиума и събирай точки', route: 'leaderboard' },
    { label: 'Куиз', desc: 'Провери познанията си за Формула 1.', route: 'quiz', feature: 'quiz' },
    { label: 'Данни', desc: 'Какво показват данните след всеки кръг', route: 'racedata.index', feature: 'data_recap' },
    { label: 'Инженерство', desc: 'Как работи болидът, обяснено на български', route: 'engineering.index', feature: 'engineering' },
];

const links = computed(() => allLinks.filter((l) => hasRoute(l.route) && (!l.feature || features.value[l.feature])));

// Първата новина идва най-важна от контролера и се показва като голяма карта.
const featuredNews = computed(() => props.topNews[0] ?? null);
const restNews = computed(() => props.topNews.slice(1));
</script>

<template>
    <!-- meta/og таговете идват сървърно от App\Support\Seo (виж app.blade.php). -->

    <PublicLayout>
        <h1 class="sr-only">Падок — новини, календар и класиране от Формула 1 на български</h1>

        <LiveSessionBanner v-if="features.live_timing" :session="liveSession" />

        <!-- Подсещане за неподадена прогноза. Стои НАД hero-а нарочно: човекът,
             който се връща, трябва да го види без да скролва. -->
        <Link
            v-if="predictionCta"
            :href="predictionCta.url"
            class="group mb-6 flex flex-col gap-3 rounded-2xl border border-red-600/40 bg-gradient-to-r from-red-600/15 to-transparent p-5 transition duration-200 hover:border-red-600/70 sm:flex-row sm:items-center sm:justify-between"
        >
            <div>
                <!-- Пулсиращата точка е за подсещане (има срок, който тече).
                     На гост нищо не му изтича — за него е покана, не аларма. -->
                <div class="flex items-center gap-2 text-xs font-black uppercase tracking-[0.18em] text-red-500">
                    <span v-if="!predictionCta.guest" aria-hidden="true" class="relative flex h-1.5 w-1.5">
                        <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                        <span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-red-500" />
                    </span>
                    {{ predictionCta.guest ? 'Лигата на прогнозите' : 'Не си прогнозирал' }}
                </div>
                <p class="mt-1.5 font-display text-lg font-black text-white sm:text-xl">
                    {{ predictionCta.race }}
                </p>
                <p class="mt-0.5 text-sm text-zinc-400">
                    <template v-if="predictionCta.guest">
                        Познай подиума и събирай точки срещу останалите в Падок. Стигат три имена.
                    </template>
                    <template v-else>
                        <template v-if="predictionCta.deadline">
                            Заключва се {{ predictionCta.deadline }}<template v-if="predictionCta.days > 0"> — {{ predictionCta.days === 1 ? 'остава 1 ден' : `остават ${predictionCta.days} дни` }}</template>.
                        </template>
                        Стигат ти три имена за подиума.
                    </template>
                </p>
            </div>

            <span class="shrink-0 rounded-lg bg-red-600 px-5 py-2.5 text-center font-semibold text-white transition group-hover:bg-red-500">
                {{ predictionCta.guest ? 'Регистрирай се и играй' : 'Дай прогноза' }}
            </span>
        </Link>

        <!-- Показва се само когато CTA-то мълчи: двете отговарят на един и същ
             въпрос („какво е моето положение") от двете му страни. -->
        <MyLeagueStanding v-if="me && !predictionCta" :me="me" class="mb-6" />

        <!-- Банер — визуален header над hero-а със състезанието -->
        <div class="relative mb-6 overflow-hidden rounded-2xl">
            <picture>
                <source media="(max-width: 767px)" srcset="/images/banners/hero/hero-750x800.webp" type="image/webp" />
                <source media="(max-width: 767px)" srcset="/images/banners/hero/hero-750x800.jpg" type="image/jpeg" />
                <source media="(max-width: 1279px)" srcset="/images/banners/hero/hero-1280x500.webp" type="image/webp" />
                <source media="(max-width: 1279px)" srcset="/images/banners/hero/hero-1280x500.jpg" type="image/jpeg" />
                <!-- Десктоп WebP нарочно го няма: hero-1920x600.webp е 212 KB,
                     а JPG-ът, който щеше да замести — 193 KB. Другите два
                     размера остават, там WebP е три пъти по-малък. -->
                <img
                    src="/images/banners/hero/hero-1920x600.jpg"
                    alt="Падок — Формула 1 на български"
                    class="block h-[180px] w-full object-cover sm:h-auto"
                    loading="eager"
                    fetchpriority="high"
                    width="1920"
                    height="600"
                />
            </picture>

            <div class="absolute inset-0 flex items-center">
                <div class="absolute inset-0 bg-gradient-to-r from-black/85 via-black/50 to-transparent" />
                <div class="relative max-w-4xl px-6 md:px-12 lg:px-20">
                    <p class="font-display text-4xl font-black leading-none tracking-tight text-white md:text-6xl lg:text-7xl">
                        Падок
                    </p>
                    <p class="mt-3 max-w-xl text-base font-medium text-white/90 md:text-xl lg:text-2xl">
                        Мястото на всички фенове на Формула 1 в България
                    </p>
                </div>
            </div>
        </div>

        <HeroSection :hero="hero" />

        <!-- На този ден във Формула 1 (V2) -->
        <ThisDayWidget v-if="features.this_day" :events="thisDay" />

        <!-- Цоловметър над играта: българинът в битка за титла бие всичко
             останало по причина някой изобщо да отвори сайта. -->
        <TsolovMeter v-if="tsolov" :tsolov="tsolov" />

        <GameTeaserWidget v-if="gameTeaser" :teaser="gameTeaser" />

        <!-- Данните от последния кръг. Над новините нарочно: материалът има
             срок и се чете точно в дните след състезанието. -->
        <DataRecapCard v-if="dataRecap" :recap="dataRecap" />

        <!-- Топ новини -->
        <section v-if="topNews.length" class="mt-10">
            <div class="mb-4 flex items-baseline justify-between">
                <h2 class="font-display text-xl font-black sm:text-2xl">Топ новини</h2>
                <Link v-if="hasRoute('news.index')" :href="route('news.index')" class="text-sm font-medium text-red-500 transition hover:text-red-400">
                    Всички новини →
                </Link>
            </div>
            <FeaturedNewsCard v-if="featuredNews" :item="featuredNews" class="mb-4" />

            <div v-if="restNews.length" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <NewsCard v-for="(item, i) in restNews" :key="i" :item="item" />
            </div>
        </section>

        <!-- Разделите на платформата -->
        <section class="mt-10">
            <h2 class="mb-4 font-display text-xl font-black sm:text-2xl">Разгледай</h2>
            <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Link
                    v-for="link in links"
                    :key="link.route"
                    :href="route(link.route)"
                    class="group rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 transition duration-200 hover:border-red-600/50 hover:bg-zinc-900"
                >
                    <div class="font-semibold text-white transition group-hover:text-red-400">{{ link.label }}</div>
                    <div class="mt-1 text-sm text-zinc-500">{{ link.desc }}</div>
                </Link>
            </div>
        </section>
    </PublicLayout>
</template>
