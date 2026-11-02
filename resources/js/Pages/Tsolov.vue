<script setup>
import Card from '@/Components/UI/Card.vue';
import StatTile from '@/Components/UI/StatTile.vue';
import PublicLayout from '@/Layouts/PublicLayout.vue';
import { Link } from '@inertiajs/vue3';
import { computed } from 'vue';

const props = defineProps({
    profile: { type: Object, required: true },
    f2: { type: Object, default: null },
    news: { type: Array, default: () => [] },
});

// Датата се показва в софийско време — базата пази UTC.
const formatDate = (iso) =>
    iso
        ? new Date(iso).toLocaleDateString('bg-BG', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
              timeZone: 'Europe/Sofia',
          })
        : null;

const age = computed(() => {
    if (!props.profile.birth_date) {
        return null;
    }
    const born = new Date(props.profile.birth_date);
    const now = new Date();
    let years = now.getFullYear() - born.getFullYear();
    const m = now.getMonth() - born.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < born.getDate())) {
        years--;
    }
    return years;
});

// ЕДИНСТВЕН източник за числата: config/tsolov.php (F2 auto-sync е непълен и е
// изключен в V1). Така банер и класиране никога не се разминават.
const stats = computed(() => props.profile.season_stats ?? null);

// Челен сблъсък със съседа в класирането: преследвачът, ако Цолов води, иначе
// пилотът точно пред него.
//
// Точките му се четат от самото класиране. Преди се смятаха като
// `points - championship_lead`, а контролерът връща `championship_lead: null`,
// щом Цолов не е първи — в JavaScript `points - null` дава `points`, така че
// лентата тихо показваше 50/50 вместо реалната разлика.
const board = computed(() => props.profile.standings ?? []);
const rival = computed(() => {
    const index = board.value.findIndex((row) => row.is_tsolov);

    if (index === -1) {
        return null;
    }

    return board.value[index === 0 ? 1 : index - 1] ?? null;
});
const rivalName = computed(() => rival.value?.name ?? null);
const rivalPoints = computed(() => rival.value?.points ?? null);
const tsolovLeads = computed(() => stats.value?.championship_position === 1);
const pointsGap = computed(() => {
    if (!stats.value || rivalPoints.value === null) {
        return null;
    }

    return Math.abs(stats.value.points - rivalPoints.value);
});
const tsolovShare = computed(() => {
    if (!stats.value || rivalPoints.value === null) {
        return 50;
    }
    const total = stats.value.points + rivalPoints.value;
    return total > 0 ? Math.round((stats.value.points / total) * 100) : 50;
});
</script>

<template>

    <PublicLayout>
        <!-- Hero банер — картина без текст; позицията в шампионата е под него, живо от базата -->
        <section class="relative overflow-hidden rounded-2xl">
            <picture>
                <source media="(max-width: 767px)" srcset="/images/banners/tsolov/tsolov-750x600.webp" type="image/webp" />
                <source media="(max-width: 767px)" srcset="/images/banners/tsolov/tsolov-750x600.jpg" type="image/jpeg" />
                <source media="(max-width: 1279px)" srcset="/images/banners/tsolov/tsolov-1280x500.webp" type="image/webp" />
                <source media="(max-width: 1279px)" srcset="/images/banners/tsolov/tsolov-1280x500.jpg" type="image/jpeg" />
                <source media="(min-width: 1280px)" srcset="/images/banners/tsolov/tsolov-1600x500.webp" type="image/webp" />
                <img
                    src="/images/banners/tsolov/tsolov-1600x500.jpg"
                    :alt="`${profile.name} — банер с болид на писта`"
                    class="block h-auto w-full object-cover"
                    loading="eager"
                    width="1600"
                    height="500"
                />
            </picture>

            <!-- Заглавието е запечено в дизайна на банера — h1 остава само за SEO/четци. -->
            <h1 class="sr-only">{{ profile.name }} — българската надежда във Формула 2</h1>
        </section>

        <!-- Ключови факти под банера (бяха в overlay-а, сега не се бият с дизайна) -->
        <div class="mx-auto mt-4 flex max-w-3xl flex-wrap items-center gap-3 text-sm text-zinc-400">
            <span v-if="stats" class="font-semibold text-white">{{ stats.points }} точки</span>
            <span v-if="stats" class="text-red-500" aria-hidden="true">·</span>
            <span v-if="stats" class="font-semibold text-white">{{ stats.wins }} победи</span>
            <span v-if="stats" class="text-red-500" aria-hidden="true">·</span>
            <span v-if="age">{{ age }} години</span>
            <span class="text-zinc-600" aria-hidden="true">·</span>
            <span>{{ profile.hometown }}</span>
            <span v-if="profile.current_series" class="text-zinc-600" aria-hidden="true">·</span>
            <span v-if="profile.current_series" class="font-semibold text-white">{{ profile.current_series }}</span>
        </div>

        <!-- Биография -->
        <section class="mx-auto mt-8 max-w-3xl">
            <h2 class="mb-3 font-display text-lg font-bold text-white">Биография</h2>
            <div class="space-y-4 leading-relaxed text-zinc-300">
                <p v-for="(p, i) in profile.bio_bg" :key="i">{{ p }}</p>
            </div>
        </section>

        <!-- Титли (акценти) -->
        <section v-if="profile.titles?.length" class="mx-auto mt-8 max-w-3xl">
            <div class="grid gap-3 sm:grid-cols-2">
                <div v-for="(t, i) in profile.titles" :key="i" class="flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                    <span class="text-3xl" aria-hidden="true">🏆</span>
                    <div>
                        <div class="font-display text-lg font-black tabular-nums text-amber-300">{{ t.year }}</div>
                        <div class="text-sm font-semibold text-white">{{ t.title }}</div>
                    </div>
                </div>
            </div>
        </section>

        <!-- Кариерна линия -->
        <section v-if="profile.milestones?.length" class="mx-auto mt-8 max-w-3xl">
            <h2 class="mb-4 font-display text-lg font-bold text-white">Кариерен път</h2>
            <div class="space-y-3">
                <Card v-for="(m, i) in profile.milestones" :key="i" class="flex gap-4">
                    <div class="shrink-0 font-display text-xl font-black tabular-nums text-emerald-400">{{ m.year }}</div>
                    <div>
                        <p class="text-zinc-200">{{ m.event }}</p>
                        <p v-if="m.championship" class="text-sm text-amber-400"><span aria-hidden="true">🏆</span> {{ m.championship }}</p>
                    </div>
                </Card>
            </div>
        </section>

        <!-- Новини за него. Пълният архив, вкл. Ф2 — главната емисия на
             сайта е само за Формула 1, така че Ф2 статиите живеят само тук. -->
        <section v-if="news.length" class="mx-auto mt-8 max-w-3xl">
            <h2 class="mb-4 font-display text-lg font-bold text-white">Новини за Цолов</h2>
            <div class="space-y-3">
                <Card v-for="item in news" :key="item.slug">
                    <Link :href="`/news/${item.slug}`" class="block group">
                        <div class="flex flex-wrap items-baseline gap-2">
                            <time v-if="item.published_at" :datetime="item.published_at" class="text-xs text-zinc-500">
                                {{ formatDate(item.published_at) }}
                            </time>
                            <span
                                v-if="!item.is_f1"
                                class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400"
                            >
                                Формула 2
                            </span>
                        </div>
                        <p class="mt-1 font-semibold text-zinc-100 group-hover:text-emerald-400">{{ item.title }}</p>
                        <p v-if="item.summary" class="mt-1 line-clamp-2 text-sm text-zinc-400">{{ item.summary }}</p>
                    </Link>
                </Card>
            </div>
        </section>

        <!-- Сезон 2026 във F2 — класиране + челен сблъсък (източник: config/tsolov.php) -->
        <section v-if="stats" class="mx-auto mt-8 max-w-3xl rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-6">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
                <h2 class="font-display text-lg font-bold text-white">Сезон 2026 във Формула 2 — {{ profile.current_team }}</h2>
                <span class="text-sm text-zinc-500">№{{ profile.car_number }}</span>
            </div>

            <div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatTile label="Позиция">P{{ stats.championship_position }}</StatTile>
                <StatTile label="Точки">{{ stats.points }}</StatTile>
                <StatTile label="Победи">{{ stats.wins }}</StatTile>
                <!-- Плочката сменя смисъла си: „Преднина" има значение само
                     когато Цолов е първи, иначе показва изоставането. -->
                <StatTile v-if="tsolovLeads && stats.championship_lead !== null" label="Преднина">
                    +{{ stats.championship_lead }}
                </StatTile>
                <StatTile v-else-if="pointsGap !== null" label="Изоставане">
                    −{{ pointsGap }}
                </StatTile>
                <StatTile v-else label="Кръгове">{{ stats.races ?? '—' }}</StatTile>
            </div>

            <!-- Челен сблъсък със съседа в класирането -->
            <div v-if="rivalPoints !== null && rivalName" class="mt-5">
                <div class="mb-1.5 flex items-center justify-between text-xs font-semibold uppercase tracking-wide">
                    <span class="text-emerald-400">Цолов · {{ stats.points }} т.</span>
                    <span class="text-zinc-400">{{ rivalName }} · {{ rivalPoints }} т.</span>
                </div>
                <div class="flex h-3 overflow-hidden rounded-full bg-zinc-800 ring-1 ring-inset ring-zinc-700">
                    <div class="bg-emerald-500 transition-[width] duration-700 ease-out" :style="{ width: tsolovShare + '%' }" />
                    <div class="bg-red-600 transition-[width] duration-700 ease-out" :style="{ width: 100 - tsolovShare + '%' }" />
                </div>
                <p class="mt-1.5 text-center text-xs text-zinc-500">
                    <template v-if="pointsGap === 0">Равни точки с {{ rivalName }}</template>
                    <template v-else-if="tsolovLeads">Цолов води с {{ pointsGap }} {{ pointsGap === 1 ? 'точка' : 'точки' }}</template>
                    <template v-else>Цолов изостава с {{ pointsGap }} точки от {{ rivalName }}</template>
                </p>
            </div>

            <!-- Мини класиране (топ 5) -->
            <div v-if="profile.standings?.length" class="mt-5 overflow-hidden rounded-xl border border-zinc-800">
                <div
                    v-for="row in profile.standings"
                    :key="row.pos"
                    class="flex items-center gap-3 border-b border-zinc-800/60 px-3 py-2 text-sm last:border-0"
                    :class="row.is_tsolov ? 'bg-emerald-500/10' : ''"
                >
                    <span class="w-5 text-center font-black tabular-nums" :class="row.is_tsolov ? 'text-emerald-400' : 'text-zinc-500'">{{ row.pos }}</span>
                    <span class="min-w-0 flex-1 truncate" :class="row.is_tsolov ? 'font-bold text-white' : 'text-zinc-300'">
                        <span v-if="row.is_tsolov">🇧🇬 </span>{{ row.name }} <span class="text-xs text-zinc-500">· {{ row.team }}</span>
                    </span>
                    <span class="font-bold tabular-nums" :class="row.is_tsolov ? 'text-emerald-400' : 'text-zinc-400'">{{ row.points }}</span>
                </div>
            </div>

            <p v-if="profile.standings_note" class="mt-2 text-right text-xs text-zinc-600">{{ profile.standings_note }}</p>
        </section>

        <!-- Подкрепи -->
        <section class="mx-auto mt-8 max-w-3xl rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 text-center">
            <h2 class="font-display text-lg font-bold text-white">Подкрепи Цолов</h2>
            <p class="mt-2 text-zinc-400">Следвай пътя на българския талант към върха на моторспорта.</p>
            <div v-if="profile.social_links?.length" class="mt-4 flex flex-wrap justify-center gap-2">
                <a v-for="(link, i) in profile.social_links" :key="i" :href="link.url" target="_blank" rel="noopener"
                    class="rounded-full border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-emerald-500 hover:text-white">
                    {{ link.label }}
                </a>
            </div>
        </section>
    </PublicLayout>
</template>
