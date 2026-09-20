<script setup>
import { useCountdown } from '@/composables/useCountdown';
import { Link } from '@inertiajs/vue3';
import { computed } from 'vue';

const props = defineProps({
    tsolov: { type: Object, required: true },
});

const { days, hours, minutes, finished } = useCountdown(() => props.tsolov.next?.at ?? null);

/** Часът е TBC → показваме само деня, иначе броячът лъже до минутата. */
const showCountdown = computed(
    () => props.tsolov.next?.at && !props.tsolov.next.time_tbc && !finished.value,
);

const sessionDay = computed(() => {
    if (!props.tsolov.next?.at) {
        return null;
    }

    return new Date(props.tsolov.next.at).toLocaleDateString('bg-BG', {
        day: 'numeric',
        month: 'long',
        timeZone: 'Europe/Sofia',
    });
});
</script>

<template>
    <!--
        Цоловметър: единственото на сайта, което никой друг не може да предложи
        на български. Затова стои на началната, а не само зад линк в менюто.
    -->
    <section class="mt-10 overflow-hidden rounded-xl border border-zinc-800 bg-gradient-to-br from-emerald-950/40 via-zinc-900/60 to-zinc-900/60 p-6">
        <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
                <div class="text-[11px] font-bold uppercase tracking-widest text-emerald-400">
                    Формула 2 · Никола Цолов
                </div>
                <h2 class="mt-1 font-display text-xl font-black text-white sm:text-2xl">
                    <template v-if="tsolov.leads">Цолов води шампионата</template>
                    <template v-else>Цолов е {{ tsolov.position }}-и в шампионата</template>
                </h2>
            </div>
            <Link
                href="/tsolov"
                class="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-bold uppercase tracking-wider text-white transition hover:bg-emerald-500"
            >
                Следи го →
            </Link>
        </div>

        <div class="mt-4 grid gap-2 sm:grid-cols-3">
            <div class="rounded-lg bg-black/30 px-3 py-2.5">
                <div class="text-[11px] uppercase tracking-wider text-zinc-500">Точки</div>
                <div class="font-display text-lg font-black tabular-nums text-white">
                    {{ tsolov.points }}
                </div>
            </div>

            <div v-if="tsolov.rival" class="rounded-lg bg-black/30 px-3 py-2.5">
                <div class="text-[11px] uppercase tracking-wider text-zinc-500">
                    {{ tsolov.leads ? 'Аванс пред' : 'Изостава от' }} {{ tsolov.rival.name }}
                </div>
                <div
                    class="font-display text-lg font-black tabular-nums"
                    :class="tsolov.leads ? 'text-emerald-400' : 'text-amber-400'"
                >
                    {{ tsolov.leads ? '+' : '−' }}{{ tsolov.rival.gap }}
                </div>
            </div>

            <div class="rounded-lg bg-black/30 px-3 py-2.5">
                <div class="text-[11px] uppercase tracking-wider text-zinc-500">
                    <template v-if="tsolov.next">{{ tsolov.next.label }} · {{ tsolov.next.location }}</template>
                    <template v-else>Остават</template>
                </div>
                <div class="font-display text-lg font-black tabular-nums text-white">
                    <template v-if="showCountdown">
                        <template v-if="days > 0">след {{ days }} д. {{ hours }} ч.</template>
                        <template v-else>след {{ hours }} ч. {{ minutes }} мин.</template>
                    </template>
                    <template v-else-if="sessionDay">{{ sessionDay }}</template>
                    <template v-else>{{ tsolov.rounds_left }} кръга</template>
                </div>
            </div>
        </div>

        <p v-if="tsolov.rounds_left > 0" class="mt-3 text-xs text-zinc-500">
            {{ tsolov.rounds_left === 1 ? 'Остава 1 кръг' : `Остават ${tsolov.rounds_left} кръга` }}
            до края на сезона.
        </p>
    </section>
</template>
