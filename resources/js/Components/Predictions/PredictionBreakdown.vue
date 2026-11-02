<script setup>
import { breakdownRows } from '@/predictions/breakdownRows';
import { usePage } from '@inertiajs/vue3';
import { computed } from 'vue';

const props = defineProps({
    // breakdown_json от PredictionScore — ключове p1/p2/p3/pole/fastest_lap/dnf/safety_car.
    breakdown: { type: Object, default: null },
    total: { type: Number, default: 0 },
});

// Редът следва формата за прогноза, за да е разпознаваем. Нескорирана
// прогноза идва без breakdown — тогава редове няма и компонентът мълчи.
const rows = computed(() => breakdownRows(props.breakdown, usePage().props.predictionScoring));

// Частичното попадение има собствен цвят и обяснение: със зеленото „✓" на
// точното „Победител +5" се четеше като познат победител.
const STYLES = {
    exact: { row: 'bg-emerald-950/20', mark: '✓', accent: 'text-emerald-400', label: 'text-zinc-200' },
    partial: { row: 'bg-amber-950/20', mark: '≈', accent: 'text-amber-400', label: 'text-zinc-200' },
    miss: { row: 'bg-zinc-900/40', mark: '✗', accent: 'text-zinc-600', label: 'text-zinc-500' },
};
</script>

<template>
    <div v-if="rows.length" class="overflow-hidden rounded-lg border border-zinc-800">
        <ul class="divide-y divide-zinc-800/60">
            <li
                v-for="row in rows"
                :key="row.key"
                class="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                :class="STYLES[row.status].row"
            >
                <span class="flex min-w-0 items-center gap-2">
                    <span
                        class="shrink-0 text-xs"
                        :class="STYLES[row.status].accent"
                        aria-hidden="true"
                    >{{ STYLES[row.status].mark }}</span>
                    <span class="min-w-0">
                        <span class="block truncate" :class="STYLES[row.status].label">{{ row.label }}</span>
                        <span v-if="row.note" class="block text-xs text-amber-400/80">{{ row.note }}</span>
                    </span>
                </span>
                <span
                    class="shrink-0 font-bold tabular-nums"
                    :class="STYLES[row.status].accent"
                >{{ row.points > 0 ? '+' + row.points : '0' }}</span>
            </li>
        </ul>
        <div class="flex items-center justify-between bg-zinc-900/80 px-3 py-2 text-sm font-bold">
            <span class="text-zinc-400">Общо</span>
            <span class="tabular-nums text-white">{{ total }} т.</span>
        </div>
    </div>
</template>
